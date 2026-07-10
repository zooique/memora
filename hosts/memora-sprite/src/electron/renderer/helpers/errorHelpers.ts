/**
 * 渲染进程错误处理辅助模块
 *
 * 职责：
 * - 提供统一的未知错误转 Error 工具函数（toError）
 * - 提供统一的日志记录函数（reportError），替代分散的 console.warn/error
 * - 提供统一的 IPC 错误处理工厂函数（createIpcErrorHandler，记录日志 + 可选 toast 反馈）
 *
 * 设计原则：
 * - toError 为纯函数，无副作用，可独立测试
 * - reportError 统一日志格式为 `[context]` 前缀，便于检索和过滤
 * - reportError 支持 warn/error 两级（默认 error），向后兼容现有 88 处调用
 * - createIpcErrorHandler 通过闭包绑定 uiManager，避免每个调用点重复传参
 * - 行为与内核 utils/toError 对齐，但渲染进程独立实现（不引入内核依赖）
 */

import type { UIManager } from '../ui.js';

/**
 * 将未知错误转为 Error
 *
 * 渲染进程本地实现，行为与内核 toError 对齐。
 * 处理 Error 实例、字符串、含 message 属性的对象、其他类型。
 *
 * @see memora/src/utils/toError.ts — 内核对应实现，逻辑变更时需同步更新
 * @param err 捕获的未知错误
 * @returns 转换后的 Error 实例
 */
export function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  if (typeof err === 'string') return new Error(err);
  if (typeof err === 'object' && err !== null && typeof (err as { message?: unknown }).message === 'string') {
    return new Error((err as { message: string }).message);
  }
  // 普通对象（无 message 属性）：JSON 序列化保留调试信息，try-catch 防止循环引用抛错
  if (typeof err === 'object' && err !== null) {
    try {
      return new Error(JSON.stringify(err));
    } catch {
      // 循环引用等无法序列化的情况，降级到 String()
      return new Error(String(err));
    }
  }
  return new Error(String(err ?? '未知错误'));
}

/** 日志级别类型（与 window.electronAPI.rendererLog 的 level 参数对齐） */
export type LogLevel = 'error' | 'warn';

/**
 * 统一日志记录
 *
 * 双通道记录：
 * 1. console：保留渲染进程控制台输出（开发时即时可见），level 决定 warn/error 方法
 * 2. window.electronAPI.rendererLog：上报主进程 logger（生产环境可观测性）
 *
 * IPC 不可用时（如 preload 加载失败）仅降级到 console，不抛错。
 *
 * @param context 错误上下文标识（如 'loadPersonaList'），自动添加方括号
 * @param error 错误对象或描述信息
 * @param level 日志级别（默认 'error'，向后兼容现有调用；'warn' 用于可降级的非致命错误）
 */
export function reportError(context: string, error: unknown, level: LogLevel = 'error'): void {
  const message = toError(error).message;
  // 控制台输出（开发时即时可见，保留 [context] 前缀格式）
  const logFn = level === 'warn' ? console.warn : console.error;
  logFn(`[${context}]`, error);
  // 上报主进程 logger（生产环境可观测性，try-catch 防止 IPC 不可用时崩溃）
  try {
    window.electronAPI?.rendererLog(level, context, message);
  } catch {
    // IPC 不可用时静默降级（console 已记录，无需额外处理）
  }
}

/**
 * 创建 IPC 错误处理函数
 *
 * 提取自 8+ 处 catch 块的重复模式（reportError + toError + showToast）。
 * 统一错误处理风格，避免每个回调都写 2-3 行错误处理代码。
 *
 * QC-06 收束：内部使用 reportError 替代原始 console.error，
 * 确保 IPC 错误日志格式与其他日志一致。
 *
 * @param uiManager UI 管理器实例（用于显示 toast）
 * @returns 绑定了 uiManager 的错误处理函数
 */
export function createIpcErrorHandler(
  uiManager: UIManager,
): (context: string, error: unknown, toastPrefix?: string) => void {
  /**
   * 统一处理 IPC 错误：记录日志 + 可选 toast 反馈
   *
   * @param context 错误上下文标识（用于日志前缀，如 'onMemoryDelete'）
   * @param error 捕获的错误对象
   * @param toastPrefix 可选的 toast 提示前缀（如 '删除记忆失败'）；不提供则仅记录日志
   */
  return (context: string, error: unknown, toastPrefix?: string): void => {
    reportError(context, error);
    if (toastPrefix) {
      uiManager.showToast(`${toastPrefix}：${toError(error).message}`, 'error');
    }
  };
}
