/**
 * 单元测试：MemoryInspector 记忆管理器（读写统一入口）
 *
 * MemoryInspector 负责记忆的查询 + 写入操作，写方法以 writeXxx 前缀命名。
 * 本测试覆盖 MemoryInspector 全部公开方法：
 *   - constructor：依赖注入
 *   - 只读查询：getById / getDeletedById / listDeleted / getBySource / list
 *   - snapshot：3 层快照（工作记忆 + Bootstrap + 归档）
 *   - search：关键词搜索（空 query 抛错 + limit 校验 + 内容截断）
 *   - searchByKeyword：纯关键词搜索（语义通道已收编移除）
 *   - stats：记忆库统计
 *   - 写操作：writeUpsert / writeDelete / writeRestore / writePurge / writePurgeExpired
 *
 * sourceHealth / suggest 由 Agent 门面直连 MemoryAdvisor（与 detectConflicts 同模式），
 * 相关测试见 memoryAdvisor.test.ts + agent.test.ts。本测试不再 import MemoryAdvisor。
 *
 * Mock 策略：
 *   - InMemoryStorage 用真实实现（测试夹具，已被 store.test.ts 验证）
 *   - loop / history 用 Partial<T> as T 单层断言（仅实现被测方法）
 *   - 写操作测试通过 writeXxx 写入后用只读方法读取验证（读写同源）
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MemoryInspector } from '@/agent/managers/memoryInspector.js';
import { InMemoryStorage } from '@/memory/inMemoryStorage.js';
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
    source: 'content',
    name: 'default',
    createdAt: '2026-06-27T10:00:00.000Z',
    accessedAt: '2026-06-27T10:00:00.000Z',
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
  // 1. constructor 依赖注入
  // ════════════════════════════════════════════════════════

  describe('constructor 依赖注入', () => {
    it('应正确接收 3 个必选依赖（index/loop/history）', () => {
      // 通过 snapshot() 间接验证依赖已存储
      const snap = inspector.snapshot();
      expect(snap).toBeDefined();
      expect(snap.working).toBeDefined();
      expect(snap.bootstrap).toBeDefined();
      expect(snap.archive).toBeDefined();
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

    it('list 应委托 index.search("", limit) 返回按 accessedAt 降序', () => {
      storage.upsert(
        createMemory({
          id: 'content:low',
          source: 'content',
          name: 'low',
          accessedAt: '2026-01-01T00:00:00.000Z',
        }),
      );
      storage.upsert(
        createMemory({
          id: 'content:high',
          source: 'content',
          name: 'high',
          accessedAt: '2026-01-03T00:00:00.000Z',
        }),
      );
      const list = inspector.list(10);
      expect(list).toHaveLength(2);
      // 按 accessedAt 降序（InMemoryStorage.search 默认行为，score 已退役）
      expect(list[0]!.name).toBe('high');
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
      storage.upsert(
        createMemory({ id: 'round-summary:s1:r1', source: 'round-summary', name: 'rs1' }),
      );
      storage.upsert(
        createMemory({ id: 'round-summary:s1:r2', source: 'round-summary', name: 'rs2' }),
      );
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
      storage.upsert(
        createMemory({ id: 'content:long', source: 'content', name: 'long', content: longContent }),
      );
      storage.upsert(
        createMemory({ id: 'content:short', source: 'content', name: 'short', content: 'short' }),
      );
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
  // 5. searchByKeyword（8 测试）
  // ════════════════════════════════════════════════════════

  describe('searchByKeyword', () => {
    it('空 query 应抛 configError', async () => {
      await expect(inspector.searchByKeyword('')).rejects.toThrow('搜索关键词为空');
    });

    it('limit <= 0 应抛 configError', async () => {
      await expect(inspector.searchByKeyword('query', 0)).rejects.toThrow('无效 limit');
    });

    it('纯关键词搜索（B0 收编：无向量通道）', async () => {
      storage.upsert(
        createMemory({ id: 'content:k1', source: 'content', name: 'k1', content: 'keyword test' }),
      );
      const hits = await inspector.searchByKeyword('keyword');
      expect(hits).toHaveLength(1);
      expect(hits[0]!.name).toBe('k1');
    });

    it('语义近义词不命中（字面匹配；LLM 须换词重试）', async () => {
      storage.upsert(
        createMemory({ id: 'content:k1', source: 'content', name: 'k1', content: '性能优化方案' }),
      );
      // 「提速」与「性能优化」语义近义但字面不匹配 → 纯关键词 0 命中
      const hits = await inspector.searchByKeyword('提速');
      expect(hits).toHaveLength(0);
      // 换词（用记忆里的字面词）→ 命中
      const retry = await inspector.searchByKeyword('性能优化');
      expect(retry).toHaveLength(1);
    });

    it('长内容截断到预览上限', async () => {
      const longContent = 'C'.repeat(150);
      storage.upsert(
        createMemory({ id: 'content:long', source: 'content', name: 'long', content: longContent }),
      );
      const hits = await inspector.searchByKeyword('C');
      expect(hits).toHaveLength(1);
      // 长内容截断到 120 + '…'
      expect(hits[0]!.contentPreview.endsWith('…')).toBe(true);
    });

    it('superseded 过滤：被 supersededBy 取代的摘要不返回（§3.3 过滤行）', async () => {
      // 旧摘要被新摘要取代 → 不出现；有效摘要正常返回（关键词命中两者，过滤后仅剩新）
      storage.upsert(
        createMemory({
          id: 'round-summary:s:old',
          source: 'round-summary',
          sessionName: 's',
          roundId: 'r1',
          name: '旧摘要',
          supersededBy: 'round-summary:s:new',
          content: '共享内容',
        }),
      );
      storage.upsert(
        createMemory({
          id: 'round-summary:s:new',
          source: 'round-summary',
          sessionName: 's',
          roundId: 'r2',
          name: '新摘要',
          content: '共享内容',
        }),
      );
      const hits = await inspector.searchByKeyword('共享内容');
      expect(hits).toHaveLength(1);
      expect(hits[0]!.name).toBe('新摘要');
    });

    it('命中揭示 accessedAt + 溯源 sessionId/roundId（§3.3 返回行，round-summary 直通 trace_summary）', async () => {
      storage.upsert(
        createMemory({
          id: 'round-summary:2026-08-28-main:r1',
          source: 'round-summary',
          sessionName: '2026-08-28-main',
          roundId: 'r1',
          name: '摘要1',
          content: '决策内容',
          accessedAt: '2026-09-01T00:00:00Z',
        }),
      );
      const hits = await inspector.searchByKeyword('决策内容');
      expect(hits[0]!.accessedAt).toBe('2026-09-01T00:00:00Z');
      // 溯源字段 = trace_summary 参数直通（sessionName 即 sessionId）
      expect(hits[0]!.sessionId).toBe('2026-08-28-main');
      expect(hits[0]!.roundId).toBe('r1');
    });

    it('excludeRoundIds：排除已载入正文轮次的 round-summary（§5.1 工具召回与装配期正文互斥）', async () => {
      // 两条 round-summary 均关键词命中；exclude r1 → 仅返回 r2（不补位凑满）
      storage.upsert(
        createMemory({
          id: 'round-summary:s:r1',
          source: 'round-summary',
          sessionName: 's',
          roundId: 'r1',
          name: '摘要1',
          content: '共同内容',
        }),
      );
      storage.upsert(
        createMemory({
          id: 'round-summary:s:r2',
          source: 'round-summary',
          sessionName: 's',
          roundId: 'r2',
          name: '摘要2',
          content: '共同内容',
        }),
      );

      const hits = await inspector.searchByKeyword('共同内容', 10, new Set(['r1']));

      expect(hits.map((h) => h.roundId)).toEqual(['r2']);
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
      const mem = createMemory({ id: 'rule:1', source: 'rule', name: 'r1' });
      inspector.writeUpsert(mem);
      // 更新内容（score 已退役，不参与断言）
      inspector.writeUpsert({ ...mem, content: '新内容' });
      expect(inspector.getById('rule:1')!.content).toBe('新内容');
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

    it('writePurgeExpired 在无向量通道时应正常清理记忆（B0 收编后常态）', () => {
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

    it('softDeleteRoundSummaries：命中轮次摘要软删 + 清空溯源（脱钩）', () => {
      // 两个命中轮（r1/r2）+ 一个无关轮（r3）
      inspector.writeUpsert(
        createMemory({
          id: 'round-summary:2026-08-28-main:r1',
          source: 'round-summary',
          sessionName: '2026-08-28-main',
          roundId: 'r1',
          name: '摘要1',
        }),
      );
      inspector.writeUpsert(
        createMemory({
          id: 'round-summary:2026-08-28-main:r2',
          source: 'round-summary',
          sessionName: '2026-08-28-main',
          roundId: 'r2',
          name: '摘要2',
        }),
      );
      inspector.writeUpsert(
        createMemory({
          id: 'round-summary:2026-08-29-main:r3',
          source: 'round-summary',
          sessionName: '2026-08-29-main',
          roundId: 'r3',
          name: '摘要3',
        }),
      );

      const count = inspector.softDeleteRoundSummaries(['r1', 'r2']);
      expect(count).toBe(2);

      // 命中者进入回收站且溯源已脱钩（恢复后即为独立记忆）
      const d1 = inspector.getDeletedById('round-summary:2026-08-28-main:r1')!;
      expect(d1.deletedAt).toBeTruthy();
      expect(d1.sessionName).toBeUndefined();
      expect(d1.roundId).toBeUndefined();
      // 未命中（r3）保持活跃
      expect(inspector.getById('round-summary:2026-08-29-main:r3')).not.toBeNull();
    });

    it('softDeleteRoundSummaries：空数组回归 0，不触碰任何记忆', () => {
      inspector.writeUpsert(
        createMemory({
          id: 'round-summary:s:r1',
          source: 'round-summary',
          sessionName: 's',
          roundId: 'r1',
        }),
      );
      expect(inspector.softDeleteRoundSummaries([])).toBe(0);
      expect(inspector.getById('round-summary:s:r1')).not.toBeNull();
    });

    it('随轮软删恢复后即为无溯源独立记忆', () => {
      inspector.writeUpsert(
        createMemory({
          id: 'round-summary:s:r9',
          source: 'round-summary',
          sessionName: '2026-08-28-main',
          roundId: 'r9',
          name: '轮次九',
        }),
      );
      inspector.softDeleteRoundSummaries(['r9']);
      inspector.writeRestore('round-summary:s:r9');
      // 恢复成功：活跃、deletedAt 清除、溯源已脱钩（独立记忆）
      const restored = inspector.getById('round-summary:s:r9')!;
      expect(restored.deletedAt).toBeUndefined();
      expect(restored.sessionName).toBeUndefined();
      expect(restored.roundId).toBeUndefined();
    });
  });
});
