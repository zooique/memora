/**
 * 重排序（Re-ranker）+ 上下文压缩
 *
 * RAG 管线增强组件：
 * 1. IReranker 接口：允许插入不同的重排序策略（如基于 LLM 的打分、MMR 多样性排序等）
 * 2. ContextCompressor：裁剪冗余内容，保留最相关的信息片段
 *
 * 设计原则：
 *   - IReranker 是可选注入，不强制使用（recall.ts 默认不启用）
 *   - 重排序在 hybridMerge 之后执行，作为最终排序的"精排"阶段
 *   - ContextCompressor 是纯函数，无副作用，可独立测试
 *
 * 使用场景：
 *   - 双通道召回后，对 topK 结果做二次精排（如 MMR 去重 / LLM 评分）
 *   - 将长记忆内容压缩到 LLM 上下文窗口内
 *
 * 详见 ADR-004 · 记忆统一模型
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
 *   - DefaultReranker：基于混合分数 + 内容长度惩罚的简单排序
 *   - LLMReranker：调用 LLM 对结果与查询的相关性做语义评分
 *   - MMRReranker：最大边际相关性排序，兼顾相关性与多样性
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

// ─── 默认重排序实现 ─────────────────────────────────

/**
 * 默认重排序器 — 内容长度惩罚排序
 *
 * 算法：在 hybridMerge 综合分数基础上，对过长内容做轻微惩罚，
 * 避免单条超长记忆占据过多上下文。
 *
 * 最终分数 = 综合分数 * (1 - contentLengthPenalty)
 * 其中 contentLengthPenalty = clamp(content.length / 2000, 0, 0.2)
 *
 * 适用范围：hybridMerge 的线性加权无法区分"长而冗余 vs 短而精准"时，
 * 本实现通过对超长内容降权，优先展示精炼的记忆。
 */
export class DefaultReranker implements IReranker {
  /**
   * 重排序：基于内容长度惩罚调整排序
   *
   * @param query - 原始查询文本（默认实现未使用，为 LLMReranker 预留）
   * @param results - 候选记忆列表
   * @param options - 重排序选项（limit 截断）
   * @returns 重排序后的记忆列表
   */
  async rerank(_query: string, results: Memory[], options: RerankerOptions = {}): Promise<Memory[]> {
    const { limit = 5 } = options;

    // 不足 limit 时无需重排序
    if (results.length <= 1) return results;

    // 计算每条记忆的最终分数（综合分数基础上加内容长度惩罚）
    const scored = results.map((memory) => ({
      memory,
      // 内容长度惩罚：超过 2000 字符的部分每千字降权 10%，上限 20%
      contentLengthPenalty: Math.min(memory.content.length / 10000, 0.2),
    }));

    // 按原始分数（score）降序，但同分时内容短者优先
    // 此时 score 已包含 hybridMerge 的综合分数（或纯关键词 score）
    scored.sort((a, b) => {
      // 调整后分数 = score - 长度惩罚
      const adjustedA = a.memory.score - a.contentLengthPenalty;
      const adjustedB = b.memory.score - b.contentLengthPenalty;
      // 分数差异大于 0.05 时按分数排序
      if (Math.abs(adjustedA - adjustedB) > 0.05) {
        return adjustedB - adjustedA;
      }
      // 分数相近时，内容短者优先
      return a.memory.content.length - b.memory.content.length;
    });

    return scored.slice(0, limit).map((s) => s.memory);
  }
}

// ─── 上下文压缩 ─────────────────────────────────────

/**
 * 上下文压缩选项
 */
export interface ContextCompressionOptions {
  /** 最大总字符数（默认 4000） */
  maxTotalChars?: number;
  /** 单条记忆最大字符数（默认 1500） */
  maxPerEntry?: number;
}

/**
 * 上下文压缩结果
 */
export interface CompressedContext {
  /** 压缩后的记忆列表 */
  memories: Memory[];
  /** 原始总字符数 */
  originalChars: number;
  /** 压缩后总字符数 */
  compressedChars: number;
  /** 被截断的记忆 id 列表 */
  truncatedIds: string[];
}

/**
 * 上下文压缩 — 在将记忆注入 LLM 上下文前裁剪冗余内容
 *
 * 策略：
 * 1. 按 score 降序排列（最高分优先保留完整内容）
 * 2. 单条超长记忆截断到 maxPerEntry
 * 3. 总字符数超过 maxTotalChars 时，截断后续记忆
 * 4. 被截断的记忆在末尾添加 "… (已截断)"
 *
 * @param memories - 待压缩的记忆列表
 * @param options - 压缩选项
 * @returns 压缩后的上下文信息
 */
export function compressContext(
  memories: Memory[],
  options: ContextCompressionOptions = {},
): CompressedContext {
  const {
    maxTotalChars = 4000,
    maxPerEntry = 1500,
  } = options;

  if (memories.length === 0) {
    return { memories: [], originalChars: 0, compressedChars: 0, truncatedIds: [] };
  }

  // 按 score 降序排列（确保重要记忆优先保留完整内容）
  const sorted = [...memories].sort((a, b) => b.score - a.score);

  const originalChars = sorted.reduce((sum, m) => sum + m.content.length, 0);
  const truncatedIds: string[] = [];
  const result: Memory[] = [];

  let totalChars = 0;

  for (const memory of sorted) {
    // 单条截断
    let content = memory.content;
    if (content.length > maxPerEntry) {
      content = content.slice(0, maxPerEntry) + '… (已截断)';
      truncatedIds.push(memory.id);
    }

    // 总字符数限制
    if (totalChars + content.length > maxTotalChars) {
      // 当前记忆只保留摘要（前 200 字符）
      content = content.slice(0, 200) + '… (已截断)';
      if (!truncatedIds.includes(memory.id)) {
        truncatedIds.push(memory.id);
      }
    }

    result.push({
      ...memory,
      content,
    });

    totalChars += content.length;

    // 如果已用尽总配额，不再添加更多记忆
    if (totalChars >= maxTotalChars) {
      break;
    }
  }

  const compressedChars = result.reduce((sum, m) => sum + m.content.length, 0);

  return { memories: result, originalChars, compressedChars, truncatedIds };
}