/**
 * Agent 流式输出事件类型
 *
 * 核心库向上层 emit 结构化事件，让 CLI/Web/TUI 等宿主项目
 * 能区分"思考中"、"输出文本"、"调用工具"等阶段，给用户实时反馈。
 *
 * 自然生长原则：这是核心库的"机制"——所有宿主项目都需要进度反馈，
 * 不是 demo 的"策略"。
 *
 * thinking 事件的 phase 取值：
 * - 'recalling'：正在召回会话记忆（recall 双通道：语义 + 关键词）
 * - 'processing'：正在写入历史/注入技能 prompt
 * - 'archiving'：正在归档用户画像/匹配角色/匹配技能
 *
 * error 事件：流式过程中发生错误（如 LLM 超时、连接断开），
 * 替代裸 throw 让宿主能优雅展示错误并清理 UI（避免未处理 rejection 静默卡死）。
 *
 * ─── agent/ 模块依赖图（最后更新：2026-08-10） ─────────────────
 * 如需精确依赖关系，请阅读各文件 import 语句。本图仅展示高层模块关系。
 *
 *   agent.ts（门面，Agent 类）
 *     ├─ assembler.ts（组件装配，init 阶段）
 *     ├─ loop.ts（主循环，chat 阶段）
 *     │    ├─ toolExecutor.ts（工具执行）
 *     │    ├─ contextManager.ts（上下文窗口管理）
 *     │    ├─ messageHistory.ts（历史消息存储）
 *     │    ├─ guardrail.ts（护栏规则）
 *     │    └─ tracer.ts（可观测性 span）
 *     ├─ composer.ts（四级补全器，不中断工作模型）
 *     ├─ personaMatcher.ts（LLM 角色匹配，从 persona 迁入）
 *     ├─ userFactExtractor.ts（用户事实提取，纯函数）
 *     ├─ builtinToolHandlers.ts（内置工具处理器）
 *     └─ managers/（14 个专职 Manager + 4 辅助/聚合模块）
 *          ├─ archiveCoordinator.ts（归档协调，emit archiveFailed）
 *          ├─ autoConfigRefiner.ts（配置自动优化）
 *          ├─ chatLockManager.ts（并发锁，token 机制）
 *          ├─ configManager.ts（配置加载）
 *          ├─ dedupManager.ts（L1 语义去重）
 *          ├─ insightExtractor.ts（LLM 提炼，prompt 独立函数）
 *          ├─ memoryAdvisor.ts（L3 记忆建议）
 *          ├─ memoryDecayScheduler.ts（记忆衰减调度）
 *          ├─ memoryInspector.ts（记忆读写统一入口，ADR-014）
 *          ├─ relationBuilder.ts（记忆关系构建，ADR-014 侧车）
 *          ├─ sessionArchiver.ts（会话归档）
 *          ├─ sessionManager.ts（会话状态 + 检查点）
 *          ├─ textPolishManager.ts（文本润色）
 *          └─ workProjection.ts（作品投影）
 *          ─ 辅助模块 ─
 *          ├─ goalConsistencyChecker.ts（P3.1 目标一致性校验）
 *          ├─ llmJudgeHelper.ts（LLM 判断辅助，供记忆衰减等使用）
 *          ├─ memoryGovernance.ts（L0-L3 治理聚合门面）
 *          └─ streamAccumulator.ts（流式累积辅助）
 *
 * 分层依赖方向（ADR-008）：
 *   agent/ → memory/ → storage/（不可反向）
 *   agent/ → persona/（不可反向，persona 不调 LLM）
 *   agent/ → llm/（provider 注入）
 *   agent/ → skill/（技能加载）
 *   agent/ → config/（配置加载）
 * ──────────────────────────────────────────────────────────
 */

/** thinking 事件的阶段标识 */
export type ThinkingPhase = 'recalling' | 'processing' | 'archiving';

/**
 * 召回记忆摘要（用于 UI 展示"召回透明度"）
 *
 * 仅暴露 UI 展示所需字段，不包含 content（避免向 UI 层泄露完整记忆内容）。
 * - name：可读名称，点击跳转记忆详情
 * - score：相似度分数（0-1），展示召回质量
 * - source：来源标签，可选展示（如 rule/insight/profile）
 */
export interface RecalledMemorySummary {
  /** 记忆唯一标识（source:name 格式，用于前端精准跳转详情） */
  id: string;
  /** 记忆可读名称（点击跳转记忆详情用） */
  name: string;
  /** 相似度分数（0-1） */
  score: number;
  /** 来源标签（开放字符串，如 'rule'、'insight'、'profile'） */
  source: string;
}

/**
 * Handoff 决策类型
 *
 * 回答后衔接决策，决定当前轮次结束后如何衔接下一轮：
 * - 'wait'：等待用户输入（气口敞开，等待 Trigger）
 * - 'loop'：自动续跑（由 Loop 模式驱动下一轮）
 * - 'end'：终止当前会话
 */
export type HandoffDecision = 'wait' | 'loop' | 'end';

export type AgentChunk =
  | { type: 'recall'; memories: RecalledMemorySummary[] }
  | { type: 'thinking'; phase: ThinkingPhase }
  | {
      type: 'text';
      content: string;
      /**
       * 护栏阻断标志（结构化信号）
       *
       * 当输入/输出被护栏规则阻断时为 true，让 eval 框架和宿主 UI
       * 能通过结构化字段判断护栏触发，而非依赖文案子串匹配。
       * 非护栏场景的普通 text chunk 不携带此字段（undefined 等同 false）。
       */
      guardrailBlocked?: boolean;
    }
  | { type: 'tool_start'; toolCallId: string; name: string; args?: string }
  | { type: 'tool_result'; toolCallId: string; name: string; ok: boolean; summary?: string }
  | { type: 'aborted'; reason: string }
  | { type: 'error'; message: string }
  | { type: 'retry'; attempt: number; maxRetries: number; delayMs: number; error: string }
  | { type: 'paused' }
  /**
   * Handoff 衔接决策
   *
   * 回答后阶段基于 L2 策略的 endingHandoff 配置，决定当前轮次结束后
   * 如何衔接下一轮。宿主可通过此 chunk 决定是否自动触发下一轮对话。
   */
  | { type: 'handoff'; decision: HandoffDecision; reason?: string }
  /**
   * 自审查轮开始信号
   *
   * LLM 生成纯文本回复后，若启用自审查且未执行，在注入自审查提示前 emit。
   * 宿主可据此展示"LLM 正在审查自身回复"的视觉反馈。
   * round 表示当前是第几轮自审查（为 Phase 9 多轮可配置预留）。
   */
  | { type: 'selfReview'; round: number }
  | { type: 'done' };

// ─── 宿主可覆盖的 UI 文本 ────────────────────────────────

/**
 * 宿主可覆盖的 UI 消息文本
 *
 * 核心库内置英文默认值，宿主可通过 AgentOptions.messages
 * 覆盖为任意语言（中文/日文/自定义）。
 *
 * 遵循领域无关原则：核心库不耦合特定语言。
 */
export interface UIMessages {
  /** 对话取消提示（默认 "User cancelled the conversation"） */
  abortedByUser?: string;
  /** 达到最大迭代次数提示（默认 "\n\n[Max iterations reached]"） */
  maxIterationsReached?: string;
  /**
   * 流式中断标记（默认 "\n\n[已中断]"）
   *
   * 流式输出被用户中断时，已生成的部分文本仍会写入历史，
   * 此标记追加到文本末尾，让下一轮 LLM 上下文和历史归档能识别中断响应。
   * 与 maxIterationsReached 性质相同（对话末尾状态标记）。
   */
  interrupted?: string;
  /**
   * 上下文窗口截断提示生成函数
   * @param skipped 被裁剪的消息数
   * @param kept 保留的消息数
   * @returns 系统消息内容
   */
  contextTruncated?: (skipped: number, kept: number) => string;
  /** 最近对话标签（默认 "[Recent conversation]"） */
  recentConversationLabel?: string;
  /** 用户角色标签（默认 "User"） */
  userLabel?: string;
  /** 助手角色标签（默认 "Assistant"） */
  assistantLabel?: string;
  /** 护栏阻断提示模板（{rule} 会被替换为规则名） */
  inputBlockedByGuard?: (rule: string) => string;
  /** 护栏警告前缀（默认 "[Guardrail Warning]"） */
  guardrailWarningPrefix?: string;
  /** 输出被护栏阻断提示模板 */
  outputBlockedByGuard?: (rule: string) => string;
  /**
   * Reflection（反思/自修正）提示生成函数
   *
   * 工具调用失败且错误可重试时，在 LLM 上下文中追加此提示，帮助 LLM 聚焦于修正而非放弃。
   *
   * @param remaining 剩余反思次数
   * @returns 系统消息内容
   */
  reflectionHint?: (remaining: number) => string;
  /**
   * 自审查提示（默认英文）
   *
   * LLM 生成纯文本回复后，注入此提示让 LLM 审查自身回复质量。
   * 自审查仅执行 1 轮，审查后 LLM 可确认或改进回复。
   */
  selfReviewPrompt?: string;
}

// ─── 归档模式（ADR-015） ──────────────────────────────────

/**
 * Agent 归档模式三态控制
 *
 * 详见 ADR-015-archive-mode.md。
 *
 * - `full`（默认）：profile facts + insight + 对话原始内容（会话归档预留）全部自动归档
 * - `insights-only`：profile facts + insight 自动归档，对话原始内容需手动归档
 * - `manual`：所有归档都需手动触发，postProcess 跳过所有自动归档分支
 *
 * 设计原则：profile facts 与 insight 同属"提炼类记忆"（从输入加工得到，非原始对话），
 * 归档行为保持一致——`insights-only` 下都自动，`manual` 下都需手动。
 */
export type ArchiveMode = 'full' | 'insights-only' | 'manual';

// ─── 不中断工作模型：增量事件 + 检查点（v2.0） ──────────
//
// 设计文档：docs/根基/不中断工作模型演进.html（v1.6）
// 核心思路：从「一问一答」升级为「开启后常驻、仅暂停不终止」，
// 输入从纯文本升级为增量事件（SessionEvent），会话从消息数组升级为
// 状态机 + 检查点（SessionCheckpoint）。
//
// 三态状态机：RUNNING → PAUSED（双向暂停）→ ERROR（独立可见）
// 恢复校验：ERROR → RUNNING 前须 error.recovered===true 且 cause 已解除
// ──────────────────────────────────────────────────────────

/** 会话状态（三态状态机，SSOT 单一真理源） */
export type SessionStatus = 'running' | 'paused' | 'error';

/**
 * 四元组：角色 × 任务 × 标准 × 资源
 *
 * 不中断工作模型的核心输入结构，三源融合（P1 显式输入 → P2 记忆沉淀 → P3 系统内置）
 * 逐级补全，缺省时有明确补全链。
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
 * 槽位引用标记
 *
 * 用于 SessionEvent.delta 的增量槽引用语义——当用户说「继续」时，
 * 任务槽引用 currentGoal 而非覆盖。引用标记让调用方可以显式表示
 * 「引用当前值」而非「提供新值」。
 *
 * 支持以下引用标识：
 * - 'currentGoal'：引用当前会话目标（适用 task 槽）
 * - 'currentRole'：引用当前角色（适用 role 槽）
 * - 'currentStandard'：引用当前标准（适用 standard 槽）
 * - 'currentResource'：引用当前资源（适用 resource 槽）
 */
export interface SlotRef {
  /** 引用标识 */
  ref: string;
}

/**
 * 角色定义
 *
 * 会话级角色，定义 Agent 的行为边界和语气风格。
 * 可中途变更（如从「开发」切换到「审查」）。
 */
export interface Role {
  /** 角色名（如 "developer"、"reviewer"、"travel-planner"） */
  name: string;
  /** 角色描述（可选，用于 system prompt 注入） */
  description?: string;
}

/**
 * 执行标准
 *
 * 定义任务完成的质量标准和约束条件。
 * 用户可随时更新标准（如"代码必须通过 ESLint"）。
 */
export interface Standard {
  /** 质量标准描述（如 "代码必须通过所有测试"） */
  quality: string;
  /** 约束条件列表（如 ["不使用第三方库", "保持向后兼容"]） */
  constraints: string[];
}

/**
 * 资源状态快照
 *
 * 会话资源维度的快照——断点续跑时用于还原 Agent 当时引用的上下文。
 * 与 B 篇「记忆覆盖四元组全集」对齐。
 */
export interface ResourceState {
  /** 引用的文档路径列表 */
  documents: string[];
  /** 引用的记忆 ID 列表 */
  memories: string[];
  /** 当前上下文摘要（断点续跑还原用） */
  context: string;
}

/**
 * 计划步骤
 *
 * Agent 执行计划中的单个步骤，用于目标漂移检测（文本相似度）和进度追踪。
 */
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

/**
 * 回合结果（P2-1: Phase 2 回合折叠）
 *
 * 记录一次完整的 LLM 调用回合（迭代）的执行结果，用于上下文注入和进度追踪。
 * 注入时标「非当前指令」防 LLM 误执行。
 */
export interface RoundOutcome {
  /** 对应的计划步骤 ID（可为空，表示自由对话回合） */
  stepId?: string;
  /** 回合摘要（LLM 单句或截断处理） */
  summary: string;
  /** 完成时间戳 */
  completedAt: number;
}

/**
 * 暂停元数据（P2-1: Phase 2 暂停模型）
 *
 * 存储暂停的上下文信息，用于渲染层展示和恢复决策。
 */
export interface PauseMeta {
  /** 暂停原因 */
  reason: string;
  /** 暂停来源 */
  source: 'user' | 'agent' | 'system';
}

/**
 * 工具幂等性级别（P3.4 补偿机制·工具幂等契约）
 *
 * 标记工具是否具有幂等性，以及幂等性的保证级别。
 * - idempotent：天然幂等（读操作），相同参数多次执行结果一致
 * - idempotent-key：依赖业务唯一键实现幂等（写操作，如 create_xxx 带唯一键）
 * - non-idempotent：非幂等（如 append 模式写入），需补偿机制兜底
 */
export type IdempotencyLevel = 'idempotent' | 'idempotent-key' | 'non-idempotent';

/**
 * 工具执行记录（P3.3 执行计划管理·工具幂等，outbox 模式）
 *
 * 记录已执行的工具调用，用于恢复时检查 outbox 模式。
 * 以工具名称 + 参数签名作为唯一标识，避免重复执行。
 *
 * 补偿管线已降级（P1-1 2026-08-11）：不再记录副作用和补偿时间戳，
 * `compensateTool` / `compensateAllNonIdempotent` 降级为纯日志记录。
 */
export interface ToolExecutionRecord {
  /** 工具名称 */
  name: string;
  /** 参数签名（JSON 字符串化后的参数，用于精确匹配） */
  argsSignature: string;
  /** 执行时间戳 */
  executedAt: number;
  /** 执行结果摘要（前 100 字符） */
  resultSummary: string;
  /** 工具执行是否成功 */
  ok: boolean;
  /** 工具幂等性级别（outbox 模式使用，决定恢复时是否跳过重复执行） */
  idempotent?: IdempotencyLevel;
}

/** 热记忆中的聊天消息
 *
 * 结构对齐 LLM Message 类型，用于会话检查点中存储截断后的热记忆窗口。
 * 不含时间戳（与 SessionMessage 区分），仅保留 role + content 用于 LLM 上下文注入。
 *
 * role 类型从 memory/types.ts 的 MessageRole 导入（SSOT 单一真理源）。
 */
export interface ChatMessage {
  /** 消息角色 */
  role: MessageRole;
  /** 消息内容 */
  content: string;
  /** 消息来源名称（可选，用于标识 function 调用等场景，与 LLM Message.name 对齐） */
  name?: string;
  /** 工具调用（assistant 消息，可选） */
  toolCalls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  /** 工具调用 ID（tool 消息，可选） */
  toolCallId?: string;
}

/**
 * 增量事件类型
 *
 * 替代纯文本输入，为不中断工作模型提供结构化意图分类。
 * 质变一的核心接口形态——从 Request 升级为 SessionEvent。
 *
 * 意图分类防污染：不同意图走不同处理路径，避免 chat 意图被误解析为 command。
 */
export interface SessionEvent {
  /** 意图分类 */
  type: 'command' | 'correction' | 'clarify' | 'chat';
  /** 原始文本内容 */
  content: string;
  /**
   * 槽位级增量（可选）
   *
   * 合并规则（槽位级）：
   * - 增量槽引用：使用 SlotRef 引用标记（如 `{ ref: 'currentGoal' }`），不覆盖
   * - 新值槽覆盖：直接提供新值，覆盖对应槽位
   * - 数组槽追加：resource 槽的 documents/memories 数组自动追加，非覆盖
   * - 未提供字段（undefined）：走补全链 P2→P3→P4
   */
  delta?: DeltaPayload;
}

/**
 * 增量载荷
 *
 * 每个槽位支持两种模式：
 * - 具体值 → 覆盖模式（新值槽覆盖）
 * - SlotRef 引用标记 → 引用模式（增量槽引用，不覆盖）
 * - undefined → 未提供，走补全链
 */
export interface DeltaPayload {
  /** 角色增量（支持引用标记引用当前角色） */
  role?: Role | SlotRef;
  /** 任务增量（支持引用标记引用当前目标） */
  task?: string | SlotRef;
  /** 标准增量（支持引用标记引用当前标准） */
  standard?: Standard | SlotRef;
  /** 资源增量（支持引用标记引用当前资源，或提供新资源追加） */
  resource?: ResourceState | SlotRef;
}

/**
 * 会话检查点
 *
 * 不中断工作模型的核心状态载体——质变二与新增维度的载体。
 * 包含会话全部上下文，支持序列化后断点续跑。
 *
 * 三态说明（v1.6）：
 * - running：Agent 正在执行中
 * - paused：用户/Agent/系统主动暂停，区分 idle（主动暂停）和 error（异常暂停）
 * - error：异常状态，独立可见不自动转 PAUSED，保留 cause 供用户检查
 *   恢复前须校验 error.recovered===true 且 cause 已解除
 */
export interface SessionCheckpoint {
  /** 会话唯一标识 */
  sessionId: string;
  /** 三态状态（v1.6）：ERROR 独立可见，不自动转 PAUSED */
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
   * 目标变更序号（原 goalVersion，T11 改名 2026-08-09）
   *
   * 每次 currentGoal 变更时递增。**仅作事件序号**，不承担版本一致性校验——
   * 漂移检测由 GoalConsistencyChecker 的文本相似度完成（Jaccard + bigram，
   * 阈值 0.7 / 0.4），与本字段无关。
   *
   * 改名动机：旧名 goalVersion 误导后来人以为存在版本校验机制（"版本"暗示
   * 可比较、可检测漂移），从而在需要一致性校验时误用本字段。实质是
   * "目标变更事件序号"——goalUpdated / goalDriftDetected 事件的载荷。
   * 多 Agent 乐观锁等真正的版本语义未来若需要，应新建独立字段 + 校验机制。
   */
  goalChangeSeq: number;
  /** 执行计划步骤列表 */
  plan: PlanStep[];
  /** 当前角色（会话级，可中途变更） */
  role: Role;
  /** 当前执行标准（会话级，可更新） */
  standard: Standard;
  /** 资源快照（断点续跑还原用） */
  resource: ResourceState;
  /** 热记忆窗口（截断后的最近对话，防膨胀） */
  hotMemory: ChatMessage[];
  /**
   * 热记忆截断计数（P2.2 热记忆截断策略）
   *
   * 当热记忆超过 `HOT_MEMORY_MAX_ROUNDS` 轮时，FIFO 截断的早期消息数量。
   * 用于恢复时注入一致性标记，让 LLM 感知截断边界。
   * 0 或 undefined 表示未发生截断。
   */
  truncatedCount?: number;
  /**
   * 工具执行日志（P3.3 执行计划管理·工具幂等，outbox 模式）
   *
   * FIFO 策略：`logToolExecution` 在超过 COMPLETED_TOOL_CALLS_MAX 时触发截断，
   * 优先丢弃「幂等或已补偿」的最早记录。非幂等未补偿记录永不丢弃（宁可检查点偏大，不可漏补偿）。
   */
  completedToolCalls?: ToolExecutionRecord[];
  /** 回合结果日志（P2-1: Phase 2 回合折叠，FIFO cap 10-12 条） */
  roundLog?: RoundOutcome[];
  /** 暂停元数据（P2-1: Phase 2 暂停模型） */
  pauseMeta?: PauseMeta;
  /** 心跳时间戳（毫秒），防僵尸会话 */
  lastHeartbeat: number;
  /**
   * 暂停起点时间戳（毫秒），与 lastHeartbeat 解耦（T2-2 / F1-1）
   *
   * 语义单一化：lastHeartbeat 仅承载「检查点写入时间」（touchCheckpoint 唯一写点，
   * 任何内容变更都会刷新）；本字段专指「本检查点进入 paused 状态的时刻」，仅由
   * SessionManager.pause() 在状态转换点写入，暂停后不再被 touchCheckpoint 刷新。
   * 暂停超时判定（isPauseTimedOut / markSessionTimedOut / checkPauseTimeout）以此为准，
   * 而非 lastHeartbeat——否则暂停后任意 touchCheckpoint（如 updatePlanStepStatus）
   * 会刷新心跳、无限推迟超时判定。
   * 可选：仅 paused 检查点有意义；缺失时超时判定回退到 lastHeartbeat。
   */
  pausedAt?: number;
  /**
   * 检查点 schema 版本（T1-4，未来兼容公共前提）
   *
   * 标记本检查点结构所对应的内核版本。`createCheckpoint` 写入当前
   * `CURRENT_SCHEMA_VERSION`；`parseCheckpoint`/`normalizeCheckpoint` 读取并比对，
   * 高于当前版本时按当前版本尽力恢复并 warn、不阻断（避免丢弃用户工作）。
   *
   * 字段为必需项（非 optional）：任何直接构造检查点的代码都必须显式声明版本，
   * 缺失即代表构造方未考虑未来兼容——由 tsc 在编译期拦下，而非运行时静默落盘。
   */
  schemaVersion: number;
}

/**
 * 状态转换结果
 *
 * 状态机 pause()/resume()/triggerError()/recover() 等显式状态转换方法的返回值，
 * 描述一次状态转换是否合法及其原因。
 */
export interface StatusTransition {
  /** 转换前状态 */
  from: 'running' | 'paused' | 'error';
  /** 转换后状态 */
  to: 'running' | 'paused' | 'error';
  /** 转换原因（如 "用户暂停"、"LLM 超时"、"恢复校验通过"） */
  reason: string;
  /** 转换是否被允许 */
  allowed: boolean;
}

// ─── 四级补全：Composer 类型 ─────────────────────────────
//
// 三源融合（P1 显式 → P2 记忆 → P3 内置 → P4 暂停询问）
// 四元组每个槽位独立走补全链，缺省时有明确来源。
// ──────────────────────────────────────────────────────────

/**
 * 补全来源级别常量（SSOT 单一真理源）
 *
 * 从常量对象推导 CompletionLevel 类型，新增级别只需加一项。
 * composer.ts 和 agent.ts 引用此常量而非硬编码字符串。
 */
export const COMPLETION_LEVELS = {
  P1_EXPLICIT: 'P1-explicit',
  P2_MEMORY: 'P2-memory',
  P3_BUILTIN: 'P3-builtin',
  P4_CLARIFY: 'P4-clarify',
} as const;

/**
 * 补全来源级别联合类型（由 COMPLETION_LEVELS 推导）
 *
 * 标记四元组每个槽位的补全来源，用于可追溯性。
 */
export type CompletionLevel = (typeof COMPLETION_LEVELS)[keyof typeof COMPLETION_LEVELS];

/**
 * 已解析的四元组增量
 *
 * Composer 补全链的输出——将 SessionEvent.delta 补全为完整的四元组增量。
 * 每个槽位标注补全来源，确保可追溯。
 */
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

/**
 * 澄清问题
 *
 * P4 补全级别：当 P1→P3 都无法补全某个槽位时，
 * 生成澄清问题暂停等待用户回答。
 */
export interface ClarifyQuestion {
  /** 目标槽位（role/task/standard/resource） */
  slot: keyof FourTuple;
  /** 问题文本 */
  question: string;
  /** 默认选项（可选，用户可快速选择） */
  options?: string[];
  /**
   * 是否低风险（P4 防滥用）
   *
   * 低风险决策由 Agent 自动兜底（使用 P3 内置值），不在连续暂停计数中累积。
   * 高风险决策须用户确认，计入连续暂停计数。
   * 连续 2 次高风险暂停后强制降级 P3，不再生成 P4 问题。
   */
  lowRisk?: boolean;
}

/**
 * Composer 输出（SSOT 单一真理源）
 *
 * 从 composer.ts 迁移至此，与 ResolvedDelta、ClarifyQuestion 等
 * 四级补全类型同处一处，消除跨文件类型追踪成本。
 */
export interface ComposeResult {
  /** 已解析的四元组增量 */
  resolved: ResolvedDelta;
  /** 需要澄清的问题（仅 P4 级别时非空，此时应暂停等待用户回答） */
  needClarify?: ClarifyQuestion[];
}

/**
 * 计划上下文（P3.3 执行计划管理，SSOT 单一真理源）
 *
 * 从 composer.ts 迁移至此，与 ComposeResult 同处一处。
 */
export interface PlanContext {
  /** 计划是否停滞（所有步骤已完成/阻塞，或空计划） */
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
import type { IMemoryRelationStore } from '@/memory/relationStore.js';
import type { ISessionStore } from '@/memory/sessionStore.js';
import type { ITracer } from '@/agent/tracer.js';
import type { ProjectContext } from '@/memory/projectManager.js';
import type { MessageRole } from '@/memory/types.js';
import type { IWebSearchProvider } from '@/web-search/types.js';
import type { ProviderRouter } from '@/llm/types.js';

/**
 * 文件层前置条件断言回调（T5：两段式契约结构化）
 *
 * 注入时，deleteRule/deleteSkill/updateRule 入口先校验宿主是否已完成文件操作。
 * `expected='absent'` 校验文件应已被宿主删除；`expected='exists'` 校验文件应已写入。
 * id 格式：`rule:NAME` 或 `skill:NAME`（排雷 T-B4：保持字符串协议，宿主 index.ts 解析）。
 *
 * 命名类型（T-C1）：此前签名全文散落 5 处（types.ts×2 / assembler.ts×2 / configManager.ts），
 * 提取为本类型统一引用。
 */
export type FileConsistencyCheck = (id: string, expected: 'exists' | 'absent') => boolean;

/** Agent 构造选项 */
export interface AgentOptions {
  /** 项目路径（必须） */
  projectPath: string;
  /** 前台 LLM Provider（必须，宿主负责创建） */
  provider: LlmProvider;
  /** 后台 LLM Provider（可选，用于投影等后台操作，不配时复用前台） */
  backgroundProvider?: LlmProvider;
  /**
   * Provider 路由选择器（P1-2 多模型路由基础）
   *
   * 根据任务类型返回对应的 Provider 实例。
   * 不配置时所有任务类型使用同一个 Provider（完全向后兼容）。
   */
  providerRouter?: ProviderRouter;
  /** 配置目录（personas/rules/skills） */
  configDir?: string;
  /** 记忆数据目录（由宿主显式注入） */
  dataDir?: string;
  /** 项目注册表目录（默认与 dataDir 相同）。设为用户级路径可避免每项目重复存储 */
  registryDir?: string;
  /** 最大上下文 token 数（默认 120000） */
  maxContextTokens?: number;
  /** 默认角色名 */
  persona?: string;
  /** 安全权限 */
  permission?: 'owner' | 'guest';
  /** 允许的路径白名单 */
  allowedPaths?: string[];
  /** 写入确认 */
  confirmWrites?: boolean;
  /** 向量存储（可选，提供时启用语义搜索召回；宿主可注入任意 IVectorStore 实现） */
  vectorStore?: IVectorStore;
  /** 召回时排除的 source 标签（默认 ['persona', 'rule', 'skill']，这些已由 bootstrap 注入） */
  recallExcludeSources?: string[];
  /** 外部注入的存储实例（可选，不传则内部创建 InMemoryStorage） */
  storage?: IMemoryStorage;
  /** 外部注入的记忆关系存储（可选，ADR-014 侧车模型，不传则跳过关系构建） */
  relationStore?: IMemoryRelationStore;
  /** 外部注入的会话存储（可选，不传则仅在内存中保存） */
  sessionStore?: ISessionStore;
  /** 可观测性 Tracer（可选，不传则使用 NoopTracer 静默丢弃所有 span） */
  tracer?: ITracer;
  /** 宿主可覆盖的 UI 消息文本（默认英文，宿主覆盖为中文等） */
  messages?: UIMessages;
  /** 上下文超限时是否自动生成摘要（默认 true，开启后首次截断时增加 ~1-2s 延迟） */
  enableContextSummary?: boolean;
  /**
   * 归档模式（ADR-015，默认 'full'）
   *
   * - 'full'：profile facts + insight 自动归档（对话原始内容待会话归档实现后自动）
   * - 'insights-only'：profile facts + insight 自动归档，对话原始内容需手动
   * - 'manual'：所有归档都需手动触发
   */
  archiveMode?: ArchiveMode;
  /** 网络搜索提供者（可选，不传则不启用网络搜索能力） */
  webSearchProvider?: IWebSearchProvider;
  /**
   * 文件层前置条件断言回调（可选，T5：两段式契约结构化）
   *
   * 注入时，deleteRule/deleteSkill/updateRule 入口先校验宿主是否已完成文件操作。
   * `expected='absent'` 校验文件应已被宿主删除；`expected='exists'` 校验文件应已写入。
   * 校验失败抛 configError（fail-fast），未注入时完全降级为现状。
   */
  fileConsistencyCheck?: FileConsistencyCheck;
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
 * Agent 内部配置（构造参数解析默认值后的形态）
 *
 * T-C1 派生自 AgentOptions（消除 24 字段逐一手写镜像）：
 *   - Omit 掉「不进入内部配置」的字段（provider/backgroundProvider 由 Agent 单独持有）
 *   - 覆盖「构造时 `?? 默认值` 解析后必填」的字段（dataDir/maxContextTokens/permission/...）
 *   - 其余字段继承 AgentOptions 的必填/可选性（与现手写声明逐字段等价）
 * 新增 AgentOptions 字段时：若构造处有默认值解析，把该字段加进 Omit 列表 + 覆盖类型。
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
  | 'persona'
> & {
  dataDir: string;
  maxContextTokens: number;
  permission: 'owner' | 'guest';
  allowedPaths: string[];
  confirmWrites: boolean;
  recallExcludeSources: string[];
  enableContextSummary: boolean;
  archiveMode: ArchiveMode;
  /** 默认角色名（AgentOptions.persona 解析后的内部命名） */
  personaName: string | undefined;
};
