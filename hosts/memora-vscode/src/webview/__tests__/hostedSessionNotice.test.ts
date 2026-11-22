/**
 * 托管子会话落定通知器单测（第三 / 第四 / 第五切片）
 *
 * 钉这些事：用户停 → 结论归中断且只通知创建者；异常终止 → 结论归失败并带回原文；
 * 成功收场 → 结论归成功；用户自己的会话当前不归代理 → 不产生通知；
 * 代理派发接管的用户会话 → 照常通知；同一会话同一轮重复信号只写一条；
 * 取不到原因时如实标「不可知」，不伪造「用户停」；
 * 创建者忙 / 用户正在输入时不抢（进待办，收场后合并成一轮浮现）；
 * 创建者实例还没装配时同样压待办、不丢，装配后放出；
 * 待办多条只唤醒一轮，且同一轮重复信号不会重复排队。
 *
 * 第六切片（HOSTED-ASK-ROUTE-1 · 等你拍板）：带戳的工作会话挂起提问 → 秒级叫醒创建者，
 * 题面 + 选项随 system 事实带出；正文按 2026-11-18 拍板为「按判断拍板继续、不阻塞」，
 * 并按 2026-11-21 订正为「有选项优先代选」（ASK-PROXY-PREFER-1）；
 * 忙 / 未装配压待办不丢；无戳轮不叫代理；同批去重；
 * needs-answer 键与落定键隔离（同轮先提问后落定，两条都能投递，落定不被吞）。
 *
 * 第八切片（HOSTED-NOTICE-KIND-1 · 唤醒档位与待办时效）：三档事实各自声明档位（种子不再共用
 * 一句「已落定」）；待办释放时每条前置「产生于 N 分钟前」且档位归 `pending`——否则多条压队
 * 合并浮现时模型无法排先后，会把几分钟前的旧落定读成「此刻刚被停」。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { Agent, ProcessEvent, Round, RoundStatus, SessionMeta } from '@zooique/memora';
import type { PendingQuestionDto } from '../../shared/protocol.js';
import { HostedSessionNotifier, noteHandBackOrSettlement } from '../helpers/hostedSessionNotice.js';
import { SessionModeStore } from '../../extension/host/sessionModeStore.js';
// 派活账本核销挂点（判据 C）：落定系统事件必须核销，且与「能否通知创建者」解耦
import { readDispatchLedger, recordDispatchLedger } from '../../extension/host/dispatchLedger.js';
import { makeTempDir } from '../../__tests__/helpers/tmpDir.js';

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
 * @param assistantContent 助手正文（成功轮的交付摘录来源；缺省 = 无正文）
 */
function round(
  id: string,
  status: RoundStatus,
  events: ProcessEvent[] = [],
  assistantContent?: string,
): Round {
  return {
    id,
    userMessage: { id: `${id}-u`, role: 'user', content: '派发内容', timestamp: TS },
    status,
    createdAt: TS,
    completedAt: TS,
    processEvents: events,
    ...(assistantContent
      ? {
          assistantMessage: {
            id: `${id}-a`,
            role: 'assistant' as const,
            content: assistantContent,
            timestamp: TS,
          },
        }
      : {}),
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
  /** 模拟「创建者实例还没装配 / 刚被摘」：false = `getAgent` 取不到创建者 */
  setCreatorAssembled: (assembled: boolean) => void;
} {
  const creatorQueue = vi.fn();
  const childQueue = vi.fn();
  // 「能否唤醒」由面板判据给出（空闲 + 用户没在打字）；此处用可变开关模拟两种不抢场景
  let canWake = true;
  const wakeCreator = vi.fn(() => true);
  const metas = new Map<string, SessionMeta>();
  const managed = new Set<string>([CREATOR]);
  // 当前由代理驱动的会话替身（生产判据 = 读盘 isAgentDrivenFailClosed，见 sessionStatus.ts；
  // 子会话出生后默认由代理驱动，故初始在内）。这里用可变集合替身覆盖「用户接管中/非托管」分支。
  const driven = new Set<string>([CHILD]);
  const rounds = new Map<string, Round>();
  // 创建者实例单拎出来：`setCreatorAssembled` 要能摘掉再装回同一个对象
  const creatorAgent = { agentLoop: { enqueueCommandResult: creatorQueue } } as unknown as Agent;
  const agents = new Map<string, Agent>([
    [CREATOR, creatorAgent],
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
    setCreatorAssembled: (assembled) => {
      // 摘掉 / 装回创建者实例：`getAgent` 直读这张表（生产 = 面板的 `_sessionAgents`）
      if (assembled) agents.set(CREATOR, creatorAgent);
      else agents.delete(CREATOR);
    },
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

  it('成功轮带交付摘录：主控据此汇报「交付了什么」，而不是只报状态', () => {
    const h = harness();
    h.metas.set(CHILD, meta(CHILD, 'hosted', '抓取任务'));
    h.rounds.set(
      'r-deliver',
      round(
        'r-deliver',
        'complete',
        [],
        '我完成了 100 字自我介绍：大家好，我是负责目录统计的助手。',
      ),
    );
    h.notifier.remember(CHILD, CREATOR);

    expect(h.notifier.noteSettledFlow(CHILD, 'r-deliver', false, false)).toBe(true);
    const text = h.creatorQueue.mock.calls[0][0] as string;
    expect(text).toContain('交付摘录：我完成了 100 字自我介绍：大家好');
  });

  it('交付摘录按共用上限 280 截断（与工作台末轮摘要同一口径）', () => {
    const h = harness();
    h.metas.set(CHILD, meta(CHILD, 'hosted', '长文任务'));
    const long = '甲'.repeat(300);
    h.rounds.set('r-long', round('r-long', 'complete', [], long));
    h.notifier.remember(CHILD, CREATOR);

    expect(h.notifier.noteSettledFlow(CHILD, 'r-long', false, false)).toBe(true);
    const text = h.creatorQueue.mock.calls[0][0] as string;
    expect(text).toContain(`${'甲'.repeat(280)}…`);
    expect(text).not.toContain('甲'.repeat(281));
  });

  it('中断轮即使有半截正文也不带交付摘录（半截回答不冒充交付）', () => {
    const h = harness();
    h.metas.set(CHILD, meta(CHILD, 'hosted', '被停的任务'));
    h.rounds.set(
      'r-half',
      round(
        'r-half',
        'interrupted',
        [{ type: 'aborted', seq: 1, ts: TS, payload: { reason: 'cancelled', stopReason: 'user' } }],
        '半截回答：我刚写到一半就被停',
      ),
    );
    h.notifier.remember(CHILD, CREATOR);

    expect(h.notifier.noteSettledFlow(CHILD, 'r-half', false, true)).toBe(true);
    const text = h.creatorQueue.mock.calls[0][0] as string;
    expect(text).not.toContain('交付摘录');
    expect(text).not.toContain('半截回答');
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
    // 创建者不再是助手会话（现在是普通会话，不拿代理的事实打扰它）
    h.managed.delete(CREATOR);
    expect(h.notifier.noteSettledFlow(CHILD, 'r7', false, true)).toBe(false);
    expect(h.creatorQueue).not.toHaveBeenCalled();
  });

  it('子会话当前不由代理驱动（用户接管中）→ 不通知创建者（出生账本不当权限用）', () => {
    const h = harness();
    h.metas.set(CHILD, meta(CHILD, 'hosted', '抓取任务'));
    h.rounds.set('r10', round('r10', 'interrupted', []));
    // 出生记录仍记着创建者，但当前驱动权不在代理侧
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

    expect(h.notifier.pendingReportCount(CREATOR)).toBe(0);
    expect(h.notifier.noteSettledFlow(CHILD, 'r11', false, false)).toBe(true);
    // 不打断：此刻既不写创建者队列，也不起轮
    expect(h.creatorQueue).not.toHaveBeenCalled();
    expect(h.wakeCreator).not.toHaveBeenCalled();
    // 结果压着没送要如实说：待办条数就是那句事实的读数源
    expect(h.notifier.pendingReportCount(CREATOR)).toBe(1);

    // 本轮收场，创建者恢复空闲 → 补浮现
    h.setCanWake(true);
    h.notifier.flushPending(CREATOR);
    expect(h.creatorQueue).toHaveBeenCalledTimes(1);
    expect(h.wakeCreator).toHaveBeenCalledTimes(1);
    expect(h.creatorQueue.mock.calls[0][0] as string).toContain('抓取任务');
    // 浮现后待办清空（条数随之归零，不会一直报「未送达」）
    expect(h.notifier.pendingReportCount(CREATOR)).toBe(0);
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

  it('创建者实例还没装配 → 压待办不丢（真机：子会话先落定、面板尚未装配）', () => {
    const h = harness();
    h.metas.set(CHILD, meta(CHILD, 'hosted', '抓取任务'));
    h.rounds.set('r16', round('r16', 'complete', []));
    h.notifier.remember(CHILD, CREATOR);
    h.setCreatorAssembled(false);

    // 投递失败但事实进待办：返回 false（如实说没送达），待办条数 +1
    expect(h.notifier.noteSettledFlow(CHILD, 'r16', false, false)).toBe(false);
    expect(h.creatorQueue).not.toHaveBeenCalled();
    expect(h.notifier.pendingReportCount(CREATOR)).toBe(1);

    // 同一轮重复信号：不重复排队（去重键在受理时已记）
    expect(h.notifier.noteSettledFlow(CHILD, 'r16', false, false)).toBe(false);
    expect(h.notifier.pendingReportCount(CREATOR)).toBe(1);

    // 实例装配到位（面板装配后调 flushPending）→ 按序放出并唤醒一轮
    h.setCreatorAssembled(true);
    h.notifier.flushPending(CREATOR);
    expect(h.creatorQueue).toHaveBeenCalledTimes(1);
    expect(h.creatorQueue.mock.calls[0][0] as string).toContain('抓取任务');
    expect(h.wakeCreator).toHaveBeenCalledTimes(1);
    expect(h.notifier.pendingReportCount(CREATOR)).toBe(0);
  });
});

describe('HostedSessionNotifier · 助手身份跨重启（HOSTED-IDENTITY-PERSIST-1）', () => {
  /** 最小 Memento：update 同步生效，供「同一持久层换容器实例」模拟重启 */
  function makeMemento() {
    const data = new Map<string, unknown>();
    return {
      get: <T>(key: string): T | undefined => data.get(key) as T | undefined,
      update: async (key: string, value: unknown): Promise<void> => {
        data.set(key, value);
      },
    };
  }

  it('重启后创建者身份读持久指针 ⇒ 子会话落定通知不丢弃（入待办并放出）', () => {
    const memento = makeMemento();
    // 上一个进程：把 CREATOR 设成助手会话（写工作区指针）
    new SessionModeStore(memento as never).set(CREATOR, 'managed');

    // 「重启」：新容器实例读同一份持久层；通知器的 isManaged 只读它（不读模式标签表）
    const modes = new SessionModeStore(memento as never);
    const metas = new Map<string, SessionMeta>([[CHILD, meta(CHILD, 'hosted', '抓取任务')]]);
    const rounds = new Map<string, Round>([['r-restart', round('r-restart', 'complete', [])]]);
    const creatorQueue = vi.fn();
    // 创建者忙（用户正在输入）⇒ 压待办；空闲后 flushPending 放出
    let canWake = false;
    const notifier = new HostedSessionNotifier({
      readSessionMeta: (sid) => metas.get(sid),
      isManaged: (sid) => modes.isManaged(sid),
      isAgentDriven: (sid) => sid === CHILD,
      getAgent: (sid) =>
        sid === CREATOR
          ? ({ agentLoop: { enqueueCommandResult: creatorQueue } } as unknown as Agent)
          : undefined,
      readRound: (roundId) => rounds.get(roundId),
      canWakeCreator: () => canWake,
      wakeCreator: () => true,
    });
    notifier.remember(CHILD, CREATOR);

    // 身份为真 ⇒ 受理（去重键记下、事实进待办）；不是「resolveTarget 返回 undefined ⇒ 直接丢」
    expect(notifier.noteSettledFlow(CHILD, 'r-restart', false, false)).toBe(true);
    expect(creatorQueue).not.toHaveBeenCalled();
    expect(notifier.pendingReportCount(CREATOR)).toBe(1);

    // 实例空闲后放出：事实没丢
    canWake = true;
    notifier.flushPending(CREATOR);
    expect(creatorQueue).toHaveBeenCalledTimes(1);
    expect(notifier.pendingReportCount(CREATOR)).toBe(0);
  });
});

/**
 * HOSTED-ASK-ROUTE-1「等你作答」档（第六切片）
 *
 * 钉四条完成判据里 notifier 能独立锁住的三条：
 * ① 带戳工作会话提问 → 秒级叫醒创建者、题面 + 选项随 system 事实进队列；
 * ② 忙 / 未装配 → 不丢、压待办、收场后补投（复用既有纪律，不另造队列）；
 * ④ 无戳轮（当前不归代理驱动）→ 不叫代理。
 * 另钉对抗点：needs-answer 去重试与落定键隔离——同轮先提问后落定，两条都能投递。
 *
 * 完成判据③（子会话 30 分钟超时自走保底保留不动）属 AskCoordinator 域，
 * 本切片只加主通道、未触碰 `armAskTimeout` / `handleAskTimeout`，由 chatPanel 集成测试覆盖。
 */
describe('HostedSessionNotifier · 等你作答（HOSTED-ASK-ROUTE-1）', () => {
  /** 造一批在途提问（题面 + 选项 + 题身份） */
  function questions(
    ...specs: Array<{ id?: string; q: string; options?: string[] }>
  ): PendingQuestionDto[] {
    return specs.map((s, i) => ({
      slot: `slot-${i}`,
      ...(s.id ? { askCallId: s.id } : {}),
      question: s.q,
      ...(s.options ? { options: s.options } : {}),
    }));
  }

  it('① 带戳工作会话提问 → 秒级叫醒创建者，题面 + 选项随事实进队列（不等超时）', () => {
    const h = harness();
    h.metas.set(CHILD, meta(CHILD, 'hosted', '抓取任务'));
    h.notifier.remember(CHILD, CREATOR);

    const qs = questions(
      { id: 'q-a', q: '用哪个方案？', options: ['方案A', '方案B'] },
      { id: 'q-b', q: '要不要发布？' },
    );
    expect(h.notifier.noteNeedsAnswer({ sessionId: CHILD, questions: qs })).toBe(true);

    // 直接投递（创建者空闲）：队列进一条、立刻起一轮，不等 30 分钟超时
    expect(h.creatorQueue).toHaveBeenCalledTimes(1);
    expect(h.wakeCreator).toHaveBeenCalledTimes(1);
    // 子会话自己的队列静默；事实只投给创建者
    expect(h.childQueue).not.toHaveBeenCalled();
    const text = h.creatorQueue.mock.calls[0][0] as string;
    expect(text).toContain('[托管会话需要你拍板]');
    expect(text).toContain('抓取任务');
    expect(text).toContain(CHILD);
    expect(text).toContain('用哪个方案？');
    expect(text).toContain('方案A / 方案B');
    expect(text).toContain('要不要发布？');
    // 2026-11-18 用户拍板：助手按判断拍板继续、不阻塞，不再强制「逐题作答」这一种形态
    expect(text).toContain('按判断拍板继续');
    expect(text).toContain('不要阻塞任务');
    expect(text).toContain('别拖到超时让子会话自己代选');
    expect(text).not.toContain('请立即逐题作答');
    // 2026-11-21 订正（ASK-PROXY-PREFER-1）：真机「任选」退化为偏好题一律空串跳过 ⇒
    // 有选项优先代选；保留「只有无法判断才转述」作为退路，不可逆操作边界不放宽。
    expect(text).toContain('有选项时按题面与上下文直接代选一项并说明代选理由');
    expect(text).toContain('只有确实无法判断时才转述用户或继续别的活');
    expect(text).toContain('不可逆操作不代答');
  });

  it('② 创建者忙 → 压待办不丢，也不起轮；收场后合并浮现', () => {
    const h = harness();
    h.metas.set(CHILD, meta(CHILD, 'hosted', '抓取任务'));
    h.notifier.remember(CHILD, CREATOR);
    h.setCanWake(false);

    expect(
      h.notifier.noteNeedsAnswer({ sessionId: CHILD, questions: questions({ q: '选哪个？' }) }),
    ).toBe(true);
    expect(h.creatorQueue).not.toHaveBeenCalled();
    expect(h.wakeCreator).not.toHaveBeenCalled();
    expect(h.notifier.pendingReportCount(CREATOR)).toBe(1);

    h.setCanWake(true);
    h.notifier.flushPending(CREATOR);
    expect(h.creatorQueue).toHaveBeenCalledTimes(1);
    expect(h.creatorQueue.mock.calls[0][0] as string).toContain('选哪个？');
    expect(h.wakeCreator).toHaveBeenCalledTimes(1);
    expect(h.notifier.pendingReportCount(CREATOR)).toBe(0);
  });

  it('② 创建者实例未装配 → 压待办不丢（返回 false 如实说没送达），装配后放出', () => {
    const h = harness();
    h.metas.set(CHILD, meta(CHILD, 'hosted', '抓取任务'));
    h.notifier.remember(CHILD, CREATOR);
    h.setCreatorAssembled(false);

    expect(
      h.notifier.noteNeedsAnswer({ sessionId: CHILD, questions: questions({ q: '确认？' }) }),
    ).toBe(false);
    expect(h.creatorQueue).not.toHaveBeenCalled();
    expect(h.notifier.pendingReportCount(CREATOR)).toBe(1);

    h.setCreatorAssembled(true);
    h.notifier.flushPending(CREATOR);
    expect(h.creatorQueue).toHaveBeenCalledTimes(1);
    expect(h.notifier.pendingReportCount(CREATOR)).toBe(0);
  });

  it('④ 无戳轮（当前不归代理驱动）→ 不叫代理；出生来源也不能当判据', () => {
    const h = harness();
    // 出生托管 + 误登记了创建者，但当前驱动权已归用户 ⇒ 不叫代理
    h.metas.set(CHILD, meta(CHILD, 'hosted', '抓取任务'));
    h.notifier.remember(CHILD, CREATOR);
    h.driven.delete(CHILD);

    expect(
      h.notifier.noteNeedsAnswer({ sessionId: CHILD, questions: questions({ q: '选哪个？' }) }),
    ).toBe(false);
    expect(h.creatorQueue).not.toHaveBeenCalled();
    expect(h.wakeCreator).not.toHaveBeenCalled();
  });

  it('④ 没有创建者记录 → 不叫代理（不知道叫谁就不乱发）', () => {
    const h = harness();
    h.metas.set(CHILD, meta(CHILD, 'hosted', '抓取任务'));
    // 不 remember：无创建者
    expect(
      h.notifier.noteNeedsAnswer({ sessionId: CHILD, questions: questions({ q: '选哪个？' }) }),
    ).toBe(false);
    expect(h.creatorQueue).not.toHaveBeenCalled();
  });

  it('同批重复提问事件 → 只叫一次；换一批题 → 可再次唤醒', () => {
    const h = harness();
    h.metas.set(CHILD, meta(CHILD, 'hosted', '抓取任务'));
    h.notifier.remember(CHILD, CREATOR);
    const qs = questions({ id: 'q-1', q: '选哪个？' });

    expect(h.notifier.noteNeedsAnswer({ sessionId: CHILD, questions: qs })).toBe(true);
    // 同批重复（题身份相同）→ 去重键拦住
    expect(h.notifier.noteNeedsAnswer({ sessionId: CHILD, questions: qs })).toBe(false);
    expect(h.creatorQueue).toHaveBeenCalledTimes(1);

    // 换一批（新题身份）→ 新键，可再次叫醒
    expect(
      h.notifier.noteNeedsAnswer({
        sessionId: CHILD,
        questions: questions({ id: 'q-2', q: '再选一个？' }),
      }),
    ).toBe(true);
    expect(h.creatorQueue).toHaveBeenCalledTimes(2);
    expect(h.wakeCreator).toHaveBeenCalledTimes(2);
  });

  it('空提问不叫代理', () => {
    const h = harness();
    h.metas.set(CHILD, meta(CHILD, 'hosted', '抓取任务'));
    h.notifier.remember(CHILD, CREATOR);
    expect(h.notifier.noteNeedsAnswer({ sessionId: CHILD, questions: [] })).toBe(false);
    expect(h.creatorQueue).not.toHaveBeenCalled();
  });

  it('对抗：题身份与 roundId 撞串 → needs-answer 键前缀隔离，落定通知不被吞', () => {
    const h = harness();
    h.metas.set(CHILD, meta(CHILD, 'hosted', '抓取任务'));
    h.rounds.set('SAME-ID', round('SAME-ID', 'complete', []));
    h.notifier.remember(CHILD, CREATOR);

    // 真机可能：题身份 askCallId 恰好 = 轮 id。去掉 needs-answer: 前缀后两键都会是
    // `CHILD:SAME-ID` ⇒ 落定被提问的去重键吞掉。前缀隔离是唯一防线，必须锁住。
    expect(
      h.notifier.noteNeedsAnswer({
        sessionId: CHILD,
        questions: questions({ id: 'SAME-ID', q: '选哪个？' }),
      }),
    ).toBe(true);
    expect(h.notifier.noteSettledFlow(CHILD, 'SAME-ID', false, false)).toBe(true);
    expect(h.creatorQueue).toHaveBeenCalledTimes(2);
    const texts = h.creatorQueue.mock.calls.map((c) => c[0] as string);
    expect(texts.some((t) => t.includes('[托管会话需要你拍板]'))).toBe(true);
    expect(texts.some((t) => t.includes('[托管会话已落定]'))).toBe(true);
  });

  it('源码守卫：提问渲染两条路径都调用了 noteNeedsAnswer；超时保底 armAskTimeout 仍保留', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../panels/chatPanel.ts', import.meta.url)),
      'utf-8',
    );
    // 两条提问写入路径（事件驱动 + 流尾兜底）都要叫醒创建者，不能只挂一条
    expect(src.match(/noteNeedsAnswer\(\{/g)?.length).toBe(2);
    // 完成判据③：超时保底没被本切片移除
    expect(src.match(/ask\.armAskTimeout\(\)/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe('P2 · Hand back 交回档（与落定共投递面）', () => {
  const hand = (workOrder?: string) => {
    const h = harness();
    h.metas.set(CHILD, {
      ...meta(CHILD, 'hosted', '抓取任务'),
      ...(workOrder ? { workOrder } : {}),
    });
    h.notifier.remember(CHILD, CREATOR);
    return h;
  };
  const localQuestions = (id: string) => [{ slot: 'slot-0', askCallId: id, question: '选哪个？' }];

  it('非前缀 / reason 缺失 → 不投，落定照常', () => {
    const h = hand();
    expect(h.notifier.noteHandBack(CHILD, '[后台命令完成] foo')).toBe(false);
    expect(h.notifier.noteHandBack(CHILD, '[HAND_BACK] suggestion: x')).toBe(false);
    expect(h.creatorQueue).not.toHaveBeenCalled();
  });

  it('命中交回 → 只投 Router，正文带 reason 与原派活边界，子会话静默', () => {
    const h = hand('只做文档，不推送');
    expect(
      h.notifier.noteHandBack(CHILD, '[HAND_BACK] reason: 超出范围 | suggestion: 新建会话'),
    ).toBe(true);
    expect(h.creatorQueue).toHaveBeenCalledTimes(1);
    expect(h.childQueue).not.toHaveBeenCalled();
    const text = h.creatorQueue.mock.calls[0][0] as string;
    expect(text).toContain('[托管会话交回]');
    expect(text).toContain('抓取任务');
    expect(text).toContain('超出范围');
    expect(text).toContain('只做文档，不推送');
    expect(text).toContain('[HAND_BACK] reason: 超出范围 | suggestion: 新建会话');
  });

  it('规范化：字段顺序乱也按 handBackMessage 真源矫正', () => {
    const h = hand();
    h.notifier.noteHandBack(CHILD, '[HAND_BACK] suggestion: y | reason: x');
    const text = h.creatorQueue.mock.calls[0][0] as string;
    expect(text).toContain('[HAND_BACK] reason: x | suggestion: y');
  });

  it('同因幂等；不同 reason 各投各的；与 needs-answer / 落定键撞串不互吞', () => {
    const h = hand();
    expect(h.notifier.noteHandBack(CHILD, '[HAND_BACK] reason: 超界A')).toBe(true);
    expect(h.notifier.noteHandBack(CHILD, '[HAND_BACK] reason: 超界A')).toBe(true);
    expect(h.creatorQueue).toHaveBeenCalledTimes(1);
    expect(h.notifier.noteHandBack(CHILD, '[HAND_BACK] reason: 超界B')).toBe(true);
    // handback 键与 needs-answer / 落定键前缀隔离：同串不吞
    h.rounds.set('超界A', round('超界A', 'complete', []));
    expect(
      h.notifier.noteNeedsAnswer({ sessionId: CHILD, questions: localQuestions('超界A') }),
    ).toBe(true);
    expect(h.notifier.noteSettledFlow(CHILD, '超界A', false, false)).toBe(true);
    expect(h.creatorQueue).toHaveBeenCalledTimes(4);
  });

  it('降级：无创建者 / 创建者被收回 / 用户轮无戳 → 不投，落定仍可走', () => {
    const noCreator = harness();
    expect(noCreator.notifier.noteHandBack(CHILD, '[HAND_BACK] reason: x')).toBe(false);

    const unmanaged = hand();
    unmanaged.managed.delete(CREATOR);
    expect(unmanaged.notifier.noteHandBack(CHILD, '[HAND_BACK] reason: x')).toBe(false);

    const userRound = hand();
    userRound.driven.delete(CHILD);
    expect(userRound.notifier.noteHandBack(CHILD, '[HAND_BACK] reason: x')).toBe(false);
    expect(userRound.creatorQueue).not.toHaveBeenCalled();
  });

  it('忙 / 未装配 → 视为受理，压待办不丢，放出后只投一条', () => {
    const busy = hand();
    busy.setCanWake(false);
    expect(busy.notifier.noteHandBack(CHILD, '[HAND_BACK] reason: 忙')).toBe(true);
    expect(busy.creatorQueue).not.toHaveBeenCalled();
    busy.setCanWake(true);
    busy.notifier.flushPending(CREATOR);
    expect(busy.creatorQueue).toHaveBeenCalledTimes(1);

    const absent = hand();
    absent.setCreatorAssembled(false);
    expect(absent.notifier.noteHandBack(CHILD, '[HAND_BACK] reason: 未装配')).toBe(true);
    absent.setCreatorAssembled(true);
    absent.notifier.flushPending(CREATOR);
    expect(absent.creatorQueue).toHaveBeenCalledTimes(1);
  });

  it('收场分流：命中交回接管本轮，未命中落定照发', () => {
    const h = hand();
    h.rounds.set('r9', round('r9', 'complete', []));
    noteHandBackOrSettlement(h.notifier, CHILD, 'r9', '[HAND_BACK] reason: 超界', false, false);
    expect(h.creatorQueue).toHaveBeenCalledTimes(1);
    expect(h.creatorQueue.mock.calls[0][0] as string).toContain('[托管会话交回]');
    noteHandBackOrSettlement(h.notifier, CHILD, 'r9', '普通回答', false, false);
    expect(h.creatorQueue).toHaveBeenCalledTimes(2);
    expect(h.creatorQueue.mock.calls[1][0] as string).toContain('[托管会话已落定]');
  });

  it('源码守卫：面板只经分流单点收场，不直连 noteSettledFlow', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../panels/chatPanel.ts', import.meta.url)),
      'utf-8',
    );
    expect(src.match(/noteHandBackOrSettlement\(/g)?.length).toBe(1);
    expect(src).toContain('textByRound.get(latestRoundId)');
    expect(src).not.toContain('this._hostedNotifier.noteSettledFlow(');
  });
});

/**
 * 第八切片（HOSTED-NOTICE-KIND-1）：唤醒档位分家 + 待办事实带时效
 *
 * 真机证据：三条通道共用一句「有一条托管会话刚落定」的种子 ⇒「子会话在等你拍板」那次唤醒
 * 也被告知已落定，模型先汇报交付、顺手代答；多条压队合并浮现时无产生时刻 ⇒ 模型按
 * 「最后一条为准」推断，把几分钟前的旧落定读成「此刻刚被停」，进而不去代答第 2 题。
 */
describe('HostedSessionNotifier · 唤醒档位与待办时效（HOSTED-NOTICE-KIND-1）', () => {
  /** 最小提问 DTO（题面真源 = 协议；本组只验档位与时效，不验题面拼装） */
  const ask: PendingQuestionDto[] = [{ slot: 'slot-0', question: '选哪个？' }];

  it('待拍板 → 档位 needs-answer（不再冒充「已落定」）', () => {
    const h = harness();
    h.metas.set(CHILD, meta(CHILD, 'hosted', '小说家 ask 测试'));
    h.notifier.remember(CHILD, CREATOR);

    expect(h.notifier.noteNeedsAnswer({ sessionId: CHILD, questions: ask })).toBe(true);
    expect(h.wakeCreator).toHaveBeenCalledWith(CREATOR, 'needs-answer');
  });

  it('落定 → settlement；交回 → handback（三档各自声明，不共用一句）', () => {
    const settled = harness();
    settled.metas.set(CHILD, meta(CHILD, 'hosted', '抓取任务'));
    settled.rounds.set('r31', round('r31', 'complete', []));
    settled.notifier.remember(CHILD, CREATOR);
    settled.notifier.noteSettledFlow(CHILD, 'r31', false, false);
    expect(settled.wakeCreator).toHaveBeenCalledWith(CREATOR, 'settlement');

    const back = harness();
    back.metas.set(CHILD, meta(CHILD, 'hosted', '抓取任务'));
    back.notifier.remember(CHILD, CREATOR);
    back.notifier.noteHandBack(CHILD, '[HAND_BACK] reason: 超出范围');
    expect(back.wakeCreator).toHaveBeenCalledWith(CREATOR, 'handback');
  });

  it('待办合并浮现 → 档位 pending，且每条前置「产生于 N 分钟前」', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-11-22T10:00:00.000Z'));
      const h = harness();
      h.metas.set(CHILD, meta(CHILD, 'hosted', '抓取任务'));
      h.rounds.set('r32', round('r32', 'complete', []));
      h.notifier.remember(CHILD, CREATOR);
      // 创建者在忙：事实压进待办，此刻不浮现
      h.setCanWake(false);
      h.notifier.noteSettledFlow(CHILD, 'r32', false, false);
      expect(h.creatorQueue).not.toHaveBeenCalled();

      // 3 分钟后创建者收场空闲 → 浮现时必须带上产生时刻
      vi.setSystemTime(new Date('2026-11-22T10:03:00.000Z'));
      h.setCanWake(true);
      h.notifier.flushPending(CREATOR);

      const text = h.creatorQueue.mock.calls[0]?.[0] as string;
      expect(text).toContain('产生于 3 分钟前');
      // 正文仍原样保留（只加时间坐标，不改写事实）
      expect(text).toContain('[托管会话已落定]');
      expect(text).toContain('抓取任务');
      expect(h.wakeCreator).toHaveBeenCalledWith(CREATOR, 'pending');
    } finally {
      vi.useRealTimers();
    }
  });

  it('刚压就放 → 标「刚刚产生」（不给毫秒级假精度）', () => {
    const h = harness();
    h.metas.set(CHILD, meta(CHILD, 'hosted', '抓取任务'));
    h.rounds.set('r33', round('r33', 'complete', []));
    h.notifier.remember(CHILD, CREATOR);
    h.setCanWake(false);
    h.notifier.noteSettledFlow(CHILD, 'r33', false, false);
    h.setCanWake(true);
    h.notifier.flushPending(CREATOR);

    expect(h.creatorQueue.mock.calls[0]?.[0] as string).toContain('刚刚产生');
  });
});

describe('派活账本核销挂点（判据 C）', () => {
  it('轮落定的系统回程核销账本：即使创建者不可通知，也照样从 pending 变 settled', () => {
    const dir = makeTempDir('memora-notice-ledger-');
    // 先记一条「已派给 CHILD」的在途活
    recordDispatchLedger(dir, {
      kind: 'send',
      callerSessionId: CREATOR,
      targetSessionId: CHILD,
      targetTitle: '抓取任务',
      text: '把抓取跑完',
      createdAt: '2026-11-22T00:00:00.000Z',
    });
    const notifier = new HostedSessionNotifier({
      // 元数据缺失 ⇒ resolveTarget 返回 undefined：通知投不出去，但落定事实仍然成立
      readSessionMeta: () => undefined,
      isManaged: () => true,
      isAgentDriven: () => true,
      getAgent: () => undefined,
      readRound: () => undefined,
      canWakeCreator: () => false,
      wakeCreator: () => false,
      projectPath: () => dir,
    });

    const delivered = notifier.noteFlowEnd({
      sessionId: CHILD,
      round: round('r-ledger', 'complete', []),
      hostAborted: false,
    });

    // 通知没投（无创建者元数据），账本不能因此永远 pending
    expect(delivered).toBe(false);
    const [record] = readDispatchLedger(dir, { now: Date.parse('2026-11-22T00:10:00.000Z') });
    expect(record).toMatchObject({
      targetSessionId: CHILD,
      status: 'settled',
      roundId: 'r-ledger',
      outcome: 'success',
    });
  });
});
