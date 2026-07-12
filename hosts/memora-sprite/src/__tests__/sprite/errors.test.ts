/**
 * errors 单元测试
 *
 * 覆盖范围：
 * - ErrorCode 枚举：9 个枚举值存在 + 值与键名一致 + 值唯一
 * - MemoraError 类：继承 Error + instanceof + name/code/message + context + cause 透传 + throw/catch
 *
 * 测试策略：
 * - 零 mock，纯逻辑验证
 * - 不使用 @ts-ignore 或 as any
 */
import { describe, it, expect } from 'vitest';
import { ErrorCode, MemoraError } from '../../sprite/errors.js';

describe('errors', () => {
  // ─── ErrorCode 枚举（3 测试） ──────────────────────────

  describe('ErrorCode 枚举', () => {
    it('9 个枚举值存在且值正确', () => {
      expect(ErrorCode.UNKNOWN).toBe('UNKNOWN');
      expect(ErrorCode.INITIALIZATION_FAILED).toBe('INITIALIZATION_FAILED');
      expect(ErrorCode.CONFIG_LOAD_FAILED).toBe('CONFIG_LOAD_FAILED');
      expect(ErrorCode.WINDOW_CREATE_FAILED).toBe('WINDOW_CREATE_FAILED');
      expect(ErrorCode.FILE_READ_FAILED).toBe('FILE_READ_FAILED');
      expect(ErrorCode.NETWORK_ERROR).toBe('NETWORK_ERROR');
      expect(ErrorCode.API_ERROR).toBe('API_ERROR');
      expect(ErrorCode.STORAGE_ERROR).toBe('STORAGE_ERROR');
      expect(ErrorCode.VALIDATION_ERROR).toBe('VALIDATION_ERROR');
    });

    it('枚举值与键名一致（string enum 反向映射）', () => {
      const keys = Object.keys(ErrorCode);
      expect(keys).toHaveLength(9);
      for (const key of keys) {
        // string enum 的值与键名相同（UNKNOWN = 'UNKNOWN'）
        expect(ErrorCode[key as keyof typeof ErrorCode]).toBe(key);
      }
    });

    it('枚举值唯一（无重复）', () => {
      const values = Object.values(ErrorCode);
      const uniqueValues = new Set(values);
      expect(uniqueValues.size).toBe(values.length);
    });
  });

  // ─── MemoraError（8 测试） ─────────────────────────────

  describe('MemoraError', () => {
    it('继承 Error 且 instanceof MemoraError', () => {
      const err = new MemoraError(ErrorCode.UNKNOWN, 'something went wrong');
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(MemoraError);
    });

    it('name 属性为 MemoraError', () => {
      const err = new MemoraError(ErrorCode.STORAGE_ERROR, 'storage down');
      expect(err.name).toBe('MemoraError');
    });

    it('code 属性为传入的 ErrorCode', () => {
      const err = new MemoraError(ErrorCode.FILE_READ_FAILED, 'read failed');
      expect(err.code).toBe(ErrorCode.FILE_READ_FAILED);
    });

    it('message 属性为传入的 message', () => {
      const err = new MemoraError(ErrorCode.NETWORK_ERROR, 'connection timeout');
      expect(err.message).toBe('connection timeout');
    });

    it('未传 options 时 context 为 undefined', () => {
      const err = new MemoraError(ErrorCode.UNKNOWN, 'no options');
      expect(err.context).toBeUndefined();
    });

    it('传入 options.context 时 context 为该对象', () => {
      const context = { filePath: '/tmp/test.txt', line: 42 };
      const err = new MemoraError(ErrorCode.FILE_READ_FAILED, 'read failed', { context });
      expect(err.context).toBe(context);
      expect(err.context?.filePath).toBe('/tmp/test.txt');
      expect(err.context?.line).toBe(42);
    });

    it('options.cause 透传到 super（error.cause === 传入的 cause）', () => {
      const rootCause = new Error('root cause');
      const err = new MemoraError(ErrorCode.STORAGE_ERROR, 'wrap', { cause: rootCause });
      expect(err.cause).toBe(rootCause);
    });

    it('同时传 cause + context 时两者均生效', () => {
      const rootCause = new TypeError('type mismatch');
      const context = { field: 'username', received: 'number' };
      const err = new MemoraError(ErrorCode.VALIDATION_ERROR, 'validation failed', {
        cause: rootCause,
        context,
      });
      expect(err.cause).toBe(rootCause);
      expect(err.context).toBe(context);
      expect(err.code).toBe(ErrorCode.VALIDATION_ERROR);
      expect(err.message).toBe('validation failed');
      expect(err.name).toBe('MemoraError');
    });

    it('throw 后能被 catch 且携带 code', () => {
      try {
        throw new MemoraError(ErrorCode.API_ERROR, 'api rate limit');
      } catch (err) {
        expect(err).toBeInstanceOf(MemoraError);
        const memoraErr = err as MemoraError;
        expect(memoraErr.code).toBe(ErrorCode.API_ERROR);
        expect(memoraErr.message).toBe('api rate limit');
      }
    });
  });
});
