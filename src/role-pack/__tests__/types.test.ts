/**
 * role-pack/types.ts 纯函数回归测试
 *
 * 覆盖两类 SSOT 兜底契约：
 *   1. resolveMemoryRecallPercent —— 记忆召回百分比 cap 的单一解析：角色包合法值（0.0~1.0）优先，
 *      缺失/越界（负、超 1、非数字、显式 undefined）一律降级内核默认。
 *   2. mergeStrategy —— 角色包覆盖后的默认兜底：未声明或空段时保留 DEFAULT_BEHAVIOR_STRATEGY
 *      完整默认，保证"开放给角色包定义的参数，内核必有硬编码兜底"。
 *
 * 背景：记忆召回百分比是"记忆摘要层占可用预算的上限 cap"（cap 非 quota）——完整对话层优先，
 * 百分比只封顶防止记忆挤占对话。
 */
import { describe, it, expect } from 'vitest';
import {
  resolveMemoryRecallPercent,
  resolveMemoryRecallMode,
  resolveMinFallback,
  resolveSummaryFocus,
  resolveToolMode,
  mergeStrategy,
  DEFAULT_BEHAVIOR_STRATEGY,
  DEFAULT_MEMORY_RECALL_PERCENT,
} from '@/role-pack/strategyResolver.js';
import type { BehaviorStrategy } from '@/role-pack/types.js';
// DEFAULT_MIN_FALLBACK 定义于 utils 共享层（SSOT），role-pack 与 memory 均引自此处
import { DEFAULT_MIN_FALLBACK } from '@/utils/recallDefaults.js';

describe('resolveMemoryRecallPercent · 记忆召回百分比 cap（SSOT 单一来源）', () => {
  it('角色包声明合法百分比（0.0~1.0）时，一律采用角色包定义', () => {
    expect(
      resolveMemoryRecallPercent({ prepare: { memoryRecallPercent: 0.6 } } as unknown as BehaviorStrategy),
    ).toBe(0.6);
    expect(
      resolveMemoryRecallPercent({ prepare: { memoryRecallPercent: 0 } } as unknown as BehaviorStrategy),
    ).toBe(0);
    expect(
      resolveMemoryRecallPercent({ prepare: { memoryRecallPercent: 1 } } as unknown as BehaviorStrategy),
    ).toBe(1);
  });

  it('未传入策略（undefined）时降级为内核默认', () => {
    expect(resolveMemoryRecallPercent(undefined)).toBe(DEFAULT_MEMORY_RECALL_PERCENT);
  });

  it('策略为空对象 / prepare 段缺失 memoryRecallPercent 时降级为内核默认', () => {
    expect(resolveMemoryRecallPercent({} as unknown as BehaviorStrategy)).toBe(
      DEFAULT_MEMORY_RECALL_PERCENT,
    );
    expect(resolveMemoryRecallPercent({ prepare: {} } as unknown as BehaviorStrategy)).toBe(
      DEFAULT_MEMORY_RECALL_PERCENT,
    );
  });

  it('memoryRecallPercent 为负数（<0）时降级为内核默认', () => {
    expect(
      resolveMemoryRecallPercent({ prepare: { memoryRecallPercent: -0.1 } } as unknown as BehaviorStrategy),
    ).toBe(DEFAULT_MEMORY_RECALL_PERCENT);
  });

  it('memoryRecallPercent 超过 1（>1）时降级为内核默认', () => {
    expect(
      resolveMemoryRecallPercent({ prepare: { memoryRecallPercent: 1.5 } } as unknown as BehaviorStrategy),
    ).toBe(DEFAULT_MEMORY_RECALL_PERCENT);
  });

  it('memoryRecallPercent 为非数字（字符串）时降级为内核默认', () => {
    expect(
      resolveMemoryRecallPercent({ prepare: { memoryRecallPercent: '0.5' } } as unknown as BehaviorStrategy),
    ).toBe(DEFAULT_MEMORY_RECALL_PERCENT);
  });

  it('memoryRecallPercent 显式为 undefined（角色包空值覆盖默认）时降级为内核默认', () => {
    expect(
      resolveMemoryRecallPercent({
        prepare: { memoryRecallPercent: undefined },
      } as unknown as BehaviorStrategy),
    ).toBe(DEFAULT_MEMORY_RECALL_PERCENT);
  });
});

describe('mergeStrategy · 角色包覆盖后的默认兜底', () => {
  it('角色包仅声明部分键时，其余键保留内核默认（兜底）', () => {
    const merged = mergeStrategy(DEFAULT_BEHAVIOR_STRATEGY, {
      prepare: { memoryRecallPercent: 0.6 },
    } as unknown as BehaviorStrategy);
    expect(merged.prepare?.memoryRecallPercent).toBe(0.6);
    expect(merged.prepare?.memoryRecall).toBe('full');
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
    expect(merged.prepare?.memoryRecallPercent).toBe(DEFAULT_MEMORY_RECALL_PERCENT);
    expect(merged.prepare?.memoryRecall).toBe('full');
  });
});

describe('枚举键解析 · SSOT 非法值归位（不透传宿主）', () => {
  it('resolveMemoryRecallMode 合法值 full/limited/none 一律采用', () => {
    expect(resolveMemoryRecallMode({ prepare: { memoryRecall: 'full' } } as unknown as BehaviorStrategy)).toBe('full');
    expect(resolveMemoryRecallMode({ prepare: { memoryRecall: 'limited' } } as unknown as BehaviorStrategy)).toBe('limited');
    expect(resolveMemoryRecallMode({ prepare: { memoryRecall: 'none' } } as unknown as BehaviorStrategy)).toBe('none');
  });

  it('resolveMemoryRecallMode 非法值归位 full', () => {
    expect(resolveMemoryRecallMode({ prepare: { memoryRecall: 'all' } } as unknown as BehaviorStrategy)).toBe('full');
    expect(resolveMemoryRecallMode({ prepare: { memoryRecall: undefined } } as unknown as BehaviorStrategy)).toBe('full');
    expect(resolveMemoryRecallMode(undefined)).toBe('full');
  });

  it('resolveMinFallback 合法非负整数（含 0）一律采用', () => {
    expect(resolveMinFallback({ prepare: { minFallback: 3 } } as unknown as BehaviorStrategy)).toBe(3);
    expect(resolveMinFallback({ prepare: { minFallback: 0 } } as unknown as BehaviorStrategy)).toBe(0); // 0=彻底关闭
  });

  it('resolveMinFallback 非法/缺失归位内核默认', () => {
    expect(resolveMinFallback(undefined)).toBe(DEFAULT_MIN_FALLBACK);
    expect(resolveMinFallback({} as unknown as BehaviorStrategy)).toBe(DEFAULT_MIN_FALLBACK);
    expect(resolveMinFallback({ prepare: {} } as unknown as BehaviorStrategy)).toBe(DEFAULT_MIN_FALLBACK);
  });

  it('resolveMinFallback 负数/非整数/非数字归位内核默认', () => {
    expect(resolveMinFallback({ prepare: { minFallback: -1 } } as unknown as BehaviorStrategy)).toBe(DEFAULT_MIN_FALLBACK);
    expect(resolveMinFallback({ prepare: { minFallback: 2.5 } } as unknown as BehaviorStrategy)).toBe(DEFAULT_MIN_FALLBACK);
    expect(resolveMinFallback({ prepare: { minFallback: '2' } } as unknown as BehaviorStrategy)).toBe(DEFAULT_MIN_FALLBACK);
  });

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
