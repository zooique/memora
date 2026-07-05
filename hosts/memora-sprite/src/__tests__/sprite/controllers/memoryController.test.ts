/**
 * MemoryController 单元测试（QC-TEST-MEM）
 *
 * 覆盖范围：
 * - 构造函数：依赖注入 + agent.memory 为 null 时降级
 * - list：列表查询（source 过滤 / limit 透传 / contentPreview 截断 / score 格式化 / createdAt 透传）
 * - show：详情查询（含 #toIso 合法/非法日期降级验证）
 * - delete：删除（含向量索引错误降级 + logger.warn）
 * - upsert：添加/更新（含向量索引异步降级 + 默认 score/时间戳）
 * - search：混合搜索 + searchHybrid 失败降级纯关键词
 * - dashboard：仪表盘数据聚合（stats + suggest）
 * - rapportLevel：默契度等级推导（Phase 2.2，纯代码推导，4 等级 + 边界值）
 * - getRelationGraph：关系图谱（ADR-014，节点上限 200）
 *
 * 测试策略（对齐 auditManager.test.ts / presenceController.test.ts 范式）：
 * - mock Agent.memory（MemoryInspector 子集）+ VectorStore，使用 vi.fn() 创建方法
 * - 通过 setLogger() 注入 mock logger，验证 warn 降级日志（logger 为 getter-only 单例，无法 spyOn）
 * - 纯业务逻辑测试，无 I/O、无 LLM、无 DOM
 * - 类型导入使用 import type（consistent-type-imports 规则）
 * - 禁止 @ts-ignore / as any / as unknown as，使用 Partial<T> as T 单层断言
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryController } from '../../../sprite/controllers/memoryController.js';
import type {
  Agent,
  Memory,
  MemoryRelation,
  VectorStore,
  ILogger,
  SuggestHit,
  AgentStats,
  AgentSearchHit,
} from 'memora';
import { setLogger } from 'memora';

// ─── 类型别名 ──────────────────────────────────────────

/** MemoryInspector 类型（从 Agent['memory'] 推导，避免直接导入未导出的类） */
type Inspector = NonNullable<Agent['memory']>;

// ─── Mock 工厂 ──────────────────────────────────────────

/**
 * 创建 Mock MemoryInspector
 *
 * 含 MemoryController 用到的全部 10 个方法：
 * list / getById / getBySource / delete / upsert / stats / suggest / searchHybrid / search / getAllRelations
 * 通过 Partial<Inspector> 中间类型实现单层 as 断言（无需 as unknown as）
 */
function createMockInspector(): Inspector {
  const inspector: Partial<Inspector> = {
    list: vi.fn().mockReturnValue([]),
    getById: vi.fn().mockReturnValue(null),
    getBySource: vi.fn().mockReturnValue([]),
    delete: vi.fn(),
    upsert: vi.fn(),
    stats: vi.fn().mockReturnValue({ total: 0, bySource: {}, relationCount: 0 }),
    suggest: vi.fn().mockReturnValue([]),
    searchHybrid: vi.fn().mockResolvedValue([]),
    search: vi.fn().mockReturnValue([]),
    getAllRelations: vi.fn().mockReturnValue([]),
    // 回收站操作 mock（restore/purge 同步 void，listDeleted 返回 Memory[]）
    restore: vi.fn(),
    purge: vi.fn(),
    listDeleted: vi.fn().mockReturnValue([]),
    // SEC-GAP6-02：getDeletedById 返回 Memory | null（替代 listDeleted().some() 全量遍历）
    getDeletedById: vi.fn().mockReturnValue(null),
  };
  return inspector as Inspector;
}

/**
 * 创建 Mock Agent（仅 memory 属性，MemoryController 唯一依赖）
 *
 * 通过 Partial<Agent> 中间类型实现单层 as 断言
 */
function createMockAgent(inspector: Inspector | null): Agent {
  const agent: Partial<Agent> = { memory: inspector };
  return agent as Agent;
}

/**
 * 创建 Mock VectorStore（仅 upsert + delete，MemoryController 唯一依赖）
 *
 * upsert 返回 Promise<void>（异步），delete 为同步 void
 */
function createMockVectorStore(): VectorStore {
  const store: Partial<VectorStore> = {
    upsert: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn(),
  };
  return store as VectorStore;
}

/**
 * 创建 Mock ILogger
 *
 * 用于通过 setLogger() 注入，验证降级日志调用
 * logger 为 getter-only 单例（get warn() { return _logger.warn.bind(_logger) }），
 * 无法用 vi.spyOn，必须通过 setLogger 替换内部 _logger 引用
 */
function createMockLogger(): ILogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

// ─── 测试数据工厂 ────────────────────────────────────────

/** 创建测试用 Memory 对象（默认值 + 可覆盖） */
function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'test:default',
    content: 'test content',
    source: 'test',
    name: 'default',
    createdAt: '2024-01-01T00:00:00.000Z',
    accessedAt: '2024-01-01T00:00:00.000Z',
    score: 0.5,
    ...overrides,
  };
}

/** 创建测试用 SuggestHit（关联推荐结果） */
function makeSuggestHit(overrides: Partial<SuggestHit> = {}): SuggestHit {
  return {
    name: 'suggestion',
    source: 'insight',
    relevance: 0.8,
    contentPreview: 'preview',
    reason: 'frequently accessed',
    ...overrides,
  };
}

/** 创建测试用 MemoryRelation（ADR-014 关系边） */
function makeRelation(overrides: Partial<MemoryRelation> = {}): MemoryRelation {
  return {
    sourceId: 'test:a',
    targetId: 'test:b',
    type: 'related',
    weight: 0.5,
    createdAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** 创建测试用 AgentSearchHit（搜索结果项） */
function makeSearchHit(overrides: Partial<AgentSearchHit> = {}): AgentSearchHit {
  return {
    id: 'test:hit',
    name: 'hit',
    source: 'test',
    score: 0.7,
    contentPreview: 'preview',
    ...overrides,
  };
}

/** 刷新微任务队列（等待 fire-and-forget Promise 的 .catch 回调执行完毕） */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ─── 测试用例 ────────────────────────────────────────────

describe('MemoryController', () => {
  let mockInspector: Inspector;
  let mockAgent: Agent;
  let mockVectorStore: VectorStore;
  let mockLogger: ILogger;

  beforeEach(() => {
    // 每个测试用例获得全新的 mock 实例，避免状态泄漏
    mockInspector = createMockInspector();
    mockAgent = createMockAgent(mockInspector);
    mockVectorStore = createMockVectorStore();
    mockLogger = createMockLogger();
    // 注入 mock logger（替代默认 console fallback），使降级日志可验证
    setLogger(mockLogger);
  });

  // ─── 1. 构造函数（3 测试） ────────────────────────────

  describe('构造函数', () => {
    it('注入 agent + vectorStore 后应正常实例化并可访问 inspector', () => {
      const controller = new MemoryController(mockAgent, mockVectorStore);
      // 验证实例创建成功：list 委托 inspector.list，返回空数组
      const result = controller.list();
      expect(result).toEqual([]);
      expect(mockInspector.list).toHaveBeenCalledWith(50);
    });

    it('vectorStore 未传时默认为 null（不影响 CRUD 操作）', () => {
      const controller = new MemoryController(mockAgent);
      // 无 vectorStore 时 upsert 不抛错（跳过向量索引更新）
      const id = controller.upsert('test', 'item', 'content');
      expect(id).toBe('test:item');
      // mockVectorStore 未注入控制器，不应被调用
      expect(mockVectorStore.upsert).not.toHaveBeenCalled();
    });

    it('agent.memory 为 null 时所有方法降级（list→[]/show→null/delete→false/upsert→抛错/dashboard→空仪表盘）', () => {
      const controller = new MemoryController(createMockAgent(null));
      expect(controller.list()).toEqual([]);
      expect(controller.show('any:id')).toBeNull();
      expect(controller.delete('any:id')).toBe(false);
      expect(() => controller.upsert('s', 'n', 'c')).toThrow('存储不可用');
      expect(controller.dashboard()).toEqual({
        total: 0,
        bySource: {},
        suggestions: [],
        relationCount: 0,
        conflictCount: 0,
      });
    });
  });

  // ─── 2. list 列表（5 测试） ──────────────────────────

  describe('list', () => {
    it('无 source 参数时调用 inspector.list(50)（默认 limit）', () => {
      const controller = new MemoryController(mockAgent);
      controller.list();
      expect(mockInspector.list).toHaveBeenCalledWith(50);
      expect(mockInspector.getBySource).not.toHaveBeenCalled();
    });

    it('自定义 limit 应透传给 inspector.list', () => {
      const controller = new MemoryController(mockAgent);
      controller.list(undefined, 10);
      expect(mockInspector.list).toHaveBeenCalledWith(10);
    });

    it('有 source 时调用 inspector.getBySource(source) 并 slice(0, limit)', () => {
      const memories = [
        makeMemory({ id: 'a:1' }),
        makeMemory({ id: 'a:2' }),
        makeMemory({ id: 'a:3' }),
      ];
      vi.mocked(mockInspector.getBySource).mockReturnValue(memories);
      const controller = new MemoryController(mockAgent);
      const result = controller.list('a', 2);
      expect(mockInspector.getBySource).toHaveBeenCalledWith('a');
      expect(result).toHaveLength(2);
      expect(result[0]!.id).toBe('a:1');
      expect(result[1]!.id).toBe('a:2');
    });

    it('contentPreview 截断：content > 100 字符时 slice(0,100)+"..."，否则原样', () => {
      const longContent = 'x'.repeat(150);
      const shortContent = 'short';
      vi.mocked(mockInspector.list).mockReturnValue([
        makeMemory({ id: 'long:1', content: longContent }),
        makeMemory({ id: 'short:1', content: shortContent }),
      ]);
      const controller = new MemoryController(mockAgent);
      const result = controller.list();
      // 长内容截断为 100 字符 + "..."（共 103 字符）
      expect(result[0]!.contentPreview).toBe('x'.repeat(100) + '...');
      expect(result[0]!.contentPreview).toHaveLength(103);
      // 短内容原样保留
      expect(result[1]!.contentPreview).toBe('short');
    });

    it('score 格式化保留两位小数（0.56789 → 0.57）+ createdAt 透传', () => {
      vi.mocked(mockInspector.list).mockReturnValue([
        makeMemory({ id: 's:1', score: 0.56789, createdAt: '2024-06-15T08:30:00.000Z' }),
      ]);
      const controller = new MemoryController(mockAgent);
      const result = controller.list();
      expect(result[0]!.score).toBe(0.57);
      expect(result[0]!.createdAt).toBe('2024-06-15T08:30:00.000Z');
    });
  });

  // ─── 3. show 详情（4 测试） ──────────────────────────

  describe('show', () => {
    it('正常返回详情（含 score 格式化 + 合法日期 ISO 转换）', () => {
      const mem = makeMemory({
        id: 'test:1',
        score: 0.9999,
        createdAt: '2024-06-15T08:30:00.000Z',
        accessedAt: '2024-06-20T12:00:00.000Z',
      });
      vi.mocked(mockInspector.getById).mockReturnValue(mem);
      const controller = new MemoryController(mockAgent);
      const result = controller.show('test:1');
      expect(result).not.toBeNull();
      expect(result!.id).toBe('test:1');
      // 0.9999 → Math.round(99.99)/100 = 100/100 = 1
      expect(result!.score).toBe(1);
      expect(result!.createdAt).toBe('2024-06-15T08:30:00.000Z');
      expect(result!.accessedAt).toBe('2024-06-20T12:00:00.000Z');
      expect(result!.content).toBe('test content');
    });

    it('id 不存在时返回 null', () => {
      vi.mocked(mockInspector.getById).mockReturnValue(null);
      const controller = new MemoryController(mockAgent);
      expect(controller.show('missing:id')).toBeNull();
    });

    it('#toIso 非法日期降级返回原始字符串（避免 RangeError 崩溃）', () => {
      const mem = makeMemory({ createdAt: 'invalid', accessedAt: 'also-invalid' });
      vi.mocked(mockInspector.getById).mockReturnValue(mem);
      const controller = new MemoryController(mockAgent);
      const result = controller.show('test:1');
      // 非法日期字符串原样返回（new Date('invalid') → Invalid Date → String(date)）
      expect(result!.createdAt).toBe('invalid');
      expect(result!.accessedAt).toBe('also-invalid');
    });

    it('inspector 为 null 时返回 null', () => {
      const controller = new MemoryController(createMockAgent(null));
      expect(controller.show('any:id')).toBeNull();
    });
  });

  // ─── 4. delete 删除（5 测试） ────────────────────────

  describe('delete', () => {
    it('软删除：getById 确认存在 → inspector.delete → 不碰 vectorStore（保留索引以便恢复） → 返回 true', () => {
      vi.mocked(mockInspector.getById).mockReturnValue(makeMemory({ id: 'test:1' }));
      const controller = new MemoryController(mockAgent, mockVectorStore);
      const result = controller.delete('test:1');
      expect(result).toBe(true);
      expect(mockInspector.delete).toHaveBeenCalledWith('test:1');
      // 软删除不删除向量索引，restore 时无需重新嵌入
      expect(mockVectorStore.delete).not.toHaveBeenCalled();
    });

    it('id 不存在时返回 false，不调用 inspector.delete', () => {
      vi.mocked(mockInspector.getById).mockReturnValue(null);
      const controller = new MemoryController(mockAgent, mockVectorStore);
      const result = controller.delete('missing:id');
      expect(result).toBe(false);
      expect(mockInspector.delete).not.toHaveBeenCalled();
      expect(mockVectorStore.delete).not.toHaveBeenCalled();
    });

    it('inspector 为 null 时返回 false', () => {
      const controller = new MemoryController(createMockAgent(null), mockVectorStore);
      expect(controller.delete('any:id')).toBe(false);
    });

    it('软删除：即使 vectorStore 存在也不调用其 delete（保留索引以便 restore）', () => {
      vi.mocked(mockInspector.getById).mockReturnValue(makeMemory({ id: 'test:1' }));
      const controller = new MemoryController(mockAgent, mockVectorStore);
      const result = controller.delete('test:1');
      // 软删除成功
      expect(result).toBe(true);
      expect(mockInspector.delete).toHaveBeenCalledWith('test:1');
      // 软删除保留向量索引，restore 时无需重新嵌入
      expect(mockVectorStore.delete).not.toHaveBeenCalled();
      // 无降级日志（未触发向量索引操作）
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('无 vectorStore 时跳过向量索引删除，返回 true', () => {
      vi.mocked(mockInspector.getById).mockReturnValue(makeMemory({ id: 'test:1' }));
      const controller = new MemoryController(mockAgent);
      const result = controller.delete('test:1');
      expect(result).toBe(true);
      expect(mockInspector.delete).toHaveBeenCalledWith('test:1');
      expect(mockVectorStore.delete).not.toHaveBeenCalled();
    });
  });

  // ─── 4b. purge 物理删除（6 测试） ───────────

  describe('purge', () => {
    it('SEC-GAP6-01 拒绝物理删除活跃态记忆：仅活跃（未软删除）→ 返回 false，不调用 inspector.purge', () => {
      // 活跃记忆必须先软删除到回收站，再彻底删除（防止绕过软删除保护）
      // SEC-GAP6-02：getDeletedById 返回 null 表示该 id 不在回收站（活跃态）
      vi.mocked(mockInspector.getDeletedById).mockReturnValue(null);
      const controller = new MemoryController(mockAgent, mockVectorStore);
      const result = controller.purge('test:1');
      expect(result).toBe(false);
      expect(mockInspector.purge).not.toHaveBeenCalled();
      expect(mockVectorStore.delete).not.toHaveBeenCalled();
    });

    it('物理删除软删除态记忆：getDeletedById 命中 → inspector.purge → vectorStore.delete → 返回 true', () => {
      // SEC-GAP6-02：getDeletedById 返回软删除态记忆（避免 listDeleted 50 条上限）
      vi.mocked(mockInspector.getDeletedById).mockReturnValue(
        makeMemory({ id: 'test:1', deletedAt: '2024-01-01T00:00:00.000Z' }),
      );
      const controller = new MemoryController(mockAgent, mockVectorStore);
      const result = controller.purge('test:1');
      expect(result).toBe(true);
      expect(mockInspector.purge).toHaveBeenCalledWith('test:1');
      expect(mockVectorStore.delete).toHaveBeenCalledWith('test:1');
    });

    it('id 不存在（不在回收站）返回 false，不调用 inspector.purge', () => {
      // SEC-GAP6-02：getDeletedById 返回 null 表示不存在或非软删除态
      vi.mocked(mockInspector.getDeletedById).mockReturnValue(null);
      const controller = new MemoryController(mockAgent, mockVectorStore);
      const result = controller.purge('missing:id');
      expect(result).toBe(false);
      expect(mockInspector.purge).not.toHaveBeenCalled();
      expect(mockVectorStore.delete).not.toHaveBeenCalled();
    });

    it('inspector 为 null 时返回 false', () => {
      const controller = new MemoryController(createMockAgent(null), mockVectorStore);
      expect(controller.purge('any:id')).toBe(false);
    });

    it('vectorStore.delete 抛错时捕获 + logger.warn，仍返回 true（不阻断主流程）', () => {
      // 软删除态记忆（getDeletedById 命中），物理删除时向量索引抛错
      vi.mocked(mockInspector.getDeletedById).mockReturnValue(
        makeMemory({ id: 'test:1', deletedAt: '2024-01-01T00:00:00.000Z' }),
      );
      // 模拟向量索引删除抛错（同步方法用 mockImplementation）
      vi.mocked(mockVectorStore.delete).mockImplementation(() => {
        throw new Error('vector index corrupted');
      });
      const controller = new MemoryController(mockAgent, mockVectorStore);
      const result = controller.purge('test:1');
      // 主流程不受影响：记忆已物理删除，返回 true
      expect(result).toBe(true);
      expect(mockInspector.purge).toHaveBeenCalledWith('test:1');
      // 降级日志已记录（对齐 upsert 错误处理模式）
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'test:1' }),
        '向量索引删除失败，可能残留孤儿向量',
      );
    });

    it('无 vectorStore 时跳过向量索引删除，返回 true', () => {
      // 软删除态记忆（getDeletedById 命中），无 vectorStore 注入
      vi.mocked(mockInspector.getDeletedById).mockReturnValue(
        makeMemory({ id: 'test:1', deletedAt: '2024-01-01T00:00:00.000Z' }),
      );
      const controller = new MemoryController(mockAgent);
      const result = controller.purge('test:1');
      expect(result).toBe(true);
      expect(mockInspector.purge).toHaveBeenCalledWith('test:1');
      expect(mockVectorStore.delete).not.toHaveBeenCalled();
    });
  });

  // ─── 4c. restore 恢复（4 测试） ─────────────

  describe('restore', () => {
    it('正常恢复：getDeletedById 命中 → inspector.restore → 返回 true', () => {
      // SEC-GAP6-02：getDeletedById 返回软删除态记忆（避免 listDeleted 50 条上限）
      vi.mocked(mockInspector.getDeletedById).mockReturnValue(
        makeMemory({ id: 'test:1', deletedAt: '2024-01-01T00:00:00.000Z' }),
      );
      const controller = new MemoryController(mockAgent, mockVectorStore);
      const result = controller.restore('test:1');
      expect(result).toBe(true);
      expect(mockInspector.restore).toHaveBeenCalledWith('test:1');
    });

    it('id 不在回收站返回 false，不调用 inspector.restore', () => {
      // SEC-GAP6-02：getDeletedById 返回 null 表示不在回收站
      vi.mocked(mockInspector.getDeletedById).mockReturnValue(null);
      const controller = new MemoryController(mockAgent, mockVectorStore);
      const result = controller.restore('test:1');
      expect(result).toBe(false);
      expect(mockInspector.restore).not.toHaveBeenCalled();
    });

    it('inspector 为 null 时返回 false', () => {
      const controller = new MemoryController(createMockAgent(null), mockVectorStore);
      expect(controller.restore('any:id')).toBe(false);
    });

    it('恢复时不碰 vectorStore（软删除时索引未删除，无需重新嵌入）', () => {
      vi.mocked(mockInspector.getDeletedById).mockReturnValue(
        makeMemory({ id: 'test:1', deletedAt: '2024-01-01T00:00:00.000Z' }),
      );
      const controller = new MemoryController(mockAgent, mockVectorStore);
      const result = controller.restore('test:1');
      expect(result).toBe(true);
      expect(mockInspector.restore).toHaveBeenCalledWith('test:1');
      // 恢复不触碰向量索引（软删除时保留，恢复时无需操作）
      expect(mockVectorStore.delete).not.toHaveBeenCalled();
      expect(mockVectorStore.upsert).not.toHaveBeenCalled();
    });
  });

  // ─── 4d. listDeleted 列出回收站（4 测试） ───

  describe('listDeleted', () => {
    it('正常返回回收站列表：映射为 DeletedMemoryListItem（id/name/source/contentPreview/deletedAt）', () => {
      vi.mocked(mockInspector.listDeleted).mockReturnValue([
        makeMemory({ id: 'test:1', name: 'item1', source: 'insight', content: 'short content', deletedAt: '2024-01-01T00:00:00.000Z' }),
        makeMemory({ id: 'test:2', name: 'item2', source: 'profile', content: 'another content', deletedAt: '2024-01-02T00:00:00.000Z' }),
      ]);
      const controller = new MemoryController(mockAgent);
      const result = controller.listDeleted();
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        id: 'test:1',
        name: 'item1',
        source: 'insight',
        contentPreview: 'short content',
        deletedAt: '2024-01-01T00:00:00.000Z',
      });
      expect(result[1]).toEqual({
        id: 'test:2',
        name: 'item2',
        source: 'profile',
        contentPreview: 'another content',
        deletedAt: '2024-01-02T00:00:00.000Z',
      });
    });

    it('content > 100 字符时截断为前 100 字符 + "..."', () => {
      const longContent = 'x'.repeat(150);
      vi.mocked(mockInspector.listDeleted).mockReturnValue([
        makeMemory({ id: 'test:1', content: longContent, deletedAt: '2024-01-01T00:00:00.000Z' }),
      ]);
      const controller = new MemoryController(mockAgent);
      const result = controller.listDeleted();
      expect(result[0].contentPreview).toBe('x'.repeat(100) + '...');
      expect(result[0].contentPreview).toHaveLength(103);
    });

    it('content 恰好 100 字符时不截断（边界条件）', () => {
      const exactContent = 'y'.repeat(100);
      vi.mocked(mockInspector.listDeleted).mockReturnValue([
        makeMemory({ id: 'test:1', content: exactContent, deletedAt: '2024-01-01T00:00:00.000Z' }),
      ]);
      const controller = new MemoryController(mockAgent);
      const result = controller.listDeleted();
      expect(result[0].contentPreview).toBe(exactContent);
      expect(result[0].contentPreview).toHaveLength(100);
    });

    it('inspector 为 null 时返回空数组', () => {
      const controller = new MemoryController(createMockAgent(null));
      expect(controller.listDeleted()).toEqual([]);
    });
  });

  // ─── 5. upsert 添加/更新（5 测试） ───────────────────

  describe('upsert', () => {
    it('正常 upsert：生成 id=${source}:${name} → inspector.upsert → vectorStore.upsert → 返回 id', () => {
      const controller = new MemoryController(mockAgent, mockVectorStore);
      const id = controller.upsert('insight', 'key-1', 'some content');
      expect(id).toBe('insight:key-1');
      // 验证 inspector.upsert 收到完整 Memory 对象
      expect(mockInspector.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'insight:key-1',
          source: 'insight',
          name: 'key-1',
          content: 'some content',
        }),
      );
      // 验证向量索引异步更新
      expect(mockVectorStore.upsert).toHaveBeenCalledWith('insight:key-1', 'some content');
    });

    it('inspector 为 null 时抛 "存储不可用" 错误', () => {
      const controller = new MemoryController(createMockAgent(null));
      expect(() => controller.upsert('s', 'n', 'c')).toThrow('存储不可用');
    });

    it('score 默认 0.5 + createdAt/accessedAt 设为同一 ISO 时间', () => {
      const controller = new MemoryController(mockAgent);
      const before = new Date().toISOString();
      controller.upsert('test', 'item', 'content');
      const after = new Date().toISOString();
      // 提取 inspector.upsert 收到的 Memory 参数
      const upsertedArg = vi.mocked(mockInspector.upsert).mock.calls[0]![0];
      expect(upsertedArg.score).toBe(0.5);
      // createdAt 与 accessedAt 必须相同（同时赋值 new Date().toISOString()）
      expect(upsertedArg.createdAt).toBe(upsertedArg.accessedAt);
      // 时间应在调用前后范围内
      expect(upsertedArg.createdAt >= before).toBe(true);
      expect(upsertedArg.createdAt <= after).toBe(true);
    });

    it('vectorStore.upsert 返回 rejected Promise 时 logger.warn，不影响返回值（异步降级）', async () => {
      vi.mocked(mockVectorStore.upsert).mockRejectedValue(new Error('embedding service down'));
      const controller = new MemoryController(mockAgent, mockVectorStore);
      // upsert 同步返回，不等待向量索引更新
      const id = controller.upsert('test', 'item', 'content');
      expect(id).toBe('test:item');
      expect(mockInspector.upsert).toHaveBeenCalled();
      // 等待微任务刷新（rejected Promise 的 .catch 回调异步执行）
      await flushMicrotasks();
      // 降级日志已记录
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'test:item' }),
        '向量索引更新失败，降级为纯关键词召回',
      );
    });

    it('无 vectorStore 时跳过向量索引更新', () => {
      const controller = new MemoryController(mockAgent);
      const id = controller.upsert('test', 'item', 'content');
      expect(id).toBe('test:item');
      expect(mockVectorStore.upsert).not.toHaveBeenCalled();
    });
  });

  // ─── 6. search 搜索（4 测试） ────────────────────────

  describe('search', () => {
    it('正常混合搜索：searchHybrid 成功返回结果', async () => {
      const hits = [makeSearchHit({ id: 'test:1', similarity: 0.95 })];
      vi.mocked(mockInspector.searchHybrid).mockResolvedValue(hits);
      const controller = new MemoryController(mockAgent);
      const result = await controller.search('keyword');
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe('test:1');
      expect(result[0]!.similarity).toBe(0.95);
      expect(mockInspector.searchHybrid).toHaveBeenCalledWith('keyword', 10);
    });

    it('searchHybrid 抛错时降级到 inspector.search + logger.warn', async () => {
      const fallbackHits = [makeSearchHit({ id: 'fallback:1' })];
      vi.mocked(mockInspector.searchHybrid).mockRejectedValue(new Error('vector search failed'));
      vi.mocked(mockInspector.search).mockReturnValue(fallbackHits);
      const controller = new MemoryController(mockAgent);
      const result = await controller.search('keyword');
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe('fallback:1');
      expect(mockInspector.search).toHaveBeenCalledWith('keyword', 10);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'keyword' }),
        '混合搜索失败，降级为纯关键词搜索',
      );
    });

    it('inspector 为 null 时返回 []', async () => {
      const controller = new MemoryController(createMockAgent(null));
      const result = await controller.search('keyword');
      expect(result).toEqual([]);
    });

    it('limit 透传（默认 10，自定义 5）', async () => {
      vi.mocked(mockInspector.searchHybrid).mockResolvedValue([]);
      const controller = new MemoryController(mockAgent);
      await controller.search('keyword', 5);
      expect(mockInspector.searchHybrid).toHaveBeenCalledWith('keyword', 5);
    });
  });

  // ─── 7. dashboard 仪表盘（4 测试） ───────────────────

  describe('dashboard', () => {
    it('正常聚合 total/bySource/suggestions/relationCount', () => {
      const stats: AgentStats = {
        total: 42,
        bySource: { insight: 20, profile: 15, rule: 7 },
        relationCount: 8,
      };
      const hits = [makeSuggestHit({ name: 'sugg-1' })];
      vi.mocked(mockInspector.stats).mockReturnValue(stats);
      vi.mocked(mockInspector.suggest).mockReturnValue(hits);
      const controller = new MemoryController(mockAgent);
      const result = controller.dashboard();
      expect(result.total).toBe(42);
      expect(result.bySource).toEqual({ insight: 20, profile: 15, rule: 7 });
      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0]!.name).toBe('sugg-1');
      expect(result.relationCount).toBe(8);
    });

    it('suggest 传 undefined + { limit: 5 }', () => {
      vi.mocked(mockInspector.stats).mockReturnValue({ total: 0, bySource: {}, relationCount: 0 });
      const controller = new MemoryController(mockAgent);
      controller.dashboard();
      expect(mockInspector.suggest).toHaveBeenCalledWith(undefined, { limit: 5 });
    });

    it('inspector 为 null 时返回空仪表盘（降级而非崩溃）', () => {
      const controller = new MemoryController(createMockAgent(null));
      const result = controller.dashboard();
      expect(result).toEqual({ total: 0, bySource: {}, suggestions: [], relationCount: 0, conflictCount: 0 });
    });

    it('relationCount 透传自 stats.relationCount', () => {
      vi.mocked(mockInspector.stats).mockReturnValue({ total: 10, bySource: {}, relationCount: 99 });
      vi.mocked(mockInspector.suggest).mockReturnValue([]);
      const controller = new MemoryController(mockAgent);
      expect(controller.dashboard().relationCount).toBe(99);
    });
  });

  // ─── 8. rapportLevel 默契度（Phase 2.2，6 测试） ─────

  describe('rapportLevel', () => {
    it('stranger：total < 5 → level=stranger + factors 含 "记忆总数 3/5"', () => {
      vi.mocked(mockInspector.stats).mockReturnValue({ total: 3, bySource: {}, relationCount: 0 });
      vi.mocked(mockInspector.suggest).mockReturnValue([]);
      const controller = new MemoryController(mockAgent);
      const result = controller.rapportLevel();
      expect(result.level).toBe('stranger');
      expect(result.description).toBe('初识阶段，精灵正在了解你');
      expect(result.factors).toContain('记忆总数 3/5');
    });

    it('acquaintance：total ≥ 5 但 profileCount < 10 → factors 含 "用户画像 X/10" + "记忆总数 X"', () => {
      vi.mocked(mockInspector.stats).mockReturnValue({
        total: 8,
        bySource: { profile: 3 },
        relationCount: 1,
      });
      vi.mocked(mockInspector.suggest).mockReturnValue([]);
      const controller = new MemoryController(mockAgent);
      const result = controller.rapportLevel();
      expect(result.level).toBe('acquaintance');
      expect(result.description).toBe('相识阶段，精灵记住了你的部分偏好');
      expect(result.factors).toContain('用户画像 3/10');
      expect(result.factors).toContain('记忆总数 8');
    });

    it('familiar：profileCount ≥ 10 但 insightCount < 50 → factors 含 "洞察记忆 X/50" + "用户画像 X" + "关系边 X"', () => {
      vi.mocked(mockInspector.stats).mockReturnValue({
        total: 20,
        bySource: { profile: 12, insight: 5 },
        relationCount: 3,
      });
      vi.mocked(mockInspector.suggest).mockReturnValue([]);
      const controller = new MemoryController(mockAgent);
      const result = controller.rapportLevel();
      expect(result.level).toBe('familiar');
      expect(result.description).toBe('熟悉阶段，精灵理解了你的习惯');
      expect(result.factors).toContain('洞察记忆 5/50');
      expect(result.factors).toContain('用户画像 12');
      expect(result.factors).toContain('关系边 3');
    });

    it('close：insightCount ≥ 50 → factors 含 "洞察记忆 X" + "用户画像 X" + "关系边 X"', () => {
      vi.mocked(mockInspector.stats).mockReturnValue({
        total: 100,
        bySource: { profile: 15, insight: 60 },
        relationCount: 10,
      });
      vi.mocked(mockInspector.suggest).mockReturnValue([]);
      const controller = new MemoryController(mockAgent);
      const result = controller.rapportLevel();
      expect(result.level).toBe('close');
      expect(result.description).toBe('亲密阶段，精灵与你默契十足');
      expect(result.factors).toContain('洞察记忆 60');
      expect(result.factors).toContain('用户画像 15');
      expect(result.factors).toContain('关系边 10');
    });

    it('边界值：total=5 → acquaintance / profileCount=10 → familiar / insightCount=50 → close', () => {
      vi.mocked(mockInspector.suggest).mockReturnValue([]);
      const controller = new MemoryController(mockAgent);

      // 边界 1: total=5 正好不触发 stranger（< 5 才是 stranger）
      vi.mocked(mockInspector.stats).mockReturnValue({ total: 5, bySource: {}, relationCount: 0 });
      expect(controller.rapportLevel().level).toBe('acquaintance');

      // 边界 2: profileCount=10 正好不触发 acquaintance（< 10 才是 acquaintance）
      vi.mocked(mockInspector.stats).mockReturnValue({
        total: 5,
        bySource: { profile: 10 },
        relationCount: 0,
      });
      expect(controller.rapportLevel().level).toBe('familiar');

      // 边界 3: insightCount=50 正好不触发 familiar（< 50 才是 familiar）
      vi.mocked(mockInspector.stats).mockReturnValue({
        total: 5,
        bySource: { profile: 10, insight: 50 },
        relationCount: 0,
      });
      expect(controller.rapportLevel().level).toBe('close');
    });

    it('无 profile/insight source 时 bySource 降级为 0（?? 0 兜底）', () => {
      vi.mocked(mockInspector.stats).mockReturnValue({
        total: 10,
        bySource: { rule: 10 },
        relationCount: 0,
      });
      vi.mocked(mockInspector.suggest).mockReturnValue([]);
      const controller = new MemoryController(mockAgent);
      const result = controller.rapportLevel();
      // profile 缺失 → bySource['profile'] ?? 0 → 0 → < 10 → acquaintance
      expect(result.level).toBe('acquaintance');
      expect(result.factors).toContain('用户画像 0/10');
    });
  });

  // ─── 9. getRelationGraph 关系图谱（ADR-014，4 测试） ──

  describe('getRelationGraph', () => {
    it('正常返回 nodes + edges', () => {
      const memories = [makeMemory({ id: 'a:1' }), makeMemory({ id: 'a:2' })];
      const relations = [makeRelation({ sourceId: 'a:1', targetId: 'a:2' })];
      vi.mocked(mockInspector.list).mockReturnValue(memories);
      vi.mocked(mockInspector.getAllRelations).mockReturnValue(relations);
      const controller = new MemoryController(mockAgent);
      const result = controller.getRelationGraph();
      expect(result.nodes).toHaveLength(2);
      expect(result.nodes[0]!.id).toBe('a:1');
      expect(result.edges).toHaveLength(1);
      expect(result.edges[0]!.sourceId).toBe('a:1');
      expect(result.edges[0]!.targetId).toBe('a:2');
    });

    it('nodes 限制 200 节点（list 传 limit=RELATION_GRAPH_MAX_NODES）', () => {
      vi.mocked(mockInspector.list).mockReturnValue([]);
      vi.mocked(mockInspector.getAllRelations).mockReturnValue([]);
      const controller = new MemoryController(mockAgent);
      controller.getRelationGraph();
      // 验证 list 被调用时传入了 200（RELATION_GRAPH_MAX_NODES 常量）
      expect(mockInspector.list).toHaveBeenCalledWith(200);
    });

    it('inspector 为 null 时返回 { nodes: [], edges: [] }', () => {
      const controller = new MemoryController(createMockAgent(null));
      const result = controller.getRelationGraph();
      expect(result).toEqual({ nodes: [], edges: [] });
    });

    it('edges 从 getAllRelations() 获取（relationStore 未注入时返回空数组，向后兼容）', () => {
      vi.mocked(mockInspector.list).mockReturnValue([]);
      // 模拟 relationStore 未注入：getAllRelations 返回 []
      vi.mocked(mockInspector.getAllRelations).mockReturnValue([]);
      const controller = new MemoryController(mockAgent);
      const result = controller.getRelationGraph();
      expect(result.edges).toEqual([]);
      expect(mockInspector.getAllRelations).toHaveBeenCalled();
    });
  });
});
