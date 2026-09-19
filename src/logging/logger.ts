/**
 * 结构化日志 — 全局单例 + 可替换 ILogger
 * 零第三方依赖、零 fs 副作用：默认 console fallback（写 stderr）；宿主经 setLogger() 注入自定义实现。
 * 内核只持有日志「接口」职责——不加载任何三方日志库，不决定日志落盘位置（通道/落盘归宿主）。
 */
import type { ILogger, LogFn } from '@/logging/loggerInterface.js';
// 反向注入 utils 层 loggerHolder：utils 运行时不依赖 logging/，由本模块桥接 logger 实例
import { setLogger as setUtilsLogger } from '@/utils/loggerHolder.js';

/** 日志级别（环境变量，默认 info） */
const level = process.env['MEMORA_LOG_LEVEL'] ?? 'info';

/** 敏感键名匹配（命中时值被替换为 [REDACTED]） */
const SENSITIVE_KEY_PATTERN = /api[_-]?key|token|password|secret|authorization|credential/i;

/**
 * 对象脱敏：深拷贝并将敏感键值替换为 [REDACTED]
 * 单一脱敏实现：console fallback 输出对象前统一经此脱敏（任意嵌套层级 + 变体 + 大小写不敏感）。
 */
function redactSensitiveKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      redacted[key] = '[REDACTED]';
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      redacted[key] = redactSensitiveKeys(value as Record<string, unknown>);
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

/** 日志级别优先级（console fallback 级别过滤用） */
const LEVEL_PRIORITY: Record<string, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
  silent: 6,
};

/** 判断目标级别是否满足最低级别要求 */
function shouldLog(targetLevel: string): boolean {
  return (LEVEL_PRIORITY[targetLevel] ?? 2) >= (LEVEL_PRIORITY[level] ?? 2);
}

/** Console 零依赖 fallback logger：仅 stderr，满足 ILogger 接口 */
function createConsoleLogger(): ILogger {
  return {
    info: createConsoleLogFn('info'),
    warn: createConsoleLogFn('warn'),
    error: createConsoleLogFn('error'),
    debug: createConsoleLogFn('debug'),
  };
}

/**
 * 创建 console fallback 单级别日志方法
 * 消除 4 处 info/warn/error/debug 方法同构实现；共享：shouldLog 过滤、文本提取、对象路径脱敏。
 */
function createConsoleLogFn(targetLevel: 'info' | 'warn' | 'error' | 'debug'): LogFn {
  const prefix = `[${targetLevel.toUpperCase()}]`;
  return (objOrMsg, msg) => {
    if (!shouldLog(targetLevel)) return;
    const text = typeof objOrMsg === 'string' ? objOrMsg : msg ?? '';
    if (typeof objOrMsg === 'object') {
      // 对象路径：脱敏后 JSON 序列化，防敏感数据泄漏
      console.error(`${prefix} ${text}`, JSON.stringify(redactSensitiveKeys(objOrMsg)));
    } else {
      console.error(`${prefix} ${text}`);
    }
  };
}

/**
 * 全局日志单例：初始为 console fallback（同步可用，零 fs 副作用）。
 * 宿主经 setLogger() 注入后替换；未注入时保持 console fallback。
 */
let _logger: ILogger = createConsoleLogger();

/** 是否已被宿主注入（setLogger 覆盖告警判定） */
let _loggerInjected = false;

// 同步初始化 utils 层 logger 桥接（确保 utils 始终持有日志实现，默认即 console fallback）
setUtilsLogger(_logger);

/**
 * 全局日志访问器：20+ 内核模块统一经此输出；每个方法为对当前 `_logger` 的**普通委托闭包**，
 * 宿主注入/复位后所有持有者自动切换到新实现（函数身份稳定，外部可将 `logger.info` 直接作回调传递）。
 */
export const logger: ILogger = {
  info: (...args: Parameters<LogFn>) => _logger.info(...args),
  warn: (...args: Parameters<LogFn>) => _logger.warn(...args),
  error: (...args: Parameters<LogFn>) => _logger.error(...args),
  debug: (...args: Parameters<LogFn>) => _logger.debug(...args),
};

/**
 * 替换全局日志实现：宿主在 Agent 初始化前调用注入自定义 logger；传入 undefined 恢复默认。
 * 注入即成为内核**唯一**日志出口：同时桥接 utils 层（`loggerHolder`），
 * 使 scanner / eventEmitter / rolePackManager 等 utils 侧模块也走注入实现（而非停留在 console fallback）。
 * 修改全局状态：单 Agent 模型下不会冲突；若多处注入，后者覆盖前者并输出警告。
 */
export function setLogger(newLogger: ILogger | undefined): void {
  if (newLogger) {
    // 检测覆盖：当前已被宿主注入且新实例不同，说明有多处注入
    if (_loggerInjected && _logger !== newLogger) {
      _logger.warn(
        'setLogger 覆盖了已有的自定义 logger（单 Agent 模型下不应出现此情况）',
      );
    }
    _loggerInjected = true;
    _logger = newLogger;
    // 注入即唯一出口：同步桥接 utils 层，否则 utils 侧仍持有旧 console fallback
    setUtilsLogger(_logger);
  } else {
    // 恢复默认：回到内置 console fallback，并重新桥接 utils 层
    _loggerInjected = false;
    _logger = createConsoleLogger();
    setUtilsLogger(_logger);
  }
}
