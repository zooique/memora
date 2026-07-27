/**
 * 宿主层共享错误类型（P0 错误处理统一）
 *
 * 职责：
 * - 定义 SpriteError 结构化错误类（携带显式 code，替代字符串推断）
 * - re-export ErrorCode 枚举（真理源在 shared/errorCodes.ts，保持调用方不变）
 *
 * 设计原则：
 * - 纯逻辑模块，零 electron 依赖，sprite/electron 层均可导入
 * - SpriteError 继承 Error，不引入运行时副作用
 * - electron/errorHandler.ts 从本模块 re-export，保持公共 API 不变
 *
 * 分层架构：
 *   - ErrorCode 枚举：shared/errorCodes.ts（真理源）→ sprite/errors.ts re-export
 *   - SpriteError 类：sprite/errors.ts（sprite 层错误类）
 *   - StorageError 类：storage/storageError.ts（storage 层错误类，零 sprite 依赖）
 *   - errorHandler.ts：鸭子类型读取 error.code，兼容 SpriteError + StorageError
 */

// ErrorCode 真理源在 shared/errorCodes.ts，re-export 保持调用方导入路径不变
export { ErrorCode } from '../shared/errorCodes.js';

// ─── 结构化错误类 ───────────────────────────────────────

/**
 * 结构化错误类
 *
 * 携带显式 ErrorCode 字段，替代基于中文字符串匹配的 extractErrorCode 推断。
 * 调用方通过 `throw new SpriteError(ErrorCode.FILE_READ_FAILED, '...')` 显式指定错误类型，
 * ErrorHandler.normalizeError 优先读取 error.code，仅在未携带 code 时降级到字符串匹配。
 */
import { ErrorCode } from '../shared/errorCodes.js';

export class SpriteError extends Error {
  /** 显式错误代码（优先于字符串推断） */
  readonly code: ErrorCode;
  /** 附加上下文信息（结构化数据，用于日志和调试） */
  readonly context?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown; context?: Record<string, unknown> }) {
    super(message, options as ErrorOptions);
    this.name = 'SpriteError';
    this.code = code;
    this.context = options?.context;
  }
}
