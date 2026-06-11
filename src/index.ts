/**
 * Memora — 通用 Agent 架构（纯逻辑库）
 *
 * 零 native 依赖。宿主项目通过注入 IMemoryStorage 实现持久化。
 * CLI 由宿主项目提供（hosts/memora-cli/）。
 *
 * 设计哲学：万物皆记忆（详见 docs/基础设计文档/01-主架构-v4.0.md §1.2）
 * 决策追溯：详见 .trae/rules/decisions/ 下的 ADR
 *
 * 重构变更（2026-06-11）：
 * - 移除 MemoryType/Permanence 枚举导出 → 新增 SOURCE_LABELS 常量
 * - 移除 MemoryTypeValue/PermanenceValue 类型导出
 * - 移除 ArchiveMode/ArchiveSnapshot 导出
 * - 新增 recall/extractKeywords 导出
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
} from './agent/agent.js';
export type { ToolDefinition, ToolHandler, WriteExtensions } from './agent/tool-executor.js';
export type { PersonaMode } from './persona/personaManager.js';
export type { ConfigSuggestion, ConfigSuggestionHandler } from './agent/agent.js';
export { loadConfig } from './config/loader.js';
export { createLlmProvider, createProviderFromConfig } from './llm/factory.js';
export type { ProviderConfig } from './llm/factory.js';
export type { LlmProvider } from './llm/provider.js';
export type { Config } from './config/loader.js';

// ─── 记忆层导出 ──────────────────────────────────────────
export { SOURCE_LABELS, inferSource, escapeLike } from './memory/types.js';
export type { Memory } from './memory/types.js';
// 存储层抽象：宿主项目可实现 IMemoryStorage 接口注入 Agent
export type { IMemoryStorage } from './memory/storage-interface.js';
export { InMemoryStorage } from './memory/in-memory-storage.js';
// 召回函数：简化关键词搜索
export { recall, extractKeywords } from './memory/recall.js';
export type { RecallOptions } from './memory/recall.js';

// ─── 日志抽象 ────────────────────────────────────────────
export type { ILogger } from './logging/logger-interface.js';
export { setLogger, logger } from './logging/logger.js';

// ─── 工具导出 ────────────────────────────────────────────
// 分词工具：宿主项目（如 SqliteStorage）依赖
export { segmentText } from './memory/segmenter.js';
export type { SkillEntry } from './skill/skillManager.js';
