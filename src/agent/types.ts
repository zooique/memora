/**
 * Agent 流式输出事件类型
 *
 * 核心库向上层 emit 结构化事件，让宿主区分思考/输出/调用工具等阶段——
 * error 事件替代裸 throw，让宿主优雅展示错误并清理 UI（避免未处理 rejection 静默卡死）。
 */

/** thinking 事件的阶段标识 */
export type ThinkingPhase =
  | 'recalling'
  | 'processing'
  | 'archiving'
  | 'llm_calling'
  // 外部任务外循环阶段标记：规划 / 第 N 步 / 汇报
  | 'planning'
  | 'step'
  | 'reporting';

/**
 * 召回记忆摘要（仅暴露 UI 展示所需字段，不含 content，避免泄露完整记忆内容）
 */
export interface RecalledMemorySummary {
  /** 记忆唯一标识（source:name，前端跳转详情） */
  id: string;
  /** 可读名称（点击跳转详情） */
  name: string;
  /** 相似度分数（0-1） */
  score: number;
  /** 来源标签（开放字符串，如 'rule'、'round-summary'） */
  source: string;
}

/** 回答后衔接决策：'wait' 等用户输入 / 'loop' 自动续跑 / 'end' 终止会话 */
export type HandoffDecision = 'wait' | 'loop' | 'end';

export type AgentChunk =
  | { type: 'recall'; memories: RecalledMemorySummary[] }
  | {
      type: 'thinking';
      phase: ThinkingPhase;
      /** 步级进度（仅 phase='step' 携带）：当前步序号 / 步数上限，供宿主精确展示进度 */
      index?: number;
      limit?: number;
    }
  | {
      type: 'text';
      content: string;
    }
  | { type: 'tool_start'; toolCallId: string; name: string; args?: string }
  | { type: 'tool_result'; toolCallId: string; name: string; ok: boolean; summary?: string }
  | { type: 'aborted'; reason: string }
  | { type: 'error'; message: string }
  | { type: 'retry'; attempt: number; maxRetries: number; delayMs: number; error: string }
  | { type: 'paused' }
  /**
   * 主动提问：LLM 结构化输出 `[ASK] 问题` 时 yield，Agent 暂停等用户在提问框回答；
   * 用户回答走 resumeExecution 续跑（非 Trigger）。与 needClarify（P4 补全）同构但触发源不同。
   */
  | { type: 'question_pending'; questions: { slot: string; question: string }[] }
  /**
   * 回答后阶段基于 endingHandoff 配置给出衔接决策，宿主据此决定是否自动触发下一轮
   */
  | { type: 'handoff'; decision: HandoffDecision; reason?: string }
  /**
   * 自审查轮开始信号：注入自审查提示前 emit；round 为第几轮（为多轮预留）
   */
  | { type: 'selfReview'; round: number }
  | { type: 'done' };

// ─── 宿主可覆盖的 UI 文本 ────────────────────────────────

/**
 * 宿主可覆盖的 UI 消息文本。核心库内置英文默认值，宿主通过 AgentOptions.messages
 * 覆盖为任意语言（领域无关原则：核心库不耦合特定语言）。
 */
export interface UIMessages {
  /** 对话取消提示（默认 "User cancelled the conversation"） */
  abortedByUser?: string;
  /** 达到最大迭代次数提示（默认 "\n\n[Max iterations reached]"） */
  maxIterationsReached?: string;
  /** 流式中断标记（默认 "\n\n[已中断]"）：中断时已生成文本仍写历史，此标记追加到末尾供下轮识别 */
  interrupted?: string;
  /** 上下文窗口截断提示生成函数 */
  contextTruncated?: (skipped: number, kept: number) => string;
  /** 软上限收尾信号（默认内置中文提示）：摘要层达容量上限时注入，让 LLM 收敛产出最终交付 */
  softLimitWrapup?: string;
  /** 最近对话标签（默认 "[Recent conversation]"） */
  recentConversationLabel?: string;
  /** 用户角色标签（默认 "User"） */
  userLabel?: string;
  /** 助手角色标签（默认 "Assistant"） */
  assistantLabel?: string;
  /** Reflection 提示生成函数：工具调用失败且可重试时追加，帮 LLM 聚焦修正 */
  reflectionHint?: (remaining: number) => string;
  /** 自审查提示生成函数：注入后让 LLM 审查自身回复质量（最多执行 maxSelfReviewRounds 轮） */
  selfReviewPrompt?: (round: number, total: number) => string;
  /** 重复工具调用负反馈提示：连续多次相同工具+参数时注入，防止死循环 */
  duplicateToolCallWarning?: (threshold: number) => string;
}

// ─── 归档模式 ───────────────────────────────────────────

/**
 * 归档模式二态：'full'（默认，content 在会话切换前自动归档）/'manual'（全部手动触发，
 * postProcess 跳过所有自动归档分支）。
 */
export type ArchiveMode = 'full' | 'manual';

// ─── 不中断工作模型：增量事件 + 检查点 ───────────────────
// 核心思路：从「一问一答」升级为「开启后常驻、仅暂停不终止」，输入升级为增量事件（SessionEvent），
// 会话升级为状态机 + 检查点（SessionCheckpoint）。三态：RUNNING → PAUSED（双向）→ ERROR（独立可见）；
// ERROR → RUNNING 前须 error.recovered===true 且 cause 已解除。
// ────────────────────────────────────────────────────────

/** 会话状态（三态状态机） */
export type SessionStatus = 'running' | 'paused' | 'error';

/**
 * 不中断工作模型的核心输入：角色 × 任务 × 标准 × 资源，三源融合逐级补全，缺省有明确补全链。
 */
export interface FourTuple {
  /** 角色定义（会话级，可中途变更） */
  role: Role;
  /** 任务描述（mainGoal 或 currentGoal） */
  task: string;
  /** 执行标准（质量标准 + 约束条件） */
  standard: Standard;
  /** 资源快照（当前引用的文档/记忆/上下文） */
  resource: ResourceState;
}

/**
 * 槽位增量引用标记：用「引用当前值」而非「提供新值」（如「继续」时 task 槽引用 currentGoal）。
 */
export interface SlotRef {
  /** 引用标识 */
  ref: string;
}

/** 会话级角色，定义行为边界和语气风格，可中途变更 */
export interface Role {
  /** 角色名（如 "developer"） */
  name: string;
  /** 角色描述（用于 system prompt 注入） */
  description?: string;
}

/** 定义任务完成的质量标准与约束条件，用户可随时更新 */
export interface Standard {
  /** 质量标准描述（如 "代码必须通过所有测试"） */
  quality: string;
  /** 约束条件列表（如 ["不使用第三方库"]） */
  constraints: string[];
}

/** 会话资源维度快照，断点续跑时还原 Agent 引用的上下文 */
export interface ResourceState {
  /** 引用的文档路径列表 */
  documents: string[];
  /** 引用的记忆 ID 列表 */
  memories: string[];
  /** 当前上下文摘要（断点续跑还原用） */
  context: string;
}

/** 计划中单个步骤，用于目标漂移检测（文本相似度）和进度追踪 */
export interface PlanStep {
  /** 步骤唯一标识 */
  id: string;
  /** 步骤描述 */
  description: string;
  /** 步骤状态 */
  status: 'pending' | 'active' | 'done' | 'blocked';
  /** 执行顺序（从 0 开始） */
  order: number;
}

/** 一次完整 LLM 调用回合的执行结果，注入时标「非当前指令」防 LLM 误执行 */
export interface RoundOutcome {
  /** 对应计划步骤 ID（可为空 = 自由对话回合） */
  stepId?: string;
  /** 回合摘要（LLM 单句或截断） */
  summary: string;
  /** 完成时间戳 */
  completedAt: number;
}

/** 暂停上下文，用于渲染层展示和恢复决策 */
export interface PauseMeta {
  /** 暂停原因 */
  reason: string;
  /** 暂停来源 */
  source: 'user' | 'agent' | 'system';
}

/**
 * 工具幂等性级别：'idempotent'（读操作天然幂等）/'idempotent-key'（依赖业务唯一键，
 * 写操作）/non-idempotent（非幂等，需补偿机制兜底）。
 */
export type IdempotencyLevel = 'idempotent' | 'idempotent-key' | 'non-idempotent';

/** 记录已执行的工具调用，以工具名+参数签名唯一标识；恢复时检查 outbox 模式避免重复执行 */
export interface ToolExecutionRecord {
  /** 工具名称 */
  name: string;
  /** 参数签名（JSON 字符串化，用于精确匹配） */
  argsSignature: string;
  /** 执行时间戳 */
  executedAt: number;
  /** 执行结果摘要（前 100 字符） */
  resultSummary: string;
  /** 工具执行是否成功 */
  ok: boolean;
  /** 幂等级别（决定恢复时是否跳过重复执行） */
  idempotent?: IdempotencyLevel;
}

/**
 * 热记忆中的聊天消息，结构对齐 LLM Message（不含时间戳，与 SessionMessage 区分），
 * 仅保留 role + content 用于 LLM 上下文注入。role 从 memory/types.ts 导入（SSOT）。
 */
export interface ChatMessage {
  /** 消息角色 */
  role: MessageRole;
  /** 消息内容 */
  content: string;
  /** 来源名称（与 LLM Message.name 对齐） */
  name?: string;
  /** 工具调用（assistant 消息） */
  toolCalls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  /** 工具调用 ID（tool 消息） */
  toolCallId?: string;
}

/**
 * 增量事件（替代纯文本输入，为不中断工作模型提供结构化意图分类）。
 * 意图分类防污染：不同意图走不同路径，避免 chat 被误解析为 command。
 */
export interface SessionEvent {
  /** 意图分类 */
  type: 'command' | 'correction' | 'clarify' | 'chat';
  /** 原始文本内容 */
  content: string;
  /**
   * 槽位级增量合并：SlotRef 引用当前值（不覆盖）/ 新值覆盖 / 数组追加 / undefined 走补全链
   */
  delta?: DeltaPayload;
}

/** 每槽位：具体值=覆盖，SlotRef=引用当前值，undefined=走补全链 */
export interface DeltaPayload {
  /** 角色增量（支持引用当前角色） */
  role?: Role | SlotRef;
  /** 任务增量（支持引用当前目标） */
  task?: string | SlotRef;
  /** 标准增量（支持引用当前标准） */
  standard?: Standard | SlotRef;
  /** 资源增量（支持引用当前资源，或提供新资源追加） */
  resource?: ResourceState | SlotRef;
}

/**
 * 会话检查点，不中断工作模型的核心状态载体，支持序列化后断点续跑。
 * 三态：running / paused（主动暂停）/ error（异常，独立可见不自动转 PAUSED，保留 cause 供检查，
 * 恢复前须校验 error.recovered===true 且 cause 已解除）。
 */
export interface SessionCheckpoint {
  /**
   * 检查点结构版本（K1 持久化加固，2026-08-23）
   *
   * 供跨版本/跨进程恢复时的版本路由：缺失视为最新版本（向后兼容旧检查点——由
   * 未写版本的旧版本 createCheckpoint 生成）；等于当前版本正常恢复；高于当前版本
   * （来自未来内核）拒绝恢复防结构不匹配。当前 v1 为初始版本，迁移映射为空是健康
   * 状态——未来结构演进升 v2 时才需补迁移函数。勿用 goalChangeSeq 承担版本校验。
   */
  schemaVersion: number;
  /** 会话唯一标识 */
  sessionId: string;
  /** 三态状态（ERROR 独立可见） */
  status: SessionStatus;
  /** 异常原因（仅 status==='error' 时有值，恢复前校验 recovered） */
  error?: {
    /** 异常原因描述 */
    cause: string;
    /** 异常发生时间戳（毫秒） */
    at: number;
    /** 是否已恢复（ERROR→RUNNING 前须为 true） */
    recovered: boolean;
  };
  /** 原始目标（防漂移锚点，不随迭代改变） */
  mainGoal: string;
  /** 当前迭代目标（可随 plan 推进更新） */
  currentGoal: string;
  /**
   * 目标变更事件序号（每次 currentGoal 变更递增，goalUpdated / goalDriftDetected 事件载荷）。
   * 仅作事件序号，不承担版本一致性校验——漂移碰撞由文本相似度完成，勿误用为版本校验。
   */
  goalChangeSeq: number;
  /** 执行计划步骤列表 */
  plan: PlanStep[];
  /** 当前角色（可中途变更） */
  role: Role;
  /** 当前执行标准（可更新） */
  standard: Standard;
  /** 资源快照（断点续跑还原用） */
  resource: ResourceState;
  /** 热记忆窗口（截断后的最近对话，防膨胀） */
  hotMemory: ChatMessage[];
  /**
   * 热记忆截断计数：超 HOT_MEMORY_MAX_ROUNDS 轮 FIFO 截断的早期消息数（0/undefined=未截断），
   * 用于恢复时注入一致性标记。
   */
  truncatedCount?: number;
  /**
   * 工具执行日志（outbox 模式）：FIFO，超上限时优先丢弃「幂等或已补偿」的最早记录，
   * 非幂等未补偿记录永不丢弃。
   */
  completedToolCalls?: ToolExecutionRecord[];
  /** 回合结果日志（FIFO cap 10-12 条） */
  roundLog?: RoundOutcome[];
  /** 暂停元数据 */
  pauseMeta?: PauseMeta;
  /** 心跳时间戳（毫秒），防僵尸会话 */
  lastHeartbeat: number;
  /**
   * 暂停起点时间戳（毫秒），与 lastHeartbeat 解耦：lastHeartbeat 承载「检查点写入时间」
   * （任何变更都刷新）；本字段仅由 pause() 在进入 paused 时写，暂停后不被触碰。
   * 暂停超时判定以此为准，否则 touchCheckpoint 会刷新心跳、无限推迟超时判定。
   * 可选：缺失时超时判定回退到 lastHeartbeat。
   */
  pausedAt?: number;
}

/** 状态机显式状态转换方法（pause/resume/triggerError/recover 等）的返回值 */
export interface StatusTransition {
  /** 转换前状态 */
  from: 'running' | 'paused' | 'error';
  /** 转换后状态 */
  to: 'running' | 'paused' | 'error';
  /** 转换原因（如 "用户暂停"） */
  reason: string;
  /** 转换是否被允许 */
  allowed: boolean;
}

// ─── 四级补全：Composer 类型 ─────────────────────────────
// 三源融合（P1 显式 → P2 记忆 → P3 内置 → P4 暂停询问），每槽位独立走补全链。
// ────────────────────────────────────────────────────────

/**
 * 补全来源级别常量（SSOT）。由常量对象推导 CompletionLevel 类型，
 * composer.ts 和 agent.ts 引用此常量而非硬编码字符串。
 */
export const COMPLETION_LEVELS = {
  P1_EXPLICIT: 'P1-explicit',
  P2_MEMORY: 'P2-memory',
  P3_BUILTIN: 'P3-builtin',
  P4_CLARIFY: 'P4-clarify',
} as const;

/** 补全来源级别联合类型（由 COMPLETION_LEVELS 推导），标记每槽位来源，用于可追溯性 */
export type CompletionLevel = (typeof COMPLETION_LEVELS)[keyof typeof COMPLETION_LEVELS];

/** Composer 补全链输出：将 SessionEvent.delta 补全为完整的四元组增量，每槽位标注补全来源 */
export interface ResolvedDelta {
  /** 角色槽 */
  role: { value: Role; source: CompletionLevel };
  /** 任务槽 */
  task: { value: string; source: CompletionLevel };
  /** 标准槽 */
  standard: { value: Standard; source: CompletionLevel };
  /** 资源槽 */
  resource: { value: ResourceState; source: CompletionLevel };
}

/** P4 补全：P1→P3 都无法补全某槽位时生成的澄清问题，暂停等待用户回答 */
export interface ClarifyQuestion {
  /** 目标槽位（role/task/standard/resource） */
  slot: keyof FourTuple;
  /** 问题文本 */
  question: string;
  /** 默认选项（可选，用户可快速选择） */
  options?: string[];
  /**
   * 是否低风险（P4 防滥用）：低风险决策由 Agent 用 P3 内置值自动兜底，不计入连续暂停；
   * 高风险须用户确认并计入计数，连续 2 次后强制降级 P3。
   */
  lowRisk?: boolean;
}

/** Composer 输出：从 composer.ts 迁移至此，与四级补全类型同处一处 */
export interface ComposeResult {
  /** 已解析的四元组增量 */
  resolved: ResolvedDelta;
  /** 需澄清的问题（仅 P4 级别时非空，此时应暂停等待用户回答） */
  needClarify?: ClarifyQuestion[];
}

/** 计划上下文（从 composer.ts 迁移至此） */
export interface PlanContext {
  /** 计划是否停滞（所有步骤完成/阻塞，或空计划） */
  stalled: boolean;
  /** 当前活跃步骤描述（有活跃步骤时） */
  activeStep?: string;
  /** 下一个待处理步骤描述（有 pending 步骤时） */
  pendingStep?: string;
}

// ─── Agent 门面类型 ─────────────────────────────────────

import type { LlmProvider } from '@/llm/provider.js';
import type { IVectorStore } from '@/memory/vectorStore.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import type { ISessionStore } from '@/memory/sessionStore.js';
import type { IRoundStore } from '@/memory/roundStore.js';
import type { ITracer } from '@/agent/tracer.js';
import type { ProjectContext } from '@/memory/projectManager.js';
import type { MessageRole } from '@/memory/types.js';
import type { IWebSearchProvider } from '@/web-search/types.js';
import type { IFetchProvider } from '@/web-fetch/types.js';
import type { ICodeExecutionProvider } from '@/code-exec/types.js';
import type { ProviderRouter } from '@/llm/types.js';

/**
 * 文件层前置条件断言回调：注入时 deleteRule/deleteSkill/updateRule 入口先校验宿主是否已完成
 * 文件操作。expected='absent'/'exists' 分别校验已删/已写。id 格式 `rule:NAME` 或 `skill:NAME`。
 */
export type FileConsistencyCheck = (id: string, expected: 'exists' | 'absent') => boolean;

/**
 * 工具执行前检查的三态结果（所有工具调用统一入口，由 preExecutionCheck 做执行前检查）：
 * - 放行（skip=false）：允许执行，可选 overrideArgs 改写参数（审计/参数改写）
 * - 跳过（skip=true, 无 denied）：不执行，返回 previousResult 让 LLM 继续（幂等去重）
 * - 拒绝（skip=true, denied=true）：阻止工具意图（工具批准否决/白名单/只读拦截）
 */
export interface PreExecutionResult {
  /** 是否跳过执行（true = 跳过或拒绝） */
  skip: boolean;
  /** 跳过时返回的已有结果（幂等去重场景） */
  previousResult?: string;
  /** 放行时可改写后的参数 JSON 字符串 */
  overrideArgs?: string;
  /** 拒绝标记（比 skip 更硬：阻止工具意图并阻止其重试） */
  denied?: boolean;
  /** 拒绝原因（回传给 LLM 让其调整策略而非重试） */
  reason?: string;
}

// ─── 重复工具调用拦截器 ──────────────────────────────────

/** 重复工具调用检测的判定结果：'ok' 正常 / 'warn' 注入负反馈提醒改策略 / 'block' 直接返回兜底文本 */
export type DuplicateCheckVerdict = 'ok' | 'warn' | 'block';

/**
 * 重复工具调用拦截器接口（宿主扩展点）。策略参数化：将「如何判定重复、触发什么」从
 * AgentLoop 剥离，宿主可注入自定义拦截器（如按场景调阈值、按工具名白名单、语义重复检测）。
 * 默认实现 DefaultDuplicateCallInterceptor 基于工具名+参数哈希机械检测。
 */
export interface DuplicateCallInterceptor {
  /** 检查本轮工具调用是否构成重复死循环 */
  check(
    toolCalls: readonly { id: string; function: { name: string; arguments: string } }[],
    context: DuplicateCheckContext,
  ): DuplicateCheckVerdict;

  /** 拦截器唯一标识（用于日志/调试，可选但建议实现） */
  readonly name?: string;
}

/** 提供给拦截器的只读运行时信息，供宿主策略做精确判定 */
export interface DuplicateCheckContext {
  /** 当前轮次索引（从 1 开始） */
  readonly iteration: number;
  /** 本轮已连续相同调用的次数 */
  readonly duplicateCount: number;
  /** 上一轮工具调用哈希 */
  readonly lastHash: string;
  /** 当前工具调用哈希 */
  readonly currentHash: string;
  /** 当前阈值（默认 3） */
  readonly threshold: number;
}

/** Agent 构造选项 */
export interface AgentOptions {
  /** 项目路径（必须） */
  projectPath: string;
  /** 前台 LLM Provider（必须，宿主负责创建） */
  provider: LlmProvider;
  /** 后台 LLM Provider（可选，用于投影等后台操作，不配时复用前台） */
  backgroundProvider?: LlmProvider;
  /** Provider 路由：按任务类型返回对应 Provider；不配时全部使用同一 Provider（向后兼容） */
  providerRouter?: ProviderRouter;
  /** 配置目录（personas/rules/skills） */
  configDir?: string;
  /** 启动时激活的角色包名：优先激活该包，未配置或不存在时回退默认激活首个 */
  activeRolePack?: string;
  /** 记忆数据目录（由宿主显式注入） */
  dataDir?: string;
  /** 项目注册表目录（默认与 dataDir 相同；设为用户级路径可避免每项目重复存储） */
  registryDir?: string;
  /** 最大上下文 token 数（默认 120000） */
  maxContextTokens?: number;
  /** 安全权限 */
  permission?: 'owner' | 'guest';
  /** 允许的路径白名单 */
  allowedPaths?: string[];
  /** 写入确认 */
  confirmWrites?: boolean;
  /** 向量存储（可选，提供时启用语义召回；宿主可注入任意实现） */
  vectorStore?: IVectorStore;
  /** 召回排除的 source 标签（默认 ['persona','rule','skill']，已由 bootstrap 注入） */
  recallExcludeSources?: string[];
  /** 外部注入的存储实例（不传则内部创建 InMemoryStorage） */
  storage?: IMemoryStorage;
  /** 外部注入的会话存储（不传则仅内存保存） */
  sessionStore?: ISessionStore;
  /** 外部注入的问答闭环存储（不传则仅 legacy 模式，传则启用 round-based 模式） */
  roundStore?: IRoundStore;
  /** 可观测性 Tracer（不传则 NoopTracer 静默丢弃） */
  tracer?: ITracer;
  /** 宿主可覆盖的 UI 消息文本（默认英文） */
  messages?: UIMessages;
  /** 上下文超限时是否自动生成摘要（默认 true；开启后首次截断增 ~1-2s 延迟） */
  enableContextSummary?: boolean;
  /** 归档模式（默认 'full'） */
  archiveMode?: ArchiveMode;
  /** 网络搜索提供者（可选，不配则不启用网络搜索） */
  webSearchProvider?: IWebSearchProvider;
  /** 网页抓取提供者（可选，不配则不启用 web_fetch；与 webSearchProvider 构成搜索→抓取闭环） */
  fetchProvider?: IFetchProvider;
  /** 代码执行提供者（可选，不配则不启用 run_code；执行器与隔离等级由宿主实现） */
  codeExecutionProvider?: ICodeExecutionProvider;
  /** 文件层前置条件断言回调（可选，未注入则完全降级为现状） */
  fileConsistencyCheck?: FileConsistencyCheck;
  /**
   * 工具执行前检查回调（宿主审批/审计/参数改写通道）：装配时与内部幂等检查组合为单点入口。
   *
   * ⚠️ 单用户桌面场景可省略（内核自动降级为仅内部幂等检查），
   * 多用户/服务端部署 **必须注入** 真实审批策略（基于权限、路径白名单、只读模式等做 denied/skip 判定）。
   * 省略不是「忘记实现」——是「单用户信任模型下不需要」的显式决策。
   */
  preExecutionCheck?: (name: string, args: string) => PreExecutionResult;
}

/** Agent 初始化后暴露的运行时上下文 */
export type AgentContext = ProjectContext;

/** Agent 项目条目（来自 ProjectManager 注册表） */
export interface AgentProjectEntry {
  name: string;
  path: string;
  lastOpened: string;
}

/**
 * Agent 内部配置（构造参数解析默认值后的形态）。派生自 AgentOptions：
 * Omit 掉「不进入内部配置」的字段；覆盖「构造时 `?? 默认值` 解析后必填」的字段；
 * 其余继承既有的必填/可选性。新增 AgentOptions 字段若有默认值解析，需加入 Omit 列表并覆盖类型。
 */
export type AgentConfig = Omit<
  AgentOptions,
  | 'provider'
  | 'backgroundProvider'
  | 'providerRouter'
  | 'dataDir'
  | 'maxContextTokens'
  | 'permission'
  | 'allowedPaths'
  | 'confirmWrites'
  | 'recallExcludeSources'
  | 'enableContextSummary'
  | 'archiveMode'
> & {
  dataDir: string;
  maxContextTokens: number;
  permission: 'owner' | 'guest';
  allowedPaths: string[];
  confirmWrites: boolean;
  recallExcludeSources: string[];
  enableContextSummary: boolean;
  archiveMode: ArchiveMode;
};