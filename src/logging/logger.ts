/**
 * 结构化日志 — 全局单例 + 可替换 ILogger
 *
 * 默认使用 pino（高性能 + JSON 输出），宿主可注入自定义实现。
 * 阶段二（M-102）：同时输出到 stderr + <dataDir>/logs/memora.log
 *
 * 使用方式：
 *   import { logger } from '@/logging/logger.js';
 *   logger.info({ key: val }, 'message');
 *   logger.warn('message');
 *
 * 注入自定义 logger：
 *   import { setLogger } from '@/logging/logger.js';
 *   setLogger(myCustomLogger);
 *
 * 关闭文件日志：设环境变量 MEMORA_LOG_FILE=0
 */
import pino from 'pino';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, createWriteStream } from 'node:fs';
import type { ILogger } from './logger-interface.js';

const level = process.env['MEMORA_LOG_LEVEL'] ?? 'info';
const isProd = process.env['NODE_ENV'] === 'production';
const fileEnabled = process.env['MEMORA_LOG_FILE'] !== '0';

/**
 * 创建默认 Pino 日志实例
 *
 * 双流输出：
 *   1. stderr（开发环境有颜色）
 *   2. <dataDir>/logs/memora.log（结构化 JSON 持久化）
 */
function createPinoLogger(): ILogger {
  const dataDir = process.env['MEMORA_DATA_DIR'] ?? '~/.memora';
  const resolvedDataDir = resolve(dataDir.replace(/^~/, homedir()));

  const streams: pino.StreamEntry[] = [];

  // stderr 流（开发环境友好显示）
  if (!isProd) {
    streams.push({
      level: 'info',
      stream: process.stderr,
    });
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

  // 单流：退回 pino 简单模式
  if (streams.length === 0) {
    return pino({ level }) as unknown as ILogger;
  }

  return pino({ level }, pino.multistream(streams)) as unknown as ILogger;
}

/** 全局日志单例（默认 PinoLogger） */
let _logger: ILogger = createPinoLogger();

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
 * 传入 undefined 则恢复为默认 PinoLogger。
 */
export function setLogger(newLogger: ILogger | undefined): void {
  _logger = newLogger ?? createPinoLogger();
}

_logger.info(
  { level, prod: isProd, fileEnabled },
  'logger 启动',
);