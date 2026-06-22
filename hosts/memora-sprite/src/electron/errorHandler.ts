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
import { MAIN_TO_RENDERER_CHANNELS } from './ipcChannels.js';
import type { SerializedAppError } from './ipcChannels.js';

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
   * code 优先级：调用方显式传入 > 从 error.message 推断 > UNKNOWN
   */
  private normalizeError(error: unknown, explicitCode?: ErrorCode, context?: string): AppError {
    const err = toError(error);
    return {
      code: explicitCode ?? this.extractErrorCode(err),
      message: err.message,
      originalError: err,
      context: context ? { description: context } : undefined,
      timestamp: new Date(),
    };
  }

  /** 从错误对象中提取错误代码 */
  private extractErrorCode(error: Error): ErrorCode {
    // 检查常见的错误模式
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
    this.mainWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.APP_ERROR, serializedError);
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
