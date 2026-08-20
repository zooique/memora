/**
 * 回答前（Prepare）独立单元测试
 *
 * 覆盖 SeedPrepare.run：
 *   - 默认策略装配（autoSwitch=on 触发角色匹配、上下文装配、L2 策略注入、工具暴露）
 *   - autoSwitch=off 锁定当前角色包（不触发自动匹配）
 *   - 会话粘性复位（会话切换时 resetSticky，同会话不重复）
 *   - 回答前中断（signal.aborted）→ 返回 aborted，跳过用户消息入史
 *   - roundId 生成 + appendUser 溯源 + 会话命名 fire-and-forget
 */

import { describe, it, expect } from 'vitest';
import { SeedPrepare } from '@/agent/seed/prepare.js';
import type { Memory } from '@/memory/types.js';
import {
  createHarness,
  collectGen,
  makeStrategy,
  useStrategy,
  type SeedMocks,
} from './harness.js';

/** 让召回桩返回若干记忆 */
function stubRecall(mocks: SeedMocks, memories: Memory[]): void {
  mocks.contextPreparer.recallAndInject.mockImplementation(async () => memories);
}

const rec = (id: string): Memory =>
  ({ id, content: `记忆${id}`, source: 'round-summary', score: 1, createdAt: '2026-08-20T00:00:00Z' }) as Memory;

describe('SeedPrepare 回答前', () => {
  it('默认策略：autoSwitch=on 触发角色匹配 → 装配上下文 → 注入 → 返回 recalledMemories', async () => {
    const { mocks, deps } = createHarness();
    stubRecall(mocks, [rec('a'), rec('b')]);

    const { chunks, result } = await collectGen(
      new SeedPrepare(deps).run('用户输入', new AbortController().signal),
    );

    // thinking 阶段提示（recalling → processing）
    expect(chunks).toEqual([
      { type: 'thinking', phase: 'recalling' },
      { type: 'thinking', phase: 'processing' },
    ]);

    // autoSwitch 默认 on → 触发角色自动匹配
    expect(mocks.contextPreparer.tryAutoMatchRolePack).toHaveBeenCalledWith('用户输入');
    // L2 策略注入 + 工具暴露面应用
    expect(mocks.loop.setStrategy).toHaveBeenCalledTimes(1);
    expect(mocks.applyRolePackToolExposure).toHaveBeenCalledTimes(1);
    // 记忆召回（默认 full + hybrid）
    expect(mocks.contextPreparer.recallAndInject).toHaveBeenCalledWith('用户输入', 'full', 'hybrid');
    // roundId 生成 + 用户消息入史（同 roundId 溯源）
    expect(mocks.loop.setCurrentRoundId).toHaveBeenCalledTimes(1);
    const roundId = mocks.loop.setCurrentRoundId.mock.calls[0]?.[0];
    expect(mocks.history.appendUser).toHaveBeenCalledWith('用户输入', roundId);
    // 会话命名 fire-and-forget
    expect(mocks.sessionNamer.ensureSessionTitle).toHaveBeenCalledWith('2026-08-20', 'main', '用户输入');

    // 返回召回记忆，未中断
    expect(result).toEqual({
      input: '用户输入',
      recalledMemories: [expect.objectContaining({ id: 'a' }), expect.objectContaining({ id: 'b' })],
      aborted: false,
    });
  });

  it('autoSwitch=off：锁定当前角色包，不触发角色自动匹配', async () => {
    const { mocks, deps } = createHarness();
    useStrategy(mocks, makeStrategy({ autoSwitch: 'off' }));

    await collectGen(new SeedPrepare(deps).run('输入', new AbortController().signal));

    expect(mocks.contextPreparer.tryAutoMatchRolePack).not.toHaveBeenCalled();
  });

  it('会话粘性复位：会话切换时 resetSticky，同会话不重复', async () => {
    const { mocks, deps } = createHarness();
    const prepare = new SeedPrepare(deps);

    // 会话 A 首次运行 → 复位粘性
    mocks.sessionManager.getCheckpoint.mockReturnValue({ sessionId: 'sess-A' });
    await collectGen(prepare.run('输入A', new AbortController().signal));
    expect(mocks.rolePackManager.resetSticky).toHaveBeenCalledTimes(1);

    // 同会话第二次 → 不复位
    await collectGen(prepare.run('输入A2', new AbortController().signal));
    expect(mocks.rolePackManager.resetSticky).toHaveBeenCalledTimes(1);

    // 会话 B → 再次复位
    mocks.sessionManager.getCheckpoint.mockReturnValue({ sessionId: 'sess-B' });
    await collectGen(prepare.run('输入B', new AbortController().signal));
    expect(mocks.rolePackManager.resetSticky).toHaveBeenCalledTimes(2);
  });

  it('回答前中断：signal.aborted → 返回 aborted，跳过技能注入与用户消息入史', async () => {
    const { mocks, deps } = createHarness();
    stubRecall(mocks, [rec('x')]);

    // 召回阶段前先中止 signal
    const ac = new AbortController();
    ac.abort();

    const { result } = await collectGen(new SeedPrepare(deps).run('输入', ac.signal));

    expect(result?.aborted).toBe(true);
    expect(result?.recalledMemories).toEqual([expect.objectContaining({ id: 'x' })]);
    // 中断后不再注入用户消息 / 不命名
    expect(mocks.loop.setCurrentRoundId).not.toHaveBeenCalled();
    expect(mocks.history.appendUser).not.toHaveBeenCalled();
    expect(mocks.sessionNamer.ensureSessionTitle).not.toHaveBeenCalled();
  });

  it('每次运行前清理临时 system 消息（技能 prompt 不跨轮累积）', async () => {
    const { mocks, deps } = createHarness();
    await collectGen(new SeedPrepare(deps).run('输入', new AbortController().signal));
    expect(mocks.loop.cleanTemporarySystemMessages).toHaveBeenCalledTimes(1);
  });

  it('无激活角色包时回退全局默认策略仍可正常完成', async () => {
    const { mocks, deps } = createHarness();
    // getActive 默认 null → 回退 DEFAULT_BEHAVIOR_STRATEGY
    const { result } = await collectGen(new SeedPrepare(deps).run('输入', new AbortController().signal));
    expect(result?.aborted).toBe(false);
    expect(mocks.loop.setStrategy).toHaveBeenCalledTimes(1);
  });
});