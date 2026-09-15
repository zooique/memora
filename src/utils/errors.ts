/**
 * 统一错误类型——把"系统 Error + 英文 stack"包装成"分类清晰 + 中文友好 + 有下一步建议"。
 * 4 大类：ConfigError（配置）/ NetworkError（网络）/ LlmError（LLM）/ ToolError（工具）。
 * 展示：标题（一眼看出问题）+ 详情（排查用）+ 建议（怎么修复）。
 */

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

/** 判断 AbortSignal 是否为「超时中断」（chat 锁超时 / LLM 无响应超时统一以 TimeoutError reason 标识）。
 *  与用户取消（abort() 无 reason / AbortError reason）区分——锁超时中断不能谎报成用户取消。 */
export function isTimeoutAbortSignal(signal: AbortSignal | undefined): boolean {
  return (
    signal?.aborted === true &&
    signal.reason instanceof DOMException &&
    signal.reason.name === 'TimeoutError'
  );
}

/**
 * 判断**抛出的错误**是否为「超时」（非 abort 路径的载体）。
 *
 * 与 `isTimeoutAbortSignal` 是**同一语义的两种载体**（同判 `name === 'TimeoutError'`）：
 * 前者看 `signal.reason`（signal 被 abort 的路径），本函数看**被抛出的错误对象**——
 * 典型场景 = `openaiCompatible.parseSseStream` 的 SSE 停摆看门狗（`Promise.race` 竞速闸
 * reject `DOMException('…','TimeoutError')`），它不经过 abort signal，故被归类为「失败」
 * 而非「中断」，最终由 `consumeExecutionStream` 的通用 catch 收口。
 *
 * **用途（否则宿主文案不可达）**：把超时归入 `error.category = 'timeout'`，让宿主
 * `chatPanel` 的 `friendlyByCategory.timeout`（「对话处理超时，请稍后重试」）真正生效；
 * 缺该分类时宿主只能回退**原始技术文案**（DOMException message），用户读到的是侦探材料。
 *
 * 注：`toError()` 对 Error 实例原样返回（实测 `DOMException instanceof Error === true`），
 * 故经 `llmCaller` 的 `toError(err)` 再 rethrow 后 `name` 不丢，本判据在链路末端依然成立。
 */
export function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && err.name === 'TimeoutError';
}