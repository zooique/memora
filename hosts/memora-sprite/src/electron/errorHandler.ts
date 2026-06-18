/**
 * 统一错误处理工具
 *
 * 职责：
 * - 提供统一的错误处理函数
 * - 错误日志记录
 * - 用户友好的错误消息
 * - 错误分类和严重程度判断
 */

import type { BrowserWindow } from 'electron';

// ─── 错误类型定义 ─────────────────────────────────────────

export enum ErrorCode {
  // 通用错误
  UNKNOWN = 'UNKNOWN',
  INITIALIZATION_FAILED = 'INITIALIZATION_FAILED',
  CONFIG_LOAD_FAILED = 'CONFIG_LOAD_FAILED',
  
  // 窗口相关错误
  WINDOW_CREATE_FAILED = 'WINDOW_CREATE_FAILED',
  WINDOW_LOAD_FAILED = 'WINDOW_LOAD_FAILED',
  
  // IPC相关错误
  IPC_HANDLER_FAILED = 'IPC_HANDLER_FAILED',
  IPC_SEND_FAILED = 'IPC_SEND_FAILED',
  
  // 文件系统错误
  FILE_READ_FAILED = 'FILE_READ_FAILED',
  FILE_WRITE_FAILED = 'FILE_WRITE_FAILED',
  
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
  private errorLog: AppError[] = [];
  private maxLogSize = 1000;

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

    // 记录错误
    this.logError(appError);

    // 显示用户友好的错误消息
    this.showErrorToUser(appError);

    // 输出到控制台
    this.logToConsole(appError);

    return appError;
  }

  /**
   * 标准化错误对象
   *
   * code 优先级：调用方显式传入 > 从 error.message 推断 > UNKNOWN
   */
  private normalizeError(error: unknown, explicitCode?: ErrorCode, context?: string): AppError {
    if (error instanceof Error) {
      return {
        code: explicitCode ?? this.extractErrorCode(error),
        message: error.message,
        originalError: error,
        context: context ? { description: context } : undefined,
        timestamp: new Date(),
      };
    }

    if (typeof error === 'string') {
      return {
        code: explicitCode ?? ErrorCode.UNKNOWN,
        message: error,
        context: context ? { description: context } : undefined,
        timestamp: new Date(),
      };
    }

    return {
      code: explicitCode ?? ErrorCode.UNKNOWN,
      message: '发生未知错误',
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

  /** 记录错误到内存日志 */
  private logError(error: AppError): void {
    this.errorLog.push(error);
    
    // 保持日志大小在限制内
    if (this.errorLog.length > this.maxLogSize) {
      this.errorLog.shift();
    }
  }

  /** 显示用户友好的错误消息 */
  private showErrorToUser(error: AppError): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return;
    }

    const userMessage = this.getUserFriendlyMessage(error);
    
    // 发送错误消息到渲染进程
    this.mainWindow.webContents.send('app-error', {
      code: error.code,
      message: userMessage,
      timestamp: error.timestamp.toISOString(),
    });
  }

  /** 获取用户友好的错误消息 */
  private getUserFriendlyMessage(error: AppError): string {
    const errorMessages: Record<ErrorCode, string> = {
      [ErrorCode.UNKNOWN]: '发生未知错误，请稍后重试',
      [ErrorCode.INITIALIZATION_FAILED]: '应用初始化失败，请重启应用',
      [ErrorCode.CONFIG_LOAD_FAILED]: '配置加载失败，使用默认配置',
      [ErrorCode.WINDOW_CREATE_FAILED]: '窗口创建失败，请重启应用',
      [ErrorCode.WINDOW_LOAD_FAILED]: '页面加载失败，请检查网络连接',
      [ErrorCode.IPC_HANDLER_FAILED]: '操作执行失败，请稍后重试',
      [ErrorCode.IPC_SEND_FAILED]: '通信失败，请重启应用',
      [ErrorCode.FILE_READ_FAILED]: '文件读取失败，请检查文件权限',
      [ErrorCode.FILE_WRITE_FAILED]: '文件保存失败，请检查磁盘空间',
      [ErrorCode.NETWORK_ERROR]: '网络连接失败，请检查网络设置',
      [ErrorCode.API_ERROR]: 'API调用失败，请稍后重试',
    };

    return errorMessages[error.code] || error.message;
  }

  /** 输出到控制台 */
  private logToConsole(error: AppError): void {
    const logMessage = `[${error.timestamp.toISOString()}] ${error.code}: ${error.message}`;
    
    if (error.originalError) {
      console.error(logMessage, error.originalError);
    } else {
      console.error(logMessage);
    }
    
    if (error.context) {
      console.error('Context:', error.context);
    }
  }

  /** 获取错误日志 */
  getErrorLog(): AppError[] {
    return [...this.errorLog];
  }

  /** 清除错误日志 */
  clearErrorLog(): void {
    this.errorLog = [];
  }

  /** 获取最近的错误 */
  getRecentErrors(count: number = 10): AppError[] {
    return this.errorLog.slice(-count);
  }
}

// ─── 全局错误处理器实例 ─────────────────────────────────

export const errorHandler = new ErrorHandler();

// ─── 便捷函数 ─────────────────────────────────────────

/** 处理异步错误 */
export async function handleAsyncError<T>(
  operation: () => Promise<T>,
  options?: { code?: ErrorCode; context?: string },
): Promise<T | null> {
  try {
    return await operation();
  } catch (error) {
    errorHandler.handle(error, options);
    return null;
  }
}

/** 处理同步错误 */
export function handleSyncError<T>(
  operation: () => T,
  options?: { code?: ErrorCode; context?: string },
): T | null {
  try {
    return operation();
  } catch (error) {
    errorHandler.handle(error, options);
    return null;
  }
}

/** 包装异步函数，自动处理错误 */
export function wrapAsyncFunction<T extends (...args: never[]) => Promise<unknown>>(
  fn: T,
  options?: { code?: ErrorCode; context?: string },
): T {
  return ((...args: never[]) => {
    return handleAsyncError(() => fn(...args), options);
  }) as T;
}

/** 包装同步函数，自动处理错误 */
export function wrapSyncFunction<T extends (...args: never[]) => unknown>(
  fn: T,
  options?: { code?: ErrorCode; context?: string },
): T {
  return ((...args: never[]) => {
    return handleSyncError(() => fn(...args), options);
  }) as T;
}