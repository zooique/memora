/**
 * shared/toError.ts 单元测试（P0 跨进程错误转换真理源）
 *
 * 覆盖范围：
 * - Error 实例直接返回
 * - 字符串包装为 Error
 * - 含 message 属性的对象提取 message
 * - 普通对象 JSON 序列化
 * - 循环引用降级到 String()
 * - 基础类型（number/boolean/symbol/null/undefined）转换
 *
 * 与 errorHelpers.test.ts 的区别：
 * - errorHelpers 测试覆盖 re-export + reportError（渲染进程封装）
 * - 本测试直接锁定 shared/ 真理源的 5 种分支行为
 */
import { describe, it, expect } from 'vitest';
import { toError } from '../../shared/toError.js';

describe('toError', () => {
  // ─── 1. Error 实例直接返回 ─────────────────────────────

  it('Error 实例应直接返回同一引用', () => {
    const err = new Error('test error');
    expect(toError(err)).toBe(err);
  });

  it('Error 子类实例应直接返回', () => {
    class CustomError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'CustomError';
      }
    }
    const err = new CustomError('custom');
    expect(toError(err)).toBe(err);
    expect(toError(err).name).toBe('CustomError');
  });

  // ─── 2. 字符串包装为 Error ─────────────────────────────

  it('字符串应包装为 Error', () => {
    const result = toError('string error');
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('string error');
  });

  it('空字符串应包装为 Error', () => {
    const result = toError('');
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('');
  });

  // ─── 3. 含 message 属性的对象 ──────────────────────────

  it('含 message 属性的对象应提取 message', () => {
    const result = toError({ message: 'object error' });
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('object error');
  });

  it('IPC 序列化错误对象应提取 message', () => {
    // Electron IPC 序列化 Error 时会丢失原型链，但保留 message 属性
    const ipcError = { message: 'ipc serialized error', stack: 'fake stack' };
    const result = toError(ipcError);
    expect(result.message).toBe('ipc serialized error');
  });

  it('message 非 string 的对象应走 JSON 序列化', () => {
    const result = toError({ message: 123 });
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toContain('123');
  });

  // ─── 4. 普通对象 JSON 序列化 ───────────────────────────

  it('无 message 的普通对象应 JSON 序列化', () => {
    const result = toError({ code: 500, detail: 'server error' });
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe(JSON.stringify({ code: 500, detail: 'server error' }));
  });

  it('嵌套对象应完整序列化', () => {
    const result = toError({ outer: { inner: 'value' } });
    expect(result.message).toBe(JSON.stringify({ outer: { inner: 'value' } }));
  });

  // ─── 5. 循环引用降级 ───────────────────────────────────

  it('循环引用对象应降级到 String()', () => {
    const circular: Record<string, unknown> = { name: 'circular' };
    circular.self = circular;
    const result = toError(circular);
    expect(result).toBeInstanceOf(Error);
    // String(obj) 输出 [object Object]，不抛错
    expect(result.message).toContain('object');
  });

  // ─── 6. 基础类型 ───────────────────────────────────────

  it('number 应 String() 转换', () => {
    const result = toError(42);
    expect(result.message).toBe('42');
  });

  it('boolean 应 String() 转换', () => {
    const result = toError(true);
    expect(result.message).toBe('true');
  });

  it('symbol 应 String() 转换', () => {
    const sym = Symbol('test');
    const result = toError(sym);
    expect(result.message).toBe(sym.toString());
  });

  it('null 应返回"未知错误"', () => {
    const result = toError(null);
    expect(result.message).toBe('未知错误');
  });

  it('undefined 应返回"未知错误"', () => {
    const result = toError(undefined);
    expect(result.message).toBe('未知错误');
  });
});
