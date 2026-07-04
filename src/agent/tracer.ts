/**
 * Agent 可观测性接口 — 零依赖的轻量 Span/Trace 抽象
 *
 * 定义 ITracer 和 ISpan 接口，让宿主项目注入 OpenTelemetry 等实现。
 * 默认 NoopTracer 静默丢弃所有 span，不引入任何运行时开销。
 *
 * 设计约束（详见 ADR-001 · 运行时栈，零依赖原则）：
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
export const NOOP_TRACER: ITracer = new NoopTracer();

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
  /** 记忆衰减执行（补全衰减可观测性缺口） */
  DECAY: 'memory.decay',
  /**
   * 上下文摘要生成（补全 generateContextSummary 可观测性缺口）
   *
   * 触发条件：消息超 maxContextTokens 触发截断时，调用 LLM 生成"遗忘补偿"摘要。
   * 监控此 span 可观察截断频率、摘要生成耗时与失败率。
   */
  CONTEXT_SUMMARY: 'context.summary',
} as const;

// ─── 运行时指标快照类型（可观测性增强）────────

/**
 * Agent 运行时指标快照
 *
 * 由 Agent.getMetrics() 聚合 AgentLoop + Agent 两层指标产出，
 * 供宿主项目构建监控面板或健康度诊断面板。
 *
 * 设计原则：
 *   - 纯只读快照——调用时不修改任何状态
 *   - 同步返回——不触发 LLM 或 IO
 *   - 累计值——指标从 Agent 初始化起累加，close() 后清零
 *
 * 分 5 个维度：LLM 调用、记忆召回、工具调用、上下文管理、记忆衰减。
 */
export interface AgentMetrics {
  /** LLM 调用相关指标 */
  llm: {
    /** LLM 调用总次数（含重试，每次 provider.chat 调用算一次） */
    callCount: number;
    /** 累计输入 token 数（基于 estimateTokens 粗略估算） */
    totalInputTokens: number;
    /** 累计输出 token 数（基于 estimateTokens 粗略估算） */
    totalOutputTokens: number;
  };
  /** 记忆召回相关指标 */
  recall: {
    /** 召回总次数（每轮对话 processUserInput 算一次） */
    totalCount: number;
    /** 命中次数（召回结果非空算命中） */
    hitCount: number;
    /** 命中率（0-1，hitCount / totalCount，totalCount 为 0 时返回 0） */
    hitRate: number;
  };
  /** 工具调用相关指标 */
  tools: {
    /** 工具调用总次数 */
    callCount: number;
    /** 工具调用失败次数（结果以 [ERR 开头） */
    failureCount: number;
  };
  /** 上下文管理指标 */
  context: {
    /** 上下文截断次数（messages 超过 maxContextTokens 触发截断的次数） */
    truncationCount: number;
    /** 当前工作记忆消息数 */
    messageCount: number;
    /** 当前估算 token 数（基于 estimateTokens） */
    estimatedTokens: number;
  };
  /** 记忆衰减指标（由 Agent 层填充，AgentLoop 层此字段为 null） */
  decay: {
    /** 衰减执行次数 */
    runCount: number;
    /** 累计衰减记忆数（score 被调低的记忆条数） */
    totalDecayedCount: number;
    /** 上次衰减时间（ISO 8601，null 表示从未执行过） */
    lastRunAt: string | null;
  } | null;
}