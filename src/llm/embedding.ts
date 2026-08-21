/**
 * Embedding Provider：复用 OpenAI 兼容 /embeddings 端点将文本转向量（维度由模型决定），
 * 支持批量嵌入与文本→向量缓存（0 新依赖，纯 fetch 调用）
 */
import { logger } from '@/logging/logger.js';
import { networkError, configError, llmError } from '@/utils/errors.js';
import { toError } from '@/utils/toError.js';
import { mergeAbortSignals } from '@/llm/abortSignal.js';

/** Embedding 调用选项：纯调用基础设施类型（signal + timeoutMs），无业务语义 */
export interface EmbeddingOptions {
  /** 外部取消信号（用户主动取消时传入） */
  signal?: AbortSignal;
  /** 超时毫秒数（超时自动 abort；默认 60s，可通过此字段覆盖） */
  timeoutMs?: number;
}

/** Embedding 配置（与 OpenAICompatibleConfig 共用 baseUrl/apiKey） */
export interface EmbeddingConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 单条 embedding 结果 */
export interface EmbeddingResult {
  /** 原始文本 */
  text: string;
  /** 向量（浮点数组，维度由模型决定） */
  vector: number[];
}

export class EmbeddingProvider {
  /** 缓存最大条目数（LRU 上限，防止无界增长导致内存泄漏） */
  private static readonly CACHE_MAX_SIZE = 1000;

  /** 默认请求超时：60 秒（embedding 无流式推理，比 chat 的 120s 更短） */
  private static readonly DEFAULT_TIMEOUT_MS = 60_000;

  /** 本地缓存：text → vector（LRU，Map 首部即最久未访问，末尾即最近访问） */
  private readonly cache = new Map<string, number[]>();

  constructor(private readonly config: EmbeddingConfig) {}

  /** LRU 读取：命中时把条目移到末尾，标记为最近访问 */
  private getCached(text: string): number[] | undefined {
    const vector = this.cache.get(text);
    if (vector === undefined) return undefined;
    // 删除后重新插入，移到末尾
    this.cache.delete(text);
    this.cache.set(text, vector);
    return vector;
  }

  /** LRU 写入：超过容量时淘汰最旧条目（首部） */
  private setCache(text: string, vector: number[]): void {
    if (this.cache.size >= EmbeddingProvider.CACHE_MAX_SIZE) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(text, vector);
  }

  /** 嵌入单条文本：返回向量（逻辑合并到 batchEmbed） */
  async embed(text: string, options?: EmbeddingOptions): Promise<number[]> {
    // 缓存命中
    const cached = this.getCached(text);
    if (cached) return cached;

    const results = await this.batchEmbed([text], options);
    const first = results[0];
    if (!first) {
      // 错误处理统一：使用 llmError 工厂
      throw llmError(
        '嵌入结果为空',
        'batchEmbed 返回空结果',
        ['请检查 Embedding 模型配置', '确认 API 返回了有效的向量数据'],
      );
    }
    return first.vector;
  }

  /** 批量嵌入：一次请求嵌入多条（减少 API 调用），结果与输入**索引对齐**（缺失项保留 null 占位，不压缩索引） */
  async batchEmbed(
    texts: string[],
    options?: EmbeddingOptions,
  ): Promise<(EmbeddingResult | null)[]> {
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

    if (!this.config.apiKey) {
      throw configError('Embedding API Key 未配置', 'embedding 需要 LLM API Key', [
        '检查 ~/.memora/config.json 的 llm.apiKey 字段',
      ]);
    }

    const url = `${this.config.baseUrl}/embeddings`;

    // 合并外部取消 + 超时信号，确保两者都能中断 fetch
    const timeoutMs = options?.timeoutMs ?? EmbeddingProvider.DEFAULT_TIMEOUT_MS;
    const abort = mergeAbortSignals(options?.signal, timeoutMs, 'Embedding 请求超时');

    try {
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
          signal: abort.signal,
        });
      } catch (err) {
        const e = toError(err);
        // 区分超时错误和网络错误
        if (e.name === 'AbortError' || e.name === 'TimeoutError') {
          throw networkError(
            'Embedding 请求超时',
            `${url} 请求超过 ${timeoutMs / 1000}s 未响应`,
            ['检查网络连接稳定性', '如频繁超时，考虑调整 timeoutMs', '稍后重试'],
            e,
          );
        }
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

      // 按 index 排序（API 不保证顺序；排序仅保证确定性，填充按 index 精确映射）
      const sorted = data.data.sort((a, b) => a.index - b.index);

      // 按 API 返回的 index 精确映射回输入数组位置（7-1 修复）：
      // data[i].index 指向 uncached 中的位置，缺失的 index（无对应 data 项）对应 results 位置保持 null 占位。
      // 不能按数组位置取 sorted[i]——index 不连续（API 部分缺失）时按位置取会让后续项错位。
      for (const item of sorted) {
        const inputPos = item.index;
        if (inputPos === undefined) continue;
        const text = uncached[inputPos];
        if (!text) continue;
        const vector = item.embedding;
        if (!vector) {
          logger.warn(
            { text: text.slice(0, 50), index: inputPos },
            'Embedding 缺失，跳过',
          );
          continue;
        }
        this.setCache(text, vector);
        const idx = uncachedIndices[inputPos];
        if (idx !== undefined) results[idx] = { text, vector };
      }

      // 保留 null 占位返回：缺失项不 filter 压缩索引（7-1 修复）——调用方按 results[i]
      // 取第 i 条时索引对齐，缺失项由调用方（batchUpsert）`if (!result) continue` 容错跳过
      return results;
    } finally {
      abort.dispose();
    }
  }

  /** 获取缓存大小（调试用） */
  get cacheSize(): number {
    return this.cache.size;
  }

  /** 清空缓存 */
  clearCache(): void {
    this.cache.clear();
  }
}
