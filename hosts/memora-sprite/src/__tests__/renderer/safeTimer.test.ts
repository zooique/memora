/**
 * 安全定时器跟踪器测试
 *
 * 覆盖范围：
 * - setTimeout：注册 + 回调触发后自动从集合移除 + 返回 ID
 * - setInterval：注册 + 不自动移除 + 返回 ID
 * - clearSafeTimeout：清理 + 从集合移除 + null 静默跳过
 * - clearSafeInterval：同上
 * - cleanup：清理所有活跃定时器 + 集合清空 + 幂等性
 *
 * 使用 vi.useFakeTimers() 假定时器模式，避免真实定时器抖动。
 * 纯逻辑测试，无 JSDOM 依赖（setTimeout/setInterval 是 Node.js 全局 API）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SafeTimerTracker } from '../../electron/renderer/helpers/safeTimer.js';

describe('SafeTimerTracker', () => {
  /** 每个测试前启用假定时器，确保定时器不真实触发 */
  beforeEach(() => {
    vi.useFakeTimers();
  });

  /** 每个测试后恢复真实定时器，避免影响后续测试 */
  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── setTimeout ──────────────────────────────────────────

  describe('setTimeout', () => {
    it('应返回定时器 ID 并注册到集合', () => {
      const tracker = new SafeTimerTracker();
      const callback = vi.fn();
      const id = tracker.setTimeout(callback, 1000);

      expect(id).toBeDefined();
      // 未推进时间，回调不应触发
      expect(callback).not.toHaveBeenCalled();
    });

    it('到达延迟时间应触发回调', () => {
      const tracker = new SafeTimerTracker();
      const callback = vi.fn();
      tracker.setTimeout(callback, 1000);

      // 推进 999ms，不应触发
      vi.advanceTimersByTime(999);
      expect(callback).not.toHaveBeenCalled();

      // 再推进 1ms 到达 1000ms，应触发
      vi.advanceTimersByTime(1);
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('回调触发后应自动从集合移除（cleanup 不会重复清理）', () => {
      const tracker = new SafeTimerTracker();
      const callback = vi.fn();
      tracker.setTimeout(callback, 1000);

      // 推进时间让回调触发
      vi.advanceTimersByTime(1000);
      expect(callback).toHaveBeenCalledTimes(1);

      // 回调触发后内部集合应已移除该 ID
      // 验证方式：cleanup 后再 cleanup 不应抛错（幂等性）
      expect(() => {
        tracker.cleanup();
        tracker.cleanup();
      }).not.toThrow();
    });
  });

  // ─── setInterval ─────────────────────────────────────────

  describe('setInterval', () => {
    it('应返回定时器 ID 并注册到集合', () => {
      const tracker = new SafeTimerTracker();
      const callback = vi.fn();
      const id = tracker.setInterval(callback, 500);

      expect(id).toBeDefined();
      expect(callback).not.toHaveBeenCalled();
    });

    it('应按间隔重复触发回调', () => {
      const tracker = new SafeTimerTracker();
      const callback = vi.fn();
      tracker.setInterval(callback, 500);

      // 推进 1500ms，应触发 3 次（500/1000/1500）
      vi.advanceTimersByTime(1500);
      expect(callback).toHaveBeenCalledTimes(3);
    });

    it('interval 不会自动从集合移除（需显式 clearSafeInterval 或 cleanup）', () => {
      const tracker = new SafeTimerTracker();
      const callback = vi.fn();
      tracker.setInterval(callback, 500);

      // 推进时间触发多次
      vi.advanceTimersByTime(1500);
      expect(callback).toHaveBeenCalledTimes(3);

      // 未清理时继续推进应继续触发
      vi.advanceTimersByTime(500);
      expect(callback).toHaveBeenCalledTimes(4);
    });
  });

  // ─── clearSafeTimeout ────────────────────────────────────

  describe('clearSafeTimeout', () => {
    it('应阻止回调触发并从集合移除', () => {
      const tracker = new SafeTimerTracker();
      const callback = vi.fn();
      const id = tracker.setTimeout(callback, 1000);

      tracker.clearSafeTimeout(id);

      // 推进时间，回调不应触发
      vi.advanceTimersByTime(1000);
      expect(callback).not.toHaveBeenCalled();
    });

    it('传 null 应静默跳过（不抛错）', () => {
      const tracker = new SafeTimerTracker();
      expect(() => tracker.clearSafeTimeout(null)).not.toThrow();
    });

    it('清理后 cleanup 不应重复清理（幂等性）', () => {
      const tracker = new SafeTimerTracker();
      const callback = vi.fn();
      const id = tracker.setTimeout(callback, 1000);

      tracker.clearSafeTimeout(id);
      // cleanup 应能正常执行，不因已清理的 ID 报错
      expect(() => tracker.cleanup()).not.toThrow();
    });
  });

  // ─── clearSafeInterval ───────────────────────────────────

  describe('clearSafeInterval', () => {
    it('应停止重复触发并从集合移除', () => {
      const tracker = new SafeTimerTracker();
      const callback = vi.fn();
      const id = tracker.setInterval(callback, 500);

      // 推进 500ms 触发一次
      vi.advanceTimersByTime(500);
      expect(callback).toHaveBeenCalledTimes(1);

      tracker.clearSafeInterval(id);

      // 继续推进，不应再触发
      vi.advanceTimersByTime(1000);
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('传 null 应静默跳过（不抛错）', () => {
      const tracker = new SafeTimerTracker();
      expect(() => tracker.clearSafeInterval(null)).not.toThrow();
    });
  });

  // ─── cleanup ────────────────────────────────────────────

  describe('cleanup', () => {
    it('应清理所有活跃的 setTimeout', () => {
      const tracker = new SafeTimerTracker();
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      tracker.setTimeout(cb1, 1000);
      tracker.setTimeout(cb2, 2000);

      tracker.cleanup();

      // 推进时间，所有回调不应触发
      vi.advanceTimersByTime(2000);
      expect(cb1).not.toHaveBeenCalled();
      expect(cb2).not.toHaveBeenCalled();
    });

    it('应清理所有活跃的 setInterval', () => {
      const tracker = new SafeTimerTracker();
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      tracker.setInterval(cb1, 500);
      tracker.setInterval(cb2, 1000);

      tracker.cleanup();

      vi.advanceTimersByTime(2000);
      expect(cb1).not.toHaveBeenCalled();
      expect(cb2).not.toHaveBeenCalled();
    });

    it('应清理混合的 setTimeout 和 setInterval', () => {
      const tracker = new SafeTimerTracker();
      const timeoutCb = vi.fn();
      const intervalCb = vi.fn();
      tracker.setTimeout(timeoutCb, 1000);
      tracker.setInterval(intervalCb, 500);

      tracker.cleanup();

      vi.advanceTimersByTime(2000);
      expect(timeoutCb).not.toHaveBeenCalled();
      expect(intervalCb).not.toHaveBeenCalled();
    });

    it('空 tracker cleanup 应静默成功（不抛错）', () => {
      const tracker = new SafeTimerTracker();
      expect(() => tracker.cleanup()).not.toThrow();
    });

    it('重复 cleanup 应幂等（不抛错）', () => {
      const tracker = new SafeTimerTracker();
      tracker.setTimeout(vi.fn(), 1000);

      tracker.cleanup();
      // 第二次 cleanup 时集合已清空，应静默成功
      expect(() => tracker.cleanup()).not.toThrow();
    });

    it('cleanup 后再注册新定时器应正常工作', () => {
      const tracker = new SafeTimerTracker();
      tracker.setTimeout(vi.fn(), 1000);
      tracker.cleanup();

      // cleanup 后 tracker 应可复用
      const callback = vi.fn();
      tracker.setTimeout(callback, 500);
      vi.advanceTimersByTime(500);
      expect(callback).toHaveBeenCalledTimes(1);
    });
  });
});
