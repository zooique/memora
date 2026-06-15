/**
 * Agent 可观测性接口 — 零依赖的轻量 Span/Trace 抽象
 *
 * 定义 ITracer 和 ISpan 接口，让宿主项目注入 OpenTelemetry 等实现。
 * 默认 NoopTracer 静默丢弃所有 span，不引入任何运行时开销。
 *
 * 设计约束（详见 docs/agent-harness-增强方案-v1.0.md §3.2）：
 *   - 禁止直接 import OpenTelemetry SDK（违反零依赖原则）
 *   - Span 收集为 fire-and-forget，不阻塞 AgentLoop 主流程
 *   - Tracer 未注入时自动降级，不抛异常
 *
 * 使用方式：
 *   // 宿主侧（泊文等）
 *   const otelTracer = new OpenTelemetryTracer(tracerProvider); // 宿主实现 ITracer
 *   const agent = new Agent({ ..., tracer: otelTracer });
 *
 *   // memora 内部
 *   const span = this.opts.tracer.startSpan('llm.call', { model: 'gpt-4o' });
 *   // ... LLM 调用 ...
 *   span.end();
 */

// ─── 类型定义 ───────────────────────────────────────────

/** Span 属性值类型 */
type SpanAttributeValue = string | number | boolean;

// ─── ISpan 接口 ─────────────────────────────────────

/** Span 接口 — 一次可观测操作的基本单元 */
export interface ISpan {
  /** 设置 Span 属性（键值对元数据） */
  setAttribute(key: string, value: SpanAttributeValue): void;
  /** 标记 Span 结束 */
  end(): void;
  /** 记录异常（不中断 span，标记错误状态） */
  recordException(error: Error): void;
}

// ─── ITracer 接口 ────────────────────────────────────

/** Tracer 接口 — 宿主注入的可观测性实现 */
export interface ITracer {
  /**
   * 开始一个新的 Span
   *
   * @param name - Span 名称（如 'llm.call'、'tool.execute'）
   * @param attributes - 初始属性（可选）
   * @returns ISpan 实例
   */
  startSpan(name: string, attributes?: Record<string, SpanAttributeValue>): ISpan;
}

// ─── Noop 实现（默认，零开销）───────────────────────

/** 空 Span 实现（静默丢弃所有操作） */
class NoopSpan implements ISpan {
  setAttribute(_key: string, _value: SpanAttributeValue): void {
    // noop
  }
  end(): void {
    // noop
  }
  recordException(_error: Error): void {
    // noop
  }
}

/** 空 Tracer 实现（始终返回 NoopSpan） */
class NoopTracer implements ITracer {
  startSpan(_name: string, _attributes?: Record<string, SpanAttributeValue>): ISpan {
    // 共享同一个 NoopSpan 实例，避免分配开销
    return NOOP_SPAN;
  }
}

/** 共享的 NoopSpan 单例（避免每次 startSpan 分配新对象） */
const NOOP_SPAN = new NoopSpan();

/** NoopTracer 单例（在未注入 tracer 时使用） */
export const noopTracer: ITracer = new NoopTracer();

// ─── AgentLoop 预定义 Span 名称 ─────────────────────

/**
 * AgentLoop 关键节点的 Span 名称常量
 *
 * 供宿主项目按名称过滤 span 做监控面板。
 */
export const TRACE_SPANS = {
  /** 记忆召回阶段 */
  RECALL: 'recall.recall',
  /** LLM API 调用 */
  LLM_CALL: 'llm.call',
  /** 工具执行 */
  TOOL_EXEC: 'tool.execute',
  /** 最终响应生成 */
  RESPONSE: 'response.generate',
} as const;