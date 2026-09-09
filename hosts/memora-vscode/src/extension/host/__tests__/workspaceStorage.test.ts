/**
 * WorkspaceStorage 单元测试
 *
 * 覆盖关键行为：
 *   - search：分词 token 匹配（多关键词短语召回，而非整串子串）
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

  it('空查询按 accessedAt 降序返回全部活跃记忆', () => {
    storage.upsert(makeMemory({ id: 'old', content: '旧记忆', accessedAt: '2026-01-01T00:00:00.000Z' }));
    storage.upsert(makeMemory({ id: 'new', content: '新记忆', accessedAt: '2026-09-01T00:00:00.000Z' }));

    const hits = storage.search('', 10);
    expect(hits.map((m) => m.id)).toEqual(['new', 'old']);
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
    hits[0]!.accessedAt = '1970-01-01T00:00:00.000Z';
    // 内部存储的 accessedAt 不应被外部修改污染
    expect(storage.getById('m1')!.accessedAt).not.toBe('1970-01-01T00:00:00.000Z');
  });
});

