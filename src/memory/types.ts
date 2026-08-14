/**
 * 记忆类型定义 — 基元驱动模型
 *
 * 设计哲学：万物皆是记忆，用 source 开放字符串替代封闭枚举
 * 详见 ADR-004 · 记忆统一模型
 */

import { configError } from '@/utils/errors.js';

// ─── 共享类型：消息角色（SSOT 单一真理源） ──────────────

/**
 * 消息角色
 *
 * 统一 ChatMessage（agent/types.ts）和 SessionMessage（sessionStore.ts）的角色定义。
 * 包含 tool 角色，用于 LLM 工具调用消息的持久化。
 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

// ─── 基元定义 ─────────────────────────────────────────────

/**
 * 记忆基元接口
 *
 * 8 个核心字段（v2.1 软删除扩展），无封闭枚举
 * - 7 个基础字段：id/content/source/name/createdAt/accessedAt/score
 * - 1 个可选字段：deletedAt（软删除时间，undefined 表示活跃记忆）
 */
export interface Memory {
  /** 唯一标识（source:name，如 'rule:core'、'round-summary:session:r1'） */
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
  /** 软删除时间（ISO 8601，可选；非 undefined 表示已软删除，回收站保留 30 天后自动物理清理） */
  deletedAt?: string;
  /**
   * 可选：配置文件 frontmatter 的额外元数据
   *
   * 仅在写入配置文件时使用（FileStore.write 合并到 frontmatter）。
   * SQLite index 不存储此字段（运行时检索不需要）。
   * 典型场景：persona 的 keywords/description，供 PersonaManager 加载时解析。
   */
  metadata?: Record<string, string>;
  /**
   * 可选：记忆是否可溯源到原始对话记录
   *
   * 为 true 时，可通过 sessionId + roundId 回溯到原始对话。
   * 为 false 时，表示原始对话已删除，无法追溯。
   * 仅对 `source='round-summary'` 的记忆有意义，其他来源记忆默认为 false。
   */
  isTraceable?: boolean;
  /**
   * 可选：摘要是否被手动修改
   *
   * 为 true 时，表示摘要内容已被人工修改，可能与原始对话不完全一致。
   * 仅对 `source='round-summary'` 的记忆有意义。
   * isTraceable 独立于此字段——修改摘要不代表原始对话不存在。
   */
  isModified?: boolean;
  /**
   * 可选：写路径取代检测（ADR-021）——是否有新摘要取代了本条
   *
   * 非 undefined 时表示本条摘要已被更新的决策/事实覆盖，不再作为当前事实注入召回
   * （召回时确定性过滤）。值为取代它的新摘要 id（`round-summary:...`），本条保留以便
   * `traceSummary` 回溯历史。仅对 `source='round-summary'` 的记忆有意义。
   *
   * 设计为**顶层持久化字段**而非 metadata：宿主 SqliteStorage 不持久化 metadata，
   * 而 superseded 标记必须跨会话生效（"写时定、读时过滤"的持久语义）。
   */
  supersededBy?: string;
}

/** 默认记忆权重（parseMemory 的默认值行为） */
export const DEFAULT_MEMORY_SCORE = 0.5;

/**
 * 轮次摘要类型
 *
 * 用于标记 `source='round-summary'` 记忆的摘要类型。
 * 在摘要生成时由 LLM 自动判断，不引入独立分类器。
 * 聚合记忆已取消（统一为单一摘要记忆），故无 aggregated 类型。
 */
export type SummaryType = 'preference' | 'fact' | 'decision' | 'intent' | 'general';

/**
 * 记忆解析器 — 验证原始数据并转换为 Memory 类型
 *
 * 提供与原 MemorySchema.parse() 等效的运行时验证能力：
 * - 非空对象检查
 * - 字段类型验证（string/number）
 * - ISO 8601 日期格式验证
 * - score 范围检查（0-1）
 * - 默认值填充（score = 0.5）
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

  // 验证 score 字段（可选，有默认值）
  // Number.isFinite 同时排除 NaN/Infinity（对齐 zod z.number() 行为）
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

/**
 * 兼容性别名 — 保持原有测试代码 (MemorySchema.parse(...)) 无需修改
 */
export const MemorySchema = { parse: parseMemory };

// ─── source 标签约定（非枚举，仅为泊文当前使用的约定） ──────

/**
 * 泊文当前使用的 source 标签约定
 *
 * 注意：source 是开放字符串，新增来源无需改代码
 * 只需在存储时指定 source 字符串即可
 */
export const SOURCE_LABELS = {
  /** 角色人格（agent-config/personas/*.md） */
  PERSONA: 'persona',
  /** 创作规则（agent-config/rules/*.md + .memora/rules/*.md） */
  RULE: 'rule',
  /** 技能定义（agent-config/skills/*.md） */
  SKILL: 'skill',
  /** 用户画像（存量数据兼容，画像层已于 2026-08-14 收敛移除，不再有新写入） */
  PROFILE: 'profile',
  /** 作品投影（Agent 读取用户作品时生成的概要） */
  WORK_PROJECTION: 'work-projection',
  /** 内容护栏规则（configDir/rules/guardrails/ 下的规则文件） */
  GUARDRAIL: 'guardrail',
  /** 轮次摘要（每轮对话后生成的溯源式摘要，记忆即摘要） */
  ROUND_SUMMARY: 'round-summary',
  /** 未知来源（inferSource 兜底值，文件路径未匹配已知目录时的默认标签） */
  UNKNOWN: 'unknown',
} as const;

// ─── Source 校验（运行时函数已迁移到 sourceValidation.ts） ──
// inferSource / escapeLike / validateSource / levenshtein → src/memory/sourceValidation.ts
// STOPWORDS → src/utils/segmenter.ts（停用词是分词关注点）
// SourceValidationSeverity 类型 → src/memory/sourceValidation.ts

// ─── 记忆关系图谱已收敛移除（2026-08-14） ─────────────────
// ADR-014 侧车模型判定为过度设计（W5-网络图谱收敛），已整体移除：
// - 独立侧车存储（IMemoryRelationStore / InMemoryRelationStore）
// - 复杂关系类型（contradicts/supports/follows/refines/caused/related）
// - 冲突检测改用 supersededBy 布尔标记（ADR-021 写路径取代检测）
// 残留源：SOURCE_LABELS.PROFILE（用户画像层）仍保留（存量数据兼容，供 GOVERNANCE 治理与计数），
// 但不再有新写入——记忆收敛为 round-summary 单轨。
