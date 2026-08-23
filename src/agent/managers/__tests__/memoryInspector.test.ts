/**
 * 单元测试：MemoryInspector 记忆管理器（读写统一入口）
 *
 * MemoryInspector 负责记忆的查询 + 写入操作，写方法以 writeXxx 前缀命名。
 * 本测试覆盖 MemoryInspector 全部公开方法：
 *   - constructor + setVectorStore：依赖注入
 *   - 只读查询：getById / getDeletedById / listDeleted / getBySource / list
 *   - snapshot：3 层快照（工作记忆 + Bootstrap + 归档）
 *   - search：关键词搜索（空 query 抛错 + limit 校验 + 内容截断）
 *   - searchHybrid：混合搜索（语义 + 关键词双通道 + 降级）
 *   - stats：记忆库统计
 *   - 写操作：writeUpsert / writeDelete / writeRestore / writePurge / writePurgeExpired
 *
 * sourceHealth / suggest 由 Agent 门面直连 MemoryAdvisor（与 detectConflicts 同模式），
 * 相关测试见 memoryAdvisor.test.ts + agent.test.ts。本测试不再 import MemoryAdvisor。
 *
 * Mock 策略：
 *   - InMemoryStorage 用真实实现（测试夹具，已被 store.test.ts 验证）
 *   - loop / history 用 Partial<T> as T 单层断言（仅实现被测方法）
 *   - VectorStore 用 mock 对象（search 返回固定结果）
 *   - 写操作测试通过 writeXxx 写入后用只读方法读取验证（读写同源）
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MemoryInspector } from '@/agent/managers/memoryInspector.js';
import { InMemoryStorage } from '@/memory/inMemoryStorage.js';
import type { IVectorStore } from '@/memory/vectorStore.js';
import type { Memory } from '@/memory/types.js';
import type { Message } from '@/llm/provider.js';
import type { AgentLoop } from '@/agent/loop.js';
import type { MessageHistory } from '@/agent/messageHistory.js';
import { nowIso } from '@/utils/time.js';

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
    source: 'content',
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
): IVectorStore {
  return {
    size,
    search: vi.fn().mockResolvedValue(searchResults),
  } as unknown as IVectorStore;
}

describe('MemoryInspector', () => {
  let storage: InMemoryStorage;
  let loop: AgentLoop;
  let history: MessageHistory;
  let inspector: MemoryInspector;

  beforeEach(() => {
    storage = new InMemoryStorage();
    loop = createMockLoop();
    history = createMockHistory();
    // inspector 不持有 advisor；sourceHealth/suggest 由 Agent 门面直连 advisor（见 memoryAdvisor.test.ts）
    inspector = new MemoryInspector(storage, loop, history);
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

    it('setVectorStore 应注入向量存储（searchHybrid 启用语义通道）', () => {
      const vs = createMockVectorStore();
      inspector.setVectorStore(vs);
      // 注入后 searchHybrid 应调用 vectorStore.search（通过 spy 验证）
      storage.upsert(createMemory({ id: 'content:test', name: 'test' }));
      inspector.searchHybrid('query');
      expect(vs.search).toHaveBeenCalled();
    });
  });

  // ════════════════════════════════════════════════════════
  // 2. 只读查询（6 测试）
  // 通过 storage 直接写入测试夹具，验证只读方法正确性
  // ════════════════════════════════════════════════════════

  describe('只读查询', () => {
    it('getById 存在时返回记忆，不存在时返回 null', () => {
      const mem = createMemory({ id: 'rule:1', source: 'rule', name: 'r1' });
      storage.upsert(mem);
      expect(inspector.getById('rule:1')).toEqual(mem);
      expect(inspector.getById('nonexistent')).toBeNull();
    });

    it('getDeletedById 应透传 index.getDeletedById（软删除态返回记忆，活跃态返回 null）', () => {
      const mem = createMemory({ id: 'rule:1', source: 'rule', name: 'r1' });
      storage.upsert(mem);
      // 活跃态 → null
      expect(inspector.getDeletedById('rule:1')).toBeNull();
      // 软删除后 → 返回记忆（含 deletedAt）
      storage.delete('rule:1');
      const deleted = inspector.getDeletedById('rule:1');
      expect(deleted).not.toBeNull();
      expect(deleted!.id).toBe('rule:1');
      expect(deleted!.deletedAt).toBeTruthy();
      // 不存在的 id → null
      expect(inspector.getDeletedById('not:exist')).toBeNull();
    });

    it('listDeleted 应返回软删除记忆列表', () => {
      storage.upsert(createMemory({ id: 'rule:1', source: 'rule', name: 'r1' }));
      storage.upsert(createMemory({ id: 'rule:2', source: 'rule', name: 'r2' }));
      storage.delete('rule:1');
      const deleted = inspector.listDeleted(10);
      expect(deleted).toHaveLength(1);
      expect(deleted[0]!.id).toBe('rule:1');
    });

    it('getBySource 应按来源标签过滤', () => {
      storage.upsert(createMemory({ id: 'rule:1', source: 'rule', name: 'r1' }));
      storage.upsert(createMemory({ id: 'rule:2', source: 'rule', name: 'r2' }));
      storage.upsert(createMemory({ id: 'persona:1', source: 'persona', name: 'p1' }));
      const rules = inspector.getBySource('rule');
      expect(rules).toHaveLength(2);
      expect(rules.map((m) => m.id)).toContain('rule:1');
      expect(rules.map((m) => m.id)).toContain('rule:2');
    });

    it('list 应委托 index.search("", limit) 返回按 score 降序', () => {
      storage.upsert(createMemory({ id: 'content:low', source: 'content', name: 'low', score: 0.3 }));
      storage.upsert(createMemory({ id: 'content:high', source: 'content', name: 'high', score: 0.9 }));
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
      inspector = new MemoryInspector(storage, loop, history);
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

    it('Bootstrap 层：已空实现（设定记忆归角色包，索引不再新增）', () => {
      storage.upsert(createMemory({ id: 'rule:r1', source: 'rule', name: 'r1' }));
      storage.upsert(createMemory({ id: 'persona:p1', source: 'persona', name: 'p1' }));
      storage.upsert(createMemory({ id: 'skill:s1', source: 'skill', name: 's1' }));
      const snap = inspector.snapshot();
      // Bootstrap 已空实现，设定记忆全走角色包路径
      expect(snap.bootstrap.total).toBe(0);
      expect(snap.bootstrap.items).toHaveLength(0);
    });

    it('归档层：round-summary 计数（作品投影已移出记忆库）', () => {
      storage.upsert(createMemory({ id: 'round-summary:s1:r1', source: 'round-summary', name: 'rs1' }));
      storage.upsert(createMemory({ id: 'round-summary:s1:r2', source: 'round-summary', name: 'rs2' }));
      const snap = inspector.snapshot();
      expect(snap.archive.archiveCount).toBe(2);
      expect(snap.archive.stats['round-summary']).toBe(2);
    });

    it('currentSession/currentSessionName：null 时降级为 "(none)"', () => {
      loop = createMockLoop();
      history = createMockHistory(null, null);
      inspector = new MemoryInspector(storage, loop, history);
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

    it('正常搜索：长内容截断到 120 字符 + "…"，短内容不截断', () => {
      const longContent = 'B'.repeat(150);
      storage.upsert(createMemory({ id: 'content:long', source: 'content', name: 'long', content: longContent }));
      storage.upsert(createMemory({ id: 'content:short', source: 'content', name: 'short', content: 'short' }));
      const hits = inspector.search('B', 10);
      // InMemoryStorage.search 按关键词匹配
      const longHit = hits.find((h) => h.name === 'long');
      const shortHit = hits.find((h) => h.name === 'short');
      if (longHit) {
        // 长内容截断到 120 + '…' = 121 字符
        expect(longHit.contentPreview).toHaveLength(121);
        expect(longHit.contentPreview.endsWith('…')).toBe(true);
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
      storage.upsert(createMemory({ id: 'content:k1', source: 'content', name: 'k1', content: 'keyword test' }));
      const hits = await inspector.searchHybrid('keyword');
      expect(hits).toHaveLength(1);
      expect(hits[0]!.name).toBe('k1');
      // 纯关键词时 similarity 为 0
      expect(hits[0]!.similarity).toBe(0);
    });

    it('vectorStore size=0 时：跳过语义搜索（纯关键词）', async () => {
      const vs = createMockVectorStore([], 0);
      inspector.setVectorStore(vs);
      storage.upsert(createMemory({ id: 'content:k1', source: 'content', name: 'k1', content: 'keyword' }));
      const hits = await inspector.searchHybrid('keyword');
      expect(hits).toHaveLength(1);
      // size=0 不调用 vectorStore.search
      expect(vs.search).not.toHaveBeenCalled();
    });

    it('vectorStore 正常时：语义 + 关键词合并去重', async () => {
      // 语义搜索返回 content:vec，关键词搜索返回 content:kw
      const vs = createMockVectorStore([{ id: 'content:vec', similarity: 0.8 }]);
      inspector.setVectorStore(vs);
      storage.upsert(createMemory({ id: 'content:vec', source: 'content', name: 'vec', content: 'shared' }));
      storage.upsert(createMemory({ id: 'content:kw', source: 'content', name: 'kw', content: 'shared' }));
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
      storage.upsert(createMemory({ id: 'content:k1', source: 'content', name: 'k1', content: 'keyword' }));
      const hits = await inspector.searchHybrid('keyword');
      // 降级后仍返回关键词结果
      expect(hits).toHaveLength(1);
      expect(hits[0]!.name).toBe('k1');
    });

    it('综合排序：vectorScore * 0.6 + memory.score * 0.4 降序', async () => {
      // vec 高语义分数 + 低 memory.score；kw 低语义分数 + 高 memory.score
      const vs = createMockVectorStore([{ id: 'content:vec', similarity: 0.9 }]);
      inspector.setVectorStore(vs);
      storage.upsert(createMemory({ id: 'content:vec', source: 'content', name: 'vec', content: 'shared', score: 0.1 }));
      storage.upsert(createMemory({ id: 'content:kw', source: 'content', name: 'kw', content: 'shared', score: 0.95 }));
      const hits = await inspector.searchHybrid('shared');
      // vec 综合分 = 0.9*0.6 + 0.1*0.4 = 0.58
      // kw 综合分 = 0*0.6 + 0.95*0.4 = 0.38
      // vec 应排第一
      expect(hits[0]!.name).toBe('vec');
      expect(hits[1]!.name).toBe('kw');
    });

    it('返回结果含 similarity 字段 + 长内容截断', async () => {
      const longContent = 'C'.repeat(150);
      const vs = createMockVectorStore([{ id: 'content:long', similarity: 0.7 }]);
      inspector.setVectorStore(vs);
      storage.upsert(createMemory({ id: 'content:long', source: 'content', name: 'long', content: longContent }));
      const hits = await inspector.searchHybrid('C');
      expect(hits).toHaveLength(1);
      expect(hits[0]!.similarity).toBe(0.7);
      // 长内容截断到 120 + '…'
      expect(hits[0]!.contentPreview.endsWith('…')).toBe(true);
    });
  });

  // ════════════════════════════════════════════════════════
  // 6. stats（3 测试）
  // ════════════════════════════════════════════════════════

  describe('stats', () => {
    it('应返回 total + bySource', () => {
      storage.upsert(createMemory({ id: 'rule:1', source: 'rule', name: 'r1' }));
      storage.upsert(createMemory({ id: 'rule:2', source: 'rule', name: 'r2' }));
      storage.upsert(createMemory({ id: 'persona:1', source: 'persona', name: 'p1' }));
      const stats = inspector.stats();
      expect(stats.total).toBe(3);
      expect(stats.bySource.rule).toBe(2);
      expect(stats.bySource.persona).toBe(1);
    });

    it('bySource 应过滤 count=0 的来源', () => {
      storage.upsert(createMemory({ id: 'rule:1', source: 'rule', name: 'r1' }));
      const stats = inspector.stats();
      expect(stats.bySource.rule).toBe(1);
      // 未出现的来源不在 bySource 中
      expect(stats.bySource.content).toBeUndefined();
    });
  });

  // ════════════════════════════════════════════════════════
  // 8. sourceHealth + suggest 委托（已迁移）
  // ════════════════════════════════════════════════════════
  //
  // sourceHealth / suggest 已从 MemoryInspector 删除，
  // 迁移至 Agent 门面直连 MemoryAdvisor（与 detectConflicts 同模式）。
  // 相关测试见：
  //   - memoryAdvisor.test.ts（advisor 单元测试，覆盖 sourceHealth/suggest 全场景）
  //   - agent.test.ts（Agent 门面委托测试）
  //   - host.test.ts（宿主 sourceHealth() 集成测试）

  // ════════════════════════════════════════════════════════
  // 9. 写操作（writeXxx 前缀）
  // ════════════════════════════════════════════════════════

  describe('写操作（writeXxx）', () => {
    // ─── 记忆写入 ───

    it('writeUpsert 应写入记忆（写入后可读取）', () => {
      const mem = createMemory({ id: 'rule:1', source: 'rule', name: 'r1' });
      inspector.writeUpsert(mem);
      // 通过只读方法验证写入结果
      expect(inspector.getById('rule:1')).toEqual(mem);
    });

    it('writeUpsert 应支持更新已存在的记忆', () => {
      const mem = createMemory({ id: 'rule:1', source: 'rule', name: 'r1', score: 0.5 });
      inspector.writeUpsert(mem);
      // 更新 score
      inspector.writeUpsert({ ...mem, score: 0.9 });
      expect(inspector.getById('rule:1')!.score).toBe(0.9);
    });

    // ─── L2 采纳反哺内核 ───

    it('writeBoost 应提升记忆 score 并更新 accessedAt', () => {
      const mem = createMemory({ id: 'content:1', source: 'content', name: 'i1', score: 0.5 });
      inspector.writeUpsert(mem);
      const before = inspector.getById('content:1')!;
      // 提升记忆 score
      const result = inspector.writeBoost('content:1');
      expect(result).toBe(true);
      const after = inspector.getById('content:1')!;
      // score 应增加 0.05（ADOPTION_BOOST_INCREMENT）
      expect(after.score).toBeCloseTo(0.55, 5);
      // accessedAt 应被更新（不复用原值）
      expect(after.accessedAt).not.toBe(before.accessedAt);
    });

    it('writeBoost 应受 SCORE_CEILING=1.0 上限约束', () => {
      const mem = createMemory({ id: 'content:1', source: 'content', name: 'i1', score: 0.98 });
      inspector.writeUpsert(mem);
      // 提升后应被钳制到 1.0，不超出上限
      inspector.writeBoost('content:1');
      expect(inspector.getById('content:1')!.score).toBe(1.0);
    });

    it('writeBoost 记忆不存在应返回 false（不抛错）', () => {
      // 候选可能来自对话历史，无对应记忆，应静默返回 false
      const result = inspector.writeBoost('content:不存在');
      expect(result).toBe(false);
    });

    it('writeBoost 应支持自定义 increment', () => {
      const mem = createMemory({ id: 'content:1', source: 'content', name: 'i1', score: 0.5 });
      inspector.writeUpsert(mem);
      // 自定义提升量 0.1
      inspector.writeBoost('content:1', 0.1);
      expect(inspector.getById('content:1')!.score).toBeCloseTo(0.6, 5);
    });

    it('writeDelete 应软删除记忆（getById 返回 null，getDeletedById 可读取）', () => {
      const mem = createMemory({ id: 'rule:1', source: 'rule', name: 'r1' });
      inspector.writeUpsert(mem);
      inspector.writeDelete('rule:1');
      // 软删除后 getById 返回 null
      expect(inspector.getById('rule:1')).toBeNull();
      // 但 getDeletedById 可读取
      const deleted = inspector.getDeletedById('rule:1');
      expect(deleted).not.toBeNull();
      expect(deleted!.deletedAt).toBeTruthy();
    });

    it('writeDelete 对不存在的 id 应为 no-op', () => {
      expect(() => inspector.writeDelete('nonexistent')).not.toThrow();
    });

    it('writeRestore 应恢复软删除的记忆（清除 deletedAt）', () => {
      const mem = createMemory({ id: 'rule:1', source: 'rule', name: 'r1' });
      inspector.writeUpsert(mem);
      inspector.writeDelete('rule:1');
      expect(inspector.getById('rule:1')).toBeNull();
      // 恢复
      inspector.writeRestore('rule:1');
      expect(inspector.getById('rule:1')).not.toBeNull();
      expect(inspector.getById('rule:1')!.deletedAt).toBeUndefined();
    });

    it('writePurge 应物理删除记忆（不可恢复）', () => {
      const mem = createMemory({ id: 'rule:1', source: 'rule', name: 'r1' });
      inspector.writeUpsert(mem);
      inspector.writePurge('rule:1');
      // 物理删除后 getById 和 getDeletedById 都返回 null
      expect(inspector.getById('rule:1')).toBeNull();
      expect(inspector.getDeletedById('rule:1')).toBeNull();
    });

    it('writePurgeExpired 应清理过期的软删除记忆', () => {
      const mem1 = createMemory({ id: 'rule:1', source: 'rule', name: 'r1' });
      const mem2 = createMemory({ id: 'rule:2', source: 'rule', name: 'r2' });
      inspector.writeUpsert(mem1);
      inspector.writeUpsert(mem2);
      inspector.writeDelete('rule:1');
      inspector.writeDelete('rule:2');

      // 阈值稍晚于当前，确保覆盖已写入的 deletedAt
      const before = new Date(Date.now() + 1000);
      const purgedCount = inspector.writePurgeExpired(before);
      expect(purgedCount).toBe(2);
      expect(inspector.getDeletedById('rule:1')).toBeNull();
      expect(inspector.getDeletedById('rule:2')).toBeNull();
    });

    it('writePurgeExpired 应同步清理过期记忆的向量（防孤儿向量被召回）', () => {
      const mem1 = createMemory({ id: 'rule:1', source: 'rule', name: 'r1' });
      const mem2 = createMemory({ id: 'rule:2', source: 'rule', name: 'r2' });
      inspector.writeUpsert(mem1);
      inspector.writeUpsert(mem2);
      inspector.writeDelete('rule:1');
      inspector.writeDelete('rule:2');

      // 注入 vectorStore，delete 为 vi.fn（跟踪调用，语义上等同 JsonVectorStore.delete 的同步内存删除）
      const del = vi.fn().mockResolvedValue(undefined);
      inspector.setVectorStore({ size: 2, search: vi.fn(), delete: del } as unknown as IVectorStore);

      const before = new Date(Date.now() + 1000);
      const purgedCount = inspector.writePurgeExpired(before);
      expect(purgedCount).toBe(2);
      // 向量同步清理：两个过期记忆的向量均被删除
      expect(del).toHaveBeenCalledTimes(2);
      expect(del).toHaveBeenCalledWith('rule:1');
      expect(del).toHaveBeenCalledWith('rule:2');
    });

    it('writePurge 应同步清理向量（手动 purge 不产生孤儿向量）', () => {
      const mem = createMemory({ id: 'rule:1', source: 'rule', name: 'r1' });
      inspector.writeUpsert(mem);

      const del = vi.fn().mockResolvedValue(undefined);
      inspector.setVectorStore({ size: 1, search: vi.fn(), delete: del } as unknown as IVectorStore);

      inspector.writePurge('rule:1');
      // 手动 purge 也同步清理向量
      expect(del).toHaveBeenCalledTimes(1);
      expect(del).toHaveBeenCalledWith('rule:1');
    });

    it('writePurgeExpired 在 vectorStore 未注入时应正常清理记忆（降级）', () => {
      const mem = createMemory({ id: 'rule:1', source: 'rule', name: 'r1' });
      inspector.writeUpsert(mem);
      inspector.writeDelete('rule:1');

      const before = new Date(Date.now() + 1000);
      const purgedCount = inspector.writePurgeExpired(before);
      expect(purgedCount).toBe(1);
      expect(inspector.getDeletedById('rule:1')).toBeNull();
    });

    it('writePurgeExpired 未过期的软删除记忆不应被清理', () => {
      const mem = createMemory({ id: 'rule:1', source: 'rule', name: 'r1' });
      inspector.writeUpsert(mem);
      inspector.writeDelete('rule:1');
      // 阈值为 1 小时前（deletedAt 晚于此值，未过期）
      const before = new Date(Date.now() - 60 * 60 * 1000);
      const purgedCount = inspector.writePurgeExpired(before);
      expect(purgedCount).toBe(0);
      expect(inspector.getDeletedById('rule:1')).not.toBeNull();
    });
  });

  // ════════════════════════════════════════════════════════
  // 7. listFading（健康观测 · 即将自然沉底）
  // ════════════════════════════════════════════════════════

  describe('listFading', () => {
    it('只返回超过 FADING_CUTOFF_DAYS 未访问的记忆（近期访问的被过滤）', () => {
      storage.upsert(
        createMemory({ id: 'content:fading', name: 'fading', accessedAt: '2020-01-01T00:00:00.000Z' }),
      );
      storage.upsert(createMemory({ id: 'content:recent', name: 'recent', accessedAt: nowIso() }));

      const fading = inspector.listFading();
      const first = fading[0]!;
      expect(fading).toHaveLength(1);
      expect(first.id).toBe('content:fading');
    });

    it('按沉底顺序排序：最久未访问在前，同天分数最低在前', () => {
      storage.upsert(
        // 同 accessedAt，低分（0.2）应排前
        createMemory({ id: 'content:a', name: 'a', accessedAt: '2020-01-01T00:00:00.000Z', score: 0.2 }),
      );
      storage.upsert(
        createMemory({ id: 'content:b', name: 'b', accessedAt: '2020-01-01T00:00:00.000Z', score: 0.8 }),
      );
      storage.upsert(
        // 更久未访问（2019）应整体在前
        createMemory({ id: 'content:c', name: 'c', accessedAt: '2019-01-01T00:00:00.000Z', score: 0.5 }),
      );

      const ids = inspector.listFading().map((m) => m.id);
      expect(ids[0]).toBe('content:c'); // 最久在前
      expect(ids[1]).toBe('content:a'); // 同天低分在前
      expect(ids[2]).toBe('content:b');
    });

    it('limit 控制返回条数且默认 50', () => {
      for (let i = 0; i < 5; i++) {
        storage.upsert(
          createMemory({
            id: `content:old-${i}`,
            name: `old-${i}`,
            accessedAt: '2020-01-01T00:00:00.000Z',
          }),
        );
      }
      expect(inspector.listFading({ limit: 2 })).toHaveLength(2);
      expect(inspector.listFading().length).toBeLessThanOrEqual(50);
    });

    it('limit 非正整数应抛 configError', () => {
      storage.upsert(
        createMemory({ id: 'content:old', name: 'old', accessedAt: '2020-01-01T00:00:00.000Z' }),
      );
      expect(() => inspector.listFading({ limit: 0 })).toThrow();
      expect(() => inspector.listFading({ limit: -1 })).toThrow();
      expect(() => inspector.listFading({ limit: 1.5 })).toThrow();
    });

    it('空库返回空数组', () => {
      expect(inspector.listFading()).toEqual([]);
    });

    it('daysSinceAccess 为距上次访问的完整天数且为正', () => {
      storage.upsert(
        createMemory({ id: 'content:old', name: 'old', accessedAt: nowIso() }),
      );
      storage.upsert(
        createMemory({
          id: 'content:fading',
          name: 'fading',
          accessedAt: '2020-01-01T00:00:00.000Z',
          score: 0.2,
        }),
      );
      const fading = inspector.listFading();
      expect(fading[0]!.daysSinceAccess).toBeGreaterThan(365);
    });

    it('contentPreview 应截断到 SEARCH_PREVIEW_LEN（120 字符）', () => {
      storage.upsert(
        createMemory({
          id: 'content:old',
          name: 'old',
          accessedAt: '2020-01-01T00:00:00.000Z',
          content: 'x'.repeat(300),
        }),
      );
      const fading = inspector.listFading();
      // 长内容截断到 120 + '…'（与 search 的 SEARCH_PREVIEW_LEN 约定一致）
      expect(fading[0]!.contentPreview.length).toBe(121);
    });
  });
});
