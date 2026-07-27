/**
 * 跨层共享错误码枚举（零依赖）
 *
 * 设计原则：
 * - 本文件只放纯值枚举，禁止引入 Node.js 内置模块或任何运行时依赖
 * - 允许被所有层（shared/sprite/storage/electron/renderer）安全导入
 * - 真理源位于 shared 层，sprite/errors.ts re-export 保持调用方不变
 * - storage/sprite/electron 层的错误类均从本模块导入 ErrorCode
 */

/**
 * 错误代码枚举
 *
 * 用于 SpriteError/StorageError.code 字段和 ErrorHandler.normalizeError 的错误分类。
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

  /** 存储层错误（存储不可用、写入失败等） */
  STORAGE_ERROR = 'STORAGE_ERROR',
  /** 数据校验错误（source 校验失败、参数非法、重复注册等） */
  VALIDATION_ERROR = 'VALIDATION_ERROR',
}
