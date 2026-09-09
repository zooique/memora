/**
 * strategyKeys.test.ts — 策略键 SSOT 测试
 *
 * 覆盖范围：
 *   1. 校验辅助函数（isTemperature / isSummaryFocus / isAskOn）
 *   2. STRATEGY_KEY_RULES 完整性（prepare / act / reflect / global 四组键覆盖 + 规则类型）
 *
 * 注：isPercent / isRecallConfidence / MAX_MIN_FALLBACK 已随 memory-tool-recall-design 阶段2
 * 召回策略键族（memoryRecallPercent/recallConfidence/minFallback）退役删除，无对应测试。
 *
 * 设计纪律：角色包对策略维度只"选择"不"定义"，因此枚举外取值是 error（机器可判读）
 */
import { describe, it, expect } from 'vitest';
import {
  STRATEGY_KEY_RULES,
  isTemperature,
  isSummaryFocus,
  isAskOn,
  MAX_OUTPUT_LIMIT,
  MAX_TOOL_STEP_LIMIT,
  MAX_SELF_REVIEW_ROUNDS,
  MAX_ASK_LIMIT,
  MAX_TOKEN_BUDGET,
  MAX_STEP_BUDGET,
  MIN_STEP_BUDGET,
  MAX_SUMMARY_FOCUS_LENGTH,
  type KeyRule,
} from '../strategyKeys.js';

// ══════════════════════════════════════════════════════════════
// 1. 校验辅助函数
// ══════════════════════════════════════════════════════════════

describe('strategyKeys — 校验辅助函数', () => {
  // ── isTemperature ──
  describe('isTemperature', () => {
    it('0.0 ~ 2.0 范围内通过', () => {
      expect(isTemperature(0)).toBe(true);
      expect(isTemperature(0.5)).toBe(true);
      expect(isTemperature(1.0)).toBe(true);
      expect(isTemperature(2.0)).toBe(true);
    });

    it('超出范围不通过', () => {
      expect(isTemperature(-0.1)).toBe(false);
      expect(isTemperature(2.1)).toBe(false);
      expect(isTemperature(100)).toBe(false);
    });

    it('负数不通过', () => {
      expect(isTemperature(-1)).toBe(false);
    });

    it('非数字类型不通过', () => {
      expect(isTemperature('0.5')).toBe(false);
      expect(isTemperature(null)).toBe(false);
    });
  });

  // ── isSummaryFocus（带长度上限）──
  describe('isSummaryFocus', () => {
    it('非空字符串且不超长通过', () => {
      expect(isSummaryFocus('编程方案视角')).toBe(true);
      expect(isSummaryFocus('a'.repeat(MAX_SUMMARY_FOCUS_LENGTH))).toBe(true);
    });

    it('超长字符串不通过（防巨型注入）', () => {
      expect(isSummaryFocus('a'.repeat(MAX_SUMMARY_FOCUS_LENGTH + 1))).toBe(false);
    });

    it('空/空白字符串不通过', () => {
      expect(isSummaryFocus('')).toBe(false);
      expect(isSummaryFocus('   ')).toBe(false);
    });

    it('非字符串类型不通过', () => {
      expect(isSummaryFocus(123)).toBe(false);
      expect(isSummaryFocus(null)).toBe(false);
    });
  });

  // ── isAskOn ──
  describe('isAskOn', () => {
    it('单个有效枚举值通过', () => {
      expect(isAskOn('ambiguity')).toBe(true);
      expect(isAskOn('decision')).toBe(true);
      expect(isAskOn('missing_info')).toBe(true);
      expect(isAskOn('confirm')).toBe(true);
    });

    it('数组形式（可组合）通过', () => {
      expect(isAskOn(['ambiguity', 'decision'])).toBe(true);
      expect(isAskOn(['confirm'])).toBe(true);
      expect(isAskOn(['ambiguity', 'decision', 'missing_info', 'confirm'])).toBe(true);
    });

    it('无效枚举值不通过', () => {
      expect(isAskOn('invalid')).toBe(false);
      expect(isAskOn('')).toBe(false);
    });

    it('含无效元素的数组不通过', () => {
      expect(isAskOn(['ambiguity', 'invalid'])).toBe(false);
      expect(isAskOn(['invalid1', 'invalid2'])).toBe(false);
    });

    it('空数组不通过', () => {
      expect(isAskOn([])).toBe(false);
    });

    it('非字符串/数组类型不通过', () => {
      expect(isAskOn(123)).toBe(false);
      expect(isAskOn(null)).toBe(false);
      expect(isAskOn(undefined)).toBe(false);
      expect(isAskOn({})).toBe(false);
    });
  });
});

// ══════════════════════════════════════════════════════════════
// 2. STRATEGY_KEY_RULES 完整性
// ══════════════════════════════════════════════════════════════

describe('strategyKeys — STRATEGY_KEY_RULES 完整性', () => {
  const PHASES = ['prepare', 'act', 'reflect', 'global'] as const;
  type Phase = (typeof PHASES)[number];

  // 收集所有已知键（文档列出的）
  const EXPECTED_KEYS: Record<Phase, string[]> = {
    prepare: [
      'summaryFocus',
      'understandingConfirm',
    ],
    act: [
      'toolMode',
      'temperature',
      'outputLimit',
      'streaming',
      'toolStepLimit',
      'providerRouting',
      'multiStepReasoning',
      'toolReadonly',
      'toolApproval',
    ],
    reflect: [
      'summary',
      'selfReview',
      'loopContinue',
      'userFollowup',
    ],
    global: ['askOn', 'askLimit', 'errorHandling', 'tokenBudget', 'stepBudget'],
  };

  it('四个阶段都存在', () => {
    for (const phase of PHASES) {
      expect(STRATEGY_KEY_RULES[phase], `阶段 ${phase} 应存在`).toBeDefined();
      expect(typeof STRATEGY_KEY_RULES[phase], `阶段 ${phase} 应为对象`).toBe('object');
    }
  });

  it('每个阶段的键数量正确', () => {
    for (const phase of PHASES) {
      const actualKeys = Object.keys(STRATEGY_KEY_RULES[phase]!);
      expect(
        actualKeys.length,
        `阶段 ${phase} 应有 ${EXPECTED_KEYS[phase].length} 个键，实际 ${actualKeys.length}`,
      ).toBe(EXPECTED_KEYS[phase].length);
    }
  });

  it('每个阶段的键名与文档一致', () => {
    for (const phase of PHASES) {
      const actualKeys = new Set(Object.keys(STRATEGY_KEY_RULES[phase]!));
      for (const expectedKey of EXPECTED_KEYS[phase]) {
        expect(actualKeys.has(expectedKey), `阶段 ${phase} 应包含键 ${expectedKey}`).toBe(true);
      }
    }
  });

  it('autoSwitch 已随 v0.13 整体移除（不在任何策略键集，防回归）', () => {
    // v0.13 移除自动匹配全链（角色包只能手动切换），autoSwitch 不应存在于任何阶段键集。
    // 若未来误加回键集，说明自动切换死灰复燃——此处守卫阻止回归。
    expect(STRATEGY_KEY_RULES.prepare!.autoSwitch).toBeUndefined();
    expect(STRATEGY_KEY_RULES.act!.autoSwitch).toBeUndefined();
    expect(STRATEGY_KEY_RULES.reflect!.autoSwitch).toBeUndefined();
    expect(STRATEGY_KEY_RULES.global!.autoSwitch).toBeUndefined();
  });

  it('每个规则都是合法的 KeyRule 类型', () => {
    for (const phase of PHASES) {
      const rules = STRATEGY_KEY_RULES[phase]!;
      for (const [key, rule] of Object.entries(rules)) {
        const r = rule as KeyRule;
        expect(
          r.kind === 'enum' || r.kind === 'check',
          `键 ${phase}.${key} 的规则应有 kind: 'enum' 或 'check'`,
        ).toBe(true);
        if (r.kind === 'enum') {
          expect(
            Array.isArray((r as { values: readonly unknown[] }).values),
            `枚举键 ${phase}.${key} 应有 values 数组`,
          ).toBe(true);
        }
        if (r.kind === 'check') {
          expect(
            typeof (r as { check: (v: unknown) => boolean }).check,
            `校验键 ${phase}.${key} 应有 check 函数`,
          ).toBe('function');
        }
      }
    }
  });

  // ── 具体枚举值验证 ──
  describe('枚举值验证', () => {
    it('act.toolMode 枚举值正确', () => {
      const rule = STRATEGY_KEY_RULES.act!.toolMode!;
      expect(rule).toEqual({ kind: 'enum', values: ['allow', 'block'] });
    });

    it('act.streaming 枚举值正确', () => {
      const rule = STRATEGY_KEY_RULES.act!.streaming!;
      expect(rule).toEqual({ kind: 'enum', values: ['streaming', 'non-streaming'] });
    });

    it('reflect.summary 枚举值正确', () => {
      const rule = STRATEGY_KEY_RULES.reflect!.summary!;
      expect(rule).toEqual({ kind: 'enum', values: ['on', 'off'] });
    });

    it('global.errorHandling 枚举值正确', () => {
      const rule = STRATEGY_KEY_RULES.global!.errorHandling!;
      expect(rule).toEqual({ kind: 'enum', values: ['retry', 'degrade', 'stop'] });
    });

    it('prepare.understandingConfirm 枚举值正确', () => {
      const rule = STRATEGY_KEY_RULES.prepare!.understandingConfirm!;
      expect(rule).toEqual({ kind: 'enum', values: ['off', 'echo', 'confirm'] });
    });
  });

  // ── 具体校验函数验证 ──
  describe('校验函数验证', () => {
    it('act.temperature 使用 isTemperature', () => {
      const rule = STRATEGY_KEY_RULES.act!.temperature!;
      expect(rule.kind).toBe('check');
      const checkRule = rule as { check: (v: unknown) => boolean };
      expect(checkRule.check(0.7)).toBe(true);
      expect(checkRule.check(3.0)).toBe(false);
    });

    it('reflect.selfReview 使用区间断言（0~MAX_SELF_REVIEW_ROUNDS），旧键 loopContinue 保留为历史别名', () => {
      const rule = STRATEGY_KEY_RULES.reflect!.selfReview!;
      expect(rule.kind).toBe('check');
      const checkRule = rule as { check: (v: unknown) => boolean; range?: { min: number; max: number } };
      expect(checkRule.check(0)).toBe(true);
      expect(checkRule.check(3)).toBe(true);
      expect(checkRule.check(-1)).toBe(false);
      expect(checkRule.range).toEqual({ min: 0, max: MAX_SELF_REVIEW_ROUNDS });
      // 历史别名仍被校验器认可（兼容已落盘角色包，不报未知键）
      expect(STRATEGY_KEY_RULES.reflect!.loopContinue).toBeDefined();
    });

    it('global.askLimit 使用区间断言（1~MAX_ASK_LIMIT）', () => {
      const rule = STRATEGY_KEY_RULES.global!.askLimit!;
      expect(rule.kind).toBe('check');
      const checkRule = rule as { check: (v: unknown) => boolean; range?: { min: number; max: number } };
      expect(checkRule.check(3)).toBe(true);
      expect(checkRule.check(0)).toBe(false);
      expect(checkRule.range).toEqual({ min: 1, max: MAX_ASK_LIMIT });
    });
  });

  // ── 数值键区间上界（SSOT：开放键必须有上下限，防无条件填写）──
  describe('strategyKeys — 数值键区间上界', () => {
    // 每个数值键：check 断言内置完整区间 + range 元数据与断言同源（防双写漂移）
    const CASES: Array<{ key: string; rule: KeyRule; min: number; max: number; probe: number }> = [
      { key: 'act.temperature', rule: STRATEGY_KEY_RULES.act!.temperature!, min: 0, max: 2, probe: 2.1 },
      { key: 'act.outputLimit', rule: STRATEGY_KEY_RULES.act!.outputLimit!, min: 1, max: MAX_OUTPUT_LIMIT, probe: MAX_OUTPUT_LIMIT + 1 },
      { key: 'act.toolStepLimit', rule: STRATEGY_KEY_RULES.act!.toolStepLimit!, min: 0, max: MAX_TOOL_STEP_LIMIT, probe: MAX_TOOL_STEP_LIMIT + 1 },
      { key: 'reflect.selfReview', rule: STRATEGY_KEY_RULES.reflect!.selfReview!, min: 0, max: MAX_SELF_REVIEW_ROUNDS, probe: MAX_SELF_REVIEW_ROUNDS + 1 },
      { key: 'global.askLimit', rule: STRATEGY_KEY_RULES.global!.askLimit!, min: 1, max: MAX_ASK_LIMIT, probe: MAX_ASK_LIMIT + 1 },
      { key: 'global.tokenBudget', rule: STRATEGY_KEY_RULES.global!.tokenBudget!, min: 0, max: MAX_TOKEN_BUDGET, probe: MAX_TOKEN_BUDGET + 1 },
      { key: 'global.stepBudget', rule: STRATEGY_KEY_RULES.global!.stepBudget!, min: MIN_STEP_BUDGET, max: MAX_STEP_BUDGET, probe: MAX_STEP_BUDGET + 1 },
    ];

    it('所有数值键都带 range 元数据（上下限齐全）', () => {
      for (const { key, rule, min, max } of CASES) {
        expect(rule.kind, `${key} 应为 check`).toBe('check');
        if (rule.kind === 'check') {
          expect(rule.range, `${key} 必须声明 range 上下限`).toBeDefined();
          expect(rule.range!.min, `${key} 下限`).toBe(min);
          expect(rule.range!.max, `${key} 上限`).toBe(max);
        }
      }
    });

    it('越上界值一律不通过（防无条件填写资源失控）', () => {
      for (const { key, rule, probe } of CASES) {
        if (rule.kind === 'check') {
          expect(rule.check(probe), `${key} 越上界 ${probe} 应拒绝`).toBe(false);
        }
      }
    });

    it('下界边界值通过（0 或 1 语义合法）', () => {
      for (const { key, rule, min } of CASES) {
        if (rule.kind === 'check') {
          expect(rule.check(min), `${key} 下界 ${min} 应通过`).toBe(true);
        }
      }
    });

    // 浮点键：允许小数，仅约束区间；其余数值键为整数键
    const FLOAT_KEYS: ReadonlySet<string> = new Set([
      'act.temperature',
    ]);

    it('非整数不通过（整数区间键必须为整数）', () => {
      for (const { key, rule } of CASES) {
        if (rule.kind === 'check' && rule.range && !FLOAT_KEYS.has(key)) {
          expect(rule.check(0.5), `${key} 浮点 0.5 应拒绝`).toBe(false);
        }
      }
    });

    it('浮点键允许小数但拒绝超区间', () => {
      for (const { key, rule, max } of CASES) {
        if (rule.kind === 'check' && rule.range && FLOAT_KEYS.has(key)) {
          // 0.5 在 [0, 1]/[0, 2] 区间内是合法浮点
          expect(rule.check(0.5), `${key} 浮点 0.5 应通过`).toBe(true);
          // 超过上界的浮点拒绝（如 1.5 对 0~1 键）
          expect(rule.check(max + 0.5), `${key} 超上界浮点应拒绝`).toBe(false);
        }
      }
    });
  });
});

// ══════════════════════════════════════════════════════════════
// 4. KeyRule 类型验证
// ══════════════════════════════════════════════════════════════

describe('strategyKeys — KeyRule 类型验证', () => {
  it('enum 类型：values 数组', () => {
    const rule: KeyRule = { kind: 'enum', values: ['a', 'b', 'c'] };
    expect(rule.kind).toBe('enum');
    expect(rule.values).toEqual(['a', 'b', 'c']);
  });

  it('check 类型：断言函数', () => {
    const rule: KeyRule = { kind: 'check', check: (v) => typeof v === 'number' };
    expect(rule.kind).toBe('check');
    expect(rule.check(42)).toBe(true);
    expect(rule.check('42')).toBe(false);
  });

  it('两种类型互斥（ discriminated union ）', () => {
    // 验证 TypeScript 类型系统正确区分两种 kind
    const enumRule: KeyRule = { kind: 'enum', values: ['test'] };
    const checkRule: KeyRule = { kind: 'check', check: () => true };

    // 运行时检查
    if (enumRule.kind === 'enum') {
      expect(Array.isArray(enumRule.values)).toBe(true);
    }
    if (checkRule.kind === 'check') {
      expect(typeof checkRule.check).toBe('function');
    }
  });
});
