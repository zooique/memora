/**
 * Memora — 通用 Agent 架构（纯逻辑库）
 *
 * Node.js 专用纯逻辑库（零 native 编译依赖，详见 ADR-002 §定位澄清）。
 * 宿主项目通过注入 IMemoryStorage 实现持久化。
 * CLI 由宿主项目提供（hosts/memora-sprite/）。
 *
 * 设计哲学：万物皆记忆（详见 architecture_philosophy_rules.md §1）
 * 决策追溯：详见 .trae/rules/decisions/ 下的 ADR
 *
 * ─── 类型依赖图 ────────────────────────────────────────────
 *
 * 各模块独立 types.ts，跨模块类型追踪可按以下依赖图定位：
 *
 *   agent/types.ts ─┬─→ llm/provider.ts (LlmProvider, ChatOptions)
 *                   ├─→ memory/vectorStore.ts (IVectorStore, EmbeddingService)
 *                   ├─→ memory/storageInterface.ts (IMemoryStorage)
 *                   ├─→ memory/relationStore.ts (IMemoryRelationStore)
 *                   ├─→ memory/sessionStore.ts (ISessionStore, SessionMessage)
 *                   ├─→ agent/tracer.ts (ITracer, ISpan, AgentMetrics)
 *                   └─→ memory/projectManager.ts (AgentProjectEntry)
 *
 *   memory/types.ts ──→ 纯类型定义（Memory, MemoryRelation, SOURCE_LABELS 等）
 *
 *   llm/types.ts ─────→ 纯类型定义（LlmChunk）
 *
 *   persona/types.ts ─→ 纯类型定义（Persona, PersonaMode）
 *
 *   skill/types.ts ───→ 纯类型定义（SkillEntry, SkillMatch）
 *
 *   eval/evalTypes.ts ─→ 纯类型定义（EvalScenario, EvalResult）
 *
 *   security/pathGuard.ts ─→ AuditEvent 等安全类型（与 agent/types.ts 解耦）
 *
 * 依赖方向（单向）：agent → memory → utils；agent → llm；agent → security
 * 内核不反向依赖宿主，所有宿主交互通过接口注入（ADR-002 §三层架构）
 */

// ─── 库导出：供宿主项目 import 接入 ──────────────────────
export { Agent } from '@/agent/agent.js';
// RecalledMemorySummary：recall chunk 载荷类型，宿主渲染召回记忆列表时需要
export type { AgentChunk, ThinkingPhase, UIMessages, ArchiveMode, RecalledMemorySummary, AgentOptions, AgentContext, AgentProjectEntry } from '@/agent/types.js';
export { AGENT_CONSTANTS, LOOP_CONSTANTS } from '@/agent/constants.js';
export { type AgentForkResult } from '@/agent/managers/sessionManager.js';
export type { ToolDefinition, ToolHandler, ToolContext, WriteExtensions } from '@/agent/toolExecutor.js';
export type { IdempotencyLevel, SideEffect, ToolExecutionRecord } from '@/agent/types.js';
export type { PersonaMode, Persona } from '@/persona/types.js';
// 类型从专职模块导出
export type { MemoryKeywords } from '@/agent/managers/insightExtractor.js';
// RelationBuilder 从 InsightExtractor 提取，封装 ADR-014 关系构建逻辑
export { RelationBuilder } from '@/agent/managers/relationBuilder.js';
export type { ConflictInfo } from '@/agent/managers/relationBuilder.js';
export type {
  MemorySnapshot,
  WorkingMemorySnapshot,
  BootstrapSnapshot,
  ArchiveSnapshot,
  AgentSearchHit,
  AgentStats,
  SuggestOptions,
  SuggestHit,
  SourceHealthStatus,
  SourceHealthEntry,
  SourceHealthReport,
} from '@/agent/managers/memoryInspector.js';
// L1 语义去重类型（SPLIT-3 闭环：来源从 MemoryInspector 迁移至 DedupManager）
export type {
  DedupPair,
  DedupVerdict,
  DedupVerdictSummary,
  DedupReport,
} from '@/agent/managers/dedupManager.js';
export type { ConfigSuggestion, ConfigSuggestionHandler } from '@/agent/managers/configManager.js';
export type { AutoConfigRefinerOptions } from '@/agent/managers/autoConfigRefiner.js';
// 会话内容归档器类型
export type { SessionArchiveResult } from '@/agent/managers/sessionArchiver.js';
// L2 时效性评估类型（MemoryDecayScheduler）
export type { TimelinessVerdict, TimelinessReport } from '@/agent/managers/memoryDecayScheduler.js';
// L3 冲突检测类型（MemoryAdvisor）
export type { ConflictVerdict, ConflictReport } from '@/agent/managers/memoryAdvisor.js';
// 记忆治理统一门面
export { MemoryGovernance } from '@/agent/managers/memoryGovernance.js';
// 作品投影管理器类型
export type { WorkProjectionEntry } from '@/agent/managers/workProjection.js';
// TextPolishManager：文本润色管理器类型（agent.polish getter 返回值，消费者可独立标注变量类型）
export type { PolishResult } from '@/agent/managers/textPolishManager.js';
export { loadConfig } from '@/config/loader.js';
export { createLlmProvider, createProviderFromConfig } from '@/llm/factory.js';
export type { ProviderConfig } from '@/llm/factory.js';
export type { LlmProvider, ChatOptions } from '@/llm/provider.js';
export type { LlmChunk } from '@/llm/types.js';
export { OpenAICompatibleProvider } from '@/llm/openaiCompatible.js';
export type { OpenAICompatibleConfig } from '@/llm/openaiCompatible.js';
export type { Config } from '@/config/loader.js';
// 事件系统
export { TypedEventEmitter, AGENT_EVENTS } from '@/utils/eventEmitter.js';
export type { AgentEventMap, AgentEventName, AgentEventHandler } from '@/utils/eventEmitter.js';

// ─── 可观测性导出 ────────────────────────────────────────
export type { ITracer, ISpan, AgentMetrics } from '@/agent/tracer.js';
export { NOOP_TRACER, TRACE_SPANS } from '@/agent/tracer.js';

// ─── 记忆层导出 ──────────────────────────────────────────
export { SOURCE_LABELS } from '@/memory/types.js';
export type { Memory } from '@/memory/types.js';
// Source 校验工具（从 types.ts 拆分到 sourceValidation.ts，公共 API 不变）
export { inferSource, escapeLike, validateSource } from '@/memory/sourceValidation.js';
export type { SourceValidationSeverity } from '@/memory/sourceValidation.js';
// 记忆关系图谱（ADR-014 侧车模型）
export { RELATION_TYPES, RELATION_WEIGHTS } from '@/memory/types.js';
export type { MemoryRelation, RelationDirection, RelationPath, RelationNeighbor } from '@/memory/types.js';
// 存储层抽象：宿主项目可实现 IMemoryStorage 接口注入 Agent
export type { IMemoryStorage } from '@/memory/storageInterface.js';
export { InMemoryStorage } from '@/memory/inMemoryStorage.js';
// 治理共享常量（MIND2-L3：宿主 SqliteStorage incrementScore/setScore 实现需要 clamp 边界）
// 衰减常量同步导出：宿主 SqliteStorage.decayScores 与核心库 recall.ts 共用同一真理源（v2 神木回天 REPEAT-3 闭环）
export { BOOST_INCREMENT, SCORE_CEILING, DECAY_FLOOR, DECAY_AGE_DAYS, DECAY_AMOUNT } from '@/memory/governance.js';

// ─── 网络搜索导出 ──────────────────────────────────────────
// IWebSearchProvider 接口：宿主项目可实现此接口注入自定义搜索引擎
export type { IWebSearchProvider, SearchResult, WebSearchOptions } from '@/web-search/types.js';
// FetchWebSearchProvider：基于 DuckDuckGo 的默认搜索实现（零依赖，开箱即用）
export { FetchWebSearchProvider } from '@/web-search/fetchWebSearchProvider.js';
// safeSearch：带超时保护的搜索包装函数（宿主自定义实现也可复用此包装）
export { safeSearch } from '@/web-search/webSearchProvider.js';
// 记忆关系存储侧车：宿主项目可实现 IMemoryRelationStore 接口注入 Agent
export type { IMemoryRelationStore } from '@/memory/relationStore.js';
export { InMemoryRelationStore } from '@/memory/inMemoryRelationStore.js';
// 项目注册表 + 锁文件管理（从 ProjectManager 提取）
// 宿主可直接使用 ProjectRegistry/LockManager 管理多项目，或通过 ProjectManager 间接委托
export { ProjectRegistry } from '@/memory/projectRegistry.js';
export type { ProjectEntry } from '@/memory/projectRegistry.js';
export { LockManager } from '@/memory/lockManager.js';
// 用户画像：宿主通过 agent.userProfile 访问，用于确认/拒绝待确认条目
export type { UserProfileEntry, ProfileCategory, ExtractedFact } from '@/memory/userProfile.js';
// 向量存储：宿主注入 EmbeddingService 后创建 JsonVectorStore，传入 AgentOptions 启用语义搜索
// 宿主也可实现 IVectorStore 接口注入自定义向量库（如 SqliteVectorStore / LanceDBVectorStore）
export { JsonVectorStore } from '@/memory/vectorStore.js';
export type { IVectorStore, EmbeddingService } from '@/memory/vectorStore.js';
// Embedding Provider：OpenAI 兼容 /embeddings 端点实现（满足 EmbeddingService 接口）
export { EmbeddingProvider } from '@/llm/embedding.js';
export type { EmbeddingConfig, EmbeddingResult } from '@/llm/embedding.js';
// EmbeddingOptions 归属 llm/（提供者层），符合分层架构依赖方向
export type { EmbeddingOptions } from '@/llm/embedding.js';
// 会话存储抽象：宿主项目可实现 ISessionStore 接口注入 Agent
export type { ISessionStore, SessionMessage } from '@/memory/sessionStore.js';
// 不中断工作模型：检查点类型和增量事件类型（宿主 IPC 层需要用于类型声明）
export type { SessionCheckpoint, SessionEvent, DeltaPayload, SlotRef, ClarifyQuestion, PauseMeta, RoundOutcome, PlanStep } from '@/agent/types.js';
// 消息历史内部类型：MessageHistory.forkSession() 返回值（Agent.forkSession() 返回 AgentForkResult）
export type { ForkResult } from '@/agent/messageHistory.js';
// 召回函数：简化关键词搜索
export { recall, extractKeywords } from '@/memory/recall.js';
export type { RecallOptions } from '@/memory/recall.js';

// ─── 日志抽象 ────────────────────────────────────────────
export type { ILogger } from '@/logging/loggerInterface.js';
export { setLogger, logger } from '@/logging/logger.js';

// ─── 工具导出 ────────────────────────────────────────────
// 分词工具：宿主项目（如 SqliteStorage）依赖
export { segmentText, segmentLower } from '@/utils/segmenter.js';
// 对象类型守卫：宿主项目（如 spriteConfig）依赖，校验 JSON.parse 结果
export { isPlainObject } from '@/utils/objects.js';
// Frontmatter 解析/序列化：宿主项目（如 skillInstaller）依赖
export { parseFrontmatter, serializeFrontmatter } from '@/utils/frontmatter.js';
// 安全定时器：宿主主进程统一使用 safeSetTimeout/safeSetInterval 跟踪清理
export { safeSetTimeout, safeSetInterval, clearSafeTimeout, clearSafeInterval } from '@/utils/safeTimer.js';
export type { SkillEntry, SkillMatch } from '@/skill/types.js';

// ─── 安全层导出 ────────────────────────────────────────────
// M2：审计日志类型（SecurityGuard.onAudit 回调的 event 参数）
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
// toError 独立导出，浏览器端可直接 import 而不引入 logging（pino）依赖
export { toError } from '@/utils/toError.js';
export type { ToolErrorCodeValue } from '@/utils/errors.js';

// ─── 通用工具导出 ────────────────────────────────────────
// 宿主主进程统一从 'memora' 导入，消除 shared/ 跨层副本（渲染进程因浏览器环境保留副本）
export { truncate } from '@/utils/strings.js';
export { formatDateKey, todayDate } from '@/utils/time.js';

// ─── 评估框架导出（Mock Eval：Agent 行为回归测试，不调用真实 LLM） ───
// 设计定位：主要供 CI 回归测试使用（MSW Mock LLM），运行时零消费者。
// 保留导出供外部宿主项目编写自己的 eval 场景；非运行时 API，不应在业务代码中 import。
export type { EvalScenario, EvalExpectation, EvalResult } from '@/eval/evalTypes.js';
export { collectAgentChunks, evaluateResult } from '@/eval/evalTypes.js';
export { EVAL_SCENARIOS } from '@/eval/scenarios.js';
export { EvalRunner } from '@/eval/evalRunner.js';
export type { EvalRunnerOptions, EvalSummary } from '@/eval/evalRunner.js';
