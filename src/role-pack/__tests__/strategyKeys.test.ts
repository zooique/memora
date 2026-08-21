/**
 * strategyKeys.test.ts — 策略键 SSOT 测试
 *
 * 覆盖范围：
 *   1. 校验辅助函数（isPositiveInt / isNonNegativeInt / isTemperature / isRecallConfidence / isNonEmptyString / isAskOn）
 *   2. STRATEGY_KEY_RULES 完整性（prepare / act / reflect / global 四组键覆盖 + 规则类型）
 *
 * 设计纪律：角色包对策略维度只"选择"不"定义"，因此枚举外取值是 error（机器可判读）
 */
import { describe, it, expect } from 'vitest';
import {
  STRATEGY_KEY_RULES,
  isPositiveInt,
  isNonNegativeInt,
  isTemperature,
  isRecallConfidence,
  isNonEmptyString,
  isAskOn,
  type KeyRule,
} from '../strategyKeys.js';

// ══════════════════════════════════════════════════════════════
// 1. 校验辅助函数
// ══════════════════════════════════════════════════════════════

describe('strategyKeys — 校验辅助函数', () => {
  // ── isPositiveInt ──
  describe('isPositiveInt', () => {
    it('正整数通过', () => {
      expect(isPositiveInt(1)).toBe(true);
      expect(isPositiveInt(10)).toBe(true);
      expect(isPositiveInt(100)).toBe(true);
    });

    it('0 不通过', () => {
      expect(isPositiveInt(0)).toBe(false);
    });

    it('负数不通过', () => {
      expect(isPositiveInt(-1)).toBe(false);
      expect(isPositiveInt(-10)).toBe(false);
    });

    it('浮点数不通过', () => {
      expect(isPositiveInt(1.5)).toBe(false);
      expect(isPositiveInt(0.1)).toBe(false);
    });

    it('非数字类型不通过', () => {
      expect(isPositiveInt('1')).toBe(false);
      expect(isPositiveInt(null)).toBe(false);
      expect(isPositiveInt(undefined)).toBe(false);
      expect(isPositiveInt({})).toBe(false);
      expect(isPositiveInt([])).toBe(false);
    });
  });

  // ── isNonNegativeInt ──
  describe('isNonNegativeInt', () => {
    it('正整数通过', () => {
      expect(isNonNegativeInt(1)).toBe(true);
      expect(isNonNegativeInt(10)).toBe(true);
    });

    it('0 通过', () => {
      expect(isNonNegativeInt(0)).toBe(true);
    });

    it('负数不通过', () => {
      expect(isNonNegativeInt(-1)).toBe(false);
      expect(isNonNegativeInt(-10)).toBe(false);
    });

    it('浮点数不通过', () => {
      expect(isNonNegativeInt(0.5)).toBe(false);
      expect(isNonNegativeInt(1.0001)).toBe(false);
    });

    it('非数字类型不通过', () => {
      expect(isNonNegativeInt('0')).toBe(false);
      expect(isNonNegativeInt(null)).toBe(false);
    });
  });

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

  // ── isRecallConfidence ──
  describe('isRecallConfidence', () => {
    it('0.0 ~ 1.0 范围内通过', () => {
      expect(isRecallConfidence(0)).toBe(true);
      expect(isRecallConfidence(0.5)).toBe(true);
      expect(isRecallConfidence(1.0)).toBe(true);
    });

    it('超出范围不通过', () => {
      expect(isRecallConfidence(-0.1)).toBe(false);
      expect(isRecallConfidence(1.1)).toBe(false);
    });

    it('非数字类型不通过', () => {
      expect(isRecallConfidence('0.8')).toBe(false);
      expect(isRecallConfidence(undefined)).toBe(false);
    });
  });

  // ── isNonEmptyString ──
  describe('isNonEmptyString', () => {
    it('非空字符串通过', () => {
      expect(isNonEmptyString('hello')).toBe(true);
      expect(isNonEmptyString('  hello  ')).toBe(true);
      expect(isNonEmptyString('你好世界')).toBe(true);
    });

    it('空字符串不通过', () => {
      expect(isNonEmptyString('')).toBe(false);
    });

    it('纯空白字符串不通过', () => {
      expect(isNonEmptyString('   ')).toBe(false);
      expect(isNonEmptyString('\t\n')).toBe(false);
    });

    it('非字符串类型不通过', () => {
      expect(isNonEmptyString(123)).toBe(false);
      expect(isNonEmptyString(null)).toBe(false);
      expect(isNonEmptyString(undefined)).toBe(false);
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
      'recentRounds',
      'memoryRecall',
      'memoryRecallQuota',
      'minFallback',
      'summaryFocus',
      'contextAssembly',
      'autoSwitch',
      'recallConfidence',
      'summaryRecall',
    ],
    act: [
      'toolMode',
      'temperature',
      'outputLimit',
      'streaming',
      'toolStepLimit',
      'providerRouting',
      'inputInterrupt',
      'multiStepReasoning',
      'toolReadonly',
      'toolApproval',
    ],
    reflect: [
      'summary',
      'handoff',
      'loopContinue',
      'userFollowup',
    ],
    global: ['askOn', 'askLimit', 'errorHandling', 'tokenBudget', 'stepBudget', 'taskLoopLimit'],
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
    it('prepare.memoryRecall 枚举值正确', () => {
      const rule = STRATEGY_KEY_RULES.prepare!.memoryRecall!;
      expect(rule).toEqual({ kind: 'enum', values: ['full', 'limited', 'none'] });
    });

    it('act.toolMode 枚举值正确', () => {
      const rule = STRATEGY_KEY_RULES.act!.toolMode!;
      expect(rule).toEqual({ kind: 'enum', values: ['allow', 'block'] });
    });

    it('act.streaming 枚举值正确', () => {
      const rule = STRATEGY_KEY_RULES.act!.streaming!;
      expect(rule).toEqual({ kind: 'enum', values: ['streaming', 'non-streaming'] });
    });

    it('reflect.handoff 枚举值正确', () => {
      const rule = STRATEGY_KEY_RULES.reflect!.handoff!;
      expect(rule).toEqual({ kind: 'enum', values: ['wait', 'loop', 'end'] });
    });

    it('reflect.summary 枚举值正确', () => {
      const rule = STRATEGY_KEY_RULES.reflect!.summary!;
      expect(rule).toEqual({ kind: 'enum', values: ['on', 'off'] });
    });

    it('global.errorHandling 枚举值正确', () => {
      const rule = STRATEGY_KEY_RULES.global!.errorHandling!;
      expect(rule).toEqual({ kind: 'enum', values: ['retry', 'degrade', 'stop'] });
    });
  });

  // ── 具体校验函数验证 ──
  describe('校验函数验证', () => {
    it('prepare.recentRounds 使用 isPositiveInt', () => {
      const rule = STRATEGY_KEY_RULES.prepare!.recentRounds!;
      expect(rule.kind).toBe('check');
      const checkRule = rule as { check: (v: unknown) => boolean };
      expect(checkRule.check(5)).toBe(true);
      expect(checkRule.check(0)).toBe(false);
    });

    it('act.temperature 使用 isTemperature', () => {
      const rule = STRATEGY_KEY_RULES.act!.temperature!;
      expect(rule.kind).toBe('check');
      const checkRule = rule as { check: (v: unknown) => boolean };
      expect(checkRule.check(0.7)).toBe(true);
      expect(checkRule.check(3.0)).toBe(false);
    });

    it('reflect.loopContinue 使用 isNonNegativeInt', () => {
      const rule = STRATEGY_KEY_RULES.reflect!.loopContinue!;
      expect(rule.kind).toBe('check');
      const checkRule = rule as { check: (v: unknown) => boolean };
      expect(checkRule.check(0)).toBe(true);
      expect(checkRule.check(3)).toBe(true);
      expect(checkRule.check(-1)).toBe(false);
    });

    it('global.askLimit 使用 isPositiveInt', () => {
      const rule = STRATEGY_KEY_RULES.global!.askLimit!;
      expect(rule.kind).toBe('check');
      const checkRule = rule as { check: (v: unknown) => boolean };
      expect(checkRule.check(3)).toBe(true);
      expect(checkRule.check(0)).toBe(false);
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
