/**
 * 单元测试：数学工具函数
 *
 * 覆盖 cosineSimilarity 余弦相似度计算，重点验证：
 *   - 相同向量返回 1
 *   - 正交向量返回 0
 *   - 反向向量返回 -1
 *   - 长度不等返回 0（短路）
 *   - 零向量（norm=0）返回 0（避免除零）
 *   - 一般情况数值正确
 */
import { describe, expect, it } from 'vitest';
import { cosineSimilarity, roundTo } from '@/utils/math.js';

describe('utils/math · roundTo', () => {
  it('默认保留 2 位小数', () => {
    expect(roundTo(3.14159)).toBe(3.14);
  });

  it('按指定小数位数四舍五入', () => {
    expect(roundTo(3.14159, 3)).toBe(3.142);
    expect(roundTo(3.14159, 0)).toBe(3);
  });

  it('正确处理向上进位', () => {
    expect(roundTo(2.675, 2)).toBeCloseTo(2.68, 10);
  });

  it('NaN/Infinity 原样返回（不参与运算）', () => {
    expect(roundTo(NaN)).toBeNaN();
    expect(roundTo(Infinity)).toBe(Infinity);
    expect(roundTo(-Infinity)).toBe(-Infinity);
  });
});

describe('utils/math · cosineSimilarity', () => {
  it('相同向量应返回 1', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
  });

  it('反向向量应返回 -1', () => {
    expect(cosineSimilarity([1, 2, 3], [-1, -2, -3])).toBeCloseTo(-1, 6);
  });

  it('正交向量应返回 0', () => {
    // [1, 0] · [0, 1] = 0
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });

  it('长度不等的向量应返回 0（短路）', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it('空向量应返回 0（长度相等但 norm=0）', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('零向量应返回 0（避免除零）', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });

  it('两边都是零向量应返回 0', () => {
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });

  it('一般情况应返回正确余弦值', () => {
    // [1, 0] · [1, 1] = 1，|a|=1，|b|=√2，cos = 1/√2 ≈ 0.7071
    expect(cosineSimilarity([1, 0], [1, 1])).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('负数分量应正确计算', () => {
    // [1, -1] · [1, 1] = 0，正交
    expect(cosineSimilarity([1, -1], [1, 1])).toBeCloseTo(0, 6);
  });

  it('单元素向量应返回 1（同号）', () => {
    expect(cosineSimilarity([5], [3])).toBeCloseTo(1, 6);
  });

  it('单元素向量应返回 -1（异号）', () => {
    expect(cosineSimilarity([5], [-3])).toBeCloseTo(-1, 6);
  });
});
