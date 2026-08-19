/**
 * 统一错误类型——把"系统 Error + 英文 stack"包装成"分类清晰 + 中文友好 + 有下一步建议"。
 * 4 大类：ConfigError（配置）/ NetworkError（网络）/ LlmError（LLM）/ ToolError（工具）。
 * 展示：标题（一眼看出问题）+ 详情（排查用）+ 建议（怎么修复）。
 */
export { toError } from '@/utils/toError.js';
// toError 实现位于 ./toError.ts（纯逻辑、零 logger、浏览器友好），此处 re-export 保持兼容

type ErrorCategory = 'config' | 'network' | 'llm' | 'tool' | 'security' | 'unknown';

/**
 * 工具错误码——供 AgentLoop 的 Reflection（自修正）判断是否可重试：
 * retryable 表示 LLM 调整参数后可重试；non-retryable 重试无意义。
 */
export const ToolErrorCode = {
  /** 路径不在白名单内（不可重试） */
  PATH_NOT_ALLOWED: 'PATH_NOT_ALLOWED',
  /** 文件不存在（可重试） */
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  /** 权限不足（不可重试） */
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  /** 参数错误（可重试） */
  ARGUMENT_ERROR: 'ARGUMENT_ERROR',
  /** 用户拒绝写入（不可重试） */
  WRITE_REJECTED: 'WRITE_REJECTED',
  /** 目录不存在（可重试） */
  DIR_NOT_FOUND: 'DIR_NOT_FOUND',
  /** 未知工具（不可重试） */
  UNKNOWN_TOOL: 'UNKNOWN_TOOL',
  /** 自定义工具执行失败（可重试） */
  CUSTOM_TOOL_FAILED: 'CUSTOM_TOOL_FAILED',
  /** 通用错误（不可重试） */
  UNKNOWN: 'UNKNOWN',
} as const;

export type ToolErrorCodeValue = (typeof ToolErrorCode)[keyof typeof ToolErrorCode];

/** 可重试错误码集合 */
const RETRYABLE_ERROR_CODES = new Set<ToolErrorCodeValue>([
  ToolErrorCode.FILE_NOT_FOUND,
  ToolErrorCode.ARGUMENT_ERROR,
  ToolErrorCode.DIR_NOT_FOUND,
  ToolErrorCode.CUSTOM_TOOL_FAILED,
]);

export function isRetryableErrorCode(code: ToolErrorCodeValue): boolean {
  return RETRYABLE_ERROR_CODES.has(code);
}

interface FriendlyErrorOptions {
  title: string;
  detail?: string;
  suggestions: string[];
  category: ErrorCategory;
  errorCode?: ToolErrorCodeValue;
  cause?: Error;
}

export class MemoraError extends Error {
  readonly title: string;
  readonly detail: string | undefined;
  readonly suggestions: readonly string[];
  readonly category: ErrorCategory;
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

  /** 格式化为用户可读的展示字符串 */
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

/** 工厂：配置错误 */
export function configError(
  title: string,
  detail: string | undefined,
  suggestions: string[],
  cause?: Error,
): MemoraError {
  return new MemoraError({ title, detail, suggestions, category: 'config', cause });
}

/** 工厂：对话繁忙错误——chat() 进行中拒绝其他需独占 Agent 的操作，统一模板用此工厂 */
export function chatBusyError(action: string): MemoraError {
  return configError(
    '对话繁忙',
    `上一轮对话尚未完成，请等待其结束后再${action}`,
    ['等待当前对话完成后重试'],
  );
}

/** 工厂：网络错误 */
export function networkError(
  title: string,
  detail: string | undefined,
  suggestions: string[],
  cause?: Error,
): MemoraError {
  return new MemoraError({ title, detail, suggestions, category: 'network', cause });
}

/** 工厂：LLM 错误 */
export function llmError(
  title: string,
  detail: string | undefined,
  suggestions: string[],
  cause?: Error,
): MemoraError {
  return new MemoraError({ title, detail, suggestions, category: 'llm', cause });
}

/** 工厂：工具错误 */
export function toolError(
  title: string,
  detail: string | undefined,
  suggestions: string[],
  cause?: Error,
  errorCode?: ToolErrorCodeValue,
): MemoraError {
  return new MemoraError({ title, detail, suggestions, category: 'tool', cause, errorCode });
}

/** 工厂：安全错误（路径越界、黑名单命中、权限不足等） */
export function securityError(
  title: string,
  detail: string | undefined,
  suggestions: string[],
  cause?: Error,
): MemoraError {
  return new MemoraError({ title, detail, suggestions, category: 'security', cause });
}

/** 判断是否为 AbortError（用户主动取消或超时中断）——统一基于 err.name === 'AbortError'，
 *  兼容原生 DOMException / 普通 Error 子类 / toError() 规范化后对象。 */
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}