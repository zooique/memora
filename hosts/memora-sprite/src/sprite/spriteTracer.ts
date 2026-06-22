/**
 * SpriteTracer — M3 ITracer 可观测性最小实现
 *
 * 设计目标：为桌面精灵场景提供零依赖的 Span 收集器，
 * 以 JSONL 格式输出 trace 日志到 dataDir/trace.log。
 *
 * 架构定位：
 *   - 宿主层（sprite）的策略实现，不修改 memora 内核
 *   - 仅实现 ITracer 接口，通过 AgentOptions.tracer 注入
 *   - 与 auditManager 同构：JSONL 输出 + fire-and-forget 写入
 *
 * 设计约束：
 *   - 零外部依赖（符合 ADR-001 零依赖原则）
 *   - 写入为 fire-and-forget（不阻塞 AgentLoop）
 *   - 保持文件大小可控：最大 1000 条，超出时从头截断
 *
 * 与审计日志的区别（M2 vs M3）：
 *   - audit.log：安全事件（文件访问/写入/拒绝）—— 合规追踪
 *   - trace.log：性能指标（LLM 调用/记忆召回/工具执行耗时）—— 性能调试
 */

import { appendFile, readFile, writeFile } from 'node:fs/promises';
import type { ITracer, ISpan } from 'memora';

/** 单条 trace 记录（JSONL 每行） */
interface TraceEntry {
  /** span 名称（如 'llm.call'、'tool.execute'） */
  name: string;
  /** span 起始时间（ISO 8601） */
  startedAt: string;
  /** span 结束时间（ISO 8601），异常结束时为 null */
  endedAt: string | null;
  /** span 耗时（毫秒），异常结束时为 null */
  durationMs: number | null;
  /** span 属性（键值对元数据） */
  attributes: Record<string, string | number | boolean>;
  /** 是否以异常结束（true 时记录了 exception） */
  hasError: boolean;
  /** 异常信息（可选） */
  errorMessage?: string;
}

/**
 * SpriteSpan — 实现 ISpan 接口
 *
 * 记录 startSpan 的时间戳，end() 时将完整记录写入 trace.log。
 * 写入失败时静默降级（不抛错，保持宿主稳定）。
 */
class SpriteSpan implements ISpan {
  private readonly name: string;
  private readonly logFilePath: string;
  private readonly maxEntries: number;
  private readonly attributes: Record<string, string | number | boolean>;
  private readonly startTime: number;
  private readonly startIso: string;
  private hasError = false;
  private errorMessage = '';
  private ended = false;

  constructor(name: string, attributes: Record<string, string | number | boolean>, logFilePath: string, maxEntries: number) {
    this.name = name;
    this.attributes = { ...attributes };
    this.startTime = Date.now();
    this.startIso = new Date(this.startTime).toISOString();
    this.logFilePath = logFilePath;
    this.maxEntries = maxEntries;
  }

  /** 设置 span 属性（键值对元数据） */
  setAttribute(key: string, value: string | number | boolean): void {
    this.attributes[key] = value;
  }

  /** 标记 span 异常结束 */
  recordException(error: Error): void {
    this.hasError = true;
    this.errorMessage = error.message;
  }

  /** 标记 span 结束，异步写入 trace.log（fire-and-forget） */
  end(): void {
    // 防重复结束：确保只写一次
    if (this.ended) return;
    this.ended = true;

    const endTime = Date.now();
    const entry: TraceEntry = {
      name: this.name,
      startedAt: this.startIso,
      endedAt: new Date(endTime).toISOString(),
      durationMs: endTime - this.startTime,
      attributes: this.attributes,
      hasError: this.hasError,
      ...(this.errorMessage ? { errorMessage: this.errorMessage } : {}),
    };

    // fire-and-forget：异步写入，不阻塞主流程
    appendFile(this.logFilePath, `${JSON.stringify(entry)}\n`)
      .then(async () => {
        // 写入成功后，检查文件大小（间隔式：只在 durationMs 为 0 的倍数时检查，避免频繁读文件）
        // 简化策略：每次写完检查条目数，超过 maxEntries 时截断
        try {
          const content = await readFile(this.logFilePath, 'utf8');
          const lines = content.trim().split('\n');
          if (lines.length > this.maxEntries) {
            const trimmed = lines.slice(-this.maxEntries).join('\n') + '\n';
            await writeFile(this.logFilePath, trimmed, 'utf8');
          }
        } catch {
          // 读取/截断失败，静默忽略（trace 本身是辅助信息）
        }
      })
      .catch(() => {
        // 写入失败时静默降级，不影响对话
      });
  }
}

/**
 * SpriteTracer — 实现 ITracer 接口
 *
 * 每个 startSpan() 返回一个新的 SpriteSpan，
 * span.end() 时写入 JSONL 记录到 dataDir/trace.log。
 */
export class SpriteTracer implements ITracer {
  private readonly logFilePath: string;
  private readonly maxEntries: number;

  /**
   * @param dataDir - 数据目录（与 audit.log、memora.db 同目录）
   * @param maxEntries - 最大保留条数，超出时从头截断，默认 1000
   */
  constructor(dataDir: string, maxEntries = 1000) {
    this.logFilePath = `${dataDir}/trace.log`;
    this.maxEntries = maxEntries;
  }

  /**
   * 开始一个新的 Span
   *
   * @param name - Span 名称（如 TRACE_SPANS.LLM_CALL = 'llm.call'）
   * @param attributes - 初始属性（可选，如 { model: 'gpt-4o' }）
   * @returns ISpan 实例，调用 .end() 结束并记录
   */
  startSpan(name: string, attributes?: Record<string, string | number | boolean>): ISpan {
    return new SpriteSpan(name, attributes ?? {}, this.logFilePath, this.maxEntries);
  }
}
