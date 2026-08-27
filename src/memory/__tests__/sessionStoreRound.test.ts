/**
 * 单元测试：会话存储的 Round-based 模式
 * 验证 SessionMeta 的扩展字段和辅助函数
 */
import { describe, expect, it } from 'vitest';
import {
  createRoundBasedSessionMeta,
  isRoundBasedMode,
  calculateMessageCount,
  generateForkSessionId,
} from '@/memory/sessionStore.js';
import type { SessionMeta } from '@/memory/sessionStore.js';

describe('会话存储 Round-based 模式', () => {
  describe('createRoundBasedSessionMeta', () => {
    it('应该创建带有 round-based 模式的会话元数据', () => {
      const meta = createRoundBasedSessionMeta('2026-08-27-test-session');

      expect(meta.sessionId).toBe('2026-08-27-test-session');
      expect(meta.storageMode).toBe('round-based');
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

  describe('isRoundBasedMode', () => {
    it('应该识别显式声明的 round-based 模式', () => {
      const meta: SessionMeta = {
        sessionId: 'test',
        storageMode: 'round-based',
        updatedAt: new Date().toISOString(),
        messageCount: 0,
      };

      expect(isRoundBasedMode(meta)).toBe(true);
    });

    it('应该识别有 roundIds 字段的模式', () => {
      const meta: SessionMeta = {
        sessionId: 'test',
        roundIds: ['round-1'],
        updatedAt: new Date().toISOString(),
        messageCount: 0,
      };

      expect(isRoundBasedMode(meta)).toBe(true);
    });

    it('应该识别 legacy 模式', () => {
      const meta: SessionMeta = {
        sessionId: 'test',
        updatedAt: new Date().toISOString(),
        messageCount: 0,
      };

      expect(isRoundBasedMode(meta)).toBe(false);
    });

    it('应该处理 undefined 输入', () => {
      expect(isRoundBasedMode(undefined)).toBe(false);
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

  describe('generateForkSessionId', () => {
    it('应该生成唯一的分叉会话 ID', () => {
      const forkId1 = generateForkSessionId('2026-08-27-original');
      const forkId2 = generateForkSessionId('2026-08-27-original');

      // 格式检查
      expect(forkId1).toContain('-fork-');
      expect(forkId2).toContain('-fork-');

      // 唯一性（时间戳不同）
      expect(forkId1).not.toBe(forkId2);
    });

    it('应该保留原始会话名', () => {
      const forkId = generateForkSessionId('2026-08-27-my-conversation');

      // 应该保留会话名部分
      expect(forkId).toContain('my-conversation');
    });

    it('应该包含当前日期', () => {
      const now = new Date();
      const dateStr = now.toISOString().slice(0, 10);
      const forkId = generateForkSessionId('test');

      expect(forkId.startsWith(dateStr)).toBe(true);
    });
  });
});
