/**
 * 记忆类型定义
 *
 * 5 种记忆类型 + 4 个永久性等级
 * 详见 ADR-004 · 记忆统一为"类型 + 永久性标记"模型
 */
import { z } from 'zod';

// 记忆类型枚举
export const MemoryType = {
  PERSONALITY: 'personality', // 人格（personality.md）
  RULE: 'rule', // 规则（rules/*.md）
  SKILL: 'skill', // 技能（skills/*.md）
  TOOL: 'tool', // 工具定义（tools/*.json）
  TOPIC: 'topic', // 话题（topics/*.md）
  ARCHIVE: 'archive', // 归档（archive/*.md）
  WORK_PROJECTION: 'work-projection', // 作品投影（助手对用户文件的记忆）
} as const;

export type MemoryTypeValue = (typeof MemoryType)[keyof typeof MemoryType];

/**
 * 类型到目录的映射（供 FileStore 和 init.ts 共用）
 *
 * 集中定义避免多处复制粘贴。值代表目录名（如 rules/、personality/）。
 */
export const TYPE_TO_DIR_MAP: Record<MemoryTypeValue, string> = {
  personality: 'personality',
  rule: 'rules',
  skill: 'skills',
  tool: 'tools',
  topic: 'topics',
  archive: 'archive',
  'work-projection': 'work-projection',
};

/**
 * 永久性等级
 */
export const Permanence = {
  ALWAYS: 'always', // 100% 必召（如人格、安全规则）
  DOMAIN: 'domain', // 领域相关（启动时加载）
  TOPIC: 'topic', // 话题相关（按需召回）
  ON_DEMAND: 'on-demand', // 显式调用（如工具定义）
} as const;

export type PermanenceValue = (typeof Permanence)[keyof typeof Permanence];

// 记忆基础 schema
export const MemorySchema = z.object({
  id: z.string(),
  type: z.enum([
    MemoryType.PERSONALITY,
    MemoryType.RULE,
    MemoryType.SKILL,
    MemoryType.TOOL,
    MemoryType.TOPIC,
    MemoryType.ARCHIVE,
    MemoryType.WORK_PROJECTION,
  ]),
  permanence: z.enum([
    Permanence.ALWAYS,
    Permanence.DOMAIN,
    Permanence.TOPIC,
    Permanence.ON_DEMAND,
  ]),
  name: z.string(),
  content: z.string(),
  // 元数据
  tags: z.array(z.string()).default([]),
  weight: z.number().min(0).max(1).default(0.5),
  // 时间戳
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  // 文件路径（如果有）
  filePath: z.string().optional(),
});

export type Memory = z.infer<typeof MemorySchema>;

// 话题文件单条消息结构
export const TopicMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.string(),
  timestamp: z.string(), // ISO 8601
});
export type TopicMessage = z.infer<typeof TopicMessageSchema>;

// 话题文件特殊结构（在 topic 类型记忆的基础上）
export interface TopicFile {
  date: string; // YYYY-MM-DD
  topic: string; // 话题名
  messages: TopicMessage[];
  summary?: string; // 冥想后炼化出的话题报告
  keywords: string[]; // 用于 FTS5 检索
  /** v4.0：对话快照种子（切话题时提取的 3-5 句用户原文） */
  seedSnapshots?: string[];
}

/**
 * Embedding 服务接口 — memory/ 层对 embedding 能力的抽象
 *
 * 分层修复（年轮审判 R-03）：memory/ 不应直接依赖 llm/ 层。
 * 此接口定义 VectorStore 需要的 embedding 能力，
 * 具体实现（EmbeddingProvider）由 llm/ 层提供，通过依赖注入传入。
 * TypeScript 结构化类型系统保证 EmbeddingProvider 自动满足此接口。
 */
export interface EmbeddingService {
  /** 嵌入单条文本，返回向量 */
  embed(text: string): Promise<number[]>;
  /** 批量嵌入多条文本 */
  batchEmbed(texts: string[]): Promise<Array<{ text: string; vector: number[] }>>;
}
