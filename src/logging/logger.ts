/**
 * 结构化日志 — 全局单例 + 可替换 ILogger
 * pino 为可选 peerDependency，动态 import 加载（未安装时降级 console）；
 * 宿主可用 setLogger() 注入自定义 logger，完全绕过 pino。
 * 降级链：pino(双流 stderr+文件) → console(仅 stderr) → 宿主注入优先。
 */
import type { ILogger, LogFn } from '@/logging/loggerInterface.js';
import { toError } from '@/utils/toError.js';
// 反向注入 utils 层 loggerHolder：utils 运行时不依赖 logging/，由本模块桥接 logger 实例
import { setLogger as setUtilsLogger } from '@/utils/loggerHolder.js';
// Node.js 内置模块静态 import（合法依赖）
import { resolve } from 'node:path';
import { mkdirSync, createWriteStream, statSync, truncateSync } from 'node:fs';
import { expandHome } from '@/utils/path.js';

/** 从 unknown 值提取错误消息（复用零依赖 toError，避免类型断言） */
function errMsg(err: unknown): string {
  return toError(err).message;
}

/** 日志级别（环境变量，默认 info） */
const level = process.env['MEMORA_LOG_LEVEL'] ?? 'info';

/** 敏感键名匹配（命中时值被替换为 [REDACTED]） */
const SENSITIVE_KEY_PATTERN = /api[_-]?key|token|password|secret|authorization|credential/i;

/**
 * pino redact 路径配置（与 console fallback 的 SENSITIVE_KEY_PATTERN 一致）
 * `*.apiKey` 匹配任意层级的 apiKey 字段，支持嵌套对象脱敏
 */
const PINO_REDACT_PATHS = [
  'apiKey', 'token', 'password', 'secret', 'authorization', 'credential',
  '*.apiKey', '*.token', '*.password', '*.secret',
  '*.authorization', '*.credential',
  '*.*.apiKey', '*.*.token', '*.*.password', '*.*.secret',
];

/**
 * 对象脱敏：深拷贝并将敏感键值替换为 [REDACTED]
 * 仅用于 console fallback 的 JSON.stringify 路径，防止敏感数据泄漏到 stderr。
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

/** Console 零依赖 fallback logger：pino 不可用时使用，仅 stderr，满足 ILogger 接口 */
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

/** pino → ILogger 包装器：显式提取 4 个日志方法，避免 as unknown as ILogger 双重断言 */
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
 * 尝试创建 Pino logger：pino 为可选 peerDependency，加载失败（未安装）返回 null，由上层回退 console。
 */
async function tryCreatePinoLogger(): Promise<ILogger | null> {
  try {
    // pino 必须动态 import（未安装时降级 console）
    const pino = (await import('pino')).default;

    // 日志目录由宿主经 MEMORA_DATA_DIR 注入；未设置时跳过文件日志
    const dataDir = process.env['MEMORA_DATA_DIR'];
    const resolvedDataDir = dataDir ? resolve(expandHome(dataDir)) : null;

    // pino.StreamEntry 类型在 pino 未安装时不可用，用内联类型
    const streams: Array<{ level: string; stream: NodeJS.WritableStream }> = [];

    // stderr 流（开发环境友好显示）
    if (!isProd) {
      streams.push({ level: 'info', stream: process.stderr });
    }

    // 文件流：日志轮转保护，超 10MB 截断重写，防长期运行生成巨大文件
    if (fileEnabled && resolvedDataDir) {
      try {
        const logsDir = resolve(resolvedDataDir, 'logs');
        mkdirSync(logsDir, { recursive: true });
        const logFilePath = resolve(logsDir, 'memora.log');

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
      // 通过包装器适配 ILogger；config redact 防敏感信息写入
      return wrapPinoAsLogger(pino({ level, redact: PINO_REDACT_PATHS }));
    }

    return wrapPinoAsLogger(pino({ level, redact: PINO_REDACT_PATHS }, pino.multistream(streams)));
  } catch (err) {
    // pino 未安装，回退到 console logger
    if (process.env['MEMORA_DEBUG']) process.stderr.write(`[memora] pino 加载失败：${errMsg(err)}\n`);
    return null;
  }
}

/**
 * 全局日志单例：初始为 console fallback（同步可用，零 fs 副作用）。
 * 首次日志调用懒触发 pino 升级；宿主注入后自动替换并跳过升级。
 */
let _logger: ILogger = createConsoleLogger();

/** 是否已被宿主注入（setLogger 覆盖检测 + pino 升级跳过） */
let _loggerInjected = false;

/** pino 升级是否已启动（确保只触发一次，避免重复 fs 操作） */
let _pinoUpgradeStarted = false;

// 同步初始化 utils 层 logger 桥接（确保 utils 在 pino 异步加载前有 console fallback）
setUtilsLogger(_logger);

/**
 * 懒触发 pino 升级（首次日志调用时触发，保证 import 零 fs 副作用）。
 * 宿主注入（_loggerInjected）或已升级（_pinoUpgradeStarted）时跳过；竞态下检查宿主是否在升级期间注入。
 */
function maybeUpgradeToPino(): void {
  if (_pinoUpgradeStarted || _loggerInjected) return;
  _pinoUpgradeStarted = true;
  void tryCreatePinoLogger().then((pinoLogger) => {
    // 守卫：升级期间宿主可能已 setLogger 注入自定义 logger
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
 * 全局日志访问器：20+ 内核模块统一经此输出；首次访问任一方法懒触发 pino 升级；
 * 宿主注入后所有模块自动切换新实现。
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
 * 替换全局日志实现：宿主在 Agent 初始化前调用注入自定义 logger；传入 undefined 恢复默认。
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
  } else {
    // 恢复默认：同步回到 console fallback；pino 升级不主动触发，等下次日志调用懒触发（零 fs 副作用）
    _loggerInjected = false;
    _pinoUpgradeStarted = false; // 允许下次日志调用时重新触发升级
    _logger = createConsoleLogger();
    setUtilsLogger(_logger);
  }
}
