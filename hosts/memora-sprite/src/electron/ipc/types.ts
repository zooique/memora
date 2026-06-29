/**
 * IPC 共享类型与工具函数
 *
 * 定义所有 IPC 处理器共用的依赖容器（IpcContext）和错误兜底包装（safeHandle）。
 * 由 main.ts 注入依赖，各领域 handler 文件消费。
 */

import type { Agent } from 'memora';
import type { Sprite } from '../../sprite/sprite.js';
import type { SqliteSessionStore } from '../../storage/sessionStore.js';
import type { WindowStateManager } from '../windows/windowState.js';
import type { WindowManager } from '../windows/windowManager.js';
import type { TrayManager } from '../trayIcon.js';
import { errorHandler, ErrorCode } from '../errorHandler.js';

/**
 * IPC 处理器上下文
 *
 * 封装所有 IPC 处理器需要的依赖，由 main.ts 注入。
 * 仅在 Agent 就绪后注册完整 IPC（配置缺失时由 main.ts 注册最小化 IPC）。
 */
export interface IpcContext {
  /** Agent 实例（对话 + 记忆） */
  agent: Agent;
  /** Sprite 实例（精灵控制 + 配置 + 角色） */
  sprite: Sprite;
  /** 会话存储（历史消息加载） */
  sessionStore: SqliteSessionStore;
  /** 窗口状态管理器 */
  windowStateManager: WindowStateManager;
  /** 窗口管理器（获取窗口引用） */
  windowManager: WindowManager;
  /** 托盘管理器（主动提示时脉冲） */
  trayManager: TrayManager | null;
  /** 获取当前对话的 AbortController */
  getAbortController: () => AbortController | null;
  /** 设置当前对话的 AbortController */
  setAbortController: (ctrl: AbortController | null) => void;
  /**
   * Agent 是否就绪（reinitAgent 失败后为 false，拒绝新对话避免使用已关闭 Agent）
   * handleUserInput 入口检查此标志，未就绪时拒绝并提示用户重新配置
   */
  isAgentReady: () => boolean;
  /** 获取当前未读计数（完整窗口隐藏时的消息数） */
  getUnreadCount: () => number;
  /** 增加未读计数并推送到浮动窗口 */
  incrementUnreadCount: () => void;
  /** 清零未读计数并推送到浮动窗口 + 完整窗口 */
  resetUnreadCount: () => void;
}

/**
 * IPC handler 错误兜底包装
 *
 * 统一 try-catch 模板：执行业务逻辑，失败时走 errorHandler + 返回降级值。
 * 适用于"简单查询/操作 + 固定降级返回值"的 handler（占 IPC 处理器的大多数）。
 *
 * 不适用场景（保持手写 try-catch）：
 * - try 内有副作用逻辑（如 CONFIG_UPDATE 需同步托盘状态）
 * - catch 返回值含 error.message（如 SESSION_NEW 需返回错误详情给 UI）
 * - try 内业务逻辑复杂含多分支（如 SESSION_LOAD 会话选择）
 * - 返回值结构复杂（如 DASHBOARD_GET 聚合多字段）
 *
 * @param context 错误上下文描述（人类可读，用于日志）
 * @param fallback 失败时返回的降级值（与 fn 返回值同类型）
 * @param fn 业务逻辑，返回最终响应体（同步或异步均可）
 * @param code 错误代码，默认 UNKNOWN
 * @returns fn 的返回值，或失败时的 fallback
 */
export async function safeHandle<T>(
  context: string,
  fallback: T,
  fn: () => T | Promise<T>,
  code: ErrorCode = ErrorCode.UNKNOWN,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    errorHandler.handle(error, { code, context });
    return fallback;
  }
}
