/**
 * 单元测试：数组工具函数
 *
 * 覆盖 byScoreDesc 降序比较函数，重点验证：
 *   - 高 score 排前（返回正数）
 *   - 低 score 排后（返回负数）
 *   - 相等 score 返回 0（稳定排序基础）
 *   - 负 score 正确比较
 *   - 泛型兼容带额外字段的对象
 *   - 可直接用于 Array.prototype.sort
 */
import { describe, expect, it } from 'vitest';
import { byScoreDesc } from '@/utils/array.js';

describe('utils/array · byScoreDesc', () => {
  it('高 score 应排前（返回正数）', () => {
    // b.score - a.score = 0.9 - 0.1 = 0.8 > 0 → a 排后
    expect(byScoreDesc({ score: 0.1 }, { score: 0.9 })).toBeGreaterThan(0);
  });

  it('低 score 应排后（返回负数）', () => {
    // b.score - a.score = 0.1 - 0.9 = -0.8 < 0 → a 排前
    expect(byScoreDesc({ score: 0.9 }, { score: 0.1 })).toBeLessThan(0);
  });

  it('相等 score 应返回 0（稳定排序基础）', () => {
    expect(byScoreDesc({ score: 0.5 }, { score: 0.5 })).toBe(0);
  });

  it('负 score 应正确比较', () => {
    // -0.1 vs -0.9：-0.1 更大应排前
    expect(byScoreDesc({ score: -0.1 }, { score: -0.9 })).toBeLessThan(0);
  });

  it('零 score 应正确比较', () => {
    expect(byScoreDesc({ score: 0 }, { score: 0 })).toBe(0);
    expect(byScoreDesc({ score: 0 }, { score: 1 })).toBeGreaterThan(0);
  });

  it('应兼容带额外字段的泛型对象', () => {
    // 泛型 T extends { score: number }，允许附带其他字段
    interface Item {
      score: number;
      id: string;
    }
    const a: Item = { score: 0.3, id: 'a' };
    const b: Item = { score: 0.7, id: 'b' };
    expect(byScoreDesc(a, b)).toBeGreaterThan(0);
  });

  it('应可直接用于 Array.prototype.sort 降序排序', () => {
    const arr = [{ score: 0.3 }, { score: 0.9 }, { score: 0.5 }, { score: 0.1 }];
    const sorted = [...arr].sort(byScoreDesc);
    expect(sorted.map((x) => x.score)).toEqual([0.9, 0.5, 0.3, 0.1]);
  });

  it('排序后相等 score 元素的相对顺序应保持稳定', () => {
    // V8 的 sort 是稳定排序：相等元素的原始顺序保留
    const arr = [
      { score: 0.5, tag: 'first' },
      { score: 0.5, tag: 'second' },
    ];
    const sorted = arr.sort(byScoreDesc);
    expect(sorted.map((x) => x.tag)).toEqual(['first', 'second']);
  });
});
