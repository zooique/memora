/**
 * WorkspaceStorage 单元测试
 *
 * 覆盖关键行为：
 *   - search：分词 token 匹配（多关键词短语召回，而非整串子串）
 *   - decayScores：指数衰减（30 天半衰期）、只降分不重置 accessedAt、只影响指定 source
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Memory } from '@zooique/memora';
import { WorkspaceStorage } from '../workspaceStorage.js';

/** 构造一条最小 Memory（测试数据） */
function makeMemory(overrides: Partial<Memory> & { id: string; content: string }): Memory {
  const now = new Date().toISOString();
  return {
    source: 'test',
    name: `记忆-${overrides.id}`,
    createdAt: now,
    accessedAt: now,
    score: 0.5,
    ...overrides,
  };
}

describe('WorkspaceStorage.search', () => {
  /** 临时工作区路径（每用例独立，避免落盘文件互相污染） */
  let dir: string;
  /** 被测试的存储实例 */
  let storage: WorkspaceStorage;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memora-ws-test-'));
    storage = new WorkspaceStorage(dir);
    storage.load();
  });

  it('多关键词短语应通过分词 token 匹配命中（修复整串子串缺陷）', () => {
    storage.upsert(
      makeMemory({
        id: 'm1',
        content: '用户决定插件记忆功能采用 JSON 文件存储（memories.json），不引入 SQLite。',
        score: 0.5,
      }),
    );

    // 旧实现用 includes 整串匹配，query 含空格无法命中；分词后任一 token 命中即返回
    const hits = storage.search('记忆存储方案 决策', 10);
    expect(hits.map((m) => m.id)).toContain('m1');
  });

  it('单关键词命中 content 即可返回', () => {
    storage.upsert(makeMemory({ id: 'm1', content: '采用 JSON 文件存储，保持零依赖。' }));

    const hits = storage.search('JSON', 10);
    expect(hits.map((m) => m.id)).toContain('m1');
  });

  it('关键词命中 name 也应返回', () => {
    storage.upsert(
      makeMemory({ id: 'm1', content: '无关内容', name: '存储方案决策记录' }),
    );

    const hits = storage.search('存储方案', 10);
    expect(hits.map((m) => m.id)).toContain('m1');
  });

  it('软删除的记忆不被命中', () => {
    storage.upsert(makeMemory({ id: 'm1', content: '采用 JSON 文件存储。' }));
    storage.delete('m1');

    const hits = storage.search('JSON', 10);
    expect(hits).toHaveLength(0);
  });

  it('空查询按 score 降序返回全部活跃记忆', () => {
    storage.upsert(makeMemory({ id: 'low', content: '低分记忆', score: 0.2 }));
    storage.upsert(makeMemory({ id: 'high', content: '高分记忆', score: 0.9 }));

    const hits = storage.search('', 10);
    expect(hits.map((m) => m.id)).toEqual(['high', 'low']);
  });

  it('limit 截断返回数量', () => {
    for (let i = 0; i < 5; i++) {
      storage.upsert(makeMemory({ id: `m${i}`, content: `记忆内容 ${i}` }));
    }

    const hits = storage.search('记忆', 3);
    expect(hits).toHaveLength(3);
  });

  it('返回结果为浅拷贝，修改不影响内部存储', () => {
    storage.upsert(makeMemory({ id: 'm1', content: '采用 JSON 文件存储。' }));

    const hits = storage.search('JSON', 10);
    hits[0]!.score = 0;
    // 内部存储的 score 不应被外部修改污染
    expect(storage.getById('m1')!.score).toBe(0.5);
  });
});

// ─── decayScores 衰减测试 ────────────────────────────────────

/** 一天的毫秒数 */
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

describe('WorkspaceStorage.decayScores', () => {
  /** 临时工作区路径（每用例独立，避免落盘文件互相污染） */
  let dir: string;
  /** 被测试的存储实例 */
  let storage: WorkspaceStorage;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memora-decay-test-'));
    storage = new WorkspaceStorage(dir);
    storage.load();
  });

  it('应使用指数衰减（30 天半衰期），30 天后 score 降为一半', () => {
    // 创建一条 30 天前访问的记忆
    const thirtyDaysAgo = new Date(Date.now() - 30 * ONE_DAY_MS).toISOString();
    storage.upsert(
      makeMemory({
        id: 'm1',
        content: '测试指数衰减',
        source: 'content',
        score: 0.8,
        accessedAt: thirtyDaysAgo,
      }),
    );

    const now = new Date();
    const decayedCount = storage.decayScores(['content'], now);

    // 30 天半衰期：score 应降为 0.8 * 0.5 = 0.4
    expect(decayedCount).toBe(1);
    expect(storage.getById('m1')!.score).toBeCloseTo(0.4, 5);
  });

  it('60 天后 score 应降为 1/4（两个半衰期）', () => {
    const sixtyDaysAgo = new Date(Date.now() - 60 * ONE_DAY_MS).toISOString();
    storage.upsert(
      makeMemory({
        id: 'm1',
        content: '测试 60 天衰减',
        source: 'content',
        score: 0.8,
        accessedAt: sixtyDaysAgo,
      }),
    );

    const now = new Date();
    storage.decayScores(['content'], now);

    // 60 天 = 2 个半衰期：score 应降为 0.8 * 0.25 = 0.2
    expect(storage.getById('m1')!.score).toBeCloseTo(0.2, 5);
  });

  it('衰减不应重置 accessedAt（自然遗忘的关键语义）', () => {
    const oldAccessedAt = new Date(Date.now() - 30 * ONE_DAY_MS).toISOString();
    storage.upsert(
      makeMemory({
        id: 'm1',
        content: '测试不重置 accessedAt',
        source: 'content',
        score: 0.8,
        accessedAt: oldAccessedAt,
      }),
    );

    const now = new Date();
    storage.decayScores(['content'], now);

    // accessedAt 应保持不变（衰减只降分，不改变访问时间）
    expect(storage.getById('m1')!.accessedAt).toBe(oldAccessedAt);
  });

  it('衰减应只影响指定 source 的记忆', () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * ONE_DAY_MS).toISOString();
    // 创建不同 source 的记忆
    storage.upsert(
      makeMemory({
        id: 'content1',
        content: 'content 类型记忆',
        source: 'content',
        score: 0.8,
        accessedAt: thirtyDaysAgo,
      }),
    );
    storage.upsert(
      makeMemory({
        id: 'rule1',
        content: 'rule 类型记忆',
        source: 'rule',
        score: 0.8,
        accessedAt: thirtyDaysAgo,
      }),
    );

    const now = new Date();
    // 只衰减 content 类型
    storage.decayScores(['content'], now);

    // content 类型应被衰减
    expect(storage.getById('content1')!.score).toBeCloseTo(0.4, 5);
    // rule 类型不应被衰减
    expect(storage.getById('rule1')!.score).toBe(0.8);
  });

  it('软删除记忆不应被衰减', () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * ONE_DAY_MS).toISOString();
    storage.upsert(
      makeMemory({
        id: 'm1',
        content: '软删除记忆',
        source: 'content',
        score: 0.8,
        accessedAt: thirtyDaysAgo,
      }),
    );
    storage.delete('m1'); // 软删除

    const now = new Date();
    const decayedCount = storage.decayScores(['content'], now);

    // 软删除记忆不应被衰减
    expect(decayedCount).toBe(0);
  });

  it('刚访问过的记忆不应被衰减（daysSinceAccess <= 0）', () => {
    const nowIso = new Date().toISOString();
    storage.upsert(
      makeMemory({
        id: 'm1',
        content: '刚访问的记忆',
        source: 'content',
        score: 0.8,
        accessedAt: nowIso,
      }),
    );

    const now = new Date();
    const decayedCount = storage.decayScores(['content'], now);

    // 刚访问过，不应衰减
    expect(decayedCount).toBe(0);
    expect(storage.getById('m1')!.score).toBe(0.8);
  });

  it('衰减应遵守 DECAY_FLOOR 下限（0.1）', () => {
    const ninetyDaysAgo = new Date(Date.now() - 90 * ONE_DAY_MS).toISOString();
    storage.upsert(
      makeMemory({
        id: 'm1',
        content: '测试衰减下限',
        source: 'content',
        score: 0.15,
        accessedAt: ninetyDaysAgo,
      }),
    );

    const now = new Date();
    storage.decayScores(['content'], now);

    // 90 天 = 3 个半衰期：0.15 * 0.125 = 0.01875，但下限是 0.1
    expect(storage.getById('m1')!.score).toBeGreaterThanOrEqual(0.1);
  });

  it('衰减零 source 列表时不应衰减任何记忆', () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * ONE_DAY_MS).toISOString();
    storage.upsert(
      makeMemory({
        id: 'm1',
        content: '测试空 source',
        source: 'content',
        score: 0.8,
        accessedAt: thirtyDaysAgo,
      }),
    );

    const now = new Date();
    const decayedCount = storage.decayScores([], now);

    expect(decayedCount).toBe(0);
    expect(storage.getById('m1')!.score).toBe(0.8);
  });
});