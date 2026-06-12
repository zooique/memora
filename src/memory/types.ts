/**
 * 记忆类型定义 — 基元驱动模型
 *
 * 设计哲学：万物皆是记忆，用 source 开放字符串替代封闭枚举
 * 详见 docs/记忆系统重构方案_排雷炼化版.md §2
 *
 * 重构变更（2026-06-11）：
 * - 移除 MemoryType 枚举 → source 开放字符串
 * - 移除 Permanence 枚举 → 召回策略由查询时决定
 * - 移除 TopicMount/ArchiveManager 相关类型
 * - 简化 Memory 接口：7 个核心字段
 */
import { z } from 'zod';

// ─── 基元定义 ─────────────────────────────────────────────

/**
 * 记忆基元 schema
 *
 * 7 个核心字段，无封闭枚举，无额外元数据
 */
export const MemorySchema = z.object({
  /** 唯一标识（source:name，如 'rule:core'、'insight:1718083200000'） */
  id: z.string(),
  /** 记忆内容（Markdown 文本） */
  content: z.string(),
  /** 来源标签（开放字符串，非枚举） */
  source: z.string(),
  /** 可读名称（文件名或摘要标题） */
  name: z.string(),
  /** 创建时间（ISO 8601） */
  createdAt: z.string().datetime(),
  /** 最后访问时间（每次召回时刷新） */
  accessedAt: z.string().datetime(),
  /** 权重（0-1，召回时用于排序） */
  score: z.number().min(0).max(1).default(0.5),
});

export type Memory = z.infer<typeof MemorySchema>;

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
} as const;

// ─── 分词相关 ─────────────────────────────────────────────

/**
 * 中文停用词集合
 * 用于关键词提取时过滤无意义词汇
 */
export const STOPWORDS = new Set([
  '的', '了', '是', '在', '我', '有', '和', '就', '不', '人', '都',
  '一', '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会',
  '着', '没有', '看', '好', '自己', '这', '那', '什么', '怎么', '可以',
  '这个', '那个', '他们', '我们', '因为', '所以', '但是', '如果', '虽然',
  '能', '把', '被', '让', '给', '对', '从', '为', '比', '与', '或',
  '吗', '呢', '吧', '啊', '哦', '嗯', '呀', '哈',
]);

// ─── 工具函数 ─────────────────────────────────────────────

/**
 * 从文件路径自动推断 source（目录映射 + frontmatter 覆盖）
 *
 * @param filePath - 文件路径
 * @param frontmatterSource - frontmatter 中显式声明的 source（可选）
 * @returns source 字符串
 */
export function inferSource(filePath: string, frontmatterSource?: string): string {
  // 优先：frontmatter 中显式声明的 source
  if (frontmatterSource) return frontmatterSource;

  // 回退：目录路径映射
  if (filePath.includes('personas/')) return SOURCE_LABELS.PERSONA;
  if (filePath.includes('/rules/')) return SOURCE_LABELS.RULE;
  if (filePath.includes('/skills/')) return SOURCE_LABELS.SKILL;

  // 默认
  return 'unknown';
}

/**
 * 转义 LIKE 通配符，防止注入
 *
 * @param str - 原始字符串
 * @returns 转义后的字符串
 */
export function escapeLike(str: string): string {
  return str.replace(/[%_]/g, '\\$&');
}
