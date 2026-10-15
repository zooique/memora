/**
 * 基于 fetch 的默认网络搜索实现（FetchWebSearchProvider）
 * 多后端降级链：Bing（国内可达，首选）→ DuckDuckGo（备用），各端点独立超时，失败/空结果时降级到下一端点。
 * 使用 Node.js 18+ 内置 fetch，零依赖。仅用于"开箱即用"场景，生产环境建议宿主实现 IWebSearchProvider 用专用搜索 API。
 */
import type {
  IWebSearchProvider,
  SearchResult,
  WebSearchOptions,
  SearchEndpoint,
} from '@/web-search/types.js';
import { BROWSER_UA, fetchWithTimeout } from '@/utils/http.js';

/** 单端点请求超时（ms）：Bing 通常 1-2s 返回，10s 覆盖慢网络且不至于拖死主循环 */
const ENDPOINT_TIMEOUT_MS = 10_000;

/**
 * 从 Bing 结果页 HTML 提取结果：结果条目 = `<li class="b_algo">` 块，块内 `<h2><a>` 取
 * 标题+链接、块内 `<p class="b_lineclamp*">` 取摘要。
 * 用正则而非 DOM 解析，避免引入 jsdom 依赖。
 *
 * **块内配对**（而非全文两个正则数组按 index 配对，SEARCH-QUALITY-1 P2-2 修订）：
 * 标题与摘要必须在同一结果块内成对——全文收集 `titles[]`/`snippets[]` 后按 index 配对时，
 * 结果块之外的任何 `b_lineclamp`（推荐位/广告位/侧栏）都会造成错位：模块摘要被贴到
 * 下一个结果标题上，LLM 读到「标题二 + 干扰摘要」的错位组合（搜不准的解析层根因）。
 * 结构漂移（无 b_algo 块）→ 零结果 → 降级链切下一端点 = 诚实失败，不产错位垃圾。
 * 块内提取范式同 parseBaiduHtml（仓内既有正确先例，嫁接而非新造）。
 */
function parseBingHtml(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];
  // 结果块：<li …b_algo…>…</li>（[^>]* 容忍附加 class/属性，如 b_algoBorder）。
  // ⚠️ 正则内**禁写引号**（如 class="[^"]*b_algo…）：toolFailurePrefixGuard 的字符串字面量
  // 提取器会把正则内的引号配对成伪字面量（`[^` → 盲区标记 `^`，旧 `^>` 同源产物）——
  // 无引号写法对 Bing 的 <li class="b_algo"> 同等正确且不新增扫描噪声。
  const blockRegex = /<li[^>]*b_algo[^>]*>([\s\S]*?)<\/li>/gi;
  let match: RegExpExecArray | null;
  while ((match = blockRegex.exec(html)) !== null && results.length < limit) {
    const block = match[1]!;
    // 标题 + 链接：块内 <h2><a href>（块内无标题 = 非结果块，跳过不占结果位）
    const titleMatch = /<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!titleMatch) continue;
    const url = titleMatch[1]!.replace(/&amp;/g, '&').trim();
    const title = titleMatch[2]!.replace(/<[^>]*>/g, '').trim();
    if (!url || !title) continue;
    // 摘要：块内 <p class="b_lineclamp*>（块内无摘要 → 空串，不跨块借用）
    const snipMatch = /<p[^>]*class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    const snippet = snipMatch?.[1]?.replace(/<[^>]*>/g, '').trim() ?? '';
    results.push({ title, url, snippet });
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

/**
 * 百度搜索结果页 HTML 解析（中文场景命中质量通常优于 Bing 抓取）。
 * 结构：结果条目 h3[class*=c-title] 内 <a href>，摘要取紧随的 content-right / c-abstract 块。
 * 反爬时页面无结果结构 → 返回空数组，由降级链自动切换下一点端。
 */
function parseBaiduHtml(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];
  const itemRegex = /<h3[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>/gi;
  let match: RegExpExecArray | null;
  while ((match = itemRegex.exec(html)) !== null && results.length < limit) {
    const url = match[1]!.replace(/&amp;/g, '&').trim();
    const title = match[2]!.replace(/<[^>]*>/g, '').trim();
    if (!url || !title) continue;
    // 摘要：标题块之后 800 字符范围内取首个内容摘要块（新版 content-right / 旧版 c-abstract）
    const after = html.slice(match.index + match[0].length, match.index + match[0].length + 800);
    const snipMatch = /(?:content-right|c-abstract)[^>]*>([\s\S]*?)<\/span>/i.exec(after);
    const snippet = snipMatch?.[1]?.replace(/<[^>]*>/g, '').trim() ?? '';
    results.push({ title, url, snippet });
  }
  return results;
}

/**
 * 搜狗搜索结果页 HTML 解析。结构：div.vrwrap > h3.vr-title > a[href]，摘要 .str_info / .space-txt。
 */
function parseSogouHtml(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];
  const itemRegex = /<h3[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>/gi;
  let match: RegExpExecArray | null;
  while ((match = itemRegex.exec(html)) !== null && results.length < limit) {
    const url = match[1]!.replace(/&amp;/g, '&').trim();
    const title = match[2]!.replace(/<[^>]*>/g, '').trim();
    if (!url || !title) continue;
    const after = html.slice(match.index + match[0].length, match.index + match[0].length + 800);
    const snipMatch = /(?:str_info|space-txt)[^>]*>([\s\S]*?)<\/(?:div|p)>/i.exec(after);
    const snippet = snipMatch?.[1]?.replace(/<[^>]*>/g, '').trim() ?? '';
    results.push({ title, url, snippet });
  }
  return results;
}

/** 可切换的内置搜索引擎名（宿主设置 memora.searchEngine 对应枚举） */
export type SearchEngineName = 'bing' | 'duckduckgo' | 'baidu' | 'sogou';

/**
 * 内置端点注册表（零配置保底基线，非真理源）：端点名 → 定义。
 * FetchWebSearchProvider 默认链与 buildSearchEndpoints 的预设名均取自此处；
 * 宿主可传入自定义 SearchEndpoint 覆盖/扩展，无需改这里。
 */
const SEARCH_ENDPOINT_REGISTRY: Readonly<Record<SearchEngineName, SearchEndpoint>> = {
  bing: {
    name: 'Bing',
    buildUrl: (query) => `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
    parse: parseBingHtml,
  },
  duckduckgo: {
    name: 'DuckDuckGo',
    buildUrl: (query) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    parse: parseDuckDuckGoHtml,
  },
  baidu: {
    name: 'Baidu',
    buildUrl: (query) => `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`,
    parse: parseBaiduHtml,
  },
  sogou: {
    name: 'Sogou',
    buildUrl: (query) => `https://www.sogou.com/web?query=${encodeURIComponent(query)}`,
    parse: parseSogouHtml,
  },
};

/** 默认端点降级链：Bing（国内可达）→ DuckDuckGo（备用） */
const DEFAULT_ENDPOINTS: readonly SearchEndpoint[] = [
  SEARCH_ENDPOINT_REGISTRY.bing,
  SEARCH_ENDPOINT_REGISTRY.duckduckgo,
];

/**
 * 构建搜索端点降级链：入参为「内核预设名（SearchEngineName）| 宿主自定义 SearchEndpoint」混排，
 * 按给定顺序组装；宿主传入的自定义端点优先生效，未知预设名忽略。
 * 全部无效 / 空列表回退默认链（Bing→DuckDuckGo），保证零配置也开箱可用。
 * 主推宿主接入：生产环境建议宿主自建 SearchEndpoint[]（自带 URL+解析）注入，内核预设仅作保底。
 */
export function buildSearchEndpoints(
  items: readonly (SearchEngineName | SearchEndpoint)[],
): readonly SearchEndpoint[] {
  const picked = items
    .map((item): SearchEndpoint | undefined =>
      typeof item === 'string' ? SEARCH_ENDPOINT_REGISTRY[item] : item,
    )
    .filter((e): e is SearchEndpoint => e !== undefined && e !== null);
  return picked.length > 0 ? picked : DEFAULT_ENDPOINTS;
}

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
        const response = await fetchWithTimeout(
          endpoint.buildUrl(query),
          ENDPOINT_TIMEOUT_MS,
          BROWSER_UA,
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
          // 打标实际服务的后端名称，供降级透出：同批次结果来自同一端点
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
}
