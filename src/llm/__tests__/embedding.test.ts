/**
 * Embedding Provider 测试
 * 覆盖缓存 / 批量嵌入 / 余弦相似度 / 错误处理
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EmbeddingProvider } from '../embedding.js';

/**
 * 创建模拟 fetch 的辅助函数
 */
function mockFetchSuccess(vectors: number[][]) {
  const mockResponse = {
    ok: true,
    json: async () => ({
      data: vectors.map((embedding, index) => ({ embedding, index })),
    }),
  };
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse as Response);
}

describe('EmbeddingProvider · cosineSimilarity', () => {
  it('相同向量应该返回 1.0', () => {
    const v = [1, 0, 0];
    expect(EmbeddingProvider.cosineSimilarity(v, v)).toBeCloseTo(1.0);
  });

  it('正交向量应该返回 0', () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(EmbeddingProvider.cosineSimilarity(a, b)).toBeCloseTo(0);
  });

  it('相反向量应该返回 -1', () => {
    const a = [1, 0, 0];
    const b = [-1, 0, 0];
    expect(EmbeddingProvider.cosineSimilarity(a, b)).toBeCloseTo(-1);
  });

  it('不同维度应该返回 0', () => {
    const a = [1, 0];
    const b = [1, 0, 0];
    expect(EmbeddingProvider.cosineSimilarity(a, b)).toBe(0);
  });

  it('零向量应该返回 0', () => {
    const a = [0, 0, 0];
    const b = [1, 0, 0];
    expect(EmbeddingProvider.cosineSimilarity(a, b)).toBe(0);
  });

  it('45 度角应该返回约 0.707', () => {
    const a = [1, 0];
    const b = [1, 1];
    expect(EmbeddingProvider.cosineSimilarity(a, b)).toBeCloseTo(Math.SQRT1_2, 5);
  });
});

describe('EmbeddingProvider · embed 单条嵌入', () => {
  let provider: EmbeddingProvider;

  beforeEach(() => {
    provider = new EmbeddingProvider({
      baseUrl: 'http://localhost:9999',
      apiKey: 'test-key',
      model: 'text-embedding-3-small',
    });
    vi.restoreAllMocks();
  });

  it('应该调用 /embeddings 端点并返回向量', async () => {
    const vector = [0.1, 0.2, 0.3];
    mockFetchSuccess([vector]);

    const result = await provider.embed('测试文本');

    expect(result).toEqual(vector);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://localhost:9999/embeddings',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('应该缓存结果，第二次调用不触发 fetch', async () => {
    const vector = [0.1, 0.2, 0.3];
    mockFetchSuccess([vector]);

    await provider.embed('测试文本');
    const result = await provider.embed('测试文本');

    expect(result).toEqual(vector);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('EmbeddingProvider · batchEmbed 批量嵌入', () => {
  let provider: EmbeddingProvider;

  beforeEach(() => {
    provider = new EmbeddingProvider({
      baseUrl: 'http://localhost:9999',
      apiKey: 'test-key',
      model: 'text-embedding-3-small',
    });
    vi.restoreAllMocks();
  });

  it('应该批量嵌入多条文本', async () => {
    const vectors = [
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ];
    mockFetchSuccess(vectors);

    const results = await provider.batchEmbed(['文本1', '文本2']);

    expect(results).toHaveLength(2);
    expect(results[0]!.vector).toEqual(vectors[0]);
    expect(results[1]!.vector).toEqual(vectors[1]);
  });

  it('已缓存的文本不应重复调用 API', async () => {
    const vector = [0.1, 0.2, 0.3];
    mockFetchSuccess([vector]);

    // 第一次嵌入
    await provider.embed('缓存文本');

    // 批量嵌入包含缓存文本
    const vector2 = [0.4, 0.5, 0.6];
    mockFetchSuccess([vector2]);
    const results = await provider.batchEmbed(['缓存文本', '新文本']);

    expect(results).toHaveLength(2);
    expect(results[0]!.vector).toEqual(vector);
    expect(results[1]!.vector).toEqual(vector2);
  });
});

describe('EmbeddingProvider · 错误处理', () => {
  it('缺少 apiKey 应该抛出配置错误', async () => {
    const provider = new EmbeddingProvider({
      baseUrl: 'http://localhost:9999',
      apiKey: '',
      model: 'text-embedding-3-small',
    });

    await expect(provider.embed('测试')).rejects.toThrow('API Key 未配置');
  });

  it('网络错误应该抛出连接失败', async () => {
    const provider = new EmbeddingProvider({
      baseUrl: 'http://localhost:9999',
      apiKey: 'test-key',
      model: 'text-embedding-3-small',
    });

    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network error'));

    await expect(provider.embed('测试')).rejects.toThrow('Embedding 服务连接失败');
  });

  it('HTTP 错误应该抛出请求失败', async () => {
    const provider = new EmbeddingProvider({
      baseUrl: 'http://localhost:9999',
      apiKey: 'test-key',
      model: 'text-embedding-3-small',
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    } as Response);

    await expect(provider.embed('测试')).rejects.toThrow('Embedding 请求失败');
  });
});
