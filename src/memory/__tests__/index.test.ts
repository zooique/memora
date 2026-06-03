/**
 * 单元测试：SQLite 记忆索引
 * 验证索引的 CRUD 与查询逻辑
 * 适配 sqlite3 (mapbox) 异步 API
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { MemoryIndex } from '@/memory/index.js';
import { MemoryType, Permanence } from '@/memory/types.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';

describe('MemoryIndex · SQLite 索引', () => {
  let tmpDir: string;
  let index: MemoryIndex;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memora-index-'));
    index = new MemoryIndex(join(tmpDir, 'test.db'));
  });

  afterEach(async () => {
    await index.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('应该创建 memories 表', async () => {
    const memories = await index.getByType(MemoryType.RULE);
    expect(memories).toEqual([]);
  });

  it('应该插入并读取一条记忆', async () => {
    const memory = {
      id: 'rule:test',
      type: MemoryType.RULE,
      permanence: Permanence.ALWAYS,
      name: 'test',
      content: '测试内容',
      tags: ['test'],
      weight: 0.8,
      createdAt: '2026-06-02T00:00:00.000Z',
      updatedAt: '2026-06-02T00:00:00.000Z',
    };
    await index.upsert(memory);

    const results = await index.getByType(MemoryType.RULE);
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe('rule:test');
    expect(results[0]?.content).toBe('测试内容');
  });

  it('应该按永久性等级过滤', async () => {
    await index.upsert({
      id: 'rule:always',
      type: MemoryType.RULE,
      permanence: Permanence.ALWAYS,
      name: 'always',
      content: 'c1',
      tags: [],
      weight: 0.5,
      createdAt: '2026-06-02T00:00:00.000Z',
      updatedAt: '2026-06-02T00:00:00.000Z',
    });
    await index.upsert({
      id: 'rule:topic',
      type: MemoryType.RULE,
      permanence: Permanence.TOPIC,
      name: 'topic',
      content: 'c2',
      tags: [],
      weight: 0.5,
      createdAt: '2026-06-02T00:00:00.000Z',
      updatedAt: '2026-06-02T00:00:00.000Z',
    });

    const always = await index.getByPermanence(Permanence.ALWAYS);
    expect(always).toHaveLength(1);
    expect(always[0]?.id).toBe('rule:always');
  });

  it('应该支持 upsert（更新已存在的）', async () => {
    await index.upsert({
      id: 'rule:test',
      type: MemoryType.RULE,
      permanence: Permanence.ALWAYS,
      name: 'test',
      content: 'old',
      tags: [],
      weight: 0.5,
      createdAt: '2026-06-02T00:00:00.000Z',
      updatedAt: '2026-06-02T00:00:00.000Z',
    });
    await index.upsert({
      id: 'rule:test',
      type: MemoryType.RULE,
      permanence: Permanence.ALWAYS,
      name: 'test',
      content: 'new',
      tags: [],
      weight: 0.5,
      createdAt: '2026-06-02T00:00:00.000Z',
      updatedAt: '2026-06-02T00:00:00.000Z',
    });

    const results = await index.getByType(MemoryType.RULE);
    expect(results).toHaveLength(1);
    expect(results[0]?.content).toBe('new');
  });

  it('应该支持简单文本搜索', async () => {
    await index.upsert({
      id: 'rule:core',
      type: MemoryType.RULE,
      permanence: Permanence.ALWAYS,
      name: 'core',
      content: '诚实优先',
      tags: [],
      weight: 0.9,
      createdAt: '2026-06-02T00:00:00.000Z',
      updatedAt: '2026-06-02T00:00:00.000Z',
    });
    await index.upsert({
      id: 'rule:safe',
      type: MemoryType.RULE,
      permanence: Permanence.ALWAYS,
      name: 'safe',
      content: '工具安全',
      tags: [],
      weight: 0.5,
      createdAt: '2026-06-02T00:00:00.000Z',
      updatedAt: '2026-06-02T00:00:00.000Z',
    });

    const results = await index.search('诚实');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.content).toContain('诚实');
  });

  it('M-202 · 应该支持中文分词搜索（match 模式）', async () => {
    await index.upsert({
      id: 'rule:human',
      type: MemoryType.RULE,
      permanence: Permanence.ALWAYS,
      name: 'human',
      content: '万物皆记忆是 Memora 的核心哲学',
      tags: ['哲学'],
      weight: 0.9,
      createdAt: '2026-06-02T00:00:00.000Z',
      updatedAt: '2026-06-02T00:00:00.000Z',
    });
    await index.upsert({
      id: 'skill:tech',
      type: MemoryType.SKILL,
      permanence: Permanence.DOMAIN,
      name: 'tech',
      content: 'TypeScript strict 模式最佳实践',
      tags: ['技术'],
      weight: 0.7,
      createdAt: '2026-06-02T00:00:00.000Z',
      updatedAt: '2026-06-02T00:00:00.000Z',
    });

    // match 模式：任一 token 命中
    const matchResults = await index.search('Memora 哲学', 10, 'match');
    expect(matchResults.length).toBeGreaterThanOrEqual(1);
    expect(matchResults.some((m) => m.id === 'rule:human')).toBe(true);

    // 单 token 中文
    const singleResults = await index.search('记忆');
    expect(singleResults.length).toBeGreaterThanOrEqual(1);
    expect(singleResults[0]?.content).toContain('记忆');
  });

  it('M-202 · 应该支持中文分词搜索（near 模式：所有 token 必须命中）', async () => {
    await index.upsert({
      id: 'rule:both',
      type: MemoryType.RULE,
      permanence: Permanence.ALWAYS,
      name: 'both',
      content: '记忆和诚实都是核心',
      tags: [],
      weight: 0.9,
      createdAt: '2026-06-02T00:00:00.000Z',
      updatedAt: '2026-06-02T00:00:00.000Z',
    });
    await index.upsert({
      id: 'rule:only1',
      type: MemoryType.RULE,
      permanence: Permanence.ALWAYS,
      name: 'only1',
      content: '只有诚实',
      tags: [],
      weight: 0.5,
      createdAt: '2026-06-02T00:00:00.000Z',
      updatedAt: '2026-06-02T00:00:00.000Z',
    });

    // near 模式：必须同时包含"诚实"和"记忆"
    const nearResults = await index.search('诚实 记忆', 10, 'near');
    expect(nearResults.length).toBe(1);
    expect(nearResults[0]?.id).toBe('rule:both');
  });
});
