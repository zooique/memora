/**
 * role-pack/types.ts 纯函数回归测试
 *
 * 覆盖两类 SSOT 兜底契约：
 *   1. mergeStrategy —— 角色包覆盖后的默认兜底：未声明或空段时保留 DEFAULT_BEHAVIOR_STRATEGY
 *      完整默认，保证"开放给角色包定义的参数，内核必有硬编码兜底"。
 *   2. 枚举/字符串键解析 —— resolveToolMode / resolveSummaryFocus 的合法值透传与非法值归位。
 *
 * 背景：prepare 召回策略键族（memoryRecall/memoryRecallPercent/minFallback/contextAssembly/
 * recallConfidence/summaryRecall）已随 memory-tool-recall-design 阶段2 整体退役——记忆纯工具化
 * 召回后 prepare 无自动注入消费端，故不再有对应解析函数与默认值（见 strategyResolver.ts）。
 */
import { describe, it, expect } from 'vitest';
import {
  resolveSummaryFocus,
  resolveToolMode,
  mergeStrategy,
  DEFAULT_BEHAVIOR_STRATEGY,
} from '@/role-pack/strategyResolver.js';
import type { BehaviorStrategy } from '@/role-pack/types.js';

describe('mergeStrategy · 角色包覆盖后的默认兜底', () => {
  it('角色包仅声明部分键时，其余键保留内核默认（兜底）', () => {
    const merged = mergeStrategy(DEFAULT_BEHAVIOR_STRATEGY, {
      prepare: { summaryFocus: '聚焦方案维度' },
    } as unknown as BehaviorStrategy);
    expect(merged.prepare?.summaryFocus).toBe('聚焦方案维度');
    expect(merged.act?.toolMode).toBe('allow');
    expect(merged.reflect?.summary).toBe('on');
  });

  it('未传入覆盖策略（undefined）时返回完整默认策略', () => {
    const merged = mergeStrategy(DEFAULT_BEHAVIOR_STRATEGY, undefined);
    expect(merged).toEqual(DEFAULT_BEHAVIOR_STRATEGY);
  });

  it('角色包声明空段（undefined）时该段仍保留基础默认（spread undefined 不覆盖）', () => {
    const merged = mergeStrategy(DEFAULT_BEHAVIOR_STRATEGY, {
      prepare: undefined,
    } as unknown as BehaviorStrategy);
    expect(merged.prepare?.summaryFocus).toBeUndefined();
  });
});

describe('枚举键解析 · SSOT 非法值归位（不透传宿主）', () => {
  it('resolveToolMode 合法值 allow/block 一律采用', () => {
    expect(resolveToolMode({ act: { toolMode: 'allow' } } as unknown as BehaviorStrategy)).toBe('allow');
    expect(resolveToolMode({ act: { toolMode: 'block' } } as unknown as BehaviorStrategy)).toBe('block');
  });

  it('resolveToolMode 非法值归位 allow', () => {
    expect(resolveToolMode({ act: { toolMode: 'deny' } } as unknown as BehaviorStrategy)).toBe('allow');
    expect(resolveToolMode({ act: { toolMode: undefined } } as unknown as BehaviorStrategy)).toBe('allow');
    expect(resolveToolMode(undefined)).toBe('allow');
  });

  it('resolveSummaryFocus 合法非空字符串一律采用（去首尾空白）', () => {
    expect(resolveSummaryFocus({ prepare: { summaryFocus: '高价值代码片段' } } as unknown as BehaviorStrategy)).toBe('高价值代码片段');
    expect(resolveSummaryFocus({ prepare: { summaryFocus: '  表格关键结构  ' } } as unknown as BehaviorStrategy)).toBe('表格关键结构');
  });

  it('resolveSummaryFocus 缺失/空白/非字符串归位 undefined（通用浓缩）', () => {
    expect(resolveSummaryFocus(undefined)).toBeUndefined();
    expect(resolveSummaryFocus({} as unknown as BehaviorStrategy)).toBeUndefined();
    expect(resolveSummaryFocus({ prepare: {} } as unknown as BehaviorStrategy)).toBeUndefined();
    expect(resolveSummaryFocus({ prepare: { summaryFocus: '' } } as unknown as BehaviorStrategy)).toBeUndefined();
    expect(resolveSummaryFocus({ prepare: { summaryFocus: '   ' } } as unknown as BehaviorStrategy)).toBeUndefined();
    expect(resolveSummaryFocus({ prepare: { summaryFocus: 42 } } as unknown as BehaviorStrategy)).toBeUndefined();
  });
});