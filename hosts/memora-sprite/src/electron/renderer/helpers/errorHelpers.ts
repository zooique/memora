/**
 * 渲染进程错误处理辅助模块
 *
 * 职责：
 * - re-export shared/toError（跨进程共享的 unknown → Error 转换工具）
 * - 提供统一的日志记录函数（reportError），替代分散的 console.warn/error
 * - 提供统一的 IPC 错误处理工厂函数（createIpcErrorHandler，记录日志 + 可选 toast 反馈）
 *
 * 设计原则：
 * - toError 从 shared/ 层导入，消除渲染进程本地重复实现
 * - reportError 统一日志格式为 `[context]` 前缀，便于检索和过滤
 * - reportError 支持 warn/error 两级（默认 error），向后兼容现有 88 处调用
 * - createIpcErrorHandler 通过闭包绑定 uiManager，避免每个调用点重复传参
 */

// toError 从 shared 层导入（渲染进程是浏览器环境，无法解析裸模块标识符 'memora'）
// MIND-D4 原始方案是创建 @memora/shared 零依赖包统一真理源，在该包创建之前使用 shared 层副本
import { toError } from '../../../shared/toError.js';
// formatErrorMessage 错误文案真理源（UX-13：替代直传 error.message 到 Toast，分类映射 + 两段式模板）
import { formatErrorMessage } from '../../../shared/errorMessages.js';
export { toError };

/**
 * createIpcErrorHandler 所需的 UI 能力（仅 showToast）
 *
 * 使用局部接口替代 `import type { UIManager }`，消除 errorHelpers → ui 的依赖，
 * 避免新增导入 errorHelpers 的模块与 ui.ts 形成循环依赖导致 ESM 初始化顺序问题。
 */
interface IpcErrorUi {
  /** 显示 toast 通知（错误反馈） */
  showToast(message: string, type?: string, duration?: number): void;
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
 * 内部使用 reportError 代替 console.error，
 * 确保 IPC 错误日志格式与其他日志一致。
 *
 * UX-13 重构：原 `${toastPrefix}：${error.message}` 直传原始消息到 Toast，
 * 现改用 formatErrorMessage 分类映射（IPC/存储/网络/权限等），原始 message
 * 仅用于模式匹配，不直接拼接进 Toast（避免技术细节泄露 + 文案统一）。
 *
 * @param uiManager UI 管理器实例（用于显示 toast）
 * @returns 绑定了 uiManager 的错误处理函数
 */
export function createIpcErrorHandler(
  uiManager: IpcErrorUi,
): (context: string, error: unknown, operation?: string) => void {
  /**
   * 统一处理 IPC 错误：记录日志 + 可选 toast 反馈
   *
   * @param context 错误上下文标识（用于日志前缀，如 'onMemoryDelete'）
   * @param error 捕获的错误对象
   * @param operation 可选的操作名（不含"失败"后缀，如 '删除记忆'）；不提供则仅记录日志
   */
  return (context: string, error: unknown, operation?: string): void => {
    reportError(context, error);
    if (operation) {
      // 通过 formatErrorMessage 分类映射错误，输出两段式/三段式中文文案
      uiManager.showToast(formatErrorMessage(operation, error), 'error');
    }
  };
}
