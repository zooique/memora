/**
 * 记忆召回管线测试
 * 覆盖 bootstrap 基础召回 + recall 增量召回
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RecallPipeline } from '../recall.js';
import type { MemoryIndex } from '../index.js';
import type { Memory } from '../types.js';

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'test:1',
    type: 'skill',
    permanence: 'always',
    name: 'test-memory',
    content: '测试内容',
    tags: ['test'],
    weight: 0.8,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    filePath: '/test/memory.md',
    ...overrides,
  };
}

describe('RecallPipeline · bootstrap 基础召回', () => {
  let mockIndex: MemoryIndex;
  let pipeline: RecallPipeline;

  beforeEach(() => {
    mockIndex = {
      getByPermanence: vi.fn(),
      search: vi.fn(),
      getById: vi.fn(),
    } as unknown as MemoryIndex;
    pipeline = new RecallPipeline(mockIndex);
  });

  it('应该返回 always + domain 两类记忆', async () => {
    const alwaysMem = makeMemory({ id: 'a1', permanence: 'always', name: 'always-mem' });
    const domainMem = makeMemory({ id: 'd1', permanence: 'domain', name: 'domain-mem' });
    vi.mocked(mockIndex.getByPermanence).mockResolvedValueOnce([alwaysMem]);
    vi.mocked(mockIndex.getByPermanence).mockResolvedValueOnce([domainMem]);

    const result = await pipeline.bootstrap();

    expect(result).toHaveLength(2);
    expect(result[0]!.permanence).toBe('always');
    expect(result[1]!.permanence).toBe('domain');
    expect(mockIndex.getByPermanence).toHaveBeenCalledWith('always');
    expect(mockIndex.getByPermanence).toHaveBeenCalledWith('domain');
  });

  it('应该处理 always 记忆为空的情况', async () => {
    const domainMem = makeMemory({ id: 'd1', permanence: 'domain' });
    vi.mocked(mockIndex.getByPermanence).mockResolvedValueOnce([]);
    vi.mocked(mockIndex.getByPermanence).mockResolvedValueOnce([domainMem]);

    const result = await pipeline.bootstrap();

    expect(result).toHaveLength(1);
    expect(result[0]!.permanence).toBe('domain');
  });

  it('应该处理 domain 记忆为空的情况', async () => {
    const alwaysMem = makeMemory({ id: 'a1', permanence: 'always' });
    vi.mocked(mockIndex.getByPermanence).mockResolvedValueOnce([alwaysMem]);
    vi.mocked(mockIndex.getByPermanence).mockResolvedValueOnce([]);

    const result = await pipeline.bootstrap();

    expect(result).toHaveLength(1);
    expect(result[0]!.permanence).toBe('always');
  });
});

describe('RecallPipeline · recall 增量召回', () => {
  let mockIndex: MemoryIndex;
  let pipeline: RecallPipeline;

  beforeEach(() => {
    mockIndex = {
      getByPermanence: vi.fn(),
      search: vi.fn(),
      getById: vi.fn(),
    } as unknown as MemoryIndex;
    pipeline = new RecallPipeline(mockIndex);
  });

  it('应该基于查询文本搜索并返回 topK 条结果', async () => {
    const candidates = [makeMemory({ id: '1', weight: 0.9 }), makeMemory({ id: '2', weight: 0.5 })];
    vi.mocked(mockIndex.search).mockResolvedValue(candidates);

    const result = await pipeline.recall('测试查询', { topK: 2 });

    expect(result).toHaveLength(2);
    expect(mockIndex.search).toHaveBeenCalledWith('测试查询', 6); // topK * 3
  });

  it('应该过滤掉权重低于 minWeight 的结果', async () => {
    const candidates = [
      makeMemory({ id: '1', weight: 0.9 }),
      makeMemory({ id: '2', weight: 0.3 }),
      makeMemory({ id: '3', weight: 0.1 }),
    ];
    vi.mocked(mockIndex.search).mockResolvedValue(candidates);

    const result = await pipeline.recall('查询', { minWeight: 0.5 });

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('1');
  });

  it('应该按 types 过滤记忆类型', async () => {
    const candidates = [
      makeMemory({ id: '1', type: 'skill', weight: 0.9 }),
      makeMemory({ id: '2', type: 'tool', weight: 0.8 }),
      makeMemory({ id: '3', type: 'rule', weight: 0.7 }),
    ];
    vi.mocked(mockIndex.search).mockResolvedValue(candidates);

    const result = await pipeline.recall('查询', { types: ['skill', 'tool'] });

    expect(result).toHaveLength(2);
    expect(result.map((m) => m.type)).toEqual(['skill', 'tool']);
  });

  it('应该用默认值 topK=5 minWeight=0 当未传入选项时', async () => {
    const candidates = Array.from({ length: 10 }, (_, i) =>
      makeMemory({ id: String(i), weight: 0.5 }),
    );
    vi.mocked(mockIndex.search).mockResolvedValue(candidates);

    const result = await pipeline.recall('查询');

    expect(result).toHaveLength(5); // 默认 topK=5
    expect(mockIndex.search).toHaveBeenCalledWith('查询', 15); // 5 * 3
  });
});
