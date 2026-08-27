/**
 * 单元测试：会话视图加载器（SessionViewLoader）
 * 验证 Round → Session 的视图转换逻辑
 */
import { describe, expect, it } from 'vitest';
import {
  flattenRoundsToMessages,
  truncateRoundsUpTo,
  countMessagesInRounds,
} from '@/memory/sessionViewLoader.js';
import { createPendingRound, completeRound } from '@/memory/roundStore.js';

describe('会话视图加载器', () => {
  describe('flattenRoundsToMessages', () => {
    it('应该将 Round 列表展开为扁平消息列表', () => {
      // 创建多个 Round
      const round1 = createPendingRound('第一个问题');
      const completed1 = completeRound(round1, '第一个回答');

      const round2 = createPendingRound('第二个问题');
      const completed2 = completeRound(round2, '第二个回答');

      // 展开
      const messages = flattenRoundsToMessages([completed1, completed2]);

      // 验证顺序：用户1 → AI1 → 用户2 → AI2
      expect(messages).toHaveLength(4);
      expect(messages[0]!.role).toBe('user');
      expect(messages[0]!.content).toBe('第一个问题');
      expect(messages[1]!.role).toBe('assistant');
      expect(messages[1]!.content).toBe('第一个回答');
      expect(messages[2]!.role).toBe('user');
      expect(messages[2]!.content).toBe('第二个问题');
      expect(messages[3]!.role).toBe('assistant');
      expect(messages[3]!.content).toBe('第二个回答');
    });

    it('应该跳过未完成的 AI 消息', () => {
      // 一个完成的 Round
      const completedRound = createPendingRound('完成的');
      const completed = completeRound(completedRound, '完成的回答');

      // 一个 pending 的 Round
      const pendingRound = createPendingRound('未完成的');

      // 展开
      const messages = flattenRoundsToMessages([completed, pendingRound]);

      // 验证：用户1 → AI1 → 用户2（跳过 pendingRound 的 AI）
      expect(messages).toHaveLength(3);
      expect(messages[0]!.content).toBe('完成的');
      expect(messages[1]!.content).toBe('完成的回答');
      expect(messages[2]!.content).toBe('未完成的');
    });

    it('应该处理空列表', () => {
      const messages = flattenRoundsToMessages([]);
      expect(messages).toHaveLength(0);
    });
  });

  describe('truncateRoundsUpTo', () => {
    it('应该截断到指定 Round', () => {
      // 创建多个 Round
      const round1 = createPendingRound('第一个');
      const completed1 = completeRound(round1, '回答1');

      const round2 = createPendingRound('第二个');
      const completed2 = completeRound(round2, '回答2');

      const round3 = createPendingRound('第三个');
      const completed3 = completeRound(round3, '回答3');

      // 截断到第二个
      const truncated = truncateRoundsUpTo(
        [completed1, completed2, completed3],
        round2.id,
      );

      // 验证：只包含前两个
      expect(truncated).toHaveLength(2);
      expect(truncated[0]!.id).toBe(round1.id);
      expect(truncated[1]!.id).toBe(round2.id);
    });

    it('应该包含指定的 Round', () => {
      const round1 = createPendingRound('第一个');
      const completed1 = completeRound(round1, '回答1');

      const round2 = createPendingRound('第二个');
      const completed2 = completeRound(round2, '回答2');

      // 截断到第一个（应该包含第一个）
      const truncated = truncateRoundsUpTo(
        [completed1, completed2],
        round1.id,
      );

      expect(truncated).toHaveLength(1);
      expect(truncated[0]!.id).toBe(round1.id);
    });

    it('应该返回全部如果未找到指定 Round', () => {
      const round1 = createPendingRound('第一个');
      const completed1 = completeRound(round1, '回答1');

      const round2 = createPendingRound('第二个');
      const completed2 = completeRound(round2, '回答2');

      // 指定不存在的 ID
      const truncated = truncateRoundsUpTo(
        [completed1, completed2],
        '不存在的-id',
      );

      // 返回全部
      expect(truncated).toHaveLength(2);
    });

    it('应该处理空列表', () => {
      const truncated = truncateRoundsUpTo([], 'any-id');
      expect(truncated).toHaveLength(0);
    });
  });

  describe('countMessagesInRounds', () => {
    it('应该计算已完成 Round 的消息数', () => {
      const round1 = createPendingRound('问题1');
      const completed1 = completeRound(round1, '回答1');

      const round2 = createPendingRound('问题2');
      const completed2 = completeRound(round2, '回答2');

      // 完成的 Round：每个包含用户+AI 两条消息
      const count = countMessagesInRounds([completed1, completed2]);
      expect(count).toBe(4); // 2 * 2
    });

    it('应该计算包含 pending Round 的消息数', () => {
      const completedRound = createPendingRound('完成的');
      const completed = completeRound(completedRound, '回答');

      const pendingRound = createPendingRound('未完成的');

      // pending Round 只有用户消息（1条），completed Round 有 2 条
      const count = countMessagesInRounds([completed, pendingRound]);
      expect(count).toBe(3); // 2 + 1
    });

    it('应该处理空列表', () => {
      const count = countMessagesInRounds([]);
      expect(count).toBe(0);
    });
  });
});
