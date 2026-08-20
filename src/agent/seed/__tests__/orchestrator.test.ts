/**
 * 种子闭环编排器独立单元测试
 *
 * 覆盖 SeedOrchestrator（最小问答闭环唯一编排真理源）的三个显式命名入口：
 *   - runChat：完整闭环 prepare → act(processUserInput) → reflect → handoff
 *   - runEvent：prepare → 任务表预判注入 → act(processEvent) → reflect → handoff
 *   - runResume：act(continueAfterPause) → reflect（无回答前、无 Handoff）
 *
 * 三入口共用短路语义：回答前中断 yield aborted；回答中失败/中断不触发回答后与 handoff。
 */

import { describe, it, expect, vi } from 'vitest';
import { SeedOrchestrator } from '@/agent/seed/index.js';
import { LOOP_CONSTANTS } from '@/agent/constants.js';
import type { SessionEvent } from '@/agent/types.js';
import {
  createHarness,
  collectGen,
  textStream,
  mockProvider,
  makeStrategy,
  useStrategy,
  type SeedMocks,
} from './harness.js';

/** 让 loop.processUserInput 返回一个文本流（runChat 的 produce 入口） */
function stubProcessUserInput(mocks: SeedMocks, contentPart: string): void {
  mocks.loop.processUserInput.mockReturnValue(textStream(contentPart));
}

/** 让 loop.processEvent 返回一个文本流（runEvent 的 produce 入口） */
function stubProcessEvent(mocks: SeedMocks, contentPart: string): void {
  mocks.loop.processEvent.mockReturnValue(textStream(contentPart));
}

/** 让 loop.continueAfterPause 返回一个文本流（runResume 的 produce 入口） */
function stubContinue(mocks: SeedMocks, contentPart: string): void {
  mocks.loop.continueAfterPause.mockReturnValue(textStream(contentPart));
}

/** 构造最小 chat 语义 SessionEvent */
function chatEvent(content: string): SessionEvent {
  return { type: 'chat', content, delta: {} } as SessionEvent;
}

describe('SeedOrchestrator 最小问答闭环', () => {
  // ── runChat ────────────────────────────────────────────
  it('runChat 完整闭环：prepare → act → reflect → handoff 顺序产出', async () => {
    const { mocks, deps, consumeControl } = createHarness();
    stubProcessUserInput(mocks, '完成回复');
    consumeControl.result = { content: '完成回复', aborted: false, failed: false };

    const { chunks } = await collectGen(
      new SeedOrchestrator(deps).runChat('用户输入', new AbortController().signal),
    );
    await vi.waitFor(() => {
      expect(mocks.roundSummaryGenerator.generate).toHaveBeenCalledTimes(1);
    });

    // prepare 已跑（用户消息入史）
    expect(mocks.history.appendUser).toHaveBeenCalledWith('用户输入', expect.any(String));
    // act 已跑（助手消息入史）
    expect(mocks.history.appendAssistant).toHaveBeenCalledWith('完成回复', expect.any(String));
    // reflect 已委托摘要生成
    expect(mocks.roundSummaryGenerator.generate).toHaveBeenCalledTimes(1);
    // handoff 产出（默认 wait）
    expect(chunks).toContainEqual({ type: 'handoff', decision: 'wait', reason: undefined });
  });

  it('runChat 回答前中断：yield aborted，不进回答中', async () => {
    const ac = new AbortController();
    ac.abort();
    const { mocks, deps } = createHarness();

    const { chunks } = await collectGen(new SeedOrchestrator(deps).runChat('输入', ac.signal));

    expect(chunks).toContainEqual({
      type: 'aborted',
      reason: 'User cancelled the conversation',
    });
    expect(mocks.loop.setCurrentRoundId).not.toHaveBeenCalled();
    expect(mocks.history.appendUser).not.toHaveBeenCalled();
    expect(mocks.history.appendAssistant).not.toHaveBeenCalled();
  });

  it('runChat 回答中失败：不触发回答后与 handoff', async () => {
    const { mocks, deps, consumeControl } = createHarness();
    stubProcessUserInput(mocks, '');
    consumeControl.result = { content: '', aborted: false, failed: true };

    const { chunks } = await collectGen(
      new SeedOrchestrator(deps).runChat('输入', new AbortController().signal),
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(mocks.roundSummaryGenerator.generate).not.toHaveBeenCalled();
    expect(chunks).not.toContainEqual(expect.objectContaining({ type: 'handoff' }));
  });

  it('runChat 回答中中断：不触发回答后与 handoff', async () => {
    const { mocks, deps, consumeControl } = createHarness();
    stubProcessUserInput(mocks, '');
    consumeControl.result = { content: '部分', aborted: true, failed: false };

    const { chunks } = await collectGen(
      new SeedOrchestrator(deps).runChat('输入', new AbortController().signal),
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(mocks.history.appendAssistant).toHaveBeenCalledWith(
      expect.stringContaining('部分'),
      expect.any(String),
    );
    expect(mocks.roundSummaryGenerator.generate).not.toHaveBeenCalled();
    expect(chunks).not.toContainEqual(expect.objectContaining({ type: 'handoff' }));
  });

  // ── runEvent ────────────────────────────────────────────
  it('runEvent 应生成任务表：shouldGenerateTaskTable 命中 → 注入 TASK_TABLE_HINT', async () => {
    const { mocks, deps, consumeControl } = createHarness();
    stubProcessEvent(mocks, '事件回复');
    consumeControl.result = { content: '事件回复', aborted: false, failed: false };
    mocks.checkpointRestoreCoordinator.shouldGenerateTaskTable.mockReturnValue(true);

    const { chunks } = await collectGen(
      new SeedOrchestrator(deps).runEvent(
        chatEvent('事件输入'),
        '事件输入',
        new AbortController().signal,
      ),
    );
    await vi.waitFor(() => expect(mocks.roundSummaryGenerator.generate).toHaveBeenCalledTimes(1));

    // 任务表提示已注入 loop
    expect(mocks.loop.injectSystemMessage).toHaveBeenCalledWith(
      expect.stringContaining('task_table_write'),
    );
    // 驱动 loop.processEvent（非 processUserInput）
    expect(mocks.loop.processEvent).toHaveBeenCalledTimes(1);
    // prepare（appendUser）+ act（appendAssistant）+ handoff 都走
    expect(mocks.history.appendUser).toHaveBeenCalledWith('事件输入', expect.any(String));
    expect(mocks.history.appendAssistant).toHaveBeenCalledWith('事件回复', expect.any(String));
    expect(chunks).toContainEqual({ type: 'handoff', decision: 'wait' });
  });

  it('runEvent 不生成任务表：shouldGenerateTaskTable 未命中 → 不注入', async () => {
    const { mocks, deps, consumeControl } = createHarness();
    stubProcessEvent(mocks, '回复');
    consumeControl.result = { content: '回复', aborted: false, failed: false };
    // 默认 shouldGenerateTaskTable 返回 false

    await collectGen(
      new SeedOrchestrator(deps).runEvent(chatEvent('输入'), '输入', new AbortController().signal),
    );

    expect(mocks.loop.injectSystemMessage).not.toHaveBeenCalled();
  });

  it('runEvent 复杂且收敛：settle 走汇报闭环，摘要挂 head（阶段 2 溯源）', async () => {
    const { mocks, deps, consumeControl } = createHarness({
      // 难度分级判定为复杂
      getBackgroundProvider: () => mockProvider('complex'),
    });
    stubProcessEvent(mocks, '事件回复');
    consumeControl.result = { content: '事件回复', aborted: false, failed: false };
    // 已收敛：plan 含 done 步骤 → settle 触发汇报
    mocks.sessionManager.getCheckpoint.mockReturnValue({
      sessionId: 'sess',
      plan: [{ id: 's1', status: 'done', description: '步骤一' }],
    });
    mocks.loop.runReport.mockReturnValue(textStream('【阶段2汇报】已收敛，结论 Y'));

    await collectGen(
      new SeedOrchestrator(deps).runEvent(
        chatEvent('事件输入'),
        '事件输入',
        new AbortController().signal,
      ),
    );
    await vi.waitFor(() => expect(mocks.roundSummaryGenerator.generate).toHaveBeenCalledTimes(1));

    // settle 走汇报闭环；汇报单源摘要（输入侧为空）
    expect(mocks.loop.runReport).toHaveBeenCalledTimes(1);
    expect(mocks.roundSummaryGenerator.generate).toHaveBeenCalledWith(
      '',
      '【阶段2汇报】已收敛，结论 Y',
      expect.any(String),
      expect.any(String),
      undefined,
    );
    // 阶段 2 head 溯源：事件路径无步闭环覆盖 roundId，getCurrentRoundId() = prepare 分配值 = appendUser 同 id
    expect(mocks.roundSummaryGenerator.generate.mock.calls[0]![2]).toBe(
      mocks.history.appendUser.mock.calls[0]![1],
    );
  });

  it('runEvent 复杂收敛但汇报为空：回退主回答普通摘要，仍恒 1 条', async () => {
    const { mocks, deps, consumeControl } = createHarness({
      getBackgroundProvider: () => mockProvider('complex'),
    });
    stubProcessEvent(mocks, '事件回复');
    consumeControl.result = { content: '事件回复', aborted: false, failed: false };
    mocks.sessionManager.getCheckpoint.mockReturnValue({
      sessionId: 'sess',
      plan: [{ id: 's1', status: 'done', description: '步骤一' }],
    });
    // 汇报闭环返回空流（LLM 未产出真实收尾）
    mocks.loop.runReport.mockImplementation(function* () {});

    await collectGen(
      new SeedOrchestrator(deps).runEvent(
        chatEvent('事件输入'),
        '事件输入',
        new AbortController().signal,
      ),
    );
    await vi.waitFor(() => expect(mocks.roundSummaryGenerator.generate).toHaveBeenCalledTimes(1));

    // 无实质收尾 → 回退主回答普通摘要（阶段 2 同样恒 1:1）
    expect(mocks.loop.runReport).toHaveBeenCalledTimes(1);
    expect(mocks.roundSummaryGenerator.generate).toHaveBeenCalledWith(
      '事件输入', // 输入侧：event 输入（fallbackInput）
      '事件回复', // 输出侧：主回答（fallbackContent）
      expect.any(String),
      expect.any(String),
      undefined,
    );
  });

  // ── runResume ───────────────────────────────────────────
  it('runResume：act(continueAfterPause) → reflect；无回答前、无 Handoff', async () => {
    const { mocks, deps, consumeControl } = createHarness();
    stubContinue(mocks, '续跑回复');
    consumeControl.result = { content: '续跑回复', aborted: false, failed: false };

    const { chunks } = await collectGen(
      new SeedOrchestrator(deps).runResume(undefined, new AbortController().signal),
    );
    await vi.waitFor(() => expect(mocks.roundSummaryGenerator.generate).toHaveBeenCalledTimes(1));

    // 不重新装配上下文（无 prepare）：不加用户消息、不生成 roundId
    expect(mocks.history.appendUser).not.toHaveBeenCalled();
    expect(mocks.loop.setCurrentRoundId).not.toHaveBeenCalled();
    // act 驱动 continueAfterPause + 追加助手消息
    expect(mocks.loop.continueAfterPause).toHaveBeenCalledTimes(1);
    expect(mocks.history.appendAssistant).toHaveBeenCalledWith('续跑回复', expect.any(String));
    // reflect 走摘要
    expect(mocks.roundSummaryGenerator.generate).toHaveBeenCalledTimes(1);
    // 无 Handoff
    expect(chunks).not.toContainEqual(expect.objectContaining({ type: 'handoff' }));
  });

  // ── runChat · 外部任务驱动外循环（阶段 3）────────────────
  it('runChat 复杂且启用外部循环：规划闭环 → 每步独立闭环（独立 roundId）→ 收敛后汇报', async () => {
    const { mocks, deps, consumeControl } = createHarness({
      // 难度分级判定为复杂
      getBackgroundProvider: () => mockProvider('complex'),
    });
    // 可变任务表：2 个 pending 步骤（步闭环执行后陆续标记 done）
    const plan: Array<{ id: string; status: string; description: string }> = [
      { id: 's1', status: 'pending', description: '步骤一' },
      { id: 's2', status: 'pending', description: '步骤二' },
    ];
    mocks.sessionManager.getCheckpoint.mockImplementation(() => ({ sessionId: 'sess', plan }));
    consumeControl.result = { content: '答', aborted: false, failed: false };
    // 汇报闭环返回文本流
    mocks.loop.runReport.mockReturnValue(textStream('【任务总结汇报】已完成，结论 X'));

    // processUserInput 驱动：规划闭环（用户输入）只建表；步闭环（含 stepPrompt）处理一个 pending 并标记 done
    mocks.loop.processUserInput.mockImplementation(function* (input: string) {
      if (typeof input === 'string' && input.includes('执行任务步骤')) {
        const step = plan[plan.findIndex((s) => s.status === 'pending')];
        if (step) step.status = 'done';
      }
      yield { type: 'text', content: '答' };
    });

    const { chunks } = await collectGen(
      new SeedOrchestrator(deps).runChat('复杂任务', new AbortController().signal),
    );
    await vi.waitFor(() => {
      // 摘要 1:1：规划/每步不产摘要，仅收尾汇报产出唯一 1 条（单源，见 §2.5）
      expect(mocks.roundSummaryGenerator.generate).toHaveBeenCalledTimes(1);
    });

    // 规划闭环 + 2 个步闭环 = processUserInput 共 3 次
    expect(mocks.loop.processUserInput).toHaveBeenCalledTimes(3);
    // 收敛后触发汇报闭环；汇报追加进会话历史（含 roundId 溯源）
    expect(mocks.loop.runReport).toHaveBeenCalledTimes(1);
    expect(mocks.history.appendAssistant).toHaveBeenCalledWith(
      '【任务总结汇报】已完成，结论 X',
      expect.any(String),
    );
    // 汇报→摘要单源：generate 输入侧为空、输出侧为汇报文本
    expect(mocks.roundSummaryGenerator.generate).toHaveBeenCalledWith(
      '',
      '【任务总结汇报】已完成，结论 X',
      expect.any(String),
      expect.any(String),
      undefined,
    );
    // 组合 head 溯源：收尾回指后，round-summary 挂 head（=prepare 分配、appendUser 同一 roundId），
    // 而非"最后一步"——保证 round-summary 锚定"这次外部输入"（见 memory-as-summary §2.5）
    const headRoundId = mocks.history.appendUser.mock.calls[0]![1];
    expect(mocks.roundSummaryGenerator.generate.mock.calls[0]![2]).toBe(headRoundId);
    // 汇报文本同样挂 head（与摘要、用户消息同 roundId，组合内溯源一致）
    expect(mocks.history.appendAssistant.mock.calls.at(-1)?.[1]).toBe(headRoundId);
    // 每个步闭环独立 roundId 由 processUserInput 自生成（未传 roundId，mock 不覆盖 currentRoundId）。
    // 故 setCurrentRoundId 仅 prepare 1 次 + 收尾回指 head 1 次 = 2 次（Q4：allocRoundId 冗余已删除）
    expect(mocks.loop.setCurrentRoundId).toHaveBeenCalledTimes(2);
    // 步间临时 system 回收：清理职责已收敛（单一真理源）。
    // orchestrator 层现只剩 prepare 入口 + 规划后（PLAN_ONLY）两处显式调用；
    // 步前/收尾前的执行期临时（self-review/reflection）改由 loop.processUserInput/runReport
    // 入口自动清理（cleanExecutionTemporary），属 loop 内部职责，不在本 mock 断言范围。
    const cleanCount = mocks.loop.cleanTemporarySystemMessages.mock.calls.length;
    // prepare 入口 1 次 + 规划后（PLAN_ONLY）1 次 = 2 次
    expect(cleanCount).toBe(2);
    // 仍产出 handoff（wait）
    expect(chunks).toContainEqual({ type: 'handoff', decision: 'wait' });
  });

  it('runChat 收敛但汇报为空：回退规划产出普通摘要，仍恒产 1 条', async () => {
    const { mocks, deps, consumeControl } = createHarness({
      getBackgroundProvider: () => mockProvider('complex'),
    });
    // 唯一步骤已 done → 无 pending → 步循环空 → isConverged()=true → 走汇报
    mocks.sessionManager.getCheckpoint.mockReturnValue({
      sessionId: 'sess',
      plan: [{ id: 's1', status: 'done', description: '步骤一' }],
    });
    stubProcessUserInput(mocks, '规划内容');
    consumeControl.result = { content: '规划内容', aborted: false, failed: false };
    // 汇报闭环返回空流（LLM 未产出真实收尾内容）
    mocks.loop.runReport.mockImplementation(function* () {});

    await collectGen(new SeedOrchestrator(deps).runChat('复杂任务', new AbortController().signal));
    await vi.waitFor(() => {
      expect(mocks.roundSummaryGenerator.generate).toHaveBeenCalledTimes(1);
    });

    // 汇报为空 → 不把空内容当汇报写史，回退规划产出走普通单条摘要（与"未收敛"同一真理源）
    expect(mocks.loop.runReport).toHaveBeenCalledTimes(1);
    expect(mocks.roundSummaryGenerator.generate).toHaveBeenCalledWith(
      '复杂任务', // 输入侧：用户输入（fallbackInput）
      '规划内容', // 输出侧：规划产出（fallbackContent）
      expect.any(String),
      expect.any(String),
      undefined,
    );
  });

  it('runChat 收敛但汇报仅 token 预算占位：视为无实质收尾，回退普通摘要', async () => {
    const { mocks, deps, consumeControl } = createHarness({
      getBackgroundProvider: () => mockProvider('complex'),
    });
    mocks.sessionManager.getCheckpoint.mockReturnValue({
      sessionId: 'sess',
      plan: [{ id: 's1', status: 'done', description: '步骤一' }],
    });
    stubProcessUserInput(mocks, '规划内容');
    consumeControl.result = { content: '规划内容', aborted: false, failed: false };
    // 汇报仅返回 token 预算占位文本 -> 视作未产出真实收尾
    mocks.loop.runReport.mockReturnValue(
      textStream(`\n\n${LOOP_CONSTANTS.TOKEN_BUDGET_REACHED_PLACEHOLDER}`),
    );

    await collectGen(new SeedOrchestrator(deps).runChat('复杂任务', new AbortController().signal));
    await vi.waitFor(() => {
      expect(mocks.roundSummaryGenerator.generate).toHaveBeenCalledTimes(1);
    });

    expect(mocks.loop.runReport).toHaveBeenCalledTimes(1);
    expect(mocks.roundSummaryGenerator.generate).toHaveBeenCalledWith(
      '复杂任务',
      '规划内容',
      expect.any(String),
      expect.any(String),
      undefined,
    );
  });

  it('runChat 复杂但未收敛（无已完成 plan 步骤）：不触发汇报，走普通摘要', async () => {
    const { mocks, deps, consumeControl } = createHarness({
      getBackgroundProvider: () => mockProvider('complex'),
    });
    stubProcessUserInput(mocks, '回复');
    consumeControl.result = { content: '回复', aborted: false, failed: false };
    // 未收敛：plan 为空或全 pending
    mocks.sessionManager.getCheckpoint.mockReturnValue({ sessionId: 'sess', plan: [] });

    await collectGen(new SeedOrchestrator(deps).runChat('输入', new AbortController().signal));
    await new Promise((r) => setTimeout(r, 0));

    expect(mocks.loop.runReport).not.toHaveBeenCalled();
    // 走普通回答后摘要（输入侧为用户输入，非空）；未收敛分支同样挂 head（=appendUser 同 roundId）
    expect(mocks.roundSummaryGenerator.generate).toHaveBeenCalledWith(
      '输入',
      '回复',
      expect.any(String),
      expect.any(String),
      undefined,
    );
    expect(mocks.roundSummaryGenerator.generate.mock.calls[0]![2]).toBe(
      mocks.history.appendUser.mock.calls[0]![1],
    );
  });

  it('runChat 复杂但 taskLoopLimit=0（关闭外循环）：走单闭环，不触发规划/步闭环/汇报', async () => {
    const { mocks, deps, consumeControl } = createHarness({
      getBackgroundProvider: () => mockProvider('complex'),
    });
    // 显式关闭外部任务循环（0=关闭，见 role-pack-spec global.taskLoopLimit）
    useStrategy(mocks, makeStrategy({ taskLoopLimit: 0 }));
    stubProcessUserInput(mocks, '直接答');
    consumeControl.result = { content: '直接答', aborted: false, failed: false };
    // 即使有已完成 plan 步骤，也不应进入外循环
    mocks.sessionManager.getCheckpoint.mockReturnValue({
      sessionId: 'sess',
      plan: [{ id: 's1', status: 'done' }],
    });

    await collectGen(new SeedOrchestrator(deps).runChat('复杂任务', new AbortController().signal));
    await new Promise((r) => setTimeout(r, 0));

    // 关闭外循环 → 不注入 PLAN_ONLY、不汇报、不 runReport；走单闭环答后摘要
    expect(mocks.loop.injectSystemMessage).not.toHaveBeenCalledWith(
      expect.stringContaining('暂时不要执行任何步骤'),
    );
    expect(mocks.loop.runReport).not.toHaveBeenCalled();
    expect(mocks.roundSummaryGenerator.generate).toHaveBeenCalledWith(
      '复杂任务',
      '直接答',
      expect.any(String),
      expect.any(String),
      undefined,
    );
  });

  it('runChat 简单：不触发汇报，即使有已完成 plan 步骤', async () => {
    const { mocks, deps, consumeControl } = createHarness({
      getBackgroundProvider: () => mockProvider('simple'),
    });
    stubProcessUserInput(mocks, '直接答');
    consumeControl.result = { content: '直接答', aborted: false, failed: false };
    mocks.sessionManager.getCheckpoint.mockReturnValue({
      sessionId: 'sess',
      plan: [{ id: 's1', status: 'done' }],
    });

    await collectGen(new SeedOrchestrator(deps).runChat('简单问题', new AbortController().signal));
    await new Promise((r) => setTimeout(r, 0));

    expect(mocks.loop.runReport).not.toHaveBeenCalled();
  });
});
