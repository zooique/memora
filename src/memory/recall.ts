/**
 * 记忆召回管线
 *
 * 启动时：基础召回（always + domain 记忆，100% 确定性）
 * Loop 中：增量召回（topic + on-demand 记忆，按相关度）
 * 详见 agent上下文组装协议.md §1-4
 */
import type { Memory, MemoryTypeValue } from './types.js';
import type { MemoryIndex } from './index.js';

export interface RecallOptions {
  types?: MemoryTypeValue[]; // 限定类型
  topK?: number; // 返回数量上限
  minWeight?: number; // 最低权重阈值
}

export class RecallPipeline {
  constructor(private readonly index: MemoryIndex) {}

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
   */
  async recall(query: string, opts: RecallOptions = {}): Promise<Memory[]> {
    const { topK = 5, minWeight = 0 } = opts;

    // 阶段一：LIKE 搜索
    // 阶段二：FTS5
    // 阶段三：FTS5 + 向量混合
    const candidates = await this.index.search(query, topK * 3);

    return candidates
      .filter((m) => m.weight >= minWeight)
      .filter((m) => !opts.types || opts.types.includes(m.type))
      .slice(0, topK);
  }
}
