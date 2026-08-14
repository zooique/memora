/**
 * 记忆召回 — 简化关键词搜索
 *
 * 设计哲学：每次用户发消息，从所有记忆中搜索最相关的几条注入上下文
 * 基于基元驱动模型，通过 source 开放字符串区分记忆来源，
 * 通过双通道（语义 + 关键词）召回，无需独立管理器
 *
 * 双通道融合排序算法在 hybridMerge.ts 中实现，与 memoryInspector.searchHybrid() 共享。
 *
 * 详见 ADR-004 · 记忆统一模型 + architecture_philosophy_rules.md §6 增量召回
 */
import type { Memory } from '@/memory/types.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import type { IVectorStore } from '@/memory/vectorStore.js';
import type { IReranker } from '@/memory/reranker.js';
import { logger } from '@/logging/logger.js';
import { SOURCE_LABELS } from '@/memory/types.js';
import { segmentLower, STOPWORDS } from '@/utils/segmenter.js';
import { nowIso } from '@/utils/time.js';
import { hybridMerge, RECALL_LIMIT_MULTIPLIER } from '@/memory/hybridMerge.js';
import type { HybridWeights } from '@/memory/hybridMerge.js';
// 召回 score 提升量/上限/下限 + 衰减常量：使用治理共享常量（v2 REPEAT-2/REPEAT-3 闭环）
// 衰减常量与宿主 SqliteStorage.decayScores 共用同一真理源，消除跨层重复硬编码
import { BOOST_INCREMENT, SCORE_CEILING, DECAY_FLOOR, DECAY_AGE_DAYS, DECAY_AMOUNT } from '@/memory/governance.js';

// ─── 召回常量 ─────────────────────────────────────

/** 语义搜索默认相似度阈值 */
const DEFAULT_MIN_SIMILARITY = 0.3;

/** 一天对应的毫秒数 */
export const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 摘要类型时间窗口策略表（memory-as-summary §4.2 差异化召回）
 *
 * 每种类型拥有独立存活窗口：intent/general 时效敏感，超期不召回；
 * preference/decision/fact 不限窗口（长期有效，可召回远古记忆）。
 * 表中未列出的类型（或未标记 summaryType 的非 round-summary 记忆）**不过滤**，
 * 仅命中窗口类型的摘要受时间约束。
 */
const RECALL_WINDOWS_DAYS: Readonly<Record<string, number>> = {
  intent: 7,
  general: 7,
};

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
  const words = segmentLower(input);

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
  /** 向量存储（可选，提供时启用语义搜索；接受任意 IVectorStore 实现） */
  vectorStore?: IVectorStore;
  /** 语义搜索相似度阈值（默认 0.3） */
  minSimilarity?: number;
  /**
   * 重排序器（可选，提供时在 hybridMerge 之后执行二次精排）
   *
   * 使用场景：hybridMerge 的线性加权无法满足需求时，
   * 通过自定义重排序器实现更复杂的排序策略（如 MMR 去重、LLM 评分等）。
   * 详见 src/memory/reranker.ts
   */
  reranker?: IReranker;
  /**
   * 双通道融合排序的权重配置（可选）
   *
   * 自定义语义相似度与记忆 score 的权重比。
   * 不传时使用默认值（vectorScoreWeight=0.6, memoryScoreWeight=0.4）。
   * 详见 src/memory/hybridMerge.ts HybridWeights
   */
  weights?: HybridWeights;
  /** 当前会话 ID，用于同窗口优先排序（可选） */
  sessionId?: string;
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
 * 融合排序算法已提取到 hybridMerge.ts，与 searchHybrid() 共享同一实现
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
    reranker,
    weights,
    sessionId,
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
    // 关键词搜索失败时降级返回已收集的语义结果，与通道 1 降级策略对称
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

  // ── 综合排序：委托给 hybridMerge 纯函数（支持自定义权重） ──
  const sorted = hybridMerge(merged.values(), limit, weights);

  // ── 重排序：reranker 在 hybridMerge 之后执行二次精排（可选） ──
  let reranked = reranker
    ? await reranker.rerank(
        query,
        sorted.map((e) => e.memory),
        { limit },
      )
    : sorted.map((e) => e.memory);

  // ── Phase 2：差异化召回（memory-as-summary §4.2）──
  // 按 type 查时间窗口策略表：preference/decision/fact 不限，intent/general 限近期
  // 未标记 summaryType 的记忆不受 type 时间窗口约束（不命中表即不过滤）
  const nowMs = Date.now();
  reranked = reranked.filter((m) => {
    const type = m.metadata?.summaryType;
    const windowDays = type ? RECALL_WINDOWS_DAYS[type] : undefined;
    if (windowDays === undefined) return true; // 不限窗口或未标记，不过滤
    const ageMs = nowMs - Date.parse(m.createdAt);
    return !Number.isNaN(ageMs) && ageMs <= windowDays * ONE_DAY_MS;
  });

  // ── Phase 3：会话窗口优先 + 组内时间排序（memory-as-summary §4.4）──
  // 排序由两个正交维度构成，类型不参与排序：
  //   维度一：同会话窗口（sessionName 匹配当前会话）优先 → 跨会话记忆次之
  //   维度二：组内按 createdAt 升序，LLM 自然识别"最近偏好"
  // 稳定排序（相等时保持原相对顺序），不破坏 hybridMerge 已选出的候选集
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

  // ── 写路径取代过滤（ADR-021）：被 superseded 的摘要不再作为当前事实注入 ──
  // supersededBy 仅对 round-summary 有意义，其他来源无此字段，过滤安全。
  // 被取代摘要仍保留于存储，可经 traceSummary 回溯历史（非删除）。
  const active = reranked.filter((m) => !m.supersededBy);

  // ── FIX-P1-2：拆分读/写，recall 只读 + boostScores 显式写 ──
  // 在副本上 boost，仅影响本轮上下文排序；持久化由调用方 fire-and-forget 调用 boostScores，
  // 不阻塞读路径，boost 写入失败不影响 chat 流程。
  const now = nowIso();
  const result: Memory[] = active.map((memory) => {
    const copy = { ...memory };
    boostScore(copy, now);
    return copy;
  });

  return result;
}

/**
 * 批量持久化 boost 后的 score（FIX-P1-2：从 recall() 拆分出的显式写操作）
 *
 * 调用方在 recall() 后 fire-and-forget 调用本函数持久化 boost，不阻塞读路径。
 * 失败仅 log 不抛错，避免读路径因 boost 写入失败而中断。
 *
 * 设计权衡：
 *   - 不在 recall() 内部 upsert：消除 IO 写耦合读路径（boost 是软指标，丢失影响小）
 *   - 不引入 dirty 标记 + 治理调度器批量持久化：避免新增状态队列和跨模块依赖
 *   - 立即持久化但 fire-and-forget：boost 数据不丢，读路径不阻塞
 *
 * @param storage 记忆存储实例
 * @param ids 待 boost 的记忆 id 列表（从 recall() 返回结果的 id 字段提取）
 * @param now 当前时间戳（可选，默认 nowIso()）
 */
export async function boostScores(
  storage: IMemoryStorage,
  ids: string[],
  now: string = nowIso(),
): Promise<void> {
  for (const id of ids) {
    // MIND2-L3：改用 incrementScore 原子操作，消除 read-modify-write 并发冲突
    // 原 getById → boostScore → upsert 三步合并为存储层一条原子更新，
    // 与 decayScores 同模式（避免与衰减/去重并发写时基于旧值覆盖）
    storage.incrementScore(id, BOOST_INCREMENT, now);
  }
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
// 模块私有（0 外部消费者，仅 recall.ts 内部调用，与 tokenizeKeywords 同模式）
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
