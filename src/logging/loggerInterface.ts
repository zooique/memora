/**
 * 日志接口 — Memora 内核与日志实现的解耦边界
 *
 * 设计目标：
 *   - 宿主项目可注入自定义日志实现（如宿主日志框架实例 / console 包装 / 测试 mock）
 *   - 不注入时使用内核内置 console fallback（写 stderr，零配置、零第三方依赖）
 *   - 20+ 内核模块通过全局单例 `logger` 访问，无需每次传参
 *
 * 日志级别语义：
 *   - debug：调试信息（默认不输出）
 *   - info：正常运行信息
 *   - warn：非致命警告
 *   - error：错误（含堆栈信息）
 *
 * 双形态签名：支持 `logger.info('msg')` 和 `logger.info({ ctx }, 'msg')`
 */
export type LogFn = (objOrMsg: Record<string, unknown> | string, msg?: string) => void;

/**
 * 日志接口
 *
 * 接口只约定「首参对象 + 可选消息」的双形态签名，实现者可以是：
 *   - 宿主日志框架实例（经适配器包装）
 *   - console 包装
 *   - 测试 mock
 *
 * 默认实现为内核内置 console fallback（写 stderr）；内核不加载任何第三方日志库。
 */
export interface ILogger {
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  debug: LogFn;
}
