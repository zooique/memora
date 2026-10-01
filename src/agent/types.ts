/**
 * Agent 流式输出事件类型
 *
 * 核心库向上层 emit 结构化事件，让宿主区分思考/输出/调用工具等阶段——
 * error 事件替代裸 throw，让宿主优雅展示错误并清理 UI（避免未处理 rejection 静默卡死）。
 */

/** 工具调用元素契约（OpenAI 协议结构）——单一真源，供 ChatMessage.toolCalls 引用 */
import type { ToolCall } from '@/llm/types.js';

/** thinking 事件的阶段标识 */
export type ThinkingPhase = 'assembling' | 'processing' | 'archiving' | 'llm_calling';

/** turn 归属标记：chunk 携带所在 turn roundId（SSOT：过程事件归属由内核唯一提供，
 *  宿主据此把 ProcessEvent 落盘到正确的 Round，不再依赖「roundIds 末尾」推断当前轮） */
export type RoundTagged = { roundId?: string };

export type AgentChunk = (
  | {
      type: 'thinking';
      phase: ThinkingPhase;
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
  /**
   * 工具调用开始（Runtime 确定执行、参数已完成）。stepIndex = 所属 step 的轮内序号（与 thought
   * 同构，loop 单点打标）；tool_result **不重复盖章**——经 toolCallId 归属本条（事实单点，防双写）。
   */
  | { type: 'tool_start'; toolCallId: string; name: string; args?: string; stepIndex?: number }
  | {
      type: 'tool_result';
      toolCallId: string;
      name: string;
      ok: boolean;
      summary?: string;
      /**
       * 策略拦截标记：工具被内核确定性拒绝（如 web_search 达硬上限），
       * 未实际执行。ok=false + blocked=true：区别于「执行失败」，UI 显示「已拦截」，
       * 不计成功数亦不计失败数；LLM 收到的是拒绝文案而非真实结果。
       */
      blocked?: boolean;
    }
  /**
   * 模型思考内容流：LLM 的 reasoning_content 增量片段。
   * 仅供宿主折叠展示，**不进正文/记忆**（CoT 防护）；落盘走 ProcessEvent（roundStore.ts
   * `type: 'thought'` 成员），重启重放可见。瞬态流：中断不补发。命名用 thought，与多模型
   * 路由任务类型 `TaskType='reasoning'`、ProcessEvent 既有相位 `type:'thinking'` 语义分离。
   * stepIndex = 本条思考所属 step（一次 LLM 调用 + 可选工具执行）的轮内序号，由 loop 打标
   * （withStepIndex 单点），随内容落盘供「一个 step 一个思考折叠块」分桶；缺省 = 无归属。
   */
  | { type: 'thought'; content: string; stepIndex?: number }
  /**
   * 工具意图预告：LLM 流式生成 tool_call 参数期间（name 一成形即触发），
   * 工具**尚未执行**。与 tool_start 的区别：start 表示 Runtime 确定要执行（参数已完成）；
   * pending 让宿主提前渲染「准备中」工具行，消除大参数工具（如 write_file 全量写入）
   * 数十秒参数生成段的 UI 真空。瞬态展示轨：**不落 ProcessEvent、不进正文/记忆**，
   * 中断或收尾后由折叠区重建自然消失。非流式 name 缺失时 toolCallId 可为空串。
   */
  | { type: 'tool_pending'; toolCallId?: string; name: string }
  /**
   * 过程叙述：LLM 在工具迭代前产出的行动叙述文本
   * （如「让我先查看所有文档」「现在逐一读取它们的内容」）。
   * 与 text（回答正文）语义分离：narrate 只供宿主渲染「过程叙述」折叠行，
   * 不进入最终回答正文（consumeExecutionStream 不将其拼入 content）。
   */
  | {
      type: 'narrate';
      content: string;
      /**
       * 回抽：content 中曾逐字流式进正文区的那一段**原文**。
       *
       * 成因：首轮（无工具史）消息级分类前无法预判是否工具轮，为保 TTFT 零损失，文本先实时
       * 流式进正文；收到 toolCalls 后才确认为过程叙述。本字段让消费者先把该段从正文
       * 撤回（内核扣持久化正文 / 宿主移正文渲染），再按叙述渲染 content——首轮与后续轮同构。
       * 契约：该段为「最近追加的正文文本」（后缀），消费者按后缀精确匹配撤回。
       *
       * 仅运行时消费（瞬态）：不落 ProcessEvent、不持久化；重放的一致由 Round.assistantMessage
       * 已在持久化侧扣除该段保证（consumer = Agent.consumeExecutionStream）。
       */
      withdrawn?: string;
    }
  /**
   * 中断（aborted chunk 的语义分类）
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
   * 流式错误（error chunk 的分类字段）
   *
   * 类别由内核唯一判定（Signal 未 abort 却抛 AbortError = 'connection' 等），
   * 宿主按 category 映射友好展示文案；无 category（null）时宿主回退原始 message，
   * 保留调试可追溯性。不承载裸前缀（如 `[连接中断]`）——语义分类走结构化字段。
   */
  | { type: 'error'; message: string; category?: LlmErrorCategory }
  | { type: 'retry'; attempt: number; maxRetries: number; delayMs: number; error: string }
  | { type: 'paused' }
  /**
   * 主动提问（ask_user 工具）：LLM 调 ask_user 时 yield，
   * Agent 暂停等用户在提问框回答；用户回答经 answerQuestion 回填后 continueAfterPause 续跑（非 Trigger）。
   */
  | { type: 'question_pending'; questions: AskQuestion[] }
  /**
   * 自审查终审开始信号：注入自审查提示前 emit（单次终审，无轮次参数）
   */
  | { type: 'selfReview' }
  /**
   * 任务项级折叠边界：迭代完成且 active 任务项**推进**时 emit。
   * 宿主据此把后续过程事件（narrate/tool/问答）归到对应任务项分组下渲染；无任务表不产。
   * planItemId 为推进到的新 active 任务项 ID，title 为该任务项标题（供分组 summary 展示）。
   */
  | { type: 'plan_item_boundary'; planItemId?: string; title?: string }
  /**
   * 迭代边界（迭代原子落盘）：**一次 LLM 迭代结束**时无条件 emit。
   *
   * 与 `plan_item_boundary` 的关系（两个信号各归其阵营，术语不撞车）：
   * - `plan_item_boundary` = **任务项推进**（有任务表且 active 任务项变化才产，无任务表静默），职责是
   *   webview 任务项级折叠的**分组依据**；
   * - `step_boundary` = **迭代完成**（与有无任务表、有无工具无关），职责是宿主**增量落盘的时机信号**
   *   （落盘不能只挂在 plan_item_boundary 上——无任务表的长工具循环会零增量落盘，该场景由本信号覆盖）。
   *
   * 顺序契约（定案锚 ADR-034）：`plan_item_boundary` 产于**迭代开始**（它所罩住的思考与工具
   * 之前），本 chunk 产于**迭代尾** → 二者天然保持先后序，保证宿主本轮落盘快照已含该任务项
   * 折叠边界，崩溃重放不错位。若二者同产在迭代尾，每个任务项的首个迭代会掉出折叠块。
   *
   * 瞬态信号：**不落 ProcessEvent**（不是历史内容，只是「此刻该落盘」的触发点），
   * `Round.processEvents` / schema 零改动。
   */
  | { type: 'step_boundary' }
  /**
   * 任务表收尾快照：turn 收尾清空运行时任务表（clearPlanOnTurnEnd）**之前**拍的全量终态。
   * 宿主桥接为 ProcessEvent `plan_snapshot` 落盘（重放恢复任务项完成态的唯一真源）；
   * 中断轮同样经过收尾兜底产出；暂停/ask 挂起轮 pauseMeta guard 保留 plan → 不拍。
   */
  | { type: 'plan_snapshot'; items: { planItemId: string; status: PlanItem['status'] }[] }
  | { type: 'done' }
) &
  RoundTagged;

/**
 * 中断语义分类：'user' = 用户主动停止/插话；'interrupted'/'connection' 为预留语义（当前无产生点）。
 */
export type AbortStopReason = 'user' | 'timeout' | 'interrupted' | 'connection';

/**
 * 流式错误语义分类（error chunk 的 category 字段）—— **具名类型 = 跨层单一真理源**。
 *
 * 两个消费面共用同一份字面量集合，故必须同名同源（各写一份会静默漂移）：
 * 1. 实时：`AgentChunk.error.category`（本文件）→ 宿主映射友好文案；
 * 2. 重放：`ProcessEvent` 的 `error` 变体（`memory/roundStore.ts`）→ 回看历史时呈现失败原因。
 * 与 `AbortStopReason` 的分工：aborted 答「谁让它停的」（signal 触因），error 答「出了什么错」，
 * 两者语义不同、**禁互相承载**（见上方 aborted 的 'connection' 预留说明）。
 */
export type LlmErrorCategory = 'connection' | 'timeout' | 'unknown';

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
  /** 自审查提示生成函数：注入后让 LLM 审查自身回复质量（单次终审：一轮即止，无需轮次参数） */
  selfReviewPrompt?: () => string;
  /** 重复工具调用负反馈提示：连续多次相同工具+参数时注入，防止死循环 */
  duplicateToolCallWarning?: (threshold: number) => string;
  /** LLM 空响应兜底提示（无文本无工具调用时使用，默认英文） */
  emptyResponseFallback?: string;
  /**
   * LLM 空响应兜底提示 · 截断型生成函数（默认英文）。
   * 判据：空响应且末次尝试 finishReason='length'（思考/生成吃满输出预算）——与瞬态型
   * （无 finishReason 或非 'length'，中转不回传即降级此口径）分型展示，文案可指导动作。
   * @param attempts 空响应结论前的 chat 尝试总数（1 次首试 + N 次自动重试）——文案口径用
   *   「尝试 N 次」（勿写「重试 N 次」：重试次数 = attempts - 1，写「重试」恒多报 1）
   */
  emptyResponseFallbackTruncated?: (attempts: number) => string;
}

// ─── 归档模式 ───────────────────────────────────────────

/**
 * 归档模式二态：'full'（默认，content 在会话切换前自动归档）/'manual'（全部手动触发，
 * postProcess 跳过所有自动归档分支）。
 */
export type ArchiveMode = 'full' | 'manual';

// ─── 不中断工作模型：会话状态机 + 检查点 ─────────────────
// 核心思路：从「一问一答」升级为「开启后常驻、仅暂停不终止」，会话升级为状态机 + 检查点（SessionCheckpoint）
// 检查点为纯内存态快照（不落盘、无序列化/恢复路径）。三态：RUNNING → PAUSED（双向）→ ERROR（独立可见）；
// ERROR → RUNNING 前须 error.recovered===true 且 cause 已解除。
// 输入统一走 chat（无增量事件驱动补全路径）。
// ────────────────────────────────────────────────────────

/** 会话状态（三态状态机） */
export type SessionStatus = 'running' | 'paused' | 'error';

/** 计划中单个任务项，用于目标漂移检测（文本相似度）和进度追踪 */
export interface PlanItem {
  /** 任务项唯一标识 */
  id: string;
  /** 任务项描述 */
  description: string;
  /** 任务项状态 */
  status: 'pending' | 'active' | 'done' | 'blocked';
  /** 执行顺序（从 0 开始） */
  order: number;
  /**
   * 会议用：该任务项的表层装配角色（组长或组员）。仅会议内临时生效，不改 activePack——
   * prepare 期经 RolePackManager.resolveRoundAssemblyRole 范围校验（∈ {组长} ∪ {组员}，越界忽略 + warning）。
   * 缺失/旧检查点走缺省 undefined（非会议）。
   */
  rolePack?: string;
}

/** 一次 LLM 迭代（step）的执行结果，注入时标「非当前指令」防 LLM 误执行 */
export interface PlanItemOutcome {
  /** 关联任务项 ID（可为空 = 自由对话的迭代推进） */
  planItemId?: string;
  /** step 摘要（LLM 单句或截断） */
  summary: string;
  /** 完成时间戳 */
  completedAt: number;
}

/** 暂停来源（唯一真源）：供 PauseMeta 与 SessionStateMachine 共用，防类型级双轨漂移 */
export type PauseSource = 'user' | 'agent' | 'system';

/** 暂停上下文，用于渲染层展示和恢复决策 */
export interface PauseMeta {
  /** 暂停原因 */
  reason: string;
  /** 暂停来源（引用 PauseSource，与 SessionStateMachine 同源） */
  source: PauseSource;
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
  /** 工具调用（assistant 消息）——形状真源 llm/types.ToolCall（与 toolRunner 同源，单契约） */
  toolCalls?: Array<ToolCall>;
  /** 工具调用 ID（tool 消息） */
  toolCallId?: string;
}

/**
 * 会话检查点，不中断工作模型的核心状态载体。纯内存态快照（
 * 不落盘、无序列化/恢复路径——中止/断电走「中断轮补全为完整 turn」，运行时暂停同 turn 内存续跑）。
 * 三态：running / paused（主动暂停）/ error（异常，独立可见不自动转 PAUSED，保留 cause 供检查，
 * 恢复前须校验 error.recovered===true 且 cause 已解除）。
 */
export interface SessionCheckpoint {
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
  /** 执行计划任务项列表 */
  plan: PlanItem[];
  /**
   * 工具执行日志（outbox 模式）：FIFO，超上限时优先丢弃「幂等或已补偿」的最早记录，
   * 非幂等未补偿记录永不丢弃。
   */
  completedToolCalls?: ToolExecutionRecord[];
  /** step 推进日志（LLM 迭代级时间轴，FIFO cap 10-12 条；任务项状态见 plan） */
  planItemLog?: PlanItemOutcome[];
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

  /**
   * 当前阈值（可选）。宿主注入自定义拦截器时，loop 的失败硬闸 / 警告文案 / `context.threshold`
   * 都应取**本拦截器**的阈值，而非 loop 自身硬编码。未实现则回落默认 3。
   */
  getThreshold?(): number;
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
   * 不回退 items[0]。
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
   *（无内置示例键；角色包无自动匹配链，本机制保留供宿主能力边界使用）
   */
  strategyOverride?: Partial<BehaviorStrategy>;
  /**
   * 记忆数据目录（宿主必填）。内核不提供默认值——目录位置与其层级语义（项目级 / 用户级）
   * 是宿主的产品决策，内核不置喙，也不假设其下的文件形态。
   */
  dataDir: string;
  /**
   * 项目注册表目录（可选，缺省随 dataDir）。注册表存在的意义是**跨项目按名解析**，
   * 故只有多项目共用同一 dataDir（或显式指定共同的 registryDir）时才真正兑现；
   * 若 dataDir 是项目级目录，注册表随之落进各项目内、只含项目自身条目，按名切换不成立。
   */
  registryDir?: string;
  /** 最大上下文 token 数（默认 120000） */
  maxContextTokens?: number;
  /**
   * per-LLM 输出预算默认值（token，可选）：宿主 per-LLM 配置（配置面板「输出上限」）透传，
   * 请求体携带 max_tokens。背景（EMPTY-RESP-1 根因）：推理模型 thinking 与正文共享输出预算，
   * thinking 吃满服务端默认上限会把正文挤空（空响应）——显式配置消除盲区。
   * undefined = 不传（回服务端默认，盲区语义与 contextWindow 同构）。
   * 裁决：与角色包策略 act.outputLimit **取更小值**（两者都是「上限」性质，须同时满足；
   * 对齐上下文窗口 min(provider 窗口, 角色包 contextLimit) 的语义）——buildChatOptions 单点裁决，
   * 宿主只经 `Agent.getEffectiveMaxTokens()` 读取生效值，不得自行重算。未声明侧缺位时取另一侧。
   * 请求层只做形态归一（openaiCompatible.normalizeMaxTokens：
   * 非正整数不传）；上限不裁决——超模型能力的值原样透传、由服务端可见报错，不被内核静默替换
   * （与 contextWindow 同哲学：集成方 UI 护栏是输入边界的唯一可见裁决点）。
   */
  maxTokens?: number;
  /** 安全权限 */
  permission?: 'owner' | 'guest';
  /** 允许的路径白名单 */
  allowedPaths?: string[];
  /** 写入确认 */
  confirmWrites?: boolean;
  /** 脚本/代码执行确认（独立于写入确认；true 时 run_code/run_project_script 执行前弹窗，默认 false 不弹窗） */
  confirmScripts?: boolean;
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
  /**
   * node 可执行文件路径（可选）：宿主注入真实 node 路径
   * （如 IDE 内置 node / 用户配置的 node）给 L3 脚本执行器（run_skill_script /
   * run_project_script 的 node runtime 分支）。缺省走 'node'（PATH 查找）；
   * 宿主机无独立 node 时注入可避免 .js/.mjs 脚本 ENOENT。
   */
  scriptNodePath?: string;
  /**
   * 禁用的技能名清单（可选）：宿主配置形态启停——命中的技能
   * 从 L1 清单消失、L2/L3 访问（read_skill/read_resource/run_skill_script）不可用。
   * 对 LLM 语义 = 技能不存在（不暴露「禁用」细节）；宿主 UI 依据同名设置标注「已禁用」徽章。
   * 缺省空 = 全量技能可用（向后兼容）。
   */
  disabledSkills?: string[];
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
  enableContextSummary: boolean;
  archiveMode: ArchiveMode;
  /**
   * 组（会议名单容器）：内部运行态必选——外部 AgentOptions 可选（不配 = 无团队），
   * Agent 构造时 `?? []` 归一化后恒为数组。
   * 收紧内部契约保证 AssembleInput 必传，防「可选性假约束」吞掉团队数据（team 启动缺口教训）。
   */
  rolePackTeams: RolePackTeam[];
};
