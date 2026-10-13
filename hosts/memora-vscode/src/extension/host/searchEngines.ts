/**
 * 宿主侧网页搜索引擎适配层（单一嫁接点，SSOT）
 *
 * 内核已通过公开 `.` 入口导出 SearchEndpoint / buildSearchEndpoints /
 * FetchWebSearchProvider / SearchEngineName（见 dist/index.d.ts）。
 * 本文件是「宿主配置形态 → 内核 SearchEndpoint[]」的唯一转换处，零复制内核解析逻辑：
 *   - 预设引擎：委托 buildSearchEndpoints（内核 REGISTRY 为唯一真理源，宿主不重写 HTML 解析）；
 *   - 自定义引擎：仅实现与内核 4 个 HTML 解析器【不重叠】的【结构化结果源】策略
 *     （OpenSearch RSS / JSON 搜索 API）——是生长而非复制。
 *
 * 不动内核即可落地：本功能只是把宿主设置接进内核预留的 SearchEndpoint 扩展点。
 */
import type { SearchEndpoint, SearchResult, SearchEngineName } from '@zooique/memora';
import { buildSearchEndpoints, FetchWebSearchProvider } from '@zooique/memora';
import type {
  CustomSearchEngineConfig,
  HostParseStrategy,
  SearchEngineTestResult,
} from '../../shared/protocol.js';

/** 宿主预置解析策略实现：入参原始响应文本 + 数量上限，返回结构化结果 */
const HOST_PARSERS: Record<HostParseStrategy, (raw: string, limit: number) => SearchResult[]> = {
  openSearchRss: parseOpenSearchRss,
  jsonApi: parseJsonApi,
};

/** 宿主预置解析策略清单（运行期校验用单一真理源：与 HOST_PARSERS 键同源派生，禁另写字面量） */
export const HOST_PARSE_STRATEGIES = Object.keys(HOST_PARSERS) as HostParseStrategy[];

/** 把用户配置转换为内核 SearchEndpoint（自定义端点优先生效） */
export function toSearchEndpoint(cfg: CustomSearchEngineConfig): SearchEndpoint {
  const parse = HOST_PARSERS[cfg.parseStrategy];
  return {
    name: cfg.name,
    buildUrl: (query: string) => cfg.urlTemplate.replace(/\{query\}/g, encodeURIComponent(query)),
    parse: (html: string, limit: number) => parse(html, limit),
  };
}

/** 按名称命中自定义配置 */
export function findCustomEngine(
  name: string,
  engines: readonly CustomSearchEngineConfig[],
): CustomSearchEngineConfig | undefined {
  return engines.find((e) => e.name === name);
}

/** 类型谓词：收窄为内核预设引擎名（与内核 SearchEngineName 对齐） */
function isPresetEngine(name: string): name is SearchEngineName {
  return name === 'bing' || name === 'duckduckgo' || name === 'baidu' || name === 'sogou';
}

/**
 * 解析当前激活引擎 → 内核端点链（单一出口，assemble 接线唯一调用点）
 *
 * - auto / 空           → undefined（内核走默认降级链 Bing→DuckDuckGo）
 * - 预设名              → buildSearchEndpoints([name, 'bing'])（委托内核 REGISTRY，Bing 兜底）
 * - 自定义名（命中配置）→ 仅该自定义端点
 * - 其它（无效）        → undefined（安全回退到 auto，不抛错）
 */
export function resolveSearchEndpoints(
  active: string | undefined,
  customs: readonly CustomSearchEngineConfig[],
): SearchEndpoint[] | undefined {
  if (!active || active === 'auto') return undefined;
  const custom = findCustomEngine(active, customs);
  if (custom) return [toSearchEndpoint(custom)];
  if (isPresetEngine(active)) {
    // 选中预设即主用；非 bing 预设额外挂 bing 兜底（避免选中 bing 时自身重复成 [bing, bing]）
    const list: SearchEngineName[] = active === 'bing' ? [active] : [active, 'bing'];
    return [...buildSearchEndpoints(list)];
  }
  return undefined;
}

/**
 * 验证单个自定义引擎连通性：复用生产路径（FetchWebSearchProvider.search 内含 buildUrl+fetch+parse），
 * 以固定探测词实测一次，返回是否解析出 ≥1 条结果。这是「保存前验证」的单一探针，
 * 既被 webview「测试」按钮调用，也被 setCustomSearchEngines 保存门禁复用（不另写抓取逻辑，零复制）。
 */
const PROBE_QUERY = 'memora test';

export async function probeSearchEngine(cfg: CustomSearchEngineConfig): Promise<SearchEngineTestResult> {
  try {
    const provider = new FetchWebSearchProvider([toSearchEndpoint(cfg)]);
    const results = await provider.search(PROBE_QUERY, { limit: 5 });
    return {
      engineName: cfg.name,
      ok: results.length > 0,
      count: results.length,
      sample: results.slice(0, 3).map((r) => ({ title: r.title, url: r.url, snippet: r.snippet })),
    };
  } catch (err) {
    return {
      engineName: cfg.name,
      ok: false,
      count: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── 结构化结果解析（与内核 HTML 解析零重叠）───

/** OpenSearch RSS / Atom 风格：从 <item>/<entry> 抽取 title/link/description */
function parseOpenSearchRss(raw: string, limit: number): SearchResult[] {
  const blocks = raw.match(/<(item|entry)[\s\S]*?<\/(item|entry)>/gi) ?? [];
  const results: SearchResult[] = [];
  for (const block of blocks) {
    if (results.length >= limit) break;
    const title = pick(block, /<title>([\s\S]*?)<\/title>/i)?.trim() ?? '';
    const url =
      pick(block, /<(link|id)>([\s\S]*?)<\/(link|id)>/i)?.trim() ??
      pickAttr(block, /<link[^>]*href="([^"]*)"/i) ??
      '';
    const snippet =
      pick(block, /<(description|summary)>([\s\S]*?)<\/(description|summary)>/i)?.trim() ?? '';
    if (url) results.push({ title: title || url, url, snippet });
  }
  return results;
}

/**
 * JSON 搜索 API：多源字段别名宽容（2026-10-13 第二档落地）
 * 不同搜索 API 字段命名各异——单写死 results/items + title/url/snippet 会漏掉
 * HN(hits[])、SearXNG(content 摘要)、WordPress(name/link/description) 等常见形态。
 * 别名集中此处单一维护（SSOT），禁在各调用点散写 ?? 链。
 */
const JSON_ARRAY_KEYS = ['results', 'items', 'hits'] as const;
const JSON_URL_KEYS = ['url', 'link', 'href'] as const;
const JSON_TITLE_KEYS = ['title', 'name'] as const;
const JSON_SNIPPET_KEYS = ['snippet', 'description', 'summary', 'content'] as const;

/** 按别名优先级取首个非空字段值（空串亦视为未提供，向后兜底） */
function pickFirst(obj: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function parseJsonApi(raw: string, limit: number): SearchResult[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const obj = data as Record<string, unknown>;
  let arr: unknown = undefined;
  for (const k of JSON_ARRAY_KEYS) {
    if (Array.isArray(obj[k])) {
      arr = obj[k];
      break;
    }
  }
  if (!Array.isArray(arr)) return [];
  return (arr as unknown[])
    .slice(0, limit)
    .map((item) => {
      const o = item as Record<string, unknown>;
      const url = String(pickFirst(o, JSON_URL_KEYS) ?? '');
      const title = String(pickFirst(o, JSON_TITLE_KEYS) ?? url);
      const snippet = String(pickFirst(o, JSON_SNIPPET_KEYS) ?? '');
      return { title, url, snippet };
    })
    .filter((r) => r.url !== '');
}

function pick(block: string, re: RegExp): string | undefined {
  return block.match(re)?.[1];
}

function pickAttr(block: string, re: RegExp): string | undefined {
  return block.match(re)?.[1];
}
