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
import type { SessionEvent } from '@/agent/types.js';
import {
  createHarness,
  collectGen,
  textStream,
  mockProvider,
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

    const { chunks } = await collectGen(new SeedOrchestrator(deps).runChat('输入', new AbortController().signal));
    await new Promise((r) => setTimeout(r, 0));

    expect(mocks.roundSummaryGenerator.generate).not.toHaveBeenCalled();
    expect(chunks).not.toContainEqual(expect.objectContaining({ type: 'handoff' }));
  });

  it('runChat 回答中中断：不触发回答后与 handoff', async () => {
    const { mocks, deps, consumeControl } = createHarness();
    stubProcessUserInput(mocks, '');
    consumeControl.result = { content: '部分', aborted: true, failed: false };

    const { chunks } = await collectGen(new SeedOrchestrator(deps).runChat('输入', new AbortController().signal));
    await new Promise((r) => setTimeout(r, 0));

    expect(mocks.history.appendAssistant).toHaveBeenCalledWith(expect.stringContaining('部分'), expect.any(String));
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
      new SeedOrchestrator(deps).runEvent(chatEvent('事件输入'), '事件输入', new AbortController().signal),
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

    await collectGen(new SeedOrchestrator(deps).runEvent(chatEvent('输入'), '输入', new AbortController().signal));

    expect(mocks.loop.injectSystemMessage).not.toHaveBeenCalled();
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

  // ── runChat · 汇报闭环（阶段 2）────────────────────────
  it('runChat 复杂且收敛：触发汇报闭环 → 汇报追加历史 + 汇报单源摘要', async () => {
    const { mocks, deps, consumeControl } = createHarness({
      // 难度分级判定为复杂
      getBackgroundProvider: () => mockProvider('complex'),
    });
    stubProcessUserInput(mocks, '完成回复');
    consumeControl.result = { content: '完成回复', aborted: false, failed: false };
    // 收敛：存在已完成 plan 步骤
    mocks.sessionManager.getCheckpoint.mockReturnValue({ sessionId: 'sess', plan: [{ id: 's1', status: 'done' }] });
    // 汇报闭环返回文本流
    mocks.loop.runReport.mockReturnValue(textStream('【任务总结汇报】已完成核心步骤，结论为 X'));

    const { chunks } = await collectGen(new SeedOrchestrator(deps).runChat('输入', new AbortController().signal));
    await vi.waitFor(() => {
      expect(mocks.roundSummaryGenerator.generate).toHaveBeenCalledTimes(1);
    });

    // 触发了汇报闭环
    expect(mocks.loop.runReport).toHaveBeenCalledTimes(1);
    // 汇报追加进会话历史（含 roundId 溯源）
    expect(mocks.history.appendAssistant).toHaveBeenCalledWith(
      '【任务总结汇报】已完成核心步骤，结论为 X',
      'round-1',
    );
    // 汇报→摘要单源：generate 输入侧为空、输出侧为汇报文本
    expect(mocks.roundSummaryGenerator.generate).toHaveBeenCalledWith(
      '',
      '【任务总结汇报】已完成核心步骤，结论为 X',
      'round-1',
      '2026-08-20-main',
      undefined,
    );
    // 仍产出 handoff（wait）
    expect(chunks).toContainEqual({ type: 'handoff', decision: 'wait' });
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
    // 走普通回答后摘要（输入侧为用户输入，非空）
    expect(mocks.roundSummaryGenerator.generate).toHaveBeenCalledWith(
      '输入',
      '回复',
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
    mocks.sessionManager.getCheckpoint.mockReturnValue({ sessionId: 'sess', plan: [{ id: 's1', status: 'done' }] });

    await collectGen(new SeedOrchestrator(deps).runChat('简单问题', new AbortController().signal));
    await new Promise((r) => setTimeout(r, 0));

    expect(mocks.loop.runReport).not.toHaveBeenCalled();
  });
});