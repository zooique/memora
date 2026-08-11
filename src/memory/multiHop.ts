/**
 * 多跳推理（Multi-hop Reasoning）管线
 *
 * RAG 管线增强组件：当单次召回无法满足复杂查询时，
 * 通过迭代搜索 - 分析 - 再搜索的循环，逐步深入获取完整信息。
 *
 * 设计原则：
 *   - 无状态纯函数：每次调用独立，不依赖外部状态
 *   - 可配置跳数：默认 2 跳，调用方可根据场景调整
 *   - 信息聚合：多跳结果合并去重，避免冗余
 *   - 降级策略：单跳失败不影响已收集的结果
 *
 * 使用场景：
 *   - 需要多个维度信息才能回答的复杂问题（如"用户对某产品的所有反馈"）
 *   - 初始查询过于宽泛，需要逐步聚焦
 *   - 信息分散在不同记忆片段中，需要串联
 *
 * 典型流程：
 *   跳 1: 搜索 query → 得到结果 A、B
 *   跳 2: 从结果 A 中提取关键词 → 生成子查询 → 搜索 → 得到结果 C、D
 *   聚合: A、B、C、D 合并去重后返回
 *
 * 详见 ADR-004 · 记忆统一模型
 */
import type { Memory } from '@/memory/types.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import type { IVectorStore } from '@/memory/vectorStore.js';
import type { IReranker } from '@/memory/reranker.js';
import type { HybridWeights } from '@/memory/hybridMerge.js';
import { recall, extractKeywords } from '@/memory/recall.js';
import { logger } from '@/logging/logger.js';

// ─── 查询扩展策略 ─────────────────────────────────────

/**
 * 查询扩展策略 — 控制多跳推理中子查询的生成方式
 *
 * 默认策略：从上一跳结果中提取关键词，与原始查询组合成新子查询。
 * 宿主可注入自定义策略实现更复杂的扩展逻辑（如 LLM 生成子查询）。
 */
export interface IQueryExpander {
  /**
   * 基于原始查询和上一跳结果生成子查询
   *
   * @param originalQuery - 原始查询文本
   * @param previousResults - 上一跳的结果记忆列表
   * @param hopIndex - 当前跳数索引（从 1 开始）
   * @returns 子查询列表（多个子查询可并行执行）
   */
  expand(originalQuery: string, previousResults: Memory[], hopIndex: number): string[];
}

/**
 * 默认查询扩展器 — 基于关键词提取
 *
 * 从上一跳最高分的记忆内容中提取关键词，
 * 与原始查询组合生成子查询。
 */
export class DefaultQueryExpander implements IQueryExpander {
  /**
   * 扩展查询：从上一跳结果中提取关键词 + 原始查询组合
   *
   * 策略：
   * 1. 取上一跳 top 3 记忆
   * 2. 从每条记忆内容中提取关键词
   * 3. 每个关键词 + 原始查询组成一个子查询
   * 4. 去重后返回
   *
   * @param originalQuery - 原始查询
   * @param previousResults - 上一跳结果
   * @param _hopIndex - 当前跳数（未使用，为自定义策略预留）
   * @returns 子查询列表
   */
  expand(originalQuery: string, previousResults: Memory[], _hopIndex: number): string[] {
    if (previousResults.length === 0) return [];

    // 取 top 3 记忆（按 score 降序）
    const topResults = [...previousResults]
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    const subQueries = new Set<string>();

    for (const memory of topResults) {
      // 从记忆内容中提取关键词
      const keywords = extractKeywords(memory.content);
      if (keywords.length === 0) continue;

      // 取前 3 个关键词与原始查询组合
      const topKeywords = keywords.slice(0, 3);
      // 组合子查询：原始查询 + 关键词
      const subQuery = `${originalQuery} ${topKeywords.join(' ')}`;
      subQueries.add(subQuery);
    }

    return [...subQueries];
  }
}

// ─── 多跳推理选项 ─────────────────────────────────────

/**
 * 多跳推理选项
 */
export interface MultiHopOptions {
  /** 每跳返回数量上限（默认 3） */
  limitPerHop?: number;
  /** 最终聚合后返回数量上限（默认 5） */
  finalLimit?: number;
  /** 最多跳数（默认 2，建议不超过 3） */
  maxHops?: number;
  /** 向量存储（可选，提供时启用语义搜索） */
  vectorStore?: IVectorStore;
  /** 语义搜索相似度阈值（默认 0.3） */
  minSimilarity?: number;
  /** 重排序器（可选，在最终聚合后执行精排） */
  reranker?: IReranker;
  /** 双通道融合排序权重（可选） */
  weights?: HybridWeights;
  /** 查询扩展器（可选，默认 DefaultQueryExpander） */
  queryExpander?: IQueryExpander;
  /** 排除的 source 标签 */
  excludeSources?: string[];
}

/**
 * 多跳推理结果
 */
export interface MultiHopResult {
  /** 聚合后的记忆列表 */
  memories: Memory[];
  /** 实际执行的跳数 */
  hopsExecuted: number;
  /** 每跳的结果数量 */
  resultsPerHop: number[];
  /** 总命中数（去重前） */
  totalHits: number;
}

// ─── 多跳推理函数 ─────────────────────────────────────

/**
 * 多跳推理 — 迭代搜索，逐步深入
 *
 * 工作流程：
 * 1. 第 1 跳：使用 recall() 搜索原始 query
 * 2. 如果有结果且未达到 maxHops：
 *    a. 从结果中提取关键词（使用 queryExpander）
 *    b. 生成子查询
 *    c. 对每个子查询执行 recall()
 *    d. 合并结果去重
 * 3. 重复直到达到 maxHops 或没有新结果
 * 4. 聚合所有跳的结果，去重后返回
 *
 * @param storage - 记忆存储实例
 * @param query - 原始查询文本
 * @param options - 多跳推理选项
 * @returns 多跳推理结果（聚合去重后的记忆列表 + 元信息）
 */
export async function multiHopRecall(
  storage: IMemoryStorage,
  query: string,
  options: MultiHopOptions = {},
): Promise<MultiHopResult> {
  const {
    limitPerHop = 3,
    finalLimit = 5,
    maxHops = 2,
    vectorStore,
    minSimilarity = 0.3,
    reranker,
    weights,
    queryExpander = new DefaultQueryExpander(),
    excludeSources,
  } = options;

  const allMemories = new Map<string, Memory>();
  const resultsPerHop: number[] = [];

  // ── 第 1 跳：搜索原始 query ──
  const firstHop = await recall(storage, query, {
    limit: limitPerHop,
    vectorStore,
    minSimilarity,
    reranker,     // 第 1 跳也应用 reranker（如果提供）
    weights,
    excludeSources,
  });

  for (const m of firstHop) {
    allMemories.set(m.id, m);
  }
  resultsPerHop.push(firstHop.length);

  // ── 后续跳：迭代搜索 ──
  let currentResults = firstHop;

  for (let hop = 1; hop < maxHops; hop++) {
    // 当前跳无结果时提前终止
    if (currentResults.length === 0) {
      logger.debug({ hop, query }, '多跳推理：当前跳无结果，提前终止');
      break;
    }

    // 生成子查询
    const subQueries = queryExpander.expand(query, currentResults, hop);

    if (subQueries.length === 0) {
      logger.debug({ hop, query }, '多跳推理：查询扩展器未生成子查询，提前终止');
      break;
    }

    // 对每个子查询执行 recall
    let hopNewCount = 0;
    for (const subQuery of subQueries) {
      const hopResults = await recall(storage, subQuery, {
        limit: limitPerHop,
        vectorStore,
        minSimilarity,
        // 子查询不应用 reranker（避免重复精排），最终聚合后统一排序
        weights,
        excludeSources,
      });

      for (const m of hopResults) {
        if (!allMemories.has(m.id)) {
          allMemories.set(m.id, m);
          hopNewCount++;
        }
      }
    }

    resultsPerHop.push(hopNewCount);

    // 无新结果时提前终止
    if (hopNewCount === 0) {
      logger.debug({ hop, query }, '多跳推理：无新结果，提前终止');
      break;
    }

    // 更新 currentResults 为最新结果（供下一跳扩展使用）
    currentResults = Array.from(allMemories.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limitPerHop);
  }

  // ── 聚合结果 ──
  let finalMemories = Array.from(allMemories.values())
    .sort((a, b) => b.score - a.score);

  // 应用 reranker（如果提供且未在第 1 跳使用简单 reranker）
  if (reranker) {
    finalMemories = await reranker.rerank(query, finalMemories, { limit: finalLimit });
  } else {
    finalMemories = finalMemories.slice(0, finalLimit);
  }

  return {
    memories: finalMemories,
    hopsExecuted: resultsPerHop.length,
    resultsPerHop,
    totalHits: allMemories.size,
  };
}