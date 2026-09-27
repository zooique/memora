/**
 * sessionStore.test.ts — ISessionStore 接口契约测试
 *
 * 覆盖范围：
 *   1. ISessionStore 接口 — 必需方法、可选方法签名验证
 *   2. 内存存储实现 — InMemorySessionStore 基本行为
 *   3. 可选方法默认行为 — 未实现时的降级
 *   4. SessionMessage / SessionMeta 类型验证
 *
 * 注：与 sessionStoreContract.test.ts 互补——后者测试 MessageHistory ↔ ISessionStore 集成，
 *     本文件聚焦接口本身的契约和内存实现。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { ISessionStore, SessionMessage, SessionMeta } from '../sessionStore.js';
// 内核真实实现（测试替身改名 TestInMemorySessionStore 后，本名恢复独占，无需再取别名区分）
import { InMemorySessionStore } from '../inMemorySessionStore.js';
import { InMemoryRoundStore } from '../inMemoryRoundStore.js';
import { createPendingRound, completeRound, type Round } from '../roundStore.js';
import { getSessionDisplayName, getSessionAutoName } from '../sessionStore.js';

// ══════════════════════════════════════════════════════════════
// 1. 最小内存实现（用于验证接口契约）
// ══════════════════════════════════════════════════════════════

/**
 * 内存会话存储实现（仅用于测试，不是生产实现）
 *
 * 实现 ISessionStore 所有必需方法 + 大部分可选方法，
 * 验证接口契约的完整性。
 */
class TestInMemorySessionStore implements ISessionStore {
  /** 消息存储：key = `${date}/${session}`，value = 消息数组 */
  private readonly messages = new Map<string, SessionMessage[]>();
  /** 会话元数据存储 */
  private readonly metas = new Map<string, SessionMeta>();
  /** Round ID 存储：key = sessionId，value = roundId[] */
  private readonly roundIdsMap = new Map<string, string[]>();

  /** 测试播种：注入已展开的消息视图（round-based 下会话视图由 roundIds → RoundStore 展开，此处直接用展开结果模拟） */
  seedMessages(date: string, session: string, message: SessionMessage): void {
    const key = `${date}/${session}`;
    const messages = this.messages.get(key) ?? [];
    messages.push(message);
    this.messages.set(key, messages);

    // 更新元数据
    const sessionId = `${date}-${session}`;
    const meta = this.metas.get(sessionId);
    if (meta) {
      this.metas.set(sessionId, {
        ...meta,
        messageCount: meta.messageCount + 1,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  /** 加载消息 */
  loadMessages(date: string, session: string): SessionMessage[] {
    const key = `${date}/${session}`;
    return this.messages.get(key) ?? [];
  }

  /** 列出所有会话 */
  listSessions(): string[] {
    const sessions = new Set<string>();
    for (const key of this.messages.keys()) {
      const [date, session] = key.split('/');
      sessions.add(`${date}-${session}`);
    }
    return Array.from(sessions).sort();
  }

  /** 获取会话元数据（可选方法实现） */
  getSessionMeta(sessionId: string): SessionMeta | undefined {
    return this.metas.get(sessionId);
  }

  /** 设置会话显示名称（可选方法实现，写入 displayName） */
  setSessionTitle(sessionId: string, title: string): void {
    const existing = this.metas.get(sessionId);
    if (existing) {
      this.metas.set(sessionId, {
        ...existing,
        displayName: title,
        updatedAt: new Date().toISOString(),
      });
    } else {
      // 从消息数推断
      const messageCount = this.countMessagesForSession(sessionId);
      this.metas.set(sessionId, {
        sessionId,
        displayName: title,
        updatedAt: new Date().toISOString(),
        messageCount,
      });
    }
  }

  /** 更新会话元数据（可选方法实现，写入 autoName/keyTopics/summary） */
  updateSessionMeta(sessionId: string, meta: Partial<SessionMeta>): void {
    const existing = this.metas.get(sessionId);
    if (existing) {
      this.metas.set(sessionId, {
        ...existing,
        ...meta,
        updatedAt: new Date().toISOString(),
      });
    } else {
      const messageCount = this.countMessagesForSession(sessionId);
      this.metas.set(sessionId, {
        sessionId,
        updatedAt: new Date().toISOString(),
        messageCount,
        ...meta,
      });
    }
  }

  /**
   * 列出所有会话元数据（可选方法实现）
   *
   * 遵循 ISessionStore 排序契约：**按 updatedAt 降序**（最近活跃在前），
   * 与宿主 WorkspaceSessionStore / 内核 InMemorySessionStore 同向。
   */
  listSessionMetas(): SessionMeta[] {
    return Array.from(this.metas.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** 辅助：统计会话消息数 */
  private countMessagesForSession(sessionId: string): number {
    // sessionId 格式：YYYY-MM-DD-sessionName
    // 日期格式 YYYY-MM-DD 中有两个 -，所以跳过前两个
    const parts = sessionId.split('-');
    if (parts.length < 4) return 0; // 至少 YYYY-MM-DD-name
    const date = `${parts[0]}-${parts[1]}-${parts[2]}`;
    const session = parts.slice(3).join('-');
    const key = `${date}/${session}`;
    return this.messages.get(key)?.length ?? 0;
  }

  // ── Round-based 方法 ──

  /** 追加 Round ID 到会话 */
  appendRoundId(sessionId: string, roundId: string): void {
    const ids = this.roundIdsMap.get(sessionId) ?? [];
    ids.push(roundId);
    this.roundIdsMap.set(sessionId, ids);
  }

  /** 批量追加 Round ID 到会话 */
  appendRoundIds(sessionId: string, roundIds: string[]): void {
    const ids = this.roundIdsMap.get(sessionId) ?? [];
    ids.push(...roundIds);
    this.roundIdsMap.set(sessionId, ids);
  }

  /** 获取会话的 Round ID 列表 */
  getRoundIds(sessionId: string): string[] {
    return this.roundIdsMap.get(sessionId) ?? [];
  }

  /** 设置会话的 Round ID 列表 */
  setRoundIds(sessionId: string, roundIds: string[]): void {
    this.roundIdsMap.set(sessionId, [...roundIds]);
  }

  /** 创建新会话元数据 */
  createSession(meta: SessionMeta): void {
    this.metas.set(meta.sessionId, { ...meta });
  }

  /** 删除会话（同时清理 Round ID 引用） */
  deleteSession(sessionId: string): void {
    this.metas.delete(sessionId);
    this.roundIdsMap.delete(sessionId);
  }
}

// ══════════════════════════════════════════════════════════════
// 2. 必需方法测试
// ══════════════════════════════════════════════════════════════

describe('ISessionStore — 必需方法契约', () => {
  let store: TestInMemorySessionStore;

  beforeEach(() => {
    store = new TestInMemorySessionStore();
  });

  describe('seedMessages（会话视图播种） + loadMessages', () => {
    it('追加后可加载', () => {
      const msg: SessionMessage = {
        role: 'user',
        content: '你好',
        timestamp: '2026-08-18T10:00:00.000Z',
      };
      store.seedMessages('2026-08-18', 'test-session', msg);

      const loaded = store.loadMessages('2026-08-18', 'test-session');
      expect(loaded).toHaveLength(1);
      expect(loaded[0]).toEqual(msg);
    });

    it('多条消息按顺序追加', () => {
      const msgs: SessionMessage[] = [
        { role: 'user', content: '问题1', timestamp: '2026-08-18T10:00:00.000Z' },
        { role: 'assistant', content: '回答1', timestamp: '2026-08-18T10:00:01.000Z' },
        { role: 'user', content: '问题2', timestamp: '2026-08-18T10:00:02.000Z' },
      ];
      for (const m of msgs) {
        store.seedMessages('2026-08-18', 'test', m);
      }

      const loaded = store.loadMessages('2026-08-18', 'test');
      expect(loaded).toHaveLength(3);
      expect(loaded[0]!.content).toBe('问题1');
      expect(loaded[1]!.content).toBe('回答1');
      expect(loaded[2]!.content).toBe('问题2');
    });

    it('不存在的会话返回空数组', () => {
      const loaded = store.loadMessages('2026-08-18', 'nonexistent');
      expect(loaded).toEqual([]);
    });

    it('不同会话隔离', () => {
      store.seedMessages('2026-08-18', 'session-A', {
        role: 'user',
        content: 'A的消息',
        timestamp: 't1',
      });
      store.seedMessages('2026-08-18', 'session-B', {
        role: 'user',
        content: 'B的消息',
        timestamp: 't2',
      });

      const loadedA = store.loadMessages('2026-08-18', 'session-A');
      const loadedB = store.loadMessages('2026-08-18', 'session-B');
      expect(loadedA).toHaveLength(1);
      expect(loadedA[0]!.content).toBe('A的消息');
      expect(loadedB).toHaveLength(1);
      expect(loadedB[0]!.content).toBe('B的消息');
    });

    it('不同日期隔离', () => {
      store.seedMessages('2026-08-18', 'test', {
        role: 'user',
        content: '今天',
        timestamp: 't1',
      });
      store.seedMessages('2026-08-17', 'test', {
        role: 'user',
        content: '昨天',
        timestamp: 't2',
      });

      const loadedToday = store.loadMessages('2026-08-18', 'test');
      const loadedYesterday = store.loadMessages('2026-08-17', 'test');
      expect(loadedToday[0]!.content).toBe('今天');
      expect(loadedYesterday[0]!.content).toBe('昨天');
    });
  });

  describe('listSessions', () => {
    it('列出所有会话', () => {
      store.seedMessages('2026-08-18', 'session-1', {
        role: 'user',
        content: 'test1',
        timestamp: 't1',
      });
      store.seedMessages('2026-08-18', 'session-2', {
        role: 'user',
        content: 'test2',
        timestamp: 't2',
      });
      store.seedMessages('2026-08-17', 'session-3', {
        role: 'user',
        content: 'test3',
        timestamp: 't3',
      });

      const sessions = store.listSessions();
      expect(sessions).toHaveLength(3);
      expect(sessions).toContain('2026-08-18-session-1');
      expect(sessions).toContain('2026-08-18-session-2');
      expect(sessions).toContain('2026-08-17-session-3');
    });

    it('空存储返回空数组', () => {
      const sessions = store.listSessions();
      expect(sessions).toEqual([]);
    });
  });
});

// ══════════════════════════════════════════════════════════════
// 3. 可选方法测试
// ══════════════════════════════════════════════════════════════

describe('ISessionStore — 可选方法契约', () => {
  let store: TestInMemorySessionStore;

  beforeEach(() => {
    store = new TestInMemorySessionStore();
  });

  describe('getSessionMeta + setSessionTitle + listSessionMetas', () => {
    it('设置标题后可获取', () => {
      store.seedMessages('2026-08-18', 'test', {
        role: 'user',
        content: 'test',
        timestamp: 't1',
      });
      store.setSessionTitle('2026-08-18-test', '我的会话');

      const meta = store.getSessionMeta('2026-08-18-test');
      expect(meta).toBeDefined();
      expect(meta!.displayName).toBe('我的会话');
      expect(meta!.sessionId).toBe('2026-08-18-test');
      expect(meta!.messageCount).toBe(1);
    });

    it('获取不存在的元数据返回 undefined', () => {
      const meta = store.getSessionMeta('nonexistent');
      expect(meta).toBeUndefined();
    });

    it('列出所有元数据', () => {
      store.seedMessages('2026-08-18', 's1', { role: 'user', content: 'a', timestamp: 't1' });
      store.seedMessages('2026-08-18', 's2', { role: 'user', content: 'b', timestamp: 't2' });
      store.setSessionTitle('2026-08-18-s1', '会话一');
      store.setSessionTitle('2026-08-18-s2', '会话二');

      const metas = store.listSessionMetas();
      expect(metas).toHaveLength(2);
      expect(metas[0]!.displayName).toBeDefined();
      expect(metas[1]!.displayName).toBeDefined();
    });

    it('listSessionMetas 按 updatedAt 降序（最近活跃在前）——ISessionStore 排序契约', () => {
      // 故意乱序插入，确保验证的是「实现真的排序」而非「碰巧等于插入顺序」
      store.createSession({
        sessionId: '2026-08-01-a',
        updatedAt: '2026-08-01T00:00:00.000Z',
        messageCount: 0,
      });
      store.createSession({
        sessionId: '2026-08-03-b',
        updatedAt: '2026-08-03T00:00:00.000Z',
        messageCount: 0,
      });
      store.createSession({
        sessionId: '2026-08-02-c',
        updatedAt: '2026-08-02T00:00:00.000Z',
        messageCount: 0,
      });

      // 契约：降序，[0] = 最近活跃。
      // SessionManager.restoreMostRecentSession 视 listSessionMetas[0] 为「最近活跃唯一真理源」，
      // 若本实现升规则该契约崩塌（恢复到最旧会话）。宿主 WorkspaceSessionStore 已是降序，
      // 两实现必须同向——排序方向属 ISessionStore 契约，非各实现自由。
      expect(store.listSessionMetas().map((m) => m.sessionId)).toEqual([
        '2026-08-03-b',
        '2026-08-02-c',
        '2026-08-01-a',
      ]);
    });

    it('更新标题时 updatedAt 更新', async () => {
      store.setSessionTitle('session-1', '原标题');
      const meta1 = store.getSessionMeta('session-1')!;
      const time1 = meta1.updatedAt;

      // 等待一小段时间确保时间戳不同
      await new Promise((resolve) => setTimeout(resolve, 10));

      store.setSessionTitle('session-1', '新标题');
      const meta2 = store.getSessionMeta('session-1')!;
      expect(meta2.displayName).toBe('新标题');
      expect(meta2.updatedAt).not.toBe(time1);
    });
  });
});

// ══════════════════════════════════════════════════════════════
// 4. SessionMessage 类型验证
// ══════════════════════════════════════════════════════════════

describe('ISessionStore — SessionMessage 类型', () => {
  it('消息结构正确', () => {
    const msg: SessionMessage = {
      role: 'user',
      content: '测试消息',
      timestamp: '2026-08-18T10:00:00.000Z',
    };
    expect(msg.role).toBe('user');
    expect(msg.content).toBe('测试消息');
    expect(msg.timestamp).toBe('2026-08-18T10:00:00.000Z');
    expect(msg.roundId).toBeUndefined();
  });

  it('消息含 roundId', () => {
    const msg: SessionMessage = {
      role: 'assistant',
      content: '带轮次的消息',
      timestamp: '2026-08-18T10:00:00.000Z',
      roundId: 'round-001',
    };
    expect(msg.roundId).toBe('round-001');
  });

  it('支持所有合法角色', () => {
    const roles: SessionMessage['role'][] = ['user', 'assistant', 'system', 'tool'];
    for (const role of roles) {
      const msg: SessionMessage = { role, content: 'test', timestamp: 't' };
      expect(msg.role).toBe(role);
    }
  });
});

// ══════════════════════════════════════════════════════════════
// 5. SessionMeta 类型验证
// ══════════════════════════════════════════════════════════════

describe('ISessionStore — SessionMeta 类型', () => {
  it('元数据结构正确', () => {
    const meta: SessionMeta = {
      sessionId: '2026-08-18-test',
      autoName: '测试会话',
      displayName: '测试会话',
      updatedAt: '2026-08-18T10:00:00.000Z',
      messageCount: 42,
    };
    expect(meta.sessionId).toBe('2026-08-18-test');
    expect(meta.autoName).toBe('测试会话');
    expect(meta.displayName).toBe('测试会话');
    expect(meta.updatedAt).toBe('2026-08-18T10:00:00.000Z');
    expect(meta.messageCount).toBe(42);
  });

  it('支持双层命名回退逻辑', () => {
    // 仅有 autoName，无 displayName
    const meta1: SessionMeta = {
      sessionId: 'test-1',
      autoName: '自动名称',
      updatedAt: '2026-08-18T10:00:00.000Z',
      messageCount: 1,
    };
    expect(meta1.autoName).toBe('自动名称');
    expect(meta1.displayName).toBeUndefined();

    // 有 displayName 覆盖 autoName
    const meta2: SessionMeta = {
      sessionId: 'test-2',
      autoName: '自动名称',
      displayName: '用户自定义',
      updatedAt: '2026-08-18T10:00:00.000Z',
      messageCount: 1,
    };
    expect(meta2.autoName).toBe('自动名称');
    expect(meta2.displayName).toBe('用户自定义');
  });
});

describe('内核 InMemorySessionStore（真实实现）· listSessionMetas 排序契约', () => {
  it('按 updatedAt 降序（最近活跃在前）——与宿主实现同向', () => {
    const store = new InMemorySessionStore(new InMemoryRoundStore());
    // 乱序插入：确保验证的是「实现真的排序」而非插入顺序
    store.createSession({
      sessionId: '2026-08-01-a',
      updatedAt: '2026-08-01T00:00:00.000Z',
      messageCount: 0,
    });
    store.createSession({
      sessionId: '2026-08-03-b',
      updatedAt: '2026-08-03T00:00:00.000Z',
      messageCount: 0,
    });
    store.createSession({
      sessionId: '2026-08-02-c',
      updatedAt: '2026-08-02T00:00:00.000Z',
      messageCount: 0,
    });

    expect(store.listSessionMetas().map((m) => m.sessionId)).toEqual([
      '2026-08-03-b',
      '2026-08-02-c',
      '2026-08-01-a',
    ]);
  });
});

// ══════════════════════════════════════════════════════════════
// 6. 内核 InMemorySessionStore（真实实现）round-based 行为全覆盖
// ══════════════════════════════════════════════════════════════

describe('内核 InMemorySessionStore（真实实现）· round-based 行为', () => {
  let store: InMemorySessionStore;
  let roundStore: InMemoryRoundStore;

  beforeEach(() => {
    roundStore = new InMemoryRoundStore();
    store = new InMemorySessionStore(roundStore);
  });

  /** 创建一个 complete Round（含 assistant 消息）并保存 */
  function saveCompleteRound(seed: string): string {
    const round = createPendingRound(`问题 ${seed}`);
    const completed = completeRound(round, `回答 ${seed}`);
    roundStore.save(completed);
    return completed.id;
  }

  /** 创建一个 pending Round（无 assistant 消息）并保存 */
  function savePendingRound(seed: string): string {
    const round = createPendingRound(`待处理 ${seed}`);
    roundStore.save(round);
    return round.id;
  }

  /** 创建一个 interrupted Round（中断/失败收场，含半截正文 + 中断标记）并保存 */
  function saveInterruptedRound(seed: string): string {
    const round = createPendingRound(`被取消 ${seed}`);
    const interrupted: Round = {
      ...completeRound(round, `半截回答 ${seed}`),
      status: 'interrupted',
    };
    roundStore.save(interrupted);
    return interrupted.id;
  }

  it('loadMessages：complete Round 展开为 user+assistant 两条', () => {
    const roundId = saveCompleteRound('A');
    store.appendRoundId('2026-09-13-main', roundId);
    const messages = store.loadMessages('2026-09-13', 'main');
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe('user');
    expect(messages[1]!.role).toBe('assistant');
    expect(messages[0]!.roundId).toBe(roundId);
    expect(messages[1]!.roundId).toBe(roundId);
  });

  it('loadMessages：无 assistant 消息的轮只展开 user 消息', () => {
    const roundId = savePendingRound('P');
    store.appendRoundId('2026-09-13-main', roundId);
    const messages = store.loadMessages('2026-09-13', 'main');
    // pending 状态 → 仅 user 消息
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe('user');
  });

  it('loadMessages：interrupted 轮同样展开 user+assistant（本方法是 LLM 历史注入唯一上游）', () => {
    // SessionManager.applySessionToLoop ← loadMessages 是 restoreHistory 的唯一上游。
    // 中断轮若被排除，用户取消后说「继续」时模型将看不到上一轮的部分产出
    // （定案见 docs/architecture/step-atomic-persistence.md §一·五）。
    const roundId = saveInterruptedRound('I');
    store.appendRoundId('2026-09-13-main', roundId);
    const messages = store.loadMessages('2026-09-13', 'main');
    expect(messages).toHaveLength(2);
    expect(messages[1]!.role).toBe('assistant');
    expect(messages[1]!.content).toBe('半截回答 I');
    expect(messages[1]!.roundId).toBe(roundId);
  });

  it('loadMessages：不存在的会话返回空数组', () => {
    expect(store.loadMessages('2026-09-13', 'nonexistent')).toEqual([]);
  });

  it('listSessions：从 roundIds 与 metas 收集去重并排序', () => {
    store.appendRoundId('2026-09-13-a', 'r1');
    store.createSession({ sessionId: '2026-09-13-b', updatedAt: 't', messageCount: 0 });
    store.createSession({ sessionId: '2026-09-13-a', updatedAt: 't2', messageCount: 0 });
    expect(store.listSessions()).toEqual(['2026-09-13-a', '2026-09-13-b']);
  });

  it('setSessionTitle：已存在 meta 时更新 displayName', () => {
    const roundId = saveCompleteRound('A');
    store.appendRoundId('2026-09-13-main', roundId);
    store.setSessionTitle('2026-09-13-main', '标题');
    expect(store.getSessionMeta('2026-09-13-main')?.displayName).toBe('标题');
    // 再次设置覆盖
    store.setSessionTitle('2026-09-13-main', '新标题');
    expect(store.getSessionMeta('2026-09-13-main')?.displayName).toBe('新标题');
  });

  it('setSessionTitle：不存在 meta 时新建并推断 messageCount', () => {
    const roundId = saveCompleteRound('A');
    store.appendRoundId('2026-09-13-main', roundId);
    store.setSessionTitle('2026-09-13-main', '新建标题');
    const meta = store.getSessionMeta('2026-09-13-main')!;
    expect(meta.displayName).toBe('新建标题');
    // appendRoundId 已更新 messageCount = 1 * 2
    expect(meta.messageCount).toBe(2);
  });

  it('updateSessionMeta：已存在 meta 时合并字段', () => {
    store.createSession({
      sessionId: '2026-09-13-main',
      autoName: '旧',
      updatedAt: 't',
      messageCount: 0,
    });
    store.updateSessionMeta('2026-09-13-main', { keyTopics: ['ts'], summary: '摘要' });
    const meta = store.getSessionMeta('2026-09-13-main')!;
    expect(meta.autoName).toBe('旧');
    expect(meta.keyTopics).toEqual(['ts']);
    expect(meta.summary).toBe('摘要');
  });

  it('updateSessionMeta：不存在 meta 时按 seed 新建', () => {
    store.updateSessionMeta('2026-09-13-main', { autoName: '自动名' });
    const meta = store.getSessionMeta('2026-09-13-main')!;
    expect(meta.sessionId).toBe('2026-09-13-main');
    expect(meta.autoName).toBe('自动名');
  });

  it('appendRoundId 追加后 getRoundIds 反映 + messageCount 更新', () => {
    const id1 = saveCompleteRound('A');
    const id2 = saveCompleteRound('B');
    // 先创建会话 meta（updateMessageCount 在无 meta 时提前返回）
    store.createSession({ sessionId: '2026-09-13-main', updatedAt: 't0', messageCount: 0 });
    store.appendRoundId('2026-09-13-main', id1);
    store.appendRoundId('2026-09-13-main', id2);
    expect(store.getRoundIds('2026-09-13-main')).toEqual([id1, id2]);
    expect(store.getSessionMeta('2026-09-13-main')?.messageCount).toBe(4);
  });

  it('appendRoundIds 批量追加 / setRoundIds 完整替换', () => {
    const id1 = saveCompleteRound('A');
    const id2 = saveCompleteRound('B');
    store.appendRoundIds('2026-09-13-main', [id1, id2]);
    expect(store.getRoundIds('2026-09-13-main')).toEqual([id1, id2]);

    const id3 = saveCompleteRound('C');
    store.setRoundIds('2026-09-13-main', [id3]);
    expect(store.getRoundIds('2026-09-13-main')).toEqual([id3]);
  });

  it('deleteSession：清空 meta 与 roundIds 并递减 Round 引用', () => {
    // 构造 refCount=2 的 complete Round（save 前设置以持久化）
    const round = createPendingRound('删除测试');
    const completed = completeRound(round, '回答');
    completed.refCount = 2; // 被 2 个会话引用
    roundStore.save(completed);
    const roundId = completed.id;
    store.createSession({ sessionId: '2026-09-13-main', updatedAt: 't', messageCount: 0 });
    store.appendRoundId('2026-09-13-main', roundId);
    store.deleteSession('2026-09-13-main');

    expect(store.getSessionMeta('2026-09-13-main')).toBeUndefined();
    expect(store.getRoundIds('2026-09-13-main')).toEqual([]);
    // 引用递减 1（2 → 1）
    expect(roundStore.getById(roundId)!.refCount).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════
// 7. 会话显示名回退（SSOT 单一语义）
// ══════════════════════════════════════════════════════════════

describe('getSessionDisplayName / getSessionAutoName', () => {
  const base: SessionMeta = {
    sessionId: '2026-09-13-main',
    updatedAt: 't',
    messageCount: 0,
  };

  it('getSessionDisplayName：displayName 优先（含去空白）', () => {
    expect(getSessionDisplayName({ ...base, displayName: ' 我的会话 ', autoName: '自动名' })).toBe(
      '我的会话',
    );
  });

  it('getSessionDisplayName：displayName 空白时回退 autoName', () => {
    expect(getSessionDisplayName({ ...base, displayName: '   ', autoName: '自动名' })).toBe(
      '自动名',
    );
  });

  it('getSessionDisplayName：仅 autoName 时用 autoName', () => {
    expect(getSessionDisplayName({ ...base, autoName: '自动名' })).toBe('自动名');
  });

  it('getSessionDisplayName：均缺失返回空串', () => {
    expect(getSessionDisplayName(base)).toBe('');
    expect(getSessionDisplayName(undefined)).toBe('');
  });

  it('getSessionAutoName：仅取 autoName，无则空串', () => {
    expect(getSessionAutoName({ ...base, autoName: ' 自动名 ' })).toBe('自动名');
    expect(getSessionAutoName(base)).toBe('');
    expect(getSessionAutoName(undefined)).toBe('');
  });
});
