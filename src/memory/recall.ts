/**
 * 记忆召回 — 简化关键词搜索
 *
 * 设计哲学：每次用户发消息，从所有记忆中搜索最相关的几条注入上下文
 * 不需要话题概念，不需要漂移检测，不需要管理器
 *
 * 详见 docs/记忆系统重构方案_排雷炼化版.md §4
 */
import type { Memory } from './types.js';
import type { IMemoryStorage } from './storageInterface.js';
import type { VectorStore } from './vectorStore.js';
import { STOPWORDS } from './types.js';

/**
 * 从文本中提取关键词
 *
 * 优先使用 Intl.Segmenter（浏览器/Node.js 内置），回退 2-gram
 *
 * @param input - 输入文本
 * @returns 关键词数组（去重 + 停用词过滤）
 */
export function extractKeywords(input: string): string[] {
  const words: string[] = [];

  // 优先使用 Intl.Segmenter 做中文分词（比 2-gram 精准）
  try {
    const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
    for (const { segment, isWordLike } of segmenter.segment(input)) {
      if (isWordLike && segment.trim().length >= 2) {
        words.push(segment.trim());
      }
    }
  } catch {
    // 回退：2-gram
    const cleaned = input.replace(/[^\u4e00-\u9fff]/g, '');
    for (let i = 0; i < cleaned.length - 1; i++) {
      words.push(cleaned[i]! + cleaned[i + 1]!);
    }
  }

  // 英文词提取
  const englishWords = input.match(/[a-z]{2,}/gi) || [];
  words.push(...englishWords.map(w => w.toLowerCase()));

  // 去重 + 停用词过滤
  return [...new Set(words)].filter(w => w.length >= 2 && !STOPWORDS.has(w));
}

// ─── 召回函数 ─────────────────────────────────────────────

/**
 * 召回选项
 */
export interface RecallOptions {
  /** 返回数量上限（默认 5） */
  limit?: number;
  /** 排除的 source 标签（默认排除 persona 和 rule） */
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
 * 3. 两路结果合并去重，按 score + similarity 综合排序
 * 4. 排除已单独注入的记忆（persona、rule）
 * 5. 返回 top N
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
    excludeSources = ['persona', 'rule'],
    vectorStore,
    minSimilarity = 0.3,
  } = options;

  const merged = new Map<string, { memory: Memory; vectorScore: number }>();

  // ── 通道 1：语义搜索（VectorStore 可用时） ──
  if (vectorStore && vectorStore.size > 0) {
    try {
      const vectorResults = await vectorStore.search(query, limit * 2, minSimilarity);
      for (const vr of vectorResults) {
        const memory = storage.getById(vr.id);
        if (memory && !excludeSources.includes(memory.source)) {
          merged.set(memory.id, { memory, vectorScore: vr.similarity });
        }
      }
    } catch {
      // 语义搜索失败（网络问题、embedding 服务不可用），静默降级到关键词
    }
  }

  // ── 通道 2：关键词搜索 ──
  const keywords = extractKeywords(query);
  if (keywords.length > 0) {
    const keywordResults = storage.search(query, limit * 2);
    for (const m of keywordResults) {
      if (!excludeSources.includes(m.source) && !merged.has(m.id)) {
        merged.set(m.id, { memory: m, vectorScore: 0 });
      }
    }
  }

  // ── 无任何结果 ──
  if (merged.size === 0) return [];

  // ── 综合排序：vectorScore（语义相关度）+ memory.score（权重） ──
  const sorted = [...merged.values()].sort((a, b) => {
    const scoreA = a.vectorScore * 0.6 + a.memory.score * 0.4;
    const scoreB = b.vectorScore * 0.6 + b.memory.score * 0.4;
    return scoreB - scoreA;
  });

  // ── 召回时提升 score ──
  // 在副本上操作避免污染调用方持有的对象，boost 后写回存储
  const now = new Date().toISOString();
  const result: Memory[] = [];
  for (const { memory } of sorted.slice(0, limit)) {
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
export function boostScore(memory: Memory, now?: string): void {
  memory.score = Math.min(1.0, memory.score + 0.05);
  memory.accessedAt = now ?? new Date().toISOString();
}

/**
 * 定期衰减：长时间未访问的记忆 score 逐渐降低（下限 0.1）
 *
 * 超过 7 天未访问的记忆，每 7 天 score 降低 0.02，
 * 体现"越久不用越不重要"。
 *
 * @param memories - 要衰减的记忆列表
 * @param now - 当前时间（Date 对象）
 */
export function decayScores(memories: Memory[], now?: Date): void {
  const ONE_DAY = 24 * 60 * 60 * 1000;
  const currentTime = now?.getTime() ?? Date.now();

  for (const m of memories) {
    // 增加日期有效性验证，跳过无效日期
    const accessedAt = new Date(m.accessedAt);
    if (isNaN(accessedAt.getTime())) {
      continue; // 跳过无效日期的记忆
    }
    const daysSinceAccess = (currentTime - accessedAt.getTime()) / ONE_DAY;
    if (daysSinceAccess > 7) {
      m.score = Math.max(0.1, m.score - 0.02 * Math.floor(daysSinceAccess / 7));
    }
  }
}
