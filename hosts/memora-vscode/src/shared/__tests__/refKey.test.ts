/**
 * refKey —— 引用身份键 / 区间标签 / 区间归一化 的单点直测
 *
 * 这三个函数是「引用」的**判据层**：键决定两条引用是否同一条，标签决定用户与模型看到的写法，
 * 归一化决定非法区间能否流到 `limit = end - start + 1` 这种算式。
 * 它们曾被四处各写一遍（键 / chip 显示 / 行号 span / 信封），故此处按纯函数直测，
 * 不绕道渲染层——任何一处再各自拼串，本文件的用例不会红，但 code review 应拦住。
 */
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { dedupeRefs, formatRefRange, normalizeRefRange, refKeyOf } from '../refKey.js';

describe('normalizeRefRange（区间不变量唯一判定点）', () => {
  it('合法区间原样返回', () => {
    expect(normalizeRefRange({ start: 5, end: 24 })).toEqual({ start: 5, end: 24 });
    expect(normalizeRefRange({ start: 7, end: 7 })).toEqual({ start: 7, end: 7 });
  });

  it('缺省 / null 返回 undefined（= 整文件引用，不是错误）', () => {
    expect(normalizeRefRange(undefined)).toBeUndefined();
    expect(normalizeRefRange(null)).toBeUndefined();
  });

  it('非法区间一律 undefined：逆序 / 0 / 负数 / 非整数', () => {
    expect(normalizeRefRange({ start: 24, end: 5 })).toBeUndefined();
    expect(normalizeRefRange({ start: 0, end: 0 })).toBeUndefined();
    expect(normalizeRefRange({ start: -3, end: 2 })).toBeUndefined();
    expect(normalizeRefRange({ start: 1.5, end: 3 })).toBeUndefined();
    expect(normalizeRefRange({ start: Number.NaN, end: 3 })).toBeUndefined();
    expect(normalizeRefRange({ start: Number.POSITIVE_INFINITY, end: 3 })).toBeUndefined();
  });
});

describe('formatRefRange（显示格式唯一产地）', () => {
  it('单行折叠为 #L7，跨行写 #L5-L24', () => {
    expect(formatRefRange({ start: 7, end: 7 })).toBe('#L7');
    expect(formatRefRange({ start: 5, end: 24 })).toBe('#L5-L24');
  });

  it('无区间返回空串（不是 #Lundefined）', () => {
    expect(formatRefRange(undefined)).toBe('');
    expect(formatRefRange({ start: 9, end: 2 })).toBe('');
  });
});

describe('refKeyOf（去重判据）', () => {
  it('整文件与选区是两条引用；同文件不同区间互不相同', () => {
    const whole = refKeyOf({ path: 'src/foo.ts', kind: 'file' });
    const single = refKeyOf({ path: 'src/foo.ts', kind: 'file', range: { start: 5, end: 5 } });
    const multi = refKeyOf({ path: 'src/foo.ts', kind: 'file', range: { start: 5, end: 24 } });
    expect(new Set([whole, single, multi]).size).toBe(3);
  });

  it('单行折叠后的键不会与整文件键相撞（整文件键 = 裸 path）', () => {
    expect(refKeyOf({ path: 'a.ts', kind: 'file' })).toBe('a.ts');
    expect(refKeyOf({ path: 'a.ts', kind: 'file', range: { start: 1, end: 1 } })).toBe('a.ts#L1');
  });

  it('非法区间降级为整文件键（不与自身产生第二个身份）', () => {
    expect(refKeyOf({ path: 'a.ts', kind: 'file', range: { start: 9, end: 2 } })).toBe('a.ts');
  });
});

describe('dedupeRefs', () => {
  it('按身份键去重并保留首次出现序', () => {
    const refs = [
      { path: 'a.ts', kind: 'file' as const, range: { start: 5, end: 24 } },
      { path: 'a.ts', kind: 'file' as const, range: { start: 5, end: 24 } },
      { path: 'a.ts', kind: 'file' as const },
    ];
    expect(dedupeRefs(refs).map((r) => refKeyOf(r))).toEqual(['a.ts#L5-L24', 'a.ts']);
  });
});
