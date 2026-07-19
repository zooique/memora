/**
 * 记忆类型定义 — 基元驱动模型
 *
 * 设计哲学：万物皆是记忆，用 source 开放字符串替代封闭枚举
 * 详见 ADR-004 · 记忆统一模型
 */

import { configError } from '@/utils/errors.js';

// ─── 基元定义 ─────────────────────────────────────────────

/**
 * 记忆基元接口
 *
 * 8 个核心字段（v2.1 软删除扩展），无封闭枚举
 * - 7 个基础字段：id/content/source/name/createdAt/accessedAt/score
 * - 1 个可选字段：deletedAt（软删除时间，undefined 表示活跃记忆）
 */
export interface Memory {
  /** 唯一标识（source:name，如 'rule:core'、'insight:1718083200000'） */
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
}

/** 默认记忆权重（parseMemory 的默认值行为） */
export const DEFAULT_MEMORY_SCORE = 0.5;

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
  /** 对话洞察（每轮问答结束后 LLM 提取） */
  INSIGHT: 'insight',
  /** 用户画像（每轮问答中 LLM 实时提取） */
  PROFILE: 'profile',
  /** 作品投影（Agent 读取用户作品时生成的概要） */
  WORK_PROJECTION: 'work-projection',
  /** 内容护栏规则（configDir/rules/guardrails/ 下的规则文件） */
  GUARDRAIL: 'guardrail',
} as const;

// ─── Source 校验（运行时函数已迁移到 sourceValidation.ts） ──
// inferSource / escapeLike / validateSource / levenshtein → src/memory/sourceValidation.ts
// STOPWORDS → src/utils/segmenter.ts（停用词是分词关注点）
// SourceValidationSeverity 类型 → src/memory/sourceValidation.ts

// ─── 记忆关系图谱（ADR-014 侧车模型） ─────────────────────

/**
 * 记忆关系基元 — 独立于 Memory 7 字段的侧车数据结构
 *
 * 设计原则（ADR-014）：
 * - 不侵入 Memory 类型，与 Memory 平行存在
 * - 关系类型是开放字符串（非枚举），宿主可自由扩展
 * - 存储有向（sourceId → targetId），查询时按 direction 参数过滤
 *
 * 预设关系类型建议值（非强制）：
 * - 'contradicts'：矛盾（双向对称）
 * - 'supports'：支持（有向）
 * - 'follows'：时间先后（有向）
 * - 'refines'：细化/演化（有向）
 * - 'caused'：因果（有向）
 * - 'related'：泛相关（双向对称）
 */
export interface MemoryRelation {
  /** 关系起点（Memory.id） */
  sourceId: string;
  /** 关系终点（Memory.id） */
  targetId: string;
  /** 关系类型（开放字符串，非枚举） */
  type: string;
  /** 关系强度 0-1（LLM 四档：0.0/0.3/0.7/1.0，代码默认 0.5 兜底） */
  weight: number;
  /** 创建时间（ISO 8601） */
  createdAt: string;
}

/**
 * 关系查询方向
 * - 'outgoing'：只查 sourceId = memoryId 的关系（冲突检测用）
 * - 'incoming'：只查 targetId = memoryId 的关系
 * - 'both'：合并两个方向并去重（可视化/召回增强用，默认）
 */
export type RelationDirection = 'outgoing' | 'incoming' | 'both';

/**
 * weight 四档离散值常量（LLM 输出约束）
 *
 * 设计理由（ADR-014 §4）：
 * - 离散值比连续浮点稳定，LLM 输出可预测
 * - 0.5 兜底避免 LLM 失败时关系数据缺失
 */
export const RELATION_WEIGHTS = {
  /** 几乎无关（LLM 明确判断无关系） */
  NONE: 0.0,
  /** 弱相关（关系存在但强度低） */
  WEAK: 0.3,
  /** 未判断（代码默认兜底，LLM 失败或未输出时） */
  UNDEFINED: 0.5,
  /** 强相关（关系明确且强度高） */
  STRONG: 0.7,
  /** 确定关系（矛盾/等价等强关系） */
  CERTAIN: 1.0,
} as const;

/**
 * 预设关系类型建议值（非枚举，仅作约定）
 *
 * 注意：type 是开放字符串，新增关系类型无需改代码
 * 只需在存储时指定 type 字符串即可
 */
export const RELATION_TYPES = {
  /** 矛盾（双向对称） */
  CONTRADICTS: 'contradicts',
  /** 支持（有向） */
  SUPPORTS: 'supports',
  /** 时间先后（有向） */
  FOLLOWS: 'follows',
  /** 细化/演化（有向） */
  REFINES: 'refines',
  /** 因果（有向） */
  CAUSED: 'caused',
  /** 泛相关（双向对称） */
  RELATED: 'related',
} as const;

// ─── 关系查询结果类型（ADR-014 扩展，Phase 5.1/5.2） ─────

/**
 * 关系路径节点 — 路径追溯查询结果
 *
 * 独立于 Memory 和 MemoryRelation，仅作为查询结果投影类型存在。
 * 不侵入 Memory 7 字段基元（ADR-004），不扩展 MemoryRelation 侧车结构（ADR-014）。
 *
 * 用于宿主 UI 展示记忆的演化脉络（如 insight-a → refines → insight-b → follows → insight-c）
 */
export interface RelationPath {
  /** 当前节点记忆 ID */
  memoryId: string;
  /** 当前节点记忆名称（用于 UI 展示） */
  memoryName: string;
  /** 当前节点记忆来源标签（用于 UI 颜色区分） */
  memorySource: string;
  /** 与上一节点的关系类型（起点节点此字段为 null） */
  relationType: string | null;
  /** 与上一节点的关系权重（起点节点此字段为 null） */
  relationWeight: number | null;
  /** 距离起点的步数（起点为 0，每跳一步 +1） */
  depth: number;
}

/**
 * 关系邻居 — 直接关联的记忆查询结果
 *
 * 独立于 Memory 和 MemoryRelation，仅作为查询结果投影类型存在。
 * 用于宿主 UI 展示某记忆的直接关联记忆（如冲突记忆、支持记忆、后续记忆等）
 */
export interface RelationNeighbor {
  /** 邻居记忆 ID */
  memoryId: string;
  /** 邻居记忆名称 */
  memoryName: string;
  /** 邻居记忆来源标签 */
  memorySource: string;
  /** 邻居记忆权重（0-1，用于 UI 节点大小） */
  memoryScore: number;
  /** 关系类型 */
  relationType: string;
  /** 关系权重 */
  relationWeight: number;
  /** 关系方向：'incoming'（邻居是 sourceId）或 'outgoing'（邻居是 targetId） */
  direction: 'incoming' | 'outgoing';
}
