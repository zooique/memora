/**
 * 单元测试：toError 错误转换
 *
 * 覆盖 toError 的 5 条转换规则（与精灵 shared/toError.ts 行为对齐）：
 *   - Error 实例原样返回
 *   - 字符串包装为 Error
 *   - 含 message 属性的对象提取 message
 *   - 普通对象 JSON 序列化（含循环引用降级）
 *   - 基础类型（number/boolean/symbol/null/undefined）转换
 */
import { describe, expect, it } from 'vitest';
import { toError } from '@/utils/toError.js';

describe('utils/toError · toError', () => {
  // ─── 1. Error 实例 ───────────────────────────────────────

  it('Error 实例应原样返回（同一引用）', () => {
    const err = new Error('原始错误');
    expect(toError(err)).toBe(err);
  });

  it('Error 子类实例应原样返回', () => {
    class CustomError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'CustomError';
      }
    }
    const err = new CustomError('自定义错误');
    expect(toError(err)).toBe(err);
    expect(toError(err).name).toBe('CustomError');
  });

  // ─── 2. 字符串 ─────────────────────────────────────────

  it('字符串应包装为 Error', () => {
    const result = toError('字符串错误');
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('字符串错误');
  });

  it('空字符串应包装为 Error', () => {
    const result = toError('');
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('');
  });

  // ─── 3. 含 message 属性的对象 ──────────────────────────

  it('含 message 字符串属性的对象应包装为 Error', () => {
    const obj = { message: '对象错误', code: 500 };
    const result = toError(obj);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('对象错误');
  });

  it('IPC 序列化错误对象应提取 message（Electron IPC 丢失原型链但保留 message）', () => {
    const ipcError = { message: 'ipc 错误', stack: 'fake stack' };
    const result = toError(ipcError);
    expect(result.message).toBe('ipc 错误');
  });

  it('message 非 string 的对象应走 JSON 序列化路径', () => {
    const obj = { message: 12345 };
    const result = toError(obj);
    expect(result).toBeInstanceOf(Error);
    // JSON 序列化包含 12345
    expect(result.message).toContain('12345');
  });

  // ─── 4. 普通对象 JSON 序列化 ───────────────────────────

  it('无 message 的普通对象应 JSON 序列化', () => {
    const result = toError({ code: 500, detail: 'server error' });
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe(JSON.stringify({ code: 500, detail: 'server error' }));
  });

  it('空对象（无 message）应 JSON 序列化为 "{}"', () => {
    const result = toError({});
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('{}');
  });

  it('嵌套对象应完整序列化', () => {
    const result = toError({ outer: { inner: 'value' } });
    expect(result.message).toBe(JSON.stringify({ outer: { inner: 'value' } }));
  });

  it('数组应 JSON 序列化（与 String() 的逗号拼接区分）', () => {
    const result = toError([1, 2, 3]);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('[1,2,3]');
  });

  it('循环引用对象应降级到 String()', () => {
    const circular: Record<string, unknown> = { name: 'circular' };
    circular.self = circular;
    const result = toError(circular);
    expect(result).toBeInstanceOf(Error);
    // String(obj) 输出 [object Object]，不抛错
    expect(result.message).toContain('object');
  });

  // ─── 5. 基础类型 ───────────────────────────────────────

  it('null 应返回"未知错误"（比 "null" 更友好）', () => {
    const result = toError(null);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('未知错误');
  });

  it('undefined 应返回"未知错误"', () => {
    const result = toError(undefined);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('未知错误');
  });

  it('数字应 String() 转换', () => {
    const result = toError(42);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('42');
  });

  it('布尔值应 String() 转换', () => {
    const result = toError(true);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('true');
  });

  it('symbol 应 String() 转换', () => {
    const sym = Symbol('test');
    const result = toError(sym);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe(sym.toString());
  });
});
