/**
 * 记忆召回测试
 * 覆盖关键词提取 + recall 函数 + boostScore 上限 + applyDecayToMemory 衰减边界
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { recall, extractKeywords, applyDecayToMemory, boostScores, ONE_DAY_MS } from '@/memory/recall.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import type { IVectorStore } from '@/memory/vectorStore.js';
import type { Memory } from '@/memory/types.js';

/**
 * 创建测试用 Memory 对象
 */
function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'test:1',
    content: '测试内容',
    source: 'insight',
    name: 'test-memory',
    createdAt: '2026-01-01T00:00:00.000Z',
    accessedAt: '2026-01-01T00:00:00.000Z',
    score: 0.8,
    ...overrides,
  };
}

describe('extractKeywords · 关键词提取', () => {
  it('应该提取中文关键词并过滤停用词', () => {
    const keywords = extractKeywords('我想学习编程的技巧');
    // 应该包含有意义的词，过滤掉停用词
    expect(keywords.length).toBeGreaterThan(0);
    expect(keywords).not.toContain('的');
    expect(keywords).not.toContain('我');
  });

  it('应该提取英文关键词', () => {
    const keywords = extractKeywords('Learn TypeScript programming');
    expect(keywords).toContain('learn');
    expect(keywords).toContain('typescript');
    expect(keywords).toContain('programming');
  });

  it('应该过滤长度小于 2 的词', () => {
    const keywords = extractKeywords('a bb ccc');
    expect(keywords).not.toContain('a');
    expect(keywords).toContain('bb');
    expect(keywords).toContain('ccc');
  });

  it('应该去重', () => {
    const keywords = extractKeywords('测试 测试 测试');
    const testCount = keywords.filter((k) => k === '测试').length;
    expect(testCount).toBe(1);
  });
});

describe('recall · 记忆召回', () => {
  let mockStorage: IMemoryStorage;

  beforeEach(() => {
    mockStorage = {
      upsert: vi.fn(),
      delete: vi.fn(),
      getById: vi.fn(),
      getBySource: vi.fn(),
      search: vi.fn(),
      count: vi.fn(() => 0),
      countBySource: vi.fn(() => 0),
      close: vi.fn(),
    } as unknown as IMemoryStorage;
  });

  it('应该基于查询搜索并返回结果', async () => {
    const results = [
      makeMemory({ id: 'insight:1', source: 'insight', score: 0.9 }),
      makeMemory({ id: 'profile:1', source: 'profile', score: 0.7 }),
    ];
    vi.mocked(mockStorage.search).mockReturnValue(results);

    const memories = await recall(mockStorage, '测试查询');

    expect(memories).toHaveLength(2);
    expect(mockStorage.search).toHaveBeenCalledWith('测试 查询', 10); // 提取关键词后组合搜索
  });

  it('应该排除默认的 persona、rule 和 skill source', async () => {
    const results = [
      makeMemory({ id: 'persona:1', source: 'persona', score: 0.9 }),
      makeMemory({ id: 'rule:1', source: 'rule', score: 0.8 }),
      makeMemory({ id: 'skill:1', source: 'skill', score: 0.7 }),
    ];
    vi.mocked(mockStorage.search).mockReturnValue(results);

    const memories = await recall(mockStorage, '测试');

    // persona、rule 和 skill 全部被排除
    expect(memories).toHaveLength(0);
  });

  it('应该支持自定义 excludeSources', async () => {
    const results = [
      makeMemory({ id: 'persona:1', source: 'persona', score: 0.9 }),
      makeMemory({ id: 'skill:1', source: 'skill', score: 0.8 }),
    ];
    vi.mocked(mockStorage.search).mockReturnValue(results);

    const memories = await recall(mockStorage, '测试', { excludeSources: [] });

    // 不排除任何 source
    expect(memories).toHaveLength(2);
  });

  it('应该限制返回数量', async () => {
    const results = Array.from({ length: 10 }, (_, i) =>
      makeMemory({ id: `insight:${i}`, source: 'insight', score: 0.5 + i * 0.05 }),
    );
    vi.mocked(mockStorage.search).mockReturnValue(results);

    const memories = await recall(mockStorage, '测试', { limit: 3 });

    expect(memories).toHaveLength(3);
  });

  it('应该按 score 降序排列', async () => {
    const results = [
      makeMemory({ id: 'insight:1', source: 'insight', score: 0.5 }),
      makeMemory({ id: 'insight:2', source: 'insight', score: 0.9 }),
      makeMemory({ id: 'insight:3', source: 'insight', score: 0.7 }),
    ];
    vi.mocked(mockStorage.search).mockReturnValue(results);

    const memories = await recall(mockStorage, '测试');

    expect(memories[0]!.score).toBeGreaterThanOrEqual(memories[1]!.score);
    expect(memories[1]!.score).toBeGreaterThanOrEqual(memories[2]!.score);
  });

  it('无关键词时应返回空数组', async () => {
    const memories = await recall(mockStorage, '！@#￥%');

    expect(memories).toEqual([]);
    // 无关键词时不应调用 search
    expect(mockStorage.search).not.toHaveBeenCalled();
  });

  it('FIX-P1-2：recall 只读不写，返回 boost 后的副本（不调用 upsert）', async () => {
    const original = makeMemory({ id: 'insight:1', source: 'insight', score: 0.5 });
    vi.mocked(mockStorage.search).mockReturnValue([original]);

    const memories = await recall(mockStorage, '测试');

    // FIX-P1-2：recall 只读，不再 upsert；boost 持久化由调用方 fire-and-forget 调用 boostScores
    expect(mockStorage.upsert).not.toHaveBeenCalled();
    // 返回的 memory 应是 boost 后的副本（score 提升）
    expect(memories[0]).not.toBe(original);
    expect(memories[0]!.id).toBe(original.id);
    expect(memories[0]!.score).toBeGreaterThanOrEqual(0.5);
    // 原始对象不应被修改（不污染调用方持有的对象）
    expect(original.score).toBe(0.5);
  });

  it('FIX-P1-2：boost 后 score 不应超过上限 1.0（在返回的副本上验证）', async () => {
    // 高分记忆（0.98）被召回后 boost +0.05 = 1.03，应被钳制到 1.0
    const highScore = makeMemory({ id: 'insight:high', source: 'insight', score: 0.98 });
    vi.mocked(mockStorage.search).mockReturnValue([highScore]);

    const memories = await recall(mockStorage, '测试');

    // 验证返回的副本 score 被钳制到 1.0（不再通过 upsert 验证）
    expect(memories[0]!.score).toBe(1.0);
    expect(mockStorage.upsert).not.toHaveBeenCalled();
  });
});

// ─── FIX-P1-2：boostScores 显式写操作 ──────────────────────

describe('FIX-P1-2: boostScores · 批量持久化 boost', () => {
  let mockStorage: IMemoryStorage;

  beforeEach(() => {
    mockStorage = {
      upsert: vi.fn(),
      delete: vi.fn(),
      getById: vi.fn(),
      getBySource: vi.fn(),
      search: vi.fn(),
      count: vi.fn(() => 0),
      countBySource: vi.fn(() => 0),
      // MIND2-L3：boostScores 改用 incrementScore 原子操作（替代 read-modify-write）
      incrementScore: vi.fn(() => true),
      setScore: vi.fn(() => true),
      decayScores: vi.fn(() => 0),
      getAllSources: vi.fn(() => new Map()),
      close: vi.fn(),
    } as unknown as IMemoryStorage;
  });

  it('应对每个 id 调用 incrementScore 原子增量', async () => {
    await boostScores(mockStorage, ['insight:1', 'insight:2']);

    // 应调用 2 次 incrementScore，传入 BOOST_INCREMENT 增量
    expect(mockStorage.incrementScore).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(mockStorage.incrementScore).mock.calls;
    expect(calls[0]![0]).toBe('insight:1');
    expect(calls[1]![0]).toBe('insight:2');
    // delta 是 BOOST_INCREMENT（0.05），now 是 ISO 字符串
    expect(calls[0]![1]).toBe(0.05);
    expect(typeof calls[0]![2]).toBe('string');
  });

  it('incrementScore 返回 false（记忆不存在/已删除）不报错', async () => {
    vi.mocked(mockStorage.incrementScore).mockReturnValue(false);

    // boostScores 不检查返回值，fire-and-forget 由 storage 层静默处理
    await expect(boostScores(mockStorage, ['insight:deleted'])).resolves.toBeUndefined();
  });

  it('空 ids 数组应直接返回，不调用 incrementScore', async () => {
    await boostScores(mockStorage, []);

    expect(mockStorage.incrementScore).not.toHaveBeenCalled();
  });
});

// ─── 语义搜索通道（双通道召回） ──────────────────────

describe('recall · 语义搜索通道（双通道召回）', () => {
  let mockStorage: IMemoryStorage;
  /** Mock VectorStore（size + search） */
  let mockVectorStore: { size: number; search: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockStorage = {
      upsert: vi.fn(),
      delete: vi.fn(),
      getById: vi.fn(),
      getBySource: vi.fn(),
      search: vi.fn(),
      count: vi.fn(() => 0),
      countBySource: vi.fn(() => 0),
      close: vi.fn(),
    } as unknown as IMemoryStorage;

    mockVectorStore = {
      size: 10,
      search: vi.fn(),
    };
  });

  it('vectorStore 有结果时应走语义搜索通道', async () => {
    // 语义搜索返回 1 条结果，关键词搜索返回 0 条
    vi.mocked(mockVectorStore.search).mockResolvedValue([
      { id: 'insight:semantic-1', similarity: 0.9 },
    ]);
    vi.mocked(mockStorage.getById).mockReturnValue(
      makeMemory({ id: 'insight:semantic-1', source: 'insight', score: 0.8 }),
    );
    vi.mocked(mockStorage.search).mockReturnValue([]);

    const memories = await recall(mockStorage, '测试查询', { vectorStore: mockVectorStore as unknown as IVectorStore });

    expect(memories).toHaveLength(1);
    expect(memories[0]!.id).toBe('insight:semantic-1');
    // 语义搜索应被调用，topK = limit * RECALL_LIMIT_MULTIPLIER = 5 * 2 = 10
    expect(mockVectorStore.search).toHaveBeenCalledWith('测试查询', 10, 0.3);
  });

  it('vectorStore.size=0 时跳过语义搜索', async () => {
    // size=0 时不应调用 vectorStore.search
    mockVectorStore.size = 0;
    vi.mocked(mockStorage.search).mockReturnValue([
      makeMemory({ id: 'insight:1', source: 'insight', score: 0.5 }),
    ]);

    const memories = await recall(mockStorage, '测试', { vectorStore: mockVectorStore as unknown as IVectorStore });

    expect(mockVectorStore.search).not.toHaveBeenCalled();
    expect(memories).toHaveLength(1);
  });

  it('excludeSources 对语义搜索结果也生效', async () => {
    // 语义搜索返回 persona source，应被排除
    vi.mocked(mockVectorStore.search).mockResolvedValue([
      { id: 'persona:1', similarity: 0.9 },
    ]);
    vi.mocked(mockStorage.getById).mockReturnValue(
      makeMemory({ id: 'persona:1', source: 'persona', score: 0.9 }),
    );

    const memories = await recall(mockStorage, '测试', { vectorStore: mockVectorStore as unknown as IVectorStore });

    // persona 被默认排除，应返回空
    expect(memories).toHaveLength(0);
  });

  it('双通道融合去重（同一 id 不重复返回）', async () => {
    // 语义搜索 + 关键词搜索都返回同一 id，应去重为 1 条
    vi.mocked(mockVectorStore.search).mockResolvedValue([
      { id: 'insight:dup', similarity: 0.9 },
    ]);
    vi.mocked(mockStorage.getById).mockReturnValue(
      makeMemory({ id: 'insight:dup', source: 'insight', score: 0.8 }),
    );
    vi.mocked(mockStorage.search).mockReturnValue([
      makeMemory({ id: 'insight:dup', source: 'insight', score: 0.8 }),
    ]);

    const memories = await recall(mockStorage, '测试', { vectorStore: mockVectorStore as unknown as IVectorStore });

    // 同一 id 应去重，仅返回 1 条
    expect(memories).toHaveLength(1);
    expect(memories[0]!.id).toBe('insight:dup');
  });
});

// ─── 双通道融合排序 ─────────────────────────────────

describe('recall · 双通道融合排序', () => {
  let mockStorage: IMemoryStorage;

  beforeEach(() => {
    mockStorage = {
      upsert: vi.fn(),
      delete: vi.fn(),
      getById: vi.fn(),
      getBySource: vi.fn(),
      search: vi.fn(),
      count: vi.fn(() => 0),
      countBySource: vi.fn(() => 0),
      close: vi.fn(),
    } as unknown as IMemoryStorage;
  });

  it('高 similarity + 中等 score 应排在低 similarity + 高 score 前面', async () => {
    // 综合分公式：vectorScore * 0.6 + memory.score * 0.4
    // memory A：similarity=0.9, score=0.5 → 0.54 + 0.20 = 0.74
    // memory B：similarity=0（关键词命中），score=0.9 → 0 + 0.36 = 0.36
    // 期望 A 排在 B 前面
    const mockVectorStore = {
      size: 10,
      search: vi.fn().mockResolvedValue([{ id: 'insight:A', similarity: 0.9 }]),
    };
    vi.mocked(mockStorage.getById).mockReturnValue(
      makeMemory({ id: 'insight:A', source: 'insight', score: 0.5 }),
    );
    vi.mocked(mockStorage.search).mockReturnValue([
      makeMemory({ id: 'insight:B', source: 'insight', score: 0.9 }),
    ]);

    const memories = await recall(mockStorage, '测试', { vectorStore: mockVectorStore as unknown as IVectorStore });

    expect(memories).toHaveLength(2);
    // A 的综合分(0.74) > B 的综合分(0.36)，A 应排在前面
    expect(memories[0]!.id).toBe('insight:A');
    expect(memories[1]!.id).toBe('insight:B');
  });

  it('高 score 记忆可在融合排序中超越低 similarity 记忆', async () => {
    // memory A：similarity=0.4, score=0.3 → 0.24 + 0.12 = 0.36
    // memory B：similarity=0（关键词命中），score=0.95 → 0 + 0.38 = 0.38
    // 期望 B 排在 A 前面（高 score 弥补了无 similarity）
    const mockVectorStore = {
      size: 10,
      search: vi.fn().mockResolvedValue([{ id: 'insight:A', similarity: 0.4 }]),
    };
    vi.mocked(mockStorage.getById).mockReturnValue(
      makeMemory({ id: 'insight:A', source: 'insight', score: 0.3 }),
    );
    vi.mocked(mockStorage.search).mockReturnValue([
      makeMemory({ id: 'insight:B', source: 'insight', score: 0.95 }),
    ]);

    const memories = await recall(mockStorage, '测试', { vectorStore: mockVectorStore as unknown as IVectorStore });

    expect(memories).toHaveLength(2);
    // B 的综合分(0.38) > A 的综合分(0.36)，B 应排在前面
    expect(memories[0]!.id).toBe('insight:B');
    expect(memories[1]!.id).toBe('insight:A');
  });

  it('limit 应在融合排序后截断', async () => {
    // 语义搜索返回 3 条，关键词搜索返回 3 条，limit=2 应截断到 2 条
    const mockVectorStore = {
      size: 10,
      search: vi.fn().mockResolvedValue([
        { id: 'insight:v1', similarity: 0.9 },
        { id: 'insight:v2', similarity: 0.8 },
        { id: 'insight:v3', similarity: 0.7 },
      ]),
    };
    vi.mocked(mockStorage.getById).mockImplementation((id: string) =>
      makeMemory({ id, source: 'insight', score: 0.5 }),
    );
    vi.mocked(mockStorage.search).mockReturnValue([
      makeMemory({ id: 'insight:k1', source: 'insight', score: 0.4 }),
      makeMemory({ id: 'insight:k2', source: 'insight', score: 0.3 }),
      makeMemory({ id: 'insight:k3', source: 'insight', score: 0.2 }),
    ]);

    const memories = await recall(mockStorage, '测试', {
      vectorStore: mockVectorStore as unknown as IVectorStore,
      limit: 2,
    });

    expect(memories).toHaveLength(2);
  });
});

// ─── 降级策略 ───────────────────────────────────────

describe('recall · 降级策略', () => {
  let mockStorage: IMemoryStorage;

  beforeEach(() => {
    mockStorage = {
      upsert: vi.fn(),
      delete: vi.fn(),
      getById: vi.fn(),
      getBySource: vi.fn(),
      search: vi.fn(),
      count: vi.fn(() => 0),
      countBySource: vi.fn(() => 0),
      close: vi.fn(),
    } as unknown as IMemoryStorage;
  });

  it('语义搜索抛错时应降级到关键词搜索', async () => {
    // vectorStore.search 抛错，应降级到关键词搜索并返回结果
    const mockVectorStore = {
      size: 10,
      search: vi.fn().mockRejectedValue(new Error('向量索引损坏')),
    };
    vi.mocked(mockStorage.search).mockReturnValue([
      makeMemory({ id: 'insight:fallback', source: 'insight', score: 0.7 }),
    ]);

    const memories = await recall(mockStorage, '测试', { vectorStore: mockVectorStore as unknown as IVectorStore });

    // 语义搜索失败，降级到关键词搜索，仍应返回结果
    expect(memories).toHaveLength(1);
    expect(memories[0]!.id).toBe('insight:fallback');
    // 关键词搜索应被调用
    expect(mockStorage.search).toHaveBeenCalled();
  });

  it('关键词搜索抛错时应仅返回语义搜索结果', async () => {
    // storage.search 抛错，应仅返回语义搜索结果
    const mockVectorStore = {
      size: 10,
      search: vi.fn().mockResolvedValue([{ id: 'insight:semantic', similarity: 0.9 }]),
    };
    vi.mocked(mockStorage.getById).mockReturnValue(
      makeMemory({ id: 'insight:semantic', source: 'insight', score: 0.8 }),
    );
    vi.mocked(mockStorage.search).mockImplementation(() => {
      throw new Error('SQLite 锁定');
    });

    const memories = await recall(mockStorage, '测试', { vectorStore: mockVectorStore as unknown as IVectorStore });

    // 关键词搜索失败，仅返回语义搜索结果
    expect(memories).toHaveLength(1);
    expect(memories[0]!.id).toBe('insight:semantic');
  });

  it('双通道都失败时应返回空数组', async () => {
    // 语义搜索抛错 + 关键词搜索抛错，应返回空数组而非抛出
    const mockVectorStore = {
      size: 10,
      search: vi.fn().mockRejectedValue(new Error('向量索引损坏')),
    };
    vi.mocked(mockStorage.search).mockImplementation(() => {
      throw new Error('SQLite 锁定');
    });

    const memories = await recall(mockStorage, '测试', { vectorStore: mockVectorStore as unknown as IVectorStore });

    expect(memories).toEqual([]);
  });

  it('minSimilarity 选项应透传到 vectorStore.search', async () => {
    // 验证自定义 minSimilarity 透传
    const mockVectorStore = {
      size: 10,
      search: vi.fn().mockResolvedValue([]),
    };

    await recall(mockStorage, '测试', {
      vectorStore: mockVectorStore as unknown as IVectorStore,
      minSimilarity: 0.5,
    });

    // minSimilarity=0.5 应透传到 vectorStore.search 第三参数
    expect(mockVectorStore.search).toHaveBeenCalledWith('测试', 10, 0.5);
  });
});

// ─── applyDecayToMemory 衰减边界 ──────────────────────

describe('applyDecayToMemory · 衰减计算边界', () => {
  it('无效日期（NaN）应跳过并返回 false', () => {
    const memory = makeMemory({ accessedAt: 'invalid-date' });
    const result = applyDecayToMemory(memory, new Date());
    expect(result).toBe(false);
    // score 不应被修改
    expect(memory.score).toBe(0.8);
  });

  it('恰好在 DECAY_AGE_DAYS（7 天）边界时不应衰减（<= 包含边界）', () => {
    const now = new Date('2026-07-15T00:00:00.000Z');
    // accessedAt 设为恰好 7 天前
    const sevenDaysAgo = new Date(now.getTime() - 7 * ONE_DAY_MS);
    const memory = makeMemory({ score: 0.8, accessedAt: sevenDaysAgo.toISOString() });

    const result = applyDecayToMemory(memory, now);
    expect(result).toBe(false);
    expect(memory.score).toBe(0.8);
  });

  it('非整数周期（如 7.9 天）应按 floor 计算为 1 个周期', () => {
    const now = new Date('2026-07-15T00:00:00.000Z');
    // 7.9 天前 → Math.floor(7.9 / 7) = 1 个周期
    const daysAgo = new Date(now.getTime() - 7.9 * ONE_DAY_MS);
    const memory = makeMemory({ score: 0.8, accessedAt: daysAgo.toISOString() });

    const result = applyDecayToMemory(memory, now);
    expect(result).toBe(true);
    // 1 个周期：0.8 - 0.02 * 1 = 0.78
    expect(memory.score).toBeCloseTo(0.78, 5);
  });
});
