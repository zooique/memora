/**
 * 双通道融合排序 — 共享给 recall() 和 searchHybrid()
 *
 * 设计动机：
 * recall.ts 和 memoryInspector.ts 共用"向量通道 + 关键词通道合并排序"逻辑，
 * 集中到此模块实现单点维护。常量（RECALL_LIMIT_MULTIPLIER /
 * VECTOR_SCORE_WEIGHT / MEMORY_SCORE_WEIGHT）与算法同源，
 * agent 直接从本模块导入，不再绕道 recall.ts，遵守"agent 不依赖 memory
 * 内部常量"分层原则。
 *
 * 收益：
 *   - 算法单点维护（排序权重调整只需改一处）
 *   - 常量与算法同源，agent 直接从 hybridMerge 导入，不再绕道 recall.ts
 *
 * 详见 ADR-004 · 记忆统一模型 + architecture_philosophy_rules.md §6 增量召回
 */
import type { Memory } from '@/memory/types.js';

// ─── 融合排序常量 ─────────────────────────────────────

/** 语义搜索召回倍率（在最终 limit 基础上多召回一些，供后续融合排序） */
export const RECALL_LIMIT_MULTIPLIER = 2;

/**
 * 默认综合排序时语义相似度权重（0.6）
 *
 * 设计理由：向量通道权重高于记忆 score 通道（0.6 > 0.4），因为：
 *   - 语义相似度由嵌入模型实时计算，反映查询与内容的语义相关性
 *   - 记忆 score 受人工编辑、boost 衰减、初始默认值（0.5）等多因素影响，
 *     不确定性更高
 *   - 但记忆 score 仍占 0.4 权重，用于：
 *     1) 抑制向量相似但 score 过低（用户从未认可）的边缘记忆
 *     2) 提升 score 高（频繁召回/人工标注重要）的记忆排名
 *   - 0.6/0.4 而非 0.7/0.3 是为避免向量通道压倒性优势，保留 score 通道的话语权
 */
export const DEFAULT_VECTOR_SCORE_WEIGHT = 0.6;

/**
 * 默认综合排序时记忆 score 权重（0.4）
 *
 * 与 DEFAULT_VECTOR_SCORE_WEIGHT 互补（0.4 = 1 - 0.6），设计理由见上
 */
export const DEFAULT_MEMORY_SCORE_WEIGHT = 0.4;

/**
 * 混合检索权重配置
 *
 * 通过 recall() 的 RecallOptions.weights 传入，自定义双通道融合排序的权重。
 * 不传时使用默认值（0.6 / 0.4）。
 *
 * 典型调优场景：
 *   - 向量质量高（如使用更好的 embedding 模型）：提高 vectorScoreWeight（如 0.8）
 *   - 记忆 score 可靠（如用户频繁标注重要性）：提高 memoryScoreWeight（如 0.6）
 *   - 关键词搜索比向量搜索更准确：降低 vectorScoreWeight（如 0.4）
 */
export interface HybridWeights {
  /** 语义相似度权重（0~1，默认 0.6） */
  vectorScoreWeight?: number;
  /** 记忆 score 权重（0~1，默认 0.4） */
  memoryScoreWeight?: number;
}

// ─── 类型 ─────────────────────────────────────────────

/**
 * 双通道合并结果条目
 *
 * 一条记忆在合并 Map 中的状态：memory + 它在向量通道的相似度分数。
 * vectorScore = 0 表示该记忆仅来自关键词通道（未命中向量索引）。
 */
export interface HybridMergeEntry {
  /** 记忆对象 */
  memory: Memory;
  /** 向量相似度分数（0~1，仅关键词命中时为 0） */
  vectorScore: number;
}

// ─── 融合排序纯函数 ───────────────────────────────────

/**
 * 双通道融合排序的纯函数
 *
 * 算法：按 vectorScore * vectorScoreWeight + memory.score * memoryScoreWeight 降序排列，
 * 取前 limit 条。权重可通过 options 自定义，默认 0.6 / 0.4。
 *
 * 输入：已去重的合并 Map 的 values（或任何可迭代的 HybridMergeEntry）
 * 输出：排序后的数组（前 limit 条）
 *
 * 共享消费者：
 *   - recall.ts recall() — 召回时融合排序（+ boost + 写回存储）
 *   - memoryInspector.ts searchHybrid() — 搜索时融合排序（→ AgentSearchHit）
 *
 * @param entries - 双通道合并后的条目（调用方负责去重）
 * @param limit - 返回数量上限
 * @param weights - 可选的自定义权重配置
 * @returns 排序后的 HybridMergeEntry 数组
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
      // 综合分数 = 向量相似度 * vectorScoreWeight + 记忆 score * memoryScoreWeight
      const scoreA = a.vectorScore * vw + a.memory.score * mw;
      const scoreB = b.vectorScore * vw + b.memory.score * mw;
      return scoreB - scoreA;
    })
    .slice(0, limit);
}
