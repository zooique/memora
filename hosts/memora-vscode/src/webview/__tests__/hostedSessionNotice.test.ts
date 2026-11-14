/**
 * 托管子会话中断通知器单测（第三切片）
 *
 * 钉五件事：用户停 → 原因归用户且只通知创建者；异常终止 → 原因归异常；
 * 用户自己的会话被停 → 不产生通知；同一会话同一轮停两次只写一条；
 * 取不到原因时如实标「不可知」，不伪造「用户停」。
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
  metas: Map<string, SessionMeta>;
  managed: Set<string>;
  driven: Set<string>;
  rounds: Map<string, Round>;
} {
  const creatorQueue = vi.fn();
  const childQueue = vi.fn();
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
  });
  return { notifier, creatorQueue, childQueue, metas, managed, driven, rounds };
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

  it('异常终止 → 原因归异常，并带回原始错误文本', () => {
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
    expect(text).toContain('异常终止：模型返回 500');
  });

  it('用户自己的会话被停 → 不产生通知（来源不是 hosted）', () => {
    const h = harness();
    h.metas.set(CHILD, meta(CHILD, 'user', '我自己的会话'));
    h.rounds.set(
      'r3',
      round('r3', 'interrupted', [
        { type: 'aborted', seq: 1, ts: TS, payload: { reason: 'cancelled', stopReason: 'user' } },
      ]),
    );
    // 即使有人误登记了创建者，出生来源判据也必须拦住
    h.notifier.remember(CHILD, CREATOR);

    expect(h.notifier.noteSettledFlow(CHILD, 'r3', false, true)).toBe(false);
    expect(h.creatorQueue).not.toHaveBeenCalled();
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

  it('暂停不是终态 / 成功收场 / 创建者已非托管 → 都不通知', () => {
    const h = harness();
    h.metas.set(CHILD, meta(CHILD, 'hosted', '抓取任务'));
    h.rounds.set('r7', round('r7', 'interrupted', []));
    h.rounds.set('r8', round('r8', 'complete', []));
    h.notifier.remember(CHILD, CREATOR);

    // 暂停可续跑
    expect(h.notifier.noteSettledFlow(CHILD, 'r7', true, false)).toBe(false);
    // 成功收场
    expect(h.notifier.noteSettledFlow(CHILD, 'r8', false, false)).toBe(false);
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
});
