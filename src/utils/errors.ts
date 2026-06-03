/**
 * 统一错误类型
 *
 * 把"系统 Error + 英文 stack trace"包装成"分类清晰 + 中文友好 + 有下一步建议"的错误
 * 详见 03-安全权限-v0.2.md §6 + M-103
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
import { logger } from '@/logging/logger.js';

export type ErrorCategory = 'config' | 'network' | 'llm' | 'tool' | 'security' | 'unknown';

export interface FriendlyErrorOptions {
  /** 用户能看懂的简短标题（中文） */
  title: string;
  /** 详细原因（可含原文） */
  detail?: string;
  /** 下一步建议（数组，按优先级） */
  suggestions: string[];
  /** 错误分类 */
  category: ErrorCategory;
  /** 原始错误（保留 stack） */
  cause?: Error;
}

export class MemoraError extends Error {
  readonly title: string;
  readonly detail: string | undefined;
  readonly suggestions: readonly string[];
  readonly category: ErrorCategory;
  readonly cause: Error | undefined;

  constructor(opts: FriendlyErrorOptions) {
    super(opts.title);
    this.name = 'MemoraError';
    this.title = opts.title;
    this.detail = opts.detail;
    this.suggestions = Object.freeze(opts.suggestions);
    this.category = opts.category;
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

  /**
   * 记录到日志（结构化）
   */
  log(): void {
    logger.error(
      {
        err: this,
        category: this.category,
        title: this.title,
        detail: this.detail,
        suggestions: this.suggestions,
        cause: this.cause?.message,
        stack: this.stack,
      },
      this.title,
    );
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
): MemoraError {
  return new MemoraError({ title, detail, suggestions, category: 'tool', cause });
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

/**
 * 把任意 Error 转成 MemoraError
 * 已经是 MemoraError 的原样返回
 * 未知 Error 包成 unknown 类
 */
export function toFriendlyError(err: unknown): MemoraError {
  if (err instanceof MemoraError) return err;
  if (err instanceof Error) {
    return new MemoraError({
      title: '未预期错误',
      detail: err.message,
      suggestions: ['查看日志文件 ~/.memora/logs/memora.log 获取详情', '如反复出现请提交 issue'],
      category: 'unknown',
      cause: err,
    });
  }
  return new MemoraError({
    title: '未预期错误',
    detail: String(err),
    suggestions: ['查看日志文件 ~/.memora/logs/memora.log 获取详情'],
    category: 'unknown',
  });
}
