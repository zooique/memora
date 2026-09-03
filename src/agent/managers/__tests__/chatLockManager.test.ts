/**
 * ChatLockManager 单元测试
 *
 * 覆盖范围：
 *   - acquire() / release()：基本获取/释放锁 + token 递增
 *   - 超时保护：超时回调触发 + 锁释放
 *   - race condition 防护：release 时 token 不匹配跳过清理
 *   - forceRelease()：强制释放 + 未持锁时 no-op
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
      // （LLM 无进展由 provider 层超时兜底，2026-09-03 语义收敛）
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

      // 超时回调不 abort 旧流的 abortController（2026-09-03：仅释放锁，不中断生成流）
      expect(abort1.signal.aborted).toBe(false);

      // 清理
      manager.release(token2);
    });
  });

  // ─── forceRelease() ──────────────────────────────────

  describe('forceRelease()', () => {
    it('强制释放锁', () => {
      const { internalAbort } = manager.acquire(180_000);

      expect(manager.isBusy).toBe(true);
      expect(internalAbort.signal.aborted).toBe(false);

      manager.forceRelease();

      expect(manager.isBusy).toBe(false);
      // forceRelease 应 abort 当前 controller
      expect(internalAbort.signal.aborted).toBe(true);
    });

    it('forceRelease 后新 acquire 获取新 token', () => {
      const { token: token1 } = manager.acquire(180_000);
      manager.forceRelease();

      const { token: token2 } = manager.acquire(180_000);
      // forceRelease 递增了 token，新 acquire 又递增一次
      expect(token2).toBe(token1 + 2);

      manager.release(token2);
    });

    it('forceRelease 后旧 release 不应影响新锁', () => {
      const { token: token1 } = manager.acquire(180_000);
      manager.forceRelease();

      const { token: token2 } = manager.acquire(180_000);
      expect(manager.isBusy).toBe(true);

      // 旧 token1 release 应跳过（token 不匹配）
      manager.release(token1);
      expect(manager.isBusy).toBe(true);

      // 清理
      manager.release(token2);
    });

    it('forceRelease 在未持锁时 no-op', () => {
      // 未持锁时调用 forceRelease 不应抛错
      expect(() => manager.forceRelease()).not.toThrow();
      expect(manager.isBusy).toBe(false);
    });

    it('多次调用 forceRelease 安全（幂等）', () => {
      manager.acquire(180_000);
      manager.forceRelease();
      expect(manager.isBusy).toBe(false);

      // 再次调用不应抛错
      expect(() => manager.forceRelease()).not.toThrow();
      expect(manager.isBusy).toBe(false);
    });
  });

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
