/**
 * 记忆召回 — 简化关键词搜索。
 * 双通道（语义 + 关键词）召回，以 source 开放字符串区分来源、无需独立管理器；
 * 融合排序在 hybridMerge.ts（与 searchHybrid() 共享）。
 */
import type { Memory } from '@/memory/types.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import type { IVectorStore } from '@/memory/vectorStore.js';
import type { IReranker } from '@/memory/reranker.js';
import { logger } from '@/logging/logger.js';
import { segmentLower, STOPWORDS } from '@/utils/segmenter.js';
import { nowIso } from '@/utils/time.js';
import { hybridMerge, RECALL_LIMIT_MULTIPLIER } from '@/memory/hybridMerge.js';
import type { HybridWeights } from '@/memory/hybridMerge.js';
// 召回默认值 SSOT 跨层共享（保底下限 + 排除默认）
import { DEFAULT_MIN_FALLBACK, DEFAULT_RECALL_EXCLUDE_SOURCES } from '@/utils/recallDefaults.js';
// 召回 score 提升/上限/下限 + 衰减：复用治理共享常量，与宿主 SqliteStorage.decayScores 同一真源
import { BOOST_INCREMENT, SCORE_CEILING, DECAY_FLOOR, DECAY_AGE_DAYS, DECAY_AMOUNT } from '@/memory/governance.js';

// ─── 召回常量 ─────────────────────────────────────

/** 语义搜索默认相似度阈值 */
const DEFAULT_MIN_SIMILARITY = 0.3;

/** 一天对应的毫秒数 */
export const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 从文本提取关键词：segmentText 精确分词 + 停用词过滤 + 英文词补充 + 去重。
 */
export function extractKeywords(input: string): string[] {
  const words = segmentLower(input);

  // 补充英文词（segmentText 可能遗漏连续英文大写缩写，如 APIKey → "apikey" 整词）
  const englishWords = input.match(/[a-z]{2,}/gi) || [];
  words.push(...englishWords.map((w) => w.toLowerCase()));

  // 去重 + 停用词过滤 + 最短长度
  return [...new Set(words)].filter((w) => w.length >= 2 && !STOPWORDS.has(w));
}

// ─── 召回函数 ─────────────────────────────────────────────

/** 召回选项 */
export interface RecallOptions {
  /** 返回数量上限（默认 5） */
  limit?: number;
  /** 排除的 source（默认空数组——设定记忆已归角色包，不再参与召回排除） */
  excludeSources?: string[];
  /** 向量存储（可选，提供时启用语义搜索） */
  vectorStore?: IVectorStore;
  /** 语义搜索相似度阈值（默认 0.3） */
  minSimilarity?: number;
  /** 重排序器（可选，hybridMerge 之后二次精排，如 MMR/LLM 评分） */
  reranker?: IReranker;
  /** 双通道融合权重（可选，默认 0.6/0.4），见 hybridMerge.ts */
  weights?: HybridWeights;
  /**
   * 会话窗口标识，用于同会话窗口优先排序。
   * 与 round-summary 写侧 metadata.sessionName 同值同源（${date}-${session}），即"当前会话窗口摘要排最前"
   */
  sessionId?: string;
  /** 召回保底下限（默认 2）：语义不足时用最近记忆补足（空查询通道），排语义命中后、去 superseded；置 0 关闭 */
  minFallback?: number;
  /** 排除的 roundId 集合（互斥）：在 hybridMerge 取 limit 前过滤，避免正文已加载的当前会话摘要挤占预算；缺省空集合不过滤 */
  excludeRoundIds?: ReadonlySet<string>;
}

/**
 * 从存储搜索相关记忆：双通道（语义+关键词）合并去重 → hybridMerge 融合排序 → 可选 reranker → 会话窗口/组内排序 + superseded 过滤 → 返回 top N。
 */
export async function recall(
  storage: IMemoryStorage,
  query: string,
  options: RecallOptions = {},
): Promise<Memory[]> {
  const {
    limit = 5,
    excludeSources = [...DEFAULT_RECALL_EXCLUDE_SOURCES],
    vectorStore,
    minSimilarity = DEFAULT_MIN_SIMILARITY,
    reranker,
    weights,
    sessionId,
    excludeRoundIds,
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
    // 失败时降级返回已收集的语义结果，与通道 1 对称
    try {
      // 用提取后的关键词组合搜索，避免 query 中停用词/噪声影响匹配
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

  // 零召回也进入保底：新会话冷启动同样需最近记忆兜底
  let active: Memory[] = [];
  if (merged.size > 0) {
    // 前置排除：在 hybridMerge 取 limit **前**过滤当前会话最近 N 轮摘要，避免挤占 top-limit 预算
    // Map 直接映射 value 数组（避免迭代器 spread 可移植性问题）
    let candidates: { memory: Memory; vectorScore: number }[] = Array.from(
      merged,
      ([, v]) => v,
    );
    if (excludeRoundIds && excludeRoundIds.size > 0) {
      candidates = candidates.filter(
        (e) => !e.memory.metadata?.roundId || !excludeRoundIds.has(e.memory.metadata.roundId),
      );
    }

    // ── 综合排序：委托 hybridMerge 纯函数（支持自定义权重） ──
    const sorted = hybridMerge(candidates, limit, weights);

    // ── 重排序：reranker 二次精排（可选） ──
    let reranked = reranker
      ? await reranker.rerank(
          query,
          sorted.map((e) => e.memory),
          { limit },
        )
      : sorted.map((e) => e.memory);

    // 记忆有效性由 superseded（写时取代）+ score 衰减判定，不在读路径按时间过滤
    // 会话窗口优先 + 组内 createdAt 升序；稳定排序，类型不参与
    reranked = [...reranked].sort((a, b) => {
      if (sessionId) {
        const aIsSameWindow = a.metadata?.sessionName === sessionId;
        const bIsSameWindow = b.metadata?.sessionName === sessionId;
        if (aIsSameWindow !== bIsSameWindow) return aIsSameWindow ? -1 : 1;
      }
      // 同窗口内（或无 sessionId）：createdAt 升序
      const aTime = Date.parse(a.createdAt);
      const bTime = Date.parse(b.createdAt);
      if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) return aTime - bTime;
      return 0;
    });

    // 被 supersededBy 取代的摘要不再作为当前事实注入（仍保留可回溯）
    active = reranked.filter((m) => !m.supersededBy);
  }

  // 召回保底：active 少于 minFallback 时用空查询通道按 score 降序补最近记忆，排语义命中后、同过滤（excludeSources+去 superseded），置 0 关闭
  const fallbackFloor = options.minFallback ?? DEFAULT_MIN_FALLBACK;
  // 仅"有查询意图"（关键词非空）时保底
  if (fallbackFloor > 0 && keywords.length > 0 && active.length < fallbackFloor) {
    const shortfall = fallbackFloor - active.length;
    // 防御：空查询补足通道失败时静默跳过，不阻塞主流程
    let recent: Memory[] = [];
    try {
      const raw = storage.search('', shortfall * RECALL_LIMIT_MULTIPLIER);
      recent = Array.isArray(raw) ? raw : [];
    } catch (err) {
      logger.debug({ err }, '召回保底：空查询补足失败，跳过');
    }
    const existingIds = new Set(active.map((m) => m.id));
    let remaining = shortfall;
    for (const candidate of recent) {
      if (remaining <= 0) break;
      // 与主流程对齐：已命中 / 被取代 / 被排除来源 → 跳过
      if (existingIds.has(candidate.id)) continue;
      if (candidate.supersededBy) continue;
      if (excludeSources.includes(candidate.source)) continue;
      // 互斥排除：避免把正文已加载的当前会话摘要补回造成重复
      const rid = candidate.metadata?.roundId;
      if (rid && excludeRoundIds?.has(rid)) continue;
      active.push(candidate);
      existingIds.add(candidate.id);
      remaining--;
    }
  }

  // 读/写拆分：在副本上 boost 仅影响本轮排序；持久化由调用方 fire-and-forget 调 boostScores，不阻塞读路径
  const now = nowIso();
  const result: Memory[] = active.map((memory) => {
    const copy = { ...memory };
    boostScore(copy, now);
    return copy;
  });

  return result;
}

/**
 * 批量持久化 boost（recall 后 fire-and-forget 调用）：失败仅 log 不抛错，不阻塞读路径。
 * 不在 recall 内 upsert（消除写耦合读）；不引入 dirty+批量调度器；立即持久化但 fire-and-forget
 */
export async function boostScores(
  storage: IMemoryStorage,
  ids: string[],
  now: string = nowIso(),
): Promise<void> {
  for (const id of ids) {
    // incrementScore 原子操作，消除 read-modify-write 并发冲突，与 decayScores 同模式
    storage.incrementScore(id, BOOST_INCREMENT, now);
  }
}

// ─── Score 衰减机制 ─────────────────────────────────────

/** 召回时提升 score（上限 1.0）：越常用越重要 */
// 模块私有（0 外部消费者，仅 recall.ts 内部调用，与 tokenizeKeywords 同模式）
function boostScore(memory: Memory, now?: string): void {
  memory.score = Math.min(SCORE_CEILING, memory.score + BOOST_INCREMENT);
  memory.accessedAt = now ?? nowIso();
}

/** 对单条记忆执行衰减（超阈值天数后逐周期降低）；返回是否实际发生衰减 */
export function applyDecayToMemory(memory: Memory, now: Date): boolean {
  const accessedAt = new Date(memory.accessedAt);
  if (isNaN(accessedAt.getTime())) {
    return false; // 跳过无效日期
  }

  const daysSinceAccess = (now.getTime() - accessedAt.getTime()) / ONE_DAY_MS;
  if (daysSinceAccess <= DECAY_AGE_DAYS) {
    return false;
  }

  const periods = Math.floor(daysSinceAccess / DECAY_AGE_DAYS);
  memory.score = Math.max(DECAY_FLOOR, memory.score - DECAY_AMOUNT * periods);
  return true;
}