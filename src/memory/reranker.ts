/**
 * 重排序（Re-ranker）接口
 *
 * RAG 管线增强组件：允许插入不同的重排序策略（如基于 LLM 的打分、MMR 多样性排序等）。
 * IReranker 是可选注入，不强制使用（recall.ts 默认不启用）。
 *
 * 设计原则：
 *   - 接口与实现分离：内核只依赖接口，具体实现由宿主或调用方注入
 *   - 重排序在 hybridMerge 之后执行，作为最终排序的"精排"阶段
 */
import type { Memory } from '@/memory/types.js';

// ─── 重排序接口 ─────────────────────────────────────

/**
 * 重排序选项
 */
export interface RerankerOptions {
  /** 返回数量上限（默认 5） */
  limit?: number;
}

/**
 * 重排序接口 — 对双通道召回结果做二次精排
 *
 * 输入：已通过 hybridMerge 初步排序的结果
 * 输出：重排序后的结果（可能调整顺序，或移除冗余条目）
 *
 * 实现示例：
 *   - 基于混合分数 + 内容长度惩罚的简单排序
 *   - 调用 LLM 对结果与查询的相关性做语义评分
 *   - 最大边际相关性排序，兼顾相关性与多样性
 */
export interface IReranker {
  /**
   * 重排序
   * @param query - 原始查询文本
   * @param results - 已去重的候选记忆列表
   * @param options - 重排序选项
   * @returns 重排序后的记忆列表
   */
  rerank(query: string, results: Memory[], options?: RerankerOptions): Promise<Memory[]>;
}
