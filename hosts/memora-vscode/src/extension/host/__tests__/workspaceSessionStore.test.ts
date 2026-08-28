/**
 * WorkspaceSessionStore 单元测试（ISessionStore 契约 + truncateFrom）
 *
 * 覆盖两类：
 *   - ISessionStore 契约（2026-08-17 排雷 P4 补充）：round 写入/loadMessages 往返、
 *     checkpoints 三件套、metas 三件套、落盘持久化往返、损坏降级
 *   - truncate-from-turn 语义（2026-08-16 对话闭环管理）：
 *     - 删除目标问答闭环（anchor assistant 向前最近的 user 消息起）到会话末尾
 *     - 目标为最后一条时只删该问答
 *     - 锚点 ts 不存在 → no-op 返回 false
 *     - 空会话 / 全 tool 消息容错
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Round } from '@zooique/memora';
import { getSessionDisplayName } from '@zooique/memora';
import { WorkspaceSessionStore } from '../sessionStore.js';
import { WorkspaceRoundStore } from '../workspaceRoundStore.js';

/** 播种一轮问答闭环（round-based：user/assistant 成对写入 RoundStore 并登记 roundId） */
function seedRound(
  store: WorkspaceSessionStore,
  roundStore: WorkspaceRoundStore,
  date: string,
  session: string,
  user: { content: string; ts: string },
  assistant?: { content: string; ts: string },
): string {
  const roundId = `round-${roundStore.size() + 1}`;
  const round: Round = {
    id: roundId,
    userMessage: {
      id: `${roundId}-user`,
      role: 'user',
      content: user.content,
      timestamp: user.ts,
    },
    ...(assistant
      ? {
          assistantMessage: {
            id: `${roundId}-assistant`,
            role: 'assistant',
            content: assistant.content,
            timestamp: assistant.ts,
          },
        }
      : {}),
    status: assistant ? 'complete' : 'pending',
    createdAt: user.ts,
    ...(assistant ? { completedAt: assistant.ts } : {}),
    refCount: 1,
  };
  roundStore.save(round);
  const sessionId = `${date}-${session}`;
  // 先落占位元数据（模拟内核 appendUser 后会话自动出现），再登记 roundId——
  // 使 appendRoundId 内的 messageCount/updatedAt 同步生效（与生产时序一致）
  store.updateSessionMeta(sessionId, {});
  store.appendRoundId(sessionId, roundId);
  return roundId;
}

/** 铺三问答闭环的会话 [u1,a1,u2,a2,u3,a3] */
function seedThreeTurns(store: WorkspaceSessionStore, roundStore: WorkspaceRoundStore): void {
  seedRound(store, roundStore, '2026-08-16', 'main', { content: '问题一', ts: 'u1' }, { content: '回答一', ts: 'a1' });
  seedRound(store, roundStore, '2026-08-16', 'main', { content: '问题二', ts: 'u2' }, { content: '回答二', ts: 'a2' });
  seedRound(store, roundStore, '2026-08-16', 'main', { content: '问题三', ts: 'u3' }, { content: '回答三', ts: 'a3' });
}

describe('WorkspaceSessionStore.truncateFrom', () => {
  /** 临时工作区路径（每用例独立，避免落盘文件互相污染） */
  let store: WorkspaceSessionStore;
  /** 问答闭环物理存储（与 store 共享实例） */
  let roundStore: WorkspaceRoundStore;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'memora-session-test-'));
    roundStore = new WorkspaceRoundStore(dir);
    roundStore.load();
    store = new WorkspaceSessionStore(dir, roundStore);
    store.load();
  });

  it('删除中间问答闭环：截断该问答（anchor 向前最近 user）到会话末尾', () => {
    seedThreeTurns(store, roundStore);
    // 删「回答二 a2」→ 起点为最近 user（u2），截断 u2 及之后 → 剩 [u1,a1]
    expect(store.truncateFrom('2026-08-16', 'main', 'a2')).toBe(true);
    const left = store.loadMessages('2026-08-16', 'main');
    expect(left.map((m) => m.content)).toEqual(['问题一', '回答一']);
  });

  it('删除最后一条问答闭环：只删该问答（u3,a3），保留前两轮', () => {
    seedThreeTurns(store, roundStore);
    expect(store.truncateFrom('2026-08-16', 'main', 'a3')).toBe(true);
    const left = store.loadMessages('2026-08-16', 'main');
    expect(left.map((m) => m.content)).toEqual(['问题一', '回答一', '问题二', '回答二']);
  });

  it('锚点 ts 不存在 → no-op 返回 false，会话不变', () => {
    seedThreeTurns(store, roundStore);
    expect(store.truncateFrom('2026-08-16', 'main', 'not-exist')).toBe(false);
    expect(store.loadMessages('2026-08-16', 'main')).toHaveLength(6);
  });

  it('流式锚点（fromTs 早于存储时间戳）也能命中——下界匹配根治源不一致：删除失效', () => {
    // 真实时序：a1 结束于 09:00:00，流式开始 09:00:05（chatPanel firstChunkTs），a2 存于 09:00:10
    seedRound(store, roundStore, '2026-08-16', 'main',
      { content: '问一', ts: '2026-08-16T09:00:00.000Z' },
      { content: '答一', ts: '2026-08-16T09:00:01.000Z' });
    seedRound(store, roundStore, '2026-08-16', 'main',
      { content: '问二', ts: '2026-08-16T09:00:04.000Z' },
      { content: '答二', ts: '2026-08-16T09:00:10.000Z' });
    // 删除按钮携带的锚点是流开始时刻（09:00:05，早于答二存储时间 09:00:10）
    expect(store.truncateFrom('2026-08-16', 'main', '2026-08-16T09:00:05.000Z')).toBe(true);
    const left = store.loadMessages('2026-08-16', 'main');
    expect(left.map((m) => m.content)).toEqual(['问一', '答一']);
  });

  it('空会话 → false 不抛错', () => {
    expect(store.truncateFrom('2026-08-16', 'main', 'x')).toBe(false);
  });

  it('截断后同步会话标题 messageCount（ADR-024 元数据一致）', () => {
    seedThreeTurns(store, roundStore);
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
  /** 问答闭环物理存储（与 store 共享实例） */
  let roundStore: WorkspaceRoundStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memora-session-contract-'));
    roundStore = new WorkspaceRoundStore(dir);
    roundStore.load();
    store = new WorkspaceSessionStore(dir, roundStore);
    store.load();
  });

  it('round 写入 / loadMessages 往返 + meta 同步（messageCount/updatedAt，ADR-024）', () => {
    seedRound(store, roundStore, '2026-08-17', 'main', { content: '你好', ts: '2026-08-17T00:00:00.000Z' });
    const list = store.loadMessages('2026-08-17', 'main');
    expect(list).toHaveLength(1);
    expect(list[0]?.role).toBe('user');
    expect(list[0]?.content).toBe('你好');
    const meta = store.getSessionMeta('2026-08-17-main');
    // round-based 估算：单个问答闭环计为 2 条（内核同款 roundIds.length*2）
    expect(meta?.messageCount).toBe(2);
    expect(meta?.displayName).toBeTruthy();
  });

  it('loadMessages 返回副本：修改返回值不污染存储', () => {
    seedRound(store, roundStore, '2026-08-17', 'main', { content: '原内容', ts: 't1' });
    const list = store.loadMessages('2026-08-17', 'main');
    list[0]!.content = '篡改';
    expect(store.loadMessages('2026-08-17', 'main')[0]?.content).toBe('原内容');
  });

  it('持久化往返：新实例 load 可恢复消息/检查点/标题', () => {
    seedRound(store, roundStore, '2026-08-17', 'main', { content: '你好', ts: 't1' });
    store.saveCheckpoint?.('2026-08-17-main', '{"status":"paused"}');
    store.setSessionTitle?.('2026-08-17-main', '会话一');
    // 模拟重启：同一工作区新建实例并 load
    const reopened = new WorkspaceSessionStore(dir);
    reopened.load();
    expect(reopened.loadMessages('2026-08-17', 'main')).toHaveLength(1);
    expect(reopened.loadCheckpoint?.('2026-08-17-main')).toBe('{"status":"paused"}');
    expect(reopened.getSessionMeta('2026-08-17-main')?.displayName).toBe('会话一');
  });

  it('saveCheckpoint 覆盖写 + deleteCheckpoint 清除', () => {
    store.saveCheckpoint?.('2026-08-17-main', 'v1');
    store.saveCheckpoint?.('2026-08-17-main', 'v2'); // 覆盖
    expect(store.loadCheckpoint?.('2026-08-17-main')).toBe('v2');
    store.deleteCheckpoint?.('2026-08-17-main');
    expect(store.loadCheckpoint?.('2026-08-17-main')).toBeNull();
  });

  it('setSessionTitle 不改 updatedAt（改名非活跃事件，ADR-024）', () => {
    seedRound(store, roundStore, '2026-08-17', 'main', { content: 'x', ts: '2026-08-17T00:00:00.000Z' });
    const before = store.getSessionMeta('2026-08-17-main')?.updatedAt;
    store.setSessionTitle?.('2026-08-17-main', '改名');
    expect(store.getSessionMeta('2026-08-17-main')?.updatedAt).toBe(before);
    expect(store.getSessionMeta('2026-08-17-main')?.displayName).toBe('改名');
  });

  it('listSessionMetas 按 updatedAt 降序（最新在前）', () => {
    // updatedAt = 写入时刻（new Date().toISOString()），非消息 timestamp——
    // 用 fake timers 确定性制造两次写入的时间差，避免毫秒级竞态导致排序不稳定
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-16T10:00:00.000Z'));
      seedRound(store, roundStore, '2026-08-16', 'main', { content: 'a', ts: '2026-08-16T00:00:00.000Z' });
      vi.setSystemTime(new Date('2026-08-17T10:00:00.000Z'));
      seedRound(store, roundStore, '2026-08-17', 'main', { content: 'b', ts: '2026-08-17T00:00:00.000Z' });
      const metas = store.listSessionMetas();
      expect(metas[0]?.sessionId).toBe('2026-08-17-main');
      expect(metas[1]?.sessionId).toBe('2026-08-16-main');
    } finally {
      vi.useRealTimers();
    }
  });

  it('deleteSession：删除消息 + meta + 检查点（连带清检查点防脏残留）', () => {
    seedRound(store, roundStore, '2026-08-17', 'main', { content: '你好', ts: 't1' });
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

describe('WorkspaceSessionStore.updateSessionMeta（ADR-024 双层命名写点，2026-08-26 排雷）', () => {
  /** 临时工作区路径（每用例独立） */
  let dir: string;
  let store: WorkspaceSessionStore;
  /** 问答闭环物理存储（与 store 共享实例） */
  let roundStore: WorkspaceRoundStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memora-session-updateMeta-'));
    roundStore = new WorkspaceRoundStore(dir);
    roundStore.load();
    store = new WorkspaceSessionStore(dir, roundStore);
    store.load();
  });

  it('SessionNamer 首轮自动命名：写入 autoName+displayName，历史列表显示真实名', () => {
    seedRound(store, roundStore, '2026-08-26', 'main', { content: '帮我写排序算法', ts: 't1' });
    // 模拟内核 SessionNamer.ensureSessionTitle 首轮写入（autoName 与 displayName 同值）
    store.updateSessionMeta('2026-08-26-main', {
      autoName: '排序算法实现',
      displayName: '排序算法实现',
    });
    const meta = store.getSessionMeta('2026-08-26-main');
    expect(meta?.autoName).toBe('排序算法实现');
    expect(meta?.displayName).toBe('排序算法实现');
    // 历史列表标题（getSessionDisplayName 优先 displayName）
    expect(getSessionDisplayName(meta)).toBe('排序算法实现');
    // 推送历史列表时透出真实名（复刻 pushSessionList 的 title 取值）
    expect(
      store
        .listSessionMetas()
        .some((m) => m.sessionId === '2026-08-26-main' && getSessionDisplayName(m) === '排序算法实现'),
    ).toBe(true);
  });

  it('首轮自动命名覆盖占位 displayName（解决"历史不显示名字"）', () => {
    // round 登记后 getSessionMeta 兜底提供占位「新会话 HH:MM」
    seedRound(store, roundStore, '2026-08-26', 'main', { content: 'x', ts: 't1' });
    expect(getSessionDisplayName(store.getSessionMeta('2026-08-26-main'))).toMatch(/^新会话 /);
    // 首轮对话后 SessionNamer 写入真实名 → 覆盖占位
    store.updateSessionMeta('2026-08-26-main', {
      autoName: '真实标题',
      displayName: '真实标题',
    });
    expect(getSessionDisplayName(store.getSessionMeta('2026-08-26-main'))).toBe('真实标题');
  });

  it('手动改名（renameSession）：仅改 displayName，保留 autoName（双层解耦）', () => {
    seedRound(store, roundStore, '2026-08-26', 'main', { content: 'x', ts: 't1' });
    store.updateSessionMeta('2026-08-26-main', {
      autoName: '自动名',
      displayName: '自动名',
    });
    // 用户手动改名：只传 displayName
    store.updateSessionMeta('2026-08-26-main', { displayName: '我改的名' });
    const meta = store.getSessionMeta('2026-08-26-main');
    expect(meta?.autoName).toBe('自动名'); // 保留 LLM 只读名
    expect(meta?.displayName).toBe('我改的名'); // 覆盖
    expect(getSessionDisplayName(meta)).toBe('我改的名'); // 显示名优先用户改的
  });

  it('setSessionTitle 仍工作且保留 autoName（单一写点回归，改名不 wipe 只读名）', () => {
    seedRound(store, roundStore, '2026-08-26', 'main', { content: 'x', ts: 't1' });
    store.updateSessionMeta('2026-08-26-main', {
      autoName: '自动名',
      displayName: '自动名',
    });
    store.setSessionTitle('2026-08-26-main', '改名');
    const meta = store.getSessionMeta('2026-08-26-main');
    expect(meta?.displayName).toBe('改名');
    expect(meta?.autoName).toBe('自动名'); // 改名经 updateSessionMeta 收口，不抹除 autoName
  });

  it('改名不改 updatedAt（与 setSessionTitle 旧契约一致）', () => {
    seedRound(store, roundStore, '2026-08-26', 'main', { content: 'x', ts: '2026-08-26T00:00:00.000Z' });
    const before = store.getSessionMeta('2026-08-26-main')?.updatedAt;
    store.updateSessionMeta('2026-08-26-main', { displayName: '改名' });
    expect(store.getSessionMeta('2026-08-26-main')?.updatedAt).toBe(before);
  });
});

describe('WorkspaceRoundStore processEvents 落盘透传与生命周期随动（v1.5 单文件内聚）', () => {
  /** 临时工作区路径 */
  let dir: string;
  /** 问答闭环物理存储（JSON 落盘） */
  let roundStore: WorkspaceRoundStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memora-roundstore-events-'));
    roundStore = new WorkspaceRoundStore(dir);
    roundStore.load();
  });

  it('processEvents 随 Round JSON 落盘：save → 新实例重载 → 完整找回（磁盘透传）', () => {
    const round: Round = {
      id: 'round-e1',
      userMessage: { id: 'u1', role: 'user', content: '问题', timestamp: 't1' },
      assistantMessage: { id: 'a1', role: 'assistant', content: '回答', timestamp: 't2' },
      status: 'complete',
      createdAt: 't1',
      completedAt: 't2',
      refCount: 1,
      processEvents: [
        { type: 'meta', seq: 1, ts: 't1', payload: { role: '文档设计师', llm: 'deepseek-chat' } },
        { type: 'recall', seq: 2, ts: 't1', payload: { memories: [{ id: 'r:1', name: '设计约束', source: 'round-summary', score: 0.8 }] } },
        { type: 'aborted', seq: 3, ts: 't2', payload: { reason: 'User cancelled the conversation' } },
      ],
    };
    roundStore.save(round);

    // 模拟重启：新实例从磁盘 load（JSON.stringify/parse 往返）
    roundStore = new WorkspaceRoundStore(dir);
    roundStore.load();
    const retrieved = roundStore.getById('round-e1');
    expect(retrieved?.processEvents).toEqual(round.processEvents);
    expect(retrieved?.processEvents?.map((e) => e.type)).toEqual(['meta', 'recall', 'aborted']);
  });

  it('删除 round 即删 processEvents（生命周期原子，无独立文件需联动）', () => {
    const round: Round = {
      id: 'round-e2',
      userMessage: { id: 'u1', role: 'user', content: '问题', timestamp: 't1' },
      status: 'pending',
      createdAt: 't1',
      refCount: 0,
      processEvents: [
        { type: 'meta', seq: 1, ts: 't1', payload: { role: 'AI', llm: 'm' } },
      ],
    };
    roundStore.save(round);

    // refCount=0 可直接删除（GC 孤儿回收 / 宿主主动删除同路径）
    expect(roundStore.delete('round-e2')).toBe(true);
    expect(roundStore.getById('round-e2')).toBeNull();
  });

  it('分叉共享 roundId 即共享 processEvents（指针复制，任一引用存在则不删）', () => {
    const round: Round = {
      id: 'round-e3',
      userMessage: { id: 'u1', role: 'user', content: '问题', timestamp: 't1' },
      assistantMessage: { id: 'a1', role: 'assistant', content: '回答', timestamp: 't2' },
      status: 'complete',
      createdAt: 't1',
      completedAt: 't2',
      refCount: 2, // 两个会话引用（分叉后）
      processEvents: [
        { type: 'meta', seq: 1, ts: 't1', payload: { role: 'AI', llm: 'm' } },
      ],
    };
    roundStore.save(round);
    // refCount>0 → 不可删除（任一会话仍引用），事件随文件保留
    expect(roundStore.delete('round-e3')).toBe(false);
    expect(roundStore.getById('round-e3')?.processEvents).toBeDefined();
  });
});