/**
 * 记忆召回测试
 * 覆盖关键词提取 + recall 函数 + touchScores 批量 touch
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { recall, extractKeywords, touchScores } from '@/memory/recall.js';
import { RECALL_LIMIT_MULTIPLIER } from '@/memory/hybridMerge.js';
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
    source: 'content',
    name: 'test-memory',
    createdAt: '2026-01-01T00:00:00.000Z',
    accessedAt: '2026-01-01T00:00:00.000Z',
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
      makeMemory({ id: 'content:1', source: 'content' }),
      makeMemory({ id: 'work-projection:1', source: 'work-projection' }),
    ];
    vi.mocked(mockStorage.search).mockReturnValue(results);

    const memories = await recall(mockStorage, '测试查询');

    expect(memories).toHaveLength(2);
    expect(mockStorage.search).toHaveBeenCalledWith('测试 查询', 10); // 提取关键词后组合搜索
  });

  it('默认不排除任何 source（设定记忆已归角色包，不再参与召回排除）', async () => {
    const results = [
      makeMemory({ id: 'persona:1', source: 'persona' }),
      makeMemory({ id: 'rule:1', source: 'rule' }),
      makeMemory({ id: 'skill:1', source: 'skill' }),
    ];
    vi.mocked(mockStorage.search).mockReturnValue(results);

    const memories = await recall(mockStorage, '测试');

    // persona、rule、skill 均不再被默认排除（历史补丁已随角色包解耦剪枝）
    expect(memories).toHaveLength(3);
  });

  it('应该支持自定义 excludeSources', async () => {
    const results = [
      makeMemory({ id: 'persona:1', source: 'persona' }),
      makeMemory({ id: 'skill:1', source: 'skill' }),
    ];
    vi.mocked(mockStorage.search).mockReturnValue(results);

    const memories = await recall(mockStorage, '测试', { excludeSources: [] });

    // 不排除任何 source
    expect(memories).toHaveLength(2);
  });

  it('应该限制返回数量', async () => {
    const results = Array.from({ length: 10 }, (_, i) =>
      makeMemory({ id: `content:${i}`, source: 'content' }),
    );
    vi.mocked(mockStorage.search).mockReturnValue(results);

    const memories = await recall(mockStorage, '测试', { limit: 3 });

    expect(memories).toHaveLength(3);
  });

  it('limit 超上限应 clamp 到 100（防 ×multiplier 放大底层搜索）', async () => {
    const results = Array.from({ length: 150 }, (_, i) =>
      makeMemory({ id: `content:${i}`, source: 'content' }),
    );
    vi.mocked(mockStorage.search).mockReturnValue(results);

    const memories = await recall(mockStorage, '测试', { limit: 100000 });

    // clamp 后 limit=100，底层 search 请求 limit×2=200，返回不超过 100 条
    expect(memories).toHaveLength(100);
    expect(mockStorage.search).toHaveBeenCalledWith('测试', 200);
  });

  it('未提供 vectorStore 时保持关键词通道插入序（score 退役后不再按 score 重排）', async () => {
    // 阶段3 排序纯化：hybridMerge=单 vectorScore；关键词通道全为 0 → stable-sort 保插入序
    const results = [
      makeMemory({ id: 'content:1', source: 'content' }),
      makeMemory({ id: 'content:2', source: 'content' }),
      makeMemory({ id: 'content:3', source: 'content' }),
    ];
    vi.mocked(mockStorage.search).mockReturnValue(results);

    const memories = await recall(mockStorage, '测试');

    // 结果保 storage.search 返回序（不再被 score 重排）
    expect(memories.map((m) => m.id)).toEqual(['content:1', 'content:2', 'content:3']);
  });

  it('无关键词时应返回空数组', async () => {
    const memories = await recall(mockStorage, '！@#￥%');

    expect(memories).toEqual([]);
    // 无关键词时不应调用 search
    expect(mockStorage.search).not.toHaveBeenCalled();
  });

  it('recall 返回刷新 accessedAt 的副本（不调用 upsert、不修改原对象）', async () => {
    const original = makeMemory({ id: 'content:1', source: 'content' });
    vi.mocked(mockStorage.search).mockReturnValue([original]);

    const memories = await recall(mockStorage, '测试');

    // recall 只读：不再 upsert；持久化 touch 由调用方 fire-and-forget
    expect(mockStorage.upsert).not.toHaveBeenCalled();
    // 返回的 memory 是副本且为非空 accessedAt（§5.2 只 touch 不 +score，score 已物理退役）
    expect(memories[0]).not.toBe(original);
    expect(memories[0]!.id).toBe(original.id);
    expect(typeof memories[0]!.accessedAt).toBe('string');
    // 原始对象不应被修改（不污染调用方持有的对象）
    expect(original.accessedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  // ── 召回保底（recall fallback）──

  it('保底：语义召回不足时用最近记忆补足至 minFallback', async () => {
    // 关键词搜索仅返回 1 条（不足默认 minFallback=2）
    vi.mocked(mockStorage.search).mockReturnValueOnce([
      makeMemory({ id: 'content:1', source: 'content' }),
    ]);
    // 空查询补足通道：storage.search('', n) 返回最近记忆
    vi.mocked(mockStorage.search).mockReturnValueOnce([
      makeMemory({ id: 'content:recent1', source: 'content' }),
      makeMemory({ id: 'content:recent2', source: 'content' }),
    ]);

    const memories = await recall(mockStorage, '测试');

    // 语义命中 1 条 + 空查询补足 1 条 = 达到 minFallback=2
    expect(memories).toHaveLength(2);
    const ids = memories.map((m) => m.id);
    expect(ids).toContain('content:1');
    expect(ids).toContain('content:recent1');
    // 空查询通道被调用：取 shortfall(1) * RECALL_LIMIT_MULTIPLIER 条
    expect(mockStorage.search).toHaveBeenLastCalledWith('', 1 * RECALL_LIMIT_MULTIPLIER);
  });

  it('保底：语义召回充足时不做空查询补足', async () => {
    // 关键词搜索返回 3 条（>= minFallback=2），无需补足
    vi.mocked(mockStorage.search).mockReturnValueOnce([
      makeMemory({ id: 'content:1', source: 'content' }),
      makeMemory({ id: 'content:2', source: 'content' }),
      makeMemory({ id: 'content:3', source: 'content' }),
    ]);

    const memories = await recall(mockStorage, '测试');

    expect(memories).toHaveLength(3);
    // 充足时不应触发空查询补足（无第二次 search 调用）
    expect(mockStorage.search).toHaveBeenCalledTimes(1);
  });

  it('保底：补足项排在语义命中之后，不抢占相关性', async () => {
    // 语义命中 1 条（高分），补足 1 条低分
    vi.mocked(mockStorage.search).mockReturnValueOnce([
      makeMemory({ id: 'content:high', source: 'content' })
    ]);
    vi.mocked(mockStorage.search).mockReturnValueOnce([
      makeMemory({ id: 'content:recent', source: 'content' }),
    ]);

    const memories = await recall(mockStorage, '测试');

    // 语义命中项排最前，补足项紧随其后
    expect(memories[0]!.id).toBe('content:high');
    expect(memories[1]!.id).toBe('content:recent');
  });

  it('保底：补足项同样去 superseded，不注入被取代摘要', async () => {
    // 语义命中 1 条（不足），补足通道返回 1 条被 superseded 的 + 1 条正常
    vi.mocked(mockStorage.search).mockReturnValueOnce([
      makeMemory({ id: 'content:1', source: 'content' }),
    ]);
    vi.mocked(mockStorage.search).mockReturnValueOnce([
      makeMemory({ id: 'content:superseded', source: 'content', supersededBy: 'content:2' }),
      makeMemory({ id: 'content:valid', source: 'content' }),
    ]);

    const memories = await recall(mockStorage, '测试');

    const ids = memories.map((m) => m.id);
    // 被取代项被过滤，仅补入正常项
    expect(ids).toContain('content:1');
    expect(ids).toContain('content:valid');
    expect(ids).not.toContain('content:superseded');
  });

  it('保底：minFallback 置 0 时彻底关闭', async () => {
    // 关键词搜索仅返回 1 条，但 minFallback=0 关闭保底
    vi.mocked(mockStorage.search).mockReturnValueOnce([
      makeMemory({ id: 'content:1', source: 'content' }),
    ]);

    const memories = await recall(mockStorage, '测试', { minFallback: 0 });

    expect(memories).toHaveLength(1);
    // 关闭时不触发空查询补足
    expect(mockStorage.search).toHaveBeenCalledTimes(1);
  });

  it('保底：零召回（新会话冷启动）时用最近记忆补足', async () => {
    // 关键词搜索返回空（新会话无相关记忆）
    vi.mocked(mockStorage.search).mockReturnValueOnce([]);
    // 空查询补足通道返回最近记忆
    vi.mocked(mockStorage.search).mockReturnValueOnce([
      makeMemory({ id: 'content:recent1', source: 'content' }),
      makeMemory({ id: 'content:recent2', source: 'content' }),
    ]);

    const memories = await recall(mockStorage, '测试', { minFallback: 2 });

    // 零召回时补足至 minFallback=2
    expect(memories).toHaveLength(2);
  });

  it('保底：无关键词（纯符号/噪声）输入不触发空查询补足', async () => {
    const memories = await recall(mockStorage, '！@#￥%');

    // 无关键词时返回空数组，且不触发任何 search（含空查询补足）
    expect(memories).toEqual([]);
    expect(mockStorage.search).not.toHaveBeenCalled();
  });
});

describe('touchScores · 批量持久化 touch（只刷 accessedAt）', () => {
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
      // score 物理退役后 touch 为唯一写位：只刷新 accessedAt（原子）
      touch: vi.fn(() => true),
      getAllSources: vi.fn(() => new Map()),
      close: vi.fn(),
    } as unknown as IMemoryStorage;
  });

  it('应对每个 id 调用 touch 刷新 accessedAt', async () => {
    await touchScores(mockStorage, ['content:1', 'content:2']);

    // 应调用 2 次 touch
    expect(mockStorage.touch).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(mockStorage.touch).mock.calls;
    expect(calls[0]![0]).toBe('content:1');
    expect(calls[1]![0]).toBe('content:2');
    // 第二参为 ISO 时间戳（承接「只 touch 不 +score」定案，score 已物理退役）
    expect(typeof calls[0]![1]).toBe('string');
  });

  it('touch 返回 false（记忆不存在/已删除）不报错', async () => {
    vi.mocked(mockStorage.touch).mockReturnValue(false);

    // touchScores 不检查返回值，fire-and-forget 由 storage 层静默处理
    await expect(touchScores(mockStorage, ['content:deleted'])).resolves.toBeUndefined();
  });

  it('空 ids 数组应直接返回，不调用 touch', async () => {
    await touchScores(mockStorage, []);

    expect(mockStorage.touch).not.toHaveBeenCalled();
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
      { id: 'content:semantic-1', similarity: 0.9 },
    ]);
    vi.mocked(mockStorage.getById).mockReturnValue(
      makeMemory({ id: 'content:semantic-1', source: 'content' }),
    );
    vi.mocked(mockStorage.search).mockReturnValue([]);

    const memories = await recall(mockStorage, '测试查询', { vectorStore: mockVectorStore as unknown as IVectorStore });

    expect(memories).toHaveLength(1);
    expect(memories[0]!.id).toBe('content:semantic-1');
    // 语义搜索应被调用，topK = limit * RECALL_LIMIT_MULTIPLIER = 5 * 2 = 10
    expect(mockVectorStore.search).toHaveBeenCalledWith('测试查询', 10, 0.3);
  });

  it('vectorStore.size=0 时跳过语义搜索', async () => {
    // size=0 时不应调用 vectorStore.search
    mockVectorStore.size = 0;
    vi.mocked(mockStorage.search).mockReturnValue([
      makeMemory({ id: 'content:1', source: 'content' }),
    ]);

    const memories = await recall(mockStorage, '测试', { vectorStore: mockVectorStore as unknown as IVectorStore });

    expect(mockVectorStore.search).not.toHaveBeenCalled();
    expect(memories).toHaveLength(1);
  });

  it('excludeSources 对语义搜索结果也生效', async () => {
    // 语义搜索返回 persona source，应被显式 excludeSources 排除
    vi.mocked(mockVectorStore.search).mockResolvedValue([
      { id: 'persona:1', similarity: 0.9 },
    ]);
    vi.mocked(mockStorage.getById).mockReturnValue(
      makeMemory({ id: 'persona:1', source: 'persona' }),
    );

    const memories = await recall(mockStorage, '测试', {
      vectorStore: mockVectorStore as unknown as IVectorStore,
      excludeSources: ['persona'],
    });

    // persona 被显式排除，应返回空
    expect(memories).toHaveLength(0);
  });

  it('双通道融合去重（同一 id 不重复返回）', async () => {
    // 语义搜索 + 关键词搜索都返回同一 id，应去重为 1 条
    vi.mocked(mockVectorStore.search).mockResolvedValue([
      { id: 'content:dup', similarity: 0.9 },
    ]);
    vi.mocked(mockStorage.getById).mockReturnValue(
      makeMemory({ id: 'content:dup', source: 'content' }),
    );
    vi.mocked(mockStorage.search).mockReturnValue([
      makeMemory({ id: 'content:dup', source: 'content' }),
    ]);

    const memories = await recall(mockStorage, '测试', { vectorStore: mockVectorStore as unknown as IVectorStore });

    // 同一 id 应去重，仅返回 1 条
    expect(memories).toHaveLength(1);
    expect(memories[0]!.id).toBe('content:dup');
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

  it('高 similarity 应排在关键词命中（vectorScore=0）前面', async () => {
    // 阶段3 排序纯化：融合序 = 单 vectorScore 降序
    // memory A：similarity=0.9 → vectorScore=0.9；memory B：仅关键词命中 → vectorScore=0
    // 期望 A 排在 B 前面
    const mockVectorStore = {
      size: 10,
      search: vi.fn().mockResolvedValue([{ id: 'content:A', similarity: 0.9 }]),
    };
    vi.mocked(mockStorage.getById).mockReturnValue(
      makeMemory({ id: 'content:A', source: 'content' }),
    );
    vi.mocked(mockStorage.search).mockReturnValue([
      makeMemory({ id: 'content:B', source: 'content' }),
    ]);

    const memories = await recall(mockStorage, '测试', { vectorStore: mockVectorStore as unknown as IVectorStore });

    expect(memories).toHaveLength(2);
    // A(vectorScore=0.9) > B(vectorScore=0)，A 应排在前面
    expect(memories[0]!.id).toBe('content:A');
    expect(memories[1]!.id).toBe('content:B');
  });

  it('高 similarity 排在关键词命中之前（score 退役后不再携带关键词命中反超）', async () => {
    // 阶段3 排序纯化：融合序 = 单 vectorScore 降序；A 向量命中 0.4、B 仅关键词命中(0)
    // A(0.4) > B(0)，A 恒在前——高 score 不再能弥补无相似度
    const mockVectorStore = {
      size: 10,
      search: vi.fn().mockResolvedValue([{ id: 'content:A', similarity: 0.4 }]),
    };
    vi.mocked(mockStorage.getById).mockReturnValue(
      makeMemory({ id: 'content:A', source: 'content' }),
    );
    vi.mocked(mockStorage.search).mockReturnValue([
      makeMemory({ id: 'content:B', source: 'content' })
    ]);

    const memories = await recall(mockStorage, '测试', { vectorStore: mockVectorStore as unknown as IVectorStore });

    expect(memories).toHaveLength(2);
    // A 向量命中 → 排前；B 关键词命中 → 排后
    expect(memories[0]!.id).toBe('content:A');
    expect(memories[1]!.id).toBe('content:B');
  });

  it('limit 应在融合排序后截断', async () => {
    // 语义搜索返回 3 条，关键词搜索返回 3 条，limit=2 应截断到 2 条
    const mockVectorStore = {
      size: 10,
      search: vi.fn().mockResolvedValue([
        { id: 'content:v1', similarity: 0.9 },
        { id: 'content:v2', similarity: 0.8 },
        { id: 'content:v3', similarity: 0.7 },
      ]),
    };
    vi.mocked(mockStorage.getById).mockImplementation((id: string) =>
      makeMemory({ id, source: 'content' }),
    );
    vi.mocked(mockStorage.search).mockReturnValue([
      makeMemory({ id: 'content:k1', source: 'content' }),
      makeMemory({ id: 'content:k2', source: 'content' }),
      makeMemory({ id: 'content:k3', source: 'content' }),
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
      makeMemory({ id: 'content:fallback', source: 'content' }),
    ]);

    const memories = await recall(mockStorage, '测试', { vectorStore: mockVectorStore as unknown as IVectorStore });

    // 语义搜索失败，降级到关键词搜索，仍应返回结果
    expect(memories).toHaveLength(1);
    expect(memories[0]!.id).toBe('content:fallback');
    // 关键词搜索应被调用
    expect(mockStorage.search).toHaveBeenCalled();
  });

  it('关键词搜索抛错时应仅返回语义搜索结果', async () => {
    // storage.search 抛错，应仅返回语义搜索结果
    const mockVectorStore = {
      size: 10,
      search: vi.fn().mockResolvedValue([{ id: 'content:semantic', similarity: 0.9 }]),
    };
    vi.mocked(mockStorage.getById).mockReturnValue(
      makeMemory({ id: 'content:semantic', source: 'content' }),
    );
    vi.mocked(mockStorage.search).mockImplementation(() => {
      throw new Error('SQLite 锁定');
    });

    const memories = await recall(mockStorage, '测试', { vectorStore: mockVectorStore as unknown as IVectorStore });

    // 关键词搜索失败，仅返回语义搜索结果
    expect(memories).toHaveLength(1);
    expect(memories[0]!.id).toBe('content:semantic');
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

// 会话窗口优先 + 组内时间排序

describe('recall · 会话窗口优先 + 组内时间排序', () => {
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

  it('同会话窗口优先，跨会话记忆次之', async () => {
    const cross = makeMemory({
      id: 'round-summary:cross',
      source: 'round-summary',
      summaryType: 'fact', sessionName: 'other-session', roundId: 'r1',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const same = makeMemory({
      id: 'round-summary:same',
      source: 'round-summary',
      summaryType: 'fact', sessionName: 'current-session', roundId: 'r2',
      createdAt: '2026-01-02T00:00:00.000Z',
    });
    vi.mocked(mockStorage.search).mockReturnValue([cross, same]);

    const memories = await recall(mockStorage, '测试', { sessionId: 'current-session' });

    // 会话窗口匹配的排前，跨会话的排后（即使跨会话的 createdAt 更早）
    expect(memories[0]!.id).toBe('round-summary:same');
    expect(memories[1]!.id).toBe('round-summary:cross');
  });

  it('同会话窗口内按 createdAt 升序', async () => {
    const older = makeMemory({
      id: 'round-summary:older',
      source: 'round-summary',
      summaryType: 'fact', sessionName: 'cur', roundId: 'r1',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const newer = makeMemory({
      id: 'round-summary:newer',
      source: 'round-summary',
      summaryType: 'fact', sessionName: 'cur', roundId: 'r2',
      createdAt: '2026-01-03T00:00:00.000Z',
    });
    vi.mocked(mockStorage.search).mockReturnValue([newer, older]);

    const memories = await recall(mockStorage, '测试', { sessionId: 'cur' });

    // 同窗口内时间升序：older 在前，newer 在后
    expect(memories[0]!.id).toBe('round-summary:older');
    expect(memories[1]!.id).toBe('round-summary:newer');
  });

  it('无 sessionId 时按 createdAt 升序', async () => {
    const older = makeMemory({
      id: 'round-summary:older',
      source: 'round-summary',
      summaryType: 'fact', sessionName: 'a', roundId: 'r1',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const newer = makeMemory({
      id: 'round-summary:newer',
      source: 'round-summary',
      summaryType: 'fact', sessionName: 'b', roundId: 'r2',
      createdAt: '2026-01-02T00:00:00.000Z',
    });
    vi.mocked(mockStorage.search).mockReturnValue([newer, older]);

    const memories = await recall(mockStorage, '测试');

    expect(memories[0]!.id).toBe('round-summary:older');
    expect(memories[1]!.id).toBe('round-summary:newer');
  });
});

describe('recall · 前置互斥排除（excludeRoundIds）', () => {
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

  it('前置排除：命中 excludeRoundIds 的 round-summary 被过滤，跨会话记忆补位 top-limit', async () => {
    // 语义召回返回：两个当前会话最近轮摘要（roundId 命中排除）+ 一个跨会话记忆
    vi.mocked(mockStorage.search).mockReturnValueOnce([
      makeMemory({
        id: 'round:A', source: 'round-summary',
        roundId: 'r1', sessionName: 'cur', summaryType: 'fact',
      }),
      makeMemory({
        id: 'round:B', source: 'round-summary',
        roundId: 'r2', sessionName: 'cur', summaryType: 'fact',
      }),
      makeMemory({ id: 'cross:1', source: 'content' }),
    ]);

    const memories = await recall(mockStorage, '测试', {
      limit: 2,
      minFallback: 0, // 关闭保底，隔离前置排除逻辑
      excludeRoundIds: new Set(['r1', 'r2']),
    });

    const ids = memories.map((m) => m.id);
    // 当前会话最近轮摘要被前置过滤，不占 top-limit 预算
    expect(ids).not.toContain('round:A');
    expect(ids).not.toContain('round:B');
    // 跨会话记忆补位
    expect(ids).toContain('cross:1');
  });

  it('排除集合含 roundId 时，无 roundId 的记忆不受影响', async () => {
    // 一个 round-summary（roundId 命中）+ 一个无 roundId 的 content 记忆
    vi.mocked(mockStorage.search).mockReturnValueOnce([
      makeMemory({
        id: 'round:A', source: 'round-summary',
        roundId: 'r1', sessionName: 'cur', summaryType: 'fact',
      }),
      makeMemory({ id: 'content:1', source: 'content' }),
    ]);

    const memories = await recall(mockStorage, '测试', {
      minFallback: 0,
      excludeRoundIds: new Set(['r1']),
    });

    const ids = memories.map((m) => m.id);
    expect(ids).not.toContain('round:A');
    expect(ids).toContain('content:1');
  });

  it('保底补足：excludeRoundIds 命中的 round-summary 不被补回（避免重复注入）', async () => {
    // 语义召回不足（1 条），触发保底补足
    vi.mocked(mockStorage.search).mockReturnValueOnce([
      makeMemory({ id: 'content:1', source: 'content' }),
    ]);
    // 空查询补足通道返回：一个当前会话最近轮摘要（roundId 命中排除）+ 一个跨会话记忆
    vi.mocked(mockStorage.search).mockReturnValueOnce([
      makeMemory({
        id: 'round:A', source: 'round-summary',
        roundId: 'r1', sessionName: 'cur', summaryType: 'fact',
      }),
      makeMemory({ id: 'cross:1', source: 'content' }),
    ]);

    const memories = await recall(mockStorage, '测试', {
      minFallback: 2,
      excludeRoundIds: new Set(['r1']),
    });

    const ids = memories.map((m) => m.id);
    // 命中的 round-summary（正文已加载）不被补回
    expect(ids).not.toContain('round:A');
    // 跨会话记忆被补足
    expect(ids).toContain('cross:1');
  });
});

// ─── v3 分层分轨召回（§4.3 分轨策略 + §4.3.1 cap 内分配） ─────────────────────

describe('recall · v3 分层分轨（preference 进池 / intent 排除 / cap 分配）', () => {
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

  it('L2 preference 无条件进池：语义/关键词未命中时仍补入跨会话偏好', async () => {
    // 关键词搜索返回空（无相关记忆命中）
    vi.mocked(mockStorage.search).mockReturnValueOnce([]);
    // 枚举 round-summary 返回一条跨会话 preference
    vi.mocked(mockStorage.getBySource).mockReturnValue([
      makeMemory({
        id: 'pref:1', source: 'round-summary', summaryType: 'preference',
        sessionName: 'other-session', roundId: 'p1',
        content: '用户偏好 TypeScript', createdAt: '2026-01-01T00:00:00.000Z',
      }),
    ]);

    const memories = await recall(mockStorage, '测试', {
      sessionId: 'current-session',
      minFallback: 0, // 关闭保底，隔离无条件进池逻辑
    });

    // preference 无条件进池，即便检索未命中
    expect(memories.map((m) => m.id)).toContain('pref:1');
  });

  it('L2 preference 无条件进池：只补跨会话偏好，当前会话（L1）偏好不被重复补入', async () => {
    // 当前会话偏好已由关键词通道命中 → 不应被 getBySource 重复补入（去重）
    vi.mocked(mockStorage.search).mockReturnValueOnce([
      makeMemory({
        id: 'pref:l1', source: 'round-summary', summaryType: 'preference',
        sessionName: 'current-session', roundId: 'p1',
      }),
    ]);
    // 枚举里同时有 L1 偏好与 L2 偏好
    vi.mocked(mockStorage.getBySource).mockReturnValue([
      makeMemory({
        id: 'pref:l1', source: 'round-summary', summaryType: 'preference',
        sessionName: 'current-session', roundId: 'p1',
      }),
      makeMemory({
        id: 'pref:l2', source: 'round-summary', summaryType: 'preference',
        sessionName: 'other-session', roundId: 'p2',
      }),
    ]);

    const memories = await recall(mockStorage, '测试', {
      sessionId: 'current-session',
      minFallback: 0,
    });

    const ids = memories.map((m) => m.id);
    // L1 偏好走语义召回命中（1 条），L2 偏好补入（1 条），无重复
    expect(ids).toContain('pref:l1');
    expect(ids).toContain('pref:l2');
    expect(ids.filter((id) => id === 'pref:l1')).toHaveLength(1);
  });

  it('L2 intent 排除：跨会话意图摘要不进候选池', async () => {
    vi.mocked(mockStorage.search).mockReturnValueOnce([
      makeMemory({
        id: 'intent:1', source: 'round-summary', summaryType: 'intent',
        sessionName: 'other-session', roundId: 'i1',
      }),
      makeMemory({
        id: 'fact:1', source: 'round-summary', summaryType: 'fact',
        sessionName: 'other-session', roundId: 'f1',
      }),
    ]);

    const memories = await recall(mockStorage, '测试', {
      sessionId: 'current-session',
      minFallback: 0,
    });

    const ids = memories.map((m) => m.id);
    // 跨会话 intent 被排除，fact 保留
    expect(ids).not.toContain('intent:1');
    expect(ids).toContain('fact:1');
  });

  it('L1 intent 保留：当前会话意图摘要仍走语义召回进池（4.3 表）', async () => {
    vi.mocked(mockStorage.search).mockReturnValueOnce([
      makeMemory({
        id: 'intent:1', source: 'round-summary', summaryType: 'intent',
        sessionName: 'current-session', roundId: 'i1',
      }),
    ]);

    const memories = await recall(mockStorage, '测试', {
      sessionId: 'current-session',
      minFallback: 0,
    });

    // L1 intent 不被排除
    expect(memories.map((m) => m.id)).toContain('intent:1');
  });

  it('cap 分配：preference 取余量、语义轨保底 semanticFloor（minSemanticShare 防挤占）', async () => {
    // 6 条 preference + 6 条 fact，content 40 字符 → 约 10 token/条
    const makePool = () => {
      const prefs = Array.from({ length: 6 }, (_, i) =>
        makeMemory({
          id: `pref:${i}`, source: 'round-summary', summaryType: 'preference',
          sessionName: 'other', roundId: `p${i}`, content: 'x'.repeat(40),
          createdAt: `2026-01-0${i + 1}T00:00:00.000Z`,
        }),
      );
      const facts = Array.from({ length: 6 }, (_, i) =>
        makeMemory({
          id: `fact:${i}`, source: 'round-summary', summaryType: 'fact',
          sessionName: 'other', roundId: `f${i}`, content: 'y'.repeat(40),
          createdAt: `2026-01-0${i + 1}T00:00:00.000Z`,
        }),
      );
      return [...prefs, ...facts];
    };

    // 对照组：minSemanticShare=0（默认）→ preference 可占满 prefAllowance，语义轨被挤出到余量 4 条
    // limit=10 提供足够条数预算（10 条 ≥ cap=100 允许的 10 条），隔离观察 cap 内 token 分配份额
    vi.mocked(mockStorage.search).mockReturnValueOnce(makePool());
    const withShare0 = await recall(mockStorage, '测试', {
      sessionId: 'current-session',
      minFallback: 0,
      capTokens: 100,
      minSemanticShare: 0,
      limit: 10,
    });
    expect(withShare0.filter((m) => m.summaryType === 'preference')).toHaveLength(6);
    expect(withShare0.filter((m) => m.summaryType === 'fact')).toHaveLength(4);

    // 实验组：minSemanticShare=0.5 → semanticFloor=50 token（5 条），语义轨保底生效，preference 让出 1 条
    vi.mocked(mockStorage.search).mockReturnValueOnce(makePool());
    const withShare = await recall(mockStorage, '测试', {
      sessionId: 'current-session',
      minFallback: 0,
      capTokens: 100,
      minSemanticShare: 0.5,
      limit: 10,
    });
    expect(withShare.filter((m) => m.summaryType === 'preference')).toHaveLength(5);
    expect(withShare.filter((m) => m.summaryType === 'fact')).toHaveLength(5);
  });

  it('cap 分配：limit 条数主导时语义保底仍在条数层面生效（防止 slice 截断破坏）', async () => {
    // limit=5 远小于 cap=100 允许条数（contextPreparer 场景：limit=5 << cap token）——
    // 修复前 cap 分配后 slice(0,5) 按分层顺序截断，preference 排前全保留、语义轨被挤出；
    // 修复后 limit 作为分配内条数约束，minSemanticShare=0.5 保证语义轨至少占剩余条数一半
    const makePool = () => {
      const prefs = Array.from({ length: 6 }, (_, i) =>
        makeMemory({
          id: `pref:${i}`, source: 'round-summary', summaryType: 'preference',
          sessionName: 'other', roundId: `p${i}`, content: 'x'.repeat(40),
          createdAt: `2026-01-0${i + 1}T00:00:00.000Z`,
        }),
      );
      const facts = Array.from({ length: 6 }, (_, i) =>
        makeMemory({
          id: `fact:${i}`, source: 'round-summary', summaryType: 'fact',
          sessionName: 'other', roundId: `f${i}`, content: 'y'.repeat(40),
          createdAt: `2026-01-0${i + 1}T00:00:00.000Z`,
        }),
      );
      return [...prefs, ...facts];
    };

    // minSemanticShare=0.5、limit=5：语义保底条数=ceil(5×0.5)=3 → preference 最多 2 条、语义轨至少 3 条
    vi.mocked(mockStorage.search).mockReturnValueOnce(makePool());
    const withShare = await recall(mockStorage, '测试', {
      sessionId: 'current-session',
      minFallback: 0,
      capTokens: 100,
      minSemanticShare: 0.5,
      limit: 5,
    });
    expect(withShare).toHaveLength(5); // limit 条数封顶生效
    expect(withShare.filter((m) => m.summaryType === 'preference')).toHaveLength(2);
    expect(withShare.filter((m) => m.summaryType === 'fact')).toHaveLength(3);

    // 对照组：minSemanticShare=0（默认）→ preference 可占满 5 条（语义保底关闭）
    vi.mocked(mockStorage.search).mockReturnValueOnce(makePool());
    const withShare0 = await recall(mockStorage, '测试', {
      sessionId: 'current-session',
      minFallback: 0,
      capTokens: 100,
      minSemanticShare: 0,
      limit: 5,
    });
    expect(withShare0.filter((m) => m.summaryType === 'preference')).toHaveLength(5);
    expect(withShare0.filter((m) => m.summaryType === 'fact')).toHaveLength(0);
  });

  it('cap 分配：L1 会话内全量注入，不受 cap 内 pref/语义预算挤占', async () => {
    // 当前会话 2 条（L1）+ 跨会话 6 条 preference + 6 条 fact（L2）
    const l1 = [
      makeMemory({
        id: 'l1:1', source: 'round-summary', summaryType: 'fact',
        sessionName: 'current-session', roundId: 'c1', content: 'a'.repeat(40),
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
      makeMemory({
        id: 'l1:2', source: 'round-summary', summaryType: 'decision',
        sessionName: 'current-session', roundId: 'c2', content: 'b'.repeat(40),
        createdAt: '2026-01-02T00:00:00.000Z',
      }),
    ];
    const prefs = Array.from({ length: 6 }, (_, i) =>
      makeMemory({
        id: `pref:${i}`, source: 'round-summary', summaryType: 'preference',
        sessionName: 'other', roundId: `p${i}`, content: 'x'.repeat(40),
        createdAt: `2026-01-0${i + 1}T00:00:00.000Z`,
      }),
    );
    const facts = Array.from({ length: 6 }, (_, i) =>
      makeMemory({
        id: `fact:${i}`, source: 'round-summary', summaryType: 'fact',
        sessionName: 'other', roundId: `f${i}`, content: 'y'.repeat(40),
        createdAt: `2026-01-0${i + 1}T00:00:00.000Z`,
      }),
    );
    vi.mocked(mockStorage.search).mockReturnValueOnce([...l1, ...prefs, ...facts]);

    const memories = await recall(mockStorage, '测试', {
      sessionId: 'current-session',
      minFallback: 0,
      capTokens: 100,
      minSemanticShare: 0.5,
      limit: 10,
    });

    const ids = memories.map((m) => m.id);
    // L1 全量注入（cap=100 时 L1 2 条 = 20 token 全进，不参与 pref/语义预算争抢）
    expect(ids).toContain('l1:1');
    expect(ids).toContain('l1:2');
    // L1 排在 L2 前面
    expect(ids.indexOf('l1:1')).toBeLessThan(ids.indexOf('pref:0'));
    expect(ids.indexOf('l1:2')).toBeLessThan(ids.indexOf('fact:0'));
  });
});
