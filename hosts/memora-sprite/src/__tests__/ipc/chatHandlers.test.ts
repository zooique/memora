/**
 * chatHandlers IPC 处理器测试（QC-TEST-CHAT）
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
vi.mock('../../electron/errorHandler.js', () => ({
  errorHandler: {
    handle: vi.fn(),
  },
  ErrorCode: {
    UNKNOWN: 'UNKNOWN',
    API_ERROR: 'API_ERROR',
  },
}));

// ─── Mock getLocalDate 为固定日期（跨日逻辑测试稳定） ───
const MOCK_TODAY = '2026-06-26';
vi.mock('../../sprite/constants.js', () => ({
  getLocalDate: vi.fn(() => MOCK_TODAY),
}));

// QC-R2-04：handleUserInput 已迁移到 chatStreamHandler.ts，registerChatHandlers 留在 chatHandlers.ts
import { registerChatHandlers } from '../../electron/ipc/chatHandlers.js';
import { handleUserInput } from '../../electron/ipc/chatStreamHandler.js';
import { IPC_CHANNELS, MAIN_TO_RENDERER_CHANNELS } from '../../electron/ipc/channels.js';
import type { IpcContext } from '../../electron/ipc/types.js';

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

/** 创建 mock windowManager（getFullWindow 返回 mock 窗口） */
function createMockWindowManager(webContents: ReturnType<typeof createMockWebContents>) {
  return {
    getFullWindow: vi.fn(() => ({
      webContents: webContents.webContents,
      isVisible: webContents.webContents.isVisible,
      isDestroyed: webContents.webContents.isDestroyed,
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
}) {
  return {
    agentHistory: overrides?.agentHistory ?? null,
    sessionManager: overrides?.sessionManager ?? null,
    agentLoop: overrides?.agentLoop ?? null,
    chat: overrides?.chat ?? vi.fn(),
    getMetrics: overrides?.getMetrics ?? vi.fn(() => ({ context: { truncationCount: 0 } })),
  } as unknown as IpcContext['agent'];
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
  return {
    agent: hasAgent ? (overrides!.agent as IpcContext['agent']) : createMockAgent(),
    sprite: {} as IpcContext['sprite'],
    sessionStore: {} as IpcContext['sessionStore'],
    windowStateManager: {} as IpcContext['windowStateManager'],
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

      // 应发送 SPRITE_ERROR，包含 Agent 未就绪提示
      const errorSend = wc.sends.find((s) => s.channel === MAIN_TO_RENDERER_CHANNELS.SPRITE_ERROR);
      expect(errorSend).toBeDefined();
      expect((errorSend!.data as { text: string }).text).toContain('Agent 未就绪');
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
          sessionManager: { restoreSession },
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
          sessionManager: { restoreSession },
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
});
