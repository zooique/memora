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

  /** 追加消息 */
  appendMessage(date: string, session: string, message: SessionMessage): void {
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

  /** 复制会话（可选方法实现） */
  copySession(
    sourceDate: string,
    sourceSession: string,
    targetDate: string,
    targetSession: string,
  ): void {
    const sourceKey = `${sourceDate}/${sourceSession}`;
    const targetKey = `${targetDate}/${targetSession}`;

    const messages = this.messages.get(sourceKey);
    if (!messages) return; // 源不存在静默返回

    // 覆盖写入（幂等）
    this.messages.set(targetKey, messages.map((m) => ({ ...m })));
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

  /** 设置会话标题（可选方法实现） */
  setSessionTitle(sessionId: string, title: string): void {
    const existing = this.metas.get(sessionId);
    if (existing) {
      this.metas.set(sessionId, {
        ...existing,
        title,
        updatedAt: new Date().toISOString(),
      });
    } else {
      // 从消息数推断
      const messageCount = this.countMessagesForSession(sessionId);
      this.metas.set(sessionId, {
        sessionId,
        title,
        updatedAt: new Date().toISOString(),
        messageCount,
      });
    }
  }

  /** 列出所有会话元数据（可选方法实现） */
  listSessionMetas(): SessionMeta[] {
    return Array.from(this.metas.values()).sort((a, b) =>
      a.updatedAt.localeCompare(b.updatedAt),
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
}

// ══════════════════════════════════════════════════════════════
// 2. 必需方法测试
// ══════════════════════════════════════════════════════════════

describe('ISessionStore — 必需方法契约', () => {

  let store: InMemorySessionStore;

  beforeEach(() => {
    store = new InMemorySessionStore();
  });

  describe('appendMessage + loadMessages', () => {
    it('追加后可加载', () => {
      const msg: SessionMessage = {
        role: 'user',
        content: '你好',
        timestamp: '2026-08-18T10:00:00.000Z',
      };
      store.appendMessage('2026-08-18', 'test-session', msg);

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
        store.appendMessage('2026-08-18', 'test', m);
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
      store.appendMessage('2026-08-18', 'session-A', {
        role: 'user', content: 'A的消息', timestamp: 't1',
      });
      store.appendMessage('2026-08-18', 'session-B', {
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
      store.appendMessage('2026-08-18', 'test', {
        role: 'user', content: '今天', timestamp: 't1',
      });
      store.appendMessage('2026-08-17', 'test', {
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
      store.appendMessage('2026-08-18', 'session-1', {
        role: 'user', content: 'test1', timestamp: 't1',
      });
      store.appendMessage('2026-08-18', 'session-2', {
        role: 'user', content: 'test2', timestamp: 't2',
      });
      store.appendMessage('2026-08-17', 'session-3', {
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

  describe('copySession', () => {
    it('复制会话成功', () => {
      // 先写入源会话
      store.appendMessage('2026-08-18', 'source', {
        role: 'user', content: '源消息', timestamp: 't1',
      });
      store.appendMessage('2026-08-18', 'source', {
        role: 'assistant', content: '源回复', timestamp: 't2',
      });

      // 复制
      store.copySession('2026-08-18', 'source', '2026-08-18', 'target');

      const targetMsgs = store.loadMessages('2026-08-18', 'target');
      expect(targetMsgs).toHaveLength(2);
      expect(targetMsgs[0]!.content).toBe('源消息');
      expect(targetMsgs[1]!.content).toBe('源回复');
    });

    it('源不存在时静默返回（不抛错）', () => {
      expect(() => {
        store.copySession('2026-08-18', 'nonexistent', '2026-08-18', 'target');
      }).not.toThrow();
    });

    it('覆盖目标（幂等）', () => {
      // 先写入目标已有内容
      store.appendMessage('2026-08-18', 'target', {
        role: 'user', content: '旧内容', timestamp: 't1',
      });
      // 写入源
      store.appendMessage('2026-08-18', 'source', {
        role: 'user', content: '新内容', timestamp: 't2',
      });

      // 复制覆盖
      store.copySession('2026-08-18', 'source', '2026-08-18', 'target');

      const targetMsgs = store.loadMessages('2026-08-18', 'target');
      expect(targetMsgs).toHaveLength(1);
      expect(targetMsgs[0]!.content).toBe('新内容');
    });
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
      store.appendMessage('2026-08-18', 'test', {
        role: 'user', content: 'test', timestamp: 't1',
      });
      store.setSessionTitle('2026-08-18-test', '我的会话');

      const meta = store.getSessionMeta('2026-08-18-test');
      expect(meta).toBeDefined();
      expect(meta!.title).toBe('我的会话');
      expect(meta!.sessionId).toBe('2026-08-18-test');
      expect(meta!.messageCount).toBe(1);
    });

    it('获取不存在的元数据返回 undefined', () => {
      const meta = store.getSessionMeta('nonexistent');
      expect(meta).toBeUndefined();
    });

    it('列出所有元数据', () => {
      store.appendMessage('2026-08-18', 's1', { role: 'user', content: 'a', timestamp: 't1' });
      store.appendMessage('2026-08-18', 's2', { role: 'user', content: 'b', timestamp: 't2' });
      store.setSessionTitle('2026-08-18-s1', '会话一');
      store.setSessionTitle('2026-08-18-s2', '会话二');

      const metas = store.listSessionMetas();
      expect(metas).toHaveLength(2);
      expect(metas[0]!.title).toBeDefined();
      expect(metas[1]!.title).toBeDefined();
    });

    it('更新标题时 updatedAt 更新', async () => {
      store.setSessionTitle('session-1', '原标题');
      const meta1 = store.getSessionMeta('session-1')!;
      const time1 = meta1.updatedAt;

      // 等待一小段时间确保时间戳不同
      await new Promise((resolve) => setTimeout(resolve, 10));

      store.setSessionTitle('session-1', '新标题');
      const meta2 = store.getSessionMeta('session-1')!;
      expect(meta2.title).toBe('新标题');
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
      title: '测试会话',
      updatedAt: '2026-08-18T10:00:00.000Z',
      messageCount: 42,
    };
    expect(meta.sessionId).toBe('2026-08-18-test');
    expect(meta.title).toBe('测试会话');
    expect(meta.updatedAt).toBe('2026-08-18T10:00:00.000Z');
    expect(meta.messageCount).toBe(42);
  });
});