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
import { PRESET_SEARCH_ENGINES } from '../../shared/protocol.js';

/** 宿主预置解析策略实现：入参原始响应文本 + 数量上限，返回结构化结果 */
const HOST_PARSERS: Record<HostParseStrategy, (raw: string, limit: number) => SearchResult[]> = {
  openSearchRss: parseOpenSearchRss,
  jsonApi: parseJsonApi,
};

/** 宿主预置解析策略清单（运行期校验用单一真理源：与 HOST_PARSERS 键同源派生，禁另写字面量） */
export const HOST_PARSE_STRATEGIES = Object.keys(HOST_PARSERS) as HostParseStrategy[];

/**
 * 自定义引擎配置的**静态校验唯一判据**（SSOT，本模块的单一真理源）
 *
 * 「测试」与「保存」两条 UI 路径共用本函数；装配侧（resolveSearchEndpoints）亦复用同一判据
 * 做纵深过滤 ⇒ 三处消费、一处定义，禁在各消费点另写规则（否则必然漂移）。
 *
 * 为何不能只守 UI：持久化数据可绕过 UI 被改写——手改 User settings.json、设置同步从
 * 其它机器导入（application scope 已挡 workspace 覆盖，但挡不住这两条）。
 *
 * 返回错误原因；undefined = 合法。
 */
export function validateCustomEngines(
  engines: readonly CustomSearchEngineConfig[] | undefined,
): string | undefined {
  if (!Array.isArray(engines)) return '自定义搜索引擎清单格式无效';
  const seen = new Set<string>();
  for (const e of engines) {
    // 口径统一按 trim 后裁决：不依赖 webview 已 trim（手工改 settings.json 可直接绕过 UI）
    const name = e?.name?.trim();
    if (!name) return '配置无效：需填写引擎名称';
    // 自定义名不得与内置名重名：下拉选项经 Set 去重后同名只剩一项，
    // 而 resolveSearchEndpoints 先查自定义 ⇒ 会静默遮蔽内置引擎，用户无从分辨
    if ((PRESET_SEARCH_ENGINES as readonly string[]).includes(name)) {
      return `配置无效：名称「${name}」与内置引擎重名，请更换`;
    }
    if (!e.urlTemplate?.includes('{query}')) return '配置无效：URL 模板需含 {query} 占位符';
    if (!isAllowedUrlScheme(e.urlTemplate)) {
      return '配置无效：URL 模板须以 http:// 或 https:// 开头';
    }
    if (!HOST_PARSE_STRATEGIES.includes(e.parseStrategy)) return '配置无效：解析策略不是宿主预置项';
    if (seen.has(name)) return `配置无效：名称「${name}」重复，引擎名必须唯一`;
    seen.add(name);
  }
  return undefined;
}

/**
 * 协议白名单：只放行 http(s)。
 * 挡掉 file:// / javascript: / data: 等 ⇒ 避免「粘贴一段别人给的配置」就让
 * 宿主（extension）进程代为发起非预期请求，与项目既有的安全审计口径一致。
 */
function isAllowedUrlScheme(tpl: string): boolean {
  return /^https?:\/\//i.test(tpl);
}

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
  // ⚠️ 已知缺口（登记待办，不破「不动内核」原则）：内核 SEARCH_ENDPOINT_REGISTRY 未导出
  // 运行期引擎清单，宿主只能并列这份字面量。内核新增第 5 个预设引擎时，此处不同步的后果是
  // **该引擎选不中**（回落默认链 Bing→DuckDuckGo，安全降级不崩），非数据损坏。
  // 根治 = 内核导出清单（如 PRESET_SEARCH_ENGINE_NAMES），宿主改为派生。
}

/**
 * 解析当前激活引擎 → 内核端点链（单一出口，assemble 接线唯一调用点）
 *
 * - auto / 空           → undefined（内核走默认降级链 Bing→DuckDuckGo）
 * - 预设名              → buildSearchEndpoints([name, 'bing'])（委托内核 REGISTRY，Bing 兜底）
 * - 自定义名（命中配置）→ 该自定义端点 + bing 兜底
 * - 其它（无效）        → undefined（安全回退到 auto，不抛错）
 */
export function resolveSearchEndpoints(
  active: string | undefined,
  customs: readonly CustomSearchEngineConfig[],
): SearchEndpoint[] | undefined {
  if (!active || active === 'auto') return undefined;
  // 消费侧纵深护栏：UI 保存路径已用 validateCustomEngines 保证持久化干净，但手改
  // User settings.json / 设置同步可绕过 UI ⇒ 此处按**同一判据**逐项过滤，
  // 坏项不进入 fetch 路径（复用单点判据，不另写规则；静默剔除，UI 侧已负责告知）。
  const usable = customs.filter((e) => validateCustomEngines([e]) === undefined);
  const custom = findCustomEngine(active, usable);
  if (custom) {
    // 与预设分支口径统一：自定义端点在前、bing 兜底（修「自定义无兜底」口径分叉）。
    // 依据：内核 FetchWebSearchProvider.search 对「HTTP ok 但解析 0 条」的端点返回空数组
    // 且**不报错**（anyOk 语义），单端点无兜底时，自定义引擎一旦解析不出，
    // 用户将静默失去全部搜索结果；内核给结果打 endpoint 字段，来源可辨识。
    return [...buildSearchEndpoints([toSearchEndpoint(custom), 'bing'])];
  }
  if (isPresetEngine(active)) {
    // 选中预设即主用；非 bing 预设额外挂 bing 兜底（避免选中 bing 时自身重复成 [bing, bing]）
    const list: SearchEngineName[] = active === 'bing' ? [active] : [active, 'bing'];
    return [...buildSearchEndpoints(list)];
  }
  return undefined;
}

/**
 * 验证单个自定义引擎连通性：复用生产路径（FetchWebSearchProvider.search 内含 buildUrl+fetch+parse），
 * 以固定探测词实测一次。这是「保存前验证」的单一探针，既被 webview「测试」按钮调用，
 * 也被 setCustomSearchEngines 保存门禁复用（不另写抓取逻辑，零复制）。
 *
 * 口径（2026-10-14 审查修正，两层）：
 * ① `ok` 判定的是**管线正确性**（URL 可达 + 响应体可被策略解析），不是「对这个探测词有没有
 *    命中」——小众/垂类引擎对固定词 0 命中是正常现象，旧口径把「内容未命中」误判成
 *    「配置错误」，合法引擎存不进去（假阴性）。
 * ② 内核 search 的语义缺口：端点 parse 抛错会被 catch 吞进 errors，而 anyOk=true 时
 *    **返回空数组** ⇒ 宿主从返回值分不出
 *    「策略错配」与「真无命中」。解法 = **差分探测**：主策略 0 命中时，用其余宿主策略
 *    对同一 URL 复探——另一策略能解析出结果 ⇒ 用户选错策略（拦）；都解析不出 ⇒ 内容层
 *    无命中（放行）。差分只借生产 search 路径，零复制抓取编排。
 *
 * 残余边界（如实）：若引擎返回的是「不支持的结构化源」（如普通 HTML 搜索页），两策略都
 * 解析不出 ⇒ 放行；运行时靠 bing 兜底出结果，且 UI 状态点不亮、文案明示 0 条，用户知情。
 */
const PROBE_QUERY = 'memora test';

/** 以指定策略走一遍生产 search 路径（差分探测与主探测共用，零第二份编排） */
async function probeWithStrategy(
  cfg: CustomSearchEngineConfig,
  strategy: HostParseStrategy,
  query: string,
): Promise<SearchResult[]> {
  const provider = new FetchWebSearchProvider([
    toSearchEndpoint({ ...cfg, parseStrategy: strategy }),
  ]);
  return provider.search(query, { limit: 5 });
}

export async function probeSearchEngine(
  cfg: CustomSearchEngineConfig,
  query: string = PROBE_QUERY,
): Promise<SearchEngineTestResult> {
  try {
    const results = await probeWithStrategy(cfg, cfg.parseStrategy, query);
    if (results.length > 0) {
      return {
        engineName: cfg.name,
        ok: true,
        count: results.length,
        sample: results.slice(0, 3).map((r) => ({ title: r.title, url: r.url, snippet: r.snippet })),
      };
    }
    // 0 命中差分：换其余宿主策略复探同一 URL，能解析出 ⇒ 策略错配（拦）
    for (const alt of HOST_PARSE_STRATEGIES.filter((s) => s !== cfg.parseStrategy)) {
      const altResults = await probeWithStrategy(cfg, alt, query);
      if (altResults.length > 0) {
        return {
          engineName: cfg.name,
          ok: false,
          count: 0,
          error: `策略「${cfg.parseStrategy}」未解析出结果，但「${alt}」可以——请更换解析策略`,
        };
      }
    }
    // 所有策略都 0 命中：管线可达、内容层无命中 ⇒ 放行（count=0 由 UI 明示）
    return { engineName: cfg.name, ok: true, count: 0, sample: [] };
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

/** 剥离 CDATA 包裹 + 反转义常见 XML 实体（RSS/Atom 文本字段常见），得到干净文本 */
function decodeXmlText(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * OpenSearch RSS / Atom 风格：从 <item>/<entry> 抽取 title/link/description
 *
 * 0 节点 = 响应体根本不是 RSS/Atom（拿 HTML 当 RSS 配）⇒ **抛错**而非返回空数组：
 * 静默返回 [] 会让探针/内核把「策略错配」误判成「无命中」，配错的引擎反而能存进去、
 * 搜的时候静默无结果。抛错才能让保存门禁拦住（probe 捕获后 ok=false）。
 * 已有节点但缺 url 是另一回事（结构怪但确是 feed），按空结果处理、不抛。
 */
function parseOpenSearchRss(raw: string, limit: number): SearchResult[] {
  const blocks = raw.match(/<(item|entry)[\s\S]*?<\/(item|entry)>/gi) ?? [];
  if (blocks.length === 0) {
    throw new Error('响应中未找到 <item>/<entry> 节点（确认这是 RSS/Atom 源，且策略选对了吗）');
  }
  const results: SearchResult[] = [];
  for (const block of blocks) {
    if (results.length >= limit) break;
    const titleRaw = pick(block, /<title>([\s\S]*?)<\/title>/i)?.trim();
    // 标签名用非捕获组 (?:...)，内容捕获为第 1 组；pick() 取 [1] 即内容（修复旧版误取标签名导致 url="link"）
    const linkInner = pick(block, /<(?:link|id)>([\s\S]*?)<\/(?:link|id)>/i)?.trim();
    const descInner = pick(block, /<(?:description|summary)>([\s\S]*?)<\/(?:description|summary)>/i)?.trim();
    const title = decodeXmlText(titleRaw ?? '');
    // 内部文本为空（如 Atom <link href>）才回退到属性；decodeXmlText('') 为假值触发 || 兜底
    const url =
      decodeXmlText(linkInner ?? '') || decodeXmlText(pickAttr(block, /<link[^>]*href="([^"]*)"/i) ?? '');
    const snippet = decodeXmlText(descInner ?? '');
    if (url) results.push({ title: title || url, url, snippet });
  }
  return results;
}

/**
 * JSON 搜索 API：多源字段别名宽容（2026-10-13 第二档落地）
 * 不同搜索 API 字段命名各异——单写死 results/items + title/url/snippet 会漏掉
 * HN(hits[])、SearXNG(content 摘要)、WordPress(name/link/description) 等常见形态。
 * 别名集中此处单一维护（SSOT），禁在各调用点散写 ?? 链。
 *
 * 失败口径与 RSS 对称：JSON.parse 失败、或找不到任何受支持的数组键 ⇒ **抛错**
 * （响应体不是 JSON / 用了不支持的嵌套结构），让保存门禁拦住错配，而非静默空结果。
 * 已知边界：嵌套数组（web.results / query.search）不在 JSON_ARRAY_KEYS 内 ⇒ 会在此抛错，
 * 属「未支持」而非「静默错」，待独立排期。
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
    throw new Error('响应体不是合法 JSON（确认这是 JSON API，且策略选对了吗）');
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('JSON 根节点不是对象');
  }
  const obj = data as Record<string, unknown>;
  let arr: unknown = undefined;
  for (const k of JSON_ARRAY_KEYS) {
    if (Array.isArray(obj[k])) {
      arr = obj[k];
      break;
    }
  }
  if (!Array.isArray(arr)) {
    throw new Error(`JSON 中未找到结果数组（支持的键：${JSON_ARRAY_KEYS.join(' / ')}）`);
  }
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
