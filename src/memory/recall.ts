/**
 * 记忆召回 — 简化关键词搜索
 *
 * 设计哲学：每次用户发消息，从所有记忆中搜索最相关的几条注入上下文
 * 基于基元驱动模型，通过 source 开放字符串区分记忆来源，
 * 通过双通道（语义 + 关键词）召回，无需独立管理器
 *
 * P1-05 重构（2026-07）：
 * 双通道融合排序算法已提取到 hybridMerge.ts，与 memoryInspector.searchHybrid() 共享。
 * 本模块仍 re-export 三个常量（RECALL_LIMIT_MULTIPLIER / VECTOR_SCORE_WEIGHT /
 * MEMORY_SCORE_WEIGHT）保持向后兼容，但实际定义已迁移到 hybridMerge.ts。
 *
 * 详见 ADR-004 · 记忆统一模型 + architecture_philosophy_rules.md §6 增量召回
 */
import type { Memory } from '@/memory/types.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import type { VectorStore } from '@/memory/vectorStore.js';
import { logger } from '@/logging/logger.js';
import { STOPWORDS, SOURCE_LABELS } from '@/memory/types.js';
import { segmentText } from '@/utils/segmenter.js';
import { nowIso } from '@/utils/time.js';
// P1-05：双通道融合排序算法从 hybridMerge 导入（常量通过 re-export 暴露给历史消费者）
import { hybridMerge, RECALL_LIMIT_MULTIPLIER } from '@/memory/hybridMerge.js';

// ─── 向后兼容 re-export（P1-05：常量定义已迁移到 hybridMerge.ts） ───
// 测试文件和历史代码可能通过 recall.ts 导入这些常量，保持 re-export 避免破坏
// 直接从 hybridMerge.ts 重新导出，本模块不再定义这些常量
export { RECALL_LIMIT_MULTIPLIER, VECTOR_SCORE_WEIGHT, MEMORY_SCORE_WEIGHT } from '@/memory/hybridMerge.js';

// ─── 召回与衰减常量 ─────────────────────────────────────

/** 语义搜索默认相似度阈值 */
const DEFAULT_MIN_SIMILARITY = 0.3;

/** 每次召回时 score 提升量 */
const BOOST_INCREMENT = 0.05;

/** score 上限 */
const SCORE_CEILING = 1.0;

/** 衰减：未访问天数阈值 */
const DECAY_AGE_DAYS = 7;

/** 衰减：每过一个周期 score 降低量 */
const DECAY_AMOUNT = 0.02;

/** 衰减：score 下限 */
const DECAY_FLOOR = 0.1;

/** 一天对应的毫秒数 */
export const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 从文本中提取关键词（用于记忆召回）
 *
 * 基于 segmentText() 精确分词，叠加停用词过滤 + 英文词补充 + 去重。
 * 分词基础设施统一由 segmenter.ts 提供，避免重复实现。
 *
 * @param input - 输入文本
 * @returns 关键词数组（去重 + 停用词过滤）
 */
export function extractKeywords(input: string): string[] {
  // 复用 segmenter.ts 的精确分词（Intl.Segmenter ICU 词典切分）
  const words = segmentText(input).map((w) => w.toLowerCase());

  // 补充英文词（segmentText 可能遗漏连续英文大写缩写，如 APIKey → "apikey" 整词）
  const englishWords = input.match(/[a-z]{2,}/gi) || [];
  words.push(...englishWords.map((w) => w.toLowerCase()));

  // 去重 + 停用词过滤 + 最短长度
  return [...new Set(words)].filter((w) => w.length >= 2 && !STOPWORDS.has(w));
}

// ─── 召回函数 ─────────────────────────────────────────────

/**
 * 召回选项
 */
export interface RecallOptions {
  /** 返回数量上限（默认 5） */
  limit?: number;
  /** 排除的 source 标签（默认排除 persona、rule、skill——已单独注入 system prompt 的记忆） */
  excludeSources?: string[];
  /** 向量存储（可选，提供时启用语义搜索） */
  vectorStore?: VectorStore;
  /** 语义搜索相似度阈值（默认 0.3） */
  minSimilarity?: number;
}

/**
 * 从记忆存储中搜索相关记忆
 *
 * 双通道召回策略：
 * 1. 语义搜索（VectorStore 可用时）：向量余弦相似度
 * 2. 关键词搜索（兜底）：LIKE 匹配
 * 3. 两路结果合并去重，按 score + similarity 综合排序（委托给 hybridMerge）
 * 4. 排除已单独注入的记忆（persona、rule、skill）
 * 5. 返回 top N
 *
 * P1-05：融合排序算法已提取到 hybridMerge.ts，与 searchHybrid() 共享同一实现
 *
 * @param storage - 记忆存储实例
 * @param query - 搜索查询文本
 * @param options - 召回选项
 * @returns 匹配的记忆列表
 */
export async function recall(
  storage: IMemoryStorage,
  query: string,
  options: RecallOptions = {},
): Promise<Memory[]> {
  const {
    limit = 5,
    excludeSources = [SOURCE_LABELS.PERSONA, SOURCE_LABELS.RULE, SOURCE_LABELS.SKILL],
    vectorStore,
    minSimilarity = DEFAULT_MIN_SIMILARITY,
  } = options;

  const merged = new Map<string, { memory: Memory; vectorScore: number }>();

  // ── 通道 1：语义搜索（VectorStore 可用时） ──
  if (vectorStore && vectorStore.size > 0) {
    try {
      const vectorResults = await vectorStore.search(
        query,
        limit * RECALL_LIMIT_MULTIPLIER,
        minSimilarity,
      );
      for (const vr of vectorResults) {
        const memory = storage.getById(vr.id);
        if (memory && !excludeSources.includes(memory.source)) {
          merged.set(memory.id, { memory, vectorScore: vr.similarity });
        }
      }
    } catch (err) {
      logger.debug({ err }, '语义搜索失败，降级到关键词');
    }
  }

  // ── 通道 2：关键词搜索 ──
  const keywords = extractKeywords(query);
  if (keywords.length > 0) {
    // FD-23: 关键词搜索失败时降级返回已收集的语义结果，与通道 1 降级策略对称
    try {
      // 使用提取后的关键词组合搜索，避免原始 query 中的停用词/噪声影响匹配
      const keywordResults = storage.search(keywords.join(' '), limit * RECALL_LIMIT_MULTIPLIER);
      for (const m of keywordResults) {
        if (!excludeSources.includes(m.source) && !merged.has(m.id)) {
          merged.set(m.id, { memory: m, vectorScore: 0 });
        }
      }
    } catch (err) {
      logger.debug({ err }, '关键词搜索失败，仅返回语义搜索结果');
    }
  }

  // ── 无任何结果 ──
  if (merged.size === 0) return [];

  // ── 综合排序：委托给 hybridMerge 纯函数（P1-05 提取） ──
  const sorted = hybridMerge(merged.values(), limit);

  // ── 召回时提升 score ──
  // 在副本上操作避免污染调用方持有的对象，boost 后写回存储
  const now = nowIso();
  const result: Memory[] = [];
  for (const { memory } of sorted) {
    const copy = { ...memory };
    boostScore(copy, now);
    storage.upsert(copy); // 写回存储，持久化 score 提升
    result.push(copy);
  }

  return result;
}

// ─── Score 衰减机制 ─────────────────────────────────────

/**
 * 召回时提升记忆的 score（上限 1.0）
 *
 * 每次被召回时，记忆的 score 略微提升，体现"越常用越重要"。
 *
 * @param memory - 被召回的记忆
 * @param now - 当前时间戳（ISO 8601）
 */
// P3-06：从 export 降为模块私有（0 外部消费者，仅 recall.ts 内部调用，与 tokenizeKeywords 同模式）
function boostScore(memory: Memory, now?: string): void {
  memory.score = Math.min(SCORE_CEILING, memory.score + BOOST_INCREMENT);
  memory.accessedAt = now ?? nowIso();
}

/**
 * 对单条记忆执行衰减计算
 *
 * @param memory - 要衰减的记忆
 * @param now - 当前时间（Date 对象）
 * @returns 是否实际发生了衰减
 */
export function applyDecayToMemory(memory: Memory, now: Date): boolean {
  const accessedAt = new Date(memory.accessedAt);
  if (isNaN(accessedAt.getTime())) {
    return false; // 跳过无效日期的记忆
  }

  const daysSinceAccess = (now.getTime() - accessedAt.getTime()) / ONE_DAY_MS;
  if (daysSinceAccess <= DECAY_AGE_DAYS) {
    return false;
  }

  const periods = Math.floor(daysSinceAccess / DECAY_AGE_DAYS);
  memory.score = Math.max(DECAY_FLOOR, memory.score - DECAY_AMOUNT * periods);
  return true;
}
