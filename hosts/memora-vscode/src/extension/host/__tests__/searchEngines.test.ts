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
