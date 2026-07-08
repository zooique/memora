/**
 * Embedding Provider 测试
 * 覆盖缓存 / 批量嵌入 / LRU 淘汰 / 错误处理
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EmbeddingProvider } from '@/llm/embedding.js';

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

// ─── LRU 缓存机制 ──────────────────────────────────────

describe('EmbeddingProvider · LRU 缓存', () => {
  let provider: EmbeddingProvider;

  beforeEach(() => {
    provider = new EmbeddingProvider({
      baseUrl: 'http://localhost:9999',
      apiKey: 'test-key',
      model: 'text-embedding-3-small',
    });
    vi.restoreAllMocks();
  });

  it('cacheSize 应反映缓存条目数', async () => {
    mockFetchSuccess([[0.1]]);
    await provider.embed('文本1');
    expect(provider.cacheSize).toBe(1);

    mockFetchSuccess([[0.2]]);
    await provider.embed('文本2');
    expect(provider.cacheSize).toBe(2);
  });

  it('clearCache 应清空所有缓存', async () => {
    mockFetchSuccess([[0.1]]);
    await provider.embed('文本1');
    expect(provider.cacheSize).toBe(1);

    provider.clearCache();
    expect(provider.cacheSize).toBe(0);
  });

  it('缓存命中不应增加 cacheSize', async () => {
    mockFetchSuccess([[0.1]]);
    await provider.embed('文本');
    await provider.embed('文本'); // 缓存命中
    expect(provider.cacheSize).toBe(1);
  });

  it('LRU 淘汰：超过 CACHE_MAX_SIZE 时应删除最旧条目', async () => {
    // 嵌入 1001 个不同文本，触发 LRU 淘汰
    for (let i = 0; i < 1001; i++) {
      mockFetchSuccess([[i / 1000]]);
      await provider.embed(`文本${i}`);
    }
    // 缓存应保持在 MAX_SIZE=1000
    expect(provider.cacheSize).toBe(1000);
  });
});

// ─── batchEmbed 边界 ────────────────────────────────────

describe('EmbeddingProvider · batchEmbed 边界', () => {
  let provider: EmbeddingProvider;

  beforeEach(() => {
    provider = new EmbeddingProvider({
      baseUrl: 'http://localhost:9999',
      apiKey: 'test-key',
      model: 'text-embedding-3-small',
    });
    vi.restoreAllMocks();
  });

  it('空数组应返回空结果（不调用 API）', async () => {
    // 先 spyOn fetch 创建 spy（不 mock 返回值），用于验证未调用
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const results = await provider.batchEmbed([]);
    expect(results).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('全部命中缓存不应调用 API', async () => {
    // 先缓存文本
    mockFetchSuccess([[0.1]]);
    await provider.embed('缓存文本');
    vi.clearAllMocks();

    // 批量嵌入仅缓存文本
    const results = await provider.batchEmbed(['缓存文本']);
    expect(results).toHaveLength(1);
    expect(results[0]!.vector).toEqual([0.1]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('部分缓存部分新文本应只嵌入新文本', async () => {
    // 先缓存文本1
    mockFetchSuccess([[0.1]]);
    await provider.embed('文本1');

    // 批量嵌入：文本1（缓存）+ 文本2（新）
    mockFetchSuccess([[0.2]]);
    const results = await provider.batchEmbed(['文本1', '文本2']);
    expect(results).toHaveLength(2);
    expect(results[0]!.vector).toEqual([0.1]); // 缓存
    expect(results[1]!.vector).toEqual([0.2]); // 新嵌入
  });

  it('API 返回缺失向量时应跳过（warn 不抛错）', async () => {
    // API 返回空 data 数组
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [] }),
    } as Response);

    const results = await provider.batchEmbed(['文本']);
    expect(results).toEqual([]);
  });

  it('embed 空结果应抛错（batchEmbed 返回空）', async () => {
    // API 返回空 data
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [] }),
    } as Response);

    await expect(provider.embed('文本')).rejects.toThrow('嵌入结果为空');
  });
});

// ─── 韧性选项（P1-8：signal + timeoutMs） ─────────────────

describe('EmbeddingProvider · 韧性选项（P1-8）', () => {
  let provider: EmbeddingProvider;

  beforeEach(() => {
    provider = new EmbeddingProvider({
      baseUrl: 'http://localhost:9999',
      apiKey: 'test-key',
      model: 'text-embedding-3-small',
    });
    vi.restoreAllMocks();
  });

  it('预取消 signal 应立即抛出超时/取消错误', async () => {
    // 创建已 abort 的 signal
    const ac = new AbortController();
    ac.abort(new DOMException('用户取消', 'AbortError'));

    // 真实 fetch 收到已 abort 的 signal 会立即 reject（无需 mock 返回值）
    vi.spyOn(globalThis, 'fetch');

    // embed 应立即 reject，不挂起
    await expect(provider.embed('测试', { signal: ac.signal })).rejects.toThrow();
  });

  it('fetch 期间 abort signal 应抛出错误', async () => {
    // 模拟 fetch 在 abort 后 reject
    const ac = new AbortController();
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce((_url, init) => {
      return new Promise((_resolve, reject) => {
        const signal = (init as RequestInit)?.signal;
        if (signal) {
          if (signal.aborted) {
            reject(new DOMException('aborted', 'AbortError'));
          } else {
            signal.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'));
            });
          }
        }
      });
    });

    // 在 fetch 发起后立即 abort
    const promise = provider.embed('测试', { signal: ac.signal });
    ac.abort();
    await expect(promise).rejects.toThrow();
  });

  it('timeoutMs 超时应抛出"Embedding 请求超时"', async () => {
    // timeoutMs=50 让超时在 50ms 后触发
    // fetch mock 需要响应 signal abort（真实 fetch 会自动响应 signal）
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce((_url, init) => {
      return new Promise((_resolve, reject) => {
        const signal = (init as RequestInit)?.signal;
        if (signal) {
          if (signal.aborted) {
            reject(new DOMException('aborted', 'AbortError'));
          } else {
            signal.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'));
            });
          }
        }
      });
    });

    await expect(
      provider.embed('测试', { timeoutMs: 50 }),
    ).rejects.toThrow('Embedding 请求超时');
  });

  it('缓存命中时不应触发 timeoutMs 超时', async () => {
    // 先缓存文本
    mockFetchSuccess([[0.1, 0.2]]);
    await provider.embed('缓存文本');

    // 第二次调用（缓存命中），即使 timeoutMs=1 也不应超时
    const result = await provider.embed('缓存文本', { timeoutMs: 1 });
    expect(result).toEqual([0.1, 0.2]);
  });

  it('embed 应将 options 透传到 batchEmbed', async () => {
    // 验证 embed 传 options 到 batchEmbed（通过 fetch 收到的 signal 间接验证）
    const ac = new AbortController();
    ac.abort(new DOMException('取消', 'AbortError'));

    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(
      provider.embed('新文本', { signal: ac.signal }),
    ).rejects.toThrow();

    // fetch 被调用时收到的 signal 应是已 abort 的（证明 options 从 embed 透传到 batchEmbed）
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const callArgs = fetchSpy.mock.calls[0]!;
    const init = callArgs[1] as RequestInit;
    expect(init.signal).toBeDefined();
    expect((init.signal as AbortSignal).aborted).toBe(true);
  });
});
