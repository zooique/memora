/**
 * FetchWebFetchProvider 单元测试
 *
 * 覆盖 FetchWebFetchProvider 类：
 *   - fetch() 通过 mock fetch 验证 HTML 解析逻辑（去 script/style/head + 去标签 + 实体解码）
 *   - <title> 标题提取
 *   - HTTP 错误处理（4xx/5xx）
 *   - maxChars 截断
 *   - 网络错误降级（抛出异常，由 safeFetch 上层降级）
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { FetchWebFetchProvider } from '@/web-fetch/fetchWebFetchProvider.js';

/** 模拟一个典型网页 HTML（含 title / script / style / 实体字符 / 多空白） */
const MOCK_PAGE_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>示例页面 &amp; 标题</title>
  <style>.main { color: red; }</style>
  <script>const hidden = '不应出现';</script>
</head>
<body>
  <h1> 欢迎 </h1>
  <p>这是第一段&nbsp;&nbsp;内容，含 &lt;标签&gt; 与 &quot;引号&quot;。</p>
  <div>尾部<div>段落</div></div>
</body>
</html>`;

/** 将 vi mock 断言为 fetch 类型（赋值 globalThis.fetch 用，兼容不同 tsconfig 下的 vi.fn 推断） */
function asFetch(mock: unknown): typeof globalThis.fetch {
  return mock as typeof globalThis.fetch;
}

/** 构造 HTTP 200 + HTML 的响应对象 */
function htmlResponse(
  html: string,
  overrides: Partial<{ url: string; headers: Record<string, string> }> = {},
): { ok: boolean; status: number; statusText: string; url: string; headers: { get: (k: string) => string | null }; text: () => Promise<string> } {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    url: overrides.url ?? 'https://example.com/page',
    headers: { get: (k: string) => overrides.headers?.[k] ?? null },
    text: () => Promise.resolve(html),
  };
}

describe('FetchWebFetchProvider', () => {
  let provider: FetchWebFetchProvider;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    provider = new FetchWebFetchProvider();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('应解析 HTML 为纯文本（去 script/style/head/标签 + 解实体 + 压缩空白）', async () => {
    globalThis.fetch = asFetch(vi.fn().mockResolvedValue(htmlResponse(MOCK_PAGE_HTML)));
    const page = await provider.fetch('https://example.com/page');
    expect(page.content).toContain('欢迎');
    expect(page.content).toContain('这是第一段 内容');
    expect(page.content).toContain('<标签>');
    expect(page.content).toContain('"引号"');
    // script/style/head 内容必须剔除
    expect(page.content).not.toContain('hidden');
    expect(page.content).not.toContain('.main');
  });

  it('应提取 <title> 并解码实体', async () => {
    globalThis.fetch = asFetch(vi.fn().mockResolvedValue(htmlResponse(MOCK_PAGE_HTML)));
    const page = await provider.fetch('https://example.com/page');
    expect(page.title).toBe('示例页面 & 标题');
  });

  it('应返回最终响应 URL 与 content-type', async () => {
    globalThis.fetch = asFetch(
      vi.fn().mockResolvedValue(
        htmlResponse(MOCK_PAGE_HTML, {
          url: 'https://example.com/final',
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
      ),
    );
    const page = await provider.fetch('https://example.com/page');
    expect(page.url).toBe('https://example.com/final');
    expect(page.contentType).toContain('text/html');
  });

  it('HTTP 非 2xx 应抛出异常（由 safeFetch 上层降级）', async () => {
    globalThis.fetch = asFetch(
      vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' }),
    );
    await expect(provider.fetch('https://example.com/missing')).rejects.toThrow('404');
  });

  it('maxChars 应截断正文', async () => {
    globalThis.fetch = asFetch(vi.fn().mockResolvedValue(htmlResponse(MOCK_PAGE_HTML)));
    const page = await provider.fetch('https://example.com/page', { maxChars: 6 });
    // 截断后长度 <= 6（截断符 … 计入）
    expect(page.content.length).toBeLessThanOrEqual(7);
    expect(page.content).toContain('…');
  });

  it('网络异常应向上抛出（由 safeFetch 上层降级）', async () => {
    globalThis.fetch = asFetch(vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await expect(provider.fetch('https://example.com')).rejects.toThrow('ECONNREFUSED');
  });

  it('空正文页面应返回空 content', async () => {
    globalThis.fetch = asFetch(vi.fn().mockResolvedValue(htmlResponse('<html><body></body></html>')));
    const page = await provider.fetch('https://example.com/empty');
    expect(page.content).toBe('');
  });
});
