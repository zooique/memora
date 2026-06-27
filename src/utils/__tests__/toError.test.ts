/**
 * 单元测试：toError 错误转换
 *
 * 覆盖 toError 的三条转换规则：
 *   - Error 实例原样返回
 *   - 含 message 属性的对象包装为 Error
 *   - 其他值通过 String() 转换
 */
import { describe, expect, it } from 'vitest';
import { toError } from '@/utils/toError.js';

describe('utils/toError · toError', () => {
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

  it('含 message 字符串属性的对象应包装为 Error', () => {
    const obj = { message: '对象错误', code: 500 };
    const result = toError(obj);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('对象错误');
  });

  it('含 message 非字符串属性的对象应走 String() 路径', () => {
    const obj = { message: 12345 };
    const result = toError(obj);
    expect(result).toBeInstanceOf(Error);
    // 对象 String() 形如 "[object Object]"
    expect(result.message).toBe('[object Object]');
  });

  it('null 应通过 String() 转换', () => {
    const result = toError(null);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('null');
  });

  it('undefined 应通过 String() 转换', () => {
    const result = toError(undefined);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('undefined');
  });

  it('字符串应通过 String() 转换', () => {
    const result = toError('字符串错误');
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('字符串错误');
  });

  it('数字应通过 String() 转换', () => {
    const result = toError(42);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('42');
  });

  it('布尔值应通过 String() 转换', () => {
    const result = toError(true);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('true');
  });

  it('数组应通过 String() 转换', () => {
    const result = toError([1, 2, 3]);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('1,2,3');
  });

  it('空对象（无 message）应走 String() 路径', () => {
    const result = toError({});
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('[object Object]');
  });
});
