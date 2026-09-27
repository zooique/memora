/**
 * 单元测试：数组工具函数
 *
 * 覆盖 byAccessedDesc 降序比较函数（score 退役后
 * 以 accessedAt 作为使用轨迹唯一事实源），重点验证：
 *   - 更新的 accessedAt 排前（返回正数）
 *   - 更旧的 accessedAt 排后（返回负数）
 *   - 相等 accessedAt 返回 0（稳定排序基础）
 *   - 泛型兼容带额外字段的对象
 *   - 可直接用于 Array.prototype.sort
 */
import { describe, expect, it } from 'vitest';
import { byAccessedDesc } from '@/utils/array.js';

describe('utils/array · byAccessedDesc', () => {
  it('更新的 accessedAt 应排前（返回正数）', () => {
    // a.accessedAt < b.accessedAt → a 排后，返回正数
    expect(
      byAccessedDesc(
        { accessedAt: '2026-01-01T00:00:00.000Z' },
        { accessedAt: '2026-01-09T00:00:00.000Z' },
      ),
    ).toBeGreaterThan(0);
  });

  it('更旧的 accessedAt 应排后（返回负数）', () => {
    expect(
      byAccessedDesc(
        { accessedAt: '2026-01-09T00:00:00.000Z' },
        { accessedAt: '2026-01-01T00:00:00.000Z' },
      ),
    ).toBeLessThan(0);
  });

  it('相等 accessedAt 应返回 0（稳定排序基础）', () => {
    expect(
      byAccessedDesc(
        { accessedAt: '2026-01-05T00:00:00.000Z' },
        { accessedAt: '2026-01-05T00:00:00.000Z' },
      ),
    ).toBe(0);
  });

  it('应兼容带额外字段的泛型对象', () => {
    // 泛型 T extends { accessedAt: string }，允许附带其他字段
    interface Item {
      accessedAt: string;
      id: string;
    }
    const a: Item = { accessedAt: '2026-01-01T00:00:00.000Z', id: 'a' };
    const b: Item = { accessedAt: '2026-01-07T00:00:00.000Z', id: 'b' };
    expect(byAccessedDesc(a, b)).toBeGreaterThan(0);
  });

  it('应可直接用于 Array.prototype.sort 降序排序', () => {
    const arr = [
      { accessedAt: '2026-01-03T00:00:00.000Z' },
      { accessedAt: '2026-01-09T00:00:00.000Z' },
      { accessedAt: '2026-01-05T00:00:00.000Z' },
      { accessedAt: '2026-01-01T00:00:00.000Z' },
    ];
    const sorted = [...arr].sort(byAccessedDesc);
    expect(sorted.map((x) => x.accessedAt)).toEqual([
      '2026-01-09T00:00:00.000Z',
      '2026-01-05T00:00:00.000Z',
      '2026-01-03T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    ]);
  });

  it('排序后相等 accessedAt 元素的相对顺序应保持稳定', () => {
    // V8 的 sort 是稳定排序：相等元素的原始顺序保留
    const arr = [
      { accessedAt: '2026-01-05T00:00:00.000Z', tag: 'first' },
      { accessedAt: '2026-01-05T00:00:00.000Z', tag: 'second' },
    ];
    const sorted = [...arr].sort(byAccessedDesc);
    expect(sorted.map((x) => x.tag)).toEqual(['first', 'second']);
  });
});
