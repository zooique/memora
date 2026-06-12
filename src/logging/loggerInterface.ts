/**
 * 日志接口 — Memora 内核与日志实现的解耦边界
 *
 * 设计目标：
 *   - 宿主项目可注入自定义日志实现（如 Electron 的 winston/pino 实例）
 *   - 不注入时使用默认 PinoLogger（零配置）
 *   - 21 个内核模块通过全局单例 `logger` 访问，无需每次传参
 *
 * 日志级别语义（与 pino 对齐）：
 *   - debug：调试信息（默认不输出）
 *   - info：正常运行信息
 *   - warn：非致命警告
 *   - error：错误（含堆栈信息）
 *
 * 签名兼容 pino：支持 `logger.info('msg')` 和 `logger.info({ ctx }, 'msg')`
 */
export type LogFn = (objOrMsg: Record<string, unknown> | string, msg?: string) => void;

/**
 * 日志接口
 *
 * 方法签名与 pino 兼容，实现者可以是：
 *   - pino 实例（默认）
 *   - console 包装
 *   - 自定义日志框架
 *   - 测试 mock
 */
export interface ILogger {
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  debug: LogFn;
}