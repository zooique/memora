/**
 * 双通道融合排序 — search_memories 工具（searchHybrid）的排序数组。
 * 集中单点维护排序逻辑与常量，agent 直接从本模块导入（agent 不依赖 memory 内部常量分层原则）。
 *
 * 阶段3（2026-09-09）排序纯化：score 权重退役，融合分 = 单语义分 vectorScore 降序。
 * score 单调不减无区分度、且 §5.2 「只 touch 不 +score」后不再更新 → 排序残件，移除 0.4 权重项
 * （memory-tool-recall-design.md §阶段3·3A）。
 */
import type { Memory } from '@/memory/types.js';

// ─── 融合排序常量 ─────────────────────────────────────

/** 语义召回倍率（在最终 limit 基础上多召回，供融合排序后取前 limit） */
export const RECALL_LIMIT_MULTIPLIER = 2;

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
 * 融合排序纯函数：按单语义分 vectorScore 降序取前 limit。
 * 消费者：searchHybrid()（search_memories 工具）融合排序。
 * keyword-only 回退（vectorScore=0）失去 score 平局 → 依赖 stable-sort 插入序，可接受（兜底后端无主序语义）。
 */
export function hybridMerge(
  entries: Iterable<HybridMergeEntry>,
  limit: number,
): HybridMergeEntry[] {
  return [...entries]
    .sort((a, b) => b.vectorScore - a.vectorScore)
    .slice(0, limit);
}