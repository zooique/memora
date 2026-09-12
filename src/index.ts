/**
 * Memora — 通用 Agent 纯逻辑库（Node.js，零 native 依赖）
 * 公共导出面：宿主项目通过本入口 import 接入；持久化/搜索/会话等宿主能力均经接口注入。
 * 类型依赖方向单向（agent → memory → utils；agent → llm；agent → security），详见 module-inventory.md。
 */

// ─── 库导出：供宿主项目 import 接入 ──────────────────────
export { Agent } from '@/agent/agent.js';
export type {
  AgentChunk,
  ThinkingPhase,
  AbortStopReason,
  UIMessages,
  ArchiveMode,
  AgentOptions,
  AgentContext,
  AgentProjectEntry,
} from '@/agent/types.js';
// 重复工具调用拦截器（宿主可自定义判重策略）
export type {
  DuplicateCallInterceptor,
  DuplicateCheckVerdict,
  DuplicateCheckContext,
} from '@/agent/types.js';
export { DefaultDuplicateCallInterceptor } from '@/agent/duplicateInterceptor.js';
export { AGENT_CONSTANTS, LOOP_CONSTANTS } from '@/agent/constants.js';
// 上下文窗口解析（单一真理源公式）：宿主在构造 Agent 前将 provider.contextWindow 与
// 用户全局上限解析为单一 maxContextTokens 数字，避免跨宿主镜像 min 逻辑
export { resolveContextWindow } from '@/agent/budget.js';
// 上下文占用快照组装（SSOT 单点）：宿主历史会话重算占用时与内核 prepare 共用同一收敛口径
export { estimateOccupancy, type EstimateOccupancyInput } from '@/agent/budget.js';
// token 估算（CJK 感知，零状态纯函数）：
//   estimateTokensMessages = 消息序列（先累计后取整，与运行时 prepare 同口径，历史会话重算用它）
//   estimateTokensText     = 单段文本（逐条场景；用于消息序列会放大取整误差）
export {
  estimateTokensMessages,
  estimateTokensText,
  type EstimableMessage,
} from '@/agent/contextManager.js';
export { type AgentForkResult } from '@/agent/managers/sessionManager.js';
export type { SessionManager } from '@/agent/managers/sessionManager.js';
export type {
  ToolDefinition,
  ToolHandler,
  ToolContext,
  WriteExtensions,
} from '@/agent/toolExecutor.js';
export type { IdempotencyLevel, ToolExecutionRecord } from '@/agent/types.js';
// 角色包（Role Pack）类型：文件夹形态（manifest.json 核心控制 + 独立内容文件）
export type {
  RolePack,
  RolePackMeta,
  RolePackAssembly,
  RolePackTeam,
  RolePackCapability,
  RolePackManifestSkill,
  BehaviorStrategy,
  PrepareStrategy,
  ActStrategy,
  ReflectStrategy,
  GlobalStrategy,
  UnderstandingConfirm,
  ToolReadonly,
  ProviderRouting,
  MultiStepReasoning,
  SelfReviewRounds,
  UserFollowup,
  ErrorHandling,
} from '@/role-pack/types.js';
export {
  DEFAULT_BEHAVIOR_STRATEGY,
  mergeStrategy,
  assembleRolePack,
} from '@/role-pack/strategyResolver.js';
export { BUILTIN_FALLBACK_PACK, MAX_TEAM_MEMBERS } from '@/role-pack/constants.js';
export { RolePackManager } from '@/role-pack/rolePackManager.js';
// 角色包格式校验器：manifest.json 唯一核心控制文件 + companion 内容红线检测
export {
  validateManifest,
  validateManifestText,
  checkCompanionContentRedline,
} from '@/role-pack/validator.js';
export type {
  RolePackValidationIssue,
  RolePackValidationResult,
  RolePackValidateInput,
  RolePackIssueSeverity,
} from '@/role-pack/validator.js';
export type {
  MemoryInspector,
  MemorySnapshot,
  WorkingMemorySnapshot,
  BootstrapSnapshot,
  ArchiveSnapshot,
  AgentSearchHit,
  AgentStats,
} from '@/agent/managers/memoryInspector.js';
export { MemoryGovernance } from '@/agent/managers/memoryGovernance.js';
export { WorkProjectionManager } from '@/agent/managers/workProjection.js';
export type { WorkProjectionEntry } from '@/agent/managers/workProjection.js';
// accumulateStream: 宿主可复用的 LLM 流式响应累积工具（用于生成标题、描述等短文本）
export { accumulateStream } from '@/agent/managers/streamAccumulator.js';
// agent.polish getter 返回值类型，消费者可独立标注变量类型
export type { PolishResult } from '@/agent/managers/textPolishManager.js';
// 记忆即摘要架构：轮次摘要生成器
export { RoundSummaryGenerator } from '@/agent/managers/roundSummaryGenerator.js';
export { loadConfig } from '@/config/loader.js';
export { createLlmProvider, createProviderFromConfig } from '@/llm/factory.js';
export type { ProviderConfig } from '@/llm/factory.js';
export type { LlmProvider, ChatOptions } from '@/llm/provider.js';
export type { LlmChunk, TaskType, ProviderRouter } from '@/llm/types.js';
export { OpenAICompatibleProvider } from '@/llm/openaiCompatible.js';
export type { OpenAICompatibleConfig } from '@/llm/openaiCompatible.js';
export type { Config } from '@/config/loader.js';
// 事件系统
export { TypedEventEmitter, AGENT_EVENTS } from '@/utils/eventEmitter.js';
export type { AgentEventMap, AgentEventName, AgentEventHandler } from '@/utils/eventEmitter.js';
// 会话标识格式契约（SSOT 单点）：date/session 双向转换唯一真理源，宿主导入后不再手写 slice/split
export { buildSessionId, splitSessionId } from '@/utils/time.js';

// ─── 可观测性导出 ────────────────────────────────────────
export type { ITracer, ISpan, AgentMetrics } from '@/agent/tracer.js';
export { NOOP_TRACER, TRACE_SPANS } from '@/agent/tracer.js';

// ─── 记忆层导出 ──────────────────────────────────────────
export { SOURCE_LABELS } from '@/memory/types.js';
// 冲突检测基于 supersededBy 判定，无需记忆关系图谱
export type { Memory, SummaryType } from '@/memory/types.js';
/**
 * 记忆解析器（宿主读档复用内核校验，避免宿主另写一份字段白名单）
 * 白名单构造：剥离未知字段（旧档 score 等），见 src/memory/types.ts
 */
export { parseMemory } from '@/memory/types.js';
export { escapeLike, validateSource } from '@/memory/sourceValidation.js';
export type { SourceValidationSeverity } from '@/memory/sourceValidation.js';
// 存储层抽象：宿主项目可实现 IMemoryStorage 接口注入 Agent
export type { IMemoryStorage } from '@/memory/storageInterface.js';
export { InMemoryStorage } from '@/memory/inMemoryStorage.js';

// ─── 网络搜索导出 ──────────────────────────────────────────
// IWebSearchProvider 接口：宿主项目可实现此接口注入自定义搜索引擎
export type { IWebSearchProvider, SearchResult, WebSearchOptions } from '@/web-search/types.js';
// FetchWebSearchProvider：默认搜索实现（零依赖开箱即用）；safeSearch：带超时保护的搜索包装（宿主可复用）
export { FetchWebSearchProvider } from '@/web-search/fetchWebSearchProvider.js';
// buildSearchEndpoints：按名字构建搜索端点降级链（宿主设置 memora.searchEngine 切换引擎用）
export {
  buildSearchEndpoints,
  type SearchEngineName,
} from '@/web-search/fetchWebSearchProvider.js';
export { safeSearch } from '@/web-search/webSearchProvider.js';

// ─── 网页抓取导出（搜索→抓取闭环第二段） ──────────────────────
// IFetchProvider 接口：宿主项目可实现此接口注入自定义抓取实现
export type { IFetchProvider, FetchedPage, FetchOptions } from '@/web-fetch/types.js';
// FetchWebFetchProvider：默认抓取实现（零依赖开箱即用）；safeFetch：带超时保护的抓取包装（宿主可复用）
export { FetchWebFetchProvider } from '@/web-fetch/fetchWebFetchProvider.js';
export { safeFetch } from '@/web-fetch/webFetchProvider.js';

// ─── 代码执行导出（通用计算底座） ────────────────────────────
// ICodeExecutionProvider 接口：宿主项目可实现此接口注入沙箱执行器（内核不内置执行器，保持零依赖）
export type {
  ICodeExecutionProvider,
  CodeExecutionResult,
  CodeExecutionOptions,
} from '@/code-exec/types.js';
// safeExecuteCode：带超时保护的执行包装（宿主可复用）
export { safeExecuteCode } from '@/code-exec/codeExecutionProvider.js';

// ─── 项目搜索导出（等价 IDE 全局搜索） ─────────────────────────
// IProjectSearchProvider 接口：宿主项目可实现此接口注入项目内搜索（VS Code 用 workspace.findFiles/findTextInFiles）
export type {
  IProjectSearchProvider,
  ProjectFileMatch,
  ProjectFileSearchOptions,
  ProjectTextMatch,
  ProjectTextSearchOptions,
} from '@/project-search/types.js';
// safeSearchProjectFiles/safeSearchProjectText：带超时保护的项目搜索包装（宿主可复用）
export {
  safeSearchProjectFiles,
  safeSearchProjectText,
} from '@/project-search/projectSearchProvider.js';
// SEARCH_PROJECT_TOOL：条件性工具定义（宿主注入 IProjectSearchProvider 后暴露给 LLM）
export { SEARCH_PROJECT_TOOL } from '@/agent/builtinTools.js';
// PROJECT_SEARCH_RESULT_MAX_LEN / IGNORED_DIR_NAMES：search_project 调用面与宿主实现方共享的单一真理源
// （宿主 projectSearchProvider import 对齐，避免结果上限 / 忽略目录数值漂移）
export { PROJECT_SEARCH_RESULT_MAX_LEN } from '@/agent/toolExecutor.js';
export { IGNORED_DIR_NAMES } from '@/agent/builtinToolHandlers.js';
// 项目注册表 + 锁文件管理：宿主可直接使用或通过 ProjectManager 间接委托
export { ProjectRegistry } from '@/memory/projectRegistry.js';
export type { ProjectEntry } from '@/memory/projectRegistry.js';
export { LockManager } from '@/memory/lockManager.js';
// 向量存储：宿主注入 EmbeddingService 创建 JsonVectorStore 启用语义搜索，或实现 IVectorStore 注入自定义向量库
export { JsonVectorStore } from '@/memory/vectorStore.js';
export type { IVectorStore, EmbeddingService } from '@/memory/vectorStore.js';
// Embedding Provider：OpenAI 兼容 /embeddings 端点实现（满足 EmbeddingService 接口）
export { EmbeddingProvider } from '@/llm/embedding.js';
export type { EmbeddingConfig, EmbeddingResult } from '@/llm/embedding.js';
export type { EmbeddingOptions } from '@/llm/embedding.js';
// 会话存储抽象：宿主项目可实现 ISessionStore 接口注入 Agent
export type { ISessionStore, SessionMessage, SessionMeta } from '@/memory/sessionStore.js';
// 会话显示名回退单一真理源（displayName→autoName），宿主从内核取，避免重复实现
export { getSessionDisplayName } from '@/memory/sessionStore.js';

// ─── 问答闭环（Round）存储导出 ─────────────────────────────
// Round 数据结构和存储接口
export type { Round, RoundMessage, RoundStatus, IRoundStore } from '@/memory/roundStore.js';
// 问答闭环内交互输入（TS-9：主动提问回答/补充输入的类型与归属语义）
export type { InteractiveInputKind } from '@/memory/roundStore.js';
// 过程事件（每轮 UI 状态重建真相源，v1.5 单文件内聚，见 process-event-log-replay-design）
export type {
  ProcessEvent,
  ProcessThinkingPhase,
  ProcessMetaPayload,
  ProcessMetricsPayload,
} from '@/memory/roundStore.js';
// Round 辅助函数
export {
  generateRoundId,
  generateMessageId,
  createPendingRound,
  completeRound,
} from '@/memory/roundStore.js';

// ─── 会话视图加载器导出 ─────────────────────────────────────
// SessionViewLoader：将 Round ID 列表展开为完整对话视图
// 注：flattenRoundsToMessages / truncateRoundsUpTo / countMessagesInRounds 为加载器内部实现，
// 宿主持有 InMemorySessionViewLoader 即获全部能力，无需直接 import 这三个内部工具（收回误暴露的公共面）。
export type {
  ISessionViewLoader,
  SessionView,
  SessionSummary,
} from '@/memory/sessionViewLoader.js';
// 内存版实现（用于测试和开发）
export { InMemorySessionViewLoader } from '@/memory/inMemorySessionViewLoader.js';

// ─── 会话管理器接口导出（单一分叉真理源见 MessageHistory.forkSession） ──
export type { ISessionManager } from '@/memory/sessionManager.js';
// 内存版实现（用于测试和开发）
export { InMemoryRoundStore } from '@/memory/inMemoryRoundStore.js';
export { InMemorySessionStore } from '@/memory/inMemorySessionStore.js';
// 会话占位标题单一真理源，避免宿主重复实现
export { defaultTitle as defaultSessionTitle } from '@/agent/managers/sessionNamer.js';
// 宿主可条件性控制 trace_summary 工具的可见性
export { TRACE_SUMMARY_TOOL } from '@/agent/builtinTools.js';
// 不中断工作模型类型（宿主 IPC 层类型声明用；增量事件类型已随 composer 剪枝移除）
export type { SessionCheckpoint, PauseMeta, StepOutcome, PlanStep } from '@/agent/types.js';
// MessageHistory.forkSession() 返回值（Agent.forkSession() 返回 AgentForkResult）
export type { ForkResult } from '@/agent/messageHistory.js';
// 注：extractKeywords 为 recall 模块内部的关键词提取工具（供 search_memories 召回使用），
// 宿主生产代码零直接消费，属纯内部实现，不再挂公共面（收回误暴露）。

// ─── 日志抽象 ────────────────────────────────────────────
export type { ILogger } from '@/logging/loggerInterface.js';
export { setLogger, logger } from '@/logging/logger.js';

// ─── 工具导出 ────────────────────────────────────────────
// 以下工具为宿主项目依赖（分词/类型守卫/Frontmatter/安全定时器）
export { segmentText, segmentLower } from '@/utils/segmenter.js';
export { isPlainObject } from '@/utils/objects.js';
export { parseFrontmatter, serializeFrontmatter } from '@/utils/frontmatter.js';
// 宿主主进程统一使用 safeSetTimeout/safeSetInterval 跟踪清理定时器
export {
  safeSetTimeout,
  safeSetInterval,
  clearSafeTimeout,
  clearSafeInterval,
} from '@/utils/safeTimer.js';
export type { SkillEntry } from '@/skill/types.js';

// ─── 安全层导出 ────────────────────────────────────────────
// 审计日志类型（SecurityGuard.onAudit 回调的 event 参数）
export type {
  AuditEvent,
  AuditListener,
  Permission,
  WriteDecision,
  WriteConfirmationInfo,
  WriteConfirmationRequest,
} from '@/security/pathGuard.js';

// ─── 错误类型导出 ────────────────────────────────────────
export { MemoraError, ToolErrorCode, isRetryableErrorCode } from '@/utils/errors.js';
// toError 独立导出：浏览器端可直接 import 而不引入 logging（pino）依赖
export { toError } from '@/utils/toError.js';
export type { ToolErrorCodeValue } from '@/utils/errors.js';

// ─── 通用工具导出 ────────────────────────────────────────
// 宿主主进程统一从 'memora' 导入通用工具，消除 shared/ 跨层副本（渲染进程因浏览器环境保留副本）
export {
  truncate,
  isValidConfigName,
  parseConfigId,
  MAX_CONFIG_NAME_LENGTH,
} from '@/utils/strings.js';
export { formatDateKey, todayDate } from '@/utils/time.js';
