/**
 * 双通道融合排序 — 共享给 recall() 和 searchHybrid()
 *
 * P1-05 提取（2026-07）：
 * 原先 recall.ts 和 memoryInspector.ts 各自实现一份"向量通道 + 关键词通道合并排序"逻辑，
 * 算法逐行重复，且 memoryInspector 跨模块从 recall.ts 导入 3 个常量
 * （RECALL_LIMIT_MULTIPLIER / VECTOR_SCORE_WEIGHT / MEMORY_SCORE_WEIGHT），
 * 违反"agent 不依赖 memory 内部常量"分层原则。
 *
 * 提取到独立模块后：
 *   - 算法单点维护（排序权重调整只需改一处）
 *   - 常量与算法同源，agent 直接从 hybridMerge 导入，不再绕道 recall.ts
 *   - recall.ts 仍 re-export 这 3 个常量，保持向后兼容（测试文件已引用）
 *
 * 详见 ADR-004 · 记忆统一模型 + architecture_philosophy_rules.md §6 增量召回
 */
import type { Memory } from '@/memory/types.js';

// ─── 融合排序常量 ─────────────────────────────────────

/** 语义搜索召回倍率（在最终 limit 基础上多召回一些，供后续融合排序） */
export const RECALL_LIMIT_MULTIPLIER = 2;

/** 综合排序时语义相似度权重 */
export const VECTOR_SCORE_WEIGHT = 0.6;

/** 综合排序时记忆 score 权重 */
export const MEMORY_SCORE_WEIGHT = 0.4;

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
