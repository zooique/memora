/**
 * 单元测试：会话存储的 Round-based 模式
 * 验证 SessionMeta 的扩展字段和辅助函数
 */
import { describe, expect, it } from 'vitest';
import {
  createRoundBasedSessionMeta,
  calculateMessageCount,
} from '@/memory/sessionStore.js';

describe('会话存储 Round-based 模式', () => {
  describe('createRoundBasedSessionMeta', () => {
    it('应该创建以 roundIds 为唯一内容来源的会话元数据', () => {
      const meta = createRoundBasedSessionMeta('2026-08-27-test-session');

      expect(meta.sessionId).toBe('2026-08-27-test-session');
      expect(meta.roundIds).toEqual([]);
      expect(meta.createdAt).toBeDefined();
      expect(meta.updatedAt).toBeDefined();
      expect(meta.messageCount).toBe(0);
    });

    it('应该支持初始 Round ID 列表', () => {
      const roundIds = ['round-1', 'round-2', 'round-3'];
      const meta = createRoundBasedSessionMeta('test-session', roundIds);

      expect(meta.roundIds).toEqual(roundIds);
      expect(meta.messageCount).toBe(roundIds.length * 2); // 每个 Round 2 条消息
    });

    it('应该生成唯一的 createdAt 和 updatedAt', () => {
      const meta1 = createRoundBasedSessionMeta('session1');
      const meta2 = createRoundBasedSessionMeta('session2');

      expect(meta1.createdAt).not.toBe(meta2.createdAt);
    });
  });

  describe('calculateMessageCount', () => {
    it('应该估算 Round 列表的消息数', () => {
      const roundIds = ['round-1', 'round-2', 'round-3'];
      const count = calculateMessageCount(roundIds);

      expect(count).toBe(6); // 3 * 2
    });

    it('应该处理空列表', () => {
      const count = calculateMessageCount([]);
      expect(count).toBe(0);
    });
  });
});
