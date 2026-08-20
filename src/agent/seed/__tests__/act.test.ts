/**
 * 回答中（Act）独立单元测试
 *
 * 覆盖 SeedAct.run 统一尾处理（chat / processEvent / resume 三路径共用）：
 *   - 正常完成：追加助手消息（带 roundId 溯源）+ yield thinking/archiving
 *   - 执行失败（consumeExecutionStream failed）→ 返回 failed，不追加消息
 *   - 中断且已产出文本：追加「文本 + 中断标记」，返回 aborted
 *   - 中断且无产出文本：不追加消息，返回 aborted
 *   - 追加助手消息失败仅记日志，不向上抛
 */

import { describe, it, expect } from 'vitest';
import { SeedAct } from '@/agent/seed/act.js';
import { createHarness, collectGen, textStream } from './harness.js';

describe('SeedAct 回答中', () => {
  it('正常完成：追加助手消息（带 roundId）+ yield archiving + 返回结果', async () => {
    const { mocks, deps, consumeControl } = createHarness();
    // 注入流收口结果：正常完成
    consumeControl.result = { content: '完成回复', aborted: false, failed: false };

    const { chunks, result } = await collectGen(
      new SeedAct(deps).run(() => textStream('完成回复')),
    );

    expect(mocks.history.appendAssistant).toHaveBeenCalledWith('完成回复', 'round-1');
    expect(chunks).toContainEqual({ type: 'thinking', phase: 'archiving' });
    expect(result).toEqual({ content: '完成回复', aborted: false, failed: false });
  });

  it('roundId 取自 loop 当前轮（非入参，便于续跑路径复用）', async () => {
    const { mocks, deps, consumeControl } = createHarness();
    mocks.loop.getCurrentRoundId.mockReturnValue('round-paused');
    consumeControl.result = { content: '续跑', aborted: false, failed: false };

    await collectGen(new SeedAct(deps).run(() => textStream('续跑')));

    expect(mocks.history.appendAssistant).toHaveBeenCalledWith('续跑', 'round-paused');
  });

  it('执行失败：返回 failed=true，不追加助手消息、不 yield archiving', async () => {
    const { mocks, deps, consumeControl } = createHarness();
    consumeControl.result = { content: '', aborted: false, failed: true };

    const { chunks, result } = await collectGen(new SeedAct(deps).run(() => textStream('')));

    expect(result?.failed).toBe(true);
    expect(mocks.history.appendAssistant).not.toHaveBeenCalled();
    // failed 提前返回，不产出 archiving
    expect(chunks).not.toContainEqual({ type: 'thinking', phase: 'archiving' });
  });

  it('中断且已产出文本：追加「文本+中断标记」→ 返回 aborted，不 yield archiving', async () => {
    const { mocks, deps, consumeControl } = createHarness();
    consumeControl.result = { content: '部分回复', aborted: true, failed: false };

    const { chunks, result } = await collectGen(
      new SeedAct(deps).run(() => textStream('partial')),
    );

    expect(mocks.history.appendAssistant).toHaveBeenCalledWith('部分回复\n\n[已中断]', 'round-1');
    expect(result?.aborted).toBe(true);
    expect(chunks).not.toContainEqual({ type: 'thinking', phase: 'archiving' });
  });

  it('中断且无产出文本：不追加消息 → 返回 aborted', async () => {
    const { mocks, deps, consumeControl } = createHarness();
    consumeControl.result = { content: '   ', aborted: true, failed: false };

    await collectGen(new SeedAct(deps).run(() => textStream('')));

    expect(mocks.history.appendAssistant).not.toHaveBeenCalled();
  });

  it('用户自定义中断标记（messages.interrupted）优先于内置默认', async () => {
    const { deps, mocks, consumeControl } = createHarness({ messages: { interrupted: '[自定义中断]' } });
    consumeControl.result = { content: 'abc', aborted: true, failed: false };

    await collectGen(new SeedAct(deps).run(() => textStream('abc')));

    expect(mocks.history.appendAssistant).toHaveBeenCalledWith('abc[自定义中断]', 'round-1');
  });

  it('追加助手消息失败仅记日志，不向上抛（降级不阻断）', async () => {
    const { mocks, deps, consumeControl } = createHarness();
    mocks.history.appendAssistant.mockRejectedValueOnce(new Error('存储失败'));
    consumeControl.result = { content: '回复', aborted: false, failed: false };

    await expect(
      collectGen(new SeedAct(deps).run(() => textStream('回复'))),
    ).resolves.toMatchObject({ result: { content: '回复', aborted: false, failed: false } });
    // appendAssistant 抛错被内部 catch，测试中不可见（日志警告）
  });
});