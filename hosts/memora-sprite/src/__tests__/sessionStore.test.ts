/**
 * SqliteSessionStore 测试
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteSessionStore } from '../storage/sessionStore.js';
import type { SessionMessage } from 'memora';

function makeMessage(overrides: Partial<SessionMessage> = {}): SessionMessage {
  return {
    role: 'user',
    content: 'Hello',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe('SqliteSessionStore', () => {
  let db: Database.Database;
  let store: SqliteSessionStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new SqliteSessionStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('should append and load messages', () => {
    const msg1 = makeMessage({ role: 'user', content: 'Hi' });
    const msg2 = makeMessage({ role: 'assistant', content: 'Hello!' });

    store.appendMessage('2026-06-16', 'main', msg1);
    store.appendMessage('2026-06-16', 'main', msg2);

    const messages = store.loadMessages('2026-06-16', 'main');
    expect(messages).toHaveLength(2);
    expect(messages[0]!.content).toBe('Hi');
    expect(messages[1]!.content).toBe('Hello!');
  });

  it('should return empty array for non-existent session', () => {
    const messages = store.loadMessages('2026-01-01', 'nonexistent');
    expect(messages).toHaveLength(0);
  });

  it('should list sessions', () => {
    store.appendMessage('2026-06-16', 'main', makeMessage());
    store.appendMessage('2026-06-15', 'chat', makeMessage());

    const sessions = store.listSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions).toContain('2026-06-15-chat');
    expect(sessions).toContain('2026-06-16-main');
  });

  it('should copy session atomically', () => {
    store.appendMessage('2026-06-16', 'main', makeMessage({ role: 'user', content: 'A' }));
    store.appendMessage('2026-06-16', 'main', makeMessage({ role: 'assistant', content: 'B' }));

    store.copySession('2026-06-16', 'main', '2026-06-16', 'fork-1');

    const copied = store.loadMessages('2026-06-16', 'fork-1');
    expect(copied).toHaveLength(2);
    expect(copied[0]!.content).toBe('A');
    expect(copied[1]!.content).toBe('B');

    // 原会话不受影响
    const original = store.loadMessages('2026-06-16', 'main');
    expect(original).toHaveLength(2);
  });

  it('should overwrite target session on copy (idempotent)', () => {
    store.appendMessage('2026-06-16', 'main', makeMessage({ content: 'original' }));
    store.appendMessage('2026-06-16', 'target', makeMessage({ content: 'old' }));

    store.copySession('2026-06-16', 'main', '2026-06-16', 'target');

    const target = store.loadMessages('2026-06-16', 'target');
    expect(target).toHaveLength(1);
    expect(target[0]!.content).toBe('original');
  });

  it('should silently skip if source session does not exist', () => {
    // 不应抛错
    store.copySession('2026-01-01', 'nonexistent', '2026-06-16', 'target');

    const target = store.loadMessages('2026-06-16', 'target');
    expect(target).toHaveLength(0);
  });

  // UX-PP-05 测试
  describe('getFirstUserMessage', () => {
    it('should return the first user message content', () => {
      store.appendMessage('2026-06-16', 'main', makeMessage({ role: 'user', content: '你好，今天天气怎么样？' }));
      store.appendMessage('2026-06-16', 'main', makeMessage({ role: 'assistant', content: '今天天气不错！' }));

      const preview = store.getFirstUserMessage('2026-06-16-main');
      expect(preview).toBe('你好，今天天气怎么样？');
    });

    it('should truncate to 50 characters', () => {
      // 这是一条超过 50 个中文字符的长消息，用于验证截断功能是否按照预期工作，当消息长度超过五十个字符时应该截断并在末尾添加省略号
      const longContent = '这是一条超过五十个中文字符的长消息，用来验证截断功能是否按照预期正常工作，当消息长度超过限定值时应截断并添加省略号。';
      store.appendMessage('2026-06-16', 'main', makeMessage({ role: 'user', content: longContent }));

      const preview = store.getFirstUserMessage('2026-06-16-main');
      expect(preview).toHaveLength(53); // 50 + '...'
      expect(preview.endsWith('...')).toBe(true);
    });

    it('should return empty string when no user message exists', () => {
      store.appendMessage('2026-06-16', 'main', makeMessage({ role: 'assistant', content: 'Hello' }));

      const preview = store.getFirstUserMessage('2026-06-16-main');
      expect(preview).toBe('');
    });

    it('should return empty string for non-existent session', () => {
      const preview = store.getFirstUserMessage('2026-01-01-nonexistent');
      expect(preview).toBe('');
    });
  });

  // FD-09 测试
  describe('deleteSession', () => {
    it('should delete a session and its messages', () => {
      store.appendMessage('2026-06-16', 'main', makeMessage({ content: 'test' }));

      const result = store.deleteSession('2026-06-16-main');
      expect(result).toBe(true);

      const messages = store.loadMessages('2026-06-16', 'main');
      expect(messages).toHaveLength(0);
    });

    it('should return false for non-existent session', () => {
      const result = store.deleteSession('2026-01-01-nonexistent');
      expect(result).toBe(false);
    });

    it('should return false for invalid session ID format', () => {
      const result = store.deleteSession('invalid');
      expect(result).toBe(false);
    });
  });

  describe('renameSession', () => {
    it('should rename a session', () => {
      store.appendMessage('2026-06-16', 'main', makeMessage({ content: 'test' }));

      const result = store.renameSession('2026-06-16-main', 'renamed');
      expect(result).toBe(true);

      // 旧会话名不再存在
      const oldMessages = store.loadMessages('2026-06-16', 'main');
      expect(oldMessages).toHaveLength(0);

      // 新会话名有消息
      const newMessages = store.loadMessages('2026-06-16', 'renamed');
      expect(newMessages).toHaveLength(1);
    });

    it('should return false for non-existent session', () => {
      const result = store.renameSession('2026-01-01-nonexistent', 'new');
      expect(result).toBe(false);
    });

    it('should return false for invalid session ID format', () => {
      const result = store.renameSession('invalid', 'new');
      expect(result).toBe(false);
    });
  });
});
