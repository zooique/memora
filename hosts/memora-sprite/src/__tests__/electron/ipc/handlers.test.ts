/**
 * IPC 处理器测试 — IPC handler 注册/清理回归测试
 *
 * 覆盖范围：
 * - registerIpcHandlers 幂等性（reinitAgent 重复调用不抛错）
 * - handleUserInput 在 Agent 未就绪时拒绝（reinitAgent 失败保护）
 * - handleUserInput 竞态保护（进行中对话时拒绝新请求）
 *
 * Mock 策略：
 * - electron.ipcMain：使用 vi.fn() 捕获 handle/on/removeHandler/removeAllListeners 调用
 * - memora.toError：保留默认实现（仅做错误对象标准化）
 * - IpcContext：构造最小化 mock 对象，仅满足 handleUserInput 前置检查
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock electron 模块 ──────────────────────────────────
// handlers.ts 顶部 import { ipcMain } from 'electron'，
// 在 Node 测试环境中 electron 不可用，必须 mock。

/** 捕获 ipcMain.handle 注册的回调，供测试间接调用 */
const handleCallbacks = new Map<string, (...args: unknown[]) => unknown>();
/** 捕获 ipcMain.on 注册的回调，供测试间接调用（USER_INPUT 等） */
const onCallbacks = new Map<string, (...args: unknown[]) => void>();

vi.mock('electron', () => ({
  ipcMain: {
    // removeHandler 对未注册通道是 no-op，mock 中直接清空对应回调
    removeHandler: vi.fn((channel: string) => {
      handleCallbacks.delete(channel);
    }),
    // removeAllListeners 清空 on 通道的全部回调
    removeAllListeners: vi.fn((channel: string) => {
      onCallbacks.delete(channel);
    }),
    // handle 注册 invoke 回调，重复注册时模拟 Electron 抛错行为
    handle: vi.fn((channel: string, callback: (...args: unknown[]) => unknown) => {
      if (handleCallbacks.has(channel)) {
        throw new Error(`Attempted to register a second handler for '${channel}'`);
      }
      handleCallbacks.set(channel, callback);
    }),
    // on 注册事件监听回调
    on: vi.fn((channel: string, callback: (...args: unknown[]) => void) => {
      onCallbacks.set(channel, callback);
    }),
  },
}));

// ─── 测试辅助 ─────────────────────────────────────────────

/**
 * 构造最小化 IpcContext mock
 *
 * handleUserInput 仅在前置检查阶段使用以下字段：
 * - windowManager.getFullWindow() → 返回 mock 窗口
 * - isAgentReady() → 由参数控制
 * - getAbortController() → 由参数控制
 * - setAbortController() → 记录调用
 *
 * 其余字段（agent/sprite/sessionStore 等）在 P1 测试中不会被触及，
 * 因为前置检查失败时函数提前 return。
 */
function createMockIpcContext(options: {
  isAgentReady: boolean;
  abortController: AbortController | null;
}): {
  ctx: Record<string, unknown>;
  sentMessages: Array<{ channel: string; data: unknown }>;
  setAbortControllerCalls: Array<AbortController | null>;
} {
  // 记录所有通过 webContents.send 推送到渲染进程的消息
  const sentMessages: Array<{ channel: string; data: unknown }> = [];
  const setAbortControllerCalls: Array<AbortController | null> = [];

  // mock 窗口对象：isDestroyed 返回 false，send 记录消息
  const mockWindow = {
    isDestroyed: () => false,
    isVisible: () => true,
    webContents: {
      send: vi.fn((channel: string, data: unknown) => {
        sentMessages.push({ channel, data });
      }),
    },
  };

  const ctx = {
    // FIX-P1-7/FIX-P1-1：agent/sprite/sessionStore 改为函数式 getter，匹配 IpcContext 接口改造
    getAgent: () => ({
      getMetrics: () => ({ context: { truncationCount: 0 } }),
    }),
    // chatStreamHandler 调用 sprite.incrementDailyMessageCount() + prepareForChat() + sprite.activePersona，mock 需提供方法
    getSprite: () => ({
      incrementDailyMessageCount: vi.fn(),
      prepareForChat: vi.fn(),
      // activePersona 返回 null 模拟"无激活角色"场景
      get activePersona() { return null; },
    }),
    getSessionStore: () => ({}),
    windowStateManager: {},
    windowManager: {
      getFullWindow: () => mockWindow,
    },
    trayManager: null,
    getAbortController: () => options.abortController,
    setAbortController: (ctrl: AbortController | null) => {
      setAbortControllerCalls.push(ctrl);
    },
    isAgentReady: () => options.isAgentReady,
    getUnreadCount: () => 0,
    incrementUnreadCount: vi.fn(),
    resetUnreadCount: vi.fn(),
    usageStatsCollector: null,
  };

  return { ctx, sentMessages, setAbortControllerCalls };
}

// ─── 测试套件 ─────────────────────────────────────────────

describe('ipcHandlers — IPC handler 注册/清理回归测试', () => {
  beforeEach(() => {
    // 每个测试前清空捕获的回调，避免测试间污染
    handleCallbacks.clear();
    onCallbacks.clear();
    vi.clearAllMocks();
  });

  // ─── registerIpcHandlers 首次调用契约 ──────────────────
  // FIX-P1-1：registerIpcHandlers 改为"仅首次调用"设计——
  // - IpcContext getter 实时返回最新实例，reinitAgent 后 IPC handler 自动看到新实例，无需 removeHandler + 重注册
  // - 调用方（main.ts setupAgentReady）用 appState.ipcRegistered 标志保证幂等
  // - 若强行重复调用，ipcMain.handle 会抛 "Attempted to register a second handler"（Electron 契约）

  describe('registerIpcHandlers 首次调用契约（FIX-P1-1：不再支持重复注册）', () => {
    it('首次调用应正常注册所有 handler 不抛错', { timeout: 15000 }, async () => {
      // 动态导入，确保 vi.mock('electron') 已生效
      const { registerIpcHandlers } = await import('../../../electron/ipc/handlers.js');
      const { ctx } = createMockIpcContext({
        isAgentReady: true,
        abortController: null,
      });

      // 首次注册：应正常完成，不抛错
      expect(() => registerIpcHandlers(ctx as never)).not.toThrow();
    });

    it('重复调用应抛 "Attempted to register a second handler" 错误（Electron 契约）', async () => {
      const { registerIpcHandlers } = await import('../../../electron/ipc/handlers.js');
      const { ctx } = createMockIpcContext({
        isAgentReady: true,
        abortController: null,
      });

      // 首次注册：正常
      registerIpcHandlers(ctx as never);

      // 第二次注册（违反 FIX-P1-1 契约）：应抛错——调用方需通过 appState.ipcRegistered 标志保证不重复调用
      expect(() => registerIpcHandlers(ctx as never)).toThrow(
        /Attempted to register a second handler/,
      );
    });

    it('首次注册应注册关键 session 通道（session-switch/delete/rename）', async () => {
      const { registerIpcHandlers } = await import('../../../electron/ipc/handlers.js');
      const { ipcMain } = await import('electron');
      const { ctx } = createMockIpcContext({
        isAgentReady: true,
        abortController: null,
      });

      registerIpcHandlers(ctx as never);

      // 验证关键 session 通道被 ipcMain.handle 注册（不再验证 removeHandler 清理）
      const handleCalls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
      const registeredChannels = handleCalls.map((call: unknown[]) => call[0] as string);

      // 关键断言：这三个 session 通道必须被注册
      expect(registeredChannels).toContain('session-switch');
      expect(registeredChannels).toContain('session-delete');
      expect(registeredChannels).toContain('session-rename');
    });
  });

  // ─── Agent 未就绪时拒绝对话 ──────────────────────

  describe('handleUserInput 在 Agent 未就绪时拒绝', () => {
    it('isAgentReady()=false 时发送 SPRITE_ERROR 并提前返回', async () => {
      const { registerIpcHandlers } = await import('../../../electron/ipc/handlers.js');
      const { ctx, sentMessages } = createMockIpcContext({
        isAgentReady: false, // 模拟 reinitAgent 失败后的状态
        abortController: null,
      });

      registerIpcHandlers(ctx as never);

      // 获取 USER_INPUT 通道注册的回调（即 handleUserInput 的入口）
      const userInputCallback = onCallbacks.get('user-input');
      expect(userInputCallback).toBeDefined();

      // 触发用户输入
      userInputCallback?.({}, '测试消息');

      // 等待微任务（handleUserInput 是 async，但前置检查同步执行后 return）
      await new Promise((resolve) => setTimeout(resolve, 10));

      // 验证：发送了 SPRITE_ERROR 错误消息
      const errorMessages = sentMessages.filter((m) => m.channel === 'sprite-error');
      expect(errorMessages).toHaveLength(1);
      expect(errorMessages[0]?.data).toMatchObject({
        text: expect.stringContaining('Agent 正在初始化中'),
      });

      // 验证：没有发送 SPRITE_STREAM_START（对话未启动）
      const streamStartMessages = sentMessages.filter((m) => m.channel === 'sprite-stream-start');
      expect(streamStartMessages).toHaveLength(0);
    });

    it('isAgentReady()=true 且无进行中对话时正常进入对话流程', async () => {
      const { registerIpcHandlers } = await import('../../../electron/ipc/handlers.js');
      const { ctx, sentMessages, setAbortControllerCalls } = createMockIpcContext({
        isAgentReady: true,
        abortController: null,
      });

      registerIpcHandlers(ctx as never);

      const userInputCallback = onCallbacks.get('user-input');
      userInputCallback?.({}, '测试消息');

      // 等待微任务让 async 函数执行到 agent.processEvent() 调用
      // agent.processEvent() 会因 mock agent 无 processEvent 方法而抛错，但前置检查应通过
      await new Promise((resolve) => setTimeout(resolve, 10));

      // 验证：前置检查通过 — setAbortController 被调用（HEAL-1 修复后，
      // setAbortController 在 try 块早期同步调用，先于 agent.processEvent()）
      // 注意：agent 是空对象 {}，processEvent() 调用会抛 TypeError，但 setAbortController
      // 已在 processEvent() 之前执行，证明进入了 try 块（前置检查全部通过）
      expect(setAbortControllerCalls.length).toBeGreaterThanOrEqual(1);

      // 验证：没有发送 "Agent 未就绪" 错误
      const errorMessages = sentMessages.filter((m) => m.channel === 'sprite-error');
      const agentNotReadyErrors = errorMessages.filter((m) =>
        typeof m.data === 'object' && m.data !== null &&
        'text' in m.data && typeof m.data.text === 'string' &&
        m.data.text.includes('Agent 未就绪'),
      );
      expect(agentNotReadyErrors).toHaveLength(0);
    });
  });

  // ─── 竞态保护 ────────────────────────────────────

  describe('handleUserInput 竞态保护（进行中对话时拒绝）', () => {
    it('getAbortController() 非空时发送 SPRITE_ERROR 并提前返回', async () => {
      const { registerIpcHandlers } = await import('../../../electron/ipc/handlers.js');
      // 模拟进行中的对话：abortController 非空
      const ongoingController = new AbortController();
      const { ctx, sentMessages } = createMockIpcContext({
        isAgentReady: true,
        abortController: ongoingController,
      });

      registerIpcHandlers(ctx as never);

      const userInputCallback = onCallbacks.get('user-input');
      // 用户中断后立即发送新消息（旧 chat() 的 finally 块尚未执行）
      userInputCallback?.({}, '第二条消息');

      await new Promise((resolve) => setTimeout(resolve, 10));

      // 验证：发送了竞态保护错误消息
      const errorMessages = sentMessages.filter((m) => m.channel === 'sprite-error');
      expect(errorMessages).toHaveLength(1);
      expect(errorMessages[0]?.data).toMatchObject({
        text: expect.stringContaining('上一条消息仍在处理中'),
      });

      // 验证：没有发送 SPRITE_STREAM_START（新对话未启动）
      const streamStartMessages = sentMessages.filter((m) => m.channel === 'sprite-stream-start');
      expect(streamStartMessages).toHaveLength(0);
    });

    it('竞态保护优先级低于 Agent 就绪检查', async () => {
      // 两个保护条件同时为 true 时，Agent 未就绪应优先拒绝
      const { registerIpcHandlers } = await import('../../../electron/ipc/handlers.js');
      const { ctx, sentMessages } = createMockIpcContext({
        isAgentReady: false,
        abortController: new AbortController(),
      });

      registerIpcHandlers(ctx as never);

      const userInputCallback = onCallbacks.get('user-input');
      userInputCallback?.({}, '测试消息');

      await new Promise((resolve) => setTimeout(resolve, 10));

      // 验证：发送的是 "Agent 正在初始化中" 错误（isAgentReady 检查在前）
      const errorMessages = sentMessages.filter((m) => m.channel === 'sprite-error');
      expect(errorMessages).toHaveLength(1);
      expect(errorMessages[0]?.data).toMatchObject({
        text: expect.stringContaining('Agent 正在初始化中'),
      });
    });
  });

  // ─── 窗口销毁保护 ──────────────────────────────────────

  describe('窗口销毁保护', () => {
    it('fullWindow 为 null 时静默返回（不抛错）', async () => {
      const { registerIpcHandlers } = await import('../../../electron/ipc/handlers.js');
      const ctx = {
        // FIX-P1-7/FIX-P1-1：agent/sprite/sessionStore 改为函数式 getter，匹配 IpcContext 接口改造
        getAgent: () => ({
          getMetrics: () => ({ context: { truncationCount: 0 } }),
        }),
        // chatStreamHandler 调用 sprite.incrementDailyMessageCount() + prepareForChat() + sprite.activePersona，mock 需提供方法
        getSprite: () => ({
          incrementDailyMessageCount: vi.fn(),
          prepareForChat: vi.fn(),
          // activePersona 返回 null 模拟"无激活角色"场景
          get activePersona() { return null; },
        }),
        getSessionStore: () => ({}),
        windowStateManager: {},
        windowManager: {
          getFullWindow: () => null, // 窗口已销毁
        },
        trayManager: null,
        getAbortController: () => null,
        setAbortController: vi.fn(),
        isAgentReady: () => true,
        getUnreadCount: () => 0,
        incrementUnreadCount: vi.fn(),
        resetUnreadCount: vi.fn(),
        usageStatsCollector: null,
      };

      registerIpcHandlers(ctx as never);

      const userInputCallback = onCallbacks.get('user-input');
      // 不应抛错
      expect(() => userInputCallback?.({}, '测试消息')).not.toThrow();
    });
  });

  // ─── SESSION_SWITCH 竞态保护 ─────────────────

  describe('SESSION_SWITCH 进行中对话时拒绝', () => {
    it('有进行中对话时切换会话返回失败', async () => {
      const { registerIpcHandlers } = await import('../../../electron/ipc/handlers.js');
      // 模拟进行中的对话：abortController 非空
      const ongoingController = new AbortController();
      const { ctx } = createMockIpcContext({
        isAgentReady: true,
        abortController: ongoingController,
      });

      registerIpcHandlers(ctx as never);

      // 获取 SESSION_SWITCH 通道注册的 handle 回调
      const switchCallback = handleCallbacks.get('session-switch');
      expect(switchCallback).toBeDefined();

      // 触发会话切换
      const result = await switchCallback?.({}, { date: '2026-06-21', session: 'main' });

      // 验证：返回失败，错误消息提示有进行中的对话
      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining('进行中的对话'),
      });
    });

    it('无进行中对话时允许切换会话', async () => {
      const { registerIpcHandlers } = await import('../../../electron/ipc/handlers.js');
      const { ctx } = createMockIpcContext({
        isAgentReady: true,
        abortController: null, // 无进行中对话
      });

      registerIpcHandlers(ctx as never);

      const switchCallback = handleCallbacks.get('session-switch');
      const result = await switchCallback?.({}, { date: '2026-06-21', session: 'main' });

      // 验证：不因竞态保护而拒绝（可能因 mock agent 无 switchSession 方法而失败，
      // 但错误消息不应是"进行中的对话"）
      expect(result).not.toMatchObject({
        error: expect.stringContaining('进行中的对话'),
      });
    });
  });
});
