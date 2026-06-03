/**
 * 记忆召回管线
 *
 * 启动时：基础召回（always + domain 记忆，100% 确定性）
 * Loop 中：增量召回（topic + on-demand 记忆，按相关度）
 * M-206：混合召回（关键词 + 向量语义，取并集去重）
 *
 * 详见 02-上下文组装-v4.0.md §1-4
 * 详见 00-记忆归档原则-v1.0.md · 信息不对称原则
 */
import type { Memory, MemoryTypeValue } from './types.js';
import type { MemoryIndex } from './index.js';
import type { VectorStore } from './vector-store.js';

export interface RecallOptions {
  types?: MemoryTypeValue[]; // 限定类型
  topK?: number; // 返回数量上限
  minWeight?: number; // 最低权重阈值
  minSimilarity?: number; // 最低语义相似度阈值（0~1，M-206）
  useVector?: boolean; // 是否启用向量语义搜索（M-206）
}

export class RecallPipeline {
  constructor(
    private readonly index: MemoryIndex,
    private readonly vectorStore?: VectorStore,
  ) {}

  /**
   * 基础召回：启动时调用
   * 加载所有 always + domain 记忆
   */
  async bootstrap(): Promise<Memory[]> {
    const always = await this.index.getByPermanence('always');
    const domain = await this.index.getByPermanence('domain');
    return [...always, ...domain];
  }

  /**
   * 增量召回：Agent Loop 中调用
   * 基于查询文本检索相关话题/能力记忆
   *
   * M-206：混合搜索策略
   * 1. 关键词搜索（LIKE，已有）
   * 2. 向量语义搜索（embedding + 余弦相似度，新增）
   * 3. 取并集去重，按权重 × 相似度综合排序
   */
  async recall(query: string, opts: RecallOptions = {}): Promise<Memory[]> {
    const { topK = 5, minWeight = 0, minSimilarity = 0.3, useVector = false } = opts;

    // 阶段一：关键词搜索
    const keywordResults = await this.index.search(query, topK * 3);

    // M-206：向量语义搜索（可选）
    const vectorIds: Set<string> = new Set();
    const similarityMap = new Map<string, number>();
    if (useVector && this.vectorStore) {
      const vectorResults = await this.vectorStore.search(query, topK * 2, minSimilarity);
      for (const { id, similarity } of vectorResults) {
        vectorIds.add(id);
        similarityMap.set(id, similarity);
      }
    }

    // 合并：关键词结果的 ID + 向量结果的 ID
    const allIds = new Set<string>();
    for (const m of keywordResults) {
      allIds.add(m.id);
    }
    for (const id of vectorIds) {
      allIds.add(id);
    }

    // 向量搜索命中的但关键词搜索未命中的，需要从索引加载
    const keywordMap = new Map<string, Memory>();
    for (const m of keywordResults) {
      keywordMap.set(m.id, m);
    }

    // 加载向量命中但关键词未命中的记忆
    const missingIds = [...vectorIds].filter((id) => !keywordMap.has(id));
    if (missingIds.length > 0) {
      // 从索引按 ID 加载（需要逐个查询，因为 search 只支持文本搜索）
      for (const id of missingIds) {
        const memory = await this.index.getById(id);
        if (memory) keywordMap.set(id, memory);
      }
    }

    // 过滤 + 排序
    const candidates = [...keywordMap.values()]
      .filter((m) => m.weight >= minWeight)
      .filter((m) => !opts.types || opts.types.includes(m.type));

    // 综合排序：权重 × 相似度（如果有向量结果则加权，否则纯权重排序）
    candidates.sort((a, b) => {
      const scoreA = a.weight * (similarityMap.get(a.id) ?? 1.0);
      const scoreB = b.weight * (similarityMap.get(b.id) ?? 1.0);
      return scoreB - scoreA;
    });

    return candidates.slice(0, topK);
  }
}
