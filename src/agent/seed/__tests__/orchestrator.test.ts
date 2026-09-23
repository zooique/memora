/**
 * 种子 turn 编排器独立单元测试
 *
 * 覆盖 SeedOrchestrator（最小 turn 唯一编排真理源）的显式命名入口：
 *   - runChat：完整 turn prepare → act(processUserInput) → reflect
 *   - runResume：act(continueAfterPause) → reflect（无回答前）
 * 注：原 runEvent（SessionEvent 结构化事件路径）已随 composer 剪枝移除。
 *
 * 入口共用短路语义：回答前中断 yield aborted；回答中失败/中断不触发回答后。
 */

import { describe, it, expect, vi } from 'vitest';
import { SeedOrchestrator } from '@/agent/seed/index.js';
import {
  createHarness,
  collectGen,
  textStream,
  makeStrategy,
  useStrategy,
  type SeedMocks,
} from './harness.js';

/** 让 loop.processUserInput 返回一个文本流（runChat 的 produce 入口） */
function stubProcessUserInput(mocks: SeedMocks, contentPart: string): void {
  mocks.loop.processUserInput.mockReturnValue(textStream(contentPart));
}

/** 让 loop.continueAfterPause 返回一个文本流（runResume 的 produce 入口） */
function stubContinue(mocks: SeedMocks, contentPart: string): void {
  mocks.loop.continueAfterPause.mockReturnValue(textStream(contentPart));
}

describe('SeedOrchestrator 最小 turn', () => {
  // ── runChat ────────────────────────────────────────────
  it('runChat 完整 turn：prepare → act → reflect 顺序产出', async () => {
    const { mocks, deps, consumeControl } = createHarness();
    stubProcessUserInput(mocks, '完成回复');
    consumeControl.result = { content: '完成回复', aborted: false, paused: false, failed: false };

    await collectGen(
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
  });

  it('reflect 守卫：reflect.summary=off 时跳过摘要生成（不沉淀）', async () => {
    const { mocks, deps, consumeControl } = createHarness();
    stubProcessUserInput(mocks, '完成回复');
    consumeControl.result = { content: '完成回复', aborted: false, paused: false, failed: false };
    // summary=off → runSummary 门控跳过（一次性对话不沉淀）
    useStrategy(mocks, makeStrategy({ summary: 'off' }));

    await collectGen(new SeedOrchestrator(deps).runChat('用户输入', new AbortController().signal));
    await new Promise((r) => setTimeout(r, 0));

    // 摘要生成不被调用（reflect 门控生效）
    expect(mocks.roundSummaryGenerator.generate).not.toHaveBeenCalled();
    // 其余闭环仍完整：act 入史
    expect(mocks.history.appendAssistant).toHaveBeenCalledWith('完成回复', expect.any(String));
  });

  it('reflect 守卫：prepare.summaryFocus 透传给摘要生成（提炼视角注入）', async () => {
    const { mocks, deps, consumeControl } = createHarness();
    stubProcessUserInput(mocks, '完成回复');
    consumeControl.result = { content: '完成回复', aborted: false, paused: false, failed: false };
    const focus = '聚焦代码结构与 diff 变更';
    useStrategy(mocks, makeStrategy({ summaryFocus: focus }));

    await collectGen(new SeedOrchestrator(deps).runChat('用户输入', new AbortController().signal));
    await vi.waitFor(() => expect(mocks.roundSummaryGenerator.generate).toHaveBeenCalledTimes(1));

    // 第五参 = 角色包提炼视角（透传非 undefined）
    expect(mocks.roundSummaryGenerator.generate).toHaveBeenCalledWith(
      '用户输入',
      '完成回复',
      expect.any(String),
      expect.any(String),
      focus,
    );
  });

  it('runChat 回答前中断：yield aborted，不进回答中', async () => {
    const ac = new AbortController();
    ac.abort();
    const { mocks, deps } = createHarness();

    const { chunks } = await collectGen(new SeedOrchestrator(deps).runChat('输入', ac.signal));

    // TS-12a：aborted chunk 带 stopReason:'user'（stopReason 为可选字段，用 toMatchObject 兼容）
    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: 'aborted',
        reason: 'User cancelled the conversation',
        stopReason: 'user',
      }),
    );
    expect(mocks.loop.setCurrentRoundId).not.toHaveBeenCalled();
    expect(mocks.history.appendUser).not.toHaveBeenCalled();
    expect(mocks.history.appendAssistant).not.toHaveBeenCalled();
  });

  it('runChat 回答中失败：不触发回答后，且与中断同收口（appendInterrupted）', async () => {
    const { mocks, deps, consumeControl } = createHarness();
    stubProcessUserInput(mocks, '');
    consumeControl.result = { content: '半截产出', aborted: false, paused: false, failed: true };

    await collectGen(new SeedOrchestrator(deps).runChat('输入', new AbortController().signal));
    await new Promise((r) => setTimeout(r, 0));

    expect(mocks.roundSummaryGenerator.generate).not.toHaveBeenCalled();
    // 非正常收场统一收口（SSOT，2026-09-15）：failed 与 aborted 共用 appendInterrupted。
    // 修复前此处直接 `return streamResult`，轮停在 pending + refCount=0，运行期无人收尾
    // → 孤儿轮（宿主须等下次重启才由 upgradeInterruptedRounds 打捞）。
    expect(mocks.history.appendInterrupted).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ content: '半截产出' }),
    );
    expect(mocks.history.appendAssistant).not.toHaveBeenCalled();
  });

  it('runChat 回答中无产出即失败：仍按 stop 语义收场（真实故障轮形态）', async () => {
    const { mocks, deps, consumeControl } = createHarness();
    stubProcessUserInput(mocks, '');
    // 真实故障轮形态：LLM 4xx 中断在纯工具阶段，content 为空（narrate 不计入 content）
    consumeControl.result = { content: '', aborted: false, paused: false, failed: true };

    await collectGen(new SeedOrchestrator(deps).runChat('输入', new AbortController().signal));
    await new Promise((r) => setTimeout(r, 0));

    // 无产出也必须登记收场（appendAssistant 会跳过空内容，故必须走 appendInterrupted）
    expect(mocks.history.appendInterrupted).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ content: '' }),
    );
  });

  it('runChat 回答中中断：不触发回答后', async () => {
    const { mocks, deps, consumeControl } = createHarness();
    stubProcessUserInput(mocks, '');
    consumeControl.result = { content: '部分', aborted: true, paused: false, failed: false };

    await collectGen(new SeedOrchestrator(deps).runChat('输入', new AbortController().signal));
    await new Promise((r) => setTimeout(r, 0));

    // 非正常收场统一收口（SSOT，2026-09-15）：中断也改走 appendInterrupted（原为 appendAssistant）
    expect(mocks.history.appendInterrupted).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ content: '部分' }),
    );
    expect(mocks.history.appendAssistant).not.toHaveBeenCalled();
    expect(mocks.roundSummaryGenerator.generate).not.toHaveBeenCalled();
  });

  it('runChat 回答中软暂停（paused）：问题全文入史但不产摘要（摘要 1:1）', async () => {
    const { mocks, deps, consumeControl } = createHarness();
    stubProcessUserInput(mocks, '');
    // 主动提问挂起：streamResult.paused=true，本轮回合未完成
    consumeControl.result = { content: '这个颜色你喜欢吗？', aborted: false, paused: true, failed: false };

    const { chunks } = await collectGen(
      new SeedOrchestrator(deps).runChat('输入', new AbortController().signal),
    );
    await new Promise((r) => setTimeout(r, 0));

    // 暂停轮问题全文仍入史（供续跑上下文完整），但不触发归档指示
    expect(mocks.history.appendAssistant).toHaveBeenCalledWith(
      '这个颜色你喜欢吗？',
      expect.any(String),
    );
    expect(chunks).not.toContainEqual({ type: 'thinking', phase: 'archiving' });
    // 摘要推迟到续跑最终轮：本轮不产摘要
    expect(mocks.roundSummaryGenerator.generate).not.toHaveBeenCalled();
  });

  // ── runResume ───────────────────────────────────────────
  it('runResume：act(continueAfterPause) → reflect；无回答前', async () => {
    const { mocks, deps, consumeControl } = createHarness();
    stubContinue(mocks, '续跑回复');
    consumeControl.result = { content: '续跑回复', aborted: false, paused: false, failed: false };

    await collectGen(new SeedOrchestrator(deps).runResume(undefined, new AbortController().signal));
    await vi.waitFor(() => expect(mocks.roundSummaryGenerator.generate).toHaveBeenCalledTimes(1));

    // 不重新装配上下文（无 prepare）：不加用户消息、不生成 roundId
    expect(mocks.history.appendUser).not.toHaveBeenCalled();
    expect(mocks.loop.setCurrentRoundId).not.toHaveBeenCalled();
    // act 驱动 continueAfterPause + 追加助手消息
    expect(mocks.loop.continueAfterPause).toHaveBeenCalledTimes(1);
    expect(mocks.history.appendAssistant).toHaveBeenCalledWith('续跑回复', expect.any(String));
    // reflect 走摘要
    expect(mocks.roundSummaryGenerator.generate).toHaveBeenCalledTimes(1);
  });

  // ── 形态② 兜底收尾（PLAN-SYNC-1 ①，2026-09-17）────────────────────────
  it('runChat 正常完成：act 触发「LLM 未显式 update 即收尾」兜底（摘要前 200 字作 planItemLog 摘要）', async () => {
    const { mocks, deps, consumeControl } = createHarness();
    stubProcessUserInput(mocks, '完成回复');
    consumeControl.result = { content: '完成回复', aborted: false, paused: false, failed: false };

    await collectGen(new SeedOrchestrator(deps).runChat('输入', new AbortController().signal));
    await new Promise((r) => setTimeout(r, 0));

    // 正常收尾分支调用兜底（与助手消息入史同一路径）
    expect(mocks.sessionManager.concludeActivePlanItemIfPlanFullyReached).toHaveBeenCalledTimes(1);
    expect(mocks.sessionManager.concludeActivePlanItemIfPlanFullyReached).toHaveBeenCalledWith(
      '完成回复'.slice(0, 200),
    );
  });

  it('runChat 暂停轮：不触发兜底（现场保留供续跑）', async () => {
    const { mocks, deps, consumeControl } = createHarness();
    stubProcessUserInput(mocks, '问题？');
    consumeControl.result = { content: '问题？', aborted: false, paused: true, failed: false };

    await collectGen(new SeedOrchestrator(deps).runChat('输入', new AbortController().signal));
    await new Promise((r) => setTimeout(r, 0));

    expect(mocks.sessionManager.concludeActivePlanItemIfPlanFullyReached).not.toHaveBeenCalled();
  });

  it('runChat 中断/失败轮：不触发兜底（与 appendInterrupted 同路径提前返回）', async () => {
    const { mocks, deps, consumeControl } = createHarness();
    stubProcessUserInput(mocks, '半截');
    consumeControl.result = { content: '半截', aborted: true, paused: false, failed: false };

    await collectGen(new SeedOrchestrator(deps).runChat('输入', new AbortController().signal));
    await new Promise((r) => setTimeout(r, 0));

    expect(mocks.sessionManager.concludeActivePlanItemIfPlanFullyReached).not.toHaveBeenCalled();
  });
});
