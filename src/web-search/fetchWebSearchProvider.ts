/**
 * 基于 fetch 的默认网络搜索实现（FetchWebSearchProvider）
 * 多后端降级链：Bing（国内可达，首选）→ DuckDuckGo（备用），各端点独立超时，失败/空结果时降级到下一端点。
 * 使用 Node.js 18+ 内置 fetch，零依赖。仅用于"开箱即用"场景，生产环境建议宿主实现 IWebSearchProvider 用专用搜索 API。
 */
import type { IWebSearchProvider, SearchResult, WebSearchOptions } from '@/web-search/types.js';

/** 单端点请求超时（ms）：Bing 通常 1-2s 返回，10s 覆盖慢网络且不至于拖死主循环 */
const ENDPOINT_TIMEOUT_MS = 10_000;

/** 搜索端点抽象：名称 + URL 构造 + HTML 解析 */
interface SearchEndpoint {
  name: string;
  buildUrl(query: string): string;
  parse(html: string, limit: number): SearchResult[];
}

/** 通用浏览器 User-Agent（避免被搜索引擎当作爬虫拒绝） */
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * 从 Bing 结果页 HTML 提取结果：标题+链接在 <h2><a>，摘要在 <p class="b_lineclamp*">。
 * 用正则而非 DOM 解析，避免引入 jsdom 依赖。
 */
function parseBingHtml(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];
  const titleRegex = /<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>/g;
  const snippetRegex = /<p[^>]*class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/g;

  const titles: Array<{ url: string; title: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = titleRegex.exec(html)) !== null && titles.length < limit) {
    const url = match[1]!.replace(/&amp;/g, '&').trim();
    const title = match[2]!.replace(/<[^>]*>/g, '').trim();
    if (title && url) {
      titles.push({ url, title });
    }
  }

  const snippets: string[] = [];
  while ((match = snippetRegex.exec(html)) !== null && snippets.length < limit) {
    const snippet = match[1]!.replace(/<[^>]*>/g, '').trim();
    if (snippet) snippets.push(snippet);
  }

  for (let i = 0; i < Math.min(titles.length, limit); i++) {
    results.push({
      title: titles[i]!.title,
      url: titles[i]!.url,
      snippet: snippets[i] ?? '',
    });
  }

  return results;
}

/**
 * 从 DuckDuckGo HTML 响应提取结果：标题/链接在 <a class="result__a">，摘要在 <a class="result__snippet">。
 */
function parseDuckDuckGoHtml(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];
  const resultRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

  const titles: Array<{ url: string; title: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = resultRegex.exec(html)) !== null && titles.length < limit) {
    const url = match[1]!.replace(/\/\/duckduckgo\.com\/l\/\?uddg=/, ''); // 解码跳转链接（两条 URL 前缀指向同一处）
    const title = match[2]!.replace(/<[^>]*>/g, '').trim();
    if (title && url) {
      titles.push({
        url: decodeURIComponent(url),
        title,
      });
    }
  }

  const snippets: string[] = [];
  while ((match = snippetRegex.exec(html)) !== null && snippets.length < limit) {
    const snippet = match[1]!.replace(/<[^>]*>/g, '').trim();
    if (snippet) snippets.push(snippet);
  }

  for (let i = 0; i < Math.min(titles.length, limit); i++) {
    results.push({
      title: titles[i]!.title,
      url: titles[i]!.url,
      snippet: snippets[i] ?? '',
    });
  }

  return results;
}

/** 默认端点降级链：Bing 首选（国内可达），DuckDuckGo 备用 */
const DEFAULT_ENDPOINTS: readonly SearchEndpoint[] = [
  {
    name: 'Bing',
    buildUrl: (query) => `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
    parse: parseBingHtml,
  },
  {
    name: 'DuckDuckGo',
    buildUrl: (query) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    parse: parseDuckDuckGoHtml,
  },
];

/** 默认搜索实现：多后端降级链（Bing → DuckDuckGo），每端点独立超时。生产建议宿主自定义 IWebSearchProvider */
export class FetchWebSearchProvider implements IWebSearchProvider {
  /** 端点降级链（可注入替换，测试与宿主定制用） */
  private readonly endpoints: readonly SearchEndpoint[];

  constructor(endpoints: readonly SearchEndpoint[] = DEFAULT_ENDPOINTS) {
    this.endpoints = endpoints;
  }

  /**
   * 搜索互联网，返回结构化结果。依次尝试各端点，非空结果即成功；
   * 若某个端点成功响应但无命中视为"无结果"，全部失败（网络/HTTP 错误）时抛聚合错误，由 safeSearch 降级。
   */
  async search(query: string, options?: WebSearchOptions): Promise<SearchResult[]> {
    const limit = options?.limit ?? 5;
    const errors: string[] = [];
    // 是否有端点成功响应（HTTP ok）——区分「无命中」与「全部失败」
    let anyOk = false;

    for (const endpoint of this.endpoints) {
      try {
        const response = await this.fetchWithTimeout(
          endpoint.buildUrl(query),
          BROWSER_UA,
          ENDPOINT_TIMEOUT_MS,
        );

        if (!response.ok) {
          errors.push(`${endpoint.name}: HTTP ${response.status} ${response.statusText}`);
          continue;
        }

        anyOk = true;
        const html = await response.text();
        const results = endpoint.parse(html, limit);
        // 空结果（该端点无命中）继续尝试下一端点
        if (results.length > 0) {
          // 打标实际服务的后端名称，供降级透出（G5，2026-08-25）：同批次结果来自同一端点
          return results.map((r) => ({ ...r, endpoint: endpoint.name }));
        }
      } catch (err) {
        errors.push(`${endpoint.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 至少一个端点成功响应但均无命中 → 搜索成功、无结果（非失败，safeSearch 不降级提示）
    if (anyOk) {
      return [];
    }
    // 全部失败 → 抛聚合错误，由 safeSearch 降级为友好提示
    throw new Error(`所有搜索端点均失败：${errors.join('；')}`);
  }

  /**
   * 带超时控制的 fetch：手动 AbortController + setTimeout（兼容性优于 AbortSignal.timeout），
   * 防某端点不可达时挂起整个搜索。
   */
  private async fetchWithTimeout(
    url: string,
    userAgent: string,
    timeoutMs: number,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, {
        headers: { 'User-Agent': userAgent },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
