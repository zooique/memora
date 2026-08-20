/**
 * Handoff（衔接决策）独立单元测试
 *
 * 覆盖 SeedHandoff.run 对当前激活策略的衔接决策归位：
 *   - wait（默认）→ decision wait，reason undefined（对话等待）
 *   - loop → decision loop，reason 'L2 策略自动衔接'
 *   - end → decision end，reason 'L2 策略自动衔接'
 */

import { describe, it, expect } from 'vitest';
import { SeedHandoff } from '@/agent/seed/handoff.js';
import { createHarness, collectGen, makeStrategy, useStrategy } from './harness.js';

describe('SeedHandoff 衔接决策', () => {
  it('默认（无激活角色包 → wait）：dialogue wait 无原因', async () => {
    const { deps } = createHarness();
    const { chunks } = await collectGen(new SeedHandoff(deps).run());
    expect(chunks).toEqual([{ type: 'handoff', decision: 'wait', reason: undefined }]);
  });

  it('reflect.handoff=loop：自动续跑，reason 标注', async () => {
    const { mocks, deps } = createHarness();
    useStrategy(mocks, makeStrategy({ handoff: 'loop' }));
    const { chunks } = await collectGen(new SeedHandoff(deps).run());
    expect(chunks).toEqual([
      { type: 'handoff', decision: 'loop', reason: 'L2 策略自动衔接' },
    ]);
  });

  it('reflect.handoff=end：任务终止，reason 标注', async () => {
    const { mocks, deps } = createHarness();
    useStrategy(mocks, makeStrategy({ handoff: 'end' }));
    const { chunks } = await collectGen(new SeedHandoff(deps).run());
    expect(chunks).toEqual([
      { type: 'handoff', decision: 'end', reason: 'L2 策略自动衔接' },
    ]);
  });
});