/**
 * 记忆类型定义 — 基元驱动模型
 *
 * 设计哲学：万物皆是记忆，用 source 开放字符串替代封闭枚举
 * 详见 ADR-004 · 记忆统一模型
 */
import { z } from 'zod';

// ─── 基元定义 ─────────────────────────────────────────────

/**
 * 记忆基元 schema
 *
 * 8 个核心字段（v2.1 GAP-6 软删除扩展），无封闭枚举
 * - 7 个基础字段：id/content/source/name/createdAt/accessedAt/score
 * - 1 个可选字段：deletedAt（软删除时间，undefined 表示活跃记忆）
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
  /** 软删除时间（ISO 8601，可选；非 undefined 表示已软删除，回收站保留 30 天后自动物理清理） */
  deletedAt: z.string().datetime().optional(),
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
  /** 内容护栏规则（configDir/rules/guardrails/ 下的规则文件） */
  GUARDRAIL: 'guardrail',
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

  // 回退：目录路径映射（使用路径分隔符匹配，避免 'other-personas/' 误匹配）
  if (/[\\/]personas[\\/]/.test(filePath)) return SOURCE_LABELS.PERSONA;
  if (/[\\/]rules[\\/]/.test(filePath)) return SOURCE_LABELS.RULE;
  if (/[\\/]skills[\\/]/.test(filePath)) return SOURCE_LABELS.SKILL;

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

// ─── Source 校验 ────────────────────────────────────────────

/**
 * 已知 source 标签集合（用于运行时校验）
 *
 * 从 SOURCE_LABELS 常量自动派生，保持同步。
 * 不是枚举——只用于 typo 检测，不阻止写入。
 */
const KNOWN_SOURCES: Set<string> = new Set(Object.values(SOURCE_LABELS));

/**
 * source 校验严重级别
 *
 * - 'block'：安全边界违规，调用方必须拒绝写入（throw）
 * - 'warn'：调用方 bug 或疑似 typo，应 warn 但允许写入
 * - undefined：无异常
 */
export type SourceValidationSeverity = 'block' | 'warn';

/**
 * 校验 source 字段是否为已知标签
 *
 * 返回校验结果，包含严重级别与警告信息（如有）。
 *
 * 分级策略：
 * - 路径遍历（`..`）与 null 字节 → severity='block'（安全边界，必须拒绝）
 * - 空字符串、非字符串、首尾空格 → severity='block'（调用方 bug，必须拒绝）
 * - 与已知标签 Levenshtein 距离 ≤ 2 的疑似 typo → severity='warn'（保持开放性）
 * - 其他自定义 source → valid: true（完全允许）
 *
 * @param source - 待校验的 source 字符串
 * @returns 校验结果
 */
export function validateSource(source: string): {
  valid: boolean;
  severity?: SourceValidationSeverity;
  warning?: string;
} {
  if (!source || typeof source !== 'string') {
    return {
      valid: false,
      severity: 'block',
      warning: `source 不能为空或非字符串，收到：${String(source)}`,
    };
  }

  if (source.trim() !== source) {
    return {
      valid: false,
      severity: 'block',
      warning: `source 包含首尾空格："${source}"`,
    };
  }

  if (source.includes('..')) {
    return {
      valid: false,
      severity: 'block',
      warning: `source 不能包含路径遍历序列："${source}"`,
    };
  }

  if (source.includes('\0')) {
    return {
      valid: false,
      severity: 'block',
      warning: `source 不能包含 null 字节`,
    };
  }

  // 检查与已知标签的相似度（简单 Levenshtein 距离 ≤ 2）
  if (!KNOWN_SOURCES.has(source)) {
    const closeMatch = [...KNOWN_SOURCES].find(
      (known) => levenshtein(source, known) <= 2 && source !== known,
    );
    if (closeMatch) {
      return {
        valid: true,
        severity: 'warn',
        warning: `source "${source}" 可能是 "${closeMatch}" 的拼写错误（已知标签：${[...KNOWN_SOURCES].join(', ')}）`,
      };
    }
  }

  return { valid: true };
}

/**
 * 简单 Levenshtein 距离计算（仅用于短字符串，不做优化）
 */
function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  // QC-17 移除非空断言：提取局部变量并 null 检查
  const row0 = matrix[0];
  if (row0) for (let j = 0; j <= a.length; j++) row0[j] = j;

  for (let i = 1; i <= b.length; i++) {
    // QC-17 移除非空断言：提取局部变量，用 ?? 0 兜底（初始化保证值存在）
    const rowI = matrix[i];
    const rowPrev = matrix[i - 1];
    if (!rowI || !rowPrev) continue;
    for (let j = 1; j <= a.length; j++) {
      const cost = b[i - 1] === a[j - 1] ? 0 : 1;
      rowI[j] = Math.min(
        (rowPrev[j] ?? 0) + 1,
        (rowI[j - 1] ?? 0) + 1,
        (rowPrev[j - 1] ?? 0) + cost,
      );
    }
  }

  // QC-17 移除非空断言：使用可选链 + 空值合并兜底
  return matrix[b.length]?.[a.length] ?? 0;
}

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
