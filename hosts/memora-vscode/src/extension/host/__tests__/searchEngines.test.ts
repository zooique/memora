import { describe, it, expect } from 'vitest';
import { toSearchEndpoint } from '../searchEngines.js';
import type { CustomSearchEngineConfig } from '../../../shared/protocol.js';

function jsonCfg(): CustomSearchEngineConfig {
  return { name: 'UnitTest', urlTemplate: 'https://x.test/?q={query}', parseStrategy: 'jsonApi' };
}

describe('searchEngines.parseJsonApi — 多源字段别名宽容（2026-10-13 第二档落地）', () => {
  it('约定形态 results[].{title,url,snippet} 全字段保留', () => {
    const raw = JSON.stringify({
      results: [{ title: 'A', url: 'https://a', snippet: 'sa' }, { title: 'B', url: 'https://b', snippet: 'sb' }],
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

  it('非法 JSON 返回空数组（不抛）', () => {
    const out = toSearchEndpoint(jsonCfg()).parse('not json', 10);
    expect(out).toEqual([]);
  });
});

describe('searchEngines.parseOpenSearchRss — 标签名误取修复 + CDATA/实体（2026-10-13 排雷补测）', () => {
  function rssCfg(): CustomSearchEngineConfig {
    return { name: 'UnitRss', urlTemplate: 'https://x.test/?q={query}', parseStrategy: 'openSearchRss' };
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

  it('无 <item>/<entry> 返回空数组', () => {
    const out = toSearchEndpoint(rssCfg()).parse('<rss><channel></channel></rss>', 10);
    expect(out).toEqual([]);
  });
});
