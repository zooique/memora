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
// 注入快捷键管理器，供 configHandlers 触发热更新副作用
import type { ShortcutManager } from '../shortcuts.js';
import type { UsageStatsCollector } from '../../sprite/usage/usageStatsCollector.js';
// AuditManager 用于 MinimalIpcState（Agent 未就绪时审计日志降级处理）
import type { AuditManager } from '../../sprite/audit/auditManager.js';
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
  /**
   * 全局快捷键管理器（Phase 3.3）
   *
   * shortcuts 配置变更时由 configHandlers 调用其热更新方法。
   * 可能为 null（shortcutManager 在 initializeApp 中创建，未就绪前为 null）。
   */
  shortcutManager: ShortcutManager | null;
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
  /** 使用统计采集器（AUDIT-5-1，默认关闭，需显式开启） */
  usageStatsCollector: UsageStatsCollector | null;
}

/**
 * IPC handler 错误兜底包装
 *
 * 统一 try-catch 模板：执行业务逻辑，失败时走 errorHandler + 返回降级值。
 * 适用于"简单查询/操作 + 固定降级返回值"的 handler（占 IPC 处理器的大多数）。
 *
 * 不适用场景（保持手写 try-catch）：
 * - try 内有副作用逻辑（如 CONFIG_UPDATE 需同步托盘状态）
 * - catch 返回值含 error.message（如 SESSION_DELETE 需返回错误详情给 UI）
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

/**
 * IPC handler 错误透传包装（查询类专用）
 *
 * 与 safeHandle 平行，但 catch 后不返回降级值，而是记录日志后 re-throw。
 * 适用于查询类 handler：异常让渲染层 catch 捕获并显示错误态（toast/showPanelError），
 * 避免返回空集合让用户误以为"无数据"而非"加载失败"。
 *
 * 与 safeHandle 的区别：
 * - safeHandle：catch → 记录日志 → 返回 fallback（操作类，降级为失败状态）
 * - throwingHandle：catch → 记录日志 → re-throw（查询类，让渲染层处理错误态）
 *
 * @param context 错误上下文描述（人类可读，用于日志）
 * @param fn 业务逻辑，返回查询结果（同步或异步均可）
 * @param code 错误代码，默认 UNKNOWN
 * @returns fn 的返回值，或失败时 re-throw 异常
 */
export async function throwingHandle<T>(
  context: string,
  fn: () => T | Promise<T>,
  code: ErrorCode = ErrorCode.UNKNOWN,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    errorHandler.handle(error, { code, context });
    throw error;
  }
}

// ─── IPC 数据传输类型 ────────────────────────────────────
// 区段说明：原分散在 channels.ts / minimalHandlers.ts 的 IPC 传输类型集中于此。

/**
 * 主进程 AppError 序列化后的 IPC 传输形态
 *
 * 主进程的 AppError 包含 Date 对象和 Error 引用，无法直接通过 IPC 传输。
 * 经由 errorHandler.showErrorToUser 序列化后，渲染进程收到的是此结构的对象。
 * 主进程和渲染进程共享此类型，消除两处重复定义（errorHandler.ts 和 renderer.ts）。
 */
export interface SerializedAppError {
  /** 错误码（ErrorCode 枚举经 IPC 传输后转为 string） */
  code: string;
  /** 用户友好的错误消息（已由 errorHandler 转换） */
  message: string;
  /** ISO 8601 时间戳（AppError.timestamp 的 toISOString() 结果） */
  timestamp: string;
}

/**
 * 作品投影 IPC 传输形态（WorkProjectionManager 查看）
 *
 * 内核 WorkProjectionEntry 的 sourcePath 为服务端绝对路径，
 * 通过 IPC 传输后渲染进程仅用于展示，不反解析。
 * 与 WorkProjectionEntry 结构对齐，但确保所有字段可序列化。
 */
export interface WorkProjectionPayload {
  /** 唯一 ID（work-proj-<slug>） */
  id: string;
  /** 文件路径（服务端绝对路径，仅展示用） */
  sourcePath: string;
  /** 文件 hash（用于变更检测） */
  fileHash: string;
  /** 概要（50-100 字） */
  summary: string;
  /** 结构（章节/模块列表） */
  structure: string[];
  /** 关键决策 */
  keyDecisions: string[];
  /** 最后更新时间（ISO 8601） */
  updatedAt: string;
}

// ─── 最小化 IPC 处理器类型 ────────────────────────────────
// 区段说明：Agent 未就绪时仍需响应的配置/状态/LLM 测试等通道所需的
// 可变状态与回调契约，由 main.ts 注入，minimalHandlers.ts 消费。

/**
 * Agent 运行时状态
 *
 * 由 main.ts 构造，通过 MinimalIpcCallbacks.setAppRuntime 注入。
 * Agent 就绪后持有 agent/sprite/sessionStore/close 四件套；
 * reinit 失败时被置为 null，IPC 处理器据此降级。
 */
export interface AppRuntime {
  /** Agent 实例（对话 + 记忆） */
  agent: Agent;
  /** Sprite 实例（精灵控制 + 配置 + 角色） */
  sprite: Sprite;
  /** 会话存储（历史消息加载） */
  sessionStore: SqliteSessionStore;
  /** 资源释放句柄（关闭精灵 + Agent + 存储连接） */
  close: () => Promise<void>;
}

/**
 * 最小化 IPC 处理器需要的可变状态
 *
 * 设计：main.ts 持有此对象引用，IPC 处理器内部通过闭包捕获。
 * main.ts 修改对象属性后，IPC 处理器立即可见。
 */
export interface MinimalIpcState {
  /** Agent 是否就绪（reinit 失败后为 false，拒绝新对话避免使用已关闭 Agent） */
  agentReady: boolean;
  /** 初始化失败时的错误详情（agentReady=false 时向 UI 展示） */
  initErrorDetail: string | null;
  /** 当前对话的 AbortController（中断时调用 abort） */
  currentAbortController: AbortController | null;
  /** 当前数据目录（reinit 后更新，用于事件推送路径定位） */
  currentDataDir: string;
  /** 写入确认待处理回调表（requestId → 确认结果回调） */
  pendingWriteConfirmations: Map<string, (confirmed: boolean) => void>;
  /** 精灵关闭句柄（reinit 前先调用以释放旧资源） */
  closeSprite: (() => Promise<void>) | null;
  /** 审计管理器（Agent 未就绪时审计日志查询降级用） */
  auditManager: AuditManager | null;
  /** 窗口管理器（主题变更等通道需要获取窗口引用） */
  windowManager: WindowManager | undefined;
  /** LLM 配置缓存（用于判断是否需要重新初始化 Agent） */
  lastProvider: string | null;
  /** LLM 配置缓存：model */
  lastModel: string | null;
  /** LLM 配置缓存：baseUrl */
  lastBaseUrl: string | null;
  /** LLM 配置缓存：apiKey */
  lastApiKey: string | null;
}

/**
 * 最小化 IPC 处理器需要的回调函数
 *
 * 这些函数是 main.ts 的局部函数，无法通过 import 获取，需通过回调注入。
 */
export interface MinimalIpcCallbacks {
  /** 集中赋值 agent/sprite/sessionStore/closeSprite */
  setAppRuntime: (runtime: AppRuntime | null) => void;
  /** Agent 就绪后初始化（注册完整 IPC + 事件监听） */
  setupAgentReady: (agent: Agent, sprite: Sprite, sessionStore: SqliteSessionStore, dataDir: string) => void;
  /** 统一错误分类 */
  classifyInitError: (errMessage: string, prefix: string) => string;
  /** 获取当前 Agent 实例（用于运行时切换 Provider） */
  getCurrentAgent: () => Agent | null;
  /** 获取当前 Sprite 实例（用于运行时切换 Provider） */
  getCurrentSprite: () => Sprite | null;
}
