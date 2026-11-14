/**
 * 运行控制域单测：`handleStop` 从「只停当前显示会话」扩成「可停指定会话」
 *
 * 主控 `stop_work_session` 与用户点停止必须走同一条实现（本文件被测对象），
 * 所以要钉住两件事：
 *   ① 后台会话也能停（按会话取运行态 / ask 协调器 / 实例）；
 *   ② 后台停止不产生界面副作用（状态 / 提示 / 队列重投影只属于当前显示会话），
 *      否则会把 A 的停止画到 B 的界面上；
 *   ③ 创建者通知读的是**被停的会话 id**，不是当前显示会话。
 */
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { Agent } from '@zooique/memora';
import {
  createChatRunControlOps,
  type ChatRunControlOpsDeps,
} from '../panels/chatRunControlOps.js';

vi.mock('vscode', () => ({ l10n: { t: (message: string) => message } }));

/** 当前显示会话 id（用例固定值） */
const CURRENT = '2026-11-14-session-current';
/** 后台会话 id（= 主控要停的子会话） */
const BACKGROUND = '2026-11-14-session-child';

/**
 * 造一个可被停止的 Agent 替身
 *
 * @param status 会话状态机当前状态（paused 才会走 abandon 分支）
 * @param roundId 当前轮 id（停止前实时读）
 * @param pending 排队插话（用于断言丢弃信号）
 * @returns Agent 替身
 */
function fakeAgent(
  status: 'thinking' | 'paused' | 'done',
  roundId = 'round-1',
  pending: string[] = [],
): Agent {
  return {
    sessionManager: { status },
    currentRoundId: () => roundId,
    getPendingInterjections: () => pending,
  } as unknown as Agent;
}

/**
 * 构造 ops 依赖
 *
 * @param overrides 覆盖项
 * @returns 依赖与调用记录
 */
function makeOps(overrides: Partial<ChatRunControlOpsDeps> = {}): {
  ops: ReturnType<typeof createChatRunControlOps>;
  calls: {
    post: ReturnType<typeof vi.fn>;
    sync: ReturnType<typeof vi.fn>;
    stopped: ReturnType<typeof vi.fn>;
    discarded: ReturnType<typeof vi.fn>;
  };
} {
  const calls = {
    post: vi.fn(),
    sync: vi.fn(),
    stopped: vi.fn(),
    discarded: vi.fn(),
  };
  const ops = createChatRunControlOps({
    post: calls.post,
    postTurnUpdate: vi.fn(),
    runtimeFor: () => ({ streaming: false }),
    askFor: () => ({ pendingQuestions: () => [], abandonOnStop: async () => true }),
    getAgent: () => undefined,
    currentSessionId: () => CURRENT,
    // 缺省「调用方是托管会话」：停自己开的活是常态；非托管的拒绝另有用例
    isManaged: () => true,
    runFlow: async () => undefined,
    syncPendingQueue: calls.sync,
    postPendingDiscarded: calls.discarded,
    onUserStopped: calls.stopped,
    ...overrides,
  });
  return { ops, calls };
}

describe('handleStop — 指定会话', () => {
  it('后台会话在跑：abort 它的流，且不投递任何界面消息', async () => {
    const controller = new AbortController();
    const { ops, calls } = makeOps({
      runtimeFor: (sessionId) => ({
        streaming: sessionId === BACKGROUND,
        ...(sessionId === BACKGROUND ? { abortController: controller } : {}),
      }),
    });
    const stopped = await ops.handleStop(BACKGROUND);
    expect(stopped).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    // 后台停止不重绘当前界面
    expect(calls.post).not.toHaveBeenCalled();
    expect(calls.sync).not.toHaveBeenCalled();
    expect(calls.discarded).not.toHaveBeenCalled();
  });

  it('后台会话已暂停：走 abandon 收场，并通知**被停的**会话创建者', async () => {
    const abandon = vi.fn(async () => true);
    const { ops, calls } = makeOps({
      askFor: () => ({ pendingQuestions: () => [{ id: 'q1' }], abandonOnStop: abandon }),
      getAgent: (sessionId) =>
        sessionId === BACKGROUND ? fakeAgent('paused', 'round-9', ['排队的话']) : undefined,
    });
    const stopped = await ops.handleStop(BACKGROUND);
    expect(stopped).toBe(true);
    expect(abandon).toHaveBeenCalledTimes(1);
    // 通知必须带后台会话 id（不是 CURRENT）
    expect(calls.stopped).toHaveBeenCalledWith(expect.anything(), 'round-9', BACKGROUND);
    // 后台停止仍不产生界面副作用
    expect(calls.post).not.toHaveBeenCalled();
    expect(calls.sync).not.toHaveBeenCalled();
    expect(calls.discarded).not.toHaveBeenCalled();
  });

  it('当前显示会话暂停：界面副作用照旧发生（状态 / 队列 / 丢弃信号）', async () => {
    const { ops, calls } = makeOps({
      askFor: () => ({ pendingQuestions: () => [], abandonOnStop: async () => true }),
      getAgent: () => fakeAgent('paused', 'round-2', ['排队的话']),
    });
    const stopped = await ops.handleStop();
    expect(stopped).toBe(true);
    expect(calls.post).toHaveBeenCalledWith({ type: 'status', state: 'done' });
    expect(calls.sync).toHaveBeenCalledWith(true);
    expect(calls.discarded).toHaveBeenCalledWith(['排队的话']);
    expect(calls.stopped).toHaveBeenCalledWith(expect.anything(), 'round-2', CURRENT);
  });

  it('没有流、也不是暂停 → stopped=false（不谎报停到了活）', async () => {
    const { ops } = makeOps({ getAgent: () => fakeAgent('done') });
    await expect(ops.handleStop(BACKGROUND)).resolves.toBe(false);
  });
});

describe('stopHostedSession — 主控停止入口', () => {
  it('托管调用方：复用 handleStop 停目标会话，返回停到的结果', async () => {
    const controller = new AbortController();
    const { ops, calls } = makeOps({
      runtimeFor: (sessionId) => ({
        streaming: sessionId === BACKGROUND,
        ...(sessionId === BACKGROUND ? { abortController: controller } : {}),
      }),
    });
    await expect(ops.stopHostedSession(CURRENT, BACKGROUND)).resolves.toEqual({
      ok: true,
      stopped: true,
    });
    expect(controller.signal.aborted).toBe(true);
    // 走的仍是同一条停止路径：后台停止不投界面消息
    expect(calls.post).not.toHaveBeenCalled();
  });

  it('非托管调用方：E_DENIED，且一次停止动作都不发生', async () => {
    const controller = new AbortController();
    const { ops } = makeOps({
      isManaged: () => false,
      runtimeFor: () => ({ streaming: true, abortController: controller }),
    });
    await expect(ops.stopHostedSession(CURRENT, BACKGROUND)).resolves.toMatchObject({
      ok: false,
      code: 'E_DENIED',
    });
    expect(controller.signal.aborted).toBe(false);
  });
});
