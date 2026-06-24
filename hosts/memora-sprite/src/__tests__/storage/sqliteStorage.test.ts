/**
 * SqliteStorage 测试
 *
 * 使用 node:sqlite（Node 22+ 内置）作为 better-sqlite3 的测试替身，
 * 避免 Electron 项目中 better-sqlite3 ABI 与 Node.js 测试环境不匹配的问题。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDatabase } from './helpers/nodeSqliteDatabase.js';
import { SqliteStorage } from '../../storage/sqliteStorage.js';
import type { Memory } from 'memora';

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    content: '测试记忆内容',
    source: 'insight',
    name: 'test-memory',
    createdAt: new Date().toISOString(),
    accessedAt: new Date().toISOString(),
    score: 0.8,
    ...overrides,
  };
}

describe('SqliteStorage', () => {
  let storage: SqliteStorage;

  beforeEach(() => {
    const db = createMemoryDatabase();
    storage = new SqliteStorage(db);
  });

  afterEach(() => {
    storage.close();
  });

  it('should upsert and get a memory', () => {
    const mem = makeMemory({ id: 'mem-1', content: 'Hello', source: 'insight' });
    storage.upsert(mem);

    const got = storage.getById('mem-1');
    expect(got).not.toBeNull();
    expect(got!.id).toBe('mem-1');
    expect(got!.content).toBe('Hello');
    expect(got!.source).toBe('insight');
  });

  it('should update existing memory on upsert', () => {
    const mem = makeMemory({ id: 'mem-2', content: 'v1', score: 0.5 });
    storage.upsert(mem);

    storage.upsert({ ...mem, content: 'v2', score: 0.9 });
    const got = storage.getById('mem-2');
    expect(got!.content).toBe('v2');
    expect(got!.score).toBe(0.9);
  });

  it('should delete a memory', () => {
    const mem = makeMemory({ id: 'mem-3' });
    storage.upsert(mem);

    storage.delete('mem-3');
    expect(storage.getById('mem-3')).toBeNull();
  });

  it('should get memories by source', () => {
    storage.upsert(makeMemory({ id: 'a', source: 'insight', score: 0.5 }));
    storage.upsert(makeMemory({ id: 'b', source: 'insight', score: 0.9 }));
    storage.upsert(makeMemory({ id: 'c', source: 'profile' }));

    const insights = storage.getBySource('insight');
    expect(insights).toHaveLength(2);
    // 按 score 降序
    expect(insights[0]!.id).toBe('b');
    expect(insights[1]!.id).toBe('a');
  });

  it('should search by keywords', () => {
    storage.upsert(makeMemory({ id: 's1', content: 'TypeScript 类型系统', name: 'ts-note' }));
    storage.upsert(makeMemory({ id: 's2', content: 'Python 数据分析', name: 'py-note' }));
    storage.upsert(makeMemory({ id: 's3', content: 'React 组件设计', name: 'react-note' }));

    const results = storage.search('TypeScript');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some(r => r.id === 's1')).toBe(true);
  });

  it('should return all memories sorted by score for empty query', () => {
    storage.upsert(makeMemory({ id: 'e1', score: 0.3 }));
    storage.upsert(makeMemory({ id: 'e2', score: 0.9 }));

    const results = storage.search('');
    expect(results).toHaveLength(2);
    expect(results[0]!.score).toBeGreaterThanOrEqual(results[1]!.score);
  });

  it('should count memories', () => {
    storage.upsert(makeMemory({ id: 'c1' }));
    storage.upsert(makeMemory({ id: 'c2' }));

    expect(storage.count()).toBe(2);
  });

  it('should count by source', () => {
    storage.upsert(makeMemory({ id: 'cs1', source: 'insight' }));
    storage.upsert(makeMemory({ id: 'cs2', source: 'insight' }));
    storage.upsert(makeMemory({ id: 'cs3', source: 'profile' }));

    expect(storage.countBySource('insight')).toBe(2);
    expect(storage.countBySource('profile')).toBe(1);
  });

  it('should decay scores for old memories', () => {
    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    storage.upsert(makeMemory({ id: 'd1', source: 'insight', accessedAt: oldDate, score: 0.8 }));
    storage.upsert(makeMemory({ id: 'd2', source: 'profile', accessedAt: oldDate, score: 0.7 }));
    storage.upsert(makeMemory({ id: 'd3', source: 'insight', accessedAt: new Date().toISOString(), score: 0.9 }));

    const decayed = storage.decayScores(['insight', 'profile'], new Date());
    expect(decayed).toBeGreaterThanOrEqual(2);

    const d1 = storage.getById('d1');
    expect(d1!.score).toBeLessThan(0.8);

    // d3 最近访问，不应被衰减
    const d3 = storage.getById('d3');
    expect(d3!.score).toBe(0.9);
  });
});
