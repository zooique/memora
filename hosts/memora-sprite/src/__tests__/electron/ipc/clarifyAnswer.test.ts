/**
 * 澄清回答链路防回归测试（SSOT 排雷第二轮 T1）
 *
 * 历史缺陷：chatHandlers 以 `void agent.processEvent(event)` 消费 async generator，
 * 而 async generator 不迭代则函数体一行不执行 → auto-resume / Composer 补槽 /
 * clarify→chat 转换 / resetConsecutivePauseCount 全链路失效，且 IPC 照常返回 success。
 *
 * 防回归判据：processEvent 的 async generator **函数体必须被执行**（= 被完整迭代），
 * 且事件负载为 {type:'clarify'}。旧实现（void 丢弃）下函数体不执行 → 断言红；
 * 修复后（handleClarifyAnswer 经 forwardStream 迭代）→ 断言绿。
 *
 * Mock 策略：
 * - electron.ipcMain：vi.mock + handleCallbacks Map（与 workProjectionHandlers.test.ts 同模式）
 * - agent.processEvent：async generator，函数体置 iterated=true（判别"是否被迭代"的唯一依据）
 * - windowManager/trayManager/errorHandler：最小 stub（forwardStream 所需）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock electron 模块 ──────────────────────────────────
const handleCallbacks = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, callback: (...args: unknown[]) => unknown) => {
      handleCallbacks.set(channel, callback);
    }),
    removeHandler: vi.fn((channel: string) => {
      handleCallbacks.delete(channel);
    }),
    on: vi.fn(),
    removeAllListeners: vi.fn(),
  },
}));

import { registerChatHandlers } from '../../../electron/ipc/chatHandlers.js';
import { IPC_CHANNELS } from '../../../electron/ipc/channels.js';
import type { IpcContext } from '../../../electron/ipc/types.js';

// ─── 测试辅助 ─────────────────────────────────────────────

function createFullWindow() {
  return {
    isDestroyed: () => false,
    isVisible: () => true,
    webContents: { send: vi.fn() },
  };
}

function createMockCtx(options: { agent: unknown; iterated: { value: boolean } }): IpcContext {
  const fullWindow = createFullWindow();
  return {
    getAgent: () => options.agent as IpcContext['getAgent'] extends () => infer T ? T : never,
    getSprite: () => ({ activePersona: 'mock-persona' }) as never,
    getSessionStore: () => null,
    windowManager: {
      getFullWindow: () => fullWindow as never,
      getFloatWindow: () => null,
    } as never,
    trayManager: { setState: vi.fn() } as never,
    getAbortController: () => null,
    setAbortController: vi.fn(),
    isAgentReady: () => true,
    getUnreadCount: () => 0,
    incrementUnreadCount: vi.fn(),
    resetUnreadCount: vi.fn(),
  };
}

function createMockAgent(processEventImpl: (event: unknown) => AsyncGenerator<never | { type: string; content?: string }>) {
  return {
    processEvent: vi.fn(processEventImpl),
    on: vi.fn(),
    getCheckpoint: () => null,
    getMetrics: () => ({ context: { truncationCount: 0 } }),
    canContinueWithoutInput: () => false,
    markPlanGenerated: vi.fn(),
    acceptPlanGenerated: vi.fn(),
    injectSystemMessage: vi.fn(),
    archiveSessionContent: vi.fn(async () => ({ memories: [] })),
    forceReleaseChatLock: vi.fn(),
    agentHistory: { currentDateValue: '2026-08-09', currentSessionValue: 'test' },
  };
}

// ─── 测试用例 ─────────────────────────────────────────────

describe('SESSION_CLARIFY_ANSWER（T1 澄清回答链路）', () => {
  beforeEach(() => {
    handleCallbacks.clear();
    vi.clearAllMocks();
  });

  it('澄清回答必须驱动 processEvent 生成器被完整迭代（函数体执行），而非 void 丢弃', async () => {
    // 核心判别状态：async generator 函数体是否执行（旧代码 void 丢弃 → 不执行 → 红）
    const iterated = { value: false };
    let receivedEvent: unknown = null;

    const fakeProcessEvent = async function* (event: unknown) {
      iterated.value = true;
      receivedEvent = event;
      yield { type: 'done' };
    };

    const agent = createMockAgent(fakeProcessEvent);
    const ctx = createMockCtx({ agent, iterated });
    registerChatHandlers(ctx);

    const handler = handleCallbacks.get(IPC_CHANNELS.SESSION_CLARIFY_ANSWER);
    expect(handler).toBeDefined();

    const answers = [{ slot: 'task', answer: '继续推进' }];
    const result = await handler!(undefined, answers);

    // 修复前（void）：函数体不执行 → iterated.value 为 false → 断言红
    expect(iterated.value).toBe(true);
    expect(agent.processEvent).toHaveBeenCalledTimes(1);
    expect(receivedEvent).toMatchObject({ type: 'clarify' });
    expect(JSON.parse((receivedEvent as { content: string }).content)).toEqual(answers);
    expect(result).toEqual({ success: true });
    // 并发闸门必须释放（AbortController 清空），否则下一条消息被误拒
    expect(ctx.setAbortController).toHaveBeenLastCalledWith(null);
  });

  it('澄清回答事件内容序列化为 slot/answer 数组', async () => {
    const agent = createMockAgent(async function* (_event: unknown) {
      yield { type: 'text', content: '已应用澄清回答' };
      yield { type: 'done' };
    });
    const ctx = createMockCtx({ agent, iterated: { value: true } });
    registerChatHandlers(ctx);

    const handler = handleCallbacks.get(IPC_CHANNELS.SESSION_CLARIFY_ANSWER)!;
    const answers = [
      { slot: 'role', answer: '专家模式' },
      { slot: 'task', answer: '完成报告' },
    ];
    await handler(undefined, answers);

    const eventArg = agent.processEvent.mock.calls[0]![0] as { type: string; content: string };
    expect(eventArg.type).toBe('clarify');
    expect(JSON.parse(eventArg.content)).toEqual(answers);
  });
});
