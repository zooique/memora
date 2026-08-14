/**
 * role-pack/types.ts 纯函数回归测试
 *
 * 覆盖两类 SSOT 兜底契约：
 *   1. resolveRecentRounds —— 上下文固定加载轮数 N 的单一解析：角色包合法值优先，
 *      缺失/非法（0、负数、非整数、非数字、显式 undefined）一律降级内核默认。
 *   2. mergeStrategy —— 角色包覆盖后的默认兜底：未声明或空段时保留 DEFAULT_BEHAVIOR_STRATEGY
 *      完整默认，保证"开放给角色包定义的参数，内核必有硬编码兜底"。
 *
 * 背景：互斥窗口与最近对话注入共用 resolveRecentRounds 的返回值（memory-as-summary §4.3），
 * 任何一条分支损坏都会导致"正文加载轮数 ≠ 互斥排除轮数"的重复注入。
 */
import { describe, it, expect } from 'vitest';
import {
  resolveRecentRounds,
  resolveHandoff,
  resolveMemoryRecallMode,
  resolveToolMode,
  mergeStrategy,
  DEFAULT_BEHAVIOR_STRATEGY,
  DEFAULT_RECENT_HISTORY_ROUNDS,
  type BehaviorStrategy,
} from '@/role-pack/types.js';

describe('resolveRecentRounds · 上下文字段固定加载轮数 N（SSOT 单一来源）', () => {
  it('角色包声明合法正整数时，一律采用角色包定义', () => {
    expect(resolveRecentRounds({ prepare: { recentRounds: 5 } } as unknown as BehaviorStrategy)).toBe(5);
    expect(resolveRecentRounds({ prepare: { recentRounds: 1 } } as unknown as BehaviorStrategy)).toBe(1);
  });

  it('未传入策略（undefined）时降级为内核默认', () => {
    expect(resolveRecentRounds(undefined)).toBe(DEFAULT_RECENT_HISTORY_ROUNDS);
  });

  it('策略为空对象 / prepare 段缺失 recentRounds 时降级为内核默认', () => {
    expect(resolveRecentRounds({} as unknown as BehaviorStrategy)).toBe(DEFAULT_RECENT_HISTORY_ROUNDS);
    expect(resolveRecentRounds({ prepare: {} } as unknown as BehaviorStrategy)).toBe(
      DEFAULT_RECENT_HISTORY_ROUNDS,
    );
  });

  it('recentRounds 为 0（非"0 以上正整数"）时降级为内核默认', () => {
    expect(resolveRecentRounds({ prepare: { recentRounds: 0 } } as unknown as BehaviorStrategy)).toBe(
      DEFAULT_RECENT_HISTORY_ROUNDS,
    );
  });

  it('recentRounds 为负数时降级为内核默认', () => {
    expect(resolveRecentRounds({ prepare: { recentRounds: -1 } } as unknown as BehaviorStrategy)).toBe(
      DEFAULT_RECENT_HISTORY_ROUNDS,
    );
  });

  it('recentRounds 为非整数（小数）时降级为内核默认', () => {
    expect(resolveRecentRounds({ prepare: { recentRounds: 2.5 } } as unknown as BehaviorStrategy)).toBe(
      DEFAULT_RECENT_HISTORY_ROUNDS,
    );
  });

  it('recentRounds 为非数字（字符串）时降级为内核默认', () => {
    expect(resolveRecentRounds({ prepare: { recentRounds: '5' } } as unknown as BehaviorStrategy)).toBe(
      DEFAULT_RECENT_HISTORY_ROUNDS,
    );
  });

  it('recentRounds 显式为 undefined（角色包空值覆盖默认）时降级为内核默认', () => {
    expect(
      resolveRecentRounds({ prepare: { recentRounds: undefined } } as unknown as BehaviorStrategy),
    ).toBe(DEFAULT_RECENT_HISTORY_ROUNDS);
  });
});

describe('mergeStrategy · 角色包覆盖后的默认兜底', () => {
  it('角色包仅声明部分键时，其余键保留内核默认（兜底）', () => {
    const merged = mergeStrategy(DEFAULT_BEHAVIOR_STRATEGY, {
      prepare: { recentRounds: 5 },
    } as unknown as BehaviorStrategy);
    expect(merged.prepare?.recentRounds).toBe(5);
    expect(merged.prepare?.memoryRecall).toBe('full');
    expect(merged.act?.toolMode).toBe('allow');
    expect(merged.reflect?.handoff).toBe('wait');
  });

  it('未传入覆盖策略（undefined）时返回完整默认策略', () => {
    const merged = mergeStrategy(DEFAULT_BEHAVIOR_STRATEGY, undefined);
    expect(merged).toEqual(DEFAULT_BEHAVIOR_STRATEGY);
  });

  it('角色包声明空段（undefined）时该段仍保留基础默认（spread undefined 不覆盖）', () => {
    const merged = mergeStrategy(DEFAULT_BEHAVIOR_STRATEGY, {
      prepare: undefined,
    } as unknown as BehaviorStrategy);
    expect(merged.prepare?.recentRounds).toBe(DEFAULT_RECENT_HISTORY_ROUNDS);
    expect(merged.prepare?.memoryRecall).toBe('full');
  });
});

describe('枚举键解析 · SSOT 非法值归位（不透传宿主）', () => {
  it('resolveHandoff 合法值 wait/loop/end 一律采用', () => {
    expect(resolveHandoff({ reflect: { handoff: 'wait' } } as unknown as BehaviorStrategy)).toBe('wait');
    expect(resolveHandoff({ reflect: { handoff: 'loop' } } as unknown as BehaviorStrategy)).toBe('loop');
    expect(resolveHandoff({ reflect: { handoff: 'end' } } as unknown as BehaviorStrategy)).toBe('end');
  });

  it('resolveHandoff 非法值（拼写错误/undefined/空策略）归位 wait', () => {
    expect(resolveHandoff({ reflect: { handoff: 'blcok' } } as unknown as BehaviorStrategy)).toBe('wait');
    expect(resolveHandoff({ reflect: { handoff: undefined } } as unknown as BehaviorStrategy)).toBe('wait');
    expect(resolveHandoff({} as unknown as BehaviorStrategy)).toBe('wait');
    expect(resolveHandoff(undefined)).toBe('wait');
  });

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

  it('resolveToolMode 合法值 allow/block 一律采用', () => {
    expect(resolveToolMode({ act: { toolMode: 'allow' } } as unknown as BehaviorStrategy)).toBe('allow');
    expect(resolveToolMode({ act: { toolMode: 'block' } } as unknown as BehaviorStrategy)).toBe('block');
  });

  it('resolveToolMode 非法值归位 allow', () => {
    expect(resolveToolMode({ act: { toolMode: 'deny' } } as unknown as BehaviorStrategy)).toBe('allow');
    expect(resolveToolMode({ act: { toolMode: undefined } } as unknown as BehaviorStrategy)).toBe('allow');
    expect(resolveToolMode(undefined)).toBe('allow');
  });
});