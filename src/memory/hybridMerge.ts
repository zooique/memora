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
 * 综合排序时语义相似度权重（模块内部使用，非公共 API）
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
const VECTOR_SCORE_WEIGHT = 0.6;

/**
 * 综合排序时记忆 score 权重（模块内部使用，非公共 API）
 *
 * 与 VECTOR_SCORE_WEIGHT 互补（0.4 = 1 - 0.6），设计理由见 VECTOR_SCORE_WEIGHT 注释
 */
const MEMORY_SCORE_WEIGHT = 0.4;

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
 * 算法：按 vectorScore * VECTOR_SCORE_WEIGHT + memory.score * MEMORY_SCORE_WEIGHT 降序排列，
 * 取前 limit 条。
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
 * @returns 排序后的 HybridMergeEntry 数组
 */
export function hybridMerge(
  entries: Iterable<HybridMergeEntry>,
  limit: number,
): HybridMergeEntry[] {
  return [...entries]
    .sort((a, b) => {
      // 综合分数 = 向量相似度 * 0.6 + 记忆 score * 0.4
      const scoreA = a.vectorScore * VECTOR_SCORE_WEIGHT + a.memory.score * MEMORY_SCORE_WEIGHT;
      const scoreB = b.vectorScore * VECTOR_SCORE_WEIGHT + b.memory.score * MEMORY_SCORE_WEIGHT;
      return scoreB - scoreA;
    })
    .slice(0, limit);
}
