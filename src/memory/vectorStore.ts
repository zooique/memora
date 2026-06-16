/**
 * 向量存储 — 纯 JS 实现，内存 + JSON 持久化
 *
 * M-206：语义检索的向量索引层
 * - 存储记忆 ID → 向量的映射
 * - 支持余弦相似度搜索（topK）
 * - 持久化到 JSON 文件（冷启动时加载）
 *
 * 设计原则：
 * - 0 新 npm 依赖（不引入 sqlite-vec / LanceDB 等外部向量库）
 * - 单用户本地场景，5k 条记录内纯 JS 余弦相似度 < 10ms
 * - 向量维度由 embedding 模型决定，存储层不关心
 *
 * 详见 ADR-002 · 存储层抽象（向量检索备选方案）
 * 详见 ADR-013 · 记忆归档三步价值过滤
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { logger } from '@/logging/logger.js';
import { cosineSimilarity } from '@/utils/math.js';

/**
 * 嵌入服务接口（原 memory/types.ts 导出，重构后内联）
 * 向量存储依赖此接口生成文本嵌入向量
 *
 * batchEmbed 返回向量数组，顺序与输入一致。
 * EmbeddingProvider（llm/embedding.ts）满足此接口（结构子类型）。
 */
export interface EmbeddingService {
   embed(text: string): Promise<number[]>;
   batchEmbed(texts: string[]): Promise<Array<{ text: string; vector: number[] }>>;
}

/**
 * 向量条目：ID + 向量
 */
interface VectorEntry {
  id: string;
  vector: number[];
}

/**
 * 持久化 JSON 格式
 */
interface VectorStoreFile {
  /** 存储版本（未来格式变更时做迁移） */
  version: 1;
  /** 向量维度（所有向量必须一致） */
  dimension: number;
  /** 向量条目 */
  entries: VectorEntry[];
}

/**
 * 向量存储
 *
 * 纯 JS 实现，内存中维护向量索引，定期持久化到 JSON 文件
 * 适用于单用户本地场景（5k 条记录以内）
 *
 * 分层修复（年轮审判 R-03）：依赖 EmbeddingService 接口而非 llm/ 层的具体实现
 */
export class VectorStore {
  /** 内存中的向量索引 */
  private entries = new Map<string, number[]>();

  /** 向量维度（由第一个插入的向量决定） */
  private dimension = 0;

  /** 是否有未持久化的变更 */
  private dirty = false;

  constructor(
    private readonly storePath: string,
    private readonly embeddingProvider: EmbeddingService,
  ) {}

  /**
   * 从 JSON 文件加载向量索引（冷启动）
   */
  async load(): Promise<void> {
    try {
      const content = await readFile(this.storePath, 'utf-8');
      const data = JSON.parse(content) as VectorStoreFile;
      this.dimension = data.dimension;
      this.entries.clear();
      for (const entry of data.entries) {
        this.entries.set(entry.id, entry.vector);
      }
      this.dirty = false;
      logger.info({ count: this.entries.size, dimension: this.dimension }, '向量索引加载完成');
    } catch {
      // 文件不存在或格式错误，从空开始
      logger.info({ path: this.storePath }, '向量索引文件不存在，从空开始');
    }
  }

  /**
   * 持久化向量索引到 JSON 文件
   */
  async save(): Promise<void> {
    if (!this.dirty) return;

    const data: VectorStoreFile = {
      version: 1,
      dimension: this.dimension,
      entries: Array.from(this.entries.entries()).map(([id, vector]) => ({ id, vector })),
    };

    await mkdir(dirname(this.storePath), { recursive: true });
    await writeFile(this.storePath, JSON.stringify(data), 'utf-8');
    this.dirty = false;
    logger.info({ count: this.entries.size }, '向量索引持久化完成');
  }

  /**
   * 为文本生成向量并存储
   * @param id 记忆 ID
   * @param text 待嵌入的文本
   */
  async upsert(id: string, text: string): Promise<void> {
    const vector = await this.embeddingProvider.embed(text);
    if (this.dimension === 0) {
      this.dimension = vector.length;
    }
    this.entries.set(id, vector);
    this.dirty = true;
  }

  /**
   * 批量嵌入并存储
   * @param items ID + 文本对
   */
  async batchUpsert(items: Array<{ id: string; text: string }>): Promise<void> {
    const texts = items.map((item) => item.text);
    const results = await this.embeddingProvider.batchEmbed(texts);

    for (let i = 0; i < items.length; i++) {
      const result = results[i];
      if (!result) continue;
      if (this.dimension === 0) {
        this.dimension = result.vector.length;
      }
      this.entries.set(items[i]!.id, result.vector);
    }
    this.dirty = true;
  }

  /**
   * 删除向量
   */
  delete(id: string): void {
    this.entries.delete(id);
    this.dirty = true;
  }

  /**
   * 语义搜索：基于查询文本的向量，返回 topK 最相似的 ID
   * @param query 查询文本
   * @param topK 返回数量上限
   * @param minSimilarity 最低相似度阈值（0~1）
   * @returns ID + 相似度 对的数组，按相似度降序排列
   */
  async search(
    query: string,
    topK = 5,
    minSimilarity = 0.3,
  ): Promise<Array<{ id: string; similarity: number }>> {
    const queryVector = await this.embeddingProvider.embed(query);

    const scored: Array<{ id: string; similarity: number }> = [];
    for (const [id, vector] of this.entries) {
      const similarity = cosineSimilarity(queryVector, vector);
      if (similarity >= minSimilarity) {
        scored.push({ id, similarity });
      }
    }

    // 按相似度降序排列，取 topK
    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, topK);
  }

  /**
   * 获取存储的向量数量
   */
  get size(): number {
    return this.entries.size;
  }
}