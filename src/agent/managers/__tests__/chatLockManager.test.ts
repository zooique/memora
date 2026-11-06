/**
 * ChatLockManager 单元测试
 *
 * 覆盖范围：
 *   - acquire() / release()：基本获取/释放锁 + token 递增
 *   - 超时保护：超时回调触发 + 锁释放
 *   - race condition 防护：release 时 token 不匹配跳过清理
 *   - attachExternalSignal()：外部 abort 触发内部 abort + 已 aborted 的 signal
 *   - isBusy 状态正确性
 *   - dispose()：销毁清理
 *
 * 测试范式：真实 ChatLockManager 实例 + vi.useFakeTimers（仅超时测试）
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { ChatLockManager } from '@/agent/managers/chatLockManager.js';
import { clearAllSafeTimers } from '@/utils/safeTimer.js';

describe('ChatLockManager', () => {
  let manager: ChatLockManager;

  beforeEach(() => {
    manager = new ChatLockManager();
  });

  afterEach(() => {
    // 清理所有活跃定时器，确保测试隔离
    clearAllSafeTimers();
  });

  // ─── isBusy 状态 ──────────────────────────────────────

  describe('isBusy', () => {
    it('初始状态应为 false', () => {
      expect(manager.isBusy).toBe(false);
    });

    it('acquire 后应为 true', () => {
      manager.acquire(180_000);
      expect(manager.isBusy).toBe(true);
    });

    it('release 后应为 false', () => {
      const { token } = manager.acquire(180_000);
      manager.release(token);
      expect(manager.isBusy).toBe(false);
    });
  });

  // ─── acquire() + release() ────────────────────────────

  describe('acquire() + release()', () => {
    it('基本获取/释放锁', () => {
      const { token, internalAbort } = manager.acquire(180_000);

      expect(token).toBe(1);
      expect(internalAbort).toBeInstanceOf(AbortController);
      expect(manager.isBusy).toBe(true);

      manager.release(token);
      expect(manager.isBusy).toBe(false);
    });

    it('token 递增（多次 acquire）', () => {
      const first = manager.acquire(180_000);
      expect(first.token).toBe(1);
      manager.release(first.token);

      const second = manager.acquire(180_000);
      expect(second.token).toBe(2);
      manager.release(second.token);

      const third = manager.acquire(180_000);
      expect(third.token).toBe(3);
      manager.release(third.token);
    });

    it('acquire 返回的 internalAbort.signal 初始未 aborted', () => {
      const { internalAbort } = manager.acquire(180_000);
      expect(internalAbort.signal.aborted).toBe(false);
    });

    it('release 后再 acquire 获取新 token', () => {
      const { token: token1 } = manager.acquire(180_000);
      manager.release(token1);

      const { token: token2 } = manager.acquire(180_000);
      expect(token2).toBe(token1 + 1);
      manager.release(token2);
    });
  });

  // ─── release() token 校验 ─────────────────────────────

  describe('release() token 校验', () => {
    it('finally release 时 token 不匹配跳过清理', () => {
      const { token: token1 } = manager.acquire(180_000);
      // 模拟超时释放后新调用获取锁（token 递增）
      const { token: token2 } = manager.acquire(180_000);

      // 用旧 token1 release，应跳过清理（token 不匹配）
      manager.release(token1);

      // 锁仍被 token2 持有
      expect(manager.isBusy).toBe(true);

      // 清理：用正确 token2 release
      manager.release(token2);
      expect(manager.isBusy).toBe(false);
    });

    it('release 已释放的 token 不影响当前锁', () => {
      const { token: token1 } = manager.acquire(180_000);
      manager.release(token1);

      // 再次 release 同一 token，不应出错也不应影响状态
      manager.release(token1);
      expect(manager.isBusy).toBe(false);
    });
  });

  // ─── 超时保护 ─────────────────────────────────────────

  describe('超时保护', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('超时回调触发 + 锁释放（不中断生成流）', () => {
      const { internalAbort } = manager.acquire(180_000);

      expect(manager.isBusy).toBe(true);
      expect(internalAbort.signal.aborted).toBe(false);

      // 推进时间触发超时
      vi.advanceTimersByTime(180_000);

      // 超时后锁释放；内部 abort 不被触发——锁超时仅释放锁，不中断生成流
      // （LLM 无进展由 provider 层超时兜底）
      expect(manager.isBusy).toBe(false);
      expect(internalAbort.signal.aborted).toBe(false);
    });

    it('超时回调触发 onTimeout 回调', () => {
      let timeoutCalled = false;
      manager.acquire(180_000, () => {
        timeoutCalled = true;
      });

      vi.advanceTimersByTime(180_000);

      expect(timeoutCalled).toBe(true);
    });

    it('超时后新 acquire 获取新 token（不抛错）', () => {
      const { token: token1 } = manager.acquire(180_000);

      // 推进时间触发超时
      vi.advanceTimersByTime(180_000);
      expect(manager.isBusy).toBe(false);

      // 新调用应能获取锁；超时释放时已自增 token（防旧 release 误清），新 acquire 再增
      const { token: token2 } = manager.acquire(180_000);
      expect(token2).toBe(token1 + 2);
      expect(manager.isBusy).toBe(true);

      // 清理
      manager.release(token2);
    });

    it('race condition：超时后新调用获取锁，旧 release 不应误清新调用者的锁', () => {
      const { token: token1, internalAbort: abort1 } = manager.acquire(180_000);

      // 推进时间触发超时（锁释放）
      vi.advanceTimersByTime(180_000);
      expect(manager.isBusy).toBe(false);

      // 新调用获取锁
      const { token: token2 } = manager.acquire(180_000);
      expect(manager.isBusy).toBe(true);

      // 旧调用的 finally 用 token1 release，应跳过清理（token 不匹配）
      manager.release(token1);

      // 关键断言：新调用的锁应仍然存在
      expect(manager.isBusy).toBe(true);

      // 超时回调不 abort 旧流的 abortController（仅释放锁，不中断生成流）
      expect(abort1.signal.aborted).toBe(false);

      // 清理
      manager.release(token2);
    });
  });

  // 删后注记（2026-10-16 · 5.0.0）：曾有 describe('forceRelease()')——覆盖强制释放（abort controller /
  // token 递增 / 幂等 / 未持锁 no-op）。forceRelease 被公开 Agent.forceReleaseChatLock 唯一调用，
  // 该门面宿主零真实调用（承诺的无进展超时兜底从未接线），门面拆除后 forceRelease 无调用者，一并删除。
  // 锁释放现仅走 release(token) 与 dispose()（下方 describe 已覆盖）。

  // ─── attachExternalSignal() ──────────────────────────

  describe('attachExternalSignal()', () => {
    it('外部 abort 触发内部 abort', () => {
      const { internalAbort } = manager.acquire(180_000);
      const externalController = new AbortController();

      const cleanup = manager.attachExternalSignal(externalController.signal, internalAbort);

      expect(internalAbort.signal.aborted).toBe(false);

      // 外部 abort 触发内部 abort
      externalController.abort();
      expect(internalAbort.signal.aborted).toBe(true);

      // 清理函数应能安全调用
      cleanup();
    });

    it('attachExternalSignal 已 aborted 的 signal', () => {
      const { internalAbort } = manager.acquire(180_000);
      const externalController = new AbortController();

      // 先 abort 外部 signal
      externalController.abort();

      const cleanup = manager.attachExternalSignal(externalController.signal, internalAbort);

      // 内部应立即被触发 abort
      expect(internalAbort.signal.aborted).toBe(true);

      cleanup();
    });

    it('未传 externalSignal 时返回 no-op 清理函数', () => {
      const { internalAbort } = manager.acquire(180_000);

      const cleanup = manager.attachExternalSignal(undefined, internalAbort);

      // 清理函数应能安全调用
      expect(() => cleanup()).not.toThrow();
      expect(internalAbort.signal.aborted).toBe(false);
    });

    it('cleanup 后外部 abort 不再触发内部 abort', () => {
      const { internalAbort } = manager.acquire(180_000);
      const externalController = new AbortController();

      const cleanup = manager.attachExternalSignal(externalController.signal, internalAbort);

      // 先 cleanup（移除监听器）
      cleanup();

      // 外部 abort 后内部不应被触发
      externalController.abort();
      expect(internalAbort.signal.aborted).toBe(false);
    });
  });

  // ─── dispose() ────────────────────────────────────────

  describe('dispose()', () => {
    it('dispose 释放锁并 abort controller', () => {
      const { internalAbort } = manager.acquire(180_000);

      expect(manager.isBusy).toBe(true);

      manager.dispose();

      expect(manager.isBusy).toBe(false);
      expect(internalAbort.signal.aborted).toBe(true);
    });

    it('dispose 后旧 release 不应影响状态', () => {
      const { token } = manager.acquire(180_000);
      manager.dispose();

      // 旧 token release 应跳过（token 不匹配）
      manager.release(token);
      expect(manager.isBusy).toBe(false);
    });

    it('未持锁时 dispose 安全调用', () => {
      expect(() => manager.dispose()).not.toThrow();
      expect(manager.isBusy).toBe(false);
    });
  });
});
