/**
 * IPC 处理器测试 — P1 修复回归测试
 *
 * 覆盖范围：
 * - P1-1: registerIpcHandlers 幂等性（reinitAgent 重复调用不抛错）
 * - P1-2: handleUserInput 在 Agent 未就绪时拒绝（reinitAgent 失败保护）
 * - P1-3: handleUserInput 竞态保护（进行中对话时拒绝新请求）
 *
 * Mock 策略：
 * - electron.ipcMain：使用 vi.fn() 捕获 handle/on/removeHandler/removeAllListeners 调用
 * - memora.toError：保留原实现（仅做错误对象标准化）
 * - IpcContext：构造最小化 mock 对象，仅满足 handleUserInput 前置检查
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock electron 模块 ──────────────────────────────────
// ipcHandlers.ts 顶部 import { ipcMain } from 'electron'，
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
    agent: {
      getMetrics: () => ({ context: { truncationCount: 0 } }),
    },
    sprite: {},
    sessionStore: {},
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
  };

  return { ctx, sentMessages, setAbortControllerCalls };
}

// ─── 测试套件 ─────────────────────────────────────────────

describe('ipcHandlers — P1 修复回归测试', () => {
  beforeEach(() => {
    // 每个测试前清空捕获的回调，避免测试间污染
    handleCallbacks.clear();
    onCallbacks.clear();
    vi.clearAllMocks();
  });

  // ─── P1-1: registerIpcHandlers 幂等性 ──────────────────

  describe('P1-1: registerIpcHandlers 幂等性（reinitAgent 重复调用）', () => {
    it('重复调用 registerIpcHandlers 不抛错', async () => {
      // 动态导入，确保 vi.mock('electron') 已生效
      const { registerIpcHandlers } = await import('../../electron/ipc/handlers.js');
      const { ctx } = createMockIpcContext({
        isAgentReady: true,
        abortController: null,
      });

      // 第一次注册：正常
      expect(() => registerIpcHandlers(ctx as never)).not.toThrow();

      // 第二次注册（模拟 reinitAgent 路径）：应清理旧通道后重新注册，不抛错
      // P1 修复前：遗漏 SESSION_SWITCH/DELETE/RENAME 的 removeHandler，
      // 导致 ipcMain.handle 重复注册抛 "Attempted to register a second handler"
      expect(() => registerIpcHandlers(ctx as never)).not.toThrow();
    });

    it('handleChannels 包含 SESSION_SWITCH/DELETE/RENAME 通道', async () => {
      const { registerIpcHandlers } = await import('../../electron/ipc/handlers.js');
      const { ipcMain } = await import('electron');
      const { ctx } = createMockIpcContext({
        isAgentReady: true,
        abortController: null,
      });

      registerIpcHandlers(ctx as never);

      // 验证 removeHandler 被调用的通道列表包含 P1 修复补充的三个通道
      const removeHandlerCalls = (ipcMain.removeHandler as ReturnType<typeof vi.fn>).mock.calls;
      const removedChannels = removeHandlerCalls.map((call: unknown[]) => call[0] as string);

      // P1 修复的关键断言：这三个通道必须被 removeHandler 清理，
      // 否则 reinitAgent 时 ipcMain.handle 会抛 "second handler" 错误
      expect(removedChannels).toContain('session-switch');
      expect(removedChannels).toContain('session-delete');
      expect(removedChannels).toContain('session-rename');
    });

    it('所有 handle 通道在重复注册前都被清理', async () => {
      const { registerIpcHandlers } = await import('../../electron/ipc/handlers.js');
      const { ipcMain } = await import('electron');
      const { ctx } = createMockIpcContext({
        isAgentReady: true,
        abortController: null,
      });

      registerIpcHandlers(ctx as never);

      // 获取第一次注册后所有 handle 注册的通道
      const handleCalls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
      const registeredChannels = handleCalls.map((call: unknown[]) => call[0] as string);

      // 清除 mock 调用记录，便于验证第二次注册前的清理
      vi.clearAllMocks();

      // 第二次注册
      registerIpcHandlers(ctx as never);

      // 验证第二次注册前，所有第一次注册的通道都被 removeHandler 清理
      const removeHandlerCalls = (ipcMain.removeHandler as ReturnType<typeof vi.fn>).mock.calls;
      const removedChannels = removeHandlerCalls.map((call: unknown[]) => call[0] as string);

      for (const channel of registeredChannels) {
        expect(removedChannels).toContain(channel);
      }
    });
  });

  // ─── P1-2: Agent 未就绪时拒绝对话 ──────────────────────

  describe('P1-2: handleUserInput 在 Agent 未就绪时拒绝', () => {
    it('isAgentReady()=false 时发送 SPRITE_ERROR 并提前返回', async () => {
      const { registerIpcHandlers } = await import('../../electron/ipc/handlers.js');
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
        text: expect.stringContaining('Agent 未就绪'),
      });

      // 验证：没有发送 SPRITE_STREAM_START（对话未启动）
      const streamStartMessages = sentMessages.filter((m) => m.channel === 'sprite-stream-start');
      expect(streamStartMessages).toHaveLength(0);
    });

    it('isAgentReady()=true 且无进行中对话时正常进入对话流程', async () => {
      const { registerIpcHandlers } = await import('../../electron/ipc/handlers.js');
      const { ctx, sentMessages } = createMockIpcContext({
        isAgentReady: true,
        abortController: null,
      });

      registerIpcHandlers(ctx as never);

      const userInputCallback = onCallbacks.get('user-input');
      userInputCallback?.({}, '测试消息');

      // 等待微任务让 async 函数执行到 agent.chat() 调用
      // agent.chat() 会因 mock agent 无 chat 方法而抛错，但前置检查应通过
      await new Promise((resolve) => setTimeout(resolve, 10));

      // 验证：发送了 SPRITE_STREAM_START（前置检查通过，对话已启动）
      // 注意：agent 是空对象 {}，chat() 调用会抛错，但 STREAM_START 在 try 之前发送
      const streamStartMessages = sentMessages.filter((m) => m.channel === 'sprite-stream-start');
      expect(streamStartMessages).toHaveLength(1);

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

  // ─── P1-3: 竞态保护 ────────────────────────────────────

  describe('P1-3: handleUserInput 竞态保护（进行中对话时拒绝）', () => {
    it('getAbortController() 非空时发送 SPRITE_ERROR 并提前返回', async () => {
      const { registerIpcHandlers } = await import('../../electron/ipc/handlers.js');
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
      const { registerIpcHandlers } = await import('../../electron/ipc/handlers.js');
      const { ctx, sentMessages } = createMockIpcContext({
        isAgentReady: false,
        abortController: new AbortController(),
      });

      registerIpcHandlers(ctx as never);

      const userInputCallback = onCallbacks.get('user-input');
      userInputCallback?.({}, '测试消息');

      await new Promise((resolve) => setTimeout(resolve, 10));

      // 验证：发送的是 "Agent 未就绪" 错误（isAgentReady 检查在前）
      const errorMessages = sentMessages.filter((m) => m.channel === 'sprite-error');
      expect(errorMessages).toHaveLength(1);
      expect(errorMessages[0]?.data).toMatchObject({
        text: expect.stringContaining('Agent 未就绪'),
      });
    });
  });

  // ─── 窗口销毁保护 ──────────────────────────────────────

  describe('窗口销毁保护', () => {
    it('fullWindow 为 null 时静默返回（不抛错）', async () => {
      const { registerIpcHandlers } = await import('../../electron/ipc/handlers.js');
      const ctx = {
        agent: {
          getMetrics: () => ({ context: { truncationCount: 0 } }),
        },
        sprite: {},
        sessionStore: {},
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
      };

      registerIpcHandlers(ctx as never);

      const userInputCallback = onCallbacks.get('user-input');
      // 不应抛错
      expect(() => userInputCallback?.({}, '测试消息')).not.toThrow();
    });
  });

  // ─── P2-AI-03: SESSION_SWITCH 竞态保护 ─────────────────

  describe('P2-AI-03: SESSION_SWITCH 进行中对话时拒绝', () => {
    it('有进行中对话时切换会话返回失败', async () => {
      const { registerIpcHandlers } = await import('../../electron/ipc/handlers.js');
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
      const { registerIpcHandlers } = await import('../../electron/ipc/handlers.js');
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
