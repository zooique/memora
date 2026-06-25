/**
 * 统一错误处理工具
 *
 * 职责：
 * - 提供统一的错误处理函数
 * - 用户友好的错误消息
 * - 错误分类和严重程度判断
 */

import type { BrowserWindow } from 'electron';
import { toError, logger } from 'memora';
import { MAIN_TO_RENDERER_CHANNELS } from './ipc/channels.js';
import type { SerializedAppError } from './ipc/channels.js';

// ─── 错误类型定义 ─────────────────────────────────────────

export enum ErrorCode {
  // 通用错误
  UNKNOWN = 'UNKNOWN',
  INITIALIZATION_FAILED = 'INITIALIZATION_FAILED',
  CONFIG_LOAD_FAILED = 'CONFIG_LOAD_FAILED',

  // 窗口相关错误
  WINDOW_CREATE_FAILED = 'WINDOW_CREATE_FAILED',

  // 文件系统错误
  FILE_READ_FAILED = 'FILE_READ_FAILED',

  // 网络错误
  NETWORK_ERROR = 'NETWORK_ERROR',
  API_ERROR = 'API_ERROR',
}

export interface AppError {
  code: ErrorCode;
  message: string;
  originalError?: Error;
  context?: Record<string, unknown>;
  timestamp: Date;
}

/**
 * 结构化错误类（P1-CODE-1 修复）
 *
 * 携带显式 ErrorCode 字段，替代基于中文字符串匹配的 extractErrorCode 推断。
 * 调用方通过 `throw new MemoraError(ErrorCode.FILE_READ_FAILED, '...')` 显式指定错误类型，
 * ErrorHandler.normalizeError 优先读取 error.code，仅在未携带 code 时降级到字符串匹配。
 */
export class MemoraError extends Error {
  /** 显式错误代码（优先于字符串推断） */
  readonly code: ErrorCode;
  /** 附加上下文信息（结构化数据，用于日志和调试） */
  readonly context?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown; context?: Record<string, unknown> }) {
    super(message, options as ErrorOptions);
    this.name = 'MemoraError';
    this.code = code;
    this.context = options?.context;
  }
}

// ─── 错误处理类 ─────────────────────────────────────────

export class ErrorHandler {
  private mainWindow: BrowserWindow | null = null;

  /** 设置主窗口引用 */
  setMainWindow(win: BrowserWindow): void {
    this.mainWindow = win;
  }

  /**
   * 处理错误
   *
   * @param error 原始错误对象
   * @param options 选项：code 显式指定错误代码（优先于从 message 推断）；context 人类可读的上下文描述
   */
  handle(error: unknown, options?: { code?: ErrorCode; context?: string }): AppError {
    const appError = this.normalizeError(error, options?.code, options?.context);

    // 显示用户友好的错误消息
    this.showErrorToUser(appError);

    // 输出结构化日志
    this.logError(appError);

    return appError;
  }

  /**
   * 标准化错误对象
   *
   * 复用内核 toError 完成 unknown → Error 转换。
   * code 优先级（P1-CODE-1 修复）：
   *   1. 调用方显式传入 explicitCode
   *   2. MemoraError 携带的 error.code（结构化错误）
   *   3. 从 error.message 字符串推断（降级 fallback，已废弃，新增错误应使用 MemoraError）
   *   4. UNKNOWN
   */
  private normalizeError(error: unknown, explicitCode?: ErrorCode, context?: string): AppError {
    const err = toError(error);
    // 优先读取结构化错误码：MemoraError 实例携带 code 字段
    const structCode = err instanceof MemoraError ? err.code : undefined;
    return {
      code: explicitCode ?? structCode ?? this.extractErrorCode(err),
      message: err.message,
      originalError: err,
      context: context ? { description: context } : undefined,
      timestamp: new Date(),
    };
  }

  /**
   * 从错误对象中提取错误代码（降级 fallback）
   *
   * @deprecated 新增错误应使用 `throw new MemoraError(ErrorCode.XXX, msg)` 显式指定 code。
   *             此方法仅作为未携带 code 的遗留错误降级路径保留。
   */
  private extractErrorCode(error: Error): ErrorCode {
    // 检查常见的错误模式（降级路径，存在误匹配风险，新增错误应使用 MemoraError）
    if (error.message.includes('ENOENT') || error.message.includes('文件')) {
      return ErrorCode.FILE_READ_FAILED;
    }

    if (error.message.includes('网络') || error.message.includes('fetch')) {
      return ErrorCode.NETWORK_ERROR;
    }

    if (error.message.includes('初始化') || error.message.includes('init')) {
      return ErrorCode.INITIALIZATION_FAILED;
    }

    return ErrorCode.UNKNOWN;
  }

  /** 显示用户友好的错误消息 */
  private showErrorToUser(error: AppError): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return;
    }

    const userMessage = this.getUserFriendlyMessage(error);

    // 发送错误消息到渲染进程
    const serializedError: SerializedAppError = {
      code: error.code,
      message: userMessage,
      timestamp: error.timestamp.toISOString(),
    };
    // QC-16 修复 TOCTOU 竞态：isDestroyed 检查与 send 之间窗口可能被销毁，用 try-catch 兜底
    try {
      this.mainWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.APP_ERROR, serializedError);
    } catch {
      // 窗口在 send 调用瞬间被销毁，错误已通过 logError 记录，无需额外处理
    }
  }

  /** 获取用户友好的错误消息 */
  private getUserFriendlyMessage(error: AppError): string {
    const errorMessages: Record<ErrorCode, string> = {
      [ErrorCode.UNKNOWN]: '发生未知错误，请稍后重试',
      // 初始化失败的原因多样（配置缺失、native 模块加载失败、数据库错误等），
      // 笼统提示"重启应用"会误导用户——重启无法解决 better-sqlite3 ABI 不匹配等问题。
      // 具体错误信息通过 AGENT_STATUS 通道返回，渲染进程在对话区显示详情。
      [ErrorCode.INITIALIZATION_FAILED]: 'Agent 初始化失败，请查看对话区的详细错误信息',
      [ErrorCode.CONFIG_LOAD_FAILED]: '配置加载失败，使用默认配置',
      [ErrorCode.WINDOW_CREATE_FAILED]: '窗口创建失败，请重启应用',
      [ErrorCode.FILE_READ_FAILED]: '文件读取失败，请检查文件权限',
      [ErrorCode.NETWORK_ERROR]: '网络连接失败，请检查网络设置',
      [ErrorCode.API_ERROR]: 'API调用失败，请稍后重试',
    };

    return errorMessages[error.code] || error.message;
  }

  /** 输出结构化日志（替代 console.error，与项目日志规范一致） */
  private logError(error: AppError): void {
    // 使用 logger.error 结构化输出，便于日志聚合和过滤
    logger.error(
      {
        code: error.code,
        context: error.context,
        originalError: error.originalError,
      },
      error.message,
    );
  }
}

// ─── 全局错误处理器实例 ─────────────────────────────────

export const errorHandler = new ErrorHandler();
