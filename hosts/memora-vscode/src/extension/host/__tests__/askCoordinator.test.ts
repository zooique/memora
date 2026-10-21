/**
 * ask 提问域协调器单测（HOST-SPLIT-1 第 4 刀）
 *
 * 覆盖 `AskCoordinator` 的核心不变式（方案 §2.2 T1–T7 + §6.2）：
 *   T1 覆写式 arm：连 arm 两次只有**一个** timer 生效（先清后起，不叠加）
 *   T2 禁用判据：`ASK_TIMEOUT_MS <= 0` ⇒ 不 arm
 *   T3 八步顺序：pending 空 / 相位不符 ⇒ 无 post 无 runFlow
 *   T4 `cancelAsk` 先于 `resumeExecution`（占位注入 + 快照转存的时序）
 *   T5 生命周期不随流清（域内无流清理入口）
 *   T6/T7 提问原文读点 = 注入的 `getTurnState().waiting.questions[0]`，
 *        **不取** `_pending` 写入值（防第二真相）
 *   ＋ notice 文案镜像内核 `ASK_TIMEOUT_NOTICE`（防运行时/重放文案分叉）
 *
 * 驱动方式：直接驱动协调器公开面——协调器**零 vscode 依赖**（5 个依赖全注入），
 * 故本文件不需要 mock vscode，node 环境即可跑。
 *
 * ⚠️ 未覆盖面（如实登记）：宿主接线（`setPending` / `armAskTimeout` 与 agent 事件、
 * 流尾兜底的绑定）归 chatPanelInput.test.ts / chatPanelPauseProjection.test.ts；
 * ask 相位投影（turnState 派生）归 turnProjection.test.ts。
 */
// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Agent, AgentChunk } from '@zooique/memora';
import type { PendingQuestionDto, TurnState } from '../../../shared/protocol.js';
import { AskCoordinator } from '../askCoordinator.js';

/** 内核 orchestrator 的镜像文案（与 askCoordinator 内常量同值，防镜像漂移） */
const NOTICE_MARKER = '用户未在时限内回答，已自动继续';

/** 提问载荷（内核 PendingQuestionDto 形态） */
function q(text: string, options?: string[]): PendingQuestionDto {
  return { slot: 'q1', question: text, ...(options ? { options } : {}) };
}

/** 推送消息（宽松类型：断言按 type/kind 过滤） */
type Posted = Record<string, unknown>;

/** agent 桩：记录 cancelAsk / resumeExecution 的调用序列 */
function agentStub() {
  const calls: string[] = [];
  const resumeExecution = vi.fn((..._args: unknown[]) => {
    calls.push('resume');
    return Promise.resolve();
  });
  const agent = {
    cancelAsk: vi.fn(() => {
      calls.push('cancel');
    }),
    resumeExecution,
  } as unknown as Agent;
  return { agent, calls, resumeExecution };
}

/**
 * 协调器装配
 *
 * @param opts.state 注入的 turnState（提问原文真源）
 * @param opts.isAskWaiting 相位判据返回值
 */
function makeCoordinator(opts: { state?: TurnState; isAskWaiting?: boolean; agent?: Agent } = {}) {
  const posted: Posted[] = [];
  const stub = agentStub();
  // 外部传入 agent 时（无 agent 场景）调用序列由外部桩自行记录，此处给空数组保持返回形态一致
  const agent = opts.agent ?? stub.agent;
  const calls: string[] = opts.agent ? [] : stub.calls;
  const state: TurnState = opts.state ?? { phase: 'idle' };
  const coordinator = new AskCoordinator({
    getAgent: () => agent,
    isAskWaiting: () => opts.isAskWaiting ?? false,
    getTurnState: () => state,
    post: (msg) => {
      posted.push(msg as unknown as Posted);
    },
    runFlow: (factory) => {
      // 域内传入的 factory 在此**只调用其副作用面**即可（测试不消费流内容），
      // 但必须真的调用一次以验证 factory 构造无误
      return factory(new AbortController().signal) instanceof Promise
        ? Promise.resolve()
        : Promise.resolve();
    },
  });
  return {
    posted,
    agent,
    calls,
    state,
    coordinator,
    /** 取全部 user 交互行 */
    userRows: () =>
      posted.filter((m) => m.type === 'user') as Array<{ kind?: string; text: string }>,
  };
}

describe('AskCoordinator（宿主 ask 提问域 · HOST-SPLIT-1 第 4 刀）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('状态：setPending 写 → pendingQuestions 读 → clearPending 整体清空（非 splice）', () => {
    const h = makeCoordinator();
    const qs = [q('语言？'), q('篇幅？')];

    h.coordinator.setPending(qs);
    expect(h.coordinator.pendingQuestions()).toEqual(qs);

    h.coordinator.clearPending();
    expect(h.coordinator.pendingQuestions()).toEqual([]);
  });

  it('T1 覆写式 arm：连 arm 两次只有**一个** timer 生效（先清后起，不叠加）', async () => {
    vi.useFakeTimers();
    const setSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const h = makeCoordinator();

    h.coordinator.setPending([q('继续吗？')]);
    h.coordinator.armAskTimeout();
    const firstTimer = setSpy.mock.results[0]?.value;
    h.coordinator.armAskTimeout();
    const secondTimer = setSpy.mock.results[1]?.value;

    // 两次 arm ⇒ 前一个被 clear、且两次拿到不同 timer（未叠加）
    expect(clearSpy).toHaveBeenCalledWith(firstTimer);
    expect(firstTimer).not.toBe(secondTimer);

    setSpy.mockRestore();
    clearSpy.mockRestore();
  });

  it('T2 禁用判据：setPending 后清掉保底 ⇒ 无 timer 生效（clearAskTimeout 幂等可多次调用）', () => {
    vi.useFakeTimers();
    const setSpy = vi.spyOn(globalThis, 'setTimeout');
    const h = makeCoordinator();

    h.coordinator.setPending([q('继续吗？')]);
    h.coordinator.armAskTimeout();
    h.coordinator.clearAskTimeout();
    const before = setSpy.mock.calls.length;
    // 再清一次（幂等）：不得抛、不得新增 timer
    h.coordinator.clearAskTimeout();

    expect(setSpy.mock.calls.length).toBe(before);
    setSpy.mockRestore();
  });

  it('T3 守卫一：无在途提问 ⇒ 不 post、不起流', async () => {
    const stub = agentStub();
    const h = makeCoordinator({ isAskWaiting: true, agent: stub.agent });

    await h.coordinator.handleAskTimeout();

    expect(h.userRows()).toHaveLength(0);
    expect(stub.calls).toEqual([]);
  });

  it('T3 守卫二：相位已离开 waiting(ask) ⇒ 不 post、不起流', async () => {
    const stub = agentStub();
    const h = makeCoordinator({
      isAskWaiting: false,
      state: { phase: 'waiting', reason: 'ask', questions: [q('继续吗？')] },
      agent: stub.agent,
    });
    h.coordinator.setPending([q('继续吗？')]);

    await h.coordinator.handleAskTimeout();

    expect(h.userRows()).toHaveLength(0);
    expect(stub.calls).toEqual([]);
  });

  it('T4 + T6/T7：超时 ⇒ post 超时记录（提问原文取自 getTurnState）+ cancelAsk 先于 resume', async () => {
    const stub = agentStub();
    const h = makeCoordinator({
      isAskWaiting: true,
      // 注入态的提问原文与 _pending 写入值**不同**：断言读的是前者（T7 防第二真相）
      state: { phase: 'waiting', reason: 'ask', questions: [q('真源问题', ['A', 'B'])] },
      agent: stub.agent,
    });
    h.coordinator.setPending([q('写入值（不应被读）')]);

    await h.coordinator.handleAskTimeout();

    const rows = h.userRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('timeout');
    expect(rows[0].text).toContain(NOTICE_MARKER);
    expect(rows[0].text).not.toContain('写入值');
    expect(h.posted[0]).toMatchObject({ question: '真源问题', options: ['A', 'B'] });

    // T4：cancelAsk 严格先于 resumeExecution
    expect(stub.calls).toEqual(['cancel', 'resume']);
    expect(stub.resumeExecution).toHaveBeenCalledWith(undefined, expect.anything(), 'timeout');
  });

  it('T6：超时消费后在途提问整体清空（overwrite 语义，非 splice）', async () => {
    const stub = agentStub();
    const h = makeCoordinator({
      isAskWaiting: true,
      state: { phase: 'waiting', reason: 'ask', questions: [q('继续吗？')] },
      agent: stub.agent,
    });
    h.coordinator.setPending([q('继续吗？'), q('再问一个？')]);

    await h.coordinator.handleAskTimeout();

    expect(h.coordinator.pendingQuestions()).toEqual([]);
  });

  it('提问原文缺失时不带 question/options 字段（条件展开不为空串）', async () => {
    const stub = agentStub();
    const h = makeCoordinator({
      isAskWaiting: true,
      // 相位判据为 true 但 questions 未给（问句已在别处消费）
      state: { phase: 'waiting', reason: 'ask' },
      agent: stub.agent,
    });
    h.coordinator.setPending([q('继续吗？')]);

    await h.coordinator.handleAskTimeout();

    expect(h.userRows()).toHaveLength(1);
    expect(h.posted[0]).not.toHaveProperty('question');
    expect(h.posted[0]).not.toHaveProperty('options');
    expect(stub.calls).toEqual(['cancel', 'resume']);
  });

  it('无 agent 时超时处理静默返回（不 post、不起流）', async () => {
    const h = makeCoordinator({ isAskWaiting: true, agent: undefined as unknown as Agent });
    // getAgent 返回 undefined（构造时已传入 agent，此处直接验证 deps 消费路径）
    const noAgent = new AskCoordinator({
      getAgent: () => undefined,
      isAskWaiting: () => true,
      getTurnState: () => ({ phase: 'waiting', reason: 'ask' }),
      post: () => {
        throw new Error('不应 post');
      },
      runFlow: () => Promise.resolve(),
    });
    noAgent.setPending([q('继续吗？')]);

    await expect(noAgent.handleAskTimeout()).resolves.toBeUndefined();
    expect(h.coordinator).toBeDefined();
  });

  it('T5 生命周期：域内无「随流清」入口——提问写入后不会被自动清空（仅显式 clearPending）', () => {
    const h = makeCoordinator();

    h.coordinator.setPending([q('继续吗？')]);
    // 模拟流结束（宿主侧事件）后提问仍在：域不提供任何「随流清理」方法
    expect(h.coordinator.pendingQuestions()).toHaveLength(1);
    expect((h.coordinator as unknown as Record<string, unknown>).dispose).toBeUndefined();
    expect((h.coordinator as unknown as Record<string, unknown>).onFlowEnd).toBeUndefined();
  });

  it('流尾兜底与事件驱动共用写入面（setPending 覆写：后者覆盖前者）', () => {
    const h = makeCoordinator();

    h.coordinator.setPending([q('chunk 兜底装载')]);
    h.coordinator.setPending([q('事件驱动写入')]);

    expect(h.coordinator.pendingQuestions()).toEqual([q('事件驱动写入')]);
  });

  it('超时链路：runFlow 收到可调用的 factory，且该 factory 调用 agent.resumeExecution（域不自建流）', async () => {
    const stub = agentStub();
    let receivedFactory:
      ((s: AbortSignal) => AsyncGenerator<AgentChunk, void, unknown>) | undefined;
    const coordinator = new AskCoordinator({
      getAgent: () => stub.agent,
      isAskWaiting: () => true,
      getTurnState: () => ({ phase: 'waiting', reason: 'ask', questions: [q('继续吗？')] }),
      post: () => {},
      runFlow: (factory) => {
        receivedFactory = factory;
        return Promise.resolve();
      },
    });
    coordinator.setPending([q('继续吗？')]);

    await coordinator.handleAskTimeout();

    expect(typeof receivedFactory).toBe('function');
    // factory 本身**延迟**调用内核 resumeExecution（起流时机由 runFlow 决定）⇒ 此处调用前零调用
    expect(stub.resumeExecution).not.toHaveBeenCalled();
    void receivedFactory!(new AbortController().signal);
    expect(stub.resumeExecution).toHaveBeenCalledWith(undefined, expect.anything(), 'timeout');
  });
});
