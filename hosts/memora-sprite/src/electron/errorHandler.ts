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
// STEP9-IMPORTS-01 反向 type-only 引用：编译期擦除，禁止改为 value import（否则与 ipc/types 形成运行时循环依赖）
// SerializedAppError 真理源在 ipc/types.ts
import type { SerializedAppError } from './ipc/types.js';

// ─── 错误类型定义 ─────────────────────────────────────────
// ErrorCode + SpriteError 定义在 sprite/errors.ts（纯逻辑层，零 electron 依赖），本模块 re-export 保持公共 API 不变
import { ErrorCode, SpriteError } from '../sprite/errors.js';
export { ErrorCode, SpriteError };

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
   * code 优先级：
   *   1. 调用方显式传入 explicitCode
   *   2. 错误对象携带的 error.code 字段（鸭子类型识别 SpriteError + StorageError）
   *   3. 从 error.message 字符串推断（降级 fallback，已废弃，新增错误应使用 SpriteError/StorageError）
   *   4. UNKNOWN
   *
   * 鸭子类型读取 code 字段，兼容 sprite 层 SpriteError + storage 层 StorageError
   * （两者均携带 code: ErrorCode 字段但互不继承，均从 shared/errorCodes.ts 导入枚举）。
   */
  private normalizeError(error: unknown, explicitCode?: ErrorCode, context?: string): AppError {
    const err = toError(error);
    // 鸭子类型读取 code 字段：兼容 SpriteError（sprite 层）+ StorageError（storage 层）
    const structCode = (err instanceof Error && 'code' in err && typeof (err as { code?: unknown }).code === 'string')
      ? (err as { code: ErrorCode }).code
      : undefined;
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
   * @deprecated 新增错误应使用 `throw new SpriteError(ErrorCode.XXX, msg)` 或
   *             `throw new StorageError(ErrorCode.XXX, msg)` 显式指定 code。
   *             此方法仅作为未携带 code 的遗留错误降级路径保留。
   *
   * 本降级路径仅覆盖遗留错误的关键词推断，STORAGE_ERROR / VALIDATION_ERROR
   * 等新错误码必须通过 SpriteError/StorageError 显式携带，不在此降级路径中追加关键词。
   * 新增 throw 一律使用 `throw new SpriteError(ErrorCode.XXX, msg)`，
   * normalizeError 会优先读取 error.code，仅在未携带 code 时才回退到此方法。
   */
  private extractErrorCode(error: Error): ErrorCode {
    // 检查常见的错误模式（降级路径，存在误匹配风险，新增错误应使用 SpriteError）
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
    // TOCTOU 竞态兜底：isDestroyed 检查与 send 之间窗口可能被销毁，用 try-catch 保护
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
      [ErrorCode.STORAGE_ERROR]: '存储操作失败，请检查数据目录权限',
      [ErrorCode.VALIDATION_ERROR]: '数据校验失败，请检查输入内容',
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
