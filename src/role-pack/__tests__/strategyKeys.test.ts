/**
 * strategyKeys.test.ts — 策略键 SSOT 测试
 *
 * 覆盖范围：
 *   1. 校验辅助函数（isTemperature / isSummaryFocus / isAskOn）
 *   2. STRATEGY_KEY_RULES 完整性（prepare / act / reflect / global 四组键覆盖 + 规则类型）
 *   3. docs/role-pack/role-pack.schema.json 与策略键常量的一致性（防腐守——防 schema 手写副本与代码常量漂移）
 *
 * 注：isPercent / isRecallConfidence / MAX_MIN_FALLBACK 已随 memory-tool-recall-design
 * 召回策略键族（memoryRecallPercent/recallConfidence/minFallback）退役删除，无对应测试。
 *
 * 设计纪律：角色包对策略维度只"选择"不"定义"，因此枚举外取值是 error（机器可判读）
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  STRATEGY_KEY_RULES,
  TOOL_MODES,
  TOOL_READONLY_MODES,
  PROVIDER_ROUTINGS,
  MULTI_STEP_REASONINGS,
  SUMMARY_MODES,
  USER_FOLLOWUPS,
  ERROR_HANDLINGS,
  ASK_TRIGGERS,
  isTemperature,
  isSummaryFocus,
  isAskOn,
  MAX_OUTPUT_LIMIT,
  MAX_TOOL_STEP_LIMIT,
  MAX_SELF_REVIEW_ROUNDS,
  MAX_ASK_LIMIT,
  MAX_CONTEXT_LIMIT,
  MIN_CONTEXT_LIMIT,
  MAX_STEP_BUDGET,
  MIN_STEP_BUDGET,
  MAX_SUMMARY_FOCUS_LENGTH,
  describeStrategyKeys,
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
    prepare: ['summaryFocus'],
    act: [
      'toolMode',
      'temperature',
      'outputLimit',
      'toolStepLimit',
      'providerRouting',
      'multiStepReasoning',
      'toolReadonly',
    ],
    reflect: ['summary', 'selfReview', 'userFollowup'],
    global: ['askOn', 'askLimit', 'errorHandling', 'contextLimit', 'stepBudget'],
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

  it('已撤键（防回归）：streaming 不在任何阶段键集', () => {
    // streaming 仅被 agent.ts 写入 ChatOptions.stream，而 openaiCompatible
    // 硬编码 stream:true 从不读取 —— 暴露给作者却是空转的假键（同 toolApproval 型）。
    // 若未来误加回键集，此守卫红。
    for (const phase of PHASES) {
      expect(Object.keys(STRATEGY_KEY_RULES[phase]!), `${phase} 不应含 streaming`).not.toContain(
        'streaming',
      );
    }
  });

  it('已撤键（防回归）：loopContinue 别名不在任何阶段键集', () => {
    // loopContinue 是 v0.13- 命名残留的兼容别名（对应 selfReview）。
    // 安装基数 0（无已落盘角色包引用）→ 兼容防的是从未发生的场景；
    // 按版本契约分面「作者输入面可不兼容」整键删除，不留过渡兼容。若未来误加回键集，此守卫红。
    for (const phase of PHASES) {
      expect(Object.keys(STRATEGY_KEY_RULES[phase]!), `${phase} 不应含 loopContinue`).not.toContain(
        'loopContinue',
      );
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
    it('act.toolMode 枚举值正确', () => {
      const rule = STRATEGY_KEY_RULES.act!.toolMode!;
      expect(rule).toEqual({ kind: 'enum', values: ['allow', 'block'] });
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

  // ── SSOT 枚举常量同源守卫（防三副本漂移：类型推导 / KeyRule.values / resolver 白名单）──
  describe('枚举常量同源守卫（identity）', () => {
    // 各枚举键的 values 必须与命名常量同一引用——若未来有人重新手写字面量数组
    // 破坏 SSOT，此守卫红（类型推导与 validator 校验将各自漂移）
    it('act 枚举键 values 与 SSOT 常量同源', () => {
      expect((STRATEGY_KEY_RULES.act!.toolMode! as { values: readonly unknown[] }).values).toBe(
        TOOL_MODES,
      );
      expect(
        (STRATEGY_KEY_RULES.act!.providerRouting! as { values: readonly unknown[] }).values,
      ).toBe(PROVIDER_ROUTINGS);
      expect(
        (STRATEGY_KEY_RULES.act!.multiStepReasoning! as { values: readonly unknown[] }).values,
      ).toBe(MULTI_STEP_REASONINGS);
      expect((STRATEGY_KEY_RULES.act!.toolReadonly! as { values: readonly unknown[] }).values).toBe(
        TOOL_READONLY_MODES,
      );
    });

    it('reflect/global 枚举键 values 与 SSOT 常量同源', () => {
      expect((STRATEGY_KEY_RULES.reflect!.summary! as { values: readonly unknown[] }).values).toBe(
        SUMMARY_MODES,
      );
      expect(
        (STRATEGY_KEY_RULES.reflect!.userFollowup! as { values: readonly unknown[] }).values,
      ).toBe(USER_FOLLOWUPS);
      expect(
        (STRATEGY_KEY_RULES.global!.errorHandling! as { values: readonly unknown[] }).values,
      ).toBe(ERROR_HANDLINGS);
    });

    it('ASK_TRIGGERS 为 askOn 白名单真源（types.ts AskOnTrigger 推导 + isAskOn 校验共用）', () => {
      // 增删触发词只改此处：类型推导（AskOnTrigger）与运行时校验（isAskOn）自动跟随
      expect(ASK_TRIGGERS).toEqual(['ambiguity', 'decision', 'missing_info', 'confirm']);
      for (const t of ASK_TRIGGERS) {
        expect(isAskOn(t), `触发词 ${t} 应通过 isAskOn 单值校验`).toBe(true);
      }
      expect(isAskOn([...ASK_TRIGGERS])).toBe(true);
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

    it('reflect.selfReview 使用区间断言（0~MAX_SELF_REVIEW_ROUNDS）', () => {
      const rule = STRATEGY_KEY_RULES.reflect!.selfReview!;
      expect(rule.kind).toBe('check');
      const checkRule = rule as {
        check: (v: unknown) => boolean;
        range?: { min: number; max: number };
      };
      expect(checkRule.check(0)).toBe(true);
      expect(checkRule.check(3)).toBe(true);
      expect(checkRule.check(-1)).toBe(false);
      expect(checkRule.range).toEqual({ min: 0, max: MAX_SELF_REVIEW_ROUNDS });
    });

    it('global.askLimit 使用区间断言（1~MAX_ASK_LIMIT）', () => {
      const rule = STRATEGY_KEY_RULES.global!.askLimit!;
      expect(rule.kind).toBe('check');
      const checkRule = rule as {
        check: (v: unknown) => boolean;
        range?: { min: number; max: number };
      };
      expect(checkRule.check(3)).toBe(true);
      expect(checkRule.check(0)).toBe(false);
      expect(checkRule.range).toEqual({ min: 1, max: MAX_ASK_LIMIT });
    });
  });

  // ── 数值键区间上界（SSOT：开放键必须有上下限，防无条件填写）──
  describe('strategyKeys — 数值键区间上界', () => {
    // 每个数值键：check 断言内置完整区间 + range 元数据与断言同源（防双写漂移）
    const CASES: Array<{ key: string; rule: KeyRule; min: number; max: number; probe: number }> = [
      {
        key: 'act.temperature',
        rule: STRATEGY_KEY_RULES.act!.temperature!,
        min: 0,
        max: 2,
        probe: 2.1,
      },
      {
        key: 'act.outputLimit',
        rule: STRATEGY_KEY_RULES.act!.outputLimit!,
        min: 1,
        max: MAX_OUTPUT_LIMIT,
        probe: MAX_OUTPUT_LIMIT + 1,
      },
      {
        key: 'act.toolStepLimit',
        rule: STRATEGY_KEY_RULES.act!.toolStepLimit!,
        min: 0,
        max: MAX_TOOL_STEP_LIMIT,
        probe: MAX_TOOL_STEP_LIMIT + 1,
      },
      {
        key: 'reflect.selfReview',
        rule: STRATEGY_KEY_RULES.reflect!.selfReview!,
        min: 0,
        max: MAX_SELF_REVIEW_ROUNDS,
        probe: MAX_SELF_REVIEW_ROUNDS + 1,
      },
      {
        key: 'global.askLimit',
        rule: STRATEGY_KEY_RULES.global!.askLimit!,
        min: 1,
        max: MAX_ASK_LIMIT,
        probe: MAX_ASK_LIMIT + 1,
      },
      {
        key: 'global.contextLimit',
        rule: STRATEGY_KEY_RULES.global!.contextLimit!,
        min: MIN_CONTEXT_LIMIT,
        max: MAX_CONTEXT_LIMIT,
        probe: MAX_CONTEXT_LIMIT + 1,
      },
      {
        key: 'global.stepBudget',
        rule: STRATEGY_KEY_RULES.global!.stepBudget!,
        min: MIN_STEP_BUDGET,
        max: MAX_STEP_BUDGET,
        probe: MAX_STEP_BUDGET + 1,
      },
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

    it('三个 0-哨兵上限键同构：contextLimit / stepBudget / outputLimit 的 check(0) 均通过', () => {
      // 表示法统一守卫：三个「上限类」键共用「0 = 不干预/走兜底、正数 = 显式声明区间」语义。
      // 若某键未来改回 intRange(1, ...)（0 报错），此处红灯——表示法分裂不允许静默发生。
      const ZERO_SENTINEL_KEYS = [
        { phase: 'global', key: 'contextLimit' },
        { phase: 'global', key: 'stepBudget' },
        { phase: 'act', key: 'outputLimit' },
      ] as const;
      for (const { phase, key } of ZERO_SENTINEL_KEYS) {
        const rule = STRATEGY_KEY_RULES[phase]![key] as {
          kind: 'check';
          check: (v: unknown) => boolean;
        };
        expect(rule.kind, `${phase}.${key} 应为 check`).toBe('check');
        expect(rule.check(0), `${phase}.${key} 应接受 0（不干预哨兵）`).toBe(true);
        expect(rule.check(-1), `${phase}.${key} 应拒绝负数`).toBe(false);
      }
    });

    // 浮点键：允许小数，仅约束区间；其余数值键为整数键
    const FLOAT_KEYS: ReadonlySet<string> = new Set(['act.temperature']);

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

// ═══════════════════════════════════════════════════════════
// 3. schema.json 与策略键常量一致性（防腐守）
//
// schema.json 是给 IDE/编辑器做 manifest 校验提示的手写交付物，无法 import TS 常量，
// 其上/下限是硬编码副本。此守卫把"两处"钉在代码真源上——改 strategyKeys.ts 常量
// 或改 schema.json 游标都会在任一不一致处红灯，杜绝静默漂移。
//
// 范围：仅覆盖「数值键的上/下限」，这是最容易漂移且语义最关键的部分。
// 语义差异说明（勿视作漂移）：
//   - stepBudget.minimum=10 是「正数声明区间下限」（0=未声明走兜底），
//     schema 的 minimum=0 是 JSON-Schema 层"接受 0"；二者叠加不冲突。
// ═══════════════════════════════════════════════════════════

describe('strategyKeys — schema.json 与常量一致性', () => {
  /** 读取 schema.json 原始文本（测试运行于 node 环境，可用文件系统直接读） */
  const schemaText = readFileSync(
    new URL('../../../docs/role-pack/role-pack.schema.json', import.meta.url),
    'utf-8',
  );
  /** 解析为 JSON 对象（schema 为有效 JSON，可直接 JSON.parse） */
  const schema = JSON.parse(schemaText) as {
    properties: {
      strategy: {
        properties: Record<
          'act' | 'reflect' | 'global',
          { properties: Record<string, { minimum?: number; maximum?: number }> }
        >;
      };
    };
  };

  const strategyProps = schema.properties.strategy.properties;

  // 数值键游标映射：schema 键 → 期望的上限（来自代码常量真源）
  // - { phase, key, expectedMax }；阶段与代码 STRATEGY_KEY_RULES 阶段对齐
  const BOUND_CASES: ReadonlyArray<{
    phase: 'act' | 'reflect' | 'global';
    key: string;
    expectedMax: number;
  }> = [
    { phase: 'act', key: 'outputLimit', expectedMax: MAX_OUTPUT_LIMIT },
    { phase: 'act', key: 'toolStepLimit', expectedMax: MAX_TOOL_STEP_LIMIT },
    { phase: 'reflect', key: 'selfReview', expectedMax: MAX_SELF_REVIEW_ROUNDS },
    { phase: 'global', key: 'askLimit', expectedMax: MAX_ASK_LIMIT },
    { phase: 'global', key: 'contextLimit', expectedMax: MAX_CONTEXT_LIMIT },
    { phase: 'global', key: 'stepBudget', expectedMax: MAX_STEP_BUDGET },
  ];

  it('所有受管数值键在 schema 中都能找到对应字段（防键被删/改名导致守门空转）', () => {
    // 若有键在 schema 中缺位，守卫本身就是空的——必须确保守卫覆盖到了真实字段
    for (const { phase, key } of BOUND_CASES) {
      const field = strategyProps[phase]?.properties?.[key];
      expect(field, `schema 应有 ${phase}.${key} 字段`).toBeDefined();
      expect(typeof field?.maximum, `${phase}.${key} 应声明 maximum`).toBe('number');
    }
  });

  it('schema 上限与代码 MAX_* 常量完全一致（防腐守：防 schema 手写副本漂移）', () => {
    // 这是本守卫的核心断言：schema 手写的 maximum 必须等于代码常量真源
    for (const { phase, key, expectedMax } of BOUND_CASES) {
      expect(
        strategyProps[phase]?.properties?.[key]?.maximum,
        `${phase}.${key} schema 上限应等于代码常量 ${expectedMax}（改常量请同步 schema.json）`,
      ).toBe(expectedMax);
    }
  });

  it('数值键的 schema minimum 与代码 range.min 一致（不含 JSON-Schema 接受层差异）', () => {
    // 通过 STRATEGY_KEY_RULES 的 range 元数据取代码真源 min，与 schema 比对
    const ruleMin = (phase: 'act' | 'reflect' | 'global' | 'prepare', key: string): number => {
      const rule = STRATEGY_KEY_RULES[phase]?.[key] as
        { kind: 'check'; range?: { min: number; max: number } } | undefined;
      expect(rule?.kind, `${phase}.${key} 应为 check 数值键`).toBe('check');
      expect(rule?.range, `${phase}.${key} 应有 range`).toBeDefined();
      return rule!.range!.min;
    };

    // 与 schema 比对的具体键（不含 stepBudget / contextLimit / outputLimit：三者的 schema 层
    // minimum=0 是 JSON-Schema 的「接受 0」层，与代码 range.min 的"正数声明区间下限"语义不同，
    // 已在文件头与常量注释说明，不在此强比对）
    const MIN_CASES = [
      { phase: 'act', key: 'toolStepLimit' },
      { phase: 'reflect', key: 'selfReview' },
      { phase: 'global', key: 'askLimit' },
    ] as const;

    for (const { phase, key } of MIN_CASES) {
      const expected = ruleMin(phase, key);
      expect(
        strategyProps[phase]?.properties?.[key]?.minimum,
        `${phase}.${key} schema 下限应等于代码常量 ${expected}`,
      ).toBe(expected);
    }
  });

  it('temperature 键 schema 范围与代码断言一致（0~2，无常量故直接断言）', () => {
    const tempField = strategyProps.act?.properties?.temperature;
    expect(tempField?.minimum).toBe(0);
    expect(tempField?.maximum).toBe(2);
    expect(isTemperature(0)).toBe(true);
    expect(isTemperature(2)).toBe(true);
    expect(isTemperature(2.1)).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════
// 6. describeStrategyKeys —— UI 键面唯一来源（RP-EDIT-1）
// 宿主角色编辑 UI 的键面数据从这里派生（宿主零清单维护）：
// 派生正确性在此锁定——枚举/区间/0 哨兵折算错任何一处，宿主表单跟着错。
// ══════════════════════════════════════════════════════════════
describe('strategyKeys — describeStrategyKeys 键面派生（RP-EDIT-1）', () => {
  /** 阶段/键 → 键面 的查找表（用例内构造，避免重复线性查找） */
  const faces = describeStrategyKeys();
  const faceMap = new Map(faces.map((f) => [`${f.stage}.${f.key}`, f]));

  it('键总数与 STRATEGY_KEY_RULES 一致，四阶段全覆盖', () => {
    const expected: string[] = [];
    for (const [stage, rules] of Object.entries(STRATEGY_KEY_RULES)) {
      for (const key of Object.keys(rules)) expected.push(`${stage}.${key}`);
    }
    expect(faces.map((f) => `${f.stage}.${f.key}`).sort()).toEqual(expected.sort());
  });

  it('enum 键 → kind=enum 且 values 与各枚举常量同源（identity 派生）', () => {
    expect(faceMap.get('act.toolMode')).toMatchObject({ kind: 'enum', values: [...TOOL_MODES] });
    expect(faceMap.get('act.providerRouting')).toMatchObject({
      kind: 'enum',
      values: [...PROVIDER_ROUTINGS],
    });
    expect(
      faceMap.get('reflect.errorHandling') ?? faceMap.get('global.errorHandling'),
    ).toMatchObject({ kind: 'enum', values: [...ERROR_HANDLINGS] });
    expect(faceMap.get('reflect.summary')).toMatchObject({
      kind: 'enum',
      values: [...SUMMARY_MODES],
    });
  });

  it('askOn → kind=multi 且 options 携出 ASK_TRIGGERS（可选值藏在常量，派生时显式带出）', () => {
    expect(faceMap.get('global.askOn')).toMatchObject({
      kind: 'multi',
      options: [...ASK_TRIGGERS],
    });
  });

  it('summaryFocus → kind=text（字符串长度区间，非数值键）', () => {
    expect(faceMap.get('prepare.summaryFocus')).toEqual({
      stage: 'prepare',
      key: 'summaryFocus',
      kind: 'text',
      range: { min: 1, max: MAX_SUMMARY_FOCUS_LENGTH },
    });
  });

  it('数值键 0 哨兵折算：0 合法的键 UI 下限折算为 0；askLimit（1 起）保持声明下限', () => {
    // outputLimit：validator range.min=1（正数声明下限），但 0=不干预合法 → UI 下限 0
    expect(faceMap.get('act.outputLimit')).toMatchObject({
      kind: 'number',
      range: { min: 0, max: MAX_OUTPUT_LIMIT },
    });
    expect(faceMap.get('global.stepBudget')).toMatchObject({
      kind: 'number',
      range: { min: 0, max: MAX_STEP_BUDGET },
    });
    expect(faceMap.get('global.contextLimit')).toMatchObject({
      kind: 'number',
      range: { min: 0, max: MAX_CONTEXT_LIMIT },
    });
    // askLimit 区间 [1,10] 不含 0 → 保持 1
    expect(faceMap.get('global.askLimit')).toMatchObject({
      kind: 'number',
      range: { min: 1, max: MAX_ASK_LIMIT },
    });
    // temperature 0.0 合法且声明下限本就是 0
    expect(faceMap.get('act.temperature')).toMatchObject({
      kind: 'number',
      range: { min: 0, max: 2 },
    });
  });
});
