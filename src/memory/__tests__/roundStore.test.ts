/**
 * 单元测试：问答闭环存储（RoundStore）
 * 验证 InMemoryRoundStore 的核心功能
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { InMemoryRoundStore } from '@/memory/inMemoryRoundStore.js';
import {
  createPendingRound,
  completeRound,
  generateRoundId,
  generateMessageId,
  generateSummaryId,
  parseRoundIdFromSummaryId,
} from '@/memory/roundStore.js';

describe('问答闭环存储', () => {
  let store: InMemoryRoundStore;

  beforeEach(() => {
    store = new InMemoryRoundStore();
  });

  describe('InMemoryRoundStore', () => {
    it('应该保存和获取问答闭环', () => {
      // 创建 pending Round
      const round = createPendingRound('你好');

      // 保存
      store.save(round);

      // 获取
      const retrieved = store.getById(round.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(round.id);
      expect(retrieved?.status).toBe('pending');
      expect(retrieved?.userMessage.content).toBe('你好');
      expect(retrieved?.refCount).toBe(1);
    });

    it('应该完成问答闭环', () => {
      // 创建并完成 Round
      const round = createPendingRound('你好');
      store.save(round);

      const completed = completeRound(round, '你好！有什么可以帮你的？');
      store.save(completed);

      // 获取并验证
      const retrieved = store.getById(round.id);
      expect(retrieved?.status).toBe('complete');
      expect(retrieved?.assistantMessage?.content).toBe('你好！有什么可以帮你的？');
      expect(retrieved?.summaryId).toBe(`round-summary:${round.id}`);
      expect(retrieved?.completedAt).toBeDefined();
    });

    it('应该批量获取问答闭环', () => {
      // 创建多个 Round
      const round1 = createPendingRound('第一个问题');
      const round2 = createPendingRound('第二个问题');
      const round3 = createPendingRound('第三个问题');

      store.save(round1);
      store.save(round2);
      store.save(round3);

      // 批量获取
      const results = store.getByIds([round1.id, round3.id]);
      expect(results).toHaveLength(2);
      expect(results[0]!.id).toBe(round1.id);
      expect(results[1]!.id).toBe(round3.id);
    });

    it('应该跳过批量获取中不存在的 ID', () => {
      const round1 = createPendingRound('存在的');
      store.save(round1);

      // 包含不存在的 ID
      const results = store.getByIds([round1.id, '不存在的-id']);
      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe(round1.id);
    });

    it('应该列出所有问答闭环', () => {
      const round1 = createPendingRound('问题1');
      const round2 = createPendingRound('问题2');

      store.save(round1);
      store.save(round2);

      const all = store.listAll();
      expect(all).toHaveLength(2);
      expect(store.size()).toBe(2);
    });

    it('应该按状态筛选问答闭环', () => {
      // 创建不同状态的 Round
      const pendingRound = createPendingRound('待处理');
      store.save(pendingRound);

      const completedRound = createPendingRound('已完成');
      const completed = completeRound(completedRound, '完成');
      store.save(completed);

      // 按状态筛选
      const pendingList = store.listByStatus('pending');
      const completedList = store.listByStatus('complete');

      expect(pendingList.length).toBeGreaterThanOrEqual(1);
      expect(completedList.length).toBeGreaterThanOrEqual(1);
    });

    it('应该管理引用计数', () => {
      const round = createPendingRound('测试引用');
      store.save(round);

      // 初始 refCount = 1
      const initial = store.getById(round.id);
      expect(initial?.refCount).toBe(1);

      // 增加引用
      store.incrementRef(round.id);
      const afterIncrement = store.getById(round.id);
      expect(afterIncrement?.refCount).toBe(2);

      // 减少引用
      store.decrementRef(round.id);
      const afterDecrement = store.getById(round.id);
      expect(afterDecrement?.refCount).toBe(1);

      // 减少到 0 以下不允许
      store.decrementRef(round.id);
      store.decrementRef(round.id); // 尝试继续减少
      const afterOverflow = store.getById(round.id);
      expect(afterOverflow?.refCount).toBe(0); // 不会降到 0 以下
    });

    it('应该删除孤立的问答闭环', () => {
      // 创建 refCount=0 的 Round
      const round = createPendingRound('待删除');
      // 手动设置 refCount=0
      round.refCount = 0;
      store.save(round);

      // 应该能删除
      const deleted = store.delete(round.id);
      expect(deleted).toBe(true);
      expect(store.getById(round.id)).toBeNull();
      expect(store.size()).toBe(0);
    });

    it('不应该删除仍被引用的问答闭环', () => {
      const round = createPendingRound('被引用');
      store.save(round);

      // refCount=1 > 0，不允许删除
      const deleted = store.delete(round.id);
      expect(deleted).toBe(false);
      expect(store.getById(round.id)).not.toBeNull();
    });

    it('应该列出孤立的问答闭环', () => {
      // 创建孤立的 Round（refCount=0 且 complete）
      const round1 = createPendingRound('孤立1');
      const completed1 = completeRound(round1, '完成1');
      completed1.refCount = 0;
      store.save(completed1);

      // 创建非孤立的 Round（refCount=2）
      const round2 = createPendingRound('非孤立');
      const completed2 = completeRound(round2, '完成2');
      completed2.refCount = 2;
      store.save(completed2);

      // 列出孤立的
      const orphaned = store.listOrphaned(0); // minAgeMs=0 忽略存活时间
      expect(orphaned.length).toBe(1);
      expect(orphaned[0]!.id).toBe(round1.id);
    });

    it('应该尊重最小存活时间', () => {
      // 创建刚完成的 Round
      const round = createPendingRound('新的');
      const completed = completeRound(round, '新完成');
      completed.refCount = 0;
      store.save(completed);

      // 存活时间设置为 1 小时，应该过滤掉
      const orphaned = store.listOrphaned(60 * 60 * 1000);
      expect(orphaned.length).toBe(0); // 不会被列出
    });

    it('应该忽略不存在的 Round 操作', () => {
      // 获取不存在的 ID
      expect(store.getById('不存在的-id')).toBeNull();

      // 增加不存在的 ID 的引用（不报错）
      expect(() => store.incrementRef('不存在的-id')).not.toThrow();

      // 减少不存在的 ID 的引用（不报错）
      expect(() => store.decrementRef('不存在的-id')).not.toThrow();
    });

    it('应该支持清空操作', () => {
      const round = createPendingRound('测试');
      store.save(round);
      expect(store.size()).toBe(1);

      store.clear();
      expect(store.size()).toBe(0);
    });
  });

  describe('辅助函数', () => {
    it('应该生成唯一的 Round ID', () => {
      const id1 = generateRoundId();
      const id2 = generateRoundId();

      expect(id1.startsWith('round-')).toBe(true);
      expect(id2.startsWith('round-')).toBe(true);
      expect(id1).not.toBe(id2); // 唯一
    });

    it('应该生成唯一的消息 ID', () => {
      const id1 = generateMessageId();
      const id2 = generateMessageId();

      expect(id1.startsWith('msg-')).toBe(true);
      expect(id1).not.toBe(id2);
    });

    it('应该生成正确的摘要 ID', () => {
      const roundId = 'round-abc123';
      const summaryId = generateSummaryId(roundId);

      expect(summaryId).toBe('round-summary:round-abc123');
    });

    it('应该从摘要 ID 解析 roundId', () => {
      const summaryId = 'round-summary:round-abc123';
      const roundId = parseRoundIdFromSummaryId(summaryId);

      expect(roundId).toBe('round-abc123');
    });

    it('应该拒绝无效的摘要 ID 格式', () => {
      expect(parseRoundIdFromSummaryId('invalid-format')).toBeNull();
      expect(parseRoundIdFromSummaryId('round-summary:')).toBeNull(); // 空 roundId
    });

    it('应该创建 pending Round', () => {
      const round = createPendingRound('测试消息');

      expect(round.id).toBeDefined();
      expect(round.status).toBe('pending');
      expect(round.userMessage.content).toBe('测试消息');
      expect(round.userMessage.role).toBe('user');
      expect(round.refCount).toBe(1);
      expect(round.createdAt).toBeDefined();
    });

    it('应该完成 Round', () => {
      const round = createPendingRound('用户问题');
      const completed = completeRound(round, 'AI 回答', { input: 10, output: 20 });

      expect(completed.status).toBe('complete');
      expect(completed.assistantMessage?.content).toBe('AI 回答');
      expect(completed.assistantMessage?.tokenUsage?.input).toBe(10);
      expect(completed.assistantMessage?.tokenUsage?.output).toBe(20);
      expect(completed.summaryId).toBe(`round-summary:${round.id}`);
      expect(completed.completedAt).toBeDefined();
    });
  });
});
