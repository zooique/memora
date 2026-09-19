/**
 * Logging 模块单元测试
 * 覆盖：内置 console fallback（字符串/对象两路径 + 脱敏 + 级别过滤）、
 * setLogger 切换不变量、多次注入覆盖警告。
 *
 * 说明：默认实现即内置 console fallback（同步可用，零 fs 副作用），
 * 无异步升级；`logger` 门面为对当前实现的委托闭包，setLogger 注入后立即生效。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { logger, setLogger } from '@/logging/logger.js';
import type { ILogger } from '@/logging/loggerInterface.js';
import { getLogger } from '@/utils/loggerHolder.js';

/** 构造一次性 mock ILogger（各方法为 vi.fn） */
function createMockLogger(): ILogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

describe('Logging · 默认 console fallback logger', () => {
  it('应具有 info/warn/error/debug 四个方法', () => {
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.debug).toBe('function');
  });

  it('应能调用 info 方法而不抛错', () => {
    const customLogger = createMockLogger();
    setLogger(customLogger);
    logger.info('测试消息');
    expect(customLogger.info).toHaveBeenCalledWith('测试消息');
    setLogger(undefined);
  });

  it('应能调用 warn 方法而不抛错', () => {
    const customLogger = createMockLogger();
    setLogger(customLogger);
    logger.warn('警告消息');
    expect(customLogger.warn).toHaveBeenCalledWith('警告消息');
    setLogger(undefined);
  });

  it('应能调用 error 方法而不抛错', () => {
    const customLogger = createMockLogger();
    setLogger(customLogger);
    logger.error('错误消息');
    expect(customLogger.error).toHaveBeenCalledWith('错误消息');
    setLogger(undefined);
  });

  it('应能调用 debug 方法而不抛错', () => {
    const customLogger = createMockLogger();
    setLogger(customLogger);
    logger.debug('调试消息');
    expect(customLogger.debug).toHaveBeenCalledWith('调试消息');
    setLogger(undefined);
  });
});

describe('Logging · setLogger() 切换', () => {
  afterEach(() => {
    setLogger(undefined);
  });

  it('应切换到自定义 logger', () => {
    const customInfo = vi.fn();
    const customWarn = vi.fn();
    const customError = vi.fn();
    const customDebug = vi.fn();

    const customLogger: ILogger = {
      info: customInfo,
      warn: customWarn,
      error: customError,
      debug: customDebug,
    };

    setLogger(customLogger);

    logger.info('自定义消息');
    expect(customInfo).toHaveBeenCalledWith('自定义消息');
  });

  it('应将 undefined 传入 setLogger 恢复内置 console fallback', () => {
    const customLogger = createMockLogger();
    // 抑制 console 输出并捕获内置 fallback 的写入
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    setLogger(customLogger);
    setLogger(undefined);

    logger.info('恢复后消息');

    // 恢复后应不再调用 customLogger
    expect(customLogger.info).not.toHaveBeenCalled();
    // 恢复后走内置 console fallback 的字符串路径（写 stderr）
    expect(spy).toHaveBeenCalledWith('[INFO] 恢复后消息');

    spy.mockRestore();
  });
});

describe('Logging · 内置 console fallback 输出与脱敏', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    // 复位为内置 console fallback，保证每条用例都在真实默认实现上验证
    setLogger(undefined);
  });

  it('字符串入参：写 stderr 并带级别前缀', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logger.warn('磁盘空间不足');
    expect(spy).toHaveBeenCalledWith('[WARN] 磁盘空间不足');
  });

  it('对象入参：端到端脱敏，敏感键替换为 [REDACTED]、非敏感键保留', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    logger.info(
      { api_key: 'sk-test-key', nested: { token: 'bearer-abc123' }, normal: 'visible' },
      '端到端脱敏测试',
    );

    expect(spy).toHaveBeenCalledTimes(1);
    const output = spy.mock.calls.map((call) => call.join(' ')).join(' ');
    // 级别前缀 + 消息文本保留
    expect(output).toContain('[INFO] 端到端脱敏测试');
    // 敏感值（含嵌套层级）不泄漏
    expect(output).not.toContain('sk-test-key');
    expect(output).not.toContain('bearer-abc123');
    // 敏感键被替换、非敏感键保留
    expect(output).toContain('[REDACTED]');
    expect(output).toContain('visible');
  });

  it('shouldLog 级别过滤：默认级别 info 下 debug 不输出', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logger.debug('不应输出');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('Logging · 多次 setLogger 覆盖警告', () => {
  afterEach(() => {
    setLogger(undefined);
  });

  it('应在第二次 setLogger 注入不同实例时发出警告', () => {
    const firstLogger = createMockLogger();
    const secondLogger = createMockLogger();

    // 第一次注入
    setLogger(firstLogger);

    // 第二次注入不同的 logger，应触发 firstLogger.warn
    setLogger(secondLogger);

    // firstLogger.warn 应被调用（覆盖警告）
    expect(firstLogger.warn).toHaveBeenCalledWith(
      'setLogger 覆盖了已有的自定义 logger（单 Agent 模型下不应出现此情况）',
    );
  });

  it('应在注入相同实例时不发出警告', () => {
    const customLogger = createMockLogger();

    setLogger(customLogger);
    // 再次注入同一个实例
    setLogger(customLogger);

    // 不应触发 warn
    expect(customLogger.warn).not.toHaveBeenCalled();
  });
});

describe('Logging · setLogger 切换不变量', () => {
  afterEach(() => {
    setLogger(undefined);
  });

  it('连续多次 setLogger 应保留最后一次注入的 logger', () => {
    const loggers: ILogger[] = Array.from({ length: 3 }, () => createMockLogger());

    for (const l of loggers) setLogger(l);

    logger.info('连续注入验证');

    // 验证：最后一个 logger 仍是当前 logger
    expect(loggers[2]!.info).toHaveBeenCalledWith('连续注入验证');
    // 前两个不应被调用
    expect(loggers[0]!.info).not.toHaveBeenCalled();
    expect(loggers[1]!.info).not.toHaveBeenCalled();
  });

  it('setLogger(undefined) 复位后再注入应保留新注入', () => {
    const first = createMockLogger();
    const second = createMockLogger();

    setLogger(first);
    setLogger(undefined);
    setLogger(second);

    logger.info('复位后注入验证');

    expect(second.info).toHaveBeenCalledWith('复位后注入验证');
    expect(first.info).not.toHaveBeenCalled();
  });
});

describe('Logging · setLogger 注入桥接 utils 层（loggerHolder）', () => {
  afterEach(() => {
    setLogger(undefined);
  });

  it('注入 custom 后 holder 应取到同一实例，复位后不再是 custom', () => {
    const custom = createMockLogger();

    setLogger(custom);
    // 注入即唯一出口：utils 层 holder 必须同步指向注入实现
    expect(getLogger()).toBe(custom);

    setLogger(undefined);
    // 复位后 utils 层不应再持有 custom（回到内置 console fallback）
    expect(getLogger()).not.toBe(custom);
  });
});
