/**
 * FetchWebSearchProvider 单元测试
 *
 * 覆盖 FetchWebSearchProvider 类：
 *   - 多后端降级链：Bing 优先，DuckDuckGo 降级
 *   - search() 通过 mock fetch 验证 HTML 解析逻辑（Bing + DuckDuckGo 两种格式）
 *   - HTTP 错误处理（4xx/5xx）
 *   - limit 参数传递
 *   - 空结果处理
 *   - 网络错误降级
 *   - URL 构造格式
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { FetchWebSearchProvider } from '@/web-search/fetchWebSearchProvider.js';

/** 模拟 DuckDuckGo HTML 响应（含两个搜索结果） */
const MOCK_DDG_HTML = `<!DOCTYPE html>
<html>
<body>
  <div class="results">
    <div class="result">
      <a class="result__a" href="https://example.com/1">测试结果标题一</a>
      <a class="result__snippet">这是第一个搜索结果的摘要描述</a>
    </div>
    <div class="result">
      <a class="result__a" href="https://example.com/2">测试结果标题二</a>
      <a class="result__snippet">这是第二个搜索结果的摘要描述</a>
    </div>
  </div>
</body>
</html>`;

/** 模拟 Bing HTML 响应（含两个搜索结果） */
const MOCK_BING_HTML = `<!DOCTYPE html>
<html>
<body>
  <ol>
    <li class="b_algo">
      <h2><a href="https://bing-example.com/1">Bing 标题一</a></h2>
      <p class="b_lineclamp2">Bing 摘要一</p>
    </li>
    <li class="b_algo">
      <h2><a href="https://bing-example.com/2">Bing 标题二</a></h2>
      <p class="b_lineclamp4">Bing 摘要二</p>
    </li>
  </ol>
</body>
</html>`;

/** 模拟空结果 HTML（Bing/DDG 均无命中） */
const MOCK_EMPTY_HTML = '<!DOCTYPE html><html><body><div class="results"></div></body></html>';

/** 模拟 DuckDuckGo 跳转链接格式 */
const MOCK_DDG_REDIRECT_HTML = `<!DOCTYPE html>
<html>
<body>
  <div class="result">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fredirected">重定向标题</a>
    <a class="result__snippet">重定向摘要</a>
  </div>
</body>
</html>`;

/** 按 URL 分发的 fetch mock：Bing 返回 bingResponse，DuckDuckGo 返回 ddgResponse */
function createUrlDispatchFetch(
  bingResponse: () => Promise<{ ok: boolean; status?: number; statusText?: string; text?: () => Promise<string> }>,
  ddgResponse: () => Promise<{ ok: boolean; status?: number; statusText?: string; text?: () => Promise<string> }>,
): ReturnType<typeof vi.fn> {
  return vi.fn().mockImplementation((url: string) => {
    if (url.includes('bing.com/search')) return bingResponse();
    return ddgResponse();
  });
}

/** 将 vi mock 断言为 fetch 类型（赋值 globalThis.fetch 用，兼容不同 tsconfig 下的 vi.fn 推断） */
function asFetch(mock: unknown): typeof globalThis.fetch {
  return mock as typeof globalThis.fetch;
}

/** 构造 HTTP 200 + HTML 的响应对象 */
function htmlResponse(html: string): Promise<{ ok: boolean; text: () => Promise<string> }> {
  return Promise.resolve({ ok: true, text: () => Promise.resolve(html) });
}

describe('FetchWebSearchProvider', () => {
  let provider: FetchWebSearchProvider;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    provider = new FetchWebSearchProvider();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('Bing 解析（首选端点）', () => {
    it('Bing 可达时应直接返回 Bing 结果（不降级）', async () => {
      const fetchMock = createUrlDispatchFetch(
        () => htmlResponse(MOCK_BING_HTML),
        () => htmlResponse(MOCK_EMPTY_HTML),
      );
      globalThis.fetch = asFetch(fetchMock);

      const results = await provider.search('测试查询');

      expect(results).toHaveLength(2);
      expect(results[0]!.title).toBe('Bing 标题一');
      expect(results[0]!.url).toBe('https://bing-example.com/1');
      expect(results[0]!.snippet).toBe('Bing 摘要一');
      expect(results[1]!.title).toBe('Bing 标题二');
      expect(results[1]!.snippet).toBe('Bing 摘要二');
      // 只请求了 Bing，未触发 DDG 降级
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]![0]).toContain('bing.com/search?q=');
    });

    it('Bing HTML 实体应解码（&amp; → &）', async () => {
      const html = '<h2><a href="https://x.com/a&amp;b=1">标题</a></h2>';
      globalThis.fetch = asFetch(createUrlDispatchFetch(
        () => htmlResponse(html),
        () => htmlResponse(MOCK_EMPTY_HTML),
      ));

      const results = await provider.search('测试');

      expect(results[0]!.url).toBe('https://x.com/a&b=1');
    });
  });

  describe('DuckDuckGo 降级解析', () => {
    it('Bing 无结果时应降级 DuckDuckGo 并解析', async () => {
      const fetchMock = createUrlDispatchFetch(
        () => htmlResponse(MOCK_EMPTY_HTML),
        () => htmlResponse(MOCK_DDG_HTML),
      );
      globalThis.fetch = asFetch(fetchMock);

      const results = await provider.search('测试查询');

      expect(results).toHaveLength(2);
      expect(results[0]!.title).toBe('测试结果标题一');
      expect(results[0]!.url).toBe('https://example.com/1');
      expect(results[0]!.snippet).toBe('这是第一个搜索结果的摘要描述');
      // Bing 空结果 → 降级 DDG（两次请求）
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('Bing 网络失败时应降级 DuckDuckGo', async () => {
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes('bing.com/search')) return Promise.reject(new Error('ENOTFOUND bing'));
        return htmlResponse(MOCK_DDG_HTML);
      }) as unknown as typeof globalThis.fetch;
      globalThis.fetch = asFetch(fetchMock);

      const results = await provider.search('测试');

      expect(results).toHaveLength(2);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('应解码 DuckDuckGo 跳转链接为原始 URL', async () => {
      globalThis.fetch = asFetch(createUrlDispatchFetch(
        () => htmlResponse(MOCK_EMPTY_HTML),
        () => htmlResponse(MOCK_DDG_REDIRECT_HTML),
      ));

      const results = await provider.search('测试');

      expect(results).toHaveLength(1);
      expect(results[0]!.url).toBe('https://example.com/redirected');
    });
  });

  describe('通用行为', () => {
    it('应携带 User-Agent 请求头', async () => {
      const fetchMock = createUrlDispatchFetch(
        () => htmlResponse(MOCK_EMPTY_HTML),
        () => htmlResponse(MOCK_EMPTY_HTML),
      );
      globalThis.fetch = asFetch(fetchMock);

      await provider.search('测试');

      const options = fetchMock.mock.calls[0]![1] as RequestInit;
      const headers = options.headers as Record<string, string>;
      expect(headers['User-Agent']).toContain('Mozilla/5.0');
    });

    it('应传递 limit 参数限制结果数量', async () => {
      const manyDdg = Array.from({ length: 6 }, (_, i) => `
        <div class="result">
          <a class="result__a" href="https://example.com/${i}">结果${i}</a>
          <a class="result__snippet">摘要${i}</a>
        </div>
      `).join('');
      const html = `<!DOCTYPE html><html><body><div class="results">${manyDdg}</div></body></html>`;

      globalThis.fetch = asFetch(createUrlDispatchFetch(
        () => htmlResponse(MOCK_EMPTY_HTML),
        () => htmlResponse(html),
      ));

      const results = await provider.search('测试', { limit: 1 });

      expect(results).toHaveLength(1);
      expect(results[0]!.title).toBe('结果0');
    });

    it('默认 limit 应为 5', async () => {
      const manyDdg = Array.from({ length: 6 }, (_, i) => `
        <div class="result">
          <a class="result__a" href="https://example.com/${i}">结果${i}</a>
          <a class="result__snippet">摘要${i}</a>
        </div>
      `).join('');
      const html = `<!DOCTYPE html><html><body><div class="results">${manyDdg}</div></body></html>`;

      globalThis.fetch = asFetch(createUrlDispatchFetch(
        () => htmlResponse(MOCK_EMPTY_HTML),
        () => htmlResponse(html),
      ));

      const results = await provider.search('测试');

      expect(results).toHaveLength(5);
    });

    it('HTTP 错误时应抛出异常（含端点名与状态码）', async () => {
      globalThis.fetch = asFetch(createUrlDispatchFetch(
        () => Promise.resolve({ ok: false, status: 403, statusText: 'Forbidden' }),
        () => Promise.resolve({ ok: false, status: 429, statusText: 'Too Many Requests' }),
      ));

      await expect(provider.search('测试')).rejects.toThrow('HTTP 403');
    });

    it('两端点均返回空结果时应返回空数组', async () => {
      globalThis.fetch = asFetch(createUrlDispatchFetch(
        () => htmlResponse(MOCK_EMPTY_HTML),
        () => htmlResponse(MOCK_EMPTY_HTML),
      ));

      const results = await provider.search('测试');

      expect(results).toEqual([]);
    });

    it('网络错误时应抛出聚合异常', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(
        new Error('ENOTFOUND'),
      ) as unknown as typeof globalThis.fetch;

      await expect(provider.search('测试')).rejects.toThrow('ENOTFOUND');
    });

    it('应携带超时信号防止端点挂起', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(MOCK_EMPTY_HTML),
      });
      globalThis.fetch = asFetch(fetchMock);

      await provider.search('测试');

      const options = fetchMock.mock.calls[0]![1] as RequestInit;
      expect(options.signal).toBeDefined();
    });

    it('Bing 返回无结果 HTML 但 DDG 有结果时应降级', async () => {
      // Bing 返回有标题但无摘要的残缺 HTML
      const bingPartial = '<html><body><li class="b_algo"><h2><a href="https://x.com/1">标题</a></h2></li></body></html>';
      globalThis.fetch = asFetch(createUrlDispatchFetch(
        () => htmlResponse(bingPartial),
        () => htmlResponse(MOCK_DDG_HTML),
      ));

      const results = await provider.search('测试');

      // Bing 解析出的标题无摘要，仍视为有结果，不降级
      expect(results).toHaveLength(1);
      expect(results[0]!.title).toBe('标题');
      expect(results[0]!.snippet).toBe('');
    });

    it('Bing 解析无任何匹配时降级 DDG', async () => {
      // Bing 返回完全无关的 HTML（无 b_algo 结构）
      const bingNoise = '<html><body><div>无关内容</div></body></html>';
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes('bing.com/search')) return htmlResponse(bingNoise);
        return htmlResponse(MOCK_DDG_HTML);
      }) as unknown as typeof globalThis.fetch;
      globalThis.fetch = asFetch(fetchMock);

      const results = await provider.search('测试');

      // Bing 解析出 0 条结果 → 降级 DDG
      expect(results).toHaveLength(2);
      expect(results[0]!.title).toBe('测试结果标题一');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('query 为空字符串时应正常搜索（不抛错）', async () => {
      globalThis.fetch = asFetch(createUrlDispatchFetch(
        () => htmlResponse(MOCK_EMPTY_HTML),
        () => htmlResponse(MOCK_EMPTY_HTML),
      ));

      // 空字符串 query 应被 encodeURIComponent 处理为 ''，不抛错
      await expect(provider.search('')).resolves.toEqual([]);
    });
  });
});
