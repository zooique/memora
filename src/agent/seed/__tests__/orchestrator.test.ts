/**
 * 种子闭环编排器独立单元测试
 *
 * 覆盖 SeedOrchestrator（最小问答闭环唯一编排真理源，chat 路径默认组装）：
 *   - 完整闭环：prepare → act → reflect（fire-and-forget）→ handoff 的默认 sequence
 *   - 回答前中断 → yield aborted，不进回答中
 *   - 回答中失败 → 不触发回答后与 handoff
 *   - 回答中中断 → 不触发回答后与 handoff
 */

import { describe, it, expect, vi } from 'vitest';
import { SeedOrchestrator } from '@/agent/seed/index.js';
import {
  createHarness,
  collectGen,
  textStream,
  type SeedMocks,
} from './harness.js';

/** 让 loop.processUserInput 返回一个文本流（orchestrator 的 produce 入口） */
function stubProcessUserInput(mocks: SeedMocks, contentPart: string): void {
  mocks.loop.processUserInput.mockReturnValue(textStream(contentPart));
}

describe('SeedOrchestrator 最小问答闭环', () => {
  it('完整闭环：prepare → act → reflect → handoff 顺序产出', async () => {
    const { mocks, deps, consumeControl } = createHarness();
    stubProcessUserInput(mocks, '完成回复');
    consumeControl.result = { content: '完成回复', aborted: false, failed: false };

    const { chunks, result } = await collectGen(
      new SeedOrchestrator(deps).run('用户输入', new AbortController().signal),
    );
    // 等待 fire-and-forget 的 reflect 完成以断言摘要委托
    await vi.waitFor(() => {
      expect(mocks.roundSummaryGenerator.generate).toHaveBeenCalledTimes(1);
    });

    expect(result).toBeUndefined();
    // prepare 已跑（用户消息入史）
    expect(mocks.history.appendUser).toHaveBeenCalledWith('用户输入', expect.any(String));
    // act 已跑（助手消息入史）
    expect(mocks.history.appendAssistant).toHaveBeenCalledWith('完成回复', expect.any(String));
    // reflect 已委托摘要生成
    expect(mocks.roundSummaryGenerator.generate).toHaveBeenCalledTimes(1);
    // handoff 产出（默认 wait）
    expect(chunks).toContainEqual({ type: 'handoff', decision: 'wait', reason: undefined });
  });

  it('回答前中断：yield aborted，不进回答中', async () => {
    const ac = new AbortController();
    ac.abort();
    const { mocks, deps } = createHarness();

    const { chunks } = await collectGen(new SeedOrchestrator(deps).run('输入', ac.signal));

    expect(chunks).toContainEqual({
      type: 'aborted',
      reason: 'User cancelled the conversation',
    });
    // 不进入 act：不生成 roundId / 不入史 / 无助手消息
    expect(mocks.loop.setCurrentRoundId).not.toHaveBeenCalled();
    expect(mocks.history.appendUser).not.toHaveBeenCalled();
    expect(mocks.history.appendAssistant).not.toHaveBeenCalled();
  });

  it('回答中失败：不触发回答后与 handoff', async () => {
    const { mocks, deps, consumeControl } = createHarness();
    stubProcessUserInput(mocks, '');
    consumeControl.result = { content: '', aborted: false, failed: true };

    const { chunks } = await collectGen(
      new SeedOrchestrator(deps).run('输入', new AbortController().signal),
    );
    // 等待微任务，确认 fire-and-forget 的 reflect 未触发
    await new Promise((r) => setTimeout(r, 0));

    expect(mocks.roundSummaryGenerator.generate).not.toHaveBeenCalled();
    expect(chunks).not.toContainEqual(expect.objectContaining({ type: 'handoff' }));
  });

  it('回答中中断：不触发回答后与 handoff', async () => {
    const { mocks, deps, consumeControl } = createHarness();
    stubProcessUserInput(mocks, '');
    consumeControl.result = { content: '部分', aborted: true, failed: false };

    const { chunks } = await collectGen(
      new SeedOrchestrator(deps).run('输入', new AbortController().signal),
    );
    await new Promise((r) => setTimeout(r, 0));

    // 中断时追加「文本+标记」，但不改走回答后
    expect(mocks.history.appendAssistant).toHaveBeenCalledWith(expect.stringContaining('部分'), expect.any(String));
    expect(mocks.roundSummaryGenerator.generate).not.toHaveBeenCalled();
    expect(chunks).not.toContainEqual(expect.objectContaining({ type: 'handoff' }));
  });
});