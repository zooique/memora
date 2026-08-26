/**
 * 记忆类型定义 — 基元驱动模型：万物皆是记忆，用 source 开放字符串替代封闭枚举
 */

import { configError } from '@/utils/errors.js';

// ─── 共享类型：消息角色（SSOT 单一真理源） ──────────────

/**
 * 消息角色：统一 agent/types.ts 的 ChatMessage 与 sessionStore.ts 的 SessionMessage
 * 含 tool 角色，用于 LLM 工具调用消息的持久化
 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

// ─── 基元定义 ─────────────────────────────────────────────

/**
 * 记忆基元接口：id/content/source/name/createdAt/accessedAt/score 7 个基础字段
 * + deletedAt 可选（软删除）
 */
export interface Memory {
  /** 唯一标识，格式 source:name，如 'rule:core'、'round-summary:session:r1' */
  id: string;
  /** 记忆内容（Markdown 文本） */
  content: string;
  /** 来源标签（开放字符串，非枚举） */
  source: string;
  /** 可读名称（文件名或摘要标题） */
  name: string;
  /** 创建时间（ISO 8601） */
  createdAt: string;
  /** 最后访问时间（每次召回时刷新） */
  accessedAt: string;
  /** 权重（0-1，召回时用于排序） */
  score: number;
  /** 软删除时间；非 undefined 表示已删除，回收站保留 30 天后物理清理 */
  deletedAt?: string;
  /** 写配置文件时的 frontmatter 额外元数据；SQLite index 不存储此字段 */
  metadata?: Record<string, string>;
  /** 是否可经 sessionId（+ roundId）回溯到原始对话；round-summary 有意义，其余默认 false */
  isTraceable?: boolean;
  /** 摘要是否已被人工修改，可能与原始对话不一致；仅 round-summary 有意义 */
  isModified?: boolean;
  /**
   * 写路径取代标记：非 undefined 表示已被更新的摘要覆盖，召回时确定性过滤；
   * 值为取代它的新摘要 id，本条保留以便 traceSummary 回溯。设计为顶层持久化字段而非
   * metadata（宿主不持久化 metadata，而 superseded 须跨会话生效）
   */
  supersededBy?: string;
}

/** parseMemory 未提供 score 时的默认权重 */
export const DEFAULT_MEMORY_SCORE = 0.5;

/**
 * round-summary 记忆的摘要类型，摘要生成时由 LLM 自动判断，无独立分类器
 */
export type SummaryType = 'preference' | 'fact' | 'decision' | 'intent' | 'general';

/**
 * 记忆解析器 — 验证原始数据并转换为 Memory
 * 校验：非空对象、字段类型、ISO 8601 日期、score 0-1、默认值填充（score=0.5）
 *
 * @param raw - 原始数据（通常来自 JSON 解析或数据库查询）
 * @returns 验证通过的 Memory 对象
 * @throws Error 当数据不符合 Memory 接口定义时
 */
export function parseMemory(raw: unknown): Memory {
  if (raw === null || typeof raw !== 'object') {
    throw configError(
      'Memory 解析失败',
      '输入必须是非空对象',
      ['检查数据源（JSON 文件 / 数据库查询）是否返回了有效对象'],
    );
  }

  const obj = raw as Record<string, unknown>;

  // 验证必需的 string 字段
  const stringFields = ['id', 'content', 'source', 'name'] as const;
  for (const field of stringFields) {
    if (typeof obj[field] !== 'string') {
      throw configError(
        'Memory 解析失败',
        `${field} 必须是字符串`,
        [`检查数据源中 ${field} 字段的类型（当前为 ${typeof obj[field]}）`],
      );
    }
  }

  // 验证 ISO 8601 日期字段
  const dateFields = ['createdAt', 'accessedAt'] as const;
  for (const field of dateFields) {
    if (typeof obj[field] !== 'string' || isNaN(Date.parse(obj[field] as string))) {
      throw configError(
        'Memory 解析失败',
        `${field} 必须是有效的 ISO 8601 日期字符串`,
        [`检查数据源中 ${field} 字段的格式（当前值: ${JSON.stringify(obj[field])}）`],
      );
    }
  }

  // 验证 score 字段（可选，有默认值）；Number.isFinite 排除 NaN/Infinity（对齐 zod z.number()）
  if (obj.score !== undefined && obj.score !== null) {
    if (typeof obj.score !== 'number' || !Number.isFinite(obj.score) || obj.score < 0 || obj.score > 1) {
      throw configError(
        'Memory 解析失败',
        `score 必须是 0-1 之间的数字（当前值: ${String(obj.score)}）`,
        ['将 score 调整为 0-1 之间的有效数字'],
      );
    }
  }

  // 验证可选的 deletedAt 字段
  if (obj.deletedAt !== undefined && obj.deletedAt !== null) {
    if (typeof obj.deletedAt !== 'string' || isNaN(Date.parse(obj.deletedAt as string))) {
      throw configError(
        'Memory 解析失败',
        `deletedAt 必须是有效的 ISO 8601 日期字符串（当前值: ${JSON.stringify(obj.deletedAt)}）`,
        ['检查数据源中 deletedAt 字段的格式'],
      );
    }
  }

  return {
    id: obj.id as string,
    content: obj.content as string,
    source: obj.source as string,
    name: obj.name as string,
    createdAt: obj.createdAt as string,
    accessedAt: obj.accessedAt as string,
    score: (obj.score as number) ?? DEFAULT_MEMORY_SCORE,
    deletedAt: obj.deletedAt as string | undefined,
    isTraceable: obj.isTraceable as boolean | undefined,
    isModified: obj.isModified as boolean | undefined,
    supersededBy: obj.supersededBy as string | undefined,
  };
}

// ─── source 标签约定（非枚举，仅为当前使用的约定） ──────

/**
 * 当前使用的 source 标签约定；source 是开放字符串，新增来源无需改代码，存储时指定即可
 *
 * 设计演进（2026-08-26 对齐 ADR-025 + 架构收敛）：
 *   - persona / rule / skill 已归角色包管理，不写入记忆库
 *   - work-projection 已移出记忆库（2026-08-20，落项目目录 projections/）
 *   - 这些标签仍保留在 SOURCE_LABELS 中，用于：
 *     1. 文件路径解析（sourcePaths.ts：从 source 标签映射到目录名）
 *     2. 文件路径推断（sourceValidation.ts：从文件路径推断 source 标签）
 *     3. typo 检测（sourceValidation.ts：KNOWN_SOURCES 集合）
 *   - 它们不再出现在 GOVERNANCE_SOURCES 中（治理系统只治理实际写入记忆库的 source）
 */
export const SOURCE_LABELS = {
  /** 角色人格（角色包 content/persona.md）— 文件路径解析用，不写入记忆库 */
  PERSONA: 'persona',
  /** 创作规则（角色包 content/rules.md + .memora/rules/*.md）— 文件路径解析用，不写入记忆库 */
  RULE: 'rule',
  /** 技能定义（角色包 skills/ 目录）— 文件路径解析用，不写入记忆库 */
  SKILL: 'skill',
  /** 作品投影（读取用户作品时生成的概要）— 已移出记忆库（2026-08-20），文件路径解析用 */
  WORK_PROJECTION: 'work-projection',
  /** 轮次摘要（每轮对话后生成的溯源式摘要，记忆即摘要） */
  ROUND_SUMMARY: 'round-summary',
  /** 未知来源（inferSource 兜底值） */
  UNKNOWN: 'unknown',
} as const;