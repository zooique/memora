/**
 * 单元测试：SQLite 记忆索引
 * 验证索引的 CRUD 与查询逻辑
 * 适配 better-sqlite3 同步 API
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

describe('MemoryIndex · touch/applyDecay（设计 2：而生其心 + 应无所住）', () => {
  let tmpDir: string;
  let index: MemoryIndex;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memora-decay-'));
    index = new MemoryIndex(join(tmpDir, 'decay.db'));
  });

  afterEach(async () => {
    await index.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── 1) touch()：把 weight 重置为 1.0 + updated_at 更新 ───
  it('touch()：被命中的记忆 weight 重置为 1.0，updated_at 更新为现在', async () => {
    const oldTime = '2026-01-01T00:00:00.000Z';
    await index.upsert({
      id: 'topic:old',
      type: MemoryType.TOPIC,
      permanence: Permanence.TOPIC,
      name: 'old',
      content: '旧话题',
      tags: [],
      weight: 0.1,
      createdAt: oldTime,
      updatedAt: oldTime,
    });

    const before = await index.getById('topic:old');
    expect(before?.weight).toBe(0.1);

    // 触摸
    await index.touch(['topic:old']);

    const after = await index.getById('topic:old');
    expect(after?.weight).toBe(1.0);
    expect(after?.updatedAt).not.toBe(oldTime);
  });

  // ─── 2) touch()：空 ID 列表静默跳过 ───────────────────
  it('touch()：空 ID 列表静默跳过，不抛错', () => {
    // better-sqlite3 同步 API，直接调用不抛错
    expect(() => index.touch([])).not.toThrow();
  });

  // ─── 3) touch()：批量更新多条 ─────────────────────────
  it('touch()：一次更新多条记忆', async () => {
    for (let i = 0; i < 3; i++) {
      await index.upsert({
        id: `m:${i}`,
        type: MemoryType.TOPIC,
        permanence: Permanence.TOPIC,
        name: `m${i}`,
        content: `内容 ${i}`,
        tags: [],
        weight: 0.2,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
    }

    await index.touch(['m:0', 'm:1', 'm:2']);

    for (let i = 0; i < 3; i++) {
      const m = await index.getById(`m:${i}`);
      expect(m?.weight).toBe(1.0);
    }
  });

  // ─── 4) applyDecay()：always 永久性永不衰减 ──────────
  it('applyDecay()：always 永久性的记忆永不衰减（Infinity 早退）', async () => {
    await index.upsert({
      id: 'rule:always',
      type: MemoryType.RULE,
      permanence: Permanence.ALWAYS,
      name: '永远',
      content: '核心规则',
      tags: [],
      weight: 0.7,
      createdAt: '2020-01-01T00:00:00.000Z', // 6 年前
      updatedAt: '2020-01-01T00:00:00.000Z',
    });

    const result = await index.applyDecay({
      always: Infinity, // 永不衰减
      domain: 90,
      topic: 7,
      'on-demand': 3,
    });

    // always 等级不衰减
    expect(result.always).toBe(0);
    const after = await index.getById('rule:always');
    expect(after?.weight).toBe(0.7);
  });

  // ─── 5) applyDecay()：老记忆按半衰期衰减，但不低于 0.05 ──
  it('applyDecay()：老记忆 weight 衰减，但不降至 MIN_WEIGHT (0.05) 以下', async () => {
    const longAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(); // 1 年前
    await index.upsert({
      id: 'skill:ancient',
      type: MemoryType.SKILL,
      permanence: Permanence.ON_DEMAND,
      name: 'ancient',
      content: '远古技能',
      tags: [],
      weight: 0.8,
      createdAt: longAgo,
      updatedAt: longAgo,
    });

    await index.applyDecay({
      always: Infinity,
      domain: 90,
      topic: 7,
      'on-demand': 3, // 3 天半衰期
    });

    const after = await index.getById('skill:ancient');
    // 1 年 ≈ 121 个半衰期 → weight 趋近 0.05（但不会等于）
    expect(after?.weight).toBeGreaterThanOrEqual(0.05);
    expect(after?.weight).toBeLessThan(0.8);
  });

  // ─── 6) search() 命中后 fire-and-forget touch ─────────
  it('search() 命中后：被命中的记忆 weight 自动重置为 1.0', async () => {
    const oldTime = '2020-01-01T00:00:00.000Z';
    await index.upsert({
      id: 'rule:hit',
      type: MemoryType.RULE,
      permanence: Permanence.ALWAYS,
      name: 'hit',
      content: '万物流转',
      tags: [],
      weight: 0.1,
      createdAt: oldTime,
      updatedAt: oldTime,
    });

    // 触发搜索（异步 touch）
    await index.search('流转', 5, 'match');

    // 等待异步 touch 完成
    await new Promise((resolve) => setTimeout(resolve, 50));

    const after = await index.getById('rule:hit');
    expect(after?.weight).toBe(1.0);
  });
});
