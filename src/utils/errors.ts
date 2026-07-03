/**
 * 统一错误类型
 *
 * 把"系统 Error + 英文 stack trace"包装成"分类清晰 + 中文友好 + 有下一步建议"的错误
 * 详见 ADR-006 · 安全模型
 *
 * 4 大类：
 *   - ConfigError      配置错误（apiKey 缺失、provider 不支持等）
 *   - NetworkError     网络错误（连接超时、DNS 失败、限流等）
 *   - LlmError         LLM 错误（4xx/5xx、返回异常 JSON）
 *   - ToolError        工具错误（路径越界、参数无效等）
 *
 * 错误展示原则：
 *   1. 标题（中文）—— 一眼看出什么问题
 *   2. 详情（原文）—— 排查用
 *   3. 建议（下一步）—— 怎么修复
 */
// P3-08：re-export toError 供混合 import 场景使用（如 import { securityError, toError }）
// 注：原注释"纯逻辑 toError，浏览器端可直接 import 此文件而不引入 logger 依赖"已删除——
// P3-05 删除 MemoraError.log() 后 errors.ts 不再 import loggerHolder，但 errors.ts
// 仍通过 MemoraError 的 formatWithSuggestions 等方法间接依赖运行时 logger（通过 index.ts 的 setLogger）。
// 单独需要 toError 的场景应直接 import from '@/utils/toError.js'（零 logger 依赖，浏览器友好）。
export { toError } from '@/utils/toError.js';

export type ErrorCategory = 'config' | 'network' | 'llm' | 'tool' | 'security' | 'unknown';

/**
 * 工具错误码 — 用于 AgentLoop 的 Reflection（反思/自修正）逻辑
 *
 * 每个错误码关联一个 retryable 标记：
 *   - retryable：LLM 可以调整参数后重试（如文件路径错误、参数类型错误）
 *   - non-retryable：重试无意义（如权限拒绝、用户拒绝写入）
 */
export const ToolErrorCode = {
  /** 路径不在白名单内（不可重试） */
  PATH_NOT_ALLOWED: 'PATH_NOT_ALLOWED',
  /** 文件不存在（可重试 — LLM 可能用错了路径） */
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  /** 权限不足（不可重试） */
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  /** 工具参数错误（可重试 — LLM 可以修正参数格式） */
  ARGUMENT_ERROR: 'ARGUMENT_ERROR',
  /**
   * 工具执行超时（可重试）
   *
   * R-03：预留错误码，当前无业务代码抛出。
   * 待 toolExecutor 实现工具执行超时机制后启用（如 Promise.race + AbortSignal）。
   * 保留在 RETRYABLE_ERROR_CODES 中以维持公共 API 契约稳定。
   */
  TOOL_TIMEOUT: 'TOOL_TIMEOUT',
  /** 用户拒绝写入（不可重试） */
  WRITE_REJECTED: 'WRITE_REJECTED',
  /** 目录不存在（可重试 — LLM 可能用错了路径） */
  DIR_NOT_FOUND: 'DIR_NOT_FOUND',
  /** 未知工具（不可重试 — 工具未注册） */
  UNKNOWN_TOOL: 'UNKNOWN_TOOL',
  /** 自定义工具执行失败（可重试） */
  CUSTOM_TOOL_FAILED: 'CUSTOM_TOOL_FAILED',
  /** 通用错误（不可重试） */
  UNKNOWN: 'UNKNOWN',
} as const;

export type ToolErrorCodeValue = (typeof ToolErrorCode)[keyof typeof ToolErrorCode];

/**
 * 判断错误码是否可重试
 */
const RETRYABLE_ERROR_CODES = new Set<ToolErrorCodeValue>([
  ToolErrorCode.FILE_NOT_FOUND,
  ToolErrorCode.ARGUMENT_ERROR,
  ToolErrorCode.TOOL_TIMEOUT,
  ToolErrorCode.DIR_NOT_FOUND,
  ToolErrorCode.CUSTOM_TOOL_FAILED,
]);

export function isRetryableErrorCode(code: ToolErrorCodeValue): boolean {
  return RETRYABLE_ERROR_CODES.has(code);
}

export interface FriendlyErrorOptions {
  /** 用户能看懂的简短标题（中文） */
  title: string;
  /** 详细原因（可含原文） */
  detail?: string;
  /** 下一步建议（数组，按优先级） */
  suggestions: string[];
  /** 错误分类 */
  category: ErrorCategory;
  /** 工具错误码（用于 AgentLoop Reflection 判断是否可重试） */
  errorCode?: ToolErrorCodeValue;
  /** 原始错误（保留 stack） */
  cause?: Error;
}

export class MemoraError extends Error {
  readonly title: string;
  readonly detail: string | undefined;
  readonly suggestions: readonly string[];
  readonly category: ErrorCategory;
  /** 工具错误码（用于 AgentLoop 反思判断是否可重试） */
  readonly errorCode: ToolErrorCodeValue | undefined;
  readonly cause: Error | undefined;

  constructor(opts: FriendlyErrorOptions) {
    super(opts.title);
    this.name = 'MemoraError';
    this.title = opts.title;
    this.detail = opts.detail;
    this.suggestions = Object.freeze(opts.suggestions);
    this.category = opts.category;
    this.errorCode = opts.errorCode;
    this.cause = opts.cause;
  }

  /**
   * 格式化为用户可读的展示字符串
   */
  format(): string {
    const lines: string[] = [];
    lines.push(`❌ ${this.title}`);
    if (this.detail) lines.push(`   原因：${this.detail}`);
    if (this.suggestions.length > 0) {
      lines.push(`   建议：`);
      for (const s of this.suggestions) {
        lines.push(`     - ${s}`);
      }
    }
    return lines.join('\n');
  }
}

/**
 * 工厂：配置错误
 */
export function configError(
  title: string,
  detail: string | undefined,
  suggestions: string[],
  cause?: Error,
): MemoraError {
  return new MemoraError({ title, detail, suggestions, category: 'config', cause });
}

/**
 * 工厂：网络错误
 */
export function networkError(
  title: string,
  detail: string | undefined,
  suggestions: string[],
  cause?: Error,
): MemoraError {
  return new MemoraError({ title, detail, suggestions, category: 'network', cause });
}

/**
 * 工厂：LLM 错误
 */
export function llmError(
  title: string,
  detail: string | undefined,
  suggestions: string[],
  cause?: Error,
): MemoraError {
  return new MemoraError({ title, detail, suggestions, category: 'llm', cause });
}

/**
 * 工厂：工具错误
 */
export function toolError(
  title: string,
  detail: string | undefined,
  suggestions: string[],
  cause?: Error,
  errorCode?: ToolErrorCodeValue,
): MemoraError {
  return new MemoraError({ title, detail, suggestions, category: 'tool', cause, errorCode });
}

/**
 * 工厂：安全错误（路径越界、黑名单命中、权限不足等）
 */
export function securityError(
  title: string,
  detail: string | undefined,
  suggestions: string[],
  cause?: Error,
): MemoraError {
  return new MemoraError({ title, detail, suggestions, category: 'security', cause });
}

// toError 已移至 ./toError.ts（纯逻辑，零依赖），此处 re-export 保持向后兼容
