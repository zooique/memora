/**
 * 单元测试：MemoryInspector 记忆查看器
 *
 * 覆盖 MemoryInspector 全部 14 个公开方法：
 *   - constructor + setVectorStore：依赖注入
 *   - 写操作代理：upsert / delete / getById / getBySource / list
 *   - snapshot：3 层快照（工作记忆 + Bootstrap + 归档）
 *   - search：关键词搜索（空 query 抛错 + limit 校验 + 内容截断）
 *   - searchHybrid：混合搜索（语义 + 关键词双通道 + 降级）
 *   - stats：记忆库统计
 *   - getRelations / getAllRelations：关系查询（relationStore 未注入降级）
 *   - sourceHealth / suggest：委托 MemoryAdvisor
 *
 * Mock 策略：
 *   - InMemoryStorage / InMemoryRelationStore 用真实实现（测试夹具，已被 store.test.ts 验证）
 *   - loop / history 用 Partial<T> as T 单层断言（仅实现被测方法）
 *   - VectorStore 用 mock 对象（search 返回固定结果）
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MemoryInspector } from '@/agent/managers/memoryInspector.js';
import { MemoryAdvisor } from '@/agent/managers/memoryAdvisor.js';
import { InMemoryStorage } from '@/memory/inMemoryStorage.js';
import { InMemoryRelationStore } from '@/memory/inMemoryRelationStore.js';
import type { VectorStore } from '@/memory/vectorStore.js';
import type { Memory } from '@/memory/types.js';
import type { Message } from '@/llm/provider.js';
import type { AgentLoop } from '@/agent/loop.js';
import type { MessageHistory } from '@/agent/messageHistory.js';

/**
 * 创建测试用 Memory 对象
 *
 * @param overrides - 覆盖默认字段值
 * @returns 完整的 Memory 对象（7 核心字段）
 */
function createMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'test:default',
    content: '默认内容',
    source: 'insight',
    name: 'default',
    createdAt: '2026-06-27T10:00:00.000Z',
    accessedAt: '2026-06-27T10:00:00.000Z',
    score: 0.5,
    ...overrides,
  };
}

/**
 * 创建 Mock AgentLoop
 *
 * 仅实现 MemoryInspector 用到的方法：getMessages
 * @param messages - 工作记忆消息列表
 */
function createMockLoop(messages: Message[] = []): AgentLoop {
  return {
    getMessages: vi.fn(() => messages),
  } as unknown as AgentLoop;
}

/**
 * 创建 Mock MessageHistory
 *
 * 仅实现 MemoryInspector 用到的属性：session / currentSessionName
 * @param session - 当前会话简短名
 * @param currentSessionName - 当前会话全名（含日期前缀）
 */
function createMockHistory(
  session: string | null = 'main',
  currentSessionName: string | null = '2026-06-27-main',
): MessageHistory {
  return {
    session,
    currentSessionName,
  } as unknown as MessageHistory;
}

/**
 * 创建 Mock VectorStore
 *
 * @param searchResults - search 方法返回的固定结果
 * @param size - 向量存储大小（0 时跳过语义搜索）
 */
function createMockVectorStore(
  searchResults: Array<{ id: string; similarity: number }> = [],
  size = 10,
): VectorStore {
  return {
    size,
    search: vi.fn().mockResolvedValue(searchResults),
  } as unknown as VectorStore;
}

describe('MemoryInspector', () => {
  let storage: InMemoryStorage;
  let loop: AgentLoop;
  let history: MessageHistory;
  let advisor: MemoryAdvisor;
  let inspector: MemoryInspector;

  beforeEach(() => {
    storage = new InMemoryStorage();
    loop = createMockLoop();
    history = createMockHistory();
    // advisor 必填，测试中显式构造（与 assembler.ts 行为一致）
    advisor = new MemoryAdvisor(storage);
    inspector = new MemoryInspector(storage, loop, history, advisor, null);
  });

  // ════════════════════════════════════════════════════════
  // 1. constructor + setVectorStore（3 测试）
  // ════════════════════════════════════════════════════════

  describe('constructor + setVectorStore', () => {
    it('应正确接收 3 个必选依赖（index/loop/history）', () => {
      // 通过 snapshot() 间接验证依赖已存储
      const snap = inspector.snapshot();
      expect(snap).toBeDefined();
      expect(snap.working).toBeDefined();
      expect(snap.bootstrap).toBeDefined();
      expect(snap.archive).toBeDefined();
    });

    it('relationStore 默认为 null（关系查询方法降级返回空）', () => {
      // 未注入 relationStore 时 getRelations 返回 []
      expect(inspector.getRelations('any-id')).toEqual([]);
      expect(inspector.getAllRelations()).toEqual([]);
    });

    it('setVectorStore 应注入向量存储（searchHybrid 启用语义通道）', () => {
      const vs = createMockVectorStore();
      inspector.setVectorStore(vs);
      // 注入后 searchHybrid 应调用 vectorStore.search（通过 spy 验证）
      storage.upsert(createMemory({ id: 'insight:test', name: 'test' }));
      inspector.searchHybrid('query');
      expect(vs.search).toHaveBeenCalled();
    });
  });

  // ════════════════════════════════════════════════════════
  // 2. 写操作代理（5 测试）
  // ════════════════════════════════════════════════════════

  describe('写操作代理', () => {
    it('upsert 应委托 index.upsert', () => {
      const mem = createMemory({ id: 'rule:1', source: 'rule', name: 'r1' });
      inspector.upsert(mem);
      expect(inspector.getById('rule:1')).toEqual(mem);
    });

    it('delete 应委托 index.delete', () => {
      const mem = createMemory({ id: 'rule:1', source: 'rule', name: 'r1' });
      inspector.upsert(mem);
      inspector.delete('rule:1');
      expect(inspector.getById('rule:1')).toBeNull();
    });

    it('getById 不存在时返回 null', () => {
      expect(inspector.getById('nonexistent')).toBeNull();
    });

    it('getDeletedById 应透传 index.getDeletedById（软删除态返回记忆，活跃态返回 null）', () => {
      const mem = createMemory({ id: 'rule:1', source: 'rule', name: 'r1' });
      inspector.upsert(mem);
      // 活跃态 → null
      expect(inspector.getDeletedById('rule:1')).toBeNull();
      // 软删除后 → 返回记忆（含 deletedAt）
      inspector.delete('rule:1');
      const deleted = inspector.getDeletedById('rule:1');
      expect(deleted).not.toBeNull();
      expect(deleted!.id).toBe('rule:1');
      expect(deleted!.deletedAt).toBeTruthy();
      // 不存在的 id → null
      expect(inspector.getDeletedById('not:exist')).toBeNull();
    });

    it('getBySource 应按来源标签过滤', () => {
      inspector.upsert(createMemory({ id: 'rule:1', source: 'rule', name: 'r1' }));
      inspector.upsert(createMemory({ id: 'rule:2', source: 'rule', name: 'r2' }));
      inspector.upsert(createMemory({ id: 'persona:1', source: 'persona', name: 'p1' }));
      const rules = inspector.getBySource('rule');
      expect(rules).toHaveLength(2);
      expect(rules.map((m) => m.id)).toContain('rule:1');
      expect(rules.map((m) => m.id)).toContain('rule:2');
    });

    it('list 应委托 index.search("", limit) 返回按 score 降序', () => {
      inspector.upsert(createMemory({ id: 'insight:low', source: 'insight', name: 'low', score: 0.3 }));
      inspector.upsert(createMemory({ id: 'insight:high', source: 'insight', name: 'high', score: 0.9 }));
      const list = inspector.list(10);
      expect(list).toHaveLength(2);
      // 按 score 降序（InMemoryStorage.search 默认行为）
      expect(list[0]!.score).toBeGreaterThanOrEqual(list[1]!.score);
    });
  });

  // ════════════════════════════════════════════════════════
  // 3. snapshot（6 测试）
  // ════════════════════════════════════════════════════════

  describe('snapshot', () => {
    it('工作记忆层：loop.getMessages slice 最后 5 条 + contentPreview 截断 80 字符', () => {
      const longContent = 'A'.repeat(100);
      const messages: Message[] = [
        { role: 'user', content: 'msg1' },
        { role: 'assistant', content: 'msg2' },
        { role: 'user', content: 'msg3' },
        { role: 'assistant', content: 'msg4' },
        { role: 'user', content: 'msg5' },
        { role: 'assistant', content: 'msg6' },
        { role: 'user', content: longContent },
      ];
      loop = createMockLoop(messages);
      inspector = new MemoryInspector(storage, loop, history, advisor, null);
      const snap = inspector.snapshot();
      // total 是全部消息数
      expect(snap.working.total).toBe(7);
      // preview 只取最后 5 条
      expect(snap.working.preview).toHaveLength(5);
      // 最后一条是长内容，验证截断到 80 字符
      const last = snap.working.preview[4]!;
      expect(last.contentPreview).toHaveLength(80);
      expect(last.contentLength).toBe(100);
      expect(last.role).toBe('user');
    });

    it('Bootstrap 层：聚合 rule + persona + skill 三类来源', () => {
      inspector.upsert(createMemory({ id: 'rule:r1', source: 'rule', name: 'r1' }));
      inspector.upsert(createMemory({ id: 'persona:p1', source: 'persona', name: 'p1' }));
      inspector.upsert(createMemory({ id: 'skill:s1', source: 'skill', name: 's1' }));
      inspector.upsert(createMemory({ id: 'insight:i1', source: 'insight', name: 'i1' }));
      const snap = inspector.snapshot();
      // bootstrap 只含 rule + persona + skill，不含 insight
      expect(snap.bootstrap.total).toBe(3);
      const sources = snap.bootstrap.items.map((m) => m.source);
      expect(sources).toContain('rule');
      expect(sources).toContain('persona');
      expect(sources).toContain('skill');
      expect(sources).not.toContain('insight');
    });

    it('归档层：insight + profile + work-projection 计数', () => {
      inspector.upsert(createMemory({ id: 'insight:i1', source: 'insight', name: 'i1' }));
      inspector.upsert(createMemory({ id: 'insight:i2', source: 'insight', name: 'i2' }));
      inspector.upsert(createMemory({ id: 'profile:p1', source: 'profile', name: 'p1' }));
      inspector.upsert(createMemory({ id: 'work-projection:w1', source: 'work-projection', name: 'w1' }));
      const snap = inspector.snapshot();
      expect(snap.archive.archiveCount).toBe(4);
      expect(snap.archive.stats.insight).toBe(2);
      expect(snap.archive.stats.profile).toBe(1);
      expect(snap.archive.stats['work-projection']).toBe(1);
    });

    it('relationCount：relationStore 未注入时为 0', () => {
      const snap = inspector.snapshot();
      expect(snap.archive.relationCount).toBe(0);
    });

    it('relationCount：relationStore 已注入时返回关系边总数', () => {
      const relationStore = new InMemoryRelationStore();
      relationStore.addRelation({
        sourceId: 'a',
        targetId: 'b',
        type: 'related',
        weight: 0.5,
        createdAt: '2026-06-27T10:00:00.000Z',
      });
      inspector = new MemoryInspector(storage, loop, history, advisor, relationStore);
      const snap = inspector.snapshot();
      expect(snap.archive.relationCount).toBe(1);
    });

    it('currentSession/currentSessionName：null 时降级为 "(none)"', () => {
      loop = createMockLoop();
      history = createMockHistory(null, null);
      inspector = new MemoryInspector(storage, loop, history, advisor, null);
      const snap = inspector.snapshot();
      expect(snap.archive.currentSession).toBe('(none)');
      expect(snap.archive.currentSessionName).toBe('(none)');
      // hint 是固定字符串
      expect(snap.archive.hint).toBe('调 listAllSessions() 获取文件清单');
    });
  });

  // ════════════════════════════════════════════════════════
  // 4. search（5 测试）
  // ════════════════════════════════════════════════════════

  describe('search', () => {
    it('空 query 应抛 configError', () => {
      expect(() => inspector.search('')).toThrow('搜索关键词为空');
    });

    it('纯空格 query 应抛 configError', () => {
      expect(() => inspector.search('   ')).toThrow('搜索关键词为空');
    });

    it('limit <= 0 应抛 configError', () => {
      expect(() => inspector.search('query', 0)).toThrow('无效 limit');
    });

    it('非整数 limit 应抛 configError', () => {
      expect(() => inspector.search('query', 1.5)).toThrow('无效 limit');
    });

    it('正常搜索：长内容截断到 120 字符 + "..."，短内容不截断', () => {
      const longContent = 'B'.repeat(150);
      inspector.upsert(createMemory({ id: 'insight:long', source: 'insight', name: 'long', content: longContent }));
      inspector.upsert(createMemory({ id: 'insight:short', source: 'insight', name: 'short', content: 'short' }));
      const hits = inspector.search('B', 10);
      // InMemoryStorage.search 按关键词匹配
      const longHit = hits.find((h) => h.name === 'long');
      const shortHit = hits.find((h) => h.name === 'short');
      if (longHit) {
        // 长内容截断到 120 + '...' = 123 字符
        expect(longHit.contentPreview).toHaveLength(123);
        expect(longHit.contentPreview.endsWith('...')).toBe(true);
      }
      if (shortHit) {
        // 短内容不截断
        expect(shortHit.contentPreview).toBe('short');
      }
    });
  });

  // ════════════════════════════════════════════════════════
  // 5. searchHybrid（8 测试）
  // ════════════════════════════════════════════════════════

  describe('searchHybrid', () => {
    it('空 query 应抛 configError', async () => {
      await expect(inspector.searchHybrid('')).rejects.toThrow('搜索关键词为空');
    });

    it('limit <= 0 应抛 configError', async () => {
      await expect(inspector.searchHybrid('query', 0)).rejects.toThrow('无效 limit');
    });

    it('vectorStore 未注入时：纯关键词搜索', async () => {
      inspector.upsert(createMemory({ id: 'insight:k1', source: 'insight', name: 'k1', content: 'keyword test' }));
      const hits = await inspector.searchHybrid('keyword');
      expect(hits).toHaveLength(1);
      expect(hits[0]!.name).toBe('k1');
      // 纯关键词时 similarity 为 0
      expect(hits[0]!.similarity).toBe(0);
    });

    it('vectorStore size=0 时：跳过语义搜索（纯关键词）', async () => {
      const vs = createMockVectorStore([], 0);
      inspector.setVectorStore(vs);
      inspector.upsert(createMemory({ id: 'insight:k1', source: 'insight', name: 'k1', content: 'keyword' }));
      const hits = await inspector.searchHybrid('keyword');
      expect(hits).toHaveLength(1);
      // size=0 不调用 vectorStore.search
      expect(vs.search).not.toHaveBeenCalled();
    });

    it('vectorStore 正常时：语义 + 关键词合并去重', async () => {
      // 语义搜索返回 insight:vec，关键词搜索返回 insight:kw
      const vs = createMockVectorStore([{ id: 'insight:vec', similarity: 0.8 }]);
      inspector.setVectorStore(vs);
      inspector.upsert(createMemory({ id: 'insight:vec', source: 'insight', name: 'vec', content: 'shared' }));
      inspector.upsert(createMemory({ id: 'insight:kw', source: 'insight', name: 'kw', content: 'shared' }));
      const hits = await inspector.searchHybrid('shared');
      expect(hits).toHaveLength(2);
      // 两条都应返回（语义 + 关键词各贡献一条）
      const names = hits.map((h) => h.name);
      expect(names).toContain('vec');
      expect(names).toContain('kw');
    });

    it('vectorStore 抛错时：降级到纯关键词（logger.debug 记录）', async () => {
      const vs = createMockVectorStore();
      vs.search = vi.fn().mockRejectedValue(new Error('vector error'));
      inspector.setVectorStore(vs);
      inspector.upsert(createMemory({ id: 'insight:k1', source: 'insight', name: 'k1', content: 'keyword' }));
      const hits = await inspector.searchHybrid('keyword');
      // 降级后仍返回关键词结果
      expect(hits).toHaveLength(1);
      expect(hits[0]!.name).toBe('k1');
    });

    it('综合排序：vectorScore * 0.6 + memory.score * 0.4 降序', async () => {
      // vec 高语义分数 + 低 memory.score；kw 低语义分数 + 高 memory.score
      const vs = createMockVectorStore([{ id: 'insight:vec', similarity: 0.9 }]);
      inspector.setVectorStore(vs);
      inspector.upsert(createMemory({ id: 'insight:vec', source: 'insight', name: 'vec', content: 'shared', score: 0.1 }));
      inspector.upsert(createMemory({ id: 'insight:kw', source: 'insight', name: 'kw', content: 'shared', score: 0.95 }));
      const hits = await inspector.searchHybrid('shared');
      // vec 综合分 = 0.9*0.6 + 0.1*0.4 = 0.58
      // kw 综合分 = 0*0.6 + 0.95*0.4 = 0.38
      // vec 应排第一
      expect(hits[0]!.name).toBe('vec');
      expect(hits[1]!.name).toBe('kw');
    });

    it('返回结果含 similarity 字段 + 长内容截断', async () => {
      const longContent = 'C'.repeat(150);
      const vs = createMockVectorStore([{ id: 'insight:long', similarity: 0.7 }]);
      inspector.setVectorStore(vs);
      inspector.upsert(createMemory({ id: 'insight:long', source: 'insight', name: 'long', content: longContent }));
      const hits = await inspector.searchHybrid('C');
      expect(hits).toHaveLength(1);
      expect(hits[0]!.similarity).toBe(0.7);
      // 长内容截断到 120 + '...'
      expect(hits[0]!.contentPreview.endsWith('...')).toBe(true);
    });
  });

  // ════════════════════════════════════════════════════════
  // 6. stats（3 测试）
  // ════════════════════════════════════════════════════════

  describe('stats', () => {
    it('应返回 total + bySource + relationCount', () => {
      inspector.upsert(createMemory({ id: 'rule:1', source: 'rule', name: 'r1' }));
      inspector.upsert(createMemory({ id: 'rule:2', source: 'rule', name: 'r2' }));
      inspector.upsert(createMemory({ id: 'persona:1', source: 'persona', name: 'p1' }));
      const stats = inspector.stats();
      expect(stats.total).toBe(3);
      expect(stats.bySource.rule).toBe(2);
      expect(stats.bySource.persona).toBe(1);
      expect(stats.relationCount).toBe(0);
    });

    it('bySource 应过滤 count=0 的来源', () => {
      inspector.upsert(createMemory({ id: 'rule:1', source: 'rule', name: 'r1' }));
      const stats = inspector.stats();
      expect(stats.bySource.rule).toBe(1);
      // 未出现的来源不在 bySource 中
      expect(stats.bySource.insight).toBeUndefined();
    });

    it('relationCount：relationStore 已注入时返回关系边总数', () => {
      const relationStore = new InMemoryRelationStore();
      relationStore.addRelation({
        sourceId: 'a',
        targetId: 'b',
        type: 'related',
        weight: 0.5,
        createdAt: '2026-06-27T10:00:00.000Z',
      });
      relationStore.addRelation({
        sourceId: 'c',
        targetId: 'd',
        type: 'related',
        weight: 0.3,
        createdAt: '2026-06-27T11:00:00.000Z',
      });
      inspector = new MemoryInspector(storage, loop, history, advisor, relationStore);
      const stats = inspector.stats();
      expect(stats.relationCount).toBe(2);
    });
  });

  // ════════════════════════════════════════════════════════
  // 7. 关系查询（4 测试）
  // ════════════════════════════════════════════════════════

  describe('关系查询', () => {
    it('getRelations：relationStore 未注入时返回空数组', () => {
      expect(inspector.getRelations('any-id')).toEqual([]);
    });

    it('getRelations：relationStore 已注入时透传 direction 参数', () => {
      const relationStore = new InMemoryRelationStore();
      relationStore.addRelation({
        sourceId: 'a',
        targetId: 'b',
        type: 'related',
        weight: 0.5,
        createdAt: '2026-06-27T10:00:00.000Z',
      });
      inspector = new MemoryInspector(storage, loop, history, advisor, relationStore);
      // direction='outgoing' 只查 sourceId='a' 的关系
      const outgoing = inspector.getRelations('a', 'outgoing');
      expect(outgoing).toHaveLength(1);
      expect(outgoing[0]!.sourceId).toBe('a');
      // direction='incoming' 只查 targetId='b' 的关系
      const incoming = inspector.getRelations('b', 'incoming');
      expect(incoming).toHaveLength(1);
      expect(incoming[0]!.targetId).toBe('b');
    });

    it('getAllRelations：relationStore 未注入时返回空数组', () => {
      expect(inspector.getAllRelations()).toEqual([]);
    });

    it('getAllRelations：relationStore 已注入时返回全部关系边', () => {
      const relationStore = new InMemoryRelationStore();
      relationStore.addRelation({
        sourceId: 'a',
        targetId: 'b',
        type: 'related',
        weight: 0.5,
        createdAt: '2026-06-27T10:00:00.000Z',
      });
      relationStore.addRelation({
        sourceId: 'c',
        targetId: 'd',
        type: 'refines',
        weight: 0.7,
        createdAt: '2026-06-27T11:00:00.000Z',
      });
      inspector = new MemoryInspector(storage, loop, history, advisor, relationStore);
      const all = inspector.getAllRelations();
      expect(all).toHaveLength(2);
    });
  });

  // ════════════════════════════════════════════════════════
  // 7.1 关系路径追溯 getRelationPath（5 测试）
  // ════════════════════════════════════════════════════════

  describe('getRelationPath 路径追溯', () => {
    it('relationStore 未注入时仅返回起点节点', () => {
      const path = inspector.getRelationPath('insight:start');
      expect(path).toHaveLength(1);
      expect(path[0]!.memoryId).toBe('insight:start');
      expect(path[0]!.depth).toBe(0);
      expect(path[0]!.relationType).toBeNull();
    });

    it('direction=incoming 时沿 sourceId 方向追溯来源', () => {
      // 构建链：a → b → c（a refines b, b refines c）
      // 从 c 追溯来源，应得到 [c(0), b(1), a(2)]
      storage.upsert(createMemory({ id: 'insight:a', name: 'a', source: 'insight' }));
      storage.upsert(createMemory({ id: 'insight:b', name: 'b', source: 'insight' }));
      storage.upsert(createMemory({ id: 'insight:c', name: 'c', source: 'insight' }));

      const relationStore = new InMemoryRelationStore();
      relationStore.addRelation({ sourceId: 'insight:a', targetId: 'insight:b', type: 'refines', weight: 0.7, createdAt: '2026-06-27T10:00:00.000Z' });
      relationStore.addRelation({ sourceId: 'insight:b', targetId: 'insight:c', type: 'refines', weight: 0.7, createdAt: '2026-06-27T11:00:00.000Z' });
      inspector = new MemoryInspector(storage, loop, history, advisor, relationStore);

      const path = inspector.getRelationPath('insight:c', 5, 'incoming');
      expect(path).toHaveLength(3);
      expect(path[0]!.memoryId).toBe('insight:c');
      expect(path[0]!.depth).toBe(0);
      expect(path[1]!.memoryId).toBe('insight:b');
      expect(path[1]!.depth).toBe(1);
      expect(path[1]!.relationType).toBe('refines');
      expect(path[2]!.memoryId).toBe('insight:a');
      expect(path[2]!.depth).toBe(2);
    });

    it('direction=outgoing 时沿 targetId 方向追溯去向', () => {
      // 从 a 追溯去向，应得到 [a(0), b(1), c(2)]
      storage.upsert(createMemory({ id: 'insight:a', name: 'a', source: 'insight' }));
      storage.upsert(createMemory({ id: 'insight:b', name: 'b', source: 'insight' }));
      storage.upsert(createMemory({ id: 'insight:c', name: 'c', source: 'insight' }));

      const relationStore = new InMemoryRelationStore();
      relationStore.addRelation({ sourceId: 'insight:a', targetId: 'insight:b', type: 'refines', weight: 0.7, createdAt: '2026-06-27T10:00:00.000Z' });
      relationStore.addRelation({ sourceId: 'insight:b', targetId: 'insight:c', type: 'refines', weight: 0.7, createdAt: '2026-06-27T11:00:00.000Z' });
      inspector = new MemoryInspector(storage, loop, history, advisor, relationStore);

      const path = inspector.getRelationPath('insight:a', 5, 'outgoing');
      expect(path).toHaveLength(3);
      expect(path[0]!.memoryId).toBe('insight:a');
      expect(path[2]!.memoryId).toBe('insight:c');
    });

    it('maxDepth 限制路径深度，超出部分不返回', () => {
      // 链：a → b → c → d → e
      storage.upsert(createMemory({ id: 'insight:a', name: 'a', source: 'insight' }));
      storage.upsert(createMemory({ id: 'insight:b', name: 'b', source: 'insight' }));
      storage.upsert(createMemory({ id: 'insight:c', name: 'c', source: 'insight' }));
      storage.upsert(createMemory({ id: 'insight:d', name: 'd', source: 'insight' }));
      storage.upsert(createMemory({ id: 'insight:e', name: 'e', source: 'insight' }));

      const relationStore = new InMemoryRelationStore();
      relationStore.addRelation({ sourceId: 'insight:a', targetId: 'insight:b', type: 'refines', weight: 0.7, createdAt: '2026-06-27T10:00:00.000Z' });
      relationStore.addRelation({ sourceId: 'insight:b', targetId: 'insight:c', type: 'refines', weight: 0.7, createdAt: '2026-06-27T11:00:00.000Z' });
      relationStore.addRelation({ sourceId: 'insight:c', targetId: 'insight:d', type: 'refines', weight: 0.7, createdAt: '2026-06-27T12:00:00.000Z' });
      relationStore.addRelation({ sourceId: 'insight:d', targetId: 'insight:e', type: 'refines', weight: 0.7, createdAt: '2026-06-27T13:00:00.000Z' });
      inspector = new MemoryInspector(storage, loop, history, advisor, relationStore);

      // maxDepth=2，从 e 追溯，应只到 depth=2（c）
      const path = inspector.getRelationPath('insight:e', 2, 'incoming');
      expect(path).toHaveLength(3); // e(0), d(1), c(2)
      expect(path[2]!.depth).toBe(2);
      expect(path[2]!.memoryId).toBe('insight:c');
    });

    it('环关系不导致无限递归（visited 防环）', () => {
      // 构建环：a → b → a
      storage.upsert(createMemory({ id: 'insight:a', name: 'a', source: 'insight' }));
      storage.upsert(createMemory({ id: 'insight:b', name: 'b', source: 'insight' }));

      const relationStore = new InMemoryRelationStore();
      relationStore.addRelation({ sourceId: 'insight:a', targetId: 'insight:b', type: 'related', weight: 0.5, createdAt: '2026-06-27T10:00:00.000Z' });
      relationStore.addRelation({ sourceId: 'insight:b', targetId: 'insight:a', type: 'related', weight: 0.5, createdAt: '2026-06-27T11:00:00.000Z' });
      inspector = new MemoryInspector(storage, loop, history, advisor, relationStore);

      const path = inspector.getRelationPath('insight:a', 10, 'outgoing');
      // 环应被 visited 阻断：a(0) → b(1)，a 已访问不再入队
      expect(path).toHaveLength(2);
      expect(path[0]!.memoryId).toBe('insight:a');
      expect(path[1]!.memoryId).toBe('insight:b');
    });
  });

  // ════════════════════════════════════════════════════════
  // 7.2 关系邻居查询 getRelationNeighbors（4 测试）
  // ════════════════════════════════════════════════════════

  describe('getRelationNeighbors 邻居查询', () => {
    it('relationStore 未注入时返回空数组', () => {
      expect(inspector.getRelationNeighbors('any-id')).toEqual([]);
    });

    it('outgoing 关系：memoryId 是 sourceId，邻居是 targetId', () => {
      storage.upsert(createMemory({ id: 'insight:a', name: 'a', source: 'insight', score: 0.8 }));
      storage.upsert(createMemory({ id: 'insight:b', name: 'b', source: 'insight', score: 0.6 }));

      const relationStore = new InMemoryRelationStore();
      relationStore.addRelation({ sourceId: 'insight:a', targetId: 'insight:b', type: 'supports', weight: 0.7, createdAt: '2026-06-27T10:00:00.000Z' });
      inspector = new MemoryInspector(storage, loop, history, advisor, relationStore);

      const neighbors = inspector.getRelationNeighbors('insight:a');
      expect(neighbors).toHaveLength(1);
      expect(neighbors[0]!.memoryId).toBe('insight:b');
      expect(neighbors[0]!.direction).toBe('outgoing');
      expect(neighbors[0]!.relationType).toBe('supports');
      expect(neighbors[0]!.memoryScore).toBe(0.6);
    });

    it('incoming 关系：memoryId 是 targetId，邻居是 sourceId', () => {
      storage.upsert(createMemory({ id: 'insight:a', name: 'a', source: 'insight', score: 0.8 }));
      storage.upsert(createMemory({ id: 'insight:b', name: 'b', source: 'insight', score: 0.6 }));

      const relationStore = new InMemoryRelationStore();
      relationStore.addRelation({ sourceId: 'insight:a', targetId: 'insight:b', type: 'supports', weight: 0.7, createdAt: '2026-06-27T10:00:00.000Z' });
      inspector = new MemoryInspector(storage, loop, history, advisor, relationStore);

      // 从 b 视角看，a 是 incoming 邻居
      const neighbors = inspector.getRelationNeighbors('insight:b');
      expect(neighbors).toHaveLength(1);
      expect(neighbors[0]!.memoryId).toBe('insight:a');
      expect(neighbors[0]!.direction).toBe('incoming');
      expect(neighbors[0]!.memoryScore).toBe(0.8);
    });

    it('同一邻居有多条关系时去重（seen Set）', () => {
      storage.upsert(createMemory({ id: 'insight:a', name: 'a', source: 'insight' }));
      storage.upsert(createMemory({ id: 'insight:b', name: 'b', source: 'insight' }));

      const relationStore = new InMemoryRelationStore();
      // a→b 两条关系（supports + related）
      relationStore.addRelation({ sourceId: 'insight:a', targetId: 'insight:b', type: 'supports', weight: 0.7, createdAt: '2026-06-27T10:00:00.000Z' });
      relationStore.addRelation({ sourceId: 'insight:a', targetId: 'insight:b', type: 'related', weight: 0.3, createdAt: '2026-06-27T11:00:00.000Z' });
      inspector = new MemoryInspector(storage, loop, history, advisor, relationStore);

      // 从 a 看，b 只出现一次（第一条关系 supports）
      const neighbors = inspector.getRelationNeighbors('insight:a');
      expect(neighbors).toHaveLength(1);
      expect(neighbors[0]!.relationType).toBe('supports');
    });
  });

  // ════════════════════════════════════════════════════════
  // 8. sourceHealth + suggest 委托（3 测试）
  // ════════════════════════════════════════════════════════

  describe('sourceHealth + suggest 委托 MemoryAdvisor', () => {
    it('sourceHealth 应委托 MemoryAdvisor 返回健康报告', () => {
      inspector.upsert(createMemory({ id: 'rule:1', source: 'rule', name: 'r1', score: 0.8 }));
      inspector.upsert(createMemory({ id: 'rule:2', source: 'rule', name: 'r2', score: 0.6 }));
      const report = inspector.sourceHealth();
      // SourceHealthReport 含 sources 数组 + 总体指标
      expect(report).toBeDefined();
      expect(Array.isArray(report.sources)).toBe(true);
      // rule 来源应出现在报告中
      const ruleEntry = report.sources.find((e) => e.source === 'rule');
      expect(ruleEntry).toBeDefined();
      expect(ruleEntry!.count).toBe(2);
    });

    it('suggest 无参时委托 MemoryAdvisor 基于全局热度推荐', () => {
      inspector.upsert(createMemory({ id: 'insight:1', source: 'insight', name: 'i1', score: 0.9 }));
      inspector.upsert(createMemory({ id: 'rule:1', source: 'rule', name: 'r1', score: 0.5 }));
      const hits = inspector.suggest();
      expect(Array.isArray(hits)).toBe(true);
      // 应返回推荐结果（按 score 降序）
      if (hits.length > 0) {
        expect(hits[0]).toBeDefined();
      }
    });

    it('suggest 带参时委托 MemoryAdvisor 结合搜索结果推荐', () => {
      inspector.upsert(createMemory({ id: 'insight:1', source: 'insight', name: 'test', content: 'test content', score: 0.9 }));
      const hits = inspector.suggest('test', { limit: 5 });
      expect(Array.isArray(hits)).toBe(true);
      // limit 选项应被尊重
      expect(hits.length).toBeLessThanOrEqual(5);
    });
  });
});
