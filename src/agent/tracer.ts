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
 *
 * 记忆检索耗时看 TOOL_EXEC span（search_memories 工具）；内核无召回类 span 发射点，
 * 勿凭旧契约重新加名。
 *
 * DIFFICULTY / REPORT 是**预留名**（规划能力尚未落地），内核同样零 emit 点——
 * 不得把注释写成正在进行的行为，否则宿主按名建监控面板会永远收不到数据。
 */
export const TRACE_SPANS = {
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
  /** 难度分级——**预留名**：规划能力（回答前判定简单/复杂），内核当前**零 emit 点** */
  DIFFICULTY: 'round.difficulty',
  /** 汇报闭环——**预留名**：规划能力（复杂任务收敛后独立汇报），内核当前**零 emit 点** */
  REPORT: 'round.report',
} as const;

// ─── 运行时指标快照类型（可观测性增强）────────

/**
 * Agent 运行时指标快照——Agent.getMetrics() 聚合 AgentLoop+Agent 两层指标产出，供宿主做监控/健康度面板。
 * 只读快照（不修改状态）、同步返回（不触发 LLM/IO）、累计值（init 起累加，close() 后清零）。
 * 分 4 维度：LLM 调用、工具调用、上下文管理、任务级 SLO（无衰减/记忆召回维度：对应指标零写点）。
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
    /**
     * LLM 空响应兜底次数：200 但 0 token 时用户看到兜底文案、
     * 任务零产出却被 success 盖章。宿主据此识别「瞬态抽风」（可期望重试救回）vs「模型拒绝」（重试也空）。
     */
    emptyResponseCount: number;
    /**
     * tool_call 批次成形守卫（`auditToolCallPairing` 发送边界）实际拒发次数。
     * N>0 代表内核真拦下了坏批次（孤立 tool 消息 / 空函数名 / 重复 id / 名称超长）。
     * 与 `unparsedToolIntentCount` 互补：后者是「模型想干却没干成」（模型侧），
     * 本值是「内核拦下了会发出去的坏批次」（内核侧守门）。
     */
    pairingGuardFires: number;
  };
  /** 工具调用指标 */
  tools: {
    /** 工具调用总次数 */
    callCount: number;
    /** 失败次数（结果以 [ERR 开头） */
    failureCount: number;
    /**
     * 未解析工具意图数（文本骨架 <tool_call>/<function=> 但无常原生 toolCalls）。
     * 让「想干活却一步没干成」不被静默盖「完成」；宿主可据 N>0 不显示该轮成功收尾。
     */
    unparsedToolIntentCount: number;
    /**
     * read_file 覆盖度台账回显（分支② `formatLedgerStub` 拦截）命中次数。
     * 用于观测防重补缝是否过度拦截：0 代表防重没在替身层拦截
     * （可能是护住也可能是拦不住），N 增大代表替身频繁顶替「拿回整份视角」的合法重读（规避行为红旗）。
     * 健康判定需连同真机规避信号交叉看，本计数仅提供可观测的量化基线。
     */
    ledgerStubEchoCount: number;
  };
  /** 上下文管理指标 */
  context: {
    /** 上下文截断次数（messages 超 maxContextTokens 触发截断） */
    truncationCount: number;
    /** 当前工作记忆消息数 */
    messageCount: number;
    /** 当前估算 token 数（estimateTokens） */
    estimatedTokens: number;
    /** 最近一次输入装配的上下文预算构成（可选：prepare 计算并透出，供宿主展示预算分配） */
    budget?: ContextBudget;
    /** 上下文占用快照（可选：prepare 期真实用量，供输入区指示器展示） */
    occupancy?: ContextOccupancy;
    /**
     * 当前激活角色包底盘占用（system prompt 总体 token，persona+rules+技能 L1+工具 schema+全局技能+时间戳）。
     * 与 occupancy.rolePackBaseTokens 同源但产生时机更早：装配 / 切换角色包时即确定（不依赖跑过 prepare），
     * 冷启动 / 重启后首屏即可显示真实占比。prepare 期仍会以其实际注入值覆盖刷新（口径一致，同一估算器）。
     */
    rolePackBaseTokens?: number;
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
  /** 任务表触发观测量（实证任务表是否被 LLM 触发，驱动 plan_item_boundary/折叠） */
  plan: {
    /** 累计调用 task_table_write 次数（= 建表/重建次数，0 = 从未触发） */
    taskTableWriteCount: number;
    /** 累计产出 plan_item_boundary 次数（= 思考折叠分块边界数，同 0 即布局骨血空转） */
    planItemBoundaryCount: number;
  };
}
