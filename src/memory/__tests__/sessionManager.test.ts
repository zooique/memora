/**
 * 集成测试：会话管理器（SessionManager）
 * 验证 Round-based 模式的核心功能
 *
 * 测试场景：
 * 1. 会话创建和加载
 * 2. Round 追加和引用计数
 * 3. 会话分叉（核心功能）
 * 4. 会话删除和引用计数清理
 * 5. 多会话共享同一 Round
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { InMemoryRoundStore } from '@/memory/inMemoryRoundStore.js';
import { InMemorySessionStore } from '@/memory/inMemorySessionStore.js';
import { InMemorySessionViewLoader } from '@/memory/inMemorySessionViewLoader.js';
import { DefaultSessionManager } from '@/memory/sessionManager.js';
import { createPendingRound, completeRound } from '@/memory/roundStore.js';

/**
 * 测试辅助：创建完整的会话管理器
 */
function createTestManager() {
  const roundStore = new InMemoryRoundStore();
  const sessionStore = new InMemorySessionStore();
  const viewLoader = new InMemorySessionViewLoader(roundStore, sessionStore);
  const manager = new DefaultSessionManager(roundStore, sessionStore, viewLoader);

  return { roundStore, sessionStore, manager };
}

describe('会话管理器集成测试', () => {
  let roundStore: InMemoryRoundStore;
  let sessionStore: InMemorySessionStore;
  let manager: DefaultSessionManager;

  beforeEach(() => {
    ({ roundStore, sessionStore, manager } = createTestManager());
  });

  describe('会话创建和加载', () => {
    it('应该创建新会话', () => {
      const meta = manager.createSession('2026-08-27-test-session');

      expect(meta.sessionId).toBe('2026-08-27-test-session');
      expect(meta.storageMode).toBe('round-based');
      expect(meta.roundIds).toEqual([]);
      expect(meta.messageCount).toBe(0);
    });

    it('应该创建带初始 Round 的会话', () => {
      // 创建 Round
      const round = createPendingRound('测试消息');
      const completed = completeRound(round, '测试回答');
      roundStore.save(completed);

      // 创建会话
      const meta = manager.createSession('test-session', [round.id]);

      expect(meta.roundIds).toEqual([round.id]);
      expect(meta.messageCount).toBe(2); // 1 个 Round = 2 条消息

      // 验证 Round 引用计数增加
      const storedRound = roundStore.getById(round.id);
      expect(storedRound?.refCount).toBe(2); // 初始 1 + 创建会话增加 1
    });

    it('应该加载会话视图', () => {
      // 创建会话
      manager.createSession('test-session');

      // 追加 Round
      const round = createPendingRound('问题1');
      const completed = completeRound(round, '回答1');
      roundStore.save(completed);
      manager.appendRound('test-session', round.id);

      // 加载视图
      const view = manager.loadSession('test-session');

      expect(view.sessionId).toBe('test-session');
      expect(view.rounds).toHaveLength(1);
      expect(view.messages).toHaveLength(2); // User + AI
      expect(view.messages[0]!.content).toBe('问题1');
      expect(view.messages[1]!.content).toBe('回答1');
    });

    it('应该加载会话摘要', () => {
      // 创建会话
      manager.createSession('test-session');

      // 追加 Round
      const round = createPendingRound('测试问题');
      const completed = completeRound(round, '测试回答内容');
      roundStore.save(completed);
      manager.appendRound('test-session', round.id);

      // 设置标题
      manager.updateSessionTitle('test-session', '我的测试会话');

      // 加载摘要
      const summary = manager.loadSessionSummary('test-session');

      expect(summary).not.toBeNull();
      expect(summary?.title).toBe('我的测试会话');
      expect(summary?.roundCount).toBe(1);
      expect(summary?.lastMessagePreview).toContain('测试回答内容');
    });
  });

  describe('Round 追加和引用计数', () => {
    it('应该追加 Round 并增加引用计数', () => {
      // 创建会话和 Round
      manager.createSession('test-session');
      const round = createPendingRound('追加测试');
      roundStore.save(round);

      // 初始引用计数
      const beforeRef = roundStore.getById(round.id)?.refCount;
      expect(beforeRef).toBe(1);

      // 追加到会话
      manager.appendRound('test-session', round.id);

      // 验证引用计数增加
      const afterRef = roundStore.getById(round.id)?.refCount;
      expect(afterRef).toBe(2);
    });

    it('应该批量追加 Round', () => {
      manager.createSession('test-session');

      // 创建多个 Round
      const round1 = createPendingRound('问题1');
      const round2 = createPendingRound('问题2');
      roundStore.save(round1);
      roundStore.save(round2);

      // 批量追加
      manager.appendRounds('test-session', [round1.id, round2.id]);

      // 验证引用计数
      expect(roundStore.getById(round1.id)?.refCount).toBe(2);
      expect(roundStore.getById(round2.id)?.refCount).toBe(2);

      // 验证会话 Round 列表
      const roundIds = manager.getSessionRoundIds('test-session');
      expect(roundIds).toHaveLength(2);
      expect(roundIds).toContain(round1.id);
      expect(roundIds).toContain(round2.id);
    });

    it('不应该追加不存在的 Round', () => {
      manager.createSession('test-session');

      expect(() => {
        manager.appendRound('test-session', '不存在的-round-id');
      }).toThrow('Round 不存在');
    });
  });

  describe('会话分叉（核心功能）', () => {
    it('应该从指定 Round 分叉会话', () => {
      // 1. 创建源会话
      manager.createSession('2026-08-27-source-session');

      // 2. 创建多个 Round
      const round1 = createPendingRound('问题1');
      const completed1 = completeRound(round1, '回答1');
      roundStore.save(completed1);

      const round2 = createPendingRound('问题2');
      const completed2 = completeRound(round2, '回答2');
      roundStore.save(completed2);

      const round3 = createPendingRound('问题3');
      const completed3 = completeRound(round3, '回答3');
      roundStore.save(completed3);

      // 3. 追加到源会话
      manager.appendRounds('2026-08-27-source-session', [
        round1.id,
        round2.id,
        round3.id,
      ]);

      // 4. 从 round2 位置分叉
      const forkedMeta = manager.forkSession(
        '2026-08-27-source-session',
        round2.id,
      );

      // 5. 验证分叉结果
      expect(forkedMeta.sessionId).not.toBe('2026-08-27-source-session');
      expect(forkedMeta.roundIds).toHaveLength(2); // round1 + round2
      expect(forkedMeta.roundIds).toContain(round1.id);
      expect(forkedMeta.roundIds).toContain(round2.id);
      expect(forkedMeta.roundIds).not.toContain(round3.id);

      // 6. 验证引用计数
      expect(roundStore.getById(round1.id)?.refCount).toBe(3); // 1(初始) + 1(源会话) + 1(分叉会话)
      expect(roundStore.getById(round2.id)?.refCount).toBe(3);
      expect(roundStore.getById(round3.id)?.refCount).toBe(2); // 1(初始) + 1(源会话)

      // 7. 验证分叉会话可加载
      const forkedView = manager.loadSession(forkedMeta.sessionId);
      expect(forkedView.rounds).toHaveLength(2);
      expect(forkedView.messages).toHaveLength(4); // 2 Round × 2
    });

    it('应该生成唯一的分叉会话 ID', () => {
      manager.createSession('source-session');

      const round = createPendingRound('问题');
      roundStore.save(round);
      manager.appendRound('source-session', round.id);

      // 创建两个分叉
      const fork1 = manager.forkSession('source-session', round.id);
      const fork2 = manager.forkSession('source-session', round.id);

      expect(fork1.sessionId).not.toBe(fork2.sessionId);
    });

    it('应该支持自定义分叉会话 ID', () => {
      manager.createSession('source-session');

      const round = createPendingRound('问题');
      roundStore.save(round);
      manager.appendRound('source-session', round.id);

      // 自定义 ID
      const forked = manager.forkSession(
        'source-session',
        round.id,
        'custom-fork-id',
      );

      expect(forked.sessionId).toBe('custom-fork-id');
    });

    it('不应该从不存在的 Round 分叉', () => {
      manager.createSession('source-session');

      // 先添加一个 Round
      const round = createPendingRound('存在的 Round');
      roundStore.save(round);
      manager.appendRound('source-session', round.id);

      // 尝试从不存在的 Round 分叉
      expect(() => {
        manager.forkSession('source-session', '不存在的-round');
      }).toThrow('分叉点 Round 不在源会话中');
    });

    it('不应该从空会话分叉', () => {
      manager.createSession('empty-session');

      expect(() => {
        manager.forkSession('empty-session', 'any-round');
      }).toThrow('源会话没有 Round');
    });
  });

  describe('会话删除和引用计数清理', () => {
    it('应该删除会话并减少引用计数', () => {
      // 创建会话
      manager.createSession('test-session');

      // 创建 Round
      const round = createPendingRound('测试');
      roundStore.save(round);
      manager.appendRound('test-session', round.id);

      // 验证初始引用计数
      expect(roundStore.getById(round.id)?.refCount).toBe(2); // 1(初始) + 1(会话)

      // 删除会话
      manager.deleteSession('test-session');

      // 验证引用计数减少
      expect(roundStore.getById(round.id)?.refCount).toBe(1); // 仅剩初始
    });

    it('删除分叉会话不应影响源会话', () => {
      // 1. 创建源会话
      manager.createSession('source-session');

      const round = createPendingRound('共享 Round');
      roundStore.save(round);
      manager.appendRound('source-session', round.id);

      // 2. 创建分叉
      const forkedMeta = manager.forkSession('source-session', round.id);

      // 3. 验证引用计数
      expect(roundStore.getById(round.id)?.refCount).toBe(3); // 1(初始) + 1(源) + 1(分叉)

      // 4. 删除分叉会话
      manager.deleteSession(forkedMeta.sessionId);

      // 5. 验证引用计数减少
      expect(roundStore.getById(round.id)?.refCount).toBe(2); // 1(初始) + 1(源)

      // 6. 验证源会话仍可加载
      const sourceView = manager.loadSession('source-session');
      expect(sourceView.rounds).toHaveLength(1);
    });
  });

  describe('多会话共享同一 Round', () => {
    it('应该支持多个会话共享同一 Round', () => {
      // 创建共享 Round
      const round = createPendingRound('共享内容');
      roundStore.save(round);

      // 创建多个会话，引用同一 Round
      manager.createSession('session-1', [round.id]);
      manager.createSession('session-2', [round.id]);
      manager.createSession('session-3', [round.id]);

      // 验证引用计数
      expect(roundStore.getById(round.id)?.refCount).toBe(4); // 1(初始) + 3(会话)

      // 删除一个会话
      manager.deleteSession('session-2');
      expect(roundStore.getById(round.id)?.refCount).toBe(3);

      // 再删除一个
      manager.deleteSession('session-1');
      expect(roundStore.getById(round.id)?.refCount).toBe(2);
    });
  });

  describe('会话列表', () => {
    it('应该列出所有会话', () => {
      // 创建多个会话
      manager.createSession('session-1');
      manager.createSession('session-2');
      manager.createSession('session-3');

      // 列出会话
      const sessions = manager.listSessions();

      expect(sessions.length).toBeGreaterThanOrEqual(3);
    });

    it('应该限制列表数量', () => {
      // 创建多个会话
      for (let i = 0; i < 10; i++) {
        manager.createSession(`session-${i}`);
      }

      // 限制为 5 个
      const sessions = manager.listSessions(5);
      expect(sessions.length).toBeLessThanOrEqual(5);
    });
  });

  describe('会话标题管理', () => {
    it('应该更新会话标题', () => {
      manager.createSession('test-session');

      manager.updateSessionTitle('test-session', '新标题');

      const meta = sessionStore.getSessionMeta('test-session');
      expect(meta?.displayName).toBe('新标题');
    });

    it('应该更新会话元数据', () => {
      manager.createSession('test-session');

      manager.updateSessionMeta('test-session', {
        autoName: '自动命名',
        keyTopics: ['测试', '会话'],
      });

      const meta = sessionStore.getSessionMeta('test-session');
      expect(meta?.autoName).toBe('自动命名');
      expect(meta?.keyTopics).toEqual(['测试', '会话']);
    });
  });
});
