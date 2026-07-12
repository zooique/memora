/**
 * scenarios.ts 结构完整性测试
 *
 * 验证评估场景定义的结构正确性，不验证场景语义（语义由 EvalRunner 执行时验证）。
 */
import { describe, it, expect } from 'vitest';
import { MINIMAL_EVAL_SCENARIOS } from '@/eval/scenarios.js';
import type { EvalExpectation } from '@/eval/evalTypes.js';

describe('MINIMAL_EVAL_SCENARIOS', () => {
  it('应包含 3 个场景', () => {
    expect(MINIMAL_EVAL_SCENARIOS).toHaveLength(3);
  });

  it('每个场景应有非空 name 和 description', () => {
    for (const scenario of MINIMAL_EVAL_SCENARIOS) {
      expect(scenario.name).toBeTruthy();
      expect(scenario.description).toBeTruthy();
    }
  });

  it('场景名称应唯一', () => {
    const names = MINIMAL_EVAL_SCENARIOS.map((s) => s.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it('每个场景的 expect 应至少定义一项检查', () => {
    const hasCheck = (expect: EvalExpectation): boolean =>
      expect.toolsCalled !== undefined ||
      expect.toolsNotCalled !== undefined ||
      expect.toolCallCount !== undefined ||
      expect.guardrailBlocked !== undefined;

    for (const scenario of MINIMAL_EVAL_SCENARIOS) {
      expect(hasCheck(scenario.expect)).toBe(true);
    }
  });

  it('应覆盖 guardrailBlocked 维度', () => {
    const hasGuardrail = MINIMAL_EVAL_SCENARIOS.some(
      (s) => s.expect.guardrailBlocked !== undefined,
    );
    expect(hasGuardrail).toBe(true);
  });

  it('应覆盖 toolsCalled 维度', () => {
    const hasToolsCalled = MINIMAL_EVAL_SCENARIOS.some(
      (s) => s.expect.toolsCalled !== undefined,
    );
    expect(hasToolsCalled).toBe(true);
  });

  it('应覆盖 toolCallCount 维度', () => {
    const hasCallCount = MINIMAL_EVAL_SCENARIOS.some(
      (s) => s.expect.toolCallCount !== undefined,
    );
    expect(hasCallCount).toBe(true);
  });
});
