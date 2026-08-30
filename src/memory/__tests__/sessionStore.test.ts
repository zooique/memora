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
import type {
  ISessionStore,
  SessionMessage,
  SessionMeta,
} from '../sessionStore.js';
// 内核真实实现（本文件顶部的同名 InMemorySessionStore 是测试替身，故此处取别名区分）
import { InMemorySessionStore as KernelSessionStore } from '../inMemorySessionStore.js';
import { InMemoryRoundStore } from '../inMemoryRoundStore.js';

// ══════════════════════════════════════════════════════════════
// 1. 最小内存实现（用于验证接口契约）
// ══════════════════════════════════════════════════════════════

/**
 * 内存会话存储实现（仅用于测试，不是生产实现）
 *
 * 实现 ISessionStore 所有必需方法 + 大部分可选方法，
 * 验证接口契约的完整性。
 */
class InMemorySessionStore implements ISessionStore {
  /** 消息存储：key = `${date}/${session}`，value = 消息数组 */
  private readonly messages = new Map<string, SessionMessage[]>();
  /** 检查点存储：key = sessionId，value = checkpoint JSON 字符串 */
  private readonly checkpoints = new Map<string, string>();
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

  /** 保存检查点（可选方法实现） */
  saveCheckpoint(sessionId: string, checkpoint: string): void {
    this.checkpoints.set(sessionId, checkpoint);
  }

  /** 加载检查点（可选方法实现） */
  loadCheckpoint(sessionId: string): string | null {
    return this.checkpoints.get(sessionId) ?? null;
  }

  /** 删除检查点（可选方法实现） */
  deleteCheckpoint(sessionId: string): void {
    this.checkpoints.delete(sessionId);
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
    return Array.from(this.metas.values()).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
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

  let store: InMemorySessionStore;

  beforeEach(() => {
    store = new InMemorySessionStore();
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
        role: 'user', content: 'A的消息', timestamp: 't1',
      });
      store.seedMessages('2026-08-18', 'session-B', {
        role: 'user', content: 'B的消息', timestamp: 't2',
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
        role: 'user', content: '今天', timestamp: 't1',
      });
      store.seedMessages('2026-08-17', 'test', {
        role: 'user', content: '昨天', timestamp: 't2',
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
        role: 'user', content: 'test1', timestamp: 't1',
      });
      store.seedMessages('2026-08-18', 'session-2', {
        role: 'user', content: 'test2', timestamp: 't2',
      });
      store.seedMessages('2026-08-17', 'session-3', {
        role: 'user', content: 'test3', timestamp: 't3',
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

  let store: InMemorySessionStore;

  beforeEach(() => {
    store = new InMemorySessionStore();
  });

  describe('saveCheckpoint + loadCheckpoint + deleteCheckpoint', () => {
    it('保存后可加载', () => {
      const checkpoint = JSON.stringify({ step: 3, status: 'paused' });
      store.saveCheckpoint('2026-08-18-test', checkpoint);

      const loaded = store.loadCheckpoint('2026-08-18-test');
      expect(loaded).toBe(checkpoint);
    });

    it('加载不存在的检查点返回 null', () => {
      const loaded = store.loadCheckpoint('nonexistent-session');
      expect(loaded).toBeNull();
    });

    it('删除检查点', () => {
      store.saveCheckpoint('session-1', 'checkpoint-data');
      store.deleteCheckpoint('session-1');

      const loaded = store.loadCheckpoint('session-1');
      expect(loaded).toBeNull();
    });

    it('覆盖保存', () => {
      store.saveCheckpoint('session-1', 'version-1');
      store.saveCheckpoint('session-1', 'version-2');

      const loaded = store.loadCheckpoint('session-1');
      expect(loaded).toBe('version-2');
    });
  });

  describe('getSessionMeta + setSessionTitle + listSessionMetas', () => {
    it('设置标题后可获取', () => {
      store.seedMessages('2026-08-18', 'test', {
        role: 'user', content: 'test', timestamp: 't1',
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
      store.createSession({ sessionId: '2026-08-01-a', updatedAt: '2026-08-01T00:00:00.000Z', messageCount: 0 });
      store.createSession({ sessionId: '2026-08-03-b', updatedAt: '2026-08-03T00:00:00.000Z', messageCount: 0 });
      store.createSession({ sessionId: '2026-08-02-c', updatedAt: '2026-08-02T00:00:00.000Z', messageCount: 0 });

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
    const store = new KernelSessionStore(new InMemoryRoundStore());
    // 乱序插入：确保验证的是「实现真的排序」而非插入顺序
    store.createSession({ sessionId: '2026-08-01-a', updatedAt: '2026-08-01T00:00:00.000Z', messageCount: 0 });
    store.createSession({ sessionId: '2026-08-03-b', updatedAt: '2026-08-03T00:00:00.000Z', messageCount: 0 });
    store.createSession({ sessionId: '2026-08-02-c', updatedAt: '2026-08-02T00:00:00.000Z', messageCount: 0 });

    expect(store.listSessionMetas().map((m) => m.sessionId)).toEqual([
      '2026-08-03-b',
      '2026-08-02-c',
      '2026-08-01-a',
    ]);
  });
});