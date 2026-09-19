/**
 * 角色包行为策略解析器单元测试
 *
 * 覆盖 strategyResolver.ts 的全部解析逻辑：
 *   1. DEFAULT_BEHAVIOR_STRATEGY 默认值完整性
 *   2. 每个 resolve* 函数的合法值 / 非法值 / 缺失值处理
 *   3. mergeStrategy 的合并行为（无覆盖 / 全量覆盖 / 部分覆盖）
 *   4. assembleRolePack 的装配逻辑（personaPrompt 组装 / 主动提问指令注入）
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_BEHAVIOR_STRATEGY,
  resolveSummaryFocus,
  resolveToolMode,
  resolveSummary,
  resolveToolStepLimit,
  resolveErrorHandling,
  resolveProviderRouting,
  resolveAskLimit,
  resolveContextLimit,
  resolveStepBudget,
  resolveMultiStepReasoning,
  resolveToolReadonly,
  mergeStrategy,
  assembleRolePack,
  resolveL2Strategy,
  DEFAULT_L2_STRATEGY,
} from '@/role-pack/strategyResolver.js';
import {
  MAX_TOOL_STEP_LIMIT,
  MAX_SELF_REVIEW_ROUNDS,
  MAX_CONTEXT_LIMIT,
  MAX_STEP_BUDGET,
  MAX_SUMMARY_FOCUS_LENGTH,
} from '@/role-pack/strategyKeys.js';
import type {
  BehaviorStrategy,
  RolePack,
  RolePackCapability,
} from '@/role-pack/types.js';

// ─── 辅助：创建最小角色包 ───────────────────────────

/** 创建用于测试的最小 RolePack */
function makeRolePack(overrides: Partial<RolePack> = {}): RolePack {
  return {
    name: 'test-role',
    content: '测试内容',
    filePath: '/fake/path/manifest.json',
    meta: {
      name: 'test-role',
      displayName: '测试角色',
      description: '用于测试的角色包',
      version: '1.0.0',
    },
    personaContent: '你是一个测试助手',
    rules: [],
    skills: [],
    capabilities: [],
    ...overrides,
  };
}

/** 创建带策略覆盖的 RolePack */
function makeRolePackWithStrategy(strategy: Partial<BehaviorStrategy>): RolePack {
  return makeRolePack({ strategy });
}

// ════════════════════════════════════════════════════════
// 1. DEFAULT_BEHAVIOR_STRATEGY 默认值完整性
// ════════════════════════════════════════════════════════

describe('DEFAULT_BEHAVIOR_STRATEGY — 默认值完整性', () => {
  it('包含全部四个顶层维度', () => {
    expect(DEFAULT_BEHAVIOR_STRATEGY).toHaveProperty('prepare');
    expect(DEFAULT_BEHAVIOR_STRATEGY).toHaveProperty('act');
    expect(DEFAULT_BEHAVIOR_STRATEGY).toHaveProperty('reflect');
    expect(DEFAULT_BEHAVIOR_STRATEGY).toHaveProperty('global');
  });

  it('prepare 维度包含全部必需字段', () => {
    const p = DEFAULT_BEHAVIOR_STRATEGY.prepare!;
    expect(p.summaryFocus).toBeUndefined();
  });

  it('act 维度包含全部必需字段', () => {
    const a = DEFAULT_BEHAVIOR_STRATEGY.act!;
    expect(a.toolMode).toBe('allow');
    expect(a.toolReadonly).toBe('full');
    expect(a.toolStepLimit).toBe(20);
    expect(a.temperature).toBe(0.7);
    expect(a.outputLimit).toBe(4096);
    expect(a.providerRouting).toBe('auto');
    expect(a.multiStepReasoning).toBe('auto');
  });

  it('reflect 维度包含全部必需字段', () => {
    const r = DEFAULT_BEHAVIOR_STRATEGY.reflect!;
    expect(r.selfReview).toBe(0);
    expect(r.summary).toBe('on');
    expect(r.userFollowup).toBe('silent');
  });

  it('global 维度包含全部必需字段', () => {
    const g = DEFAULT_BEHAVIOR_STRATEGY.global!;
    // 0 = 角色包不声明，resolve 函数缺省回退 contextLimit=0（不设额外上限） / DEFAULT_MAX_ITERATIONS=50
    expect(g.contextLimit).toBe(0);
    expect(g.stepBudget).toBe(0);
    expect(g.errorHandling).toBe('retry');
    expect(g.askOn).toEqual(['ambiguity', 'decision', 'missing_info']);
    expect(g.askLimit).toBe(10);
  });
});

// ════════════════════════════════════════════════════════
// 2. resolve* 函数测试
// ════════════════════════════════════════════════════════

describe('resolve* 函数 — 基础策略解析', () => {
  // ── resolveToolMode ──
  describe('resolveToolMode', () => {
    it('合法值透传（allow / block 双向）', () => {
      expect(resolveToolMode({ act: { toolMode: 'allow' } })).toBe('allow');
      expect(resolveToolMode({ act: { toolMode: 'block' } })).toBe('block');
    });

    it('非法/缺失值回退默认 allow', () => {
      expect(resolveToolMode({ act: { toolMode: 'bad' as never } })).toBe('allow');
      expect(resolveToolMode({ act: { toolMode: undefined } })).toBe('allow');
      expect(resolveToolMode(undefined)).toBe('allow');
    });
  });

  // ── resolveSummary ──
  describe('resolveSummary', () => {
    it('合法值透传', () => {
      expect(resolveSummary({ reflect: { summary: 'off' } })).toBe('off');
    });

    it('非法/缺失值回退默认 on', () => {
      expect(resolveSummary({ reflect: { summary: 'bad' as never } })).toBe('on');
      expect(resolveSummary(undefined)).toBe('on');
    });
  });

  // ── resolveErrorHandling ──
  describe('resolveErrorHandling', () => {
    it('合法值透传', () => {
      expect(resolveErrorHandling({ global: { errorHandling: 'degrade' } })).toBe('degrade');
      expect(resolveErrorHandling({ global: { errorHandling: 'stop' } })).toBe('stop');
    });

    it('非法/缺失值回退默认 retry', () => {
      expect(resolveErrorHandling({ global: { errorHandling: 'bad' as never } })).toBe('retry');
      expect(resolveErrorHandling(undefined)).toBe('retry');
    });
  });

  // ── resolveProviderRouting ──
  describe('resolveProviderRouting', () => {
    it('合法值透传', () => {
      expect(resolveProviderRouting({ act: { providerRouting: 'fixed' } })).toBe('fixed');
    });

    it('非法/缺失值回退默认 auto', () => {
      expect(resolveProviderRouting({ act: { providerRouting: 'bad' as never } })).toBe('auto');
      expect(resolveProviderRouting(undefined)).toBe('auto');
    });
  });

  // ── resolveAskLimit ──
  describe('resolveAskLimit', () => {
    it('合法值透传', () => {
      expect(resolveAskLimit({ global: { askLimit: 5 } })).toBe(5);
    });

    it('非法/缺失值回退默认 10', () => {
      expect(resolveAskLimit({ global: { askLimit: 0 } })).toBe(10);
      expect(resolveAskLimit({ global: { askLimit: 99 } })).toBe(10);
      expect(resolveAskLimit({ global: { askLimit: '3' as never } })).toBe(10);
      expect(resolveAskLimit(undefined)).toBe(10);
    });
  });

  // ── resolveMultiStepReasoning ──
  describe('resolveMultiStepReasoning', () => {
    it('合法值透传', () => {
      expect(resolveMultiStepReasoning({ act: { multiStepReasoning: 'manual' } })).toBe('manual');
    });

    it('非法/缺失值回退默认 auto', () => {
      expect(resolveMultiStepReasoning({ act: { multiStepReasoning: 'bad' as never } })).toBe('auto');
      expect(resolveMultiStepReasoning(undefined)).toBe('auto');
    });
  });

  // ── resolveToolReadonly ──
  describe('resolveToolReadonly', () => {
    it('合法值透传', () => {
      expect(resolveToolReadonly({ act: { toolReadonly: 'readonly' } })).toBe('readonly');
    });

    it('非法/缺失值回退默认 full', () => {
      expect(resolveToolReadonly({ act: { toolReadonly: 'bad' as never } })).toBe('full');
      expect(resolveToolReadonly(undefined)).toBe('full');
    });
  });

  // ── 无 resolveUnderstandingConfirm（2026-09-13 回收：键已删，解析函数随之移除）──
});

// ════════════════════════════════════════════════════════
// 3. resolve* 函数 — 数值解析（边界测试）
// ════════════════════════════════════════════════════════

describe('resolve* 函数 — 数值解析', () => {
  // ── resolveSummaryFocus ──
  describe('resolveSummaryFocus', () => {
    it('合法非空字符串采用', () => {
      expect(resolveSummaryFocus({ prepare: { summaryFocus: '代码审查' } })).toBe('代码审查');
    });

    it('空字符串回退 undefined', () => {
      expect(resolveSummaryFocus({ prepare: { summaryFocus: '' } })).toBeUndefined();
    });

    it('纯空白字符串回退 undefined', () => {
      expect(resolveSummaryFocus({ prepare: { summaryFocus: '   ' } })).toBeUndefined();
    });

    it('非字符串（类型越界）回退 undefined', () => {
      expect(resolveSummaryFocus({ prepare: { summaryFocus: 42 as never } })).toBeUndefined();
    });

    it('自动 trim 空白', () => {
      expect(resolveSummaryFocus({ prepare: { summaryFocus: '  代码审查  ' } })).toBe('代码审查');
    });

    it('缺失回退 undefined', () => {
      expect(resolveSummaryFocus(undefined)).toBeUndefined();
    });

    it('超长字符串回退 undefined（防巨型注入）', () => {
      expect(
        resolveSummaryFocus({ prepare: { summaryFocus: 'a'.repeat(MAX_SUMMARY_FOCUS_LENGTH + 1) } }),
      ).toBeUndefined();
    });
  });

  // ── resolveToolStepLimit ──
  describe('resolveToolStepLimit', () => {
    it('合法正整数采用', () => {
      expect(resolveToolStepLimit({ act: { toolStepLimit: 50 } })).toBe(50);
    });

    it('0 表示无限制', () => {
      expect(resolveToolStepLimit({ act: { toolStepLimit: 0 } })).toBe(0);
    });

    it('负数回退默认 0', () => {
      expect(resolveToolStepLimit({ act: { toolStepLimit: -1 } })).toBe(0);
    });

    it('越上界回退默认 0（防无条件填写）', () => {
      expect(resolveToolStepLimit({ act: { toolStepLimit: MAX_TOOL_STEP_LIMIT + 1 } })).toBe(0);
    });

    it('缺失回退默认 0', () => {
      expect(resolveToolStepLimit(undefined)).toBe(0);
    });
  });

  // ── resolveContextLimit ──
  describe('resolveContextLimit', () => {
    it('合法声明值采用（≥ MIN_CONTEXT_LIMIT）', () => {
      expect(resolveContextLimit({ global: { contextLimit: 200_000 } })).toBe(200_000);
    });

    it('低于 MIN_CONTEXT_LIMIT 回退 0（低于内核默认窗口的收紧无意义）', () => {
      expect(resolveContextLimit({ global: { contextLimit: 16_000 } })).toBe(0);
    });

    it('0 表示不设额外上限（跟随 provider 窗口）', () => {
      expect(resolveContextLimit({ global: { contextLimit: 0 } })).toBe(0);
    });

    it('负数回退 0（不设额外上限）', () => {
      expect(resolveContextLimit({ global: { contextLimit: -1 } })).toBe(0);
    });

    it('小数回退 0（不设额外上限）', () => {
      expect(resolveContextLimit({ global: { contextLimit: 8000.5 } })).toBe(0);
    });

    it('越上界回退 0（防无条件填写）', () => {
      expect(resolveContextLimit({ global: { contextLimit: MAX_CONTEXT_LIMIT + 1 } })).toBe(0);
    });

    it('缺失回退 0（不设额外上限）', () => {
      expect(resolveContextLimit(undefined)).toBe(0);
    });
  });

  // ── resolveStepBudget ──
  describe('resolveStepBudget', () => {
    it('合法正整数采用', () => {
      expect(resolveStepBudget({ global: { stepBudget: 40 } })).toBe(40);
    });

    it('0 采用（loop 侧等同未声明 → maxIterations 兜底，非「不限」）', () => {
      expect(resolveStepBudget({ global: { stepBudget: 0 } })).toBe(0);
    });

    it('负数回退默认 50', () => {
      expect(resolveStepBudget({ global: { stepBudget: -1 } })).toBe(50);
    });

    it('小数回退默认 50', () => {
      expect(resolveStepBudget({ global: { stepBudget: 1.5 } })).toBe(50);
    });

    it('越上界回退默认 50（防无条件填写）', () => {
      expect(resolveStepBudget({ global: { stepBudget: MAX_STEP_BUDGET + 1 } })).toBe(50);
    });

    it('缺失回退默认 50', () => {
      expect(resolveStepBudget(undefined)).toBe(50);
    });
  });
});

// ════════════════════════════════════════════════════════
// 4. mergeStrategy 合并行为
// ════════════════════════════════════════════════════════

describe('mergeStrategy — 策略合并', () => {
  const base = DEFAULT_BEHAVIOR_STRATEGY;

  it('无覆盖时返回原 base', () => {
    const result = mergeStrategy(base, undefined);
    expect(result).toBe(base);
  });

  it('空对象覆盖时返回原 base', () => {
    const result = mergeStrategy(base, {});
    // 各维度都是空对象，合并后等于 base
    expect(result.prepare).toEqual(base.prepare);
    expect(result.act).toEqual(base.act);
    expect(result.reflect).toEqual(base.reflect);
    expect(result.global).toEqual(base.global);
  });

  it('部分覆盖：仅修改 reflect.summary', () => {
    const result = mergeStrategy(base, {
      reflect: { summary: 'off' },
    });
    expect(result.reflect!.summary).toBe('off');
    // 其他维度不变
    expect(result.act!.toolMode).toBe('allow');
  });

  it('多维度覆盖', () => {
    const result = mergeStrategy(base, {
      act: { toolMode: 'block', providerRouting: 'fixed' },
      reflect: { userFollowup: 'ask' },
    });
    expect(result.act!.toolMode).toBe('block');
    expect(result.act!.providerRouting).toBe('fixed');
    expect(result.reflect!.userFollowup).toBe('ask');
    // 未覆盖的字段保留默认值
    expect(result.act!.temperature).toBe(0.7);
  });

  it('部分覆盖 prepare.summaryFocus 生效', () => {
    const result = mergeStrategy(base, {
      prepare: { summaryFocus: '聚焦方案维度' },
    });
    // 覆盖生效；未覆盖字段保持默认
    expect(result.prepare!.summaryFocus).toBe('聚焦方案维度');
  });

  it('整段声明 undefined 时该段保留基础默认（用有真默认值的 act 段取证）', () => {
    const result = mergeStrategy(base, { act: undefined });
    // act 段基础默认见 strategyResolver.ts:55-63。此处必须断言「有真值」的字段：
    // 若换成默认值本身即 undefined 的字段（如 prepare.summaryFocus），
    // 「{...base.act, ...undefined}」「?? {}」「整段清空」三种实现都会通过 = 因错误的原因通过。
    expect(result.act!.toolMode).toBe('allow');
    expect(result.act!.temperature).toBe(0.7);
  });
});

// ════════════════════════════════════════════════════════
// 5. assembleRolePack 装配逻辑
// ════════════════════════════════════════════════════════

describe('assembleRolePack — 角色包装配', () => {
  it('基础装配：最小角色包', () => {
    const pack = makeRolePack();
    const result = assembleRolePack(pack);

    expect(result).toBeDefined();
    expect(result.meta).toBe(pack.meta);
    expect(result.personaPrompt).toContain('你是一个测试助手');
    expect(result.skills).toEqual([]);
    expect(result.capabilities).toEqual([]);
    expect(result.strategy).toBeDefined();
  });

  it('personaPrompt 注入规则', () => {
    const pack = makeRolePack({
      personaContent: '你是代码助手',
      rules: ['- 必须先理解需求', '- 输出中文注释'],
    });
    const result = assembleRolePack(pack);

    expect(result.personaPrompt).toContain('你是代码助手');
    expect(result.personaPrompt).toContain('## 规则');
    expect(result.personaPrompt).toContain('必须先理解需求');
    expect(result.personaPrompt).toContain('输出中文注释');
  });

  it('无规则时不注入规则块', () => {
    const pack = makeRolePack({ rules: [] });
    const result = assembleRolePack(pack);

    expect(result.personaPrompt).not.toContain('## 规则');
  });

  it('userFollowup=ask 时注入主动提问指令', () => {
    const pack = makeRolePackWithStrategy({
      reflect: { userFollowup: 'ask' },
      global: { askOn: ['ambiguity', 'decision'], askLimit: 2 },
    });
    const result = assembleRolePack(pack);

    expect(result.personaPrompt).toContain('## 主动提问规则');
    expect(result.personaPrompt).toContain('遇到模糊不清的情况时');
    expect(result.personaPrompt).toContain('需要用户做决策时');
    expect(result.personaPrompt).toContain('每次回答中最多提问 2 次');
    // 提问通道 = ask_user 工具引导
    expect(result.personaPrompt).toContain('ask_user');
  });

  it('userFollowup=silent 时不注入主动提问指令', () => {
    const pack = makeRolePackWithStrategy({
      reflect: { userFollowup: 'silent' },
    });
    const result = assembleRolePack(pack);

    expect(result.personaPrompt).not.toContain('主动提问规则');
  });

  it('主动提问：trigger=confirm 映射为"需要用户确认"', () => {
    const pack = makeRolePackWithStrategy({
      reflect: { userFollowup: 'ask' },
      global: { askOn: ['confirm'], askLimit: 1 },
    });
    const result = assembleRolePack(pack);

    expect(result.personaPrompt).toContain('需要用户确认');
  });

  it('主动提问：askOn 为字符串（兼容）', () => {
    const pack = makeRolePackWithStrategy({
      reflect: { userFollowup: 'ask' },
      global: { askOn: 'decision' as const, askLimit: 1 },
    });
    const result = assembleRolePack(pack);

    expect(result.personaPrompt).toContain('需要用户做决策');
  });

  it('主动提问：askOn 为空数组时不注入', () => {
    const pack = makeRolePackWithStrategy({
      reflect: { userFollowup: 'ask' },
      global: { askOn: [], askLimit: 3 },
    });
    const result = assembleRolePack(pack);

    expect(result.personaPrompt).not.toContain('主动提问规则');
  });

  it('装配后的 strategy 所有维度都有值', () => {
    const pack = makeRolePack();
    const result = assembleRolePack(pack);

    const s = result.strategy;
    expect(s.prepare).toBeDefined();
    expect(s.act).toBeDefined();
    expect(s.reflect).toBeDefined();
    expect(s.global).toBeDefined();

    // 关键字段有默认值
    expect(s.reflect!.summary).toBe('on');
    expect(s.act!.toolMode).toBe('allow');
  });

  it('装配后的 strategy 叠加角色包声明值', () => {
    const pack = makeRolePackWithStrategy({
      reflect: { summary: 'off' },
    });
    const result = assembleRolePack(pack);

    expect(result.strategy.reflect!.summary).toBe('off');
    // 其他字段仍是默认
    expect(result.strategy.act!.toolMode).toBe('allow');
  });

  it('capabilities 从角色包派生', () => {
    const caps: RolePackCapability[] = [
      { capability: 'file:read', description: '读取文件' },
    ];
    const pack = makeRolePack({ capabilities: caps });
    const result = assembleRolePack(pack);

    expect(result.capabilities).toEqual(caps);
  });

  it('skills 原样传递', () => {
    const skills = [{ file: 'skills/test.md', name: 'test-skill' }];
    const pack = makeRolePack({ skills });
    const result = assembleRolePack(pack);

    expect(result.skills).toEqual(skills);
  });

  it('personaPrompt = personaContent + 规则（无主动提问时）', () => {
    const pack = makeRolePack({
      personaContent: '你是测试',
      rules: ['- 规则1'],
    });
    const result = assembleRolePack(pack);

    // 不含主动提问时，prompt 只包含 persona + 规则
    const parts = result.personaPrompt.split('\n\n');
    expect(parts[0]).toBe('你是测试');
    expect(parts[1]).toContain('规则1');
  });
});

// ════════════════════════════════════════════════════════
// 6. 跨维度一致性
// ════════════════════════════════════════════════════════

describe('跨维度一致性', () => {
  it('mergeStrategy 不改变 DEFAULT_BEHAVIOR_STRATEGY 引用', () => {
    const original = DEFAULT_BEHAVIOR_STRATEGY;
    mergeStrategy(DEFAULT_BEHAVIOR_STRATEGY, { act: { toolMode: 'block' } });
    // 原对象不应被修改
    expect(DEFAULT_BEHAVIOR_STRATEGY.act!.toolMode).toBe('allow');
    expect(DEFAULT_BEHAVIOR_STRATEGY).toBe(original);
  });
});

// ════════════════════════════════════════════════════════
// 7. L2 运行时策略（resolveL2Strategy）
// ════════════════════════════════════════════════════════

describe('L2 运行时策略 resolveL2Strategy（收敛）', () => {
  it('无角色包声明时守恒 DEFAULT_L2_STRATEGY（整体默认值）', () => {
    expect(resolveL2Strategy(undefined)).toEqual(DEFAULT_L2_STRATEGY);
    expect(resolveL2Strategy({} as BehaviorStrategy)).toEqual(DEFAULT_L2_STRATEGY);
  });

  it('toolMode=block 映射为 toolCallsBlocked=true，其余守默认', () => {
    const s = resolveL2Strategy({ act: { toolMode: 'block' } } as BehaviorStrategy);
    expect(s.toolCallsBlocked).toBe(true);
    expect(s.errorHandling).toBe('retry');
    expect(s.providerRouting).toBe('auto');
  });

  it('selfReview=正整数映射为布尔开关 selfReviewEnabled，非法值归 false', () => {
    // 布尔数字语义（2026-09-12 定案）：任意正整数 >0 一律收敛为「开」（单次终审）
    expect(
      resolveL2Strategy({ reflect: { selfReview: 1 } } as BehaviorStrategy).selfReviewEnabled,
    ).toBe(true);
    expect(
      resolveL2Strategy({ reflect: { selfReview: 2 } } as BehaviorStrategy).selfReviewEnabled,
    ).toBe(true);
    expect(
      resolveL2Strategy({ reflect: { selfReview: 3 } } as BehaviorStrategy).selfReviewEnabled,
    ).toBe(true);
    // 负 / 小数 / 非 number 均归一为 false（关闭自审查）
    expect(
      resolveL2Strategy({ reflect: { selfReview: -1 } } as BehaviorStrategy).selfReviewEnabled,
    ).toBe(false);
    expect(
      resolveL2Strategy({ reflect: { selfReview: 2.5 } } as BehaviorStrategy).selfReviewEnabled,
    ).toBe(false);
    expect(
      resolveL2Strategy({ reflect: { selfReview: 'on' } } as unknown as BehaviorStrategy)
        .selfReviewEnabled,
    ).toBe(false);
    // 越上界归一为 false（防无条件填写）——语义上大于 1 已无额外轮数，上界仅作防御校验
    expect(
      resolveL2Strategy({ reflect: { selfReview: MAX_SELF_REVIEW_ROUNDS + 1 } } as BehaviorStrategy)
        .selfReviewEnabled,
    ).toBe(false);
  });

  it('act/global 声明值覆盖对应维度', () => {
    const s = resolveL2Strategy({
      act: { toolReadonly: 'readonly' },
      global: { contextLimit: 300_000 },
    } as BehaviorStrategy);
    expect(s.toolReadonly).toBe('readonly');
    expect(s.contextLimit).toBe(300_000);
  });
});
