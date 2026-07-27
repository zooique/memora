/**
 * 存储层错误类型（零上层依赖）
 *
 * 职责：
 * - 定义 storage 层自有的结构化错误类 StorageError
 * - 携带显式 ErrorCode 字段，供 errorHandler.normalizeError 鸭子类型读取
 *
 * 设计原则：
 * - 纯逻辑模块，零 sprite/electron 依赖
 * - ErrorCode 从 shared/errorCodes.ts 导入（跨层共享契约）
 * - StorageError 继承 Error，不引入运行时副作用
 *
 * 与 SpriteError 的关系：
 * - 两者均携带 code: ErrorCode 字段，但互不继承
 * - errorHandler.ts 通过鸭子类型（'code' in err）统一识别，不依赖 instanceof
 * - storage 层抛 StorageError，sprite/electron 层抛 SpriteError，分层清晰
 */

import { ErrorCode } from '../shared/errorCodes.js';

/**
 * 存储层结构化错误类
 *
 * 携带显式 ErrorCode 字段，与 SpriteError 行为对齐但独立定义。
 * 调用方通过 `throw new StorageError(ErrorCode.VALIDATION_ERROR, '...')` 显式指定错误类型，
 * errorHandler.normalizeError 通过鸭子类型读取 error.code 字段进行分类。
 */
export class StorageError extends Error {
  /** 显式错误代码（与 SpriteError.code 同源，均来自 shared/errorCodes.ts） */
  readonly code: ErrorCode;
  /** 附加上下文信息（结构化数据，用于日志和调试） */
  readonly context?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown; context?: Record<string, unknown> }) {
    super(message, options as ErrorOptions);
    this.name = 'StorageError';
    this.code = code;
    this.context = options?.context;
  }
}
