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
import type { ILogger } from './loggerInterface.js';

/** 日志级别（从环境变量读取，默认 info） */
const level = process.env['MEMORA_LOG_LEVEL'] ?? 'info';

/** 敏感键模式（匹配时值被替换为 [REDACTED]） */
const SENSITIVE_KEY_PATTERN = /api[_-]?key|token|password|secret|authorization|credential/i;

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
    info: (objOrMsg, msg) => {
      if (!shouldLog('info')) return;
      const text = typeof objOrMsg === 'string' ? objOrMsg : msg ?? '';
      if (typeof objOrMsg === 'object') {
        console.error(`[INFO] ${text}`, JSON.stringify(redactSensitiveKeys(objOrMsg)));
      } else {
        console.error(`[INFO] ${text}`);
      }
    },
    warn: (objOrMsg, msg) => {
      if (!shouldLog('warn')) return;
      const text = typeof objOrMsg === 'string' ? objOrMsg : msg ?? '';
      if (typeof objOrMsg === 'object') {
        console.error(`[WARN] ${text}`, JSON.stringify(redactSensitiveKeys(objOrMsg)));
      } else {
        console.error(`[WARN] ${text}`);
      }
    },
    error: (objOrMsg, msg) => {
      if (!shouldLog('error')) return;
      const text = typeof objOrMsg === 'string' ? objOrMsg : msg ?? '';
      if (typeof objOrMsg === 'object') {
        console.error(`[ERROR] ${text}`, JSON.stringify(redactSensitiveKeys(objOrMsg)));
      } else {
        console.error(`[ERROR] ${text}`);
      }
    },
    debug: (objOrMsg, msg) => {
      if (!shouldLog('debug')) return;
      const text = typeof objOrMsg === 'string' ? objOrMsg : msg ?? '';
      if (typeof objOrMsg === 'object') {
        console.error(`[DEBUG] ${text}`, JSON.stringify(redactSensitiveKeys(objOrMsg)));
      } else {
        console.error(`[DEBUG] ${text}`);
      }
    },
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
    const { homedir } = await import('node:os');
    const { mkdirSync, createWriteStream } = await import('node:fs');

    const dataDir = process.env['MEMORA_DATA_DIR'] ?? '~/.memora';
    const resolvedDataDir = resolve(dataDir.replace(/^~/, homedir()));

    // pino.StreamEntry 类型在 pino 未安装时不可用，用内联类型
    const streams: Array<{ level: string; stream: NodeJS.WritableStream }> = [];

    // stderr 流（开发环境友好显示）
    if (!isProd) {
      streams.push({ level: 'info', stream: process.stderr });
    }

    // 文件流（结构化 JSON，方便后续分析）
    if (fileEnabled) {
      try {
        mkdirSync(resolve(resolvedDataDir, 'logs'), { recursive: true });
        const logFilePath = resolve(resolvedDataDir, 'logs', 'memora.log');
        streams.push({
          level: 'info',
          stream: createWriteStream(logFilePath, { flags: 'a' }),
        });
      } catch (err) {
        process.stderr.write(`[memora] 日志文件创建失败：${(err as Error).message}\n`);
      }
    }

    if (streams.length === 0) {
      return pino({ level }) as unknown as ILogger;
    }

    return pino({ level }, pino.multistream(streams)) as unknown as ILogger;
  } catch {
    // pino 未安装，回退到 console logger
    return null;
  }
}

/**
 * 全局日志单例
 *
 * 初始化为 console fallback，模块顶层异步尝试加载 pino。
 * 宿主通过 setLogger() 注入后自动替换。
 */
let _logger: ILogger = createConsoleLogger();

// 模块加载时异步尝试升级到 pino（不阻塞模块导入）
void tryCreatePinoLogger().then((pinoLogger) => {
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
});

/**
 * 全局日志访问器
 *
 * 20+ 个内核模块统一通过此变量输出日志。
 * 宿主注入自定义 logger 后，所有模块自动使用新实现。
 */
export const logger: ILogger = {
  get info() {
    return _logger.info.bind(_logger);
  },
  get warn() {
    return _logger.warn.bind(_logger);
  },
  get error() {
    return _logger.error.bind(_logger);
  },
  get debug() {
    return _logger.debug.bind(_logger);
  },
};

/**
 * 替换全局日志实现
 *
 * 宿主项目在 Agent 初始化前调用此函数注入自定义 logger。
 * 传入 undefined 则恢复为默认（pino 或 console fallback）。
 */
export function setLogger(newLogger: ILogger | undefined): void {
  if (newLogger) {
    _logger = newLogger;
  } else {
    // 恢复默认：尝试 pino，否则 console
    void tryCreatePinoLogger().then((pinoLogger) => {
      _logger = pinoLogger ?? createConsoleLogger();
    });
  }
}
