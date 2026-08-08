/**
 * 基于 fetch 的默认网络搜索实现（FetchWebSearchProvider）
 *
 * 多后端降级链：Bing（国内可达，首选）→ DuckDuckGo（备用）。
 * 使用 Node.js 18+ 内置 fetch，零额外依赖。
 *
 * 2026-08-08 变更：DuckDuckGo 在中国大陆网络不可达（实测 8s 超时），
 * 而 Bing 可达（实测 200 OK）——新增 Bing 为首选后端，
 * 每个端点独立 10s 超时，前一端点失败/空结果时降级到下一端点。
 *
 * 注意：本实现仅用于"开箱即用"场景，生产环境建议宿主项目
 * 实现 IWebSearchProvider 接口使用专用搜索 API（如 Google Custom Search、Bing API）。
 */

import type { IWebSearchProvider, SearchResult, WebSearchOptions } from '@/web-search/types.js';

/** 单端点请求超时（毫秒）：Bing 通常 1-2s 返回，10s 覆盖慢网络且不至于拖死主循环 */
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
 * 从 Bing 搜索结果页 HTML 中提取结果
 *
 * Bing 结果结构（实测 2026-08-08）：
 * - 每个结果在 <li class="b_algo"> 内
 * - 标题 + 链接：<h2><a href="真实URL">标题</a></h2>
 * - 摘要：<p class="b_lineclamp2/4...">摘要</p>
 * 用正则解析而非 DOM 解析，避免引入 jsdom 依赖。
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
 * 从 DuckDuckGo HTML 响应中提取搜索结果
 *
 * DuckDuckGo HTML 版本的结果格式：
 * - 每个结果包含在 <div class="result"> 中
 * - 标题在 <a class="result__a"> 中
 * - 摘要文本在 <a class="result__snippet"> 中
 * - 链接在 <a class="result__url"> 中
 */
function parseDuckDuckGoHtml(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];

  // 匹配 DuckDuckGo 结果块的通用模式
  // 每组结果包含标题、链接、摘要三个字段
  const resultRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

  // 提取标题和链接
  const titles: Array<{ url: string; title: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = resultRegex.exec(html)) !== null && titles.length < limit) {
    const url = match[1]!.replace(/\/\/duckduckgo\.com\/l\/\?uddg=/, ''); // 解码跳转链接
    const title = match[2]!.replace(/<[^>]*>/g, '').trim(); // 去除 HTML 标签
    if (title && url) {
      titles.push({
        url: decodeURIComponent(url),
        title,
      });
    }
  }

  // 提取摘要
  const snippets: string[] = [];
  while ((match = snippetRegex.exec(html)) !== null && snippets.length < limit) {
    const snippet = match[1]!.replace(/<[^>]*>/g, '').trim();
    if (snippet) snippets.push(snippet);
  }

  // 合并标题、链接和摘要
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

/**
 * 基于 fetch 的默认网络搜索实现
 *
 * 多后端降级链（Bing → DuckDuckGo），每个端点独立超时。
 * 适用于开发/测试场景，生产环境建议宿主实现自定义 IWebSearchProvider。
 */
export class FetchWebSearchProvider implements IWebSearchProvider {
  /** 端点降级链（可注入替换，测试与宿主定制用） */
  private readonly endpoints: readonly SearchEndpoint[];

  constructor(endpoints: readonly SearchEndpoint[] = DEFAULT_ENDPOINTS) {
    this.endpoints = endpoints;
  }

  /**
   * 搜索互联网，返回结构化结果
   *
   * 依次尝试各端点：某端点返回非空结果即成功；全部失败（网络错误/HTTP 错误/全空）
   * 时抛出聚合错误，由调用方（safeSearch）降级为友好提示。
   *
   * @param query - 搜索关键词
   * @param options - 搜索选项（limit 控制返回结果数量，默认 5）
   * @returns 结构化搜索结果列表
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
        // 有结果即成功返回；空结果（该端点无命中）继续尝试下一端点
        if (results.length > 0) {
          return results;
        }
      } catch (err) {
        errors.push(`${endpoint.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 至少一个端点成功响应但均无命中 → 搜索成功、无结果（非失败，safeSearch 不降级提示）
    if (anyOk) {
      return [];
    }
    // 全部端点均失败（网络/HTTP 错误）→ 抛出聚合错误，由 safeSearch 降级为友好提示
    throw new Error(`所有搜索端点均失败：${errors.join('；')}`);
  }

  /**
   * 带超时控制的 fetch
   *
   * 手动 AbortController + setTimeout（兼容性优于 AbortSignal.timeout），
   * 防止某端点不可达时挂起整个搜索。
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
