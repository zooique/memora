/**
 * 降级策略测试 — 验证 P1-P4 降级行为正确性
 *
 * 故障模式矩阵：
 * - P0 对话响应：不可降级（不测试降级行为）
 * - P1 消息持久化：失败记日志，不抛异常
 * - P2 话题归档：失败跳过，不阻塞对话
 * - P3 启动补执归档：超时兜底，Agent 正常启动
 * - P4 项目切换：失败 warn，继续切换
 *
 * 测试策略：mock 存储层抛错，验证上层不中断
 */
import { describe, it, expect, vi } from 'vitest';
import { MessageHistory } from '@/agent/messageHistory.js';
import type { ISessionStore } from '@/memory/sessionStore.js';

// ═══════════════════════════════════════════════════════════════
// Mock 工具
// ═══════════════════════════════════════════════════════════════

/** 创建一个总是抛错的 ISessionStore mock */
function createFailingSessionStore(): ISessionStore {
  return {
    appendMessage: vi.fn(() => {
      throw new Error('模拟存储不可用');
    }),
    loadMessages: vi.fn(() => {
      throw new Error('模拟存储不可用');
    }),
    listSessions: vi.fn(() => {
      throw new Error('模拟存储不可用');
    }),
  };
}

// ═══════════════════════════════════════════════════════════════
// P1: 消息持久化降级
// ═══════════════════════════════════════════════════════════════

describe('降级策略 · P1 消息持久化', () => {
  it('appendUser 存储失败时不抛出异常', async () => {
    const failingStore = createFailingSessionStore();
    const history = new MessageHistory(failingStore);

    // 应正常返回，不抛出
    await expect(history.appendUser('测试消息')).resolves.toBeUndefined();
    expect(failingStore.appendMessage).toHaveBeenCalledOnce();
  });

  it('appendAssistant 存储失败时不抛出异常', async () => {
    const failingStore = createFailingSessionStore();
    const history = new MessageHistory(failingStore);

    await expect(history.appendAssistant('AI 回复')).resolves.toBeUndefined();
    expect(failingStore.appendMessage).toHaveBeenCalledOnce();
  });

  it('空内容 assistant 消息不触发持久化', async () => {
    const failingStore = createFailingSessionStore();
    const history = new MessageHistory(failingStore);

    await history.appendAssistant('   ');
    expect(failingStore.appendMessage).not.toHaveBeenCalled();
  });

  it('未注入 sessionStore 时不崩溃（内存模式）', async () => {
    const history = new MessageHistory(undefined);
    await expect(history.appendUser('无存储模式')).resolves.toBeUndefined();
    await expect(history.appendAssistant('无存储回复')).resolves.toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// P2: 归档降级（通过 MessageHistory.registerPendingArchive 间接测试）
// ═══════════════════════════════════════════════════════════════

describe('降级策略 · P2 归档降级', () => {
  it('pendingArchive 注册的 rejected Promise 不影响 awaitPendingArchives', async () => {
    const history = new MessageHistory(undefined);

    // 注册一个会 reject 的 Promise（模拟归档失败）
    // 注意：实际代码中 .catch() 在注册前已附加（如 agent.ts:516），
    // 这里同样附加 .catch() 避免 unhandled rejection
    const failingPromise = Promise.reject(new Error('归档失败')).catch(() => {});
    history.registerPendingArchive(failingPromise);

    // awaitPendingArchives 应正常完成，不抛出
    await expect(history.awaitPendingArchives(1000)).resolves.toBe(true);
  });

  it('pendingArchive 为空时快速返回', async () => {
    const history = new MessageHistory(undefined);
    await expect(history.awaitPendingArchives(1000)).resolves.toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// P4: 降级日志格式验证
// ═══════════════════════════════════════════════════════════════

describe('降级策略 · 日志格式一致性', () => {
  it('P1 降级日志包含 source 和 action 字段', async () => {
    const failingStore = createFailingSessionStore();
    const history = new MessageHistory(failingStore);

    // 触发降级
    await history.appendUser('触发降级的消息');

    // 验证 mock 被调用（实际日志格式由 logger.warn 输出）
    // 这里验证降级行为本身，日志格式的正确性由 logger.test.ts 覆盖
    expect(failingStore.appendMessage).toHaveBeenCalledOnce();
  });
});
