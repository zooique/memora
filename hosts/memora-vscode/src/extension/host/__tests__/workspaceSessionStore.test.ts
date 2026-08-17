/**
 * WorkspaceSessionStore 单元测试（ISessionStore 契约 + truncateFrom）
 *
 * 覆盖两类：
 *   - ISessionStore 契约（2026-08-17 排雷 P4 补充）：appendMessage/loadMessages 往返、
 *     checkpoints 三件套、metas 三件套、copySession、落盘持久化往返、损坏降级
 *   - truncate-from-turn 语义（2026-08-16 对话闭环管理）：
 *     - 删除目标问答闭环（anchor assistant 向前最近的 user 消息起）到会话末尾
 *     - 目标为最后一条时只删该问答
 *     - 锚点 ts 不存在 → no-op 返回 false
 *     - 空会话 / 全 tool 消息容错
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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

describe('WorkspaceSessionStore ISessionStore 契约', () => {
  /** 临时工作区路径（每用例独立） */
  let dir: string;
  /** 被测实例（默认已 load） */
  let store: WorkspaceSessionStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memora-session-contract-'));
    store = new WorkspaceSessionStore(dir);
    store.load();
  });

  it('appendMessage/loadMessages 往返 + meta 同步（messageCount/updatedAt，ADR-024）', () => {
    store.appendMessage('2026-08-17', 'main', msg('user', '你好', '2026-08-17T00:00:00.000Z'));
    const list = store.loadMessages('2026-08-17', 'main');
    expect(list).toHaveLength(1);
    expect(list[0]?.role).toBe('user');
    expect(list[0]?.content).toBe('你好');
    const meta = store.getSessionMeta('2026-08-17-main');
    expect(meta?.messageCount).toBe(1);
    expect(meta?.title).toBeTruthy();
  });

  it('loadMessages 返回副本：修改返回值不污染存储', () => {
    store.appendMessage('2026-08-17', 'main', msg('user', '原内容', 't1'));
    const list = store.loadMessages('2026-08-17', 'main');
    list[0]!.content = '篡改';
    expect(store.loadMessages('2026-08-17', 'main')[0]?.content).toBe('原内容');
  });

  it('持久化往返：新实例 load 可恢复消息/检查点/标题', () => {
    store.appendMessage('2026-08-17', 'main', msg('user', '你好', 't1'));
    store.saveCheckpoint?.('2026-08-17-main', '{"status":"paused"}');
    store.setSessionTitle?.('2026-08-17-main', '会话一');
    // 模拟重启：同一工作区新建实例并 load
    const reopened = new WorkspaceSessionStore(dir);
    reopened.load();
    expect(reopened.loadMessages('2026-08-17', 'main')).toHaveLength(1);
    expect(reopened.loadCheckpoint?.('2026-08-17-main')).toBe('{"status":"paused"}');
    expect(reopened.getSessionMeta('2026-08-17-main')?.title).toBe('会话一');
  });

  it('saveCheckpoint 覆盖写 + deleteCheckpoint 清除', () => {
    store.saveCheckpoint?.('2026-08-17-main', 'v1');
    store.saveCheckpoint?.('2026-08-17-main', 'v2'); // 覆盖
    expect(store.loadCheckpoint?.('2026-08-17-main')).toBe('v2');
    store.deleteCheckpoint?.('2026-08-17-main');
    expect(store.loadCheckpoint?.('2026-08-17-main')).toBeNull();
  });

  it('setSessionTitle 不改 updatedAt（改名非活跃事件，ADR-024）', () => {
    store.appendMessage('2026-08-17', 'main', msg('user', 'x', '2026-08-17T00:00:00.000Z'));
    const before = store.getSessionMeta('2026-08-17-main')?.updatedAt;
    store.setSessionTitle?.('2026-08-17-main', '改名');
    expect(store.getSessionMeta('2026-08-17-main')?.updatedAt).toBe(before);
    expect(store.getSessionMeta('2026-08-17-main')?.title).toBe('改名');
  });

  it('getSessionMeta 无 meta 的旧会话 → 从消息推导占位（updatedAt=末条时间戳）', () => {
    // 手工构造只有 sessions 无 metas 的旧数据文件（早期版本落盘格式）
    mkdirSync(join(dir, '.memora'), { recursive: true });
    writeFileSync(
      join(dir, '.memora', 'sessions.json'),
      JSON.stringify({
        sessions: {
          '2026-07-01-main': [{ role: 'user', content: '旧', timestamp: '2026-07-01T00:00:00.000Z' }],
        },
        checkpoints: {},
      }),
      'utf8',
    );
    const s = new WorkspaceSessionStore(dir);
    s.load();
    const meta = s.getSessionMeta('2026-07-01-main');
    expect(meta?.messageCount).toBe(1);
    expect(meta?.updatedAt).toBe('2026-07-01T00:00:00.000Z');
  });

  it('listSessionMetas 按 updatedAt 降序（最新在前）', () => {
    store.appendMessage('2026-08-16', 'main', msg('user', 'a', '2026-08-16T00:00:00.000Z'));
    store.appendMessage('2026-08-17', 'main', msg('user', 'b', '2026-08-17T00:00:00.000Z'));
    const metas = store.listSessionMetas();
    expect(metas[0]?.sessionId).toBe('2026-08-17-main');
    expect(metas[1]?.sessionId).toBe('2026-08-16-main');
  });

  it('copySession：复制源会话到目标；目标已存在覆盖；源为空静默返回', () => {
    store.appendMessage('2026-08-17', 'src', msg('user', '源', 't1'));
    store.copySession?.('2026-08-17', 'src', '2026-08-17', 'dst');
    expect(store.loadMessages('2026-08-17', 'dst')).toHaveLength(1);
    // 目标已存在 → 覆盖（非追加）
    store.appendMessage('2026-08-17', 'dst', msg('user', '覆盖', 't2'));
    store.copySession?.('2026-08-17', 'src', '2026-08-17', 'dst');
    expect(store.loadMessages('2026-08-17', 'dst').map((m) => m.content)).toEqual(['源']);
    // 源为空 → 静默返回（不抛错）
    expect(() => store.copySession?.('2026-08-17', 'empty', '2026-08-17', 'dst2')).not.toThrow();
    expect(store.listSessions()).not.toContain('2026-08-17-dst2');
  });

  it('deleteSession：删除消息 + meta + 检查点（连带清检查点防脏残留）', () => {
    store.appendMessage('2026-08-17', 'main', msg('user', '你好', 't1'));
    store.setSessionTitle?.('2026-08-17-main', '会话一');
    store.saveCheckpoint?.('2026-08-17-main', '{"status":"paused"}');
    store.deleteSession('2026-08-17-main');
    expect(store.getSessionMeta('2026-08-17-main')).toBeUndefined();
    expect(store.listSessions()).not.toContain('2026-08-17-main');
    expect(store.loadCheckpoint?.('2026-08-17-main')).toBeNull();
  });

  it('会话文件损坏 → load 降级为空不抛错', () => {
    mkdirSync(join(dir, '.memora'), { recursive: true });
    writeFileSync(join(dir, '.memora', 'sessions.json'), '{invalid json', 'utf8');
    const s = new WorkspaceSessionStore(dir);
    expect(() => s.load()).not.toThrow();
    expect(s.listSessions()).toEqual([]);
    expect(s.loadCheckpoint?.('2026-08-17-main')).toBeNull();
  });
});