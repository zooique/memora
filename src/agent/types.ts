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
  // 多 turn 任务编排（档2 externalTaskLoop）阶段标记：规划 / 第 N 步 / 汇报
  | 'planning'
  | 'step'
  | 'reporting';

/** turn 归属标记：chunk 携带所在 turn roundId（SSOT：过程事件归属由内核唯一提供，
 *  宿主据此把 ProcessEvent 落盘到正确的 Round，不再依赖「roundIds 末尾」推断当前轮） */
export type RoundTagged = { roundId?: string };

export type AgentChunk = (
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
      /**
       * 文本阶段标识：'self_review' 为自审查应答（机制层区分，供宿主分段渲染——
       * 自审查输出与最终回答分离展示，不再混入同一消息流）；缺省/'answer' 为正常交付。
       * 仅标识不改变内容语义，历史落库仍按整轮拼接。
       */
      stage?: TextChunkStage;
    }
  | { type: 'tool_start'; toolCallId: string; name: string; args?: string }
  | {
      type: 'tool_result';
      toolCallId: string;
      name: string;
      ok: boolean;
      summary?: string;
      /**
       * 策略拦截标记（2026-09-02）：工具被内核确定性拒绝（如 web_search 达硬上限），
       * 未实际执行。ok=false + blocked=true：区别于「执行失败」，UI 显示「已拦截」，
       * 不计成功数亦不计失败数；LLM 收到的是拒绝文案而非真实结果。
       */
      blocked?: boolean;
    }
  /**
   * 过程叙述（2026-09-02）：LLM 在工具迭代前产出的行动叙述文本
   * （如「让我先查看所有文档」「现在逐一读取它们的内容」）。
   * 与 text（回答正文）语义分离：narrate 只供宿主渲染「过程叙述」折叠行，
   * 不进入最终回答正文（consumeExecutionStream 不将其拼入 content）。
   */
  | { type: 'narrate'; content: string }
  /**
   * 中断（aborted chunk 的语义分类，TS-12）
   *
   * stopReason 由内核在产生点按真实触因唯一判定，宿主按语义映射友好文案（与 error.category 同构）：
   * - 'user'：宿主 signal / 插话控制器真 abort（用户主动停止或插话介入）
   * - 'timeout'：chat 锁超时 / LLM 无响应超时中断（signal.reason 为 TimeoutError，区别于用户取消）
   * - 'interrupted'：预留语义（流式中断；当前无产生点，未来场景分化时启用）
   * - 'connection'：预留语义（连接中断已由 error chunk category:'connection' 捕获，不在此重复）
   * 无 stopReason（旧数据/直接构造）时宿主回退 reason 原文，保持兼容。
   */
  | { type: 'aborted'; reason: string; stopReason?: AbortStopReason }
  /**
   * 流式错误（error chunk 的分类字段，TS-10a）
   *
   * 类别由内核唯一判定（Signal 未 abort 却抛 AbortError = 'connection' 等），
   * 宿主按 category 映射友好展示文案；无 category（null）时宿主回退原始 message，
   * 保留调试可追溯性。不承载裸前缀（如 `[连接中断]`）——语义分类走结构化字段。
   */
  | { type: 'error'; message: string; category?: 'connection' | 'timeout' | 'unknown' }
  | { type: 'retry'; attempt: number; maxRetries: number; delayMs: number; error: string }
  | { type: 'paused' }
  /**
   * 主动提问（ask_user 工具，2026-09-04 通道收敛）：LLM 调 ask_user 时 yield，
   * Agent 暂停等用户在提问框回答；用户回答经 answerQuestion 回填后 continueAfterPause 续跑（非 Trigger）。
   */
  | { type: 'question_pending'; questions: AskQuestion[] }
  /**
   * 自审查轮开始信号：注入自审查提示前 emit；round 为第几轮（为多轮预留）
   */
  | { type: 'selfReview'; round: number }
  /**
   * 步级折叠边界（阶段二，2026-09-08 路 B′）：迭代完成且 active 任务表步骤**推进**时 emit。
   * 宿主据此把后续过程事件（narrate/tool/问答）归到对应 step 分组下渲染；无任务表不产。
   * stepId 为推进到的新 active step ID，title 为步骤标题（供分组 summary 展示）。
   */
  | { type: 'step_boundary'; stepId?: string; title?: string }
  | { type: 'done' }
) & RoundTagged;

/**
 * 中断语义分类（TS-12a）：'user' = 用户主动停止/插话；'interrupted'/'connection' 为预留语义（当前无产生点）。
 */
export type AbortStopReason = 'user' | 'timeout' | 'interrupted' | 'connection';

/**
 * 文本块阶段标识：供宿主区分正常交付与自审查应答，做独立分段展示。
 * - 'answer'：正常回答（缺省值）
 * - 'self_review'：自审查轮应答（满意确认或修订输出）
 */
export type TextChunkStage = 'answer' | 'self_review';

// ─── 宿主可覆盖的 UI 文本 ────────────────────────────────

/**
 * 宿主可覆盖的 UI 消息文本。核心库内置英文默认值，宿主通过 AgentOptions.messages
 * 覆盖为任意语言（领域无关原则：核心库不耦合特定语言）。
 */
export interface UIMessages {
  /** 对话取消提示（默认 "User cancelled the conversation"） */
  abortedByUser?: string;
  /** 锁超时/LLM 无响应中断提示（默认 "LLM request timed out (no response)"） */
  abortedByTimeout?: string;
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

// ─── 不中断工作模型：会话状态机 + 检查点 ─────────────────
// 核心思路：从「一问一答」升级为「开启后常驻、仅暂停不终止」，会话升级为状态机 + 检查点（SessionCheckpoint）
// 支持断点续跑。三态：RUNNING → PAUSED（双向）→ ERROR（独立可见）；
// ERROR → RUNNING 前须 error.recovered===true 且 cause 已解除。
// 注：原「增量事件（SessionEvent）驱动补全」整条剪枝（见 docs/architecture/），输入统一走 chat。
// ────────────────────────────────────────────────────────

/** 会话状态（三态状态机） */
export type SessionStatus = 'running' | 'paused' | 'error';

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
  /**
   * 会议用：该任务项的表层装配角色（组长或组员）。仅会议内临时生效，不改 activePack——
   * prepare 期经 RolePackManager.resolveRoundAssemblyRole 范围校验（∈ {组长} ∪ {组员}，越界忽略 + warning）。
   * 进 checkpoint（schemaVersion 升版 + 迁移映射）；缺失/旧检查点走缺省 undefined（非会议）。
   */
  rolePack?: string;
}

/** 一次 LLM 迭代（step）的执行结果，注入时标「非当前指令」防 LLM 误执行 */
export interface StepOutcome {
  /** 关联任务表步骤 ID（可为空 = 自由对话的迭代推进） */
  planStepId?: string;
  /** step 摘要（LLM 单句或截断） */
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
 * 工具幂等性级别：
 * - 'idempotent'：写后状态确定、可安全重跑（如 task_table_update），跳过回喂缓存摘要
 * - 'idempotent-key'：依赖业务唯一键实现幂等（写操作，如 write_file / register_work）
 * - 'non-idempotent'：非幂等，需补偿机制兜底；另承担「禁止跳过」语义
 * - 'read-only'：读/查询类，目标态可被外部改动（写工具/时间），永不跳过——跳过回喂
 *   陈旧结果会误导 LLM；重跑无害且无需去重持久化
 */
export type IdempotencyLevel = 'idempotent' | 'idempotent-key' | 'non-idempotent' | 'read-only';

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
   * 目标变更事件序号（每次 currentGoal 变更递增，goalDriftDetected 事件载荷）。
   * 仅作事件序号，不承担版本一致性校验——漂移碰撞由文本相似度完成，勿误用为版本校验。
   */
  goalChangeSeq: number;
  /** 执行计划步骤列表 */
  plan: PlanStep[];
  /** 当前角色（可中途变更） */
  role: Role;
  /** 当前执行标准（可更新） */
  standard: Standard;
  /**
   * 工具执行日志（outbox 模式）：FIFO，超上限时优先丢弃「幂等或已补偿」的最早记录，
   * 非幂等未补偿记录永不丢弃。
   */
  completedToolCalls?: ToolExecutionRecord[];
  /** step 推进日志（LLM 迭代级时间轴，FIFO cap 10-12 条；task 步骤状态见 plan） */
  stepLog?: StepOutcome[];
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

/**
 * 结构化主动提问（ask_user 内置工具解析产物）
 *
 * 唯一「提问后暂停」形态：LLM 调 ask_user 工具（question + 可选 options/allowCustom），
 * loop 检出后挂起，用户答案以 tool result 回填（对齐 Claude Code AskUserQuestion 机制）。
 */
export interface AskQuestion {
  /** 溯源槽位（当前恒为 'ask'，为未来扩展保留） */
  slot: string;
  /** 问题文本 */
  question: string;
  /** 候选选项（ask_user 工具 options 参数，宿主渲染可点击选项） */
  options?: string[];
  /** 是否允许用户在选项外自由输入（ask_user 工具 allowCustom 参数，默认 false） */
  allowCustom?: boolean;
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
import type { IProjectSearchProvider } from '@/project-search/types.js';
import type { ProviderRouter } from '@/llm/types.js';
// 宿主装配级策略覆盖类型（AgentOptions.strategyOverride）：引用角色包行为策略类型
import type { BehaviorStrategy } from '@/role-pack/types.js';
import type { RolePackTeam } from '@/role-pack/types.js';

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
  /**
   * 启动时激活的角色包名（宿主装配级，既有键，语义扩展）：宿主持久化的用户选择。
   * §4.1 解析链第一层——有效则生效；失效（包不存在）落兜底包（builtinFallbackRole ?? BUILTIN_FALLBACK_PACK），
   * 不再回退 items[0]。
   */
  activeRolePack?: string;
  /**
   * 组（宿主装配级）：组长角色包 + 组员名单。会议名单容器，非选择对象。
   * 组长身份唯一（一个角色包只能是一个组的组长）；组员可被多组引用；成员名单非空；
   * 组员仅作小组会议参与者（会议内表层装配），不用于日常。
   */
  rolePackTeams?: RolePackTeam[];
  /** 程序级内置兜底角色（可选）：覆盖内核常量 BUILTIN_FALLBACK_PACK；覆盖值须指向存在的包，否则回退内核常量 */
  builtinFallbackRole?: string;
  /**
   * 宿主装配级**策略覆盖**（可选）：经 resolveActiveStrategy 压过角色包声明，表达宿主产品能力边界。
   * 只影响 override 声明过的键；是「宿主策略层」通用覆盖，不新增任何独立开关。
   *（v0.13 后无内置示例键；角色包自动匹配全链已移除，本机制保留供宿主能力边界使用）
   */
  strategyOverride?: Partial<BehaviorStrategy>;
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
  /** 脚本/代码执行确认（独立于写入确认；true 时 run_code/run_project_script 执行前弹窗，默认 false 不弹窗） */
  confirmScripts?: boolean;
  /** 向量存储（可选，提供时启用语义召回；宿主可注入任意实现） */
  vectorStore?: IVectorStore;
  /** 召回排除的 source 标签（默认 []：设定记忆已归角色包、不进记忆库，无需召回排除；SSOT 见 recallDefaults.DEFAULT_RECALL_EXCLUDE_SOURCES） */
  recallExcludeSources?: string[];
  /** 外部注入的存储实例（不传则内部创建 InMemoryStorage） */
  storage?: IMemoryStorage;
  /** 外部注入的会话存储（round-based 唯一模式；未注入则消息仅内存保存） */
  sessionStore?: ISessionStore;
  /** 外部注入的问答闭环存储（round-based 唯一模式；与 sessionStore 成对注入，未注入则消息仅内存保存） */
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
  /** 项目搜索提供者（可选，不配则不启用 search_project；等价 IDE 全局搜索，由宿主实现） */
  projectSearchProvider?: IProjectSearchProvider;
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
  | 'confirmScripts'
  | 'recallExcludeSources'
  | 'enableContextSummary'
  | 'archiveMode'
> & {
  dataDir: string;
  maxContextTokens: number;
  permission: 'owner' | 'guest';
  allowedPaths: string[];
  confirmWrites: boolean;
  /** 脚本/代码执行确认开关（AgentOptions.confirmScripts 的默认值解析结果） */
  confirmScripts: boolean;
  recallExcludeSources: string[];
  enableContextSummary: boolean;
  archiveMode: ArchiveMode;
  /**
   * 组（会议名单容器）：内部运行态必选——外部 AgentOptions 可选（不配 = 无团队），
   * Agent 构造时 `?? []` 归一化后恒为数组。P-6（2026-09-06）：
   * 收紧内部契约保证 AssembleInput 必传，防「可选性假约束」再吞团队数据（team 启动缺口教训）。
   */
  rolePackTeams: RolePackTeam[];
};