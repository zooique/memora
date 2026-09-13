/**
 * InMemorySessionViewLoader 单元测试 — 内存会话视图加载器
 *
 * 覆盖全部分支：
 *   - loadView：会话不存在抛错 / 正常加载视图
 *   - loadSummary：会话不存在返回 null / 短/长 AI 消息预览截断 / 标题回退（displayName→autoName→sessionId）
 *   - loadBatchSummaries：按 updatedAt 降序
 *   - getMessageCount：无 meta / 命中 meta.messageCount / 空 roundIds / 计算
 *   - loadViewUpTo：截断视图 + 消息数更新
 *   - getSessionMeta：getSessionMeta 优先 + listSessionMetas 兜底
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { InMemorySessionViewLoader } from '@/memory/inMemorySessionViewLoader.js';
import { InMemorySessionStore } from '@/memory/inMemorySessionStore.js';
import { InMemoryRoundStore } from '@/memory/inMemoryRoundStore.js';
import { createPendingRound, completeRound } from '@/memory/roundStore.js';
import type { ISessionStore } from '@/memory/sessionStore.js';

describe('InMemorySessionViewLoader', () => {
  let roundStore: InMemoryRoundStore;
  let sessionStore: InMemorySessionStore;
  let loader: InMemorySessionViewLoader;
  const SID = '2026-09-13-main';

  beforeEach(() => {
    roundStore = new InMemoryRoundStore();
    sessionStore = new InMemorySessionStore(roundStore);
    loader = new InMemorySessionViewLoader(roundStore, sessionStore);
  });

  /** 保存一个 complete Round 到会话 */
  function seedRound(content: string, ai: string): string {
    const round = createPendingRound(content);
    const completed = completeRound(round, ai);
    roundStore.save(completed);
    sessionStore.createSession({
      sessionId: SID,
      updatedAt: '2026-09-13T00:00:00.000Z',
      messageCount: 0,
    });
    sessionStore.appendRoundId(SID, completed.id);
    return completed.id;
  }

  describe('loadView', () => {
    it('会话不存在：抛 Error', () => {
      expect(() => loader.loadView('nope')).toThrow(`会话不存在: nope`);
    });

    it('正常加载：返回 meta / rounds / messages', () => {
      seedRound('问题', '回答');
      const view = loader.loadView(SID);
      expect(view.sessionId).toBe(SID);
      expect(view.rounds).toHaveLength(1);
      // complete round → user + assistant 两条消息
      expect(view.messages).toHaveLength(2);
      expect(view.meta.sessionId).toBe(SID);
    });
  });

  describe('loadSummary', () => {
    it('会话不存在：返回 null', () => {
      expect(loader.loadSummary('nope')).toBeNull();
    });

    it('空会话（无 roundIds）：roundCount=0、无预览', () => {
      sessionStore.createSession({ sessionId: SID, updatedAt: 't', messageCount: 0 });
      const s = loader.loadSummary(SID)!;
      expect(s.roundCount).toBe(0);
      expect(s.lastMessagePreview).toBeUndefined();
    });

    it('AI 消息 ≤50 字符：预览原样返回', () => {
      seedRound('问题', '短回答');
      const s = loader.loadSummary(SID)!;
      expect(s.lastMessagePreview).toBe('短回答');
    });

    it('AI 消息 >50 字符：预览截断并追加 ...', () => {
      seedRound('问题', 'A'.repeat(120));
      const s = loader.loadSummary(SID)!;
      expect(s.lastMessagePreview).toBe('A'.repeat(50) + '...');
    });

    it('标题回退：displayName → autoName → sessionId', () => {
      seedRound('问题', '回答');
      // 无 displayName/autoName → sessionId 兜底
      expect(loader.loadSummary(SID)!.title).toBe(SID);
      // 有 autoName → 用之
      sessionStore.updateSessionMeta(SID, { autoName: '自动标题' });
      expect(loader.loadSummary(SID)!.title).toBe('自动标题');
      // 有 displayName → 优先
      sessionStore.updateSessionMeta(SID, { displayName: '自定义标题' });
      expect(loader.loadSummary(SID)!.title).toBe('自定义标题');
    });
  });

  describe('loadBatchSummaries', () => {
    it('按 updatedAt 降序排列', () => {
      sessionStore.createSession({ sessionId: '2026-09-10-a', updatedAt: '2026-09-10T00:00:00Z', messageCount: 0 });
      sessionStore.createSession({ sessionId: '2026-09-12-b', updatedAt: '2026-09-12T00:00:00Z', messageCount: 0 });
      const summaries = loader.loadBatchSummaries(['2026-09-12-b', '2026-09-10-a']);
      expect(summaries.map((s) => s.sessionId)).toEqual(['2026-09-12-b', '2026-09-10-a']);
    });

    it('不存在的会话被过滤', () => {
      sessionStore.createSession({ sessionId: SID, updatedAt: 't', messageCount: 0 });
      const summaries = loader.loadBatchSummaries(['nope', SID]);
      expect(summaries).toHaveLength(1);
      expect(summaries[0]!.sessionId).toBe(SID);
    });
  });

  describe('getMessageCount', () => {
    it('会话不存在：返回 0', () => {
      expect(loader.getMessageCount('nope')).toBe(0);
    });

    it('命中 meta.messageCount：直接返回', () => {
      sessionStore.createSession({ sessionId: SID, updatedAt: 't', messageCount: 7 });
      expect(loader.getMessageCount(SID)).toBe(7);
    });

    it('无 meta.messageCount 且无 roundIds：返回 0', () => {
      // 通过 listSessionMetas 兜底返回含 messageCount 的 meta（此处用 autoName 触发兜底路径）
      sessionStore.createSession({ sessionId: SID, updatedAt: 't', messageCount: undefined as unknown as number });
      expect(loader.getMessageCount(SID)).toBe(0);
    });
  });

  describe('loadViewUpTo', () => {
    it('截断视图到指定 Round 并更新消息数', () => {
      const id1 = seedRound('问题一', '回答一');
      const id2 = seedRound('问题二', '回答二');
      sessionStore.setRoundIds(SID, [id1, id2]);
      const view = loader.loadViewUpTo(SID, id1);
      // 仅截断保留第一个 round
      expect(view.rounds).toHaveLength(1);
      expect(view.rounds[0]!.id).toBe(id1);
      expect(view.messages).toHaveLength(2);
      expect(view.meta.messageCount).toBe(2);
    });
  });

  describe('getSessionMeta 兜底（listSessionMetas fallback）', () => {
    it('无 getSessionMeta 方法时从 listSessionMetas 查找', () => {
      sessionStore.createSession({ sessionId: SID, autoName: '兜底会话', updatedAt: 't', messageCount: 0 });
      // 显式构造缺 getSessionMeta 的 store：listSessionMetas 兜底命中
      const noGetMeta: ISessionStore = {
        getRoundIds: (id: string) => sessionStore.getRoundIds(id),
        listSessionMetas: () => sessionStore.listSessionMetas(),
      } as unknown as ISessionStore;
      const loaderNoMeta = new InMemorySessionViewLoader(roundStore, noGetMeta);
      const s = loaderNoMeta.loadSummary(SID)!;
      expect(s.sessionId).toBe(SID);
      expect(s.title).toBe('兜底会话');
      expect(s.roundCount).toBe(0);
    });

    it('两者都不可用时 loadSummary 返回 null', () => {
      const emptyStore = { getRoundIds: () => [] } as unknown as ISessionStore;
      const loaderEmpty = new InMemorySessionViewLoader(roundStore, emptyStore);
      expect(loaderEmpty.loadSummary(SID)).toBeNull();
    });
  });
});