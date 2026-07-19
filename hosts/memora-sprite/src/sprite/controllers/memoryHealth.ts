/**
 * 记忆健康度诊断模块
 *
 * 职责：
 *   1. 重复记忆检测（基于内容相似度 + 同名记忆）
 *   2. 过期记忆标记（长期未访问 + 低 score）
 *   3. 记忆质量评分（完整性、时效性、关联度）
 *   4. 健康度仪表盘数据聚合
 *
 * 设计原则：
 *   - 纯代码推导，不依赖 LLM（B6：代码负责确定性工作）
 *   - 零内核修改，仅消费现有 MemoryController 的公开 API
 *   - 健康度诊断结果不持久化，每次请求实时计算（遵循"配置是真理源"原则）
 *   - 开放字符串阈值，允许后续通过配置调优
 */

// STEP9-IMPORTS-01 反向 type-only 引用：编译期擦除，禁止改为 value import（否则与 memoryController 形成运行时循环依赖）
import type { MemoryListItem } from './memoryController.js';
import { MS_PER_DAY } from '../constants.js';

// ─── 健康度阈值常量（开放字符串，后续可配置化） ──────────

/** 过期记忆：最后访问距今超过此天数 */
const STALE_AGE_DAYS = 30;

/** 过期记忆：score 低于此值 */
const STALE_SCORE_THRESHOLD = 0.2;

/** 重复检测：内容相似度高于此值视为重复 */
const DUPLICATE_SIMILARITY_THRESHOLD = 0.85;

/** 重复检测：同名记忆组达到此数量即视为重复（>=2 表示出现重复） */
const DUPLICATE_NAME_THRESHOLD = 2;

/** 低质量记忆：content 长度低于此值（字符数） */
const LOW_QUALITY_CONTENT_LENGTH = 20;

/** 健康度仪表盘各项满分 */
const HEALTH_MAX_SCORE = 100;

// ─── 类型定义 ────────────────────────────────────────────

/** 重复记忆组 */
export interface DuplicateGroup {
  /** 重复类型：同名或内容相似 */
  type: 'name' | 'content';
  /** 重复的记忆列表 */
  memories: MemoryListItem[];
  /** 相似度（content 类型时有值） */
  similarity?: number;
}

/** 过期记忆 */
export interface StaleMemory {
  /** 记忆条目 */
  memory: MemoryListItem;
  /** 过期原因 */
  reason: 'old_age' | 'low_score' | 'both';
  /** 最后访问距今的天数（-1 表示无访问记录） */
  daysSinceAccess: number;
}

/** 健康度评分 */
export interface HealthScores {
  /** 整体健康分（0-100） */
  overall: number;
  /** 唯一性分（无重复记忆，0-100） */
  uniqueness: number;
  /** 新鲜度分（无过期记忆，0-100） */
  freshness: number;
  /** 完整度分（记忆内容质量，0-100） */
  completeness: number;
}

/** 健康度仪表盘完整数据 */
export interface HealthDashboard {
  /** 健康度评分 */
  scores: HealthScores;
  /** 重复记忆组列表 */
  duplicates: DuplicateGroup[];
  /** 过期记忆列表 */
  staleMemories: StaleMemory[];
  /** 低质量记忆数 */
  lowQualityCount: number;
  /** 记忆总数（用于上下文） */
  totalMemories: number;
  /** 健康等级标签 */
  healthLabel: 'excellent' | 'good' | 'fair' | 'poor';
  /** 健康等级描述 */
  healthDescription: string;
}

// ─── 工具函数 ────────────────────────────────────────────

/**
 * 计算两个字符串的 Jaccard 相似度（基于词袋）
 *
 * 轻量级相似度计算，不依赖向量模型。将文本分词后计算交集/并集比。
 * 用于快速筛选候选重复记忆，不是精确的语义相似度。
 *
 * @param a 文本 A
 * @param b 文本 B
 * @returns 相似度 [0, 1]
 */
function jaccardSimilarity(a: string, b: string): number {
  // 中文按字符分词，英文按空格分词
  const tokenize = (s: string): Set<string> => {
    // 简单策略：按 2-gram 字符拆分，兼顾中英文
    const tokens = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) {
      tokens.add(s.slice(i, i + 2));
    }
    return tokens;
  };

  const setA = tokenize(a);
  const setB = tokenize(b);

  if (setA.size === 0 && setB.size === 0) return 0;
  if (setA.size === 0 || setB.size === 0) return 0;

  // 计算交集大小
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * 检测重复记忆组
 *
 * 两步检测：
 *   1. 同名记忆 → 直接标记为 name 类型重复
 *   2. 内容相似度 > 阈值 → 标记为 content 类型重复
 *
 * @param memories 全量记忆列表
 * @returns 重复记忆组列表
 */
function detectDuplicates(memories: MemoryListItem[]): DuplicateGroup[] {
  const groups: DuplicateGroup[] = [];
  const processed = new Set<number>(); // 已处理的索引

  // 按 name 分组检测同名重复
  const nameMap = new Map<string, number[]>();
  memories.forEach((m, i) => {
    const existing = nameMap.get(m.name) || [];
    existing.push(i);
    nameMap.set(m.name, existing);
  });

  for (const [, indices] of nameMap) {
    if (indices.length >= DUPLICATE_NAME_THRESHOLD) {
      groups.push({
        type: 'name',
        memories: indices.map((i) => memories[i]!),
      });
      indices.forEach((i) => processed.add(i));
    }
  }

  // 内容相似度检测（对未处理的记忆两两比较）
  const unprocessed = memories.filter((_, i) => !processed.has(i));
  const contentProcessed = new Set<number>();

  for (let i = 0; i < unprocessed.length; i++) {
    if (contentProcessed.has(i)) continue;
    const first = unprocessed[i]!;
    const group: MemoryListItem[] = [first];

    for (let j = i + 1; j < unprocessed.length; j++) {
      if (contentProcessed.has(j)) continue;
      const second = unprocessed[j]!;
      const sim = jaccardSimilarity(
        first.contentPreview,
        second.contentPreview,
      );
      if (sim >= DUPLICATE_SIMILARITY_THRESHOLD) {
        group.push(second);
        contentProcessed.add(j);
      }
    }

    if (group.length > 1) {
      groups.push({
        type: 'content',
        memories: group,
        similarity: jaccardSimilarity(group[0]!.contentPreview, group[1]!.contentPreview),
      });
    }
    contentProcessed.add(i);
  }

  return groups;
}

/**
 * 检测过期记忆
 *
 * 判定条件（满足任一即为过期）：
 *   - 最后访问时间距今 > STALE_AGE_DAYS 天
 *   - score < STALE_SCORE_THRESHOLD
 *
 * @param memories 全量记忆列表
 * @returns 过期记忆列表
 */
function detectStaleMemories(memories: MemoryListItem[]): StaleMemory[] {
  const now = Date.now();
  const stale: StaleMemory[] = [];

  for (const m of memories) {
    const daysSinceAccess = m.createdAt
      ? Math.floor((now - new Date(m.createdAt).getTime()) / MS_PER_DAY)
      : -1;

    const isOld = daysSinceAccess > STALE_AGE_DAYS;
    const isLowScore = m.score < STALE_SCORE_THRESHOLD;

    if (isOld || isLowScore) {
      stale.push({
        memory: m,
        reason: isOld && isLowScore ? 'both' : isOld ? 'old_age' : 'low_score',
        daysSinceAccess: daysSinceAccess > 0 ? daysSinceAccess : -1,
      });
    }
  }

  return stale;
}

/**
 * 计算健康度评分
 *
 * 三个维度：
 *   - uniqueness：无重复记忆的比例（重复记忆越少分越高）
 *   - freshness：无过期记忆的比例（过期记忆越少分越高）
 *   - completeness：内容质量（过短的内容视为低质量）
 *
 * @param total 记忆总数
 * @param duplicateCount 重复记忆涉及的记忆数
 * @param staleCount 过期记忆数
 * @param lowQualityCount 低质量记忆数
 * @returns 健康度评分
 */
function calculateHealthScores(
  total: number,
  duplicateCount: number,
  staleCount: number,
  lowQualityCount: number,
): HealthScores {
  if (total === 0) {
    return { overall: HEALTH_MAX_SCORE, uniqueness: HEALTH_MAX_SCORE, freshness: HEALTH_MAX_SCORE, completeness: HEALTH_MAX_SCORE };
  }

  const uniqueness = Math.round(HEALTH_MAX_SCORE * (1 - duplicateCount / total));
  const freshness = Math.round(HEALTH_MAX_SCORE * (1 - staleCount / total));
  const completeness = Math.round(HEALTH_MAX_SCORE * (1 - lowQualityCount / total));

  // 整体分 = 三维度加权平均（唯一性 0.4、新鲜度 0.3、完整度 0.3）
  const overall = Math.round(uniqueness * 0.4 + freshness * 0.3 + completeness * 0.3);

  return { overall, uniqueness, freshness, completeness };
}

/**
 * 根据整体健康分确定健康等级
 *
 * @param overall 整体健康分 [0, 100]
 * @returns 健康等级标签和描述
 */
function healthLevel(overall: number): { label: 'excellent' | 'good' | 'fair' | 'poor'; description: string } {
  if (overall >= 90) return { label: 'excellent', description: '记忆库非常健康，数据质量优秀' };
  if (overall >= 70) return { label: 'good', description: '记忆库状态良好，少量记忆需要关注' };
  if (overall >= 50) return { label: 'fair', description: '记忆库存在一些问题，建议清理' };
  return { label: 'poor', description: '记忆库健康度较低，需要立即清理' };
}

// ─── 公开 API ────────────────────────────────────────────

/**
 * 构建健康度仪表盘完整数据
 *
 * 单次调用完成所有检测和评分，返回 HealthDashboard 供 UI 渲染。
 * 纯计算，无副作用，不调 LLM，不持久化。
 *
 * @param memories 全量记忆列表（由 MemoryController.list() 提供）
 * @returns 健康度仪表盘数据
 */
export function buildHealthDashboard(memories: MemoryListItem[]): HealthDashboard {
  const total = memories.length;

  // 空记忆库：返回满分
  if (total === 0) {
    return {
      scores: { overall: HEALTH_MAX_SCORE, uniqueness: HEALTH_MAX_SCORE, freshness: HEALTH_MAX_SCORE, completeness: HEALTH_MAX_SCORE },
      duplicates: [],
      staleMemories: [],
      lowQualityCount: 0,
      totalMemories: 0,
      healthLabel: 'excellent',
      healthDescription: '记忆库为空，暂无数据',
    };
  }

  // 并行检测（纯计算，无需异步）
  const duplicates = detectDuplicates(memories);
  const staleMemories = detectStaleMemories(memories);

  // 低质量记忆：内容过短
  const lowQualityCount = memories.filter(
    (m) => m.contentPreview.length < LOW_QUALITY_CONTENT_LENGTH,
  ).length;

  // 重复记忆涉及的总数（一个记忆可能出现在多个重复组中，去重）
  const duplicateMemoryIds = new Set<string>();
  for (const group of duplicates) {
    for (const m of group.memories) {
      duplicateMemoryIds.add(m.id);
    }
  }

  const scores = calculateHealthScores(
    total,
    duplicateMemoryIds.size,
    staleMemories.length,
    lowQualityCount,
  );

  const level = healthLevel(scores.overall);

  return {
    scores,
    duplicates,
    staleMemories,
    lowQualityCount,
    totalMemories: total,
    healthLabel: level.label,
    healthDescription: level.description,
  };
}

/**
 * 获取重复记忆的 ID 列表（用于清理操作）
 *
 * 提取重复组中除第一条外的所有记忆 ID，作为"建议删除"列表。
 * 保留每组中 score 最高的一条。
 *
 * @param duplicates 重复记忆组
 * @returns 建议删除的记忆 ID 列表
 */
export function getDuplicateRemovalIds(duplicates: DuplicateGroup[]): string[] {
  const ids: string[] = [];
  for (const group of duplicates) {
    // 按 score 降序排序，保留第一条（最高分），其余标记为可删除
    const sorted = [...group.memories].sort((a, b) => b.score - a.score);
    for (let i = 1; i < sorted.length; i++) {
      ids.push(sorted[i]!.id);
    }
  }
  return ids;
}

/**
 * 获取过期记忆的 ID 列表（用于清理操作）
 *
 * @param staleMemories 过期记忆列表
 * @returns 过期记忆 ID 列表
 */
export function getStaleRemovalIds(staleMemories: StaleMemory[]): string[] {
  return staleMemories.map((s) => s.memory.id);
}