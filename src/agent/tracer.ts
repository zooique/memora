/**
 * Agent 可观测性接口 — 零依赖轻量 Span/Trace 抽象。
 * 宿主注入 ITracer 实现（如 OpenTelemetry）；默认 NoopTracer 静默丢弃所有 span，零运行时开销。
 * 约束：只留 span 名契约（宿主按名过滤建监控面板）；Span 收集 fire-and-forget 不阻塞主流程；未注入时自动降级不抛异常。
 */

import type { ContextBudget, ContextOccupancy } from '@/agent/budget.js';

// ─── 类型定义 ───────────────────────────────────────────

/** Span 属性值类型 */
type SpanAttributeValue = string | number | boolean;

// ─── ISpan 接口 ─────────────────────────────────────

/** 一次可观测操作的基本单元 */
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
  /** 开始新 Span（name 如 'llm.call'、'tool.execute'；attributes 可选） */
  startSpan(name: string, attributes?: Record<string, SpanAttributeValue>): ISpan;
}

// ─── Noop 实现（默认，零开销）───────────────────────

/** 空 Span 实现（静默丢弃所有操作，无实际作用） */
class NoopSpan implements ISpan {
  setAttribute(_key: string, _value: SpanAttributeValue): void {
    /* noop */
  }
  end(): void {
    /* noop */
  }
  recordException(_error: Error): void {
    /* noop */
  }
}

/** 空 Tracer 实现（始终返回共享的 NoopSpan） */
class NoopTracer implements ITracer {
  startSpan(_name: string, _attributes?: Record<string, SpanAttributeValue>): ISpan {
    // 共享同一 NoopSpan 实例，避免分配开销
    return NOOP_SPAN;
  }
}

/** 共享 NoopSpan 单例（避免每次 startSpan 分配新对象） */
const NOOP_SPAN = new NoopSpan();

/** NoopTracer 单例（未注入 tracer 时使用） */
export const NOOP_TRACER: ITracer = new NoopTracer();

// ─── AgentLoop 预定义 Span 名称 ─────────────────────

/**
 * AgentLoop 关键节点 Span 名称常量——供宿主按名过滤建监控面板。
 * 各 span 名称/用途契约（span 名是宿主监控依赖，勿改）：
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
  /** 上下文摘要生成——消息超 maxContextTokens 触发截断时调 LLM 生成"遗忘补偿"摘要；观察截断频率/耗时/失败率 */
  CONTEXT_SUMMARY: 'context.summary',
  /** 对话后归档处理——每轮 chat() 后 postProcess（round-summary 生成、角色/技能匹配）；观察归档耗时/失败率 */
  POST_PROCESS: 'archive.postProcess',
  /** 实际记忆召回函数——RECALL span 仅包裹注入动作立即 end，不覆盖召回耗时；此 span 在 recall() 内部埋点，观察真实耗时与双通道命中分布 */
  RECALL_ACTUAL: 'recall.actual',
  /** 难度分级——回答前判定简单/复杂（种子聚类） */
  DIFFICULTY: 'round.difficulty',
  /** 汇报闭环——复杂任务收敛后独立汇报产出 */
  REPORT: 'round.report',
} as const;

// ─── 运行时指标快照类型（可观测性增强）────────

/**
 * Agent 运行时指标快照——Agent.getMetrics() 聚合 AgentLoop+Agent 两层指标产出，供宿主做监控/健康度面板。
 * 只读快照（不修改状态）、同步返回（不触发 LLM/IO）、累计值（init 起累加，close() 后清零）。
 * 分 5 维度：LLM 调用、记忆召回、工具调用、上下文管理、任务级 SLO（显式衰减维度已随衰减子系统移除，2026-08-27）。
 */
export interface AgentMetrics {
  /** LLM 调用指标 */
  llm: {
    /** 调用总次数（含重试，每次 provider.chat 算一次） */
    callCount: number;
    /** 累计输入 token（estimateTokens 估算） */
    totalInputTokens: number;
    /** 累计输出 token（estimateTokens 估算） */
    totalOutputTokens: number;
    /** 实际 API 返回的输入 token 累计值（仅在 Provider 支持 usage 时填充，否则为 0） */
    actualInputTokens: number;
    /** 实际 API 返回的输出 token 累计值（仅在 Provider 支持 usage 时填充，否则为 0） */
    actualOutputTokens: number;
  };
  /** 记忆召回指标 */
  recall: {
    /** 召回总次数（每轮 processUserInput 算一次） */
    totalCount: number;
    /** 命中次数（召回结果非空） */
    hitCount: number;
    /** 命中率（0-1，totalCount 为 0 时为 0） */
    hitRate: number;
  };
  /** 工具调用指标 */
  tools: {
    /** 工具调用总次数 */
    callCount: number;
    /** 失败次数（结果以 [ERR 开头） */
    failureCount: number;
  };
  /** 上下文管理指标 */
  context: {
    /** 上下文截断次数（messages 超 maxContextTokens 触发截断） */
    truncationCount: number;
    /** 当前工作记忆消息数 */
    messageCount: number;
    /** 当前估算 token 数（estimateTokens） */
    estimatedTokens: number;
    /** 最近一次输入装配的上下文预算构成（可选：prepare 计算并透出，供宿主展示预算分配，④） */
    budget?: ContextBudget;
    /** 上下文占用快照（可选：prepare 期真实用量，供输入区指示器展示，④ 预算可视化） */
    occupancy?: ContextOccupancy;
  };
  /** 任务级 SLO 度量（AgentLoop 层填充） */
  tasks: {
    /** 任务总执行次数（每次 processUserInput 算一次） */
    totalCount: number;
    /** 任务成功次数（正常完成，未被 abort/暂停） */
    successCount: number;
    /** 任务失败次数（被中止、超时、或迭代耗尽） */
    failureCount: number;
    /** 任务成功率（0-1，totalCount 为 0 时为 0） */
    successRate: number;
    /** 平均任务耗时（毫秒，0 表示尚无数据） */
    avgDurationMs: number;
  };
}