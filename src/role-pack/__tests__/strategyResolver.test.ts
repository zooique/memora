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
  resolveMemoryRecallPercent,
  resolveHandoff,
  resolveMemoryRecallMode,
  resolveMinFallback,
  resolveSummaryFocus,
  resolveToolMode,
  resolveSummary,
  resolveContextAssembly,
  resolveToolStepLimit,
  resolveErrorHandling,
  resolveProviderRouting,
  resolveInputInterrupt,
  resolveTokenBudget,
  resolveStepBudget,
  resolveTaskLoopLimit,
  resolveMultiStepReasoning,
  resolveRecallConfidence,
  resolveSummaryRecall,
  resolveToolReadonly,
  resolveToolApproval,
  resolveUnderstandingConfirm,
  mergeStrategy,
  assembleRolePack,
  resolveL2Strategy,
  DEFAULT_L2_STRATEGY,
  DEFAULT_MEMORY_RECALL_PERCENT,
} from '@/role-pack/strategyResolver.js';
import { DEFAULT_MIN_FALLBACK } from '@/utils/recallDefaults.js';
import {
  MAX_MIN_FALLBACK,
  MAX_TOOL_STEP_LIMIT,
  MAX_LOOP_CONTINUE,
  MAX_TOKEN_BUDGET,
  MAX_STEP_BUDGET,
  MAX_TASK_LOOP_LIMIT,
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
    keywords: ['test'],
    content: '测试内容',
    filePath: '/fake/path/manifest.json',
    meta: {
      name: 'test-role',
      displayName: '测试角色',
      description: '用于测试的角色包',
      version: '1.0.0',
      keywords: ['test'],
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
    expect(p.understandingConfirm).toBe('off');
    expect(p.contextAssembly).toBe('hybrid');
    expect(p.memoryRecall).toBe('full');
    expect(p.memoryRecallPercent).toBe(DEFAULT_MEMORY_RECALL_PERCENT);
    expect(p.summaryRecall).toBe('on');
    expect(p.minFallback).toBe(DEFAULT_MIN_FALLBACK);
    expect(p.recallConfidence).toBe(0.6);
  });

  it('act 维度包含全部必需字段', () => {
    const a = DEFAULT_BEHAVIOR_STRATEGY.act!;
    expect(a.toolMode).toBe('allow');
    expect(a.toolApproval).toBe('auto');
    expect(a.toolReadonly).toBe('full');
    expect(a.toolStepLimit).toBe(20);
    expect(a.streaming).toBe('streaming');
    expect(a.temperature).toBe(0.7);
    expect(a.outputLimit).toBe(4096);
    expect(a.providerRouting).toBe('auto');
    expect(a.multiStepReasoning).toBe('auto');
    expect(a.inputInterrupt).toBe('allow');
  });

  it('reflect 维度包含全部必需字段', () => {
    const r = DEFAULT_BEHAVIOR_STRATEGY.reflect!;
    expect(r.handoff).toBe('wait');
    expect(r.loopContinue).toBe(0);
    expect(r.summary).toBe('on');
    expect(r.userFollowup).toBe('silent');
  });

  it('global 维度包含全部必需字段', () => {
    const g = DEFAULT_BEHAVIOR_STRATEGY.global!;
    expect(g.tokenBudget).toBe(8000);
    expect(g.stepBudget).toBe(50);
    expect(g.errorHandling).toBe('retry');
    expect(g.askOn).toEqual(['ambiguity', 'decision', 'missing_info']);
    expect(g.askLimit).toBe(3);
  });

  it('DEFAULT_MEMORY_RECALL_PERCENT 常量与默认值一致', () => {
    expect(DEFAULT_MEMORY_RECALL_PERCENT).toBe(0.4);
    expect(DEFAULT_BEHAVIOR_STRATEGY.prepare!.memoryRecallPercent).toBe(0.4);
  });
});

// ════════════════════════════════════════════════════════
// 2. resolve* 函数测试
// ════════════════════════════════════════════════════════

describe('resolve* 函数 — 基础策略解析', () => {
  // ── resolveHandoff ──
  describe('resolveHandoff', () => {
    it('合法值透传', () => {
      expect(resolveHandoff({ reflect: { handoff: 'loop' } })).toBe('loop');
      expect(resolveHandoff({ reflect: { handoff: 'end' } })).toBe('end');
      expect(resolveHandoff({ reflect: { handoff: 'wait' } })).toBe('wait');
    });

    it('非法值回退默认 wait', () => {
      expect(resolveHandoff({ reflect: { handoff: 'invalid' as never } })).toBe('wait');
    });

    it('缺失值回退默认 wait', () => {
      expect(resolveHandoff(undefined)).toBe('wait');
      expect(resolveHandoff({})).toBe('wait');
    });
  });

  // ── resolveMemoryRecallMode ──
  describe('resolveMemoryRecallMode', () => {
    it('合法值透传', () => {
      expect(resolveMemoryRecallMode({ prepare: { memoryRecall: 'limited' } })).toBe('limited');
      expect(resolveMemoryRecallMode({ prepare: { memoryRecall: 'none' } })).toBe('none');
    });

    it('非法/缺失值回退默认 full', () => {
      expect(resolveMemoryRecallMode({ prepare: { memoryRecall: 'bad' as never } })).toBe('full');
      expect(resolveMemoryRecallMode(undefined)).toBe('full');
    });
  });

  // ── resolveToolMode ──
  describe('resolveToolMode', () => {
    it('合法值透传', () => {
      expect(resolveToolMode({ act: { toolMode: 'block' } })).toBe('block');
    });

    it('非法/缺失值回退默认 allow', () => {
      expect(resolveToolMode({ act: { toolMode: 'bad' as never } })).toBe('allow');
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

  // ── resolveContextAssembly ──
  describe('resolveContextAssembly', () => {
    it('合法值透传', () => {
      expect(resolveContextAssembly({ prepare: { contextAssembly: 'fixed' } })).toBe('fixed');
      expect(resolveContextAssembly({ prepare: { contextAssembly: 'query' } })).toBe('query');
    });

    it('非法/缺失值回退默认 hybrid', () => {
      expect(resolveContextAssembly({ prepare: { contextAssembly: 'bad' as never } })).toBe('hybrid');
      expect(resolveContextAssembly(undefined)).toBe('hybrid');
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

  // ── resolveInputInterrupt ──
  describe('resolveInputInterrupt', () => {
    it('合法值透传', () => {
      expect(resolveInputInterrupt({ act: { inputInterrupt: 'block' } })).toBe('block');
    });

    it('非法/缺失值回退默认 allow', () => {
      expect(resolveInputInterrupt({ act: { inputInterrupt: 'bad' as never } })).toBe('allow');
      expect(resolveInputInterrupt(undefined)).toBe('allow');
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

  // ── resolveSummaryRecall ──
  describe('resolveSummaryRecall', () => {
    it('合法值透传', () => {
      expect(resolveSummaryRecall({ prepare: { summaryRecall: 'off' } })).toBe('off');
    });

    it('非法/缺失值回退默认 on', () => {
      expect(resolveSummaryRecall({ prepare: { summaryRecall: 'bad' as never } })).toBe('on');
      expect(resolveSummaryRecall(undefined)).toBe('on');
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

  // ── resolveToolApproval ──
  describe('resolveToolApproval', () => {
    it('合法值透传', () => {
      expect(resolveToolApproval({ act: { toolApproval: 'confirm' } })).toBe('confirm');
    });

    it('非法/缺失值回退默认 auto', () => {
      expect(resolveToolApproval({ act: { toolApproval: 'bad' as never } })).toBe('auto');
      expect(resolveToolApproval(undefined)).toBe('auto');
    });
  });

  // ── resolveUnderstandingConfirm ──
  describe('resolveUnderstandingConfirm', () => {
    it('合法值透传', () => {
      expect(resolveUnderstandingConfirm({ prepare: { understandingConfirm: 'echo' } })).toBe('echo');
      expect(resolveUnderstandingConfirm({ prepare: { understandingConfirm: 'confirm' } })).toBe('confirm');
    });

    it('非法/缺失值回退默认 off', () => {
      expect(resolveUnderstandingConfirm({ prepare: { understandingConfirm: 'bad' as never } })).toBe('off');
      expect(resolveUnderstandingConfirm(undefined)).toBe('off');
      expect(resolveUnderstandingConfirm({})).toBe('off');
    });
  });
});

// ════════════════════════════════════════════════════════
// 3. resolve* 函数 — 数值解析（边界测试）
// ════════════════════════════════════════════════════════

describe('resolve* 函数 — 数值解析', () => {
  // ── resolveMemoryRecallPercent ──
  describe('resolveMemoryRecallPercent', () => {
    it('合法百分比（0.0~1.0）采用', () => {
      expect(resolveMemoryRecallPercent({ prepare: { memoryRecallPercent: 0.5 } })).toBe(0.5);
      expect(resolveMemoryRecallPercent({ prepare: { memoryRecallPercent: 0 } })).toBe(0);
      expect(resolveMemoryRecallPercent({ prepare: { memoryRecallPercent: 1 } })).toBe(1);
    });

    it('负数回退默认', () => {
      expect(resolveMemoryRecallPercent({ prepare: { memoryRecallPercent: -0.1 } })).toBe(
        DEFAULT_MEMORY_RECALL_PERCENT,
      );
    });

    it('超过 1 回退默认', () => {
      expect(resolveMemoryRecallPercent({ prepare: { memoryRecallPercent: 1.5 } })).toBe(
        DEFAULT_MEMORY_RECALL_PERCENT,
      );
    });

    it('非数值回退默认', () => {
      expect(resolveMemoryRecallPercent({ prepare: { memoryRecallPercent: '0.5' } as never })).toBe(
        DEFAULT_MEMORY_RECALL_PERCENT,
      );
    });

    it('缺失回退默认', () => {
      expect(resolveMemoryRecallPercent(undefined)).toBe(DEFAULT_MEMORY_RECALL_PERCENT);
      expect(resolveMemoryRecallPercent({ prepare: {} })).toBe(DEFAULT_MEMORY_RECALL_PERCENT);
    });
  });

  // ── resolveMinFallback ──
  describe('resolveMinFallback', () => {
    it('合法非负整数采用', () => {
      expect(resolveMinFallback({ prepare: { minFallback: 3 } })).toBe(3);
      expect(resolveMinFallback({ prepare: { minFallback: 0 } })).toBe(0);
    });

    it('负数回退默认', () => {
      expect(resolveMinFallback({ prepare: { minFallback: -1 } })).toBe(DEFAULT_MIN_FALLBACK);
    });

    it('越上界回退默认（防无条件填写）', () => {
      expect(resolveMinFallback({ prepare: { minFallback: MAX_MIN_FALLBACK + 1 } })).toBe(
        DEFAULT_MIN_FALLBACK,
      );
    });

    it('小数回退默认', () => {
      expect(resolveMinFallback({ prepare: { minFallback: 1.5 } })).toBe(DEFAULT_MIN_FALLBACK);
    });

    it('缺失/非数值回退默认', () => {
      expect(resolveMinFallback(undefined)).toBe(DEFAULT_MIN_FALLBACK);
    });
  });

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

  // ── resolveTokenBudget ──
  describe('resolveTokenBudget', () => {
    it('合法正整数采用', () => {
      expect(resolveTokenBudget({ global: { tokenBudget: 16000 } })).toBe(16000);
    });

    it('0 表示不限制', () => {
      expect(resolveTokenBudget({ global: { tokenBudget: 0 } })).toBe(0);
    });

    it('负数回退默认 8000', () => {
      expect(resolveTokenBudget({ global: { tokenBudget: -1 } })).toBe(8000);
    });

    it('小数回退默认 8000', () => {
      expect(resolveTokenBudget({ global: { tokenBudget: 8000.5 } })).toBe(8000);
    });

    it('越上界回退默认 8000（防无条件填写）', () => {
      expect(resolveTokenBudget({ global: { tokenBudget: MAX_TOKEN_BUDGET + 1 } })).toBe(8000);
    });

    it('缺失回退默认 8000', () => {
      expect(resolveTokenBudget(undefined)).toBe(8000);
    });
  });

  // ── resolveStepBudget ──
  describe('resolveStepBudget', () => {
    it('合法正整数采用', () => {
      expect(resolveStepBudget({ global: { stepBudget: 100 } })).toBe(100);
    });

    it('0 表示不限制', () => {
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

  // ── resolveTaskLoopLimit（阶段 3 外部任务循环步数上限）──
  describe('resolveTaskLoopLimit', () => {
    it('合法正整数采用', () => {
      expect(resolveTaskLoopLimit({ global: { taskLoopLimit: 5 } })).toBe(5);
    });

    it('0 表示关闭外部任务循环', () => {
      expect(resolveTaskLoopLimit({ global: { taskLoopLimit: 0 } })).toBe(0);
    });

    it('负数回退默认 10', () => {
      expect(resolveTaskLoopLimit({ global: { taskLoopLimit: -1 } })).toBe(10);
    });

    it('小数回退默认 10', () => {
      expect(resolveTaskLoopLimit({ global: { taskLoopLimit: 3.14 } })).toBe(10);
    });

    it('越上界回退默认 10（防无条件填写）', () => {
      expect(resolveTaskLoopLimit({ global: { taskLoopLimit: MAX_TASK_LOOP_LIMIT + 1 } })).toBe(10);
    });

    it('缺失回退默认 10', () => {
      expect(resolveTaskLoopLimit(undefined)).toBe(10);
    });
  });

  // ── resolveRecallConfidence ──
  describe('resolveRecallConfidence', () => {
    it('0.0~1.0 范围内采用', () => {
      expect(resolveRecallConfidence({ prepare: { recallConfidence: 0.8 } })).toBe(0.8);
      expect(resolveRecallConfidence({ prepare: { recallConfidence: 0.0 } })).toBe(0.0);
      expect(resolveRecallConfidence({ prepare: { recallConfidence: 1.0 } })).toBe(1.0);
    });

    it('超出范围回退 0.3', () => {
      expect(resolveRecallConfidence({ prepare: { recallConfidence: 1.5 } })).toBe(0.3);
      expect(resolveRecallConfidence({ prepare: { recallConfidence: -0.1 } })).toBe(0.3);
    });

    it('缺失回退 0.3', () => {
      expect(resolveRecallConfidence(undefined)).toBe(0.3);
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

  it('部分覆盖：仅修改 handoff', () => {
    const result = mergeStrategy(base, {
      reflect: { handoff: 'loop' },
    });
    expect(result.reflect!.handoff).toBe('loop');
    // 其他维度不变
    expect(result.prepare!.memoryRecall).toBe('full');
    expect(result.act!.toolMode).toBe('allow');
  });

  it('多维度覆盖', () => {
    const result = mergeStrategy(base, {
      prepare: { memoryRecall: 'none' },
      act: { toolMode: 'block', providerRouting: 'fixed' },
      reflect: { handoff: 'end' },
    });
    expect(result.prepare!.memoryRecall).toBe('none');
    expect(result.act!.toolMode).toBe('block');
    expect(result.act!.providerRouting).toBe('fixed');
    expect(result.reflect!.handoff).toBe('end');
    // 未覆盖的字段保留默认值
    expect(result.act!.temperature).toBe(0.7);
  });

  it('空值覆盖不影响已有字段', () => {
    const result = mergeStrategy(base, {
      prepare: { memoryRecall: 'none' },
    });
    // 其他 prepare 字段保持默认
    expect(result.prepare!.memoryRecall).toBe('none');
    expect(result.prepare!.contextAssembly).toBe('hybrid');
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
    expect(result.personaPrompt).toContain('每轮最多提问 2 次');
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

  it('understandingConfirm=off 时不注入理解确认指令', () => {
    const pack = makeRolePackWithStrategy({ prepare: { understandingConfirm: 'off' } });
    const result = assembleRolePack(pack);

    expect(result.personaPrompt).not.toContain('## 理解确认');
  });

  it('understandingConfirm=echo 时注入"复述但不等待"指令', () => {
    const pack = makeRolePackWithStrategy({ prepare: { understandingConfirm: 'echo' } });
    const result = assembleRolePack(pack);

    expect(result.personaPrompt).toContain('## 理解确认');
    expect(result.personaPrompt).toContain('复述你对用户意图的理解');
    expect(result.personaPrompt).toContain('不等待用户确认');
  });

  it('understandingConfirm=confirm 时注入"复述并等待确认"指令', () => {
    const pack = makeRolePackWithStrategy({ prepare: { understandingConfirm: 'confirm' } });
    const result = assembleRolePack(pack);

    expect(result.personaPrompt).toContain('## 理解确认');
    expect(result.personaPrompt).toContain('待用户确认后再正式作答');
  });

  it('默认（未声明）不注入理解确认指令', () => {
    const pack = makeRolePack();
    const result = assembleRolePack(pack);

    expect(result.personaPrompt).not.toContain('## 理解确认');
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
    expect(s.reflect!.handoff).toBe('wait');
    expect(s.act!.toolMode).toBe('allow');
  });

  it('装配后的 strategy 叠加角色包声明值', () => {
    const pack = makeRolePackWithStrategy({
      reflect: { handoff: 'loop' },
    });
    const result = assembleRolePack(pack);

    expect(result.strategy.reflect!.handoff).toBe('loop');
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
  it('DEFAULT_BEHAVIOR_STRATEGY 的 prepare.memoryRecallPercent 与 DEFAULT_MEMORY_RECALL_PERCENT 一致', () => {
    expect(DEFAULT_BEHAVIOR_STRATEGY.prepare!.memoryRecallPercent).toBe(DEFAULT_MEMORY_RECALL_PERCENT);
  });

  it('resolveMemoryRecallPercent(undefined) 与 DEFAULT_MEMORY_RECALL_PERCENT 一致', () => {
    expect(resolveMemoryRecallPercent(undefined)).toBe(DEFAULT_MEMORY_RECALL_PERCENT);
  });

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

  it('loopContinue=N（正整数）映射为 maxSelfReviewRounds，非法值归 0', () => {
    expect(
      resolveL2Strategy({ reflect: { loopContinue: 3 } } as BehaviorStrategy).maxSelfReviewRounds,
    ).toBe(3);
    // 负 / 小数 / 非 number 均归一为 0（关闭自审查）
    expect(
      resolveL2Strategy({ reflect: { loopContinue: -1 } } as BehaviorStrategy).maxSelfReviewRounds,
    ).toBe(0);
    expect(
      resolveL2Strategy({ reflect: { loopContinue: 2.5 } } as BehaviorStrategy).maxSelfReviewRounds,
    ).toBe(0);
    expect(
      resolveL2Strategy({ reflect: { loopContinue: 'on' } } as unknown as BehaviorStrategy)
        .maxSelfReviewRounds,
    ).toBe(0);
    // 越上界归一为 0（防无条件填写导致无限自审查）
    expect(
      resolveL2Strategy({ reflect: { loopContinue: MAX_LOOP_CONTINUE + 1 } } as BehaviorStrategy)
        .maxSelfReviewRounds,
    ).toBe(0);
  });

  it('act/global 声明值覆盖对应维度', () => {
    const s = resolveL2Strategy({
      act: { toolApproval: 'confirm', toolReadonly: 'readonly' },
      global: { tokenBudget: 120 },
    } as BehaviorStrategy);
    expect(s.toolApproval).toBe('confirm');
    expect(s.toolReadonly).toBe('readonly');
    expect(s.tokenBudget).toBe(120);
  });
});
