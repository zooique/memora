/**
 * 结构化日志 — 全局单例 + 可替换 ILogger
 *
 * 内核零第三方依赖：pino 为可选 peerDependency，通过动态 import 加载。
 * 宿主可注入自定义 logger（setLogger），完全绕过 pino。
 *
 * 降级策略：
 *   1. pino 可用 → 双流输出（stderr + 文件日志）
 *   2. pino 不可用 → console 零依赖 fallback（仅 stderr）
 *   3. 宿主注入 → 优先使用宿主实现
 *
 * 使用方式：
 *   import { logger } from '@/logging/logger.js';
 *   logger.info({ key: val }, 'message');
 *
 * 注入自定义 logger：
 *   import { setLogger } from '@/logging/logger.js';
 *   setLogger(myCustomLogger);
 */
import type { ILogger, LogFn } from '@/logging/loggerInterface.js';
import { toError } from '@/utils/toError.js';
// 桥接 utils 层 loggerHolder：utils 运行时不依赖 logging/，
// 由本模块在加载和 setLogger 时反向注入 logger 实例。
import { setLogger as setUtilsLogger } from '@/utils/loggerHolder.js';

/**
 * 从 unknown 值提取错误消息（复用零依赖的 toError，避免类型断言）
 */
function errMsg(err: unknown): string {
  return toError(err).message;
}

/** 日志级别（从环境变量读取，默认 info） */
const level = process.env['MEMORA_LOG_LEVEL'] ?? 'info';

/** 敏感键模式（匹配时值被替换为 [REDACTED]） */
const SENSITIVE_KEY_PATTERN = /api[_-]?key|token|password|secret|authorization|credential/i;

/**
 * pino redact 路径配置（与 console fallback 的 SENSITIVE_KEY_PATTERN 保持一致）
 *
 * 支持嵌套对象脱敏：`*.apiKey` 匹配任意层级的 apiKey 字段
 */
const PINO_REDACT_PATHS = [
  'apiKey', 'token', 'password', 'secret', 'authorization', 'credential',
  '*.apiKey', '*.token', '*.password', '*.secret',
  '*.authorization', '*.credential',
  '*.*.apiKey', '*.*.token', '*.*.password', '*.*.secret',
];

/**
 * 对象脱敏：深拷贝对象并将敏感键的值替换为 [REDACTED]
 *
 * 仅用于 console fallback logger 的 JSON.stringify 路径，
 * 防止 API Key 等敏感数据泄漏到 stderr。
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
/** 是否生产环境 */
const isProd = process.env['NODE_ENV'] === 'production';
/** 是否启用文件日志 */
const fileEnabled = process.env['MEMORA_LOG_FILE'] !== '0';

/** 日志级别优先级（用于 console fallback 的级别过滤） */
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

/**
 * Console 零依赖 fallback logger
 *
 * pino 不可用时使用。仅输出到 stderr，不写文件。
 * 满足 ILogger 接口，所有内核模块透明使用。
 */
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
 *
 * 消除 createConsoleLogger 内 4 处 info/warn/error/debug 方法的同构实现
 * （ADR-017 枝叶层 2 次提取原则，4 次重复已超阈值）。
 *
 * 共享逻辑：
 *   1. shouldLog 级别过滤
 *   2. 提取 text（字符串直传，对象取 msg 参数）
 *   3. 区分字符串/对象输出（对象路径调用 redactSensitiveKeys 脱敏）
 *
 * @param targetLevel 日志级别（'info' | 'warn' | 'error' | 'debug'）
 * @returns LogFn 兼容的日志方法
 */
function createConsoleLogFn(targetLevel: 'info' | 'warn' | 'error' | 'debug'): LogFn {
  // 级别前缀（与原实现保持一致，便于日志检索过滤）
  const prefix = `[${targetLevel.toUpperCase()}]`;
  return (objOrMsg, msg) => {
    // 级别过滤：低于当前级别则静默返回
    if (!shouldLog(targetLevel)) return;
    // 提取文本：字符串入参直接使用，对象入参取 msg 参数
    const text = typeof objOrMsg === 'string' ? objOrMsg : msg ?? '';
    if (typeof objOrMsg === 'object') {
      // 对象路径：脱敏后 JSON 序列化输出（防止 API Key 等敏感数据泄漏到 stderr）
      console.error(`${prefix} ${text}`, JSON.stringify(redactSensitiveKeys(objOrMsg)));
    } else {
      // 字符串路径：仅输出前缀 + 文本
      console.error(`${prefix} ${text}`);
    }
  };
}

/**
 * pino → ILogger 包装器
 *
 * pino 通过动态 import 加载，实例类型未知。
 * 包装器显式提取 4 个日志方法，避免 as unknown as ILogger 双重断言。
 *
 * @param pinoInst pino 实例（动态导入）
 * @returns ILogger 兼容对象
 */
function wrapPinoAsLogger(pinoInst: {
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  debug: LogFn;
}): ILogger {
  return {
    info: pinoInst.info.bind(pinoInst),
    warn: pinoInst.warn.bind(pinoInst),
    error: pinoInst.error.bind(pinoInst),
    debug: pinoInst.debug.bind(pinoInst),
  };
}

/**
 * 尝试创建 Pino logger
 *
 * pino 为可选 peerDependency，通过动态 import 加载。
 * 加载失败（宿主未安装 pino）则回退到 console logger。
 *
 * @returns Pino logger 实例，或 null（pino 不可用）
 */
async function tryCreatePinoLogger(): Promise<ILogger | null> {
  try {
    const pino = (await import('pino')).default;
    const { resolve } = await import('node:path');
    const { mkdirSync, createWriteStream, statSync, truncateSync } = await import('node:fs');
    const { expandHome } = await import('@/utils/path.js');

    // 日志目录由宿主通过 MEMORA_DATA_DIR 环境变量注入；未设置时跳过文件日志
    const dataDir = process.env['MEMORA_DATA_DIR'];
    const resolvedDataDir = dataDir ? resolve(expandHome(dataDir)) : null;

    // pino.StreamEntry 类型在 pino 未安装时不可用，用内联类型
    const streams: Array<{ level: string; stream: NodeJS.WritableStream }> = [];

    // stderr 流（开发环境友好显示）
    if (!isProd) {
      streams.push({ level: 'info', stream: process.stderr });
    }

    // 文件流（结构化 JSON，方便后续分析）
    // 日志轮转保护——超过 10MB 时截断重写，防止长期运行生成巨大文件
    if (fileEnabled && resolvedDataDir) {
      try {
        const logsDir = resolve(resolvedDataDir, 'logs');
        mkdirSync(logsDir, { recursive: true });
        const logFilePath = resolve(logsDir, 'memora.log');

        // 检查文件大小，超过 10MB 时截断
        const LOG_MAX_BYTES = 10 * 1024 * 1024; // 10MB
        try {
          const stat = statSync(logFilePath);
          if (stat.size > LOG_MAX_BYTES) {
            truncateSync(logFilePath, 0);
            process.stderr.write(`[memora] 日志文件超过 10MB，已截断：${logFilePath}\n`);
          }
        } catch (err) {
          // 文件不存在或无法 stat，正常——首次写入
          if (process.env['MEMORA_DEBUG']) process.stderr.write(`[memora] stat 日志文件失败：${errMsg(err)}\n`);
        }

        streams.push({
          level: 'info',
          stream: createWriteStream(logFilePath, { flags: 'a' }),
        });
      } catch (err) {
        process.stderr.write(`[memora] 日志文件创建失败：${errMsg(err)}\n`);
      }
    }

    if (streams.length === 0) {
      // 通过包装器适配 ILogger 接口，避免 as unknown as ILogger 双重断言
      // SEC-AUDIT: 配置 redact 防止敏感信息写入日志文件
      return wrapPinoAsLogger(pino({ level, redact: PINO_REDACT_PATHS }));
    }

    // 通过包装器适配 ILogger 接口
    // SEC-AUDIT: 配置 redact 防止敏感信息写入日志文件
    return wrapPinoAsLogger(pino({ level, redact: PINO_REDACT_PATHS }, pino.multistream(streams)));
  } catch (err) {
    // pino 未安装，回退到 console logger
    if (process.env['MEMORA_DEBUG']) process.stderr.write(`[memora] pino 加载失败：${errMsg(err)}\n`);
    return null;
  }
}

/**
 * 全局日志单例
 *
 * 初始化为 console fallback（同步可用，零 fs 副作用）。
 * 首次日志调用时懒触发 pino 升级（确保模块 import 零 fs 副作用）。
 * 宿主通过 setLogger() 注入后自动替换，并跳过 pino 升级。
 */
let _logger: ILogger = createConsoleLogger();

/** 标记 _logger 是否已被宿主注入（用于 setLogger 覆盖检测 + pino 升级跳过） */
let _loggerInjected = false;

/** pino 升级是否已启动（确保只触发一次，避免重复 fs 操作） */
let _pinoUpgradeStarted = false;

// 同步初始化 utils 层 logger 桥接（确保 utils 在 pino 异步加载前就有 console fallback）
setUtilsLogger(_logger);

/**
 * 懒触发 pino 升级
 *
 * 在首次日志调用时触发，确保模块 import 零 fs 副作用。
 * - 宿主已注入 logger 时跳过升级（_loggerInjected 守卫）
 * - 升级启动后不再重复触发（_pinoUpgradeStarted 守卫）
 * - 竞态守卫：then 回调内再次检查 _loggerInjected，避免覆盖宿主在升级期间注入的 logger
 */
function maybeUpgradeToPino(): void {
  if (_pinoUpgradeStarted || _loggerInjected) return;
  _pinoUpgradeStarted = true;
  void tryCreatePinoLogger().then((pinoLogger) => {
    // 守卫：升级期间宿主可能已通过 setLogger 注入自定义 logger
    if (_loggerInjected) {
      setUtilsLogger(_logger);
      return;
    }
    if (pinoLogger) {
      _logger = pinoLogger;
      _logger.info(
        { level, prod: isProd, fileEnabled },
        'logger 启动（pino）',
      );
    } else {
      _logger.info(
        { level, prod: isProd },
        'logger 启动（console fallback，pino 未安装）',
      );
    }
    // 桥接注入到 utils 层（utils 运行时不依赖 logging/）
    setUtilsLogger(_logger);
  });
}

/**
 * 全局日志访问器
 *
 * 20+ 个内核模块统一通过此变量输出日志。
 * 首次访问任一方法时懒触发 pino 升级（确保 import 零 fs 副作用）。
 * 宿主注入自定义 logger 后，所有模块自动使用新实现。
 */
export const logger: ILogger = {
  get info() {
    maybeUpgradeToPino();
    return _logger.info.bind(_logger);
  },
  get warn() {
    maybeUpgradeToPino();
    return _logger.warn.bind(_logger);
  },
  get error() {
    maybeUpgradeToPino();
    return _logger.error.bind(_logger);
  },
  get debug() {
    maybeUpgradeToPino();
    return _logger.debug.bind(_logger);
  },
};

/**
 * 替换全局日志实现
 *
 * 宿主项目在 Agent 初始化前调用此函数注入自定义 logger。
 * 传入 undefined 则恢复为默认（pino 或 console fallback）。
 *
 * 注意：此函数修改全局状态。在单 Agent 模型下（ADR-011），
 * 同一进程只有一个 Agent 实例，不会冲突。若同一进程创建多个
 * Agent 实例并分别注入 logger，后者会覆盖前者——此时会输出警告。
 */
export function setLogger(newLogger: ILogger | undefined): void {
  if (newLogger) {
    // 检测覆盖：如果当前 logger 已被宿主注入，且新 logger 不是同一个，说明有多处注入
    if (_loggerInjected && _logger !== newLogger) {
      _logger.warn(
        'setLogger 覆盖了已有的自定义 logger（单 Agent 模型下不应出现此情况）',
      );
    }
    _loggerInjected = true;
    _logger = newLogger;
  } else {
    // 恢复默认：同步恢复到 console fallback
    // pino 升级不主动触发——等下次日志调用时由 maybeUpgradeToPino() 懒触发
    // 这样 setLogger(undefined) 零 fs 副作用，与模块加载时一致
    _loggerInjected = false;
    _pinoUpgradeStarted = false; // 允许下次日志调用时重新触发升级
    _logger = createConsoleLogger();
    setUtilsLogger(_logger);
  }
}
