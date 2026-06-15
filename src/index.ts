/**
 * Memora — 通用 Agent 架构（纯逻辑库）
 *
 * 零 native 依赖。宿主项目通过注入 IMemoryStorage 实现持久化。
 * CLI 由宿主项目提供（hosts/memora-cli/）。
 *
 * 设计哲学：万物皆记忆（详见 docs/基础设计文档/01-主架构-v4.0.md §1.2）
 * 决策追溯：详见 .trae/rules/decisions/ 下的 ADR
 */

// ─── 库导出：供宿主项目 import 接入 ──────────────────────
export { Agent } from './agent/agent.js';
export type { AgentChunk, ThinkingPhase } from './agent/types.js';
export type {
  AgentOptions,
  AgentContext,
  AgentBuildCtx,
} from './agent/agent.js';
export type { ToolDefinition, ToolHandler, WriteExtensions } from './agent/toolExecutor.js';
export type { PersonaMode, Persona } from './persona/types.js';
// 类型从专职模块导出
export type { MemoryKeywords } from './agent/insightExtractor.js';
export type {
  MemorySnapshot,
  WorkingMemorySnapshot,
  BootstrapSnapshot,
  ArchiveSnapshot,
  AgentSearchHit,
  AgentStats,
} from './agent/memoryInspector.js';
export type { ConfigSuggestion, ConfigSuggestionHandler } from './agent/configManager.js';
export { loadConfig } from './config/loader.js';
export { createLlmProvider, createProviderFromConfig } from './llm/factory.js';
export type { ProviderConfig } from './llm/factory.js';
export type { LlmProvider } from './llm/provider.js';
export type { Config } from './config/loader.js';
// 事件系统
export type { AgentEventMap, AgentEventName, AgentEventHandler } from './utils/eventEmitter.js';

// ─── 可观测性导出 ────────────────────────────────────────
export type { ITracer, ISpan } from './agent/tracer.js';
export { noopTracer, TRACE_SPANS } from './agent/tracer.js';

// ─── 记忆层导出 ──────────────────────────────────────────
export { SOURCE_LABELS, inferSource, escapeLike, validateSource } from './memory/types.js';
export type { Memory } from './memory/types.js';
// 存储层抽象：宿主项目可实现 IMemoryStorage 接口注入 Agent
export type { IMemoryStorage } from './memory/storageInterface.js';
export { InMemoryStorage } from './memory/inMemoryStorage.js';
// 向量存储：宿主注入 EmbeddingService 后创建 VectorStore，传入 AgentOptions 启用语义搜索
export { VectorStore } from './memory/vectorStore.js';
export type { EmbeddingService } from './memory/vectorStore.js';
// 会话存储抽象：宿主项目可实现 ISessionStore 接口注入 Agent
export type { ISessionStore, SessionMessage } from './memory/sessionStore.js';
// 消息历史类型：loadSessionMessages() 返回值
export type { ForkResult } from './agent/messageHistory.js';
// 召回函数：简化关键词搜索
export { recall, extractKeywords, decayScores } from './memory/recall.js';
export type { RecallOptions } from './memory/recall.js';

// ─── 日志抽象 ────────────────────────────────────────────
export type { ILogger } from './logging/loggerInterface.js';
export { setLogger, logger } from './logging/logger.js';

// ─── 工具导出 ────────────────────────────────────────────
// 分词工具：宿主项目（如 SqliteStorage）依赖
// 工具导出
export { segmentText, tokenizeKeywords } from './utils/segmenter.js';
export type { SkillEntry, SkillMatch } from './skill/types.js';

// ─── 错误类型导出 ────────────────────────────────────────
export { MemoraError, ToolErrorCode, isRetryableErrorCode } from './utils/errors.js';
export type { ToolErrorCodeValue } from './utils/errors.js';
