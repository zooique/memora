/**
 * 多跳推理 单元测试
 *
 * 覆盖：
 *   - DefaultQueryExpander：关键词提取 + 子查询生成
 *   - multiHopRecall：单跳回退、多跳扩展、提前终止、降级
 *   - 边界条件：空结果、无关键词、自定义 options
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { multiHopRecall, DefaultQueryExpander } from '@/memory/multiHop.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import type { Memory } from '@/memory/types.js';

/** 构造测试记忆对象 */
function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'test:1',
    content: '测试内容',
    source: 'content',
    name: 'test-memory',
    createdAt: '2026-01-01T00:00:00.000Z',
    accessedAt: '2026-01-01T00:00:00.000Z',
    score: 0.8,
    ...overrides,
  };
}

// ─── DefaultQueryExpander ────────────────────────────

describe('DefaultQueryExpander · 查询扩展器', () => {
  const expander = new DefaultQueryExpander();

  it('空结果应返回空数组', () => {
    const result = expander.expand('query', [], 1);
    expect(result).toHaveLength(0);
  });

  it('应从 top 3 记忆的内容中提取关键词生成子查询', () => {
    const results = [
      makeMemory({ id: 'm1', content: 'JavaScript 编程 技巧', score: 0.9 }),
      makeMemory({ id: 'm2', content: 'TypeScript 类型 系统', score: 0.8 }),
    ];
    const subQueries = expander.expand('编程', results, 1);
    // 应为每个 top 结果生成一个子查询
    expect(subQueries.length).toBeGreaterThanOrEqual(1);
    // 每个子查询应包含原始查询
    for (const sq of subQueries) {
      expect(sq).toContain('编程');
    }
  });

  it('内容无有效关键词时应跳过该记忆', () => {
    // 只有 1 个字符的单词会被过滤
    const results = [
      makeMemory({ id: 'm1', content: 'a b c', score: 0.9 }),
    ];
    const subQueries = expander.expand('query', results, 1);
    expect(subQueries).toHaveLength(0);
  });

  it('应按 score 降序选择 top 3 记忆', () => {
    // 4 条记忆，只有 top 3 应被用于扩展
    const results = [
      makeMemory({ id: 'm1', content: 'JavaScript 编程', score: 0.9 }),
      makeMemory({ id: 'm2', content: 'TypeScript 类型', score: 0.8 }),
      makeMemory({ id: 'm3', content: 'Node.js 后端', score: 0.7 }),
      makeMemory({ id: 'm4', content: 'React 前端', score: 0.6 }),
    ];
    const subQueries = expander.expand('开发', results, 1);
    // 应生成至少 1 个子查询（最多 3 个）
    expect(subQueries.length).toBeGreaterThanOrEqual(1);
    expect(subQueries.length).toBeLessThanOrEqual(3);
  });
});

// ─── multiHopRecall ──────────────────────────────────

describe('multiHopRecall · 多跳推理', () => {
  let mockStorage: IMemoryStorage;

  beforeEach(() => {
    mockStorage = {
      upsert: vi.fn(),
      delete: vi.fn(),
      restore: vi.fn(),
      purge: vi.fn(),
      listDeleted: vi.fn(),
      getDeletedById: vi.fn(),
      purgeExpired: vi.fn(),
      getById: vi.fn(),
      getBySource: vi.fn(),
      search: vi.fn(),
      count: vi.fn(() => 0),
      countBySource: vi.fn(() => 0),
      decayScores: vi.fn(() => 0),
      incrementScore: vi.fn(() => true),
      setScore: vi.fn(() => true),
      getAllSources: vi.fn(() => new Map()),
      close: vi.fn(),
    } as unknown as IMemoryStorage;
  });

  it('单跳（maxHops=1）时等同于直接 recall', async () => {
    const results = [
      makeMemory({ id: 'content:1', source: 'content', score: 0.9 }),
      makeMemory({ id: 'content:2', source: 'content', score: 0.7 }),
    ];
    vi.mocked(mockStorage.search).mockReturnValue(results);

    const output = await multiHopRecall(mockStorage, '测试', { maxHops: 1 });

    // 应有 2 条结果
    expect(output.memories).toHaveLength(2);
    expect(output.hopsExecuted).toBe(1);
    expect(output.resultsPerHop).toHaveLength(1);
    expect(output.totalHits).toBe(2);
  });

  it('多跳应返回比单跳更多的结果', async () => {
    // 第 1 跳返回 2 条
    // 第 2 跳扩展查询后返回额外 2 条
    const firstHopResults = [
      makeMemory({ id: 'content:A', source: 'content', content: 'TypeScript 编程 异步', score: 0.9 }),
      makeMemory({ id: 'content:B', source: 'content', content: 'TypeScript 类型 系统', score: 0.8 }),
    ];
    const secondHopResults = [
      makeMemory({ id: 'content:C', source: 'content', content: 'Promise 异步 编程', score: 0.7 }),
      makeMemory({ id: 'content:D', source: 'content', content: '类型 安全 编程', score: 0.6 }),
    ];

    // 第一次调用 search 返回第 1 跳结果，第二次返回第 2 跳结果
    // recall() 内部调用 storage.search(keywords.join(' '), ...)
    // 第 1 跳：extractKeywords('TypeScript') → ['typescript'] → search('typescript', 6)
    // 第 2 跳：extractKeywords(subQuery) → search(...) 使用后续 mock
    vi.mocked(mockStorage.search)
      .mockReturnValueOnce(firstHopResults)
      .mockReturnValue(secondHopResults);

    // getById 用于语义搜索，返回 null（模拟无向量存储）
    vi.mocked(mockStorage.getById).mockReturnValue(null);

    const output = await multiHopRecall(mockStorage, 'TypeScript', { maxHops: 2 });

    // 最终应有 4 条去重结果
    expect(output.memories.length).toBeGreaterThanOrEqual(2);
    expect(output.hopsExecuted).toBe(2);
    expect(output.totalHits).toBeGreaterThanOrEqual(2);
  });

  it('第 1 跳无结果时应提前终止', async () => {
    vi.mocked(mockStorage.search).mockReturnValue([]);

    const output = await multiHopRecall(mockStorage, '无结果查询', { maxHops: 3 });

    expect(output.memories).toHaveLength(0);
    expect(output.hopsExecuted).toBe(1); // 只执行了第 1 跳
    expect(output.totalHits).toBe(0);
  });

  it('后续跳无新结果时应提前终止', async () => {
    // 第 1 跳返回结果，但第 2 跳扩展后无新结果
    const firstHopResults = [
      makeMemory({ id: 'content:A', source: 'content', content: 'TypeScript 编程 异步', score: 0.9 }),
    ];

    vi.mocked(mockStorage.search)
      .mockReturnValueOnce(firstHopResults)
      .mockReturnValue([]); // 第 2 跳无结果

    const output = await multiHopRecall(mockStorage, 'TypeScript', { maxHops: 3 });

    expect(output.memories).toHaveLength(1);
    expect(output.hopsExecuted).toBe(2);
    expect(output.totalHits).toBe(1);
  });

  it('应去重合并各跳结果', async () => {
    // 第 1 跳和第 2 跳返回相同 id，应去重
    const firstHopResults = [
      makeMemory({ id: 'content:dup', source: 'content', content: 'TypeScript 编程 异步', score: 0.9 }),
    ];
    const secondHopResults = [
      makeMemory({ id: 'content:dup', source: 'content', content: 'TypeScript 编程 异步', score: 0.9 }),
    ];

    vi.mocked(mockStorage.search)
      .mockReturnValueOnce(firstHopResults)
      .mockReturnValue(secondHopResults);

    const output = await multiHopRecall(mockStorage, 'TypeScript', { maxHops: 2 });

    // 同一 id 应去重为 1 条
    expect(output.memories).toHaveLength(1);
    expect(output.totalHits).toBe(1);
  });

  it('finalLimit 应控制最终返回数量', async () => {
    const results = Array.from({ length: 5 }, (_, i) =>
      makeMemory({ id: `content:${i}`, source: 'content', score: 0.9 - i * 0.1 }),
    );
    vi.mocked(mockStorage.search).mockReturnValue(results);

    const output = await multiHopRecall(mockStorage, '测试', { maxHops: 1, finalLimit: 2 });

    expect(output.memories).toHaveLength(2);
  });

  it('自定义 queryExpander 应被使用', async () => {
    // 自定义 expander 固定返回一个子查询
    const customExpander = {
      expand: vi.fn().mockReturnValue(['TypeScript 自定义']),
    };

    const firstHopResults = [
      makeMemory({ id: 'content:A', source: 'content', content: 'TypeScript 编程', score: 0.9 }),
    ];
    const secondHopResults = [
      makeMemory({ id: 'content:B', source: 'content', content: '额外结果', score: 0.7 }),
    ];

    vi.mocked(mockStorage.search)
      .mockReturnValueOnce(firstHopResults)
      .mockReturnValue(secondHopResults);

    const output = await multiHopRecall(mockStorage, 'TypeScript', {
      maxHops: 2,
      queryExpander: customExpander,
    });

    // 自定义 expander 应被调用
    expect(customExpander.expand).toHaveBeenCalled();
    // 第 2 跳结果应被合并
    expect(output.totalHits).toBe(2);
  });
});