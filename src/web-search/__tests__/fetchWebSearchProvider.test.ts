/**
 * FetchWebSearchProvider 单元测试
 *
 * 覆盖 FetchWebSearchProvider 类：
 *   - search() 通过 mock fetch 验证 HTML 解析逻辑
 *   - HTTP 错误处理（4xx/5xx）
 *   - limit 参数传递
 *   - 空结果处理
 *   - URL 构造格式
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { FetchWebSearchProvider } from '@/web-search/fetchWebSearchProvider.js';

/** 模拟 DuckDuckGo HTML 响应（含两个搜索结果） */
const MOCK_HTML_RESPONSE = `<!DOCTYPE html>
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

/** 模拟空结果 HTML */
const MOCK_EMPTY_HTML = '<!DOCTYPE html><html><body><div class="results"></div></body></html>';

/** 模拟 DuckDuckGo 跳转链接格式 */
const MOCK_HTML_WITH_REDIRECT = `<!DOCTYPE html>
<html>
<body>
  <div class="result">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fredirected">重定向标题</a>
    <a class="result__snippet">重定向摘要</a>
  </div>
</body>
</html>`;

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

  it('应正确解析 DuckDuckGo HTML 搜索结果', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(MOCK_HTML_RESPONSE),
    });

    const results = await provider.search('测试查询');

    expect(results).toHaveLength(2);
    expect(results[0]!.title).toBe('测试结果标题一');
    expect(results[0]!.url).toBe('https://example.com/1');
    expect(results[0]!.snippet).toBe('这是第一个搜索结果的摘要描述');
    expect(results[1]!.title).toBe('测试结果标题二');
    expect(results[1]!.url).toBe('https://example.com/2');
    expect(results[1]!.snippet).toBe('这是第二个搜索结果的摘要描述');
  });

  it('应使用 DuckDuckGo HTML 搜索 URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(MOCK_EMPTY_HTML),
    });
    globalThis.fetch = fetchMock;

    await provider.search('测试查询');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = fetchMock.mock.calls[0]![0] as string;
    expect(calledUrl).toContain('html.duckduckgo.com/html/?q=');
    expect(calledUrl).toContain(encodeURIComponent('测试查询'));
  });

  it('应携带 User-Agent 请求头', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(MOCK_EMPTY_HTML),
    });
    globalThis.fetch = fetchMock;

    await provider.search('测试');

    const options = fetchMock.mock.calls[0]![1] as RequestInit;
    const headers = options.headers as Record<string, string>;
    expect(headers['User-Agent']).toContain('Mozilla/5.0');
  });

  it('应传递 limit 参数限制结果数量', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(MOCK_HTML_RESPONSE),
    });

    const results = await provider.search('测试', { limit: 1 });

    expect(results).toHaveLength(1);
    expect(results[0]!.title).toBe('测试结果标题一');
  });

  it('HTTP 错误时应抛出异常', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
    });

    await expect(provider.search('测试')).rejects.toThrow('HTTP 403');
  });

  it('空结果 HTML 应返回空数组', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(MOCK_EMPTY_HTML),
    });

    const results = await provider.search('测试');

    expect(results).toEqual([]);
  });

  it('网络错误时应抛出异常', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ENOTFOUND'));

    await expect(provider.search('测试')).rejects.toThrow('ENOTFOUND');
  });

  it('应解码 DuckDuckGo 跳转链接为原始 URL', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(MOCK_HTML_WITH_REDIRECT),
    });

    const results = await provider.search('测试');

    expect(results).toHaveLength(1);
    expect(results[0]!.url).toBe('https://example.com/redirected');
  });

  it('默认 limit 应为 5', async () => {
    // 生成包含 6 个结果的 HTML
    const manyResults = Array.from({ length: 6 }, (_, i) => `
      <div class="result">
        <a class="result__a" href="https://example.com/${i}">结果${i}</a>
        <a class="result__snippet">摘要${i}</a>
      </div>
    `).join('');
    const html = `<!DOCTYPE html><html><body><div class="results">${manyResults}</div></body></html>`;

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(html),
    });

    const results = await provider.search('测试');

    // 默认 limit=5，应只返回 5 个结果
    expect(results).toHaveLength(5);
  });
});