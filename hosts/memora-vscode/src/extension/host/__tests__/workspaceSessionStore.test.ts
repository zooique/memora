/**
 * WorkspaceSessionStore 单元测试（ISessionStore 契约 + truncateFrom）
 *
 * 覆盖两类：
 *   - ISessionStore 契约：round 写入/loadMessages 往返、
 *     metas 三件套、落盘持久化往返、损坏降级
 *   - truncate-from-turn 语义（对话闭环管理，锚 = Round.id）：
 *     - 删除目标轮及其之后所有轮（身份精确定位，不做时间窗猜测）
 *     - 目标为最后一轮时只删该轮
 *     - 锚点 roundId 不存在 → no-op 返回 false
 *     - 相邻两个中断轮（DELETE-ANCHOR-1 形态）不得删错目标
 *     - 空会话 / 全 tool 消息容错
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Round } from '@zooique/memora';
import { getSessionDisplayName } from '@zooique/memora';
import { WorkspaceSessionStore } from '../sessionStore.js';
import { WorkspaceRoundStore } from '../workspaceRoundStore.js';
// 临时目录统一入口：建目录 + 模块顶层注册清理（禁止裸 mkdtempSync，见 helpers/tmpDir.ts）
import { makeTempDir } from '../../../__tests__/helpers/tmpDir.js';

/** 播种一轮问答闭环（round-based：user/assistant 成对写入 RoundStore 并登记 roundId）
 *
 *  @param status 覆盖轮状态（缺省 assistant ? 'complete' : 'pending'）——
 *        用于播种「中断收场轮」（'interrupted'）等非 complete 终态
 */
function seedRound(
  store: WorkspaceSessionStore,
  roundStore: WorkspaceRoundStore,
  date: string,
  session: string,
  user: { content: string; ts: string },
  assistant?: { content: string; ts: string },
  status?: Round['status'],
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
    status: status ?? (assistant ? 'complete' : 'pending'),
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
  seedRound(
    store,
    roundStore,
    '2026-08-16',
    'main',
    { content: '问题一', ts: 'u1' },
    { content: '回答一', ts: 'a1' },
  );
  seedRound(
    store,
    roundStore,
    '2026-08-16',
    'main',
    { content: '问题二', ts: 'u2' },
    { content: '回答二', ts: 'a2' },
  );
  seedRound(
    store,
    roundStore,
    '2026-08-16',
    'main',
    { content: '问题三', ts: 'u3' },
    { content: '回答三', ts: 'a3' },
  );
}

/**
 * 铺 [中断, 中断, 完成]：DELETE-ANCHOR-1 的复现形态。
 *
 * 旧 ts 锚在此形态必然出错——两个中断轮都没有 assistant ts 可命中，下界匹配落到第三轮的
 * assistant，而「上折回」只能退一层（退到第二轮），于是点第一轮的删除会删掉第三轮、
 * 第一轮原地不动（静默删错目标）。按 roundId 定位则与形态无关。
 */
function seedTwoInterruptedThenDone(
  store: WorkspaceSessionStore,
  roundStore: WorkspaceRoundStore,
): void {
  const seed = (
    content: string,
    ts: string,
    assistant?: { content: string; ts: string },
    status?: 'interrupted',
  ): string =>
    seedRound(store, roundStore, '2026-08-16', 'main', { content, ts }, assistant, status);
  seed('问题一', '2026-08-16T09:00:00.000Z', undefined, 'interrupted');
  seed('问题二', '2026-08-16T09:00:04.000Z', undefined, 'interrupted');
  seed('问题三', '2026-08-16T09:00:10.000Z', {
    content: '回答三',
    ts: '2026-08-16T09:00:11.000Z',
  });
}

describe('WorkspaceSessionStore.truncateFrom', () => {
  /** 临时工作区路径（每用例独立，避免落盘文件互相污染） */
  let store: WorkspaceSessionStore;
  /** 问答闭环物理存储（与 store 共享实例） */
  let roundStore: WorkspaceRoundStore;

  beforeEach(() => {
    const dir = makeTempDir('memora-session-test-');
    roundStore = new WorkspaceRoundStore(dir);
    roundStore.load();
    store = new WorkspaceSessionStore(dir, roundStore);
    store.load();
  });

  it('删除中间轮：从该轮截断到会话末尾（按身份定位，不做时间窗猜测）', () => {
    seedThreeTurns(store, roundStore);
    // 删 round-2 → 截断 round-2 及之后 → 剩 [问题一, 回答一]
    const res = store.truncateFrom('2026-08-16', 'main', 'round-2');
    expect(res.ok).toBe(true);
    const left = store.loadMessages('2026-08-16', 'main');
    expect(left.map((m) => m.content)).toEqual(['问题一', '回答一']);
    // 被回收（引用归零）的 Round 列表返回，供联动软删记忆摘要（⑥）：round-2/round-3 全删
    expect(res.removedIds).toEqual(['round-2', 'round-3']);
  });

  it('删除最后一条问答闭环：只删该轮，保留前两轮', () => {
    seedThreeTurns(store, roundStore);
    const res = store.truncateFrom('2026-08-16', 'main', 'round-3');
    expect(res.ok).toBe(true);
    expect(res.removedIds).toEqual(['round-3']);
    const left = store.loadMessages('2026-08-16', 'main');
    expect(left.map((m) => m.content)).toEqual(['问题一', '回答一', '问题二', '回答二']);
  });

  it('锚点 roundId 不存在 → no-op 返回 false，会话不变（陈旧 DOM 不许误删）', () => {
    seedThreeTurns(store, roundStore);
    expect(store.truncateFrom('2026-08-16', 'main', 'round-404').ok).toBe(false);
    expect(store.loadMessages('2026-08-16', 'main')).toHaveLength(6);
  });

  it('截断结果带出起点轮的 user 原文（COPY-2 regenerate 重发真源）', () => {
    seedThreeTurns(store, roundStore);
    // 锚 round-3 → removedUserText = 该轮 user 原文（问题三），重发文本以 store 为准
    const res = store.truncateFrom('2026-08-16', 'main', 'round-3');
    expect(res.ok).toBe(true);
    expect(res.removedUserText).toBe('问题三');
  });

  it('空会话 → false 不抛错', () => {
    expect(store.truncateFrom('2026-08-16', 'main', 'round-1').ok).toBe(false);
  });

  it('截断后同步会话标题 messageCount（元数据一致）', () => {
    seedThreeTurns(store, roundStore);
    store.truncateFrom('2026-08-16', 'main', 'round-2');
    const meta = store.getSessionMeta('2026-08-16-main');
    expect(meta?.messageCount).toBe(2);
  });

  it('末尾中断轮（无 assistant 收场）可按身份删除——不再依赖「锚 >= 末轮 user ts」兜底', () => {
    seedRound(
      store,
      roundStore,
      '2026-08-16',
      'main',
      { content: '问题一', ts: '2026-08-16T09:00:00.000Z' },
      { content: '回答一', ts: '2026-08-16T09:00:01.000Z' },
    );
    seedRound(
      store,
      roundStore,
      '2026-08-16',
      'main',
      { content: '问题二', ts: '2026-08-16T09:00:04.000Z' },
      undefined,
      'interrupted',
    );
    const res = store.truncateFrom('2026-08-16', 'main', 'round-2');
    expect(res.ok).toBe(true);
    expect(res.removedIds).toEqual(['round-2']);
    const left = store.loadMessages('2026-08-16', 'main');
    expect(left.map((m) => m.content)).toEqual(['问题一', '回答一']);
  });

  it('删除中间中断轮（无 assistant 收场）：按身份截断，连其后完成轮一并删', () => {
    seedRound(
      store,
      roundStore,
      '2026-08-16',
      'main',
      { content: '问题一', ts: '2026-08-16T09:00:00.000Z' },
      { content: '回答一', ts: '2026-08-16T09:00:01.000Z' },
    );
    seedRound(
      store,
      roundStore,
      '2026-08-16',
      'main',
      { content: '问题二', ts: '2026-08-16T09:00:04.000Z' },
      undefined,
      'interrupted',
    );
    seedRound(
      store,
      roundStore,
      '2026-08-16',
      'main',
      { content: '问题三', ts: '2026-08-16T09:00:10.000Z' },
      { content: '回答三', ts: '2026-08-16T09:00:11.000Z' },
    );
    // 锚 = 中断轮自身 roundId：截断面与 done 轮完全一致，不再需要「上折回」这种时间窗猜测
    const res = store.truncateFrom('2026-08-16', 'main', 'round-2');
    expect(res.ok).toBe(true);
    expect(res.removedIds).toEqual(['round-2', 'round-3']);
    const left = store.loadMessages('2026-08-16', 'main');
    expect(left.map((m) => m.content)).toEqual(['问题一', '回答一']);
  });

  it('done 轮删除：前一轮是中断轮也不误折（锚是身份，不存在「折回」这一步）', () => {
    seedRound(
      store,
      roundStore,
      '2026-08-16',
      'main',
      { content: '问题一', ts: '2026-08-16T09:00:00.000Z' },
      { content: '回答一', ts: '2026-08-16T09:00:01.000Z' },
    );
    seedRound(
      store,
      roundStore,
      '2026-08-16',
      'main',
      { content: '问题二', ts: '2026-08-16T09:00:04.000Z' },
      undefined,
      'interrupted',
    );
    seedRound(
      store,
      roundStore,
      '2026-08-16',
      'main',
      { content: '问题三', ts: '2026-08-16T09:00:10.000Z' },
      { content: '回答三', ts: '2026-08-16T09:00:11.000Z' },
    );
    const res = store.truncateFrom('2026-08-16', 'main', 'round-3');
    expect(res.ok).toBe(true);
    expect(res.removedIds).toEqual(['round-3']);
    const left = store.loadMessages('2026-08-16', 'main');
    expect(left.map((m) => m.content)).toEqual(['问题一', '回答一', '问题二']);
  });

  it('DELETE-ANCHOR-1 相邻两个中断轮：删第二个只删它与其后完成轮，首轮保留', () => {
    seedTwoInterruptedThenDone(store, roundStore);
    const res = store.truncateFrom('2026-08-16', 'main', 'round-2');
    expect(res.ok).toBe(true);
    expect(res.removedIds).toEqual(['round-2', 'round-3']);
    const left = store.loadMessages('2026-08-16', 'main');
    expect(left.map((m) => m.content)).toEqual(['问题一']);
  });

  it('DELETE-ANCHOR-1 相邻两个中断轮：删第一个清空会话（旧 ts 锚会删第三轮、留下首轮）', () => {
    seedTwoInterruptedThenDone(store, roundStore);
    const res = store.truncateFrom('2026-08-16', 'main', 'round-1');
    expect(res.ok).toBe(true);
    expect(res.removedIds).toEqual(['round-1', 'round-2', 'round-3']);
    expect(store.loadMessages('2026-08-16', 'main')).toEqual([]);
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
    dir = makeTempDir('memora-session-contract-');
    roundStore = new WorkspaceRoundStore(dir);
    roundStore.load();
    store = new WorkspaceSessionStore(dir, roundStore);
    store.load();
  });

  it('round 写入 / loadMessages 往返 + meta 同步（messageCount/updatedAt）', () => {
    seedRound(store, roundStore, '2026-08-17', 'main', {
      content: '你好',
      ts: '2026-08-17T00:00:00.000Z',
    });
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

  it('loadMessages：interrupted 轮同样展开 user+assistant（与内核同口径，漏计即丢 LLM 上下文）', () => {
    // 与内核 inMemorySessionStore.loadMessages 逐字同构；判据同为 isRoundSettled。
    // 中断轮 = 等同用户点停止的正常 turn，重开会话后须能把该轮回复注入 LLM 历史。
    seedRound(
      store,
      roundStore,
      '2026-08-17',
      'main',
      { content: '被取消的提问', ts: 'i1' },
      { content: '半截回答', ts: 'i2' },
      'interrupted',
    );
    const list = store.loadMessages('2026-08-17', 'main');
    expect(list).toHaveLength(2);
    expect(list[1]?.role).toBe('assistant');
    expect(list[1]?.content).toBe('半截回答');
    // O(1) 缓存口径（roundIds.length * 2）与精确口径仍等价
    expect(store.getSessionMeta('2026-08-17-main')?.messageCount).toBe(2);
  });

  it('loadMessages：窗口内轮次带 attachments，窗口外衰减（生产路径，真机断点B）', () => {
    // restoreHistory 生产链唯一上游（switchToSession → loadSessionMessages → 本方法）。
    // 真机验收 IMG-2 第 13 子块：本方法曾丢 attachments ⇒ 重启后历史图全灭（模型只见
    // 纯文本连占位都没有）；判据与内核 messageHistory.loadRoundBasedMessages 同构。
    const ref: import('@zooique/memora').ImageRef = {
      sha256: 'a'.repeat(64),
      mime: 'image/png',
      width: 64,
      height: 32,
      bytes: 1234,
      name: 'hist.png',
    };
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const roundId = `round-img-${i}`;
      ids.push(roundId);
      roundStore.save({
        id: roundId,
        userMessage: {
          id: `${roundId}-user`,
          role: 'user',
          content: `带图轮 ${i}`,
          timestamp: `2026-08-17T00:0${i}:00.000Z`,
          attachments: [ref],
        },
        assistantMessage: {
          id: `${roundId}-assistant`,
          role: 'assistant',
          content: `答 ${i}`,
          timestamp: `2026-08-17T00:0${i}:30.000Z`,
        },
        status: 'complete',
        createdAt: `2026-08-17T00:0${i}:00.000Z`,
        completedAt: `2026-08-17T00:0${i}:30.000Z`,
        refCount: 1,
      });
    }
    store.setRoundIds('2026-08-17-main', ids);

    const list = store.loadMessages('2026-08-17', 'main');
    expect(list).toHaveLength(12);
    // currentIdx=5，窗口 RETAIN_IMAGE_ROUNDS=4 → 第 2..5 轮带图，第 0/1 轮衰减
    const users = list.filter((m) => m.role === 'user');
    expect(users[0]?.attachments).toBeUndefined();
    expect(users[1]?.attachments).toBeUndefined();
    expect(users[2]?.attachments).toEqual([ref]);
    expect(users[5]?.attachments).toEqual([ref]);
    // 衰减只剥图：content/roundId 恒不变（文本永不衰减）
    expect(users[0]?.content).toBe('带图轮 0');
    expect(users[0]?.roundId).toBe('round-img-0');
  });

  it('持久化往返：新实例 load 可恢复消息/标题', () => {
    seedRound(store, roundStore, '2026-08-17', 'main', { content: '你好', ts: 't1' });
    store.setSessionTitle?.('2026-08-17-main', '会话一');
    // 模拟重启：同一工作区新建实例并 load
    const reopened = new WorkspaceSessionStore(dir);
    reopened.load();
    expect(reopened.loadMessages('2026-08-17', 'main')).toHaveLength(1);
    expect(reopened.getSessionMeta('2026-08-17-main')?.displayName).toBe('会话一');
  });

  it('setSessionTitle 不改 updatedAt（改名非活跃事件）', () => {
    seedRound(store, roundStore, '2026-08-17', 'main', {
      content: 'x',
      ts: '2026-08-17T00:00:00.000Z',
    });
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
      seedRound(store, roundStore, '2026-08-16', 'main', {
        content: 'a',
        ts: '2026-08-16T00:00:00.000Z',
      });
      vi.setSystemTime(new Date('2026-08-17T10:00:00.000Z'));
      seedRound(store, roundStore, '2026-08-17', 'main', {
        content: 'b',
        ts: '2026-08-17T00:00:00.000Z',
      });
      const metas = store.listSessionMetas();
      expect(metas[0]?.sessionId).toBe('2026-08-17-main');
      expect(metas[1]?.sessionId).toBe('2026-08-16-main');
    } finally {
      vi.useRealTimers();
    }
  });

  it('deleteSession：删除消息 + meta + 回收无会话引用 Round（派生集合判 0）', () => {
    const roundId = seedRound(store, roundStore, '2026-08-17', 'main', {
      content: '你好',
      ts: 't1',
    });
    store.setSessionTitle?.('2026-08-17-main', '会话一');
    const removedIds = store.deleteSession('2026-08-17-main');
    expect(store.getSessionMeta('2026-08-17-main')).toBeUndefined();
    expect(store.listSessions()).not.toContain('2026-08-17-main');
    // 先注销会话 roundIds → 现场派生引用集合判 0 ⇒ 移入回收站（不再读 refCount）
    expect(roundStore.getById(roundId)).toBeNull();
    // 返回值 = 被回收的 Round 列表（供调用方联动软删记忆摘要）
    expect(removedIds).toEqual([roundId]);
  });

  it('deleteSession：分叉共享轮安全保留（仍被其他会话 roundIds 引用）', () => {
    const roundId = seedRound(store, roundStore, '2026-08-17', 'main', { content: 'x', ts: 't1' });
    // 分叉引用 = 另一会话 roundIds 共享同一 Round（指针复制，refCount 不变）
    store.setRoundIds('2026-08-17-fork', [roundId]);
    const removedIds = store.deleteSession('2026-08-17-main');
    // Round 仍被分叉会话引用 → 保留（delete 不再有 refCount 护栏，保护来自引用集合派生）
    expect(roundStore.getById(roundId)).not.toBeNull();
    // 返回值不含共享轮（未回收 → 不联动记忆，共享会话摘要保留）
    expect(removedIds).toEqual([]);
    // 会话侧指针已清除
    expect(store.getSessionMeta('2026-08-17-main')).toBeUndefined();
  });

  it('会话文件损坏 → load 降级为空不抛错', () => {
    mkdirSync(join(dir, '.memora'), { recursive: true });
    writeFileSync(join(dir, '.memora', 'sessions.json'), '{invalid json', 'utf8');
    const s = new WorkspaceSessionStore(dir);
    expect(() => s.load()).not.toThrow();
    expect(s.listSessions()).toEqual([]);
  });
});

describe('WorkspaceSessionStore.updateSessionMeta（双层命名写点）', () => {
  /** 临时工作区路径（每用例独立） */
  let dir: string;
  let store: WorkspaceSessionStore;
  /** 问答闭环物理存储（与 store 共享实例） */
  let roundStore: WorkspaceRoundStore;

  beforeEach(() => {
    dir = makeTempDir('memora-session-updateMeta-');
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
        .some(
          (m) => m.sessionId === '2026-08-26-main' && getSessionDisplayName(m) === '排序算法实现',
        ),
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
    seedRound(store, roundStore, '2026-08-26', 'main', {
      content: 'x',
      ts: '2026-08-26T00:00:00.000Z',
    });
    const before = store.getSessionMeta('2026-08-26-main')?.updatedAt;
    store.updateSessionMeta('2026-08-26-main', { displayName: '改名' });
    expect(store.getSessionMeta('2026-08-26-main')?.updatedAt).toBe(before);
  });

  it('无既有 meta 时 messageCount 由 roundIds 派生（分叉路径禁写 0）+ createdAt 不丢', () => {
    // 复刻内核 messageHistory.forkSession 时序（setRoundIds → updateSessionMeta）：分叉只搬
    // Round 指针 + 写 createdAt，**不预建 meta**。此刻 setRoundIds 内的计数回写因
    // `if (!meta) return` 提前退出，故 updateSessionMeta 走的是「无既有 meta」分支——
    // 该分支若写 0，分叉会话的 meta 就留下假值 0（getSessionMeta 见 meta 即返回，
    // 不走占位兜底）。
    store.setRoundIds('2026-09-21-forked', ['round-f1', 'round-f2', 'round-f3']);
    // meta 尚未落库 → getSessionMeta 走 roundIds 占位兜底（真值 3 轮 = 6 条）
    expect(store.getSessionMeta('2026-09-21-forked')?.messageCount).toBe(6);

    store.updateSessionMeta('2026-09-21-forked', { createdAt: '2026-09-21T00:00:00.000Z' });

    const meta = store.getSessionMeta('2026-09-21-forked');
    // 与内核 InMemorySessionStore.deriveMessageCount 同源：roundIds.length * 2
    expect(meta?.messageCount).toBe(6);
    // 合并语义是「基底 + 覆盖」而非白名单重建：内核传入的 createdAt 必须留存
    expect(meta?.createdAt).toBe('2026-09-21T00:00:00.000Z');

    // 落盘真相源复核：createdAt 一旦丢弃即不可恢复，须经 JSON 往返仍在
    const reopened = new WorkspaceSessionStore(dir);
    reopened.load();
    const persisted = reopened.getSessionMeta('2026-09-21-forked');
    expect(persisted?.createdAt).toBe('2026-09-21T00:00:00.000Z');
    expect(persisted?.messageCount).toBe(6);
  });

  // ── 归档防重快照（archivedMessageCount）透传与保护 ──
  // 背景：内核 SessionArchiver 把「上次实际归档时的消息数」并入既有 updateSessionMeta
  // 的 partialMeta 同批落盘（ARCH-GAP-2 排雷修复）。本宿主是该字段的落盘真相源 ⇒ 透传
  // 与「缺省不抹既有」必须在此钉死，否则跨进程防重在真实环境静默失效。

  it('归档防重快照透传：updateSessionMeta 写入 → getSessionMeta 读回', () => {
    seedRound(store, roundStore, '2026-10-19', 'main', { content: '第一问', ts: 't1' });
    store.updateSessionMeta('2026-10-19-main', { archivedMessageCount: 6 });

    expect(store.getSessionMeta('2026-10-19-main')?.archivedMessageCount).toBe(6);
  });

  it('归档防重快照：后续写入其他字段不被抹（缺省 = 保留既有）', () => {
    seedRound(store, roundStore, '2026-10-19', 'main', { content: '第一问', ts: 't1' });
    store.updateSessionMeta('2026-10-19-main', { archivedMessageCount: 6 });
    // 内核下一轮回归档写 summary 时不会重传 archivedMessageCount（值未变）
    store.updateSessionMeta('2026-10-19-main', { summary: '本次摘要' });

    const meta = store.getSessionMeta('2026-10-19-main');
    expect(meta?.summary).toBe('本次摘要');
    expect(meta?.archivedMessageCount).toBe(6);
  });

  it('归档防重快照：显式传 undefined 不抹既有（与 autoName/summary 同族保护）', () => {
    seedRound(store, roundStore, '2026-10-19', 'main', { content: '第一问', ts: 't1' });
    store.updateSessionMeta('2026-10-19-main', { archivedMessageCount: 6 });
    // Partial 允许显式 undefined；若被 spread 覆盖，跨进程防重即失效（重启后又烧一次 LLM）
    store.updateSessionMeta('2026-10-19-main', {
      archivedMessageCount: undefined,
      displayName: '改个名',
    });

    expect(store.getSessionMeta('2026-10-19-main')?.archivedMessageCount).toBe(6);
  });

  it('归档防重快照跨进程：落盘 JSON 往返后仍可读（防重的宿主侧真实闭环）', () => {
    seedRound(store, roundStore, '2026-10-19', 'main', { content: '第一问', ts: 't1' });
    store.updateSessionMeta('2026-10-19-main', { archivedMessageCount: 6 });

    // 模拟宿主重启：新实例 + load（内核重启后正是这样拿回跨进程判据）
    const reopened = new WorkspaceSessionStore(dir);
    reopened.load();

    expect(reopened.getSessionMeta('2026-10-19-main')?.archivedMessageCount).toBe(6);
  });
});

describe('WorkspaceRoundStore processEvents 落盘透传与生命周期随动（v1.5 单文件内聚）', () => {
  /** 临时工作区路径 */
  let dir: string;
  /** 问答闭环物理存储（JSON 落盘） */
  let roundStore: WorkspaceRoundStore;

  beforeEach(() => {
    dir = makeTempDir('memora-roundstore-events-');
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
        {
          type: 'memory_added',
          seq: 2,
          ts: 't1',
          payload: { id: 'r:1', name: '设计约束', source: 'round-summary' },
        },
        {
          type: 'aborted',
          seq: 3,
          ts: 't2',
          payload: { reason: 'User cancelled the conversation' },
        },
      ],
    };
    roundStore.save(round);

    // 模拟重启：新实例从磁盘 load（JSON.stringify/parse 往返）
    roundStore = new WorkspaceRoundStore(dir);
    roundStore.load();
    const retrieved = roundStore.getById('round-e1');
    expect(retrieved?.processEvents).toEqual(round.processEvents);
    expect(retrieved?.processEvents?.map((e) => e.type)).toEqual([
      'meta',
      'memory_added',
      'aborted',
    ]);
  });

  it('删除 round 即删 processEvents（生命周期原子，无独立文件需联动）', () => {
    const round: Round = {
      id: 'round-e2',
      userMessage: { id: 'u1', role: 'user', content: '问题', timestamp: 't1' },
      status: 'pending',
      createdAt: 't1',
      refCount: 0,
      processEvents: [{ type: 'meta', seq: 1, ts: 't1', payload: { role: 'AI', llm: 'm' } }],
    };
    roundStore.save(round);

    // 无会话引用的轮可直接回收（引用判定在会话层；delete 只负责物理层）
    expect(roundStore.delete('round-e2')).toBe(true);
    expect(roundStore.getById('round-e2')).toBeNull();
  });

  it('delete 移入回收站：processEvents 随文件一起离开活轮集合（7 天可找回）', () => {
    const round: Round = {
      id: 'round-e3',
      userMessage: { id: 'u1', role: 'user', content: '问题', timestamp: 't1' },
      assistantMessage: { id: 'a1', role: 'assistant', content: '回答', timestamp: 't2' },
      status: 'complete',
      createdAt: 't1',
      completedAt: 't2',
      refCount: 1, // 冻结为存在性标记；共享保护由会话引用集合承担
      processEvents: [{ type: 'meta', seq: 1, ts: 't1', payload: { role: 'AI', llm: 'm' } }],
    };
    roundStore.save(round);

    expect(roundStore.delete('round-e3')).toBe(true);
    expect(roundStore.getById('round-e3')).toBeNull();
    // 物理文件未抹除：进入 rounds/.trash（保留 7 天）
    const trashDir = join(dir, '.memora', 'rounds', '.trash');
    expect(existsSync(trashDir)).toBe(true);
    expect(readdirSync(trashDir).some((n) => n.startsWith('round-e3.'))).toBe(true);
  });
});

describe('WorkspaceRoundStore.sweepOrphans（孤儿统一回收，2026-08-29）', () => {
  /** 临时工作区路径（每用例独立） */
  let dir: string;
  /** 问答闭环物理存储 */
  let roundStore: WorkspaceRoundStore;
  /** 引用真源（模拟会话 roundIds）：孤儿判定现场派生，不读 refCount */
  let referencedIds: Set<string>;

  beforeEach(() => {
    referencedIds = new Set();
    dir = makeTempDir('memora-round-sweep-');
    roundStore = new WorkspaceRoundStore(dir);
    roundStore.load();
    roundStore.setReferencedIdsProvider(() => referencedIds);
  });

  /**
   * 直接落一个 Round（绕过 SessionStore 登记，模拟无会话引用残留孤儿）。
   * status 可指定为 'pending' 以复现「CRASH 残留」形态。
   * `refCount` 固定为 1（存在性标记），不参与任何孤儿判据。
   */
  function seedRawRound(
    roundId: string,
    createdAt: string,
    status: Round['status'] = 'complete',
  ): void {
    const round: Round = {
      id: roundId,
      userMessage: { id: `${roundId}-u`, role: 'user', content: 'x', timestamp: createdAt },
      status,
      createdAt,
      refCount: 1,
    };
    roundStore.save(round);
  }

  it('清理无会话引用的孤儿并返回被清扫 Round ID；被引用轮保留', () => {
    seedRawRound('round-loss', '2026-08-20T00:00:00.000Z');
    seedRawRound('round-keep', '2026-08-20T00:00:00.000Z');
    referencedIds.add('round-keep'); // 被会话 roundIds 引用
    // 返回值 = 清扫产物（Round ID 列表），供调用方延迟联动软删 round-summary
    expect(roundStore.sweepOrphans()).toEqual(['round-loss']);
    expect(roundStore.getById('round-loss')).toBeNull();
    expect(roundStore.getById('round-keep')).not.toBeNull();
  });

  it('minAgeMs 存活保护：刚创建/进行中的轮不被误删', () => {
    seedRawRound('round-fresh', new Date().toISOString());
    // 超短存活内不清（暂存保护区）
    expect(roundStore.sweepOrphans(60 * 60 * 1000)).toEqual([]);
    expect(roundStore.getById('round-fresh')).not.toBeNull();
    // 无保护立即回收
    expect(roundStore.sweepOrphans(0)).toEqual(['round-fresh']);
    expect(roundStore.getById('round-fresh')).toBeNull();
  });

  it('无孤儿时 no-op 返回空数组', () => {
    expect(roundStore.sweepOrphans()).toEqual([]);
  });

  it('默认调用（不传参）不删超龄新鲜轮——24h 存活保护的安全默认', () => {
    // 复现生产路径：extension 启动装配点调 sweepOrphans(DEFAULT_SWEEP_MIN_AGE_MS)。
    seedRawRound('round-inflight', new Date().toISOString(), 'pending');
    expect(roundStore.sweepOrphans()).toEqual([]);
    expect(roundStore.getById('round-inflight')).not.toBeNull();
  });

  it('在途轮（pending，在会话 roundIds 中）即便 minAgeMs=0 也不被回收', () => {
    // 判据 = 「不在任何会话 roundIds 中」：在途轮建轮即登记会话，不属孤儿。
    // 变异锚：listOrphaned 若忽略引用集合（只按 status/年龄筛）⇒ 本例红在 getById 为 null。
    seedRawRound('round-inflight-live', new Date().toISOString(), 'pending');
    referencedIds.add('round-inflight-live');
    expect(roundStore.sweepOrphans(0)).toEqual([]);
    expect(roundStore.getById('round-inflight-live')).not.toBeNull();
  });

  it('未注入引用真源时 sweep 返回空（宁可不回收，也不按过期计数误删）', () => {
    const bare = new WorkspaceRoundStore(dir);
    bare.load();
    // 必须用 bare 自己 save（另一个实例的 save 不更新 bare 的内存索引）
    bare.save({
      id: 'round-no-provider',
      userMessage: { id: 'u', role: 'user', content: 'x', timestamp: '2026-08-20T00:00:00.000Z' },
      status: 'complete',
      createdAt: '2026-08-20T00:00:00.000Z',
      refCount: 1,
    });
    expect(bare.sweepOrphans(0)).toEqual([]);
    expect(bare.getById('round-no-provider')).not.toBeNull();
  });
});

/**
 * 留存区分组标签（宿主扩展能力，非 ISessionStore 契约）
 *
 * 守的是四条**立身不变式**（实现改动前必读，任何一条破了本机制就名存实亡）：
 *   ① 移入留存 = **纯视图改位**：Round 文件、会话内容、引用集合一律不变；会话仍在
 *      `listSessions()` 结果里（它没被移出存储，只是换了显示分组）。
 *   ② **留存数据不能被启动清扫吃掉**——不清会话 roundIds 是保住它的唯一机制：引用一旦消失，
 *      `WorkspaceRoundStore.sweepOrphans`（宿主启动清理）就会把 Round 当孤儿移入回收站，
 *      表现为「存进留存区了，24 小时后被自家保洁清空」。
 *   ③ 标记与会话**同生共死**：删除会话必须同步摘标记，否则留存区分组出现无标题幽灵条目。
 *   ④ 旧档无 `archivedIds` 字段 → 空集（向后兼容，不做迁移分发）。
 */
describe('WorkspaceSessionStore · 留存区分组标签', () => {
  /** 临时工作区路径（每用例独立） */
  let dir: string;
  let store: WorkspaceSessionStore;
  let roundStore: WorkspaceRoundStore;

  beforeEach(() => {
    dir = makeTempDir('memora-archive-test-');
    roundStore = new WorkspaceRoundStore(dir);
    roundStore.load();
    store = new WorkspaceSessionStore(dir, roundStore);
    store.load();
  });

  /** Round 物理文件路径（断言「文件还在」用，是留存价值的最小证据） */
  const roundFileOf = (roundId: string): string =>
    join(dir, '.memora', 'rounds', `${roundId}.json`);

  it('① 移入留存是纯改位：会话内容 / Round 文件 / 引用集合一律不变', () => {
    seedThreeTurns(store, roundStore);
    const sessionId = '2026-08-16-main';
    const roundIds = store.getRoundIds(sessionId);

    expect(store.archiveSession(sessionId)).toBe(true);
    expect(store.isArchived(sessionId)).toBe(true);
    // 仍是会话（没被移出存储，只是换了显示分组）
    expect(store.listSessions()).toContain(sessionId);
    // 内容一字不变
    expect(store.loadMessages('2026-08-16', 'main').map((m) => m.content)).toEqual([
      '问题一',
      '回答一',
      '问题二',
      '回答二',
      '问题三',
      '回答三',
    ]);
    // 物理文件与引用集合均在
    for (const id of roundIds) {
      expect(existsSync(roundFileOf(id))).toBe(true);
      expect(store.referencedIds()).toContain(id);
    }
  });

  it('② 留存数据不被启动清扫吃掉：归档后强制清扫（minAgeMs=0）仍完好', () => {
    // 本用例是留存机制的**存在证明**：若归档实现改成「清会话引用 + 搬文件」的直觉写法，
    // 引用消失 → sweepOrphans 把 Round 当孤儿移入回收站 → 留存区里只剩一个空壳会话。
    seedThreeTurns(store, roundStore);
    const sessionId = '2026-08-16-main';
    const roundIds = store.getRoundIds(sessionId);
    store.archiveSession(sessionId);

    // 关闭存活保护强制清扫：留存区会话的 Round 必须一个都不被回收
    expect(roundStore.sweepOrphans(0)).toEqual([]);
    for (const id of roundIds) {
      expect(roundStore.getById(id)).not.toBeNull();
      expect(existsSync(roundFileOf(id))).toBe(true);
    }
    expect(store.loadMessages('2026-08-16', 'main').map((m) => m.content)).toEqual([
      '问题一',
      '回答一',
      '问题二',
      '回答二',
      '问题三',
      '回答三',
    ]);
  });

  it('③ 标记持久化往返：重载后仍在留存区', () => {
    seedThreeTurns(store, roundStore);
    store.archiveSession('2026-08-16-main');

    const reloaded = new WorkspaceSessionStore(dir, roundStore);
    reloaded.load();
    expect(reloaded.listArchivedIds()).toEqual(['2026-08-16-main']);
    expect(reloaded.isArchived('2026-08-16-main')).toBe(true);
  });

  it('④ 旧档兼容：无 archivedIds 字段的会话文件 → 空集，其余数据照常读取', () => {
    const sessionsPath = join(dir, '.memora', 'sessions.json');
    mkdirSync(join(dir, '.memora'), { recursive: true });
    writeFileSync(
      sessionsPath,
      JSON.stringify({
        metas: {},
        roundIdsStore: { '2026-08-16-main': ['round-1'] },
      }),
    );
    const legacy = new WorkspaceSessionStore(dir, roundStore);
    legacy.load();
    expect(legacy.listArchivedIds()).toEqual([]);
    expect(legacy.getRoundIds('2026-08-16-main')).toEqual(['round-1']);
  });

  it('幂等：重复移入返回 false；移回非留存项返回 false', () => {
    seedThreeTurns(store, roundStore);
    expect(store.archiveSession('2026-08-16-main')).toBe(true);
    expect(store.archiveSession('2026-08-16-main')).toBe(false); // 已在留存区
    expect(store.archiveSession('不存在-的会话')).toBe(false); // 会话不存在

    expect(store.unarchiveSession('2026-08-16-main')).toBe(true);
    expect(store.unarchiveSession('2026-08-16-main')).toBe(false); // 已移回
  });

  it('⑤ 删除留存会话：标记同步摘除（防留存区出现幽灵条目）', () => {
    seedThreeTurns(store, roundStore);
    store.archiveSession('2026-08-16-main');
    expect(store.listArchivedIds()).toEqual(['2026-08-16-main']);

    store.deleteSession('2026-08-16-main');
    expect(store.listSessions()).not.toContain('2026-08-16-main');
    expect(store.listArchivedIds()).toEqual([]);
  });

  it('回归护栏：删除语义未变（物理回收 Round + 返回联动产物）', () => {
    // 本用例锁的是「既有删除行为一字未动」——留存能力是新增面，不得改变删除的既有语义。
    seedThreeTurns(store, roundStore);
    const removed = store.deleteSession('2026-08-16-main');
    expect(removed).toEqual(['round-1', 'round-2', 'round-3']);
    for (const id of removed) {
      expect(roundStore.getById(id)).toBeNull();
      expect(existsSync(roundFileOf(id))).toBe(false);
    }
  });
});

/**
 * 导航指针（SESSION-RESUME-1）：启动初始会话 = **上次停留的会话**，不是「最近写入」的会话
 *
 * 立项目的（真机症状）：改本字段前 chatPanel 构造器取 `listSessionMetas()[0]`，而该排序的
 * 时间是 `updateRoundBasedMessageCount` 写的——只在「有一轮落盘」时刷新。「切到旧会话翻
 * 历史但没发消息」在磁盘上零痕迹 ⇒ 重启永远回到最近写过消息的会话，用户以为「打开的是最新
 * 会话」。
 *
 * 守三条不变式：
 *   ① 指针可解析 ⇒ 恒优先（哪怕它 updatedAt 不是最新）——这就是本条要治的症状本身
 *   ② 指针不可解析（会话已不存在 / 旧档无字段 / 空串）⇒ 退回最近写入，**绝不返回悬空 id**
 *      （内核 switchToSession 对不存在会话不报错 ⇒ 悬空 id 的后果是静默空屏，比报错更难排查）
 *   ③ 删除会话必须清指针，否则下次启动把用户带回一个已被删除的会话
 */
describe('WorkspaceSessionStore · 导航指针（SESSION-RESUME-1）', () => {
  let dir: string;
  let store: WorkspaceSessionStore;
  let roundStore: WorkspaceRoundStore;

  beforeEach(() => {
    dir = makeTempDir('memora-resume-test-');
    roundStore = new WorkspaceRoundStore(dir);
    roundStore.load();
    store = new WorkspaceSessionStore(dir, roundStore);
    store.load();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** 重开实例 = 模拟插件重启：只走磁盘，不共享任何内存状态 */
  function reopen(): WorkspaceSessionStore {
    const rs = new WorkspaceRoundStore(dir);
    rs.load();
    const next = new WorkspaceSessionStore(dir, rs);
    next.load();
    return next;
  }

  /** 播两个 updatedAt 严格递增的会话（fake timers 保证排序确定性，避免毫秒级同刻竞态） */
  function seedTwoSessions(): void {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-01T10:00:00.000Z'));
    seedRound(store, roundStore, '2026-08-01', 'old', {
      content: '旧会话',
      ts: '2026-08-01T10:00:00.000Z',
    });
    vi.setSystemTime(new Date('2026-08-05T10:00:00.000Z'));
    seedRound(store, roundStore, '2026-08-05', 'new', {
      content: '新会话',
      ts: '2026-08-05T10:00:00.000Z',
    });
    vi.useRealTimers();
  }

  it('① 指针优先于 updatedAt：停在旧会话，重启仍回到旧会话', () => {
    seedTwoSessions();
    // 前置事实：「最近写入」确实是新会话（旧实现据此选初始会话）
    expect(store.listSessionMetas()[0]?.sessionId).toBe('2026-08-05-new');
    // 用户切到旧会话（只看不发）后关闭
    store.setLastActiveSession('2026-08-01-old');
    expect(reopen().getInitialSessionId()).toBe('2026-08-01-old');
  });

  it('② 指针落盘往返：新实例（重启）读得回，不需要额外迁移', () => {
    seedTwoSessions();
    store.setLastActiveSession('2026-08-01-old');
    // 直接读磁盘形态，证明是持久化而非内存巧合
    const raw = JSON.parse(readFileSync(join(dir, '.memora', 'sessions.json'), 'utf8')) as {
      lastActiveSessionId?: string;
    };
    expect(raw.lastActiveSessionId).toBe('2026-08-01-old');
  });

  it('③ 指针不可解析 ⇒ 退回最近写入，绝不返回悬空 id', () => {
    seedTwoSessions();
    // 手工删数据 / 换机同步留下的陈旧指针
    store.setLastActiveSession('2026-07-01-ghost');
    expect(store.getInitialSessionId()).toBe('2026-08-05-new');
  });

  it('④ 旧档无该字段 ⇒ 空指针走「最近写入」兜底（向后兼容，无迁移）', () => {
    seedTwoSessions();
    // 模拟加字段前的旧档：把字段删掉再重开
    const file = join(dir, '.memora', 'sessions.json');
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    delete raw.lastActiveSessionId;
    writeFileSync(file, JSON.stringify(raw, null, 2));
    expect(reopen().getInitialSessionId()).toBe('2026-08-05-new');
  });

  it('⑤ 删除会话同步清指针（否则重启复活已删会话）', () => {
    seedTwoSessions();
    store.setLastActiveSession('2026-08-01-old');
    store.deleteSession('2026-08-01-old');
    // 指针失效 ⇒ 退回剩下那个会话，而不是把用户带回已删除的 2026-08-01-old
    expect(reopen().getInitialSessionId()).toBe('2026-08-05-new');
  });

  it('⑥ 占位 meta 的 updatedAt 取会话 id 日期，不取 now()', () => {
    // 只写 roundIds 不写 meta（内核 forkSession 的「先 setRoundIds 后 updateSessionMeta」时序，
    // 以及命名未回写窗口），走 getSessionMeta 的占位分支
    store.setRoundIds('2026-07-20-placeholder', ['round-p1']);
    const first = store.getSessionMeta('2026-07-20-placeholder');
    expect(first?.updatedAt).toBe('2026-07-20T00:00:00.000Z');
    // 稳定性 = 本条的关键判据：旧实现每次查询都返回 now()，该会话因此恒排 listSessionMetas 第一
    expect(store.getSessionMeta('2026-07-20-placeholder')?.updatedAt).toBe(first?.updatedAt);
    // 行为判据：占位会话不再抢「最近写入」位（有真实写入的两个会话排在它前面）
    seedTwoSessions();
    expect(store.listSessionMetas().map((m) => m.sessionId)).toEqual([
      '2026-08-05-new',
      '2026-08-01-old',
      '2026-07-20-placeholder',
    ]);
  });
});
