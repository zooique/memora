/**
 * 双通道融合排序 — 共享给 recall() 与 searchHybrid()。
 * 集中单点维护排序逻辑与常量，agent 直接从本模块导入，不绕道 recall.ts（agent 不依赖 memory 内部常量分层原则）
 */
import type { Memory } from '@/memory/types.js';

// ─── 融合排序常量 ─────────────────────────────────────

/** 语义召回倍率（在最终 limit 基础上多召回，供融合排序后取前 limit） */
export const RECALL_LIMIT_MULTIPLIER = 2;

/**
 * 语义相似度权重（0.6）：向量通道权重高于 score 通道（score 受编辑/衰减/默认值影响不确定性高）；
 * 但 score 仍占 0.4 以抑制"向量相似但 score 极低"的边缘记忆、提升高频/人工标注记忆；
 * 非 0.7/0.3 是避免向量通道压倒性优势、保留 score 话语权
 */
export const DEFAULT_VECTOR_SCORE_WEIGHT = 0.6;

/** 记忆 score 权重（0.4 = 1 - 0.6），理由见上 */
export const DEFAULT_MEMORY_SCORE_WEIGHT = 0.4;

/**
 * 双通道融合权重（经 RecallOptions.weights 传入；不传用默认 0.6/0.4）。
 * 调优：向量质量高→升 vectorScoreWeight；score 可靠→升 memoryScoreWeight
 */
export interface HybridWeights {
  /** 语义相似度权重（0~1，默认 0.6） */
  vectorScoreWeight?: number;
  /** 记忆 score 权重（0~1，默认 0.4） */
  memoryScoreWeight?: number;
}

// ─── 类型 ─────────────────────────────────────────────

/**
 * 双通道合并条目：memory + 它在向量通道的相似度分数（仅关键词命中时为 0）
 */
export interface HybridMergeEntry {
  /** 记忆对象 */
  memory: Memory;
  /** 向量相似度分数（0~1，仅关键词命中时为 0） */
  vectorScore: number;
}

// ─── 融合排序纯函数 ───────────────────────────────────

/**
 * 双通道融合排序纯函数：按 vectorScore*vw + memory.score*mw 降序取前 limit（默认 0.6/0.4）。
 * 共享消费者：recall() 召回融合排序 · searchHybrid() 搜索融合排序
 */
export function hybridMerge(
  entries: Iterable<HybridMergeEntry>,
  limit: number,
  weights?: HybridWeights,
): HybridMergeEntry[] {
  const vw = weights?.vectorScoreWeight ?? DEFAULT_VECTOR_SCORE_WEIGHT;
  const mw = weights?.memoryScoreWeight ?? DEFAULT_MEMORY_SCORE_WEIGHT;
  return [...entries]
    .sort((a, b) => {
      const scoreA = a.vectorScore * vw + a.memory.score * mw;
      const scoreB = b.vectorScore * vw + b.memory.score * mw;
      return scoreB - scoreA;
    })
    .slice(0, limit);
}