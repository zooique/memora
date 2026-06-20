/**
 * utils 层日志持有器 — 解耦 utils → logging 的运行时依赖
 *
 * 设计动机：
 *   utils 是最底层工具层，不应运行时依赖 logging/（业务层）。
 *   但 utils 中的错误日志、事件容错、扫描诊断需要日志能力。
 *   通过 holder 模式，utils 运行时只依赖此模块（同层），
 *   实际 logger 实例由 logging/ 在模块加载时注入。
 *
 * 依赖方向：
 *   - utils/* → utils/loggerHolder.ts（同层，运行时）
 *   - utils/loggerHolder.ts → logging/loggerInterface.ts（type-only，编译时擦除）
 *   - logging/logger.ts → utils/loggerHolder.ts（运行时，桥接注入）
 *
 * 使用方式：
 *   // utils 内部使用
 *   import { getLogger } from './loggerHolder.js';
 *   getLogger().warn({ dir }, '扫描目录失败');
 *
 *   // logging 层桥接（自动执行，无需手动调用）
 *   // logging/logger.ts 模块加载时自动调用 setLogger(logger)
 */

import type { ILogger } from '@/logging/loggerInterface.js';

/** 空操作 logger — 默认实现，不输出任何日志 */
const noopLogger: ILogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** 当前注入的 logger 实例（默认 noop，由 logging/logger.ts 桥接注入） */
let currentLogger: ILogger = noopLogger;

/**
 * 获取当前 logger 实例
 *
 * utils 模块统一通过此函数获取 logger，而非直接 import logging/logger.ts。
 * 在 logging/logger.ts 模块加载前，返回 noopLogger（不输出日志）。
 */
export function getLogger(): ILogger {
  return currentLogger;
}

/**
 * 注入 logger 实例（由 logging/logger.ts 自动调用）
 *
 * 传入 undefined 则恢复为 noopLogger。
 */
export function setLogger(logger: ILogger | undefined): void {
  currentLogger = logger ?? noopLogger;
}
