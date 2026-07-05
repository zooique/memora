/**
 * 宿主层共享错误类型（P0 错误处理统一）
 *
 * 职责：
 * - 定义跨层共享的 ErrorCode 枚举（错误分类的真理源）
 * - 定义 MemoraError 结构化错误类（携带显式 code，替代字符串推断）
 *
 * 设计原则：
 * - 纯逻辑模块，零 electron 依赖，sprite/storage/electron 层均可导入
 * - MemoraError 继承 Error，不引入运行时副作用
 * - electron/errorHandler.ts 从本模块 re-export，保持公共 API 不变
 *
 * 架构方向：electron 依赖 sprite（不反向），因此错误类型定义在 sprite 层。
 */

// ─── 错误码枚举 ─────────────────────────────────────────

/**
 * 错误代码枚举
 *
 * 用于 MemoraError.code 字段和 ErrorHandler.normalizeError 的错误分类。
 * 新增错误码时同步更新 electron/errorHandler.ts 的 getUserFriendlyMessage。
 */
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

  // P0-B 新增：存储与校验错误（sprite/storage 层 throw 使用）
  /** 存储层错误（存储不可用、写入失败等） */
  STORAGE_ERROR = 'STORAGE_ERROR',
  /** 数据校验错误（source 校验失败、参数非法、重复注册等） */
  VALIDATION_ERROR = 'VALIDATION_ERROR',
}

// ─── 结构化错误类 ───────────────────────────────────────

/**
 * 结构化错误类
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
