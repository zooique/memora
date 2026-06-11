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
  MemorySnapshot,
  WorkingMemorySnapshot,
  BootstrapSnapshot,
  ArchiveSnapshot,
  MountedSnapshot,
  ArchiveMode,
} from './agent/agent.js';
export type { ToolDefinition, ToolHandler, WriteExtensions } from './agent/tool-executor.js';
export type { PersonaMode } from './persona/personaManager.js';
export type { ConfigSuggestion, ConfigSuggestionHandler } from './agent/agent.js';
export { loadConfig } from './config/loader.js';
export { createLlmProvider, createProviderFromConfig } from './llm/factory.js';
export type { ProviderConfig } from './llm/factory.js';
export type { LlmProvider } from './llm/provider.js';
export type { Config } from './config/loader.js';
export { MemoryType, Permanence } from './memory/types.js';
export type { Memory, MemoryTypeValue, PermanenceValue } from './memory/types.js';
// 存储层抽象：宿主项目可实现 IMemoryStorage 接口注入 Agent
export type { IMemoryStorage } from './memory/storage-interface.js';
export { InMemoryStorage } from './memory/in-memory-storage.js';
// 日志抽象：宿主项目可注入自定义 ILogger 实现
export type { ILogger } from './logging/logger-interface.js';
export { setLogger, logger } from './logging/logger.js';
// 分词工具：宿主项目（如 SqliteStorage）依赖
export { segmentText } from './memory/segmenter.js';
export type { SkillEntry } from './skill/skillManager.js';
