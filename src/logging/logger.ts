/**
 * 结构化日志
 * 使用 pino：高性能 + JSON 输出
 *
 * 阶段一默认输出到 stderr（不影响 stdout 给 Agent）
 * 阶段二可加文件输出到 ~/.memora/logs/
 */
import pino from 'pino';

export const logger = pino({
  level: process.env['MEMORA_LOG_LEVEL'] ?? 'info',
  transport:
    process.env['NODE_ENV'] === 'production'
      ? undefined
      : {
          target: 'pino-pretty',
          options: { colorize: true, destination: 2 }, // 2 = stderr
        },
});
