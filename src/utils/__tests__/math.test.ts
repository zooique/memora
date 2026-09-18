/**
 * 单元测试：数学工具函数
 *
 * 覆盖 roundTo 四舍五入，重点验证：
 *   - 默认保留 2 位小数
 *   - 按指定小数位数四舍五入
 *   - 正确处理向上进位
 *   - NaN/Infinity 原样返回（不参与运算）
 */
import { describe, expect, it } from 'vitest';
import { roundTo } from '@/utils/math.js';

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
