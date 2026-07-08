/**
 * 向量存储 — 纯 JS 实现，内存 + JSON 持久化
 *
 * 语义检索的向量索引层：
 * - 存储记忆 ID → 向量的映射
 * - 支持余弦相似度搜索（topK）
 * - 持久化到 JSON 文件（冷启动时加载）
 *
 * 设计原则：
 * - 0 新 npm 依赖（不引入 sqlite-vec / LanceDB 等外部向量库）
 * - 单用户本地场景，5k 条记录内纯 JS 余弦相似度 < 10ms
 * - 向量维度由 embedding 模型决定，存储层不关心
 *
 * 加固点：
 * - load() 增加 schema 校验（防止损坏文件污染内存索引）
 * - upsert/batchUpsert 增加维度一致性校验（防止维度错位导致相似度计算崩溃）
 * - save() 串行化（防止并发 save 互相覆盖丢失数据）
 * - delete() JSDoc 明确"需显式 save"约定
 *
 * 详见 ADR-002 · 存储层抽象（向量检索备选方案）
 * 详见 ADR-013 · 记忆归档三步价值过滤
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { logger } from '@/logging/logger.js';
import { configError } from '@/utils/errors.js';
import { cosineSimilarity } from '@/utils/math.js';
import type { EmbeddingOptions } from '@/llm/embedding.js';

/**
 * 嵌入服务接口
 * 向量存储依赖此接口生成文本嵌入向量
 *
 * batchEmbed 返回向量数组，顺序与输入一致。
 * EmbeddingProvider（llm/embedding.ts）满足此接口（结构子类型）。
 *
 * P1-8 韧性补齐：embed/batchEmbed 接受 EmbeddingOptions（signal + timeoutMs），
 * 宿主在用户取消对话时可透传 AbortSignal 中断 embedding 请求。
 */
export interface EmbeddingService {
   embed(text: string, options?: EmbeddingOptions): Promise<number[]>;
   batchEmbed(texts: string[], options?: EmbeddingOptions): Promise<Array<{ text: string; vector: number[] }>>;
}

/**
 * 向量存储接口（依赖倒置）
 *
 * 抽出接口让宿主可注入自定义实现（如 SqliteVectorStore / LanceDBVectorStore），
 * 内核消费者（recall.ts / memoryInspector.ts / agent.ts）只依赖此接口，
 * 不耦合具体持久化方式（JSON / SQLite / 外部向量库）。
 *
 * 与 IMemoryStorage / IMemoryRelationStore / ILogger / ITracer 同属
 * 内核六大注入接口，遵循 ADR-002 存储层抽象原则。
 *
 * 内核内置实现：JsonVectorStore（JSON 文件持久化，单用户本地场景）。
 */
export interface IVectorStore {
  /** 从持久化介质加载向量索引（冷启动） */
  load(): Promise<void>;
  /** 持久化向量索引到介质 */
  save(): Promise<void>;
  /**
   * 为文本生成向量并存储
   * @param id 记忆 ID
   * @param text 待嵌入的文本
   * @param options embedding 调用选项（signal 外部取消 + timeoutMs 超时）
   */
  upsert(id: string, text: string, options?: EmbeddingOptions): Promise<void>;
  /**
   * 批量嵌入并存储
   * @param items ID + 文本对
   * @param options embedding 调用选项（signal 外部取消 + timeoutMs 超时）
   */
  batchUpsert(items: Array<{ id: string; text: string }>, options?: EmbeddingOptions): Promise<void>;
  /**
   * 删除向量（实现决定是否立即持久化）
   * @param id 待删除的记忆 ID
   */
  delete(id: string): void;
  /**
   * 语义搜索：基于查询文本的向量，返回 topK 最相似的 ID
   * @param query 查询文本
   * @param topK 返回数量上限
   * @param minSimilarity 最低相似度阈值（0~1）
   * @param options embedding 调用选项（signal 外部取消 + timeoutMs 超时）
   * @returns ID + 相似度 对的数组，按相似度降序排列
   */
  search(
    query: string,
    topK?: number,
    minSimilarity?: number,
    options?: EmbeddingOptions,
  ): Promise<Array<{ id: string; similarity: number }>>;
  /** 获取存储的向量数量 */
  readonly size: number;
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
 * 校验持久化文件是否符合 VectorStoreFile schema
 *
 * 防止损坏文件 / 旧版格式 / 手动编辑错误污染内存索引。
 * 校验项：
 *   - 顶层为对象
 *   - version === 1（未来版本需迁移逻辑）
 *   - dimension 为非负整数
 *   - entries 为数组，每个条目含字符串 id 和数字数组 vector
 *   - 所有 vector 长度等于 dimension
 *
 * @param data 已 JSON.parse 的对象
 * @returns true 表示通过校验
 */
function isValidVectorStoreFile(data: unknown): data is VectorStoreFile {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  if (obj.version !== 1) return false;
  if (typeof obj.dimension !== 'number' || !Number.isInteger(obj.dimension) || obj.dimension < 0) {
    return false;
  }
  if (!Array.isArray(obj.entries)) return false;
  for (const entry of obj.entries) {
    if (typeof entry !== 'object' || entry === null) return false;
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== 'string' || e.id.length === 0) return false;
    if (!Array.isArray(e.vector)) return false;
    if (!e.vector.every((v) => typeof v === 'number' && Number.isFinite(v))) return false;
    if (e.vector.length !== obj.dimension) return false;
  }
  return true;
}

/**
 * JSON 持久化向量存储（IVectorStore 内核内置实现）
 *
 * 纯 JS 实现，内存中维护向量索引，定期持久化到 JSON 文件
 * 适用于单用户本地场景（5k 条记录以内）
 *
 * 依赖 EmbeddingService 接口（依赖倒置，与 llm/ 层解耦）
 * 实现 IVectorStore 接口，宿主可替换为其他实现（如 SqliteVectorStore）
 */
export class JsonVectorStore implements IVectorStore {
  /** 内存中的向量索引 */
  private entries = new Map<string, number[]>();

  /** 向量维度（由第一个插入的向量决定） */
  private dimension = 0;

  /** 是否有未持久化的变更 */
  private dirty = false;

  /**
   * 串行化 save 调用的 Promise 链
   *
   * 防止并发 save 互相覆盖：每个 save 等待前一个完成后再执行。
   * 无并发时为 null，有并发时为正在执行的 Promise。
   */
  private savePromise: Promise<void> | null = null;

  constructor(
    private readonly storePath: string,
    private readonly embeddingProvider: EmbeddingService,
  ) {}

  /**
   * 从 JSON 文件加载向量索引（冷启动）
   *
   * 加固：增加 schema 校验，损坏文件视为"从空开始"
   * 防止部分写入 / 手动编辑错误 / 版本不匹配的文件污染内存索引
   */
  async load(): Promise<void> {
    try {
      const content = await readFile(this.storePath, 'utf-8');
      const data: unknown = JSON.parse(content);
      // schema 校验：损坏 / 格式错误的文件视为"从空开始"，避免污染内存索引
      if (!isValidVectorStoreFile(data)) {
        logger.warn({ path: this.storePath }, '向量索引文件格式无效，从空开始');
        return;
      }
      this.dimension = data.dimension;
      this.entries.clear();
      for (const entry of data.entries) {
        this.entries.set(entry.id, entry.vector);
      }
      this.dirty = false;
      logger.info({ count: this.entries.size, dimension: this.dimension }, '向量索引加载完成');
    } catch {
      // 文件不存在或 JSON 解析失败，从空开始
      logger.info({ path: this.storePath }, '向量索引文件不存在，从空开始');
    }
  }

  /**
   * 持久化向量索引到 JSON 文件
   *
   * 加固：串行化并发 save，防止互相覆盖丢失数据。
   * 调用方可在并发场景下安全地多次调用 save，每次都会等待前一次完成。
   *
   * @returns 等待所有挂起 save 完成的 Promise
   */
  async save(): Promise<void> {
    // 串行化：若已有 save 在执行，将本次调用追加到链尾
    if (this.savePromise !== null) {
      this.savePromise = this.savePromise.then(() => this.doSave());
      return this.savePromise;
    }
    this.savePromise = this.doSave().finally(() => {
      // 当前链路完成，清空引用以允许下次独立 save
      this.savePromise = null;
    });
    return this.savePromise;
  }

  /**
   * 实际执行持久化的内部方法
   *
   * 由 save() 串行化调度，外部不应直接调用
   */
  private async doSave(): Promise<void> {
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
   *
   * 加固：维度一致性校验，防止维度错位导致 cosineSimilarity 计算崩溃
   *
   * @param id 记忆 ID
   * @param text 待嵌入的文本
   * @param options embedding 调用选项（signal 外部取消 + timeoutMs 超时）
   * @throws {MemoraError} 当 embedding 返回的向量维度与已存维度不一致时抛出 configError
   */
  async upsert(id: string, text: string, options?: EmbeddingOptions): Promise<void> {
    const vector = await this.embeddingProvider.embed(text, options);
    if (this.dimension === 0) {
      this.dimension = vector.length;
    } else if (vector.length !== this.dimension) {
      // 维度不一致会破坏 cosineSimilarity 计算（长度不匹配返回 0）
      // 此处主动报错，让调用方感知模型切换或配置错误
      // G-1：统一 MemoraError 体系，提供中文标题 + 排查建议
      throw configError(
        '向量维度不一致',
        `期望 ${this.dimension}，实际 ${vector.length}（id=${id}）。可能是 embedding 模型切换导致。`,
        ['清空 vectors.json 后重试', '检查 embedding 模型是否切换'],
      );
    }
    this.entries.set(id, vector);
    this.dirty = true;
  }

  /**
   * 批量嵌入并存储
   *
   * 加固：维度一致性校验，与 upsert 同契约
   *
   * @param items ID + 文本对
   * @param options embedding 调用选项（signal 外部取消 + timeoutMs 超时）
   * @throws {MemoraError} 当 embedding 返回的向量维度与已存维度不一致时抛出 configError
   */
  async batchUpsert(items: Array<{ id: string; text: string }>, options?: EmbeddingOptions): Promise<void> {
    const texts = items.map((item) => item.text);
    const results = await this.embeddingProvider.batchEmbed(texts, options);

    for (let i = 0; i < items.length; i++) {
      const result = results[i];
      const item = items[i];
      if (!result || !item) continue;
      if (this.dimension === 0) {
        this.dimension = result.vector.length;
      } else if (result.vector.length !== this.dimension) {
        // 维度不一致会破坏 cosineSimilarity 计算
        // G-1：统一 MemoraError 体系，提供中文标题 + 排查建议
        throw configError(
          '批量插入向量维度不一致',
          `期望 ${this.dimension}，实际 ${result.vector.length}（id=${item.id}）`,
          ['清空 vectors.json 后重试', '检查 embedding 模型是否切换'],
        );
      }
      this.entries.set(item.id, result.vector);
    }
    this.dirty = true;
  }

  /**
   * 删除向量
   *
   * 注意：此方法仅标记 dirty=true，不会自动调用 save。
   * 调用方需在合适的时机显式调用 save() 持久化删除操作，
   * 否则下次冷启动会重新加载已删除的向量。
   *
   * @param id 待删除的记忆 ID
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
   * @param options embedding 调用选项（signal 外部取消 + timeoutMs 超时）
   * @returns ID + 相似度 对的数组，按相似度降序排列
   */
  async search(
    query: string,
    topK = 5,
    minSimilarity = 0.3,
    options?: EmbeddingOptions,
  ): Promise<Array<{ id: string; similarity: number }>> {
    const queryVector = await this.embeddingProvider.embed(query, options);

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
