/**
 * 基于 fetch 的默认网络搜索实现（FetchWebSearchProvider）
 *
 * 使用 DuckDuckGo 的 HTML 搜索接口（无需 API Key）作为默认降级方案。
 * 使用 Node.js 18+ 内置 fetch，零额外依赖。
 *
 * 注意：本实现仅用于"开箱即用"场景，生产环境建议宿主项目
 * 实现 IWebSearchProvider 接口使用专用搜索 API（如 Google Custom Search、Bing API）。
 */

import type { IWebSearchProvider, SearchResult, WebSearchOptions } from '@/web-search/types.js';

/**
 * 从 DuckDuckGo HTML 响应中提取搜索结果
 *
 * DuckDuckGo HTML 版本的结果格式：
 * - 每个结果包含在 <div class="result"> 中
 * - 标题在 <a class="result__a"> 中
 * - 摘要文本在 <a class="result__snippet"> 中
 * - 链接在 <a class="result__url"> 中
 *
 * 使用正则解析而非 DOM 解析，避免引入 jsdom 依赖。
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

/**
 * 基于 fetch 的默认网络搜索实现
 *
 * 使用 DuckDuckGo HTML 搜索接口，无需 API Key。
 * 适用于开发/测试场景，生产环境建议宿主实现自定义 IWebSearchProvider。
 */
export class FetchWebSearchProvider implements IWebSearchProvider {
  /**
   * 搜索互联网，返回结构化结果
   *
   * @param query - 搜索关键词
   * @param options - 搜索选项（limit 控制返回结果数量，默认 5）
   * @returns 结构化搜索结果列表
   */
  async search(query: string, options?: WebSearchOptions): Promise<SearchResult[]> {
    const limit = options?.limit ?? 5;
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

    const response = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });

    if (!response.ok) {
      throw new Error(`DuckDuckGo 搜索请求失败：HTTP ${response.status} ${response.statusText}`);
    }

    const html = await response.text();
    return parseDuckDuckGoHtml(html, limit);
  }
}