/**
 * WorkspaceSessionStore.truncateFrom 单元测试（2026-08-16 对话闭环管理）
 *
 * 覆盖 truncate-from-turn 语义：
 *   - 删除目标问答闭环（anchor assistant 向前最近的 user 消息起）到会话末尾
 *   - 目标为最后一条时只删该问答
 *   - 锚点 ts 不存在 → no-op 返回 false
 *   - 空会话 / 全 tool 消息容错
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionMessage } from '@zooique/memora';
import { WorkspaceSessionStore } from '../sessionStore.js';

/** 构造一条会话消息（role/content/timestamp） */
function msg(role: SessionMessage['role'], content: string, ts: string): SessionMessage {
  return { role, content, timestamp: ts };
}

/** 铺三问答闭环的会话 [u1,a1,u2,a2,u3,a3] */
function seedThreeTurns(store: WorkspaceSessionStore): void {
  store.appendMessage('2026-08-16', 'main', msg('user', '问题一', 'u1'));
  store.appendMessage('2026-08-16', 'main', msg('assistant', '回答一', 'a1'));
  store.appendMessage('2026-08-16', 'main', msg('user', '问题二', 'u2'));
  store.appendMessage('2026-08-16', 'main', msg('assistant', '回答二', 'a2'));
  store.appendMessage('2026-08-16', 'main', msg('user', '问题三', 'u3'));
  store.appendMessage('2026-08-16', 'main', msg('assistant', '回答三', 'a3'));
}

describe('WorkspaceSessionStore.truncateFrom', () => {
  /** 临时工作区路径（每用例独立，避免落盘文件互相污染） */
  let store: WorkspaceSessionStore;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'memora-session-test-'));
    store = new WorkspaceSessionStore(dir);
    store.load();
  });

  it('删除中间问答闭环：截断该问答（anchor 向前最近 user）到会话末尾', () => {
    seedThreeTurns(store);
    // 删「回答二 a2」→ 起点为最近 user（u2），截断 u2 及之后 → 剩 [u1,a1]
    expect(store.truncateFrom('2026-08-16', 'main', 'a2')).toBe(true);
    const left = store.loadMessages('2026-08-16', 'main');
    expect(left.map((m) => m.content)).toEqual(['问题一', '回答一']);
  });

  it('删除最后一条问答闭环：只删该问答（u3,a3），保留前两轮', () => {
    seedThreeTurns(store);
    expect(store.truncateFrom('2026-08-16', 'main', 'a3')).toBe(true);
    const left = store.loadMessages('2026-08-16', 'main');
    expect(left.map((m) => m.content)).toEqual(['问题一', '回答一', '问题二', '回答二']);
  });

  it('锚点 ts 不存在 → no-op 返回 false，会话不变', () => {
    seedThreeTurns(store);
    expect(store.truncateFrom('2026-08-16', 'main', 'not-exist')).toBe(false);
    expect(store.loadMessages('2026-08-16', 'main')).toHaveLength(6);
  });

  it('流式锚点（fromTs 早于存储时间戳）也能命中——下界匹配根治源不一致：删除失效', () => {
    // 真实时序：a1 结束于 09:00:00，流式开始 09:00:05（chatPanel firstChunkTs），a2 存于 09:00:10
    store.appendMessage('2026-08-16', 'main', msg('user', '问一', '2026-08-16T09:00:00.000Z'));
    store.appendMessage('2026-08-16', 'main', msg('assistant', '答一', '2026-08-16T09:00:01.000Z'));
    store.appendMessage('2026-08-16', 'main', msg('user', '问二', '2026-08-16T09:00:04.000Z'));
    store.appendMessage('2026-08-16', 'main', msg('assistant', '答二', '2026-08-16T09:00:10.000Z'));
    // 删除按钮携带的锚点是流开始时刻（09:00:05，早于答二存储时间 09:00:10）
    expect(store.truncateFrom('2026-08-16', 'main', '2026-08-16T09:00:05.000Z')).toBe(true);
    const left = store.loadMessages('2026-08-16', 'main');
    expect(left.map((m) => m.content)).toEqual(['问一', '答一']);
  });

  it('空会话 → false 不抛错', () => {
    expect(store.truncateFrom('2026-08-16', 'main', 'x')).toBe(false);
  });

  it('截断后同步会话标题 messageCount（ADR-024 元数据一致）', () => {
    seedThreeTurns(store);
    store.truncateFrom('2026-08-16', 'main', 'a2');
    const meta = store.getSessionMeta('2026-08-16-main');
    expect(meta?.messageCount).toBe(2);
  });
});