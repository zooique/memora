/**
 * chatHandlers IPC 处理器测试
 *
 * 覆盖范围：
 * - CHAT_ABORT：有/无 AbortController 时的中断行为
 * - handleUserInput 前置检查分支（不覆盖 generator 消费，需独立集成测试）：
 *   - fullWindow 不存在/已销毁 → 直接返回
 *   - Agent 未就绪 → 发送 SPRITE_ERROR + 返回
 *   - 竞态保护（已有进行中对话）→ 发送 SPRITE_ERROR + 返回
 *   - 跨日 + sessionManager 未初始化 → 发送 SPRITE_ERROR + 返回
 *   - 跨日 + 正常重置 → restoreSession 调用 + 继续 flow
 *
 * Mock 策略：
 * - electron.ipcMain：vi.mock + handleCallbacks/onCallbacks Map
 * - errorHandler：mock handle 方法
 * - windowManager.getFullWindow()：返回 mock webContents（含 send/isVisible/isDestroyed）
 * - agent：mock agentHistory/sessionManager/agentLoop/chat/getMetrics
 * - getLocalDate：mock 为固定日期，确保跨日逻辑测试稳定
 *
 * 注意：handleUserInput 的 generator 消费部分（chunk 类型分发 + 超时兜底 + 中断通知）
 * 涉及 AsyncGenerator mock + 定时器，脆弱且 ROI 低，留待集成测试覆盖。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock electron 模块 ──────────────────────────────────
const handleCallbacks = new Map<string, (...args: unknown[]) => unknown>();
const onCallbacks = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, callback: (...args: unknown[]) => unknown) => {
      handleCallbacks.set(channel, callback);
    }),
    removeHandler: vi.fn((channel: string) => {
      handleCallbacks.delete(channel);
    }),
    on: vi.fn((channel: string, callback: (...args: unknown[]) => unknown) => {
      onCallbacks.set(channel, callback);
    }),
    removeAllListeners: vi.fn(),
  },
}));

// ─── Mock errorHandler 模块 ─────────────────────────────
vi.mock('../../../electron/errorHandler.js', () => ({
  errorHandler: {
    handle: vi.fn(),
  },
  ErrorCode: {
    UNKNOWN: 'UNKNOWN',
    API_ERROR: 'API_ERROR',
  },
}));

// ─── Mock memora 模块（logger + toError） ───────────────
// emitStreamError 内部调用 logger.warn，需 mock 验证
// vi.mock 是 hoisted 的，用 vi.hoisted 声明可在 factory 内引用的变量
const { loggerWarn } = vi.hoisted(() => ({ loggerWarn: vi.fn() }));
vi.mock('memora', () => ({
  logger: {
    warn: loggerWarn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  toError: vi.fn((err: unknown) => err instanceof Error ? err : new Error(String(err))),
}));

// ─── Mock getLocalDate 为固定日期（跨日逻辑测试稳定） ───
const MOCK_TODAY = '2026-06-26';
vi.mock('../../../sprite/constants.js', () => ({
  getLocalDate: vi.fn(() => MOCK_TODAY),
}));

// handleUserInput 已迁移到 chatStreamHandler.ts，registerChatHandlers 留在 chatHandlers.ts
import { registerChatHandlers } from '../../../electron/ipc/chatHandlers.js';
import { handleUserInput } from '../../../electron/ipc/chatStreamHandler.js';
import { IPC_CHANNELS, MAIN_TO_RENDERER_CHANNELS } from '../../../electron/ipc/channels.js';
import type { IpcContext } from '../../../electron/ipc/types.js';
// C2 错误降级测试需要验证 errorHandler.handle 调用
import { errorHandler } from '../../../electron/errorHandler.js';

// ─── 测试辅助 ─────────────────────────────────────────────

/** 创建 mock webContents（记录 send 调用） */
function createMockWebContents(options?: { visible?: boolean; destroyed?: boolean }) {
  const sends: { channel: string; data: unknown }[] = [];
  return {
    sends,
    webContents: {
      send: vi.fn((channel: string, data: unknown) => {
        sends.push({ channel, data });
      }),
      isVisible: vi.fn(() => options?.visible ?? true),
      isDestroyed: vi.fn(() => options?.destroyed ?? false),
    },
  };
}

/** 创建 mock windowManager（getFullWindow + getFloatWindow 返回 mock 窗口） */
function createMockWindowManager(webContents: ReturnType<typeof createMockWebContents>) {
  return {
    getFullWindow: vi.fn(() => ({
      webContents: webContents.webContents,
      isVisible: webContents.webContents.isVisible,
      isDestroyed: webContents.webContents.isDestroyed,
    })),
    // P4-1：浮动窗口消息预览需要 getFloatWindow mock
    getFloatWindow: vi.fn(() => ({
      send: vi.fn(),
    })),
  };
}

/** 创建 mock agent（含 agentHistory/sessionManager/agentLoop/chat/getMetrics） */
function createMockAgent(overrides?: {
  agentHistory?: { currentDateValue: string } | null;
  sessionManager?: { restoreSession: ReturnType<typeof vi.fn> } | null;
  agentLoop?: { restoreHistory: ReturnType<typeof vi.fn> } | null;
  chat?: ReturnType<typeof vi.fn>;
  getMetrics?: ReturnType<typeof vi.fn>;
  forceReleaseChatLock?: ReturnType<typeof vi.fn>;
}) {
  return {
    agentHistory: overrides?.agentHistory ?? null,
    sessionManager: overrides?.sessionManager ?? null,
    agentLoop: overrides?.agentLoop ?? null,
    chat: overrides?.chat ?? vi.fn(),
    getMetrics: overrides?.getMetrics ?? vi.fn(() => ({ context: { truncationCount: 0 } })),
    // 超时兜底强制释放内核锁的 mock（默认 no-op，测试可覆盖验证调用）
    forceReleaseChatLock: overrides?.forceReleaseChatLock ?? vi.fn(),
  } as unknown as ReturnType<IpcContext['getAgent']>;
}

/** 创建 mock IpcContext */
function createMockCtx(overrides?: {
  agent?: ReturnType<typeof createMockAgent> | null;
  windowManager?: ReturnType<typeof createMockWindowManager>;
  getAbortController?: ReturnType<typeof vi.fn>;
  isAgentReady?: ReturnType<typeof vi.fn>;
  trayManager?: { setState: ReturnType<typeof vi.fn> } | null;
}): IpcContext {
  const hasAgent = overrides && 'agent' in overrides;
  const hasWindowManager = overrides && 'windowManager' in overrides;
  const hasGetAbort = overrides && 'getAbortController' in overrides;
  const hasIsReady = overrides && 'isAgentReady' in overrides;
  const hasTray = overrides && 'trayManager' in overrides;
  // FIX-P1-1：getter 必须返回固定实例——IPC handler 调用的 mock 与测试断言验证的 mock 必须为同一对象，
  // 否则 forceReleaseChatLock 等断言因 mock 引用不一致而失败
  const agent = hasAgent
    ? (overrides!.agent as ReturnType<IpcContext['getAgent']>)
    : createMockAgent();
  // chatStreamHandler 调用 sprite.incrementDailyMessageCount() + prepareForChat() + sprite.activePersona，mock 需提供方法
  const sprite = {
    incrementDailyMessageCount: vi.fn(),
    prepareForChat: vi.fn(),
    // 公开 getter activePersona：返回 null 模拟"无激活角色"场景
    get activePersona() { return null; },
  } as unknown as ReturnType<IpcContext['getSprite']>;
  const sessionStore = {} as ReturnType<IpcContext['getSessionStore']>;
  return {
    // FIX-P1-7/FIX-P1-1：agent/sprite/sessionStore 改为函数式 getter，匹配 IpcContext 接口改造
    getAgent: () => agent,
    getSprite: () => sprite,
    getSessionStore: () => sessionStore,
    windowManager: hasWindowManager
      ? (overrides!.windowManager as IpcContext['windowManager'])
      : ({} as IpcContext['windowManager']),
    trayManager: hasTray ? overrides!.trayManager : null,
    getAbortController: hasGetAbort ? overrides!.getAbortController! : vi.fn(() => null),
    setAbortController: vi.fn(),
    isAgentReady: hasIsReady ? overrides!.isAgentReady! : vi.fn(() => true),
    getUnreadCount: vi.fn(() => 0),
    incrementUnreadCount: vi.fn(),
    resetUnreadCount: vi.fn(),
  } as unknown as IpcContext;
}

describe('chatHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handleCallbacks.clear();
    onCallbacks.clear();
    loggerWarn.mockClear();
  });

  // ─── CHAT_ABORT handler ────────────────────────────────

  describe('CHAT_ABORT', () => {
    it('有 AbortController 时应调用 abort 并返回 aborted: true', async () => {
      const abortController = new AbortController();
      const abortSpy = vi.spyOn(abortController, 'abort');
      const ctx = createMockCtx({
        getAbortController: vi.fn(() => abortController),
      });
      registerChatHandlers(ctx);

      const callback = handleCallbacks.get(IPC_CHANNELS.CHAT_ABORT)!;
      const result = await callback();

      expect(result).toEqual({ aborted: true });
      expect(abortSpy).toHaveBeenCalledTimes(1);
      // abort 应携带 DOMException（name='AbortError'）
      const reason = abortController.signal.reason;
      expect(reason).toBeInstanceOf(DOMException);
      expect((reason as DOMException).name).toBe('AbortError');
    });

    it('无 AbortController 时应直接返回 aborted: true（不抛错）', async () => {
      const ctx = createMockCtx({
        getAbortController: vi.fn(() => null),
      });
      registerChatHandlers(ctx);

      const callback = handleCallbacks.get(IPC_CHANNELS.CHAT_ABORT)!;
      const result = await callback();

      expect(result).toEqual({ aborted: true });
    });
  });

  // ─── CHAT_FORCE_RELEASE_LOCK handler ───────────────────

  describe('CHAT_FORCE_RELEASE_LOCK', () => {
    it('有进行中对话时应调用 forceReleaseChatLock + 清理 AbortController + 返回 released: true', async () => {
      const abortController = new AbortController();
      const ctx = createMockCtx({
        getAbortController: vi.fn(() => abortController),
      });
      registerChatHandlers(ctx);

      const callback = handleCallbacks.get(IPC_CHANNELS.CHAT_FORCE_RELEASE_LOCK)!;
      const result = await callback();

      // 应返回 released: true（之前有锁）
      expect(result).toEqual({ released: true });
      // 应调用内核 forceReleaseChatLock
      expect(ctx.getAgent().forceReleaseChatLock).toHaveBeenCalledTimes(1);
      // 应清理宿主侧 AbortController 引用
      expect(ctx.setAbortController).toHaveBeenCalledWith(null);
    });

    it('无进行中对话时应返回 released: false（幂等 no-op）', async () => {
      const ctx = createMockCtx({
        getAbortController: vi.fn(() => null),
      });
      registerChatHandlers(ctx);

      const callback = handleCallbacks.get(IPC_CHANNELS.CHAT_FORCE_RELEASE_LOCK)!;
      const result = await callback();

      // 应返回 released: false（本来就没锁）
      expect(result).toEqual({ released: false });
      // 内核 forceReleaseChatLock 仍被调用（幂等 no-op，由内核 _chatBusy 判断）
      expect(ctx.getAgent().forceReleaseChatLock).toHaveBeenCalledTimes(1);
      // 仍应清理 AbortController（防御性，确保状态一致）
      expect(ctx.setAbortController).toHaveBeenCalledWith(null);
    });
  });

  // ─── handleUserInput 前置检查分支 ──────────────────────

  describe('handleUserInput 前置检查', () => {
    it('fullWindow 不存在时应直接返回（不发送任何 IPC）', async () => {
      const wc = createMockWebContents();
      const wm = createMockWindowManager(wc);
      wm.getFullWindow.mockReturnValueOnce(null); // fullWindow 不存在
      const ctx = createMockCtx({ windowManager: wm });

      await handleUserInput('测试', ctx);

      // 不应发送任何消息（前置检查直接返回）
      expect(wc.sends).toHaveLength(0);
    });

    it('fullWindow 已销毁时应直接返回', async () => {
      const wc = createMockWebContents({ destroyed: true });
      const wm = createMockWindowManager(wc);
      const ctx = createMockCtx({ windowManager: wm });

      await handleUserInput('测试', ctx);

      expect(wc.sends).toHaveLength(0);
    });

    it('Agent 未就绪时应发送 SPRITE_ERROR 并返回', async () => {
      const wc = createMockWebContents();
      const wm = createMockWindowManager(wc);
      const ctx = createMockCtx({
        windowManager: wm,
        isAgentReady: vi.fn(() => false),
      });

      await handleUserInput('测试', ctx);

      // 应发送 SPRITE_ERROR，包含 Agent 正在初始化中提示
      const errorSend = wc.sends.find((s) => s.channel === MAIN_TO_RENDERER_CHANNELS.SPRITE_ERROR);
      expect(errorSend).toBeDefined();
      expect((errorSend!.data as { text: string }).text).toContain('Agent 正在初始化中');
    });

    it('已有进行中对话时应发送 SPRITE_ERROR（竞态保护）', async () => {
      const wc = createMockWebContents();
      const wm = createMockWindowManager(wc);
      const ctx = createMockCtx({
        windowManager: wm,
        isAgentReady: vi.fn(() => true),
        getAbortController: vi.fn(() => new AbortController()), // 模拟已有进行中对话
      });

      await handleUserInput('测试', ctx);

      const errorSend = wc.sends.find((s) => s.channel === MAIN_TO_RENDERER_CHANNELS.SPRITE_ERROR);
      expect(errorSend).toBeDefined();
      expect((errorSend!.data as { text: string }).text).toContain('上一条消息仍在处理中');
    });

    it('跨日 + sessionManager 未初始化时应发送 SPRITE_ERROR', async () => {
      const wc = createMockWebContents();
      const wm = createMockWindowManager(wc);
      const ctx = createMockCtx({
        windowManager: wm,
        isAgentReady: vi.fn(() => true),
        getAbortController: vi.fn(() => null),
        agent: createMockAgent({
          agentHistory: { currentDateValue: '2026-06-25' }, // 跨日：Agent 记录的日期是昨天
          sessionManager: null, // sessionManager 未初始化
        }),
      });

      await handleUserInput('测试', ctx);

      const errorSend = wc.sends.find((s) => s.channel === MAIN_TO_RENDERER_CHANNELS.SPRITE_ERROR);
      expect(errorSend).toBeDefined();
      expect((errorSend!.data as { text: string }).text).toContain('会话管理器未初始化');
    });

    it('跨日 + 正常重置应调用 restoreSession 并继续 flow', async () => {
      const wc = createMockWebContents();
      const wm = createMockWindowManager(wc);
      const restoreSession = vi.fn().mockResolvedValue(2); // 恢复 2 条消息
      const restoreHistory = vi.fn();
      const chatGen = (async function* () {
        yield { type: 'done' as const };
      })();
      const ctx = createMockCtx({
        windowManager: wm,
        isAgentReady: vi.fn(() => true),
        getAbortController: vi.fn(() => null),
        agent: createMockAgent({
          agentHistory: { currentDateValue: '2026-06-25' }, // 跨日
          sessionManager: { restoreSession, switchSession: vi.fn() },
          agentLoop: { restoreHistory },
          chat: vi.fn(() => chatGen),
        }),
      });

      await handleUserInput('测试', ctx);

      // 应调用 restoreSession 重置到当天 main
      expect(restoreSession).toHaveBeenCalledWith('2026-06-26', 'main');
      // 恢复 2 条消息，不应调用 restoreHistory([])（仅 restoredCount=0 时才清理）
      expect(restoreHistory).not.toHaveBeenCalledWith([]);
    });

    it('跨日 + 恢复 0 条消息时应清理 AgentLoop 历史', async () => {
      const wc = createMockWebContents();
      const wm = createMockWindowManager(wc);
      const restoreSession = vi.fn().mockResolvedValue(0); // 当天无消息
      const restoreHistory = vi.fn();
      const chatGen = (async function* () {
        yield { type: 'done' as const };
      })();
      const ctx = createMockCtx({
        windowManager: wm,
        isAgentReady: vi.fn(() => true),
        getAbortController: vi.fn(() => null),
        agent: createMockAgent({
          agentHistory: { currentDateValue: '2026-06-25' },
          sessionManager: { restoreSession, switchSession: vi.fn() },
          agentLoop: { restoreHistory },
          chat: vi.fn(() => chatGen),
        }),
      });

      await handleUserInput('测试', ctx);

      // restoredCount=0 时应清理旧上下文残留
      expect(restoreHistory).toHaveBeenCalledWith([]);
    });

    it('完整窗口不可见时应增加未读计数', async () => {
      const wc = createMockWebContents({ visible: false }); // 窗口不可见
      const wm = createMockWindowManager(wc);
      const chatGen = (async function* () {
        // 必须有 text 事件：accumulatedText 为空时（AI 无实际回复）不计入未读
        yield { type: 'text' as const, content: '回复' };
        yield { type: 'done' as const };
      })();
      const ctx = createMockCtx({
        windowManager: wm,
        agent: createMockAgent({
          chat: vi.fn(() => chatGen),
        }),
      });

      await handleUserInput('测试', ctx);

      expect(ctx.incrementUnreadCount).toHaveBeenCalled();
    });

    it('正常 flow 应发送 SPRITE_STREAM_START 并设置 AbortController', async () => {
      const wc = createMockWebContents();
      const wm = createMockWindowManager(wc);
      const chatGen = (async function* () {
        yield { type: 'done' as const };
      })();
      const ctx = createMockCtx({
        windowManager: wm,
        agent: createMockAgent({
          chat: vi.fn(() => chatGen),
        }),
      });

      await handleUserInput('测试', ctx);

      // 应发送 SPRITE_STREAM_START
      const startSend = wc.sends.find((s) => s.channel === MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_START);
      expect(startSend).toBeDefined();
      expect((startSend!.data as { messageId: string }).messageId).toBeTruthy();

      // 应设置 AbortController
      expect(ctx.setAbortController).toHaveBeenCalled();
      // finally 块应清理 AbortController（设为 null）
      expect(ctx.setAbortController).toHaveBeenLastCalledWith(null);

      // 应发送 SPRITE_STREAM_END（finally 块）
      const endSend = wc.sends.find((s) => s.channel === MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_END);
      expect(endSend).toBeDefined();
    });

    it('托盘应在对话开始时切 active，结束时切 idle', async () => {
      const wc = createMockWebContents();
      const wm = createMockWindowManager(wc);
      const setState = vi.fn();
      const chatGen = (async function* () {
        yield { type: 'done' as const };
      })();
      const ctx = createMockCtx({
        windowManager: wm,
        trayManager: { setState },
        agent: createMockAgent({
          chat: vi.fn(() => chatGen),
        }),
      });

      await handleUserInput('测试', ctx);

      // 开始时 active，结束时 idle
      expect(setState).toHaveBeenCalledWith('active');
      expect(setState).toHaveBeenLastCalledWith('idle');
    });
  });

  // ─── emitStreamError 日志记录 ──

  describe('emitStreamError 日志记录', () => {
    /**
     * 验证 emitStreamError 辅助函数的行为契约：
     * 1. 推送 SPRITE_ERROR 到渲染进程（保留原有 UI 提示）
     * 2. 调用 logger.warn 记录主进程日志（补齐可观测性）
     *
     * 通过 handleUserInput 的前置检查分支间接验证 emitStreamError，
     * 覆盖 3 个业务拒绝场景 + 1 个超时场景（超时场景需定时器 mock，留待集成测试）。
     */

    it('Agent 未就绪时应调用 logger.warn 记录上下文', async () => {
      const wc = createMockWebContents();
      const wm = createMockWindowManager(wc);
      const ctx = createMockCtx({
        windowManager: wm,
        isAgentReady: vi.fn(() => false),
      });

      await handleUserInput('测试', ctx);

      // 验证 logger.warn 被调用，携带 context 字段
      expect(loggerWarn).toHaveBeenCalledTimes(1);
      const logPayload = loggerWarn.mock.calls[0]![0] as { context: string; text: string };
      expect(logPayload.context).toBe('Agent 未就绪');
    });

    it('竞态保护时应调用 logger.warn 记录上下文', async () => {
      const wc = createMockWebContents();
      const wm = createMockWindowManager(wc);
      const ctx = createMockCtx({
        windowManager: wm,
        isAgentReady: vi.fn(() => true),
        getAbortController: vi.fn(() => new AbortController()),
      });

      await handleUserInput('测试', ctx);

      expect(loggerWarn).toHaveBeenCalledTimes(1);
      const logPayload = loggerWarn.mock.calls[0]![0] as { context: string };
      expect(logPayload.context).toBe('对话竞态保护');
    });

    it('SessionManager 未初始化时应调用 logger.warn 记录上下文', async () => {
      const wc = createMockWebContents();
      const wm = createMockWindowManager(wc);
      const ctx = createMockCtx({
        windowManager: wm,
        isAgentReady: vi.fn(() => true),
        getAbortController: vi.fn(() => null),
        agent: createMockAgent({
          agentHistory: { currentDateValue: '2026-06-25' },
          sessionManager: null,
        }),
      });

      await handleUserInput('测试', ctx);

      expect(loggerWarn).toHaveBeenCalledTimes(1);
      const logPayload = loggerWarn.mock.calls[0]![0] as { context: string };
      expect(logPayload.context).toBe('SessionManager 未初始化');
    });

    it('logger.warn 和 SPRITE_ERROR 推送应同时发生（双通道通知）', async () => {
      const wc = createMockWebContents();
      const wm = createMockWindowManager(wc);
      const ctx = createMockCtx({
        windowManager: wm,
        isAgentReady: vi.fn(() => false),
      });

      await handleUserInput('测试', ctx);

      // 双通道：logger.warn（主进程日志）+ SPRITE_ERROR（渲染进程 UI 提示）
      expect(loggerWarn).toHaveBeenCalled();
      const errorSend = wc.sends.find((s) => s.channel === MAIN_TO_RENDERER_CHANNELS.SPRITE_ERROR);
      expect(errorSend).toBeDefined();
    });

    it('正常 flow 不应调用 logger.warn（仅错误路径才记录）', async () => {
      const wc = createMockWebContents();
      const wm = createMockWindowManager(wc);
      const chatGen = (async function* () {
        yield { type: 'done' as const };
      })();
      const ctx = createMockCtx({
        windowManager: wm,
        agent: createMockAgent({
          chat: vi.fn(() => chatGen),
        }),
      });

      await handleUserInput('测试', ctx);

      // 正常流程不应触发 emitStreamError
      expect(loggerWarn).not.toHaveBeenCalled();
    });
  });
});

// ─── C1：chatStreamHandler 流式主路径补测（chunk 类型分发） ──
//
// 覆盖目标：
//   - text chunk：累积 delta + 推送 SPRITE_STREAM_CHUNK（完整文本，非增量）
//   - recall chunk：推送 SPRITE_STREAM_RECALL（召回记忆摘要）
//   - tool_start chunk：推送 SPRITE_STREAM_TOOL_START（工具名 + 参数）
//   - tool_result chunk：推送 SPRITE_STREAM_TOOL_RESULT（工具名 + 成功状态 + 摘要）
//   - thinking chunk：推送 SPRITE_STREAM_THINKING（阶段名称）
//   - done chunk：截断检测（truncationCount 增加时推送 SPRITE_CONTEXT_TRUNCATED）+ 发送 archiving keepalive
//   - 完整窗口不可见时累加未读计数 + 托盘切换 active 状态
//   - 正常结束发送 SPRITE_STREAM_START + SPRITE_STREAM_END + 托盘切回 idle

describe('chatStreamHandler C1 流式主路径', () => {
  /** 创建流式测试专用 mock ctx（含可见窗口 + 就绪 Agent） */
  function createStreamMockCtx(chatGen: AsyncGenerator): {
    ctx: IpcContext;
    sends: { channel: string; data: unknown }[];
    traySetState: ReturnType<typeof vi.fn>;
    setAbortController: ReturnType<typeof vi.fn>;
    incrementUnread: ReturnType<typeof vi.fn>;
    incrementDaily: ReturnType<typeof vi.fn>;
    prepareForChat: ReturnType<typeof vi.fn>;
    getMetrics: ReturnType<typeof vi.fn>;
  } {
    const sends: { channel: string; data: unknown }[] = [];
    const traySetState = vi.fn();
    const setAbortController = vi.fn();
    const incrementUnread = vi.fn();
    const incrementDaily = vi.fn();
    const prepareForChat = vi.fn();
    // getMetrics 默认返回 truncationCount=0，测试可后续 mockReturnValue
    const getMetrics = vi.fn(() => ({ context: { truncationCount: 0 } }));

    const wm = createMockWindowManager(createMockWebContents({ visible: true, destroyed: false }));
    const ctx = createMockCtx({
      windowManager: wm,
      isAgentReady: vi.fn(() => true),
      getAbortController: vi.fn(() => null),
      trayManager: { setState: traySetState },
      agent: createMockAgent({
        chat: vi.fn(() => chatGen),
        getMetrics,
      }),
    });
    // 覆盖 sprite mock（createMockCtx 内 sprite 是新建的，需重新指向）
    // activePersona 返回 null 模拟"无激活角色"场景（消息底部不显示角色标签）
    (ctx as unknown as { getSprite: () => unknown }).getSprite = () => ({
      incrementDailyMessageCount: incrementDaily,
      prepareForChat,
      get activePersona() { return null; },
    });
    (ctx as unknown as { setAbortController: unknown }).setAbortController = setAbortController;
    (ctx as unknown as { incrementUnreadCount: unknown }).incrementUnreadCount = incrementUnread;
    // 拦截 webContents.send 到 sends 数组
    const fullWindow = wm.getFullWindow();
    (fullWindow.webContents.send as ReturnType<typeof vi.fn>).mockImplementation(
      (channel: string, data: unknown) => {
        sends.push({ channel, data });
      },
    );

    return { ctx, sends, traySetState, setAbortController, incrementUnread, incrementDaily, prepareForChat, getMetrics };
  }

  it('text chunk 应累积 delta 并推送 SPRITE_STREAM_CHUNK（完整文本）', async () => {
    const chatGen = (async function* () {
      yield { type: 'text' as const, content: '你好' };
      yield { type: 'text' as const, content: '，世界' };
      yield { type: 'done' as const };
    })();
    const { ctx, sends } = createStreamMockCtx(chatGen);

    await handleUserInput('测试', ctx);

    // 应推送两次 CHUNK，第二次为完整文本"你好，世界"
    const chunks = sends.filter((s) => s.channel === MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_CHUNK);
    expect(chunks).toHaveLength(2);
    expect((chunks[0]!.data as { text: string }).text).toBe('你好');
    expect((chunks[1]!.data as { text: string }).text).toBe('你好，世界');
  });

  it('recall chunk 应推送 SPRITE_STREAM_RECALL（含 memories 数组）', async () => {
    const memories = [{ id: '1', name: '记忆A', content: '内容A' }];
    const chatGen = (async function* () {
      yield { type: 'recall' as const, memories };
      yield { type: 'done' as const };
    })();
    const { ctx, sends } = createStreamMockCtx(chatGen);

    await handleUserInput('测试', ctx);

    const recall = sends.find((s) => s.channel === MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_RECALL);
    expect(recall).toBeDefined();
    expect((recall!.data as { memories: unknown[] }).memories).toEqual(memories);
  });

  it('tool_start chunk 应推送 SPRITE_STREAM_TOOL_START（工具名 + 参数）', async () => {
    const chatGen = (async function* () {
      yield {
        type: 'tool_start' as const,
        toolCallId: 'tc-1',
        name: 'read_file',
        args: { path: '/test.md' },
      };
      yield { type: 'done' as const };
    })();
    const { ctx, sends } = createStreamMockCtx(chatGen);

    await handleUserInput('测试', ctx);

    const toolStart = sends.find((s) => s.channel === MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_TOOL_START);
    expect(toolStart).toBeDefined();
    expect((toolStart!.data as { name: string; args: unknown }).name).toBe('read_file');
    expect((toolStart!.data as { toolCallId: string }).toolCallId).toBe('tc-1');
  });

  it('tool_result chunk 应推送 SPRITE_STREAM_TOOL_RESULT（成功状态 + 摘要）', async () => {
    const chatGen = (async function* () {
      yield {
        type: 'tool_result' as const,
        toolCallId: 'tc-1',
        name: 'read_file',
        ok: true,
        summary: '文件内容摘要',
      };
      yield { type: 'done' as const };
    })();
    const { ctx, sends } = createStreamMockCtx(chatGen);

    await handleUserInput('测试', ctx);

    const toolResult = sends.find((s) => s.channel === MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_TOOL_RESULT);
    expect(toolResult).toBeDefined();
    expect((toolResult!.data as { ok: boolean; summary: string }).ok).toBe(true);
    expect((toolResult!.data as { summary: string }).summary).toBe('文件内容摘要');
  });

  it('thinking chunk 应推送 SPRITE_STREAM_THINKING（阶段名称）', async () => {
    const chatGen = (async function* () {
      yield { type: 'thinking' as const, phase: '回忆中' };
      yield { type: 'done' as const };
    })();
    const { ctx, sends } = createStreamMockCtx(chatGen);

    await handleUserInput('测试', ctx);

    const thinking = sends.filter((s) => s.channel === MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_THINKING);
    // done 也会发一个 thinking（phase=archiving keepalive）
    expect(thinking.length).toBeGreaterThanOrEqual(1);
    expect((thinking[0]!.data as { phase: string }).phase).toBe('回忆中');
  });

  it('done chunk 应推送 archiving keepalive thinking（覆盖 postProcess 窗口期）', async () => {
    const chatGen = (async function* () {
      yield { type: 'done' as const };
    })();
    const { ctx, sends } = createStreamMockCtx(chatGen);

    await handleUserInput('测试', ctx);

    const thinking = sends.filter((s) => s.channel === MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_THINKING);
    // done 后应发一个 phase=archiving 的 thinking keepalive
    const archiving = thinking.find((s) => (s.data as { phase: string }).phase === 'archiving');
    expect(archiving).toBeDefined();
  });

  it('done chunk 检测到截断次数增加时应推送 SPRITE_CONTEXT_TRUNCATED', async () => {
    const chatGen = (async function* () {
      yield { type: 'done' as const };
    })();
    const { ctx, sends, getMetrics } = createStreamMockCtx(chatGen);
    // 第一次调用返回 truncationCount=0（对话开始前），第二次返回 2（对话结束后）
    getMetrics
      .mockReturnValueOnce({ context: { truncationCount: 0 } })
      .mockReturnValueOnce({ context: { truncationCount: 2 } });

    await handleUserInput('测试', ctx);

    const truncated = sends.find((s) => s.channel === MAIN_TO_RENDERER_CHANNELS.SPRITE_CONTEXT_TRUNCATED);
    expect(truncated).toBeDefined();
    expect((truncated!.data as { count: number }).count).toBe(2);
  });

  it('done chunk 截断次数未变时不应推送 SPRITE_CONTEXT_TRUNCATED', async () => {
    const chatGen = (async function* () {
      yield { type: 'done' as const };
    })();
    const { ctx, sends } = createStreamMockCtx(chatGen);

    await handleUserInput('测试', ctx);

    const truncated = sends.find((s) => s.channel === MAIN_TO_RENDERER_CHANNELS.SPRITE_CONTEXT_TRUNCATED);
    expect(truncated).toBeUndefined();
  });

  it('完整窗口不可见时应累加未读计数', async () => {
    const chatGen = (async function* () {
      // 必须有 text 事件：accumulatedText 为空时（AI 无实际回复）不计入未读
      yield { type: 'text' as const, content: '回复' };
      yield { type: 'done' as const };
    })();
    // 构造不可见窗口
    const sends: { channel: string; data: unknown }[] = [];
    const wm = createMockWindowManager(createMockWebContents({ visible: false, destroyed: false }));
    const incrementUnread = vi.fn();
    const ctx = createMockCtx({
      windowManager: wm,
      isAgentReady: vi.fn(() => true),
      getAbortController: vi.fn(() => null),
      agent: createMockAgent({ chat: vi.fn(() => chatGen) }),
    });
    (ctx as unknown as { getSprite: () => unknown }).getSprite = () => ({
      incrementDailyMessageCount: vi.fn(),
      prepareForChat: vi.fn(),
    });
    (ctx as unknown as { incrementUnreadCount: unknown }).incrementUnreadCount = incrementUnread;
    const fullWindow = wm.getFullWindow();
    (fullWindow.webContents.send as ReturnType<typeof vi.fn>).mockImplementation(
      (channel: string, data: unknown) => sends.push({ channel, data }),
    );

    await handleUserInput('测试', ctx);

    expect(incrementUnread).toHaveBeenCalledTimes(1);
  });

  it('正常结束应发送 SPRITE_STREAM_START + SPRITE_STREAM_END + 托盘切回 idle', async () => {
    const chatGen = (async function* () {
      yield { type: 'text' as const, content: '回复' };
      yield { type: 'done' as const };
    })();
    const { ctx, sends, traySetState } = createStreamMockCtx(chatGen);

    await handleUserInput('测试', ctx);

    // 应发送 START 和 END
    const start = sends.find((s) => s.channel === MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_START);
    const end = sends.find((s) => s.channel === MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_END);
    expect(start).toBeDefined();
    expect(end).toBeDefined();
    // 托盘应先切 active 再切 idle
    expect(traySetState).toHaveBeenCalledWith('active');
    expect(traySetState).toHaveBeenCalledWith('idle');
  });

  it('应调用 sprite.prepareForChat + sprite.incrementDailyMessageCount（对话前感知刷新 + 消息计数）', async () => {
    const chatGen = (async function* () {
      yield { type: 'done' as const };
    })();
    const { ctx, incrementDaily, prepareForChat } = createStreamMockCtx(chatGen);

    await handleUserInput('测试文本', ctx);

    expect(prepareForChat).toHaveBeenCalledWith('测试文本');
    expect(incrementDaily).toHaveBeenCalledTimes(1);
  });
});

// ─── C2：chatStreamHandler 超时 + 中断 + 错误降级 ──
//
// 覆盖目标：
//   - 60s 无进展超时兜底：定时器触发 → abort + 推送 SPRITE_ERROR + STREAM_END + 清理 AbortController
//   - aborted chunk：内核主动 yield aborted → 推送 SPRITE_STREAM_ABORTED + break + finally 发 END
//   - error chunk：内核 yield error → 推送 SPRITE_STREAM_ABORTED + break + 不发 SPRITE_ERROR
//   - AbortError（用户中断）：generator throw AbortError → 推送 SPRITE_STREAM_ABORTED（reason=用户手动停止）+ 不上报 errorHandler
//   - 其他异常（LLM 错误）：generator throw Error → 推送 SPRITE_ERROR + 上报 errorHandler
//   - 超时路径不重复发 STREAM_END（幂等保护）
//   - 窗口销毁时 break 退出循环

describe('chatStreamHandler C2 超时 + 中断 + 错误降级', () => {
  /**
   * 创建流式测试专用 mock ctx（C2 版本）
   *
   * 与 C1 的区别：
   * - chat mock 接收 (text, signal) 参数，让 generator 能响应 abort
   * - setAbortController 真实写入 ref，让 catch 块能读取 signal.reason
   */
  function createStreamMockCtxV2(chatGenFactory: (signal: AbortSignal) => AsyncGenerator): {
    ctx: IpcContext;
    sends: { channel: string; data: unknown }[];
    traySetState: ReturnType<typeof vi.fn>;
    abortControllerRef: { current: AbortController | null };
    incrementDaily: ReturnType<typeof vi.fn>;
    prepareForChat: ReturnType<typeof vi.fn>;
    getMetrics: ReturnType<typeof vi.fn>;
  } {
    const sends: { channel: string; data: unknown }[] = [];
    const traySetState = vi.fn();
    const incrementDaily = vi.fn();
    const prepareForChat = vi.fn();
    const getMetrics = vi.fn(() => ({ context: { truncationCount: 0 } }));
    // 真实存储 AbortController，让 catch 块能读取 signal.reason
    const abortControllerRef: { current: AbortController | null } = { current: null };

    const wm = createMockWindowManager(createMockWebContents({ visible: true, destroyed: false }));
    const ctx = createMockCtx({
      windowManager: wm,
      isAgentReady: vi.fn(() => true),
      getAbortController: vi.fn(() => abortControllerRef.current),
      trayManager: { setState: traySetState },
      agent: createMockAgent({
        // chat mock 接收 (text, signal)，传给 factory 创建 generator
        chat: vi.fn((_text: string, signal: AbortSignal) => chatGenFactory(signal)),
        getMetrics,
      }),
    });
    (ctx as unknown as { getSprite: () => unknown }).getSprite = () => ({
      incrementDailyMessageCount: incrementDaily,
      prepareForChat,
      // activePersona 返回 null 模拟"无激活角色"场景
      get activePersona() { return null; },
    });
    (ctx as unknown as { setAbortController: unknown }).setAbortController = vi.fn(
      (ctrl: AbortController | null) => {
        abortControllerRef.current = ctrl;
      },
    );
    const fullWindow = wm.getFullWindow();
    (fullWindow.webContents.send as ReturnType<typeof vi.fn>).mockImplementation(
      (channel: string, data: unknown) => {
        sends.push({ channel, data });
      },
    );

    return { ctx, sends, traySetState, abortControllerRef, incrementDaily, prepareForChat, getMetrics };
  }

  it('60s 无进展超时应触发 abort + 推送 SPRITE_ERROR + STREAM_END + 清理 AbortController', async () => {
    vi.useFakeTimers();
    // generator yield 一个 chunk 后等待 abort 信号（模拟 LLM 卡死，超时后 abort 触发 reject）
    const { ctx, sends, traySetState, abortControllerRef } = createStreamMockCtxV2((signal) => {
      return (async function* () {
        yield { type: 'text' as const, content: '第一条' };
        // 等待 abort 信号：超时触发 abort 时 reject AbortError，让 generator 退出
        await new Promise<void>((_, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('流式输出无进展超时', 'TimeoutError')),
            { once: true },
          );
        });
      })();
    });

    // 启动 handleUserInput（不 await，让定时器可推进）
    const promise = handleUserInput('测试', ctx);
    // 推进 60s + 1ms 触发超时
    await vi.advanceTimersByTimeAsync(60_001);
    await promise;

    // 应推送 SPRITE_ERROR（含超时提示）
    const errorSend = sends.find((s) => s.channel === MAIN_TO_RENDERER_CHANNELS.SPRITE_ERROR);
    expect(errorSend).toBeDefined();
    expect((errorSend!.data as { text: string }).text).toContain('超时');
    // 应推送 STREAM_END（超时路径在定时器内发送）
    const end = sends.find((s) => s.channel === MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_END);
    expect(end).toBeDefined();
    // 应清理 AbortController
    expect(abortControllerRef.current).toBeNull();
    // 托盘应切回 idle
    expect(traySetState).toHaveBeenCalledWith('idle');
    // 应调用 forceReleaseChatLock 强制释放内核锁（防止 generator 挂起导致锁泄漏）
    expect(ctx.getAgent().forceReleaseChatLock).toHaveBeenCalled();
    // loggerWarn 应被调用（emitStreamError 内部）
    expect(loggerWarn).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('aborted chunk 应推送 SPRITE_STREAM_ABORTED + finally 发 END（单点路由）', async () => {
    const { ctx, sends } = createStreamMockCtxV2(() => {
      return (async function* () {
        yield { type: 'aborted' as const, reason: '用户手动停止' };
      })();
    });

    await handleUserInput('测试', ctx);

    // 应推送 SPRITE_STREAM_ABORTED（含 reason）
    const aborted = sends.find((s) => s.channel === MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_ABORTED);
    expect(aborted).toBeDefined();
    expect((aborted!.data as { reason: string }).reason).toBe('用户手动停止');
    // finally 应发 STREAM_END
    const end = sends.find((s) => s.channel === MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_END);
    expect(end).toBeDefined();
  });

  it('error chunk 应推送 SPRITE_STREAM_ABORTED（复用通道）+ break + finally 发 END', async () => {
    const { ctx, sends } = createStreamMockCtxV2(() => {
      return (async function* () {
        yield { type: 'error' as const, message: 'LLM 连接断开' };
      })();
    });

    await handleUserInput('测试', ctx);

    // error chunk 复用 SPRITE_STREAM_ABORTED 通道
    const aborted = sends.find((s) => s.channel === MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_ABORTED);
    expect(aborted).toBeDefined();
    expect((aborted!.data as { reason: string }).reason).toBeTruthy();
    // finally 应发 STREAM_END
    const end = sends.find((s) => s.channel === MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_END);
    expect(end).toBeDefined();
    // error chunk 不应触发 SPRITE_ERROR（用 SPRITE_STREAM_ABORTED 替代）
    const errorSend = sends.find((s) => s.channel === MAIN_TO_RENDERER_CHANNELS.SPRITE_ERROR);
    expect(errorSend).toBeUndefined();
  });

  it('AbortError（用户中断）应推送 SPRITE_STREAM_ABORTED + 不上报 errorHandler', async () => {
    // 构造 AbortError：generator throw DOMException(name='AbortError')
    const { ctx, sends, abortControllerRef } = createStreamMockCtxV2(() => {
      return (async function* () {
        throw new DOMException('用户中断', 'AbortError');
      })();
    });

    // 在 handleUserInput 创建 AbortController 后（setAbortController 回调内），
    // 立即 abort 它，让 catch 块能读到 AbortError reason
    const originalSetAbort = (ctx.setAbortController as ReturnType<typeof vi.fn>);
    originalSetAbort.mockImplementation((ctrl: AbortController | null) => {
      abortControllerRef.current = ctrl;
      // 模拟用户中断：在 controller 创建后立即 abort
      if (ctrl) {
        ctrl.abort(new DOMException('用户中断', 'AbortError'));
      }
    });

    await handleUserInput('测试', ctx);

    // 应推送 SPRITE_STREAM_ABORTED（reason=用户手动停止）
    const aborted = sends.find((s) => s.channel === MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_ABORTED);
    expect(aborted).toBeDefined();
    expect((aborted!.data as { reason: string }).reason).toBe('用户手动停止');
    // 不应推送 SPRITE_ERROR（用户中断不是错误）
    const errorSend = sends.find((s) => s.channel === MAIN_TO_RENDERER_CHANNELS.SPRITE_ERROR);
    expect(errorSend).toBeUndefined();
    // 不应上报 errorHandler（用户中断不记录为错误）
    expect(errorHandler.handle).not.toHaveBeenCalled();
  });

  it('其他异常（LLM 错误）应推送 SPRITE_ERROR + 上报 errorHandler', async () => {
    const llmError = new Error('LLM 服务不可用');
    const { ctx, sends } = createStreamMockCtxV2(() => {
      return (async function* () {
        throw llmError;
      })();
    });

    await handleUserInput('测试', ctx);

    // 应推送 SPRITE_ERROR（含错误信息）
    const errorSend = sends.find((s) => s.channel === MAIN_TO_RENDERER_CHANNELS.SPRITE_ERROR);
    expect(errorSend).toBeDefined();
    expect((errorSend!.data as { text: string }).text).toBeTruthy();
    // 应上报 errorHandler
    expect(errorHandler.handle).toHaveBeenCalled();
    // 不应推送 SPRITE_STREAM_ABORTED（非中断场景）
    const aborted = sends.find((s) => s.channel === MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_ABORTED);
    expect(aborted).toBeUndefined();
  });

  it('超时路径不应重复发 STREAM_END（幂等保护）', async () => {
    vi.useFakeTimers();
    // generator yield 一个 chunk 后等待 abort 信号
    const { ctx, sends } = createStreamMockCtxV2((signal) => {
      return (async function* () {
        yield { type: 'text' as const, content: '第一条' };
        await new Promise<void>((_, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('流式输出无进展超时', 'TimeoutError')),
            { once: true },
          );
        });
      })();
    });

    const promise = handleUserInput('测试', ctx);
    await vi.advanceTimersByTimeAsync(60_001);
    await promise;

    // 超时路径在定时器内发过一次 STREAM_END，finally 块因 streamTimedOut=true 跳过
    const ends = sends.filter((s) => s.channel === MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_END);
    expect(ends).toHaveLength(1);
    // 超时路径应调用 forceReleaseChatLock（与上一个超时测试一致）
    expect(ctx.getAgent().forceReleaseChatLock).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('窗口销毁时应 break 退出循环（不抛错）', async () => {
    // 构造窗口在第一个 chunk 后销毁
    const sends: { channel: string; data: unknown }[] = [];
    const wm = createMockWindowManager(createMockWebContents({ visible: true, destroyed: false }));
    const ctx = createMockCtx({
      windowManager: wm,
      isAgentReady: vi.fn(() => true),
      getAbortController: vi.fn(() => null),
      agent: createMockAgent({
        chat: vi.fn(() => {
          return (async function* () {
            yield { type: 'text' as const, content: '第一条' };
            yield { type: 'text' as const, content: '第二条' };
            yield { type: 'done' as const };
          })();
        }),
      }),
    });
    (ctx as unknown as { getSprite: () => unknown }).getSprite = () => ({
      incrementDailyMessageCount: vi.fn(),
      prepareForChat: vi.fn(),
    });
    const fullWindow = wm.getFullWindow();
    // 第一个 chunk 发送后标记窗口为已销毁（下次循环检查 isDestroyed 时 break）
    (fullWindow.webContents.send as ReturnType<typeof vi.fn>).mockImplementation(
      (channel: string, data: unknown) => {
        sends.push({ channel, data });
        // 第一次 send 是 SPRITE_STREAM_START，第二次是 CHUNK，之后标记销毁
        if (sends.length >= 2) {
          (fullWindow.isDestroyed as ReturnType<typeof vi.fn>).mockReturnValue(true);
        }
      },
    );

    await handleUserInput('测试', ctx);

    // 应只发送 1 个 CHUNK（第一个 chunk 后窗口销毁，break 退出，第二个 chunk 不发送）
    const chunks = sends.filter((s) => s.channel === MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_CHUNK);
    expect(chunks).toHaveLength(1);
  });
});
