/**
 * 结构化日志
 * 使用 pino：高性能 + JSON 输出
 *
 * 阶段二（M-102）：同时输出到 stderr（开发环境有颜色） + <dataDir>/logs/memora.log
 *
 * 关闭文件日志：设环境变量 MEMORA_LOG_FILE=0
 */
import pino, { type Logger } from 'pino';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, createWriteStream } from 'node:fs';

const level = process.env['MEMORA_LOG_LEVEL'] ?? 'info';
const isProd = process.env['NODE_ENV'] === 'production';
const fileEnabled = process.env['MEMORA_LOG_FILE'] !== '0';

function createLogger(): Logger {
  // 解析日志文件路径（~ 展开为用户目录）
  const dataDir = process.env['MEMORA_DATA_DIR'] ?? '~/.memora';
  const resolvedDataDir = resolve(dataDir.replace(/^~/, homedir()));
  const logFilePath = resolve(resolvedDataDir, 'logs', 'memora.log');

  // 多流输出
  const streams: pino.StreamEntry[] = [];

  // 1. stderr 流（开发环境友好显示）
  if (!isProd) {
    streams.push({
      level: 'info',
      stream: process.stderr,
    });
  }

  // 2. 文件流（结构化 JSON，方便后续分析）
  if (fileEnabled) {
    try {
      mkdirSync(resolve(resolvedDataDir, 'logs'), { recursive: true });
      streams.push({
        level: 'info',
        stream: createWriteStream(logFilePath, { flags: 'a' }),
      });
    } catch (err) {
      // 文件创建失败不阻塞 logger 启动
      process.stderr.write(`[memora] 日志文件创建失败：${(err as Error).message}\n`);
    }
  }

  // 单流：退回 pino 简单模式
  if (streams.length === 0) {
    return pino({ level });
  }

  return pino({ level }, pino.multistream(streams));
}

export const logger = createLogger();

/**
 * 在 logger 启动后输出当前配置（用于诊断）
 */
logger.info(
  {
    level,
    prod: isProd,
    fileEnabled,
  },
  'logger 启动',
);
