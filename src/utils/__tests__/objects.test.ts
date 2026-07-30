/**
 * 单元测试：对象类型守卫工具函数
 *
 * 覆盖 isPlainObject，重点验证：
 *   - 普通对象返回 true 并收窄类型
 *   - null / undefined 返回 false
 *   - 数组返回 false（即使空数组）
 *   - 原始值（字符串/数字/布尔）返回 false
 *   - 函数返回 false
 *
 * 实现契约边界：本函数仅排除 null / 数组 / 非对象类型，
 * 不区分类实例（Date / Error / Map 等 typeof === 'object' 的值视为普通对象）。
 * 调用场景为 JSON.parse 结果校验，JSON 不会产生类实例，此边界不影响调用正确性。
 */
import { describe, expect, it } from 'vitest';
import { isPlainObject } from '@/utils/objects.js';

describe('utils/objects · isPlainObject', () => {
  it('空对象应返回 true', () => {
    expect(isPlainObject({ })).toBe(true);
  });

  it('带属性的对象应返回 true', () => {
    expect(isPlainObject({ a: 1, b: 'x' })).toBe(true);
  });

  it('JSON.parse 结果应返回 true', () => {
    // 典型使用场景：校验 JSON.parse 的结果
    expect(isPlainObject(JSON.parse('{"key":"value"}'))).toBe(true);
  });

  it('null 应返回 false', () => {
    // typeof null === 'object'，需显式排除
    expect(isPlainObject(null)).toBe(false);
  });

  it('undefined 应返回 false', () => {
    expect(isPlainObject(undefined)).toBe(false);
  });

  it('空数组应返回 false', () => {
    // 数组 typeof === 'object'，需通过 Array.isArray 排除
    expect(isPlainObject([])).toBe(false);
  });

  it('非空数组应返回 false', () => {
    expect(isPlainObject([1, 2, 3])).toBe(false);
  });

  it('字符串应返回 false', () => {
    expect(isPlainObject('hello')).toBe(false);
  });

  it('数字应返回 false', () => {
    expect(isPlainObject(42)).toBe(false);
  });

  it('布尔值应返回 false', () => {
    expect(isPlainObject(true)).toBe(false);
  });

  it('Date 实例应返回 true（实现不区分类实例）', () => {
    // 契约边界：typeof === 'object' 且非 null 非数组即视为普通对象
    // 调用场景为 JSON.parse 校验，JSON 不会产生 Date，此行为不影响正确性
    expect(isPlainObject(new Date())).toBe(true);
  });

  it('Error 实例应返回 true（实现不区分类实例）', () => {
    expect(isPlainObject(new Error('err'))).toBe(true);
  });

  it('Map 实例应返回 true（实现不区分类实例）', () => {
    expect(isPlainObject(new Map())).toBe(true);
  });

  it('函数应返回 false', () => {
    expect(isPlainObject(() => { })).toBe(false);
  });

  it('Object.create(null) 应返回 true', () => {
    // 无原型对象，typeof === 'object' 且非 null 非数组 → 视为普通对象
    expect(isPlainObject(Object.create(null))).toBe(true);
  });
});
