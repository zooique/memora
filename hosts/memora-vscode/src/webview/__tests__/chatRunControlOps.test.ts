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
    turnUpdate: ReturnType<typeof vi.fn>;
    runFlow: ReturnType<typeof vi.fn>;
  };
} {
  const calls = {
    post: vi.fn(),
    sync: vi.fn(),
    stopped: vi.fn(),
    discarded: vi.fn(),
    turnUpdate: vi.fn(),
    runFlow: vi.fn(async () => undefined),
  };
  const ops = createChatRunControlOps({
    post: calls.post,
    postTurnUpdate: calls.turnUpdate,
    runtimeFor: () => ({ streaming: false }),
    askFor: () => ({ pendingQuestions: () => [], abandonOnStop: async () => true }),
    getAgent: () => undefined,
    currentSessionId: () => CURRENT,
    // 缺省「调用方是托管会话」：停自己开的活是常态；非托管的拒绝另有用例
    isManaged: () => true,
    runFlow: calls.runFlow,
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
      askFor: () => ({ pendingQuestions: () => [], abandonOnStop: abandon }),
      getAgent: (sessionId) =>
        sessionId === BACKGROUND ? fakeAgent('paused', 'round-9', ['排队的话']) : undefined,
    });
    const stopped = await ops.handleStop(BACKGROUND);
    expect(stopped).toBe(true);
    expect(abandon).toHaveBeenCalledTimes(1);
    // 通知必须带后台会话 id（不是 CURRENT）
    expect(calls.stopped).toHaveBeenCalledWith(expect.anything(), 'round-9', BACKGROUND);
    // 后台停止的界面副作用按**目标会话**投递（有视图绑它才到屏；单份长度缓存仍不动）
    expect(calls.post).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'notice' }),
      BACKGROUND,
    );
    expect(calls.sync).not.toHaveBeenCalled();
    expect(calls.discarded).toHaveBeenCalledWith(['排队的话'], BACKGROUND);
    expect(calls.turnUpdate).toHaveBeenCalledWith(BACKGROUND);
  });

  it('当前显示会话暂停：界面副作用照旧发生（状态 / 队列 / 丢弃信号）', async () => {
    const { ops, calls } = makeOps({
      askFor: () => ({ pendingQuestions: () => [], abandonOnStop: async () => true }),
      getAgent: () => fakeAgent('paused', 'round-2', ['排队的话']),
    });
    const stopped = await ops.handleStop();
    expect(stopped).toBe(true);
    expect(calls.post).toHaveBeenCalledWith({ type: 'status', state: 'done' }, CURRENT);
    expect(calls.sync).toHaveBeenCalledWith(true);
    expect(calls.discarded).toHaveBeenCalledWith(['排队的话'], CURRENT);
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

/**
 * 造一个可被暂停 / 恢复的 Agent 替身
 *
 * @param options.status 会话状态机当前状态（paused 才可恢复）
 * @param options.pending 是否已有在途暂停申请
 * @param options.pauseAccepted requestPause 的返回值（false = 空闲守卫作废）
 * @returns Agent 替身与 requestPause 调用记录
 */
function fakeRunControlAgent(options: {
  status: string;
  pending?: boolean;
  pauseAccepted?: boolean;
}): { agent: Agent; requestPause: ReturnType<typeof vi.fn> } {
  const requestPause = vi.fn(() => options.pauseAccepted ?? true);
  return {
    agent: {
      sessionManager: { status: options.status },
      isPausePending: () => options.pending ?? false,
      requestPause,
    } as unknown as Agent,
    requestPause,
  };
}

describe('pauseHostedSession — 主控暂停入口', () => {
  it('后台会话在跑：调目标实例已有的 requestPause，不投界面消息', async () => {
    const { agent, requestPause } = fakeRunControlAgent({ status: 'running' });
    const { ops, calls } = makeOps({ getAgent: (id) => (id === BACKGROUND ? agent : undefined) });
    await expect(ops.pauseHostedSession(CURRENT, BACKGROUND)).resolves.toEqual({
      ok: true,
      paused: true,
      already: false,
    });
    expect(requestPause).toHaveBeenCalledTimes(1);
    // 后台会话不重绘当前界面（与停止同一约束）
    expect(calls.turnUpdate).not.toHaveBeenCalled();
    expect(calls.post).not.toHaveBeenCalled();
  });

  it('已在暂停态 / 申请在途：幂等回 already，不再提交暂停请求', async () => {
    const paused = fakeRunControlAgent({ status: 'paused' });
    const { ops } = makeOps({ getAgent: () => paused.agent });
    await expect(ops.pauseHostedSession(CURRENT, BACKGROUND)).resolves.toEqual({
      ok: true,
      paused: true,
      already: true,
    });
    expect(paused.requestPause).not.toHaveBeenCalled();

    const pending = fakeRunControlAgent({ status: 'running', pending: true });
    const { ops: ops2 } = makeOps({ getAgent: () => pending.agent });
    await expect(ops2.pauseHostedSession(CURRENT, BACKGROUND)).resolves.toEqual({
      ok: true,
      paused: true,
      already: true,
    });
    expect(pending.requestPause).not.toHaveBeenCalled();
  });

  it('目标没有活实例：E_UNREADABLE（读不到状态就不猜着暂停，也不新建实例）', async () => {
    const { ops } = makeOps({ getAgent: () => undefined });
    await expect(ops.pauseHostedSession(CURRENT, BACKGROUND)).resolves.toMatchObject({
      ok: false,
      code: 'E_UNREADABLE',
    });
  });

  it('非托管调用方：E_DENIED，requestPause 一次都不调', async () => {
    const { agent, requestPause } = fakeRunControlAgent({ status: 'running' });
    const { ops } = makeOps({ isManaged: () => false, getAgent: () => agent });
    await expect(ops.pauseHostedSession(CURRENT, BACKGROUND)).resolves.toMatchObject({
      ok: false,
      code: 'E_DENIED',
    });
    expect(requestPause).not.toHaveBeenCalled();
  });
});

describe('resumeHostedSession — 主控恢复入口', () => {
  it('目标在暂停态：走既有续跑通路（显式带目标 sid），不等待流结束', async () => {
    const { agent } = fakeRunControlAgent({ status: 'paused' });
    const { ops, calls } = makeOps({ getAgent: (id) => (id === BACKGROUND ? agent : undefined) });
    await expect(ops.resumeHostedSession(CURRENT, BACKGROUND)).resolves.toEqual({
      ok: true,
      resumed: true,
    });
    // 复用既有 runFlow 通路，且显式带目标 sid（后台会话不得写成当前会话）
    expect(calls.runFlow).toHaveBeenCalledWith(expect.any(Function), BACKGROUND);
    // 后台会话不投界面消息
    expect(calls.turnUpdate).not.toHaveBeenCalled();
  });

  it('等用户回答的暂停：resumed=false，不代答、不启动续跑', async () => {
    const { agent } = fakeRunControlAgent({ status: 'paused' });
    const { ops, calls } = makeOps({
      getAgent: () => agent,
      askFor: () => ({ pendingQuestions: () => [{ id: 'q1' }], abandonOnStop: async () => false }),
    });
    await expect(ops.resumeHostedSession(CURRENT, BACKGROUND)).resolves.toEqual({
      ok: true,
      resumed: false,
    });
    expect(calls.runFlow).not.toHaveBeenCalled();
  });

  it('目标不在暂停态：resumed=false，不猜着恢复', async () => {
    const { agent } = fakeRunControlAgent({ status: 'running' });
    const { ops, calls } = makeOps({ getAgent: () => agent });
    await expect(ops.resumeHostedSession(CURRENT, BACKGROUND)).resolves.toEqual({
      ok: true,
      resumed: false,
    });
    expect(calls.runFlow).not.toHaveBeenCalled();
  });

  it('目标没有活实例 / 非托管：E_UNREADABLE / E_DENIED', async () => {
    const { ops } = makeOps({ getAgent: () => undefined });
    await expect(ops.resumeHostedSession(CURRENT, BACKGROUND)).resolves.toMatchObject({
      ok: false,
      code: 'E_UNREADABLE',
    });
    const { agent } = fakeRunControlAgent({ status: 'paused' });
    const { ops: denied } = makeOps({ isManaged: () => false, getAgent: () => agent });
    await expect(denied.resumeHostedSession(CURRENT, BACKGROUND)).resolves.toMatchObject({
      ok: false,
      code: 'E_DENIED',
    });
  });
});

/**
 * 造一个可用于「主动汇报一轮」的 Agent 替身
 *
 * @param status 会话状态机当前状态
 * @param aligned 内核当前会话是否已对齐创建者（false = 需要先 switchToSession）
 * @returns Agent 替身与两个可观测间谍
 */
function fakeWakeAgent(
  status: 'thinking' | 'paused' | 'done',
  aligned = true,
): {
  agent: Agent;
  chat: ReturnType<typeof vi.fn>;
  switchToSession: ReturnType<typeof vi.fn>;
} {
  const chat = vi.fn(async function* () {
    // 空流：本用例只关心「有没有起一轮、种子对不对」，不关心 chunk
  });
  const switchToSession = vi.fn(async () => undefined);
  const agent = {
    sessionManager: {
      status,
      getCurrentSessionInfo: () => ({ date: '2026-11-14', session: aligned ? 'creator' : 'other' }),
      switchToSession,
    },
    isPausePending: () => false,
    chat,
  } as unknown as Agent;
  return { agent, chat, switchToSession };
}

describe('落定主动浮现 — isSessionIdle / wakeSettlementReport', () => {
  /** 创建者会话 id（与 fakeWakeAgent 的对齐口径一致） */
  const CREATOR = '2026-11-14-creator';

  it('三种「不空」都不算空闲：在跑 / 待答 / 暂停可续跑', () => {
    const streaming = makeOps({
      runtimeFor: () => ({ streaming: true }),
      getAgent: () => fakeWakeAgent('thinking').agent,
    });
    expect(streaming.ops.isSessionIdle(CREATOR)).toBe(false);

    const asking = makeOps({
      askFor: () => ({
        pendingQuestions: () => [{ id: 'q1' }],
        abandonOnStop: async () => true,
      }),
      getAgent: () => fakeWakeAgent('thinking').agent,
    });
    expect(asking.ops.isSessionIdle(CREATOR)).toBe(false);

    const paused = makeOps({ getAgent: () => fakeWakeAgent('paused').agent });
    expect(paused.ops.isSessionIdle(CREATOR)).toBe(false);

    const idle = makeOps({ getAgent: () => fakeWakeAgent('thinking').agent });
    expect(idle.ops.isSessionIdle(CREATOR)).toBe(true);
  });

  it('空闲 → 走既有托管通道起一轮：种子标 hosted，事实留在系统事件队列', () => {
    const { agent, chat } = fakeWakeAgent('thinking');
    const { ops, calls } = makeOps({ getAgent: () => agent });

    expect(ops.wakeSettlementReport(CREATOR)).toBe(true);
    expect(calls.runFlow).toHaveBeenCalledTimes(1);
    const [factory, sessionId, seed] = calls.runFlow.mock.calls[0] as [
      (signal: AbortSignal) => AsyncGenerator<unknown, void, unknown>,
      string,
      { origin?: string; userMessage?: { content: string } },
    ];
    // 必须归到创建者会话、且带来源戳 hosted（角色仍是 user，靠 origin 区分来源）
    expect(sessionId).toBe(CREATOR);
    expect(seed.origin).toBe('hosted');
    expect(seed.userMessage?.content).toContain('settled');
    // 种子只负责「起一轮」：调用即进既有 chat 通道（不新造流）
    void factory(new AbortController().signal).next();
    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat.mock.calls[0]?.[0]).toBe(seed.userMessage?.content);
    expect(chat.mock.calls[0]?.[3]).toEqual({ origin: 'hosted' });
  });

  it('不空闲 / 实例不在 → 不起轮，如实返回 false', () => {
    const { ops: busy, calls: busyCalls } = makeOps({
      runtimeFor: () => ({ streaming: true }),
      getAgent: () => fakeWakeAgent('thinking').agent,
    });
    expect(busy.wakeSettlementReport(CREATOR)).toBe(false);
    expect(busyCalls.runFlow).not.toHaveBeenCalled();

    const { ops: gone } = makeOps({ getAgent: () => undefined });
    expect(gone.wakeSettlementReport(CREATOR)).toBe(false);
  });

  it('内核当前会话错位 → 先切回创建者再起轮（不把汇报写进别的会话）', async () => {
    const { agent, switchToSession } = fakeWakeAgent('thinking', false);
    const { ops, calls } = makeOps({ getAgent: () => agent });

    expect(ops.wakeSettlementReport(CREATOR)).toBe(true);
    // 错位时不同步直接开跑：先等切换完成，再走 runFlow
    expect(switchToSession).toHaveBeenCalledWith(CREATOR);
    expect(calls.runFlow).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(calls.runFlow).toHaveBeenCalledTimes(1));
  });
});
