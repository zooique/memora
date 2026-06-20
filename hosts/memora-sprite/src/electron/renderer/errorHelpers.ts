/**
 * 渲染进程错误处理辅助模块
 *
 * 职责：
 * - 提供统一的未知错误转 Error 工具函数
 * - 提供统一的 IPC 错误处理工厂函数（记录日志 + 可选 toast 反馈）
 *
 * 设计原则：
 * - toError 为纯函数，无副作用，可独立测试
 * - createIpcErrorHandler 通过闭包绑定 uiManager，避免每个调用点重复传参
 * - 行为与内核 utils/toError 对齐，但渲染进程独立实现（不引入内核依赖）
 */

import type { UIManager } from './ui.js';

/**
 * 将未知错误转为 Error
 *
 * 渲染进程本地实现，行为与内核 toError 对齐。
 * 处理 Error 实例、字符串、含 message 属性的对象、其他类型。
 *
 * @param err 捕获的未知错误
 * @returns 转换后的 Error 实例
 */
export function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  if (typeof err === 'string') return new Error(err);
  if (typeof err === 'object' && err !== null && typeof (err as { message?: unknown }).message === 'string') {
    return new Error((err as { message: string }).message);
  }
  return new Error(String(err ?? '未知错误'));
}

/**
 * 创建 IPC 错误处理函数
 *
 * 提取自 8+ 处 catch 块的重复模式（console.error + toError + showToast）。
 * 统一错误处理风格，避免每个回调都写 2-3 行错误处理代码。
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
    console.error(`[${context}]`, error);
    if (toastPrefix) {
      uiManager.showToast(`${toastPrefix}：${toError(error).message}`, 'error');
    }
  };
}
