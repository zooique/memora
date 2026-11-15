/**
 * 托管子会话落定通知器单测（第三 / 第四 / 第五切片）
 *
 * 钉九件事：用户停 → 结论归中断且只通知创建者；异常终止 → 结论归失败并带回原文；
 * 成功收场 → 结论归成功；用户自己的会话当前不归代理 → 不产生通知；
 * 代理派发接管的用户会话 → 照常通知；同一会话同一轮重复信号只写一条；
 * 取不到原因时如实标「不可知」，不伪造「用户停」；
 * 创建者忙 / 用户正在输入时不抢（进待办，收场后合并成一轮浮现）；
 * 待办多条只唤醒一轮，且同一轮重复信号不会重复排队。
 */
import { describe, expect, it, vi } from 'vitest';
import type { Agent, ProcessEvent, Round, RoundStatus, SessionMeta } from '@zooique/memora';
import { HostedSessionNotifier } from '../helpers/hostedSessionNotice.js';

const TS = '2026-11-14T10:00:00.000Z';
/** 创建者会话 id */
const CREATOR = '2026-11-14-creator';
/** 代理创建的子会话 id */
const CHILD = '2026-11-14-child';

/**
 * 造会话元数据
 *
 * @param sessionId 会话 id
 * @param origin 出生来源
 * @param displayName 显示标题（缺省 = 只靠 id 兜底）
 */
function meta(sessionId: string, origin: SessionMeta['origin'], displayName?: string): SessionMeta {
  return {
    sessionId,
    ...(displayName ? { displayName } : {}),
    ...(origin ? { origin } : {}),
    updatedAt: TS,
    messageCount: 0,
  };
}

/**
 * 造一轮（只补本用例消费的字段）
 *
 * @param id 轮 id
 * @param status 轮状态
 * @param events 过程事件（原因真源）
 */
function round(id: string, status: RoundStatus, events: ProcessEvent[] = []): Round {
  return {
    id,
    userMessage: { id: `${id}-u`, role: 'user', content: '派发内容', timestamp: TS },
    status,
    createdAt: TS,
    completedAt: TS,
    processEvents: events,
  };
}

/**
 * 测试台：真实的通知器 + 可观测的队列 / 元数据 / 托管集合
 *
 * 两个 Agent 各自一条队列：只有创建者的队列该响，子会话自己的队列必须静默。
 */
function harness(): {
  notifier: HostedSessionNotifier;
  creatorQueue: ReturnType<typeof vi.fn>;
  childQueue: ReturnType<typeof vi.fn>;
  wakeCreator: ReturnType<typeof vi.fn>;
  /** 模拟「创建者忙 / 用户正在输入」：false = 此刻不能唤醒 */
  setCanWake: (can: boolean) => void;
  metas: Map<string, SessionMeta>;
  managed: Set<string>;
  driven: Set<string>;
  rounds: Map<string, Round>;
} {
  const creatorQueue = vi.fn();
  const childQueue = vi.fn();
  // 「能否唤醒」由面板判据给出（空闲 + 用户没在打字）；此处用可变开关模拟两种不抢场景
  let canWake = true;
  const wakeCreator = vi.fn(() => true);
  const metas = new Map<string, SessionMeta>();
  const managed = new Set<string>([CREATOR]);
  // 当前由代理驱动的会话（生产 = SessionModeStore.agentDriven；子会话出生后默认在内）
  const driven = new Set<string>([CHILD]);
  const rounds = new Map<string, Round>();
  const agents = new Map<string, Agent>([
    [CREATOR, { agentLoop: { enqueueCommandResult: creatorQueue } } as unknown as Agent],
    [CHILD, { agentLoop: { enqueueCommandResult: childQueue } } as unknown as Agent],
  ]);
  const notifier = new HostedSessionNotifier({
    readSessionMeta: (sid) => metas.get(sid),
    isManaged: (sid) => managed.has(sid),
    isAgentDriven: (sid) => driven.has(sid),
    getAgent: (sid) => agents.get(sid),
    readRound: (roundId) => rounds.get(roundId),
    canWakeCreator: () => canWake,
    wakeCreator,
  });
  return {
    notifier,
    creatorQueue,
    childQueue,
    wakeCreator,
    setCanWake: (can) => {
      canWake = can;
    },
    metas,
    managed,
    driven,
    rounds,
  };
}

describe('HostedSessionNotifier', () => {
  it('用户主动停 → 原因归用户，且只通知创建者（带会话标题）', () => {
    const h = harness();
    h.metas.set(CHILD, meta(CHILD, 'hosted', '抓取任务'));
    h.rounds.set(
      'r1',
      round('r1', 'interrupted', [
        { type: 'aborted', seq: 1, ts: TS, payload: { reason: 'cancelled', stopReason: 'user' } },
      ]),
    );
    h.notifier.remember(CHILD, CREATOR);

    expect(h.notifier.noteSettledFlow(CHILD, 'r1', false, true)).toBe(true);
    expect(h.creatorQueue).toHaveBeenCalledTimes(1);
    // 通知对象正确：子会话自己的队列一条不响
    expect(h.childQueue).not.toHaveBeenCalled();
    const text = h.creatorQueue.mock.calls[0][0] as string;
    expect(text).toContain('抓取任务');
    expect(text).toContain('用户主动停止');
    expect(text).toContain(CHILD);
    expect(text).toContain('r1');
  });

  it('异常终止 → 结论归失败，并带回原始错误文本', () => {
    const h = harness();
    h.metas.set(CHILD, meta(CHILD, 'hosted', '抓取任务'));
    h.rounds.set(
      'r2',
      round('r2', 'interrupted', [
        { type: 'error', seq: 1, ts: TS, payload: { message: '模型返回 500' } },
      ]),
    );
    h.notifier.remember(CHILD, CREATOR);

    h.notifier.noteSettledFlow(CHILD, 'r2', false, false);
    const text = h.creatorQueue.mock.calls[0][0] as string;
    expect(text).toContain('失败');
    expect(text).toContain('异常终止：模型返回 500');
  });

  it('成功收场 → 结论归成功（主控能收到「这条活干完了」）', () => {
    const h = harness();
    h.metas.set(CHILD, meta(CHILD, 'hosted', '抓取任务'));
    h.rounds.set('r-success', round('r-success', 'complete', []));
    h.notifier.remember(CHILD, CREATOR);

    expect(h.notifier.noteSettledFlow(CHILD, 'r-success', false, false)).toBe(true);
    expect(h.creatorQueue).toHaveBeenCalledTimes(1);
    const text = h.creatorQueue.mock.calls[0][0] as string;
    expect(text).toContain('抓取任务');
    expect(text).toContain(CHILD);
    expect(text).toContain('r-success');
    expect(text).toContain('成功');
    // 成功不是「中断」，不能把结论写成失败 / 中断
    expect(text).not.toContain('失败');
    expect(text).not.toContain('中断');
  });

  it('用户自己的会话当前不归代理 → 不产生通知（判据是驱动权，不看出生来源）', () => {
    const h = harness();
    h.metas.set(CHILD, meta(CHILD, 'user', '我自己的会话'));
    h.rounds.set(
      'r3',
      round('r3', 'interrupted', [
        { type: 'aborted', seq: 1, ts: TS, payload: { reason: 'cancelled', stopReason: 'user' } },
      ]),
    );
    // 即使有人误登记了创建者，驱动权判据也必须拦住（当前归用户）
    h.notifier.remember(CHILD, CREATOR);
    h.driven.delete(CHILD);

    expect(h.notifier.noteSettledFlow(CHILD, 'r3', false, true)).toBe(false);
    expect(h.creatorQueue).not.toHaveBeenCalled();
  });

  it('代理派发接管的用户自建会话（origin=user）→ 中断照常通知创建者', () => {
    const h = harness();
    // 出生来源仍是用户建（持久事实），但 send_to_session 受理后当前归代理驱动
    h.metas.set(CHILD, meta(CHILD, 'user', '我自己的会话'));
    h.rounds.set(
      'r3b',
      round('r3b', 'interrupted', [
        { type: 'aborted', seq: 1, ts: TS, payload: { reason: 'cancelled', stopReason: 'user' } },
      ]),
    );
    h.notifier.remember(CHILD, CREATOR);

    expect(h.notifier.noteSettledFlow(CHILD, 'r3b', false, true)).toBe(true);
    const text = h.creatorQueue.mock.calls[0][0] as string;
    expect(text).toContain('我自己的会话');
    expect(text).toContain('用户主动停止');
  });

  it('hosted 但没有创建者记录 → 不通知（不知道谁是代理，就不乱发）', () => {
    const h = harness();
    h.metas.set(CHILD, meta(CHILD, 'hosted', '抓取任务'));
    h.rounds.set('r4', round('r4', 'interrupted', []));

    expect(h.notifier.noteSettledFlow(CHILD, 'r4', false, true)).toBe(false);
    expect(h.creatorQueue).not.toHaveBeenCalled();
  });

  it('同一会话同一轮停两次 → 只写一条', () => {
    const h = harness();
    h.metas.set(CHILD, meta(CHILD, 'hosted', '抓取任务'));
    h.rounds.set(
      'r5',
      round('r5', 'interrupted', [
        { type: 'aborted', seq: 1, ts: TS, payload: { reason: 'cancelled', stopReason: 'user' } },
      ]),
    );
    h.notifier.remember(CHILD, CREATOR);

    expect(h.notifier.noteSettledFlow(CHILD, 'r5', false, true)).toBe(true);
    expect(h.notifier.noteSettledFlow(CHILD, 'r5', false, true)).toBe(false);
    expect(h.creatorQueue).toHaveBeenCalledTimes(1);
  });

  it('取不到原因 → 如实标「原因不可知」，不伪造用户停', () => {
    const h = harness();
    h.metas.set(CHILD, meta(CHILD, 'hosted', '抓取任务'));
    // interrupted 但没有任何 aborted / error 事件，宿主也没有 abort
    h.rounds.set('r6', round('r6', 'interrupted', []));
    h.notifier.remember(CHILD, CREATOR);

    expect(h.notifier.noteSettledFlow(CHILD, 'r6', false, false)).toBe(true);
    const text = h.creatorQueue.mock.calls[0][0] as string;
    expect(text).toContain('原因不可知');
    expect(text).not.toContain('用户主动停止');
  });

  it('暂停不是终态 / 创建者已非托管 → 都不通知', () => {
    const h = harness();
    h.metas.set(CHILD, meta(CHILD, 'hosted', '抓取任务'));
    h.rounds.set('r7', round('r7', 'interrupted', []));
    h.notifier.remember(CHILD, CREATOR);

    // 暂停可续跑
    expect(h.notifier.noteSettledFlow(CHILD, 'r7', true, false)).toBe(false);
    // 创建者被收回托管（现在是普通会话，不拿代理的事实打扰它）
    h.managed.delete(CREATOR);
    expect(h.notifier.noteSettledFlow(CHILD, 'r7', false, true)).toBe(false);
    expect(h.creatorQueue).not.toHaveBeenCalled();
  });

  it('子会话已被用户收回（当前不由代理驱动）→ 不通知创建者（出生账本不当权限用）', () => {
    const h = harness();
    h.metas.set(CHILD, meta(CHILD, 'hosted', '抓取任务'));
    h.rounds.set('r10', round('r10', 'interrupted', []));
    // 出生记录仍记着创建者，但当前驱动权已归用户
    h.notifier.remember(CHILD, CREATOR);
    h.driven.delete(CHILD);

    expect(h.notifier.noteSettledFlow(CHILD, 'r10', false, true)).toBe(false);
    expect(h.creatorQueue).not.toHaveBeenCalled();
  });

  it('paused 态用户停止 → 回盘上读轮，原因归用户', () => {
    const h = harness();
    h.metas.set(CHILD, meta(CHILD, 'hosted', '抓取任务'));
    // 轮上没有 aborted 事件，但调用方就是用户停止入口 ⇒ hostAborted 是直接证据
    h.rounds.set('r9', round('r9', 'interrupted', []));
    h.notifier.remember(CHILD, CREATOR);

    expect(h.notifier.notePausedStop(CHILD, 'r9')).toBe(true);
    expect(h.creatorQueue.mock.calls[0][0] as string).toContain('用户主动停止');
  });

  it('同步抛错 → 原因归异常（原文），无轮也投递', () => {
    const h = harness();
    h.metas.set(CHILD, meta(CHILD, 'hosted'));
    h.notifier.remember(CHILD, CREATOR);

    expect(h.notifier.noteSyncThrow({ sessionId: CHILD, error: new Error('chat 锁被占用') })).toBe(
      true,
    );
    const text = h.creatorQueue.mock.calls[0][0] as string;
    expect(text).toContain('异常终止：chat 锁被占用');
    // 标题缺失时回退用 id，不能只给一个空标题
    expect(text).toContain(CHILD);
  });

  it('创建者忙 → 不抢：先进待办不写队列，收场后浮现并只唤醒一轮', () => {
    const h = harness();
    h.metas.set(CHILD, meta(CHILD, 'hosted', '抓取任务'));
    h.rounds.set('r11', round('r11', 'complete', []));
    h.notifier.remember(CHILD, CREATOR);
    // 创建者正在跑别的活
    h.setCanWake(false);

    expect(h.notifier.noteSettledFlow(CHILD, 'r11', false, false)).toBe(true);
    // 不打断：此刻既不写创建者队列，也不起轮
    expect(h.creatorQueue).not.toHaveBeenCalled();
    expect(h.wakeCreator).not.toHaveBeenCalled();

    // 本轮收场，创建者恢复空闲 → 补浮现
    h.setCanWake(true);
    h.notifier.flushPending(CREATOR);
    expect(h.creatorQueue).toHaveBeenCalledTimes(1);
    expect(h.wakeCreator).toHaveBeenCalledTimes(1);
    expect(h.creatorQueue.mock.calls[0][0] as string).toContain('抓取任务');
  });

  it('用户正在输入 → 同样压着不抢；等到本轮收场才浮现', () => {
    const h = harness();
    h.metas.set(CHILD, meta(CHILD, 'hosted', '抓取任务'));
    h.rounds.set('r12', round('r12', 'complete', []));
    h.notifier.remember(CHILD, CREATOR);
    // 面板判据把「用户正在打字」折算成不可唤醒
    h.setCanWake(false);

    h.notifier.noteSettledFlow(CHILD, 'r12', false, false);
    expect(h.creatorQueue).not.toHaveBeenCalled();

    // 用户本轮收场且不再打字 → 收场补浮现（宁晚不打断）
    h.setCanWake(true);
    h.notifier.flushPending(CREATOR);
    expect(h.creatorQueue).toHaveBeenCalledTimes(1);
    expect(h.wakeCreator).toHaveBeenCalledTimes(1);
  });

  it('多条落定压在一起 → 收场只唤醒一轮（不逐条刷屏）', () => {
    const h = harness();
    h.metas.set(CHILD, meta(CHILD, 'hosted', '抓取任务'));
    h.rounds.set('r13', round('r13', 'complete', []));
    h.rounds.set('r14', round('r14', 'complete', []));
    h.notifier.remember(CHILD, CREATOR);
    h.setCanWake(false);

    h.notifier.noteSettledFlow(CHILD, 'r13', false, false);
    h.notifier.noteSettledFlow(CHILD, 'r14', false, false);
    expect(h.creatorQueue).not.toHaveBeenCalled();

    h.setCanWake(true);
    h.notifier.flushPending(CREATOR);
    // 两条事实都带进上下文，但只起一轮汇报
    expect(h.creatorQueue).toHaveBeenCalledTimes(2);
    expect(h.wakeCreator).toHaveBeenCalledTimes(1);
  });

  it('待办阶段同一轮重复信号 → 只排一条（不许重复刷屏）', () => {
    const h = harness();
    h.metas.set(CHILD, meta(CHILD, 'hosted', '抓取任务'));
    h.rounds.set('r15', round('r15', 'complete', []));
    h.notifier.remember(CHILD, CREATOR);
    h.setCanWake(false);

    expect(h.notifier.noteSettledFlow(CHILD, 'r15', false, false)).toBe(true);
    // 同一轮的第二 / 第三次信号：去重键已记，不再入待办
    expect(h.notifier.noteSettledFlow(CHILD, 'r15', false, false)).toBe(false);
    expect(h.notifier.noteSettledFlow(CHILD, 'r15', false, false)).toBe(false);

    h.setCanWake(true);
    h.notifier.flushPending(CREATOR);
    expect(h.creatorQueue).toHaveBeenCalledTimes(1);
    expect(h.wakeCreator).toHaveBeenCalledTimes(1);
  });
});
