/**
 * LoopMetrics 单测（ARCH-3 P3-6 下沉后补）
 *
 * 纯值对象：11 个计数字段 + 3 个派生 getter 的**除法保护**（分母为 0 时不得返回 NaN）。
 */

import { describe, it, expect } from 'vitest';
import { LoopMetrics } from '@/agent/managers/loopMetrics.js';

describe('LoopMetrics', () => {
  it('初始值全为 0，派生指标不产生 NaN（分母保护）', () => {
    const m = new LoopMetrics();
    expect(m.llmCallCount).toBe(0);
    expect(m.hitRate).toBe(0);
    expect(m.taskSuccessRate).toBe(0);
    expect(m.taskAvgDurationMs).toBe(0);
    expect(Number.isNaN(m.hitRate)).toBe(false);
    expect(Number.isNaN(m.taskSuccessRate)).toBe(false);
  });

  it('hitRate = 命中 / 总数', () => {
    const m = new LoopMetrics();
    m.recallTotalCount = 4;
    m.recallHitCount = 3;
    expect(m.hitRate).toBe(0.75);
  });

  it('taskSuccessRate = 成功 / 总数', () => {
    const m = new LoopMetrics();
    m.taskTotalCount = 4;
    m.taskSuccessCount = 1;
    expect(m.taskSuccessRate).toBe(0.25);
  });

  it('taskAvgDurationMs 四舍五入', () => {
    const m = new LoopMetrics();
    m.taskTotalCount = 3;
    m.taskTotalDurationMs = 10;
    expect(m.taskAvgDurationMs).toBe(3); // 3.33 → 3
  });

  it('两个 LoopMetrics 实例互不共享状态（引用共享需由调用方保证）', () => {
    const a = new LoopMetrics();
    const b = new LoopMetrics();
    a.llmCallCount = 5;
    expect(b.llmCallCount).toBe(0);
  });
});
