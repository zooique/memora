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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Agent, ProcessEvent } from '@zooique/memora';
import {
  createChatRunControlOps,
  type ChatRunControlOpsDeps,
} from '../panels/chatRunControlOps.js';
import { INTERNAL_SEED_SENDER } from '../../shared/constants.js';

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
    // 后台会话没有视图在画它 → 不发轮级收场（切过去时由重放正确渲染中断轮），
    // 也就不会把 A 的骨架收掉（与上面的按会话投递同一纪律）
    expect(calls.post).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'interrupted' }),
      expect.anything(),
    );
  });

  it('当前显示会话暂停：界面副作用照旧发生（状态 / 队列 / 丢弃信号）', async () => {
    const { ops, calls } = makeOps({
      askFor: () => ({ pendingQuestions: () => [], abandonOnStop: async () => true }),
      getAgent: () => fakeAgent('paused', 'round-2', ['排队的话']),
    });
    const stopped = await ops.handleStop();
    expect(stopped).toBe(true);
    expect(calls.post).toHaveBeenCalledWith({ type: 'status', state: 'done' }, CURRENT);
    // 轮级收场必发（2026-11-22 真机 bug1）：paused 态没有活跃流，runFlow 收尾不会发
    // interrupted——缺了它，ask 挂起前建的续接骨架永不收场，留下带角色名头的「等待输入」空壳。
    // 顺序与 thinking 态同构：先轮级收场（带被停的轮 id），再切骨架显隐。
    const postedTypes = calls.post.mock.calls.map(([msg]) => (msg as { type: string }).type);
    expect(postedTypes.slice(0, 2)).toEqual(['interrupted', 'status']);
    expect(calls.post).toHaveBeenCalledWith({ type: 'interrupted', roundId: 'round-2' }, CURRENT);
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

describe('托管事实主动浮现 — isSessionIdle / wakeNoticeTurn', () => {
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

    expect(ops.wakeNoticeTurn(CREATOR, 'settlement')).toBe(true);
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
    // 订正锚（HOSTED-INTERNAL-SEED-1 · 2026-11-18）：原断言 { origin: 'hosted' } 保持——
    // 来源戳语义不变；真机发现种子以 user 轮落盘、重启重放伪装成用户输入后，新增
    // senderName 标记让内核 appendUser 落 RoundMessage.name，重放据此跳过 user 气泡。
    expect(chat.mock.calls[0]?.[3]).toEqual({
      origin: 'hosted',
      senderName: INTERNAL_SEED_SENDER,
    });
    // 两个写端同值：seed（实时投影）与 chat opts（内核落盘）任一缺一即回归
    expect(seed.userMessage).toMatchObject({ name: INTERNAL_SEED_SENDER });
  });

  it('不空闲 / 实例不在 → 不起轮，如实返回 false', () => {
    const { ops: busy, calls: busyCalls } = makeOps({
      runtimeFor: () => ({ streaming: true }),
      getAgent: () => fakeWakeAgent('thinking').agent,
    });
    expect(busy.wakeNoticeTurn(CREATOR, 'settlement')).toBe(false);
    expect(busyCalls.runFlow).not.toHaveBeenCalled();

    const { ops: gone } = makeOps({ getAgent: () => undefined });
    expect(gone.wakeNoticeTurn(CREATOR, 'settlement')).toBe(false);
  });

  it('内核当前会话错位 → 先切回创建者再起轮（不把汇报写进别的会话）', async () => {
    const { agent, switchToSession } = fakeWakeAgent('thinking', false);
    const { ops, calls } = makeOps({ getAgent: () => agent });

    expect(ops.wakeNoticeTurn(CREATOR, 'settlement')).toBe(true);
    // 错位时不同步直接开跑：先等切换完成，再走 runFlow
    expect(switchToSession).toHaveBeenCalledWith(CREATOR);
    expect(calls.runFlow).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(calls.runFlow).toHaveBeenCalledTimes(1));
  });

  /**
   * 起一轮并取回种子（每档一个独立替身：runFlow 调用记录不互相污染）
   *
   * @param kind 唤醒档位
   * @returns 种子正文与 seedId
   */
  function seedOf(kind: 'settlement' | 'needs-answer' | 'handback' | 'pending'): {
    content: string;
    id: string;
  } {
    const { agent } = fakeWakeAgent('thinking');
    const { ops, calls } = makeOps({ getAgent: () => agent });
    expect(ops.wakeNoticeTurn(CREATOR, kind)).toBe(true);
    const seed = calls.runFlow.mock.calls[0]?.[2] as {
      userMessage?: { id?: string; content?: string };
    };
    return { content: seed.userMessage?.content ?? '', id: seed.userMessage?.id ?? '' };
  }

  it('种子按档位分家：待拍板档必须否掉「已落定」，交回档不是交付汇报', () => {
    const settlement = seedOf('settlement');
    const needsAnswer = seedOf('needs-answer');
    const handback = seedOf('handback');
    const pending = seedOf('pending');

    // 落定档：首句就是「已落定」
    expect(settlement.content).toContain('has just settled');
    // 待拍板档：必须**明确否掉**已落定——共用首句正是真机误判的根因
    expect(needsAnswer.content).toContain('NOT settled');
    expect(needsAnswer.content).not.toContain('has just settled');
    expect(needsAnswer.content).toContain('waiting for your decision');
    // 交回档：三选一裁决，不是交付汇报
    expect(handback.content).toContain('handed the work back');
    expect(handback.content).not.toContain('has just settled');
    // 合并浮现档：据实说「压着若干条 + 可能已被取代」，并给排序指令
    expect(pending.content).toContain('queued while you were busy');
    expect(pending.content).toContain('superseded');
    // 四档两两不同（防退化成共用一句）
    const unique = new Set([
      settlement.content,
      needsAnswer.content,
      handback.content,
      pending.content,
    ]);
    expect(unique.size).toBe(4);
    // seedId 带档位：重放 / 排查时一眼看出这一轮被哪一档唤醒
    expect(needsAnswer.id).toContain('live-notice-needs-answer-');
    expect(pending.id).toContain('live-notice-pending-');
  });
});

describe('完成门补派 — wakeDispatchRepair', () => {
  /** 与 fakeWakeAgent 的当前会话对齐口径一致（date-session） */
  const REPAIR_SID = '2026-11-14-creator';

  it('托管 + 空闲 ⇒ 起一轮内部种子，种子点名源轮', () => {
    const { agent, chat } = fakeWakeAgent('thinking');
    const { ops, calls } = makeOps({ getAgent: () => agent });

    expect(ops.wakeDispatchRepair(REPAIR_SID, 'r-source')).toBe(true);
    expect(calls.runFlow).toHaveBeenCalledTimes(1);
    const [factory, sessionId, seed] = calls.runFlow.mock.calls[0] as [
      (signal: AbortSignal) => AsyncGenerator<unknown, void, unknown>,
      string,
      { origin?: string; userMessage?: { content: string; name?: string } },
    ];
    // 归到源会话、带 hosted 来源戳、点名源轮（模型据此回看自己的承诺）
    expect(sessionId).toBe(REPAIR_SID);
    expect(seed.origin).toBe('hosted');
    expect(seed.userMessage?.content).toContain('r-source');
    expect(seed.userMessage).toMatchObject({ name: INTERNAL_SEED_SENDER });
    // 种子只负责起一轮：调用即进既有 chat 通道（不新造流）
    void factory(new AbortController().signal).next();
    expect(chat).toHaveBeenCalledTimes(1);
    // 两个写端同值：检查不得在重放时伪装成用户输入
    expect(chat.mock.calls[0]?.[3]).toEqual({
      origin: 'hosted',
      senderName: INTERNAL_SEED_SENDER,
    });
  });

  it('非托管 ⇒ 不起轮（用户自建会话不打扰）', () => {
    const { agent } = fakeWakeAgent('thinking');
    const { ops, calls } = makeOps({ isManaged: () => false, getAgent: () => agent });

    expect(ops.wakeDispatchRepair(REPAIR_SID, 'r-source')).toBe(false);
    expect(calls.runFlow).not.toHaveBeenCalled();
  });

  it('不空闲 / 实例不在 ⇒ 不起轮', () => {
    const busy = makeOps({
      runtimeFor: () => ({ streaming: true }),
      getAgent: () => fakeWakeAgent('thinking').agent,
    });
    expect(busy.ops.wakeDispatchRepair(REPAIR_SID, 'r-source')).toBe(false);
    expect(busy.calls.runFlow).not.toHaveBeenCalled();

    const gone = makeOps({ getAgent: () => undefined });
    expect(gone.ops.wakeDispatchRepair(REPAIR_SID, 'r-source')).toBe(false);
  });

  it('种子工具名走真源：源码守卫禁止再写死字面量（DISPATCH-REPAIR-1）', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/webview/panels/chatRunControlOps.ts'),
      'utf8',
    );
    // 种子文案必须插值真源常量，工具名变更须随常量全仓同批改动
    expect(src).toContain(
      'actually call ${SEND_TO_SESSION_TOOL_NAME} (or ${CREATE_SESSION_TOOL_NAME})',
    );
    expect(src).not.toContain('actually call send_to_session (or create_session)');
    // 种子只陈述系统见证的事实，不复述模型上轮的话术（防「我说过」记忆锚）
    expect(src).toContain('ended without an accepted session-dispatch receipt');
    expect(src).not.toContain('telling me the work had been dispatched');
  });
});

/**
 * 完成门入口的判据输入合并（DISPATCH-REPAIR-1）
 *
 * 判据吃的是「盘面快照 ∪ 本轮内存事件」——流尾 checkpoint 前读盘，末段回执可能只在内存；
 * resume 续跑流内存段又只含续跑部分。单取任一方都会漏判回执 → 误起补派轮。
 * 这里用 fake timers 控制延后一拍，钉住「任一方有回执都不误触发」。
 */
describe('完成门入口 — maybeWakeDispatchRepair 判据输入合并', () => {
  const SID = '2026-11-14-creator';
  const CLAIM = { content: '已派给小说会话。' };

  /** 一次真实形状的 send_to_session 成功回执（业务 ok=true 在摘要首键） */
  const receipt: ProcessEvent[] = [
    {
      type: 'tool_start',
      seq: 1,
      ts: '2026-11-21T06:00:01.000Z',
      payload: {
        toolCallId: 'send-ok',
        name: 'send_to_session',
        args: JSON.stringify({ sid: '2026-11-14-target', text: '继续写' }),
      },
    },
    {
      type: 'tool_result',
      seq: 2,
      ts: '2026-11-21T06:00:01.500Z',
      payload: {
        toolCallId: 'send-ok',
        name: 'send_to_session',
        ok: true,
        summary: JSON.stringify({ ok: true, accepted: true }),
      },
    },
  ] as ProcessEvent[];

  /** 基础源轮：完成 + 声称已派 + 非种子 + 盘面无事件 */
  const round = {
    status: 'complete',
    assistantMessage: CLAIM,
    userMessage: { name: 'memora宝' },
    processEvents: [] as ProcessEvent[],
  };

  function run(
    diskEvents: ProcessEvent[],
    buffered: ProcessEvent[] | undefined,
  ): ReturnType<typeof makeOps> {
    vi.useFakeTimers();
    try {
      const built = makeOps({
        getAgent: () => fakeWakeAgent('thinking').agent,
      });
      built.ops.maybeWakeDispatchRepair(SID, { ...round, processEvents: diskEvents }, 'r-source', {
        processEvents: buffered,
      });
      vi.advanceTimersByTime(0);
      return built;
    } finally {
      vi.useRealTimers();
    }
  }

  it('回执只在内存（盘面空）⇒ 不误起补派轮', () => {
    const { calls } = run([], receipt);
    expect(calls.runFlow).not.toHaveBeenCalled();
  });

  it('回执只在盘面（内存空）⇒ 不误起补派轮', () => {
    const { calls } = run(receipt, []);
    expect(calls.runFlow).not.toHaveBeenCalled();
  });

  it('两边都无回执 ⇒ 起一轮补派检查', () => {
    const { calls } = run([], []);
    expect(calls.runFlow).toHaveBeenCalledTimes(1);
  });
});
