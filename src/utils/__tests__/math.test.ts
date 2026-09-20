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
import { roundTo, positiveInt, parseLimit } from '@/utils/math.js';

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

describe('utils/math · positiveInt', () => {
  it('合法正整数返回解析结果', () => {
    expect(positiveInt('42')).toBe(42);
  });

  it('缺省 / 非法 / ≤0 一律返回 undefined（默认值交给调用方）', () => {
    expect(positiveInt(undefined)).toBeUndefined();
    expect(positiveInt('abc')).toBeUndefined();
    expect(positiveInt('0')).toBeUndefined();
    expect(positiveInt('-3')).toBeUndefined();
  });
});

describe('utils/math · parseLimit', () => {
  it('合法参数返回解析值，超上限钳制到 max', () => {
    expect(parseLimit('10', 5, 30)).toBe(10);
    expect(parseLimit('99', 5, 30)).toBe(30);
  });

  it('非法 / 缺失回退默认值', () => {
    expect(parseLimit(undefined, 5, 30)).toBe(5);
    expect(parseLimit('abc', 5, 30)).toBe(5);
    expect(parseLimit('0', 5, 30)).toBe(5);
    expect(parseLimit('-1', 5, 30)).toBe(5);
  });

  it('默认值超过 max 时钳制到 max（防御）', () => {
    expect(parseLimit(undefined, 50, 30)).toBe(30);
  });
});
