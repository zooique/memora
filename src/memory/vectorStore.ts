/**
 * 向量存储 — 纯 JS 实现，内存 + JSON 持久化（单用户本地，5k 条内余弦相似度 <10ms，0 npm 依赖）。
 * 语义检索向量索引层：存 id→向量、余弦相似度 topK 搜索、JSON 持久化。
 * 加固点：schema 校验防损坏文件污染、维度一致性校验防相似度崩溃、save 串行化、delete 立即 save。
 */
import { readFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { logger } from '@/logging/logger.js';
import { atomicWriteFile } from '@/utils/atomicWrite.js';
import { configError } from '@/utils/errors.js';
import { cosineSimilarity } from '@/utils/math.js';
import type { EmbeddingOptions } from '@/llm/embedding.js';

/**
 * 嵌入服务接口：生成文本嵌入向量，batchEmbed 结果与输入索引对齐（缺失项为 null 占位，不压缩索引）。
 * EmbeddingProvider（llm/embedding.ts）结构子类型满足；options 透传 signal/timeoutMs 支持外部取消。
 */
export interface EmbeddingService {
  embed(text: string, options?: EmbeddingOptions): Promise<number[]>;
  batchEmbed(
    texts: string[],
    options?: EmbeddingOptions,
  ): Promise<Array<{ text: string; vector: number[] } | null>>;
}

/**
 * 向量存储接口（依赖倒置）：宿主可注入 SqliteVectorStore/LanceDB 等实现，
 * 内核消费者只依赖此接口不耦合持久化方式。内核内置 JsonVectorStore。
 */
export interface IVectorStore {
  /** 从持久化介质加载向量索引（冷启动） */
  load(): Promise<void>;
  /** 持久化向量索引到介质 */
  save(): Promise<void>;
  /** 为文本生成向量并存储（options: signal 外部取消 + timeoutMs 超时） */
  upsert(id: string, text: string, options?: EmbeddingOptions): Promise<void>;
  /** 批量嵌入并存储 */
  batchUpsert(items: Array<{ id: string; text: string }>, options?: EmbeddingOptions): Promise<void>;
  /** 删除向量并立即持久化（低频，立即 save 防崩溃后已删向量冷启动复活） */
  delete(id: string): Promise<void>;
  /** 语义搜索：返回 topK 最相似（降序）的 id+similarity 对 */
  search(
    query: string,
    topK?: number,
    minSimilarity?: number,
    options?: EmbeddingOptions,
  ): Promise<Array<{ id: string; similarity: number }>>;
  /** 存储的向量数量 */
  readonly size: number;
}

/** 向量条目：ID + 向量 */
interface VectorEntry {
  id: string;
  vector: number[];
}

/** 持久化 JSON 格式 */
interface VectorStoreFile {
  /** 存储版本（未来格式变更迁移用） */
  version: 1;
  /** 向量维度（所有向量一致） */
  dimension: number;
  /** 向量条目 */
  entries: VectorEntry[];
}

/** 校验持久化文件是否符合 VectorStoreFile schema，防损坏/旧版/手动编辑污染内存索引 */
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
 * JSON 持久化向量存储（内核内置实现）：内存索引 + 周期持久化到 JSON，单用户本地场景。
 * 依赖 EmbeddingService（依赖倒置，与 llm/ 解耦）。
 */
export class JsonVectorStore implements IVectorStore {
  /** 内存中的向量索引 */
  private entries = new Map<string, number[]>();
  /** 向量维度（由第一个插入的向量决定） */
  private dimension = 0;
  /** 是否有未持久化的变更 */
  private dirty = false;
  /** 串行化 save 的 Promise 链，防并发互相覆盖 */
  private savePromise: Promise<void> | null = null;

  constructor(
    private readonly storePath: string,
    private readonly embeddingProvider: EmbeddingService,
  ) {}

  /** 冷启动加载：schema 校验，损坏则备份并从空开始 */
  async load(): Promise<void> {
    let content: string;
    try {
      content = await readFile(this.storePath, 'utf-8');
    } catch {
      // 文件不存在：从空开始（正常冷启动）
      logger.info({ path: this.storePath }, '向量索引文件不存在，从空开始');
      return;
    }
    try {
      const data: unknown = JSON.parse(content);
      // 损坏/格式错误：备份后从空开始，避免静默覆盖不可逆丢失
      if (!isValidVectorStoreFile(data)) {
        await this.backupCorrupt();
        logger.warn({ path: this.storePath }, '向量索引文件格式无效，已从空开始并备份损坏文件');
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
      // JSON 解析失败（半写/手动损坏）：备份后从空开始
      await this.backupCorrupt();
      logger.warn({ path: this.storePath }, '向量索引文件解析失败，已从空开始并备份损坏文件');
    }
  }

  /** 备份损坏文件为 .corrupt.<timestamp>，便于人工恢复/re-embed，避免静默覆盖不可逆丢失 */
  private async backupCorrupt(): Promise<void> {
    try {
      await rename(this.storePath, `${this.storePath}.corrupt.${Date.now()}`);
    } catch (err) {
      logger.warn({ err, path: this.storePath }, '备份损坏向量索引文件失败（不影响从空开始）');
    }
  }

  /** 持久化：串行化并发 save，每次等待前一次完成，防互相覆盖丢数据 */
  async save(): Promise<void> {
    // 将本次 save 追加到链尾（或开启新链），完成后仅当仍是链尾才清空引用，避免截断后续链
    const p = (this.savePromise ?? Promise.resolve()).then(() => this.doSave());
    this.savePromise = p;
    p.finally(() => {
      if (this.savePromise === p) this.savePromise = null;
    });
    return p;
  }

  /** 实际持久化，由 save() 串行化调度，外部不应直接调用 */
  private async doSave(): Promise<void> {
    if (!this.dirty) return;

    const data: VectorStoreFile = {
      version: 1,
      dimension: this.dimension,
      entries: Array.from(this.entries.entries()).map(([id, vector]) => ({ id, vector })),
    };

    await mkdir(dirname(this.storePath), { recursive: true });
    // 原子写：防写一半崩溃造成整库向量静默清空（向量昂贵只能重算）
    await atomicWriteFile(this.storePath, JSON.stringify(data));
    this.dirty = false;
    logger.info({ count: this.entries.size }, '向量索引持久化完成');
  }

  /** 生成向量并存储；维度校验防错位导致 cosineSimilarity 崩溃（如模型切换） */
  async upsert(id: string, text: string, options?: EmbeddingOptions): Promise<void> {
    const vector = await this.embeddingProvider.embed(text, options);
    if (this.dimension === 0) {
      this.dimension = vector.length;
    } else if (vector.length !== this.dimension) {
      // 维度不一致会破坏余弦相似度计算，主动报错让调用方感知模型切换/配置错误
      throw configError(
        '向量维度不一致',
        `期望 ${this.dimension}，实际 ${vector.length}（id=${id}）。可能是 embedding 模型切换导致。`,
        ['清空 vectors.json 后重试', '检查 embedding 模型是否切换'],
      );
    }
    this.entries.set(id, vector);
    this.dirty = true;
  }

  /** 批量生成向量并存储，维度校验同 upsert */
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

  /** 删除向量并立即持久化（低频，代价可控；save 串行化由内部链保证） */
  async delete(id: string): Promise<void> {
    this.entries.delete(id);
    this.dirty = true;
    await this.save();
  }

  /** 语义搜索：按查询向量余弦相似度过滤 minSimilarity，降序取 topK */
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
    // 降序取 topK
    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, topK);
  }

  /** 存储的向量数量 */
  get size(): number {
    return this.entries.size;
  }
}