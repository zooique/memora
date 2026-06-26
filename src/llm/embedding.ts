/**
 * Embedding Provider — 调用 OpenAI 兼容的 /embeddings 端点
 *
 * M-206：语义检索的核心能力
 * - 将文本转为向量（embedding）
 * - 支持批量嵌入（减少 API 调用次数）
 * - 向量维度由模型决定（如 text-embedding-3-small: 1536 维）
 *
 * 设计原则：
 * - 复用 OpenAI 兼容协议（与 chat 共用 baseUrl/apiKey）
 * - 0 新 npm 依赖（纯 fetch 调用）
 * - 缓存机制：相同文本不重复调用 API
 *
 * 详见 ADR-003 · LLM 适配层使用 OpenAI Chat Completions 兼容协议
 */
import { logger } from '@/logging/logger.js';
import { networkError, configError, toError } from '@/utils/errors.js';

/**
 * Embedding 配置（与 OpenAICompatibleConfig 共用 baseUrl/apiKey）
 */
export interface EmbeddingConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * 单条 embedding 结果
 */
export interface EmbeddingResult {
  /** 原始文本 */
  text: string;
  /** 向量（浮点数组，维度由模型决定） */
  vector: number[];
}

/**
 * Embedding Provider
 *
 * 调用 /embeddings 端点将文本转为向量
 * 支持批量嵌入和本地缓存
 */
export class EmbeddingProvider {
  /** 缓存最大条目数（LRU 上限，防止无界增长导致内存泄漏） */
  private static readonly CACHE_MAX_SIZE = 1000;

  /** 本地缓存：text → vector（LRU，Map 迭代顺序 = 最近访问顺序） */
  private readonly cache = new Map<string, number[]>();

  constructor(private readonly config: EmbeddingConfig) {}

  /**
   * LRU 读取：命中时把条目移到末尾，标记为最近访问
   * Map 保持插入顺序，末尾即最近访问，首部即最久未访问（淘汰候选）
   */
  private getCached(text: string): number[] | undefined {
    const vector = this.cache.get(text);
    if (vector === undefined) return undefined;
    // 删除后重新插入，移到末尾
    this.cache.delete(text);
    this.cache.set(text, vector);
    return vector;
  }

  /**
   * LRU 写入：超过容量时淘汰最旧条目（首部）
   */
  private setCache(text: string, vector: number[]): void {
    if (this.cache.size >= EmbeddingProvider.CACHE_MAX_SIZE) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(text, vector);
  }

  /**
   * 嵌入单条文本
   * @param text 待嵌入的文本
   * @returns 向量
   */
  async embed(text: string): Promise<number[]> {
    // 缓存命中
    const cached = this.getCached(text);
    if (cached) return cached;

    const results = await this.batchEmbed([text]);
    const first = results[0];
    if (!first) throw new Error('embed: batchEmbed 返回空结果');
    return first.vector;
  }

  /**
   * 批量嵌入多条文本
   * OpenAI 兼容 API 支持一次请求嵌入多条文本，减少 API 调用
   * @param texts 待嵌入的文本数组
   * @returns 嵌入结果数组（顺序与输入一致）
   */
  async batchEmbed(texts: string[]): Promise<EmbeddingResult[]> {
    // 过滤已缓存的
    const uncached: string[] = [];
    const uncachedIndices: number[] = [];
    const results: (EmbeddingResult | null)[] = texts.map((text, i) => {
      const cached = this.getCached(text);
      if (cached) return { text, vector: cached };
      uncached.push(text);
      uncachedIndices.push(i);
      return null;
    });

    // 全部命中缓存
    if (uncached.length === 0) {
      return results as EmbeddingResult[];
    }

    // 调用 /embeddings API
    if (!this.config.apiKey) {
      throw configError('Embedding API Key 未配置', 'embedding 需要 LLM API Key', [
        '检查 ~/.memora/config.json 的 llm.apiKey 字段',
      ]);
    }

    const url = `${this.config.baseUrl}/embeddings`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          input: uncached,
        }),
      });
    } catch (err) {
      const e = toError(err);
      throw networkError(
        'Embedding 服务连接失败',
        `无法访问 ${url}：${e.message}`,
        ['检查网络连接', '确认 baseUrl 配置正确'],
        e,
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw networkError('Embedding 请求失败', `HTTP ${response.status}: ${body.slice(0, 200)}`, [
        '检查 API Key 是否有效',
        '确认 embedding 模型名称正确',
      ]);
    }

    const data = (await response.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
    };

    // 按 index 排序（API 不保证顺序）
    const sorted = data.data.sort((a, b) => a.index - b.index);

    // 填充结果 + 更新缓存
    for (let i = 0; i < uncached.length; i++) {
      // QC-17 移除非空断言：循环条件保证索引有效，null 检查兜底
      const text = uncached[i];
      if (!text) continue;
      const vector = sorted[i]?.embedding;
      if (!vector) {
        logger.warn({ text: text.slice(0, 50), index: i }, 'Embedding 缺失，跳过');
        continue;
      }
      this.setCache(text, vector);
      // QC-17 移除非空断言：null 检查兜底
      const idx = uncachedIndices[i];
      if (idx !== undefined) results[idx] = { text, vector };
    }

    return results.filter((r): r is EmbeddingResult => r !== null);
  }

  /**
   * 获取缓存大小（调试用）
   */
  get cacheSize(): number {
    return this.cache.size;
  }

  /**
   * 清空缓存
   */
  clearCache(): void {
    this.cache.clear();
  }
}
