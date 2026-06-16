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
});
