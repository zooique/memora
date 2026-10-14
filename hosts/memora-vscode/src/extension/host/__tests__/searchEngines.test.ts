import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  toSearchEndpoint,
  probeSearchEngine,
  resolveSearchEndpoints,
  validateCustomEngines,
} from '../searchEngines.js';
import type { CustomSearchEngineConfig } from '../../../shared/protocol.js';

function jsonCfg(): CustomSearchEngineConfig {
  return { name: 'UnitTest', urlTemplate: 'https://x.test/?q={query}', parseStrategy: 'jsonApi' };
}

describe('searchEngines.parseJsonApi — 多源字段别名宽容（2026-10-13 第二档落地）', () => {
  it('约定形态 results[].{title,url,snippet} 全字段保留', () => {
    const raw = JSON.stringify({
      results: [
        { title: 'A', url: 'https://a', snippet: 'sa' },
        { title: 'B', url: 'https://b', snippet: 'sb' },
      ],
    });
    const out = toSearchEndpoint(jsonCfg()).parse(raw, 10);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ title: 'A', url: 'https://a', snippet: 'sa' });
  });

  it('HN/SearXNG 风格 hits[].{title,url,content}：摘要由 content 兜底（证实修复）', () => {
    const raw = JSON.stringify({
      hits: [{ title: 'HN', url: 'https://news.ycombinator.com/1', content: 'HN snippet text' }],
    });
    const out = toSearchEndpoint(jsonCfg()).parse(raw, 10);
    expect(out).toHaveLength(1);
    // 此前写死 snippet/description/summary → 此处 content 会被漏成空；现应命中
    expect(out[0].snippet).toBe('HN snippet text');
    expect(out[0].title).toBe('HN');
    expect(out[0].url).toBe('https://news.ycombinator.com/1');
  });

  it('items[].{name,link,description} 别名：title/url/snippet 各自映射', () => {
    const raw = JSON.stringify({
      items: [{ name: 'Item', link: 'https://item', description: 'desc here' }],
    });
    const out = toSearchEndpoint(jsonCfg()).parse(raw, 10);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ title: 'Item', url: 'https://item', snippet: 'desc here' });
  });

  it('无 url 的条目被过滤', () => {
    const raw = JSON.stringify({ results: [{ title: 'NoUrl', snippet: 'x' }] });
    const out = toSearchEndpoint(jsonCfg()).parse(raw, 10);
    expect(out).toHaveLength(0);
  });

  it('非法 JSON → 抛错（非静默空数组：策略错配必须被保存门禁拦住）', () => {
    // 2026-10-14 口径修正：旧实现 JSON.parse 失败 return [] ⇒ 探针/内核把「拿 HTML 当
    // JSON 配」误判成「无命中」，错配配置反而能存进去、搜时静默无结果。
    expect(() => toSearchEndpoint(jsonCfg()).parse('not json', 10)).toThrow(/不是合法 JSON/);
  });

  it('找不到受支持的数组键 → 抛错（点明支持的键，含嵌套结构未支持的告知）', () => {
    const raw = JSON.stringify({ web: { results: [{ title: 'a', url: 'https://a' }] } });
    expect(() => toSearchEndpoint(jsonCfg()).parse(raw, 10)).toThrow(/未找到结果数组/);
  });
});

describe('searchEngines.parseOpenSearchRss — 标签名误取修复 + CDATA/实体（2026-10-13 排雷补测）', () => {
  function rssCfg(): CustomSearchEngineConfig {
    return {
      name: 'UnitRss',
      urlTemplate: 'https://x.test/?q={query}',
      parseStrategy: 'openSearchRss',
    };
  }

  it('抽取 <item> 的 title/link/description：url 取内容而非标签名（修复 url="link" 静默损坏）', () => {
    const raw = `<rss><channel><item><title>Hello</title><link>https://x.com/a</link><description>desc text</description></item></channel></rss>`;
    const out = toSearchEndpoint(rssCfg()).parse(raw, 10);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ title: 'Hello', url: 'https://x.com/a', snippet: 'desc text' });
  });

  it('CDATA 包裹被剥离 + &amp; 反转义为 &（URL 含查询参数场景）', () => {
    const raw = `<item><title><![CDATA[W & A]]></title><link><![CDATA[https://x.com/?a=1&amp;b=2]]></link><description><![CDATA[<b>hi</b>]]></description></item>`;
    const out = toSearchEndpoint(rssCfg()).parse(raw, 10);
    expect(out[0].title).toBe('W & A');
    expect(out[0].url).toBe('https://x.com/?a=1&b=2');
  });

  it('Atom <link href> 兜底（无内部文本）', () => {
    const raw = `<entry><title>Atom</title><link href="https://atom.com/x"/></entry>`;
    const out = toSearchEndpoint(rssCfg()).parse(raw, 10);
    expect(out[0].url).toBe('https://atom.com/x');
  });

  it('无 <item>/<entry> → 抛错（拿普通 HTML 当 RSS 配 = 策略错配，不静默）', () => {
    const raw = '<html><body>no feed here</body></html>';
    expect(() => toSearchEndpoint(rssCfg()).parse(raw, 10)).toThrow(/未找到 <item>\/<entry>/);
  });

  it('有 item 但缺 link/id → 空结果（确是 feed 但结构缺字段，不抛）', () => {
    const raw = `<rss><channel><item><title>NoLink</title></item></channel></rss>`;
    expect(toSearchEndpoint(rssCfg()).parse(raw, 10)).toEqual([]);
  });
});

/**
 * resolveSearchEndpoints —— assemble 接线的唯一出口，此前**零测试覆盖**
 * （2026-10-14 审查：覆盖倒挂——两个 parser 有 9 条用例，最核心的三分支解析函数没人钉）。
 */
describe('resolveSearchEndpoints — 唯一出口三分支 + 兜底口径', () => {
  const CUSTOM: CustomSearchEngineConfig = {
    name: 'MyApi',
    urlTemplate: 'https://api.test/search?q={query}',
    parseStrategy: 'jsonApi',
  };

  it('auto / 空 → undefined（走内核默认链 Bing→DuckDuckGo）', () => {
    expect(resolveSearchEndpoints('auto', [CUSTOM])).toBeUndefined();
    expect(resolveSearchEndpoints(undefined, [CUSTOM])).toBeUndefined();
    expect(resolveSearchEndpoints('', [CUSTOM])).toBeUndefined();
  });

  it('预设 bing → 单端点（不自身重复成 [bing, bing]）', () => {
    const eps = resolveSearchEndpoints('bing', []);
    expect(eps?.map((e) => e.name)).toEqual(['Bing']);
  });

  it('预设 baidu → [Baidu, Bing]（首选在前、Bing 兜底）', () => {
    const eps = resolveSearchEndpoints('baidu', []);
    expect(eps?.map((e) => e.name)).toEqual(['Baidu', 'Bing']);
  });

  it('自定义名 → [自定义, Bing] 兜底（与预设分支口径统一，修单端点无兜底分叉）', () => {
    const eps = resolveSearchEndpoints('MyApi', [CUSTOM]);
    // 第 1 项是用户配置（buildUrl 含其模板），第 2 项是内核 REGISTRY 的 bing
    expect(eps).toHaveLength(2);
    expect(eps?.[0].buildUrl('a b')).toBe('https://api.test/search?q=a%20b');
    expect(eps?.[1].name).toBe('Bing');
  });

  it('未知名 → undefined（安全回退默认链，不抛错）', () => {
    expect(resolveSearchEndpoints('ghost', [CUSTOM])).toBeUndefined();
  });

  it('脏配置不进 fetch 路径：parseStrategy 非法项被过滤 ⇒ 该名视为不存在', () => {
    const dirty = { ...CUSTOM, parseStrategy: 'evil' as never };
    // 若不过滤，toSearchEndpoint 会造出 parse=undefined 的端点，内核一调用即 TypeError
    expect(resolveSearchEndpoints('MyApi', [dirty])).toBeUndefined();
  });

  it('脏配置不影响合法项：混合清单中合法引擎照常解析', () => {
    const dirty = { ...CUSTOM, name: 'Broken', parseStrategy: 'evil' as never };
    const eps = resolveSearchEndpoints('MyApi', [dirty, CUSTOM]);
    expect(eps).toHaveLength(2);
    expect(eps?.[0].buildUrl('q')).toContain('api.test');
  });
});

/**
 * probeSearchEngine —— 保存门禁的单一探针。
 * 口径（2026-10-14 修正）：ok = 管线正确性（URL 可达 + 响应体可解析），
 * 不是「对探测词有没有命中」——后者把小众引擎的 0 命中误判为配置错误（假阴性）。
 */
describe('probeSearchEngine — 保存门禁探针', () => {
  const CFG: CustomSearchEngineConfig = {
    name: 'MyApi',
    urlTemplate: 'https://api.test/search?q={query}',
    parseStrategy: 'jsonApi',
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(resp: { ok: boolean; body: string } | Error): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        resp instanceof Error
          ? Promise.reject(resp)
          : Promise.resolve({ ok: resp.ok, status: 200, text: () => Promise.resolve(resp.body) }),
      ),
    );
  }

  it('管线通 + 有命中 → ok=true，count 反映命中数', async () => {
    stubFetch({ ok: true, body: JSON.stringify({ results: [{ title: 'A', url: 'https://a' }] }) });
    const r = await probeSearchEngine(CFG);
    expect(r.ok).toBe(true);
    expect(r.count).toBe(1);
    expect(r.sample?.[0]?.url).toBe('https://a');
    expect(r.error).toBeUndefined();
  });

  it('管线通 + 0 命中 → 仍 ok=true（接口可达但未解析出结果，不误拒合法引擎）', async () => {
    stubFetch({ ok: true, body: JSON.stringify({ results: [] }) });
    const r = await probeSearchEngine(CFG);
    expect(r.ok).toBe(true);
    expect(r.count).toBe(0);
  });

  it('策略错配（RSS 源配了 jsonApi）→ 差分探测抓获 ⇒ ok=false 指引换策略', async () => {
    // 同一 URL 两次请求返回同一 RSS body：jsonApi 解析 0（JSON.parse 抛 → anyOk=true → []），
    // 差分 openSearchRss 能解析出 ⇒ 判定「策略选错」而非「无命中」
    const rss = `<rss><channel><item><title>T</title><link>https://a</link></item></channel></rss>`;
    stubFetch({ ok: true, body: rss });
    const r = await probeSearchEngine(CFG);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('请更换解析策略');
    expect(r.count).toBe(0);
  });

  it('真 0 命中（合法 JSON 空结果集，差分也解析不出）→ ok=true 放行（不误拒小众引擎）', async () => {
    stubFetch({ ok: true, body: JSON.stringify({ results: [] }) });
    const r = await probeSearchEngine(CFG);
    expect(r.ok).toBe(true);
    expect(r.count).toBe(0);
  });

  it('HTTP 非 ok → ok=false', async () => {
    stubFetch({ ok: false, body: '' });
    const r = await probeSearchEngine(CFG);
    expect(r.ok).toBe(false);
  });

  it('网络层失败 → ok=false，不抛给调用方', async () => {
    stubFetch(new Error('ECONNREFUSED'));
    const r = await probeSearchEngine(CFG);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('ECONNREFUSED');
  });
});

/**
 * validateCustomEngines 在本域的定义守卫：判据曾只守 UI 前门（手改 settings.json 可绕过），
 * 现由 resolveSearchEndpoints 在同一判据上做消费侧过滤 ⇒ 两处共用、零第二份规则。
 */
describe('validateCustomEngines — 与 resolveSearchEndpoints 同源复用', () => {
  const OK: CustomSearchEngineConfig = {
    name: 'MyApi',
    urlTemplate: 'https://api.test/search?q={query}',
    parseStrategy: 'jsonApi',
  };
  it('同一函数既被 UI 保存路径调用、也被 resolveSearchEndpoints 过滤调用', () => {
    expect(validateCustomEngines([OK])).toBeUndefined();
    expect(validateCustomEngines([{ ...OK, name: '' }])).toContain('引擎名称');
  });
});
