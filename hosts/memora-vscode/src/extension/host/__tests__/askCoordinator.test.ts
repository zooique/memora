/**
 * ask 提问域协调器单测（HOST-SPLIT-1 第 4 刀）
 *
 * 覆盖 `AskCoordinator` 的核心不变式：
 *   T1 覆写式 arm：连 arm 两次只有**一个** timer 生效（先清后起，不叠加）
 *   T2 禁用判据：`ASK_TIMEOUT_MS <= 0` ⇒ 不 arm
 *   T3 判据 = 「提问是否仍未被消费」：无在途提问才早退；**相位不参与判定**（ADR-044 决策 4）
 *   T4 `cancelAsk` 先于 `resumeExecution`（占位注入 + 快照转存的时序）
 *   T5 生命周期不随流清（域内无流清理入口）
 *   T6 提问原文读点 = 本域在途快照 `_pending`（相位投影由它派生，不设第二真相）
 *   T7 不可续跑（无暂停检查点）⇒ `abandonTurn()` 收场，不「假续跑」
 *   T8 停止 ⇒ `abandonOnStop()` 清快照 + 逐条 post 未回答行 + 收场
 *   ＋ notice 文案镜像内核 `ASK_TIMEOUT_NOTICE`（防运行时/重放文案分叉）
 *
 * 驱动方式：直接驱动协调器公开面——协调器**零 vscode 依赖**（依赖全注入），
 * 故本文件不需要 mock vscode，node 环境即可跑。
 *
 * ⚠️ 未覆盖面（如实登记）：宿主接线（`setPending` / `armAskTimeout` 与 agent 事件、
 * 流尾兜底的绑定）归 chatPanelInput.test.ts / chatPanelPauseProjection.test.ts；
 * ask 相位投影（turnState 派生）归 turnProjection.test.ts。
 */
// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Agent, AgentChunk } from '@zooique/memora';
import { LOOP_CONSTANTS } from '@zooique/memora';
import type { PendingQuestionDto } from '../../../shared/protocol.js';
import { AskCoordinator } from '../askCoordinator.js';

/** 内核 orchestrator 的镜像文案（与 askCoordinator 内常量同值，防镜像漂移） */
const NOTICE_MARKER = '用户未在时限内回答，已自动继续';

/** 提问载荷（内核 PendingQuestionDto 形态） */
function q(text: string, options?: string[], askCallId?: string): PendingQuestionDto {
  return {
    slot: 'q1',
    question: text,
    ...(options ? { options } : {}),
    ...(askCallId ? { askCallId } : {}),
  };
}

/** 推送消息（宽松类型：断言按 type/kind 过滤） */
type Posted = Record<string, unknown>;

/**
 * agent 桩：记录 cancelAsk / resumeExecution / abandonTurn 的调用序列
 *
 * @param opts.status 内核会话状态（`resumeExecution` 的可续跑判据同源）
 * @param opts.checkpointDiscarded `abandonTurn` 的返回值（是否清掉了暂停检查点）
 */
function agentStub(
  opts: { status?: string; checkpointDiscarded?: boolean; roundId?: string } = {},
) {
  const calls: string[] = [];
  const resumeExecution = vi.fn((..._args: unknown[]) => {
    calls.push('resume');
    return Promise.resolve();
  });
  const cancelAsk = vi.fn(() => {
    calls.push('cancel');
  });
  const abandonTurn = vi.fn(async () => {
    calls.push('abandon');
    return opts.checkpointDiscarded ?? true;
  });
  /** 在途轮 id（内核 `Agent.currentRoundId` 同款）；缺省空串 = 无在途轮，不造假占位 */
  const currentRoundId = vi.fn(() => opts.roundId ?? '');
  const agent = {
    cancelAsk,
    currentRoundId,
    resumeExecution,
    abandonTurn,
    sessionManager: { status: opts.status ?? 'paused' },
  } as unknown as Agent;
  return { agent, calls, resumeExecution, cancelAsk, abandonTurn, currentRoundId };
}

/** 协调器装配（agent 缺省为暂停态桩——超时正常续跑的那条路） */
function makeCoordinator(stub = agentStub()) {
  const posted: Posted[] = [];
  const coordinator = new AskCoordinator({
    getAgent: () => stub.agent,
    post: (msg) => {
      posted.push(msg as unknown as Posted);
    },
    runFlow: (factory) => {
      // 域内传入的 factory 在此**只构造不消费**（测试不消费流内容），
      // 但必须真的调用一次以验证 factory 构造无误
      void factory(new AbortController().signal);
      return Promise.resolve();
    },
  });
  return {
    posted,
    stub,
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

  it('T3 守卫：无在途提问 ⇒ 不 post、不调内核（判据只有这一条）', async () => {
    const h = makeCoordinator();

    await h.coordinator.handleAskTimeout();

    expect(h.userRows()).toHaveLength(0);
    expect(h.stub.calls).toEqual([]);
  });

  it('T4 + T6 超时可续跑 ⇒ 整批 post 超时记录（题面取 _pending）+ cancelAsk 先于 resume', async () => {
    const h = makeCoordinator();
    h.coordinator.setPending([q('真源问题', ['A', 'B'])]);

    await h.coordinator.handleAskTimeout();

    const rows = h.userRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('timeout');
    expect(rows[0].text).toContain(NOTICE_MARKER);
    expect(h.posted[0]).toMatchObject({ question: '真源问题', options: ['A', 'B'] });

    // T4：cancelAsk 严格先于 resumeExecution
    expect(h.stub.calls).toEqual(['cancel', 'resume']);
    expect(h.stub.resumeExecution).toHaveBeenCalledWith(undefined, expect.anything(), 'timeout');
  });

  it('T6：超时消费后在途提问整体清空（overwrite 语义，非 splice）', async () => {
    const h = makeCoordinator();
    h.coordinator.setPending([q('继续吗？'), q('再问一个？')]);

    await h.coordinator.handleAskTimeout();

    expect(h.coordinator.pendingQuestions()).toEqual([]);
  });

  it('T4-batch 超时整批逐条 post：同刻 ts + 批内唯一 inputId + 各题问/选项随行透出（ASK-MULTI-Q-1 漏网面，与内核整组落盘同构）', async () => {
    const h = makeCoordinator();
    h.coordinator.setPending([
      q('Q1：编程语言？', ['TS', 'Python'], 'call-lang'),
      q('Q2：时区？', ['Asia/Shanghai', 'UTC'], 'call-tz'),
    ]);

    await h.coordinator.handleAskTimeout();

    const rows = h.userRows();
    // 整批逐条 post：屏上与盘面同为 N 条（与内核整组落盘同构）
    expect(rows).toHaveLength(2);
    expect(rows[0].kind).toBe('timeout');
    expect(rows[1].kind).toBe('timeout');
    expect(rows[0].text).toContain(NOTICE_MARKER);
    expect(rows[1].text).toContain(NOTICE_MARKER);
    // 批内同刻 ts（一次超时提交）+ 批内唯一身份（去重键真源，按 ts 去重会丢第 2 条）
    expect(h.posted[0]!.ts).toBe(h.posted[1]!.ts);
    expect(h.posted[0]!.inputId).not.toBe(h.posted[1]!.inputId);
    // ADR-043：身份取内核题身份（非宿主自造键）⇒ 与盘面落盘 id 同源、跨面可配对
    expect(h.posted[0]!.inputId).toBe('call-lang');
    expect(h.posted[1]!.inputId).toBe('call-tz');
    // 各题问/选项随行透出（不折叠到首问）
    expect(h.posted[0]).toMatchObject({ question: 'Q1：编程语言？', options: ['TS', 'Python'] });
    expect(h.posted[1]).toMatchObject({
      question: 'Q2：时区？',
      options: ['Asia/Shanghai', 'UTC'],
    });
    expect(h.stub.calls).toEqual(['cancel', 'resume']);
  });

  it('问句为空串 ⇒ 不带 question/options 字段（条件展开不为空串）', async () => {
    const h = makeCoordinator();
    h.coordinator.setPending([q('')]);

    await h.coordinator.handleAskTimeout();

    expect(h.userRows()).toHaveLength(1);
    expect(h.posted[0]).not.toHaveProperty('question');
    expect(h.posted[0]).not.toHaveProperty('options');
    expect(h.stub.calls).toEqual(['cancel', 'resume']);
  });

  it('T7 去相位化：提问未消费但已无可续跑点（用户已停止）⇒ abandonTurn 收场，不假续跑', async () => {
    // 旧实现首行 `if (!isAskWaiting()) return` 会在此早退：停止后相位离开 waiting(ask)，
    // 于是「最需要保底收场」的时刻反而什么都不做 ⇒ 轮永久 pending（真机 09:24 实证）。
    const stub = agentStub({ status: 'running' });
    const h = makeCoordinator(stub);
    h.coordinator.setPending([q('Q1：语言？', ['TS'])]);

    await h.coordinator.handleAskTimeout();

    // 未答提问仍要留痕（屏上不丢这批题）
    expect(h.userRows()).toHaveLength(1);
    expect(h.userRows()[0]!.kind).toBe('timeout');
    // 不续跑：无暂停检查点时 resumeExecution 会静默 return，等于白打一条流
    expect(stub.resumeExecution).not.toHaveBeenCalled();
    // 以中断收场（内核内部：cancelAsk 占位 + appendInterrupted 转 unanswered + 弃检查点）
    expect(stub.abandonTurn).toHaveBeenCalledTimes(1);
    expect(h.coordinator.pendingQuestions()).toEqual([]);
  });

  it('T8 停止（提问等待态）⇒ 清快照 + 逐条 post 未回答行（题面/候选/身份同盘面）+ 收场', async () => {
    const stub = agentStub({ checkpointDiscarded: true, roundId: 'round-42' });
    const h = makeCoordinator(stub);
    h.coordinator.setPending([
      q('Q1：职业？', ['主播', '护士'], 'call-a'),
      q('Q2：城市？', ['重庆'], 'call-b'),
    ]);

    const checkpointDiscarded = await h.coordinator.abandonOnStop();

    // ① 宿主镜像必须清：否则相位恒 waiting/ask，下一条输入被当成「回答死提问」吞掉
    expect(h.coordinator.pendingQuestions()).toEqual([]);
    // ② 逐条留痕：与内核 appendInterrupted 落盘的 unanswered 行同文案、同题身份
    const rows = h.userRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.kind)).toEqual(['unanswered', 'unanswered']);
    expect(rows[0]!.text).toBe(LOOP_CONSTANTS.ASK_UNANSWERED_NOTICE);
    expect(h.posted[0]).toMatchObject({ inputId: 'call-a', question: 'Q1：职业？' });
    expect(h.posted[1]).toMatchObject({ inputId: 'call-b', question: 'Q2：城市？' });
    expect(h.posted[0]!.ts).toBe(h.posted[1]!.ts);
    // ③ 收场 + 检查点结论透出
    expect(stub.abandonTurn).toHaveBeenCalledTimes(1);
    expect(checkpointDiscarded).toBe(true);
    // ④ 用户可见结论（不静默）
    const notices = h.posted.filter((m) => m.type === 'notice');
    expect(notices).toHaveLength(1);
    expect(String(notices[0]!.message)).toContain('2 个提问未回答');
    // ⑤ 收场消息：ask 期没有流可 abort，`runFlow` 的 aborted 收尾分支永不触发 ⇒ 必须在此补发，
    // 否则实时态不折叠过程、不写终态，与重载后的重放形态分叉（真机 2026-10-31 实证）
    const interrupted = h.posted.filter((m) => m.type === 'interrupted');
    expect(interrupted).toHaveLength(1);
    // ⑥ 轮身份随收场下发：缺它则 webview `settleRoundFooter` 首行早退 ⇒ 中断轮无底栏
    //（时间 + 复制/分叉/删除），实时形态与重放分叉（真机 2026-10-31 实证：底栏整块不出现）
    expect(interrupted[0]).toMatchObject({ roundId: 'round-42' });
    // 取轮身份的时机：必须在 abandonTurn 之前——不依赖「弃轮不清在途 id」这一实现细节
    expect(stub.currentRoundId.mock.invocationCallOrder[0]).toBeLessThan(
      stub.abandonTurn.mock.invocationCallOrder[0]!,
    );
  });

  it('T8 停止（纯暂停态，无在途提问）⇒ 只收场，不 post 未回答行', async () => {
    const stub = agentStub({ checkpointDiscarded: true });
    const h = makeCoordinator(stub);

    const checkpointDiscarded = await h.coordinator.abandonOnStop();

    expect(h.userRows()).toHaveLength(0);
    expect(h.posted.filter((m) => m.type === 'notice')).toHaveLength(0);
    // 纯暂停态同样收场：折叠/终态与重放同构，不因「没有提问」而漏发
    const interrupted = h.posted.filter((m) => m.type === 'interrupted');
    expect(interrupted).toHaveLength(1);
    // 无在途轮（currentRoundId 空串）⇒ 不造假 roundId，字段整块不下发（协议字段可选）
    expect(interrupted[0]).not.toHaveProperty('roundId');
    expect(stub.abandonTurn).toHaveBeenCalledTimes(1);
    expect(checkpointDiscarded).toBe(true);
  });

  it('无 agent 时超时处理静默返回（不 post、不起流）', async () => {
    const noAgent = new AskCoordinator({
      getAgent: () => undefined,
      post: () => {
        throw new Error('不应 post');
      },
      runFlow: () => Promise.resolve(),
    });
    noAgent.setPending([q('继续吗？')]);

    await expect(noAgent.handleAskTimeout()).resolves.toBeUndefined();
    await expect(noAgent.abandonOnStop()).resolves.toBe(false);
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
