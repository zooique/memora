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
import { createPendingRound, completeRound, type Round } from '@/memory/roundStore.js';

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

    it('应保留中断轮（interrupted）的 AI 消息——定案 §一·五「可作后续上下文」', () => {
      // 中断轮 = 等同用户点停止的正常 turn（assistantMessage 含半截正文 + 中断标记）。
      // 回归点：appendInterrupted 曾伪 complete 而恰好放行；改落 interrupted 后若判据仍自写
      // 'complete'，中断轮回复会静默从会话视图 / LLM 历史消失。判据 SSOT = isRoundSettled。
      const round = createPendingRound('被取消的提问');
      const interrupted: Round = { ...completeRound(round, '半截回答'), status: 'interrupted' };

      const messages = flattenRoundsToMessages([interrupted]);

      expect(messages).toHaveLength(2);
      expect(messages[0]!.content).toBe('被取消的提问');
      expect(messages[1]!.role).toBe('assistant');
      expect(messages[1]!.content).toBe('半截回答');
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

    it('中断轮同样计 2 条——与宿主 O(1) 缓存（roundIds.length * 2）口径等价', () => {
      // 会话的 roundIds 只登记已收场轮（appendAssistant / appendInterrupted 均仅在终态登记），
      // 故「每已收场轮 = User+AI 两条」的 O(1) 缓存与本节精确口径必须恒等；
      // 若只认 'complete'，中断轮在精确口径算 1 条、在缓存口径算 2 条 → 上下文占用指示器口径分叉。
      const round = createPendingRound('被取消的提问');
      const interrupted: Round = { ...completeRound(round, '半截回答'), status: 'interrupted' };

      expect(countMessagesInRounds([interrupted])).toBe(2);
    });
  });
});
