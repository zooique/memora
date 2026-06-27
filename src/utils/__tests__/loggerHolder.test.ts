/**
 * 单元测试：utils 层日志持有器
 *
 * 覆盖 getLogger / setLogger 的解耦设计：
 *   - 默认返回 noopLogger（不抛错、不输出）
 *   - setLogger 注入后 getLogger 返回注入的实例
 *   - setLogger(undefined) 恢复 noopLogger
 *   - 注入的 logger 各级别方法可调用
 *
 * 注意：loggerHolder 是模块级单例状态，需 beforeEach 重置为 noop。
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { getLogger, setLogger } from '@/utils/loggerHolder.js';
import type { ILogger } from '@/logging/loggerInterface.js';

describe('utils/loggerHolder', () => {
  // 每个测试前重置为 noop logger，避免测试间状态泄漏
  beforeEach(() => {
    setLogger(undefined);
  });

  it('默认应返回 noop logger（不抛错）', () => {
    const logger = getLogger();
    expect(logger).toBeDefined();
    expect(() => logger.debug('x')).not.toThrow();
    expect(() => logger.info('x')).not.toThrow();
    expect(() => logger.warn('x')).not.toThrow();
    expect(() => logger.error('x')).not.toThrow();
  });

  it('setLogger 注入后 getLogger 应返回注入的实例', () => {
    const mockLogger: ILogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    setLogger(mockLogger);
    expect(getLogger()).toBe(mockLogger);
  });

  it('setLogger(undefined) 应恢复 noop logger', () => {
    const mockLogger: ILogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    setLogger(mockLogger);
    expect(getLogger()).toBe(mockLogger);
    setLogger(undefined);
    expect(getLogger()).not.toBe(mockLogger);
    // 恢复后调用不应抛错
    expect(() => getLogger().info('x')).not.toThrow();
  });

  it('setLogger(null) 应等价于 undefined（恢复 noop）', () => {
    setLogger(null as unknown as undefined);
    expect(() => getLogger().info('x')).not.toThrow();
  });

  it('注入的 logger 各级别应可正常调用', () => {
    const mockLogger: ILogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    setLogger(mockLogger);
    getLogger().debug('debug msg');
    getLogger().info('info msg');
    getLogger().warn('warn msg');
    getLogger().error('error msg');
    expect(mockLogger.debug).toHaveBeenCalledWith('debug msg');
    expect(mockLogger.info).toHaveBeenCalledWith('info msg');
    expect(mockLogger.warn).toHaveBeenCalledWith('warn msg');
    expect(mockLogger.error).toHaveBeenCalledWith('error msg');
  });

  it('多次 setLogger 应覆盖前一次注入', () => {
    const logger1: ILogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const logger2: ILogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    setLogger(logger1);
    expect(getLogger()).toBe(logger1);
    setLogger(logger2);
    expect(getLogger()).toBe(logger2);
  });

  it('noop logger 的方法应是 noop（调用无副作用）', () => {
    // 多次调用不应抛错，也不应返回任何有意义的值
    const logger = getLogger();
    expect(logger.debug('x')).toBeUndefined();
    expect(logger.info('x')).toBeUndefined();
    expect(logger.warn('x')).toBeUndefined();
    expect(logger.error('x')).toBeUndefined();
  });
});
