/**
 * scenarios.ts 结构完整性测试
 *
 * 验证评估场景定义的结构正确性，不验证场景语义（语义由 EvalRunner 执行时验证）。
 */
import { describe, it, expect } from 'vitest';
import { EVAL_SCENARIOS } from '@/eval/scenarios.js';
import type { EvalExpectation } from '@/eval/evalTypes.js';

describe('EVAL_SCENARIOS', () => {
  it('应包含 8 个场景', () => {
    expect(EVAL_SCENARIOS).toHaveLength(8);
  });

  it('每个场景应有非空 name 和 description', () => {
    for (const scenario of EVAL_SCENARIOS) {
      expect(scenario.name).toBeTruthy();
      expect(scenario.description).toBeTruthy();
    }
  });

  it('场景名称应唯一', () => {
    const names = EVAL_SCENARIOS.map((s) => s.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it('每个场景的 expect 应至少定义一项检查', () => {
    const hasCheck = (expect: EvalExpectation): boolean =>
      expect.toolsCalled !== undefined ||
      expect.toolsNotCalled !== undefined ||
      expect.toolCallCount !== undefined ||
      expect.guardrailBlocked !== undefined ||
      expect.recallCount !== undefined ||
      expect.done !== undefined;

    for (const scenario of EVAL_SCENARIOS) {
      expect(hasCheck(scenario.expect)).toBe(true);
    }
  });

  it('应覆盖 guardrailBlocked 维度', () => {
    const hasGuardrail = EVAL_SCENARIOS.some(
      (s) => s.expect.guardrailBlocked !== undefined,
    );
    expect(hasGuardrail).toBe(true);
  });

  it('应覆盖 toolsCalled 维度', () => {
    const hasToolsCalled = EVAL_SCENARIOS.some(
      (s) => s.expect.toolsCalled !== undefined,
    );
    expect(hasToolsCalled).toBe(true);
  });

  it('应覆盖 toolsNotCalled 维度', () => {
    const hasToolsNotCalled = EVAL_SCENARIOS.some(
      (s) => s.expect.toolsNotCalled !== undefined,
    );
    expect(hasToolsNotCalled).toBe(true);
  });

  it('应覆盖 toolCallCount 维度', () => {
    const hasCallCount = EVAL_SCENARIOS.some(
      (s) => s.expect.toolCallCount !== undefined,
    );
    expect(hasCallCount).toBe(true);
  });

  it('应覆盖 recallCount 维度', () => {
    const hasRecallCount = EVAL_SCENARIOS.some(
      (s) => s.expect.recallCount !== undefined,
    );
    expect(hasRecallCount).toBe(true);
  });

  it('应覆盖 done 维度', () => {
    const hasDone = EVAL_SCENARIOS.some(
      (s) => s.expect.done !== undefined,
    );
    expect(hasDone).toBe(true);
  });

  it('recall-memory-present 场景应配置 recalledMemories', () => {
    const scenario = EVAL_SCENARIOS.find((s) => s.name === 'recall-memory-present');
    expect(scenario).toBeDefined();
    expect(scenario!.recalledMemories).toBeDefined();
    expect(scenario!.recalledMemories!.length).toBeGreaterThan(0);
  });

  it('每个场景的 input 应为字符串', () => {
    for (const scenario of EVAL_SCENARIOS) {
      expect(typeof scenario.input).toBe('string');
    }
  });
});
