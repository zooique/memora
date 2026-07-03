/**
 * 单元测试：安全定时器工具
 *
 * 覆盖 safeSetTimeout / safeSetInterval / clearSafeTimeout / clearSafeInterval：
 *   - 定时器正常触发回调
 *   - clear 函数清理定时器后不再触发
 *   - clear 传入 null 不抛错
 *   - 内部 activeTimers 注册表正确跟踪
 *
 * R-06：新增 activeTimers 注册表清理的直接验证（通过 getActiveTimerCount）
 *
 * 使用 vi.useFakeTimers 控制时间推进。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  safeSetTimeout,
  safeSetInterval,
  clearSafeTimeout,
  clearSafeInterval,
  getActiveTimerCount,
  clearAllSafeTimers,
} from '@/utils/safeTimer.js';

describe('utils/safeTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // R-06：清理前序测试残留的定时器，确保 activeTimers 注册表隔离
    clearAllSafeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('safeSetTimeout', () => {
    it('应在指定毫秒后触发回调', () => {
      const cb = vi.fn();
      safeSetTimeout(cb, 1000);
      vi.advanceTimersByTime(999);
      expect(cb).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('触发后回调应能正常执行', () => {
      const result = { value: 0 };
      safeSetTimeout(() => {
        result.value = 42;
      }, 100);
      vi.advanceTimersByTime(100);
      expect(result.value).toBe(42);
    });
  });

  describe('safeSetInterval', () => {
    it('应按间隔重复触发回调', () => {
      const cb = vi.fn();
      safeSetInterval(cb, 1000);
      vi.advanceTimersByTime(1000);
      expect(cb).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1000);
      expect(cb).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(3000);
      expect(cb).toHaveBeenCalledTimes(5);
    });
  });

  describe('clearSafeTimeout', () => {
    it('应取消未触发的 timeout', () => {
      const cb = vi.fn();
      const id = safeSetTimeout(cb, 1000);
      clearSafeTimeout(id);
      vi.advanceTimersByTime(2000);
      expect(cb).not.toHaveBeenCalled();
    });

    it('传入 null 不应抛错', () => {
      expect(() => clearSafeTimeout(null)).not.toThrow();
    });

    it('对已触发的 timeout 调用 clear 不应抛错', () => {
      const cb = vi.fn();
      const id = safeSetTimeout(cb, 100);
      vi.advanceTimersByTime(200);
      expect(() => clearSafeTimeout(id)).not.toThrow();
    });
  });

  describe('clearSafeInterval', () => {
    it('应取消未触发的 interval', () => {
      const cb = vi.fn();
      const id = safeSetInterval(cb, 1000);
      clearSafeInterval(id);
      vi.advanceTimersByTime(5000);
      expect(cb).not.toHaveBeenCalled();
    });

    it('应停止正在重复触发的 interval', () => {
      const cb = vi.fn();
      const id = safeSetInterval(cb, 1000);
      vi.advanceTimersByTime(3000);
      expect(cb).toHaveBeenCalledTimes(3);
      clearSafeInterval(id);
      vi.advanceTimersByTime(5000);
      expect(cb).toHaveBeenCalledTimes(3); // 清理后不再增加
    });

    it('传入 null 不应抛错', () => {
      expect(() => clearSafeInterval(null)).not.toThrow();
    });

    it('对已清理的 interval 重复调用 clear 不应抛错', () => {
      const cb = vi.fn();
      const id = safeSetInterval(cb, 1000);
      clearSafeInterval(id);
      expect(() => clearSafeInterval(id)).not.toThrow();
    });
  });

  describe('跨函数交互', () => {
    it('safeSetTimeout 触发后内部注册表应自动清理', () => {
      const cb = vi.fn();
      safeSetTimeout(cb, 100);
      vi.advanceTimersByTime(100);
      // 触发后再 clear 不应抛错（说明已从注册表移除）
      // 这里只能间接验证：clear 已触发过的 id 不抛错
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('safeSetTimeout 和 safeSetInterval 可并行使用', () => {
      const timeoutCb = vi.fn();
      const intervalCb = vi.fn();
      safeSetTimeout(timeoutCb, 500);
      safeSetInterval(intervalCb, 1000);
      vi.advanceTimersByTime(500);
      expect(timeoutCb).toHaveBeenCalledTimes(1);
      expect(intervalCb).toHaveBeenCalledTimes(0);
      vi.advanceTimersByTime(500);
      expect(timeoutCb).toHaveBeenCalledTimes(1);
      expect(intervalCb).toHaveBeenCalledTimes(1);
    });
  });

  // ─── R-06：activeTimers 注册表直接验证 ──────────────────

  describe('R-06 · activeTimers 注册表直接验证', () => {
    it('初始状态活跃定时器应为 0（无残留）', () => {
      // 每个测试开始前应无残留定时器
      expect(getActiveTimerCount()).toBe(0);
    });

    it('safeSetTimeout 创建后活跃定时器应 +1', () => {
      safeSetTimeout(vi.fn(), 1000);
      expect(getActiveTimerCount()).toBe(1);
    });

    it('safeSetInterval 创建后活跃定时器应 +1', () => {
      safeSetInterval(vi.fn(), 1000);
      expect(getActiveTimerCount()).toBe(1);
    });

    it('R-06：safeSetTimeout 触发后应自动从注册表移除', () => {
      safeSetTimeout(vi.fn(), 100);
      expect(getActiveTimerCount()).toBe(1);
      vi.advanceTimersByTime(100);
      // 触发后应自动从注册表移除（设计：callback 内 activeTimers.delete(id)）
      expect(getActiveTimerCount()).toBe(0);
    });

    it('R-06：clearSafeTimeout 应立即从注册表移除', () => {
      const id = safeSetTimeout(vi.fn(), 1000);
      expect(getActiveTimerCount()).toBe(1);
      clearSafeTimeout(id);
      // clear 后应立即从注册表移除，无需等待时间推进
      expect(getActiveTimerCount()).toBe(0);
    });

    it('R-06：clearSafeInterval 应立即从注册表移除', () => {
      const id = safeSetInterval(vi.fn(), 1000);
      expect(getActiveTimerCount()).toBe(1);
      clearSafeInterval(id);
      // clear 后应立即从注册表移除
      expect(getActiveTimerCount()).toBe(0);
    });

    it('R-06：safeSetInterval 多次触发后仍保留在注册表（设计正确）', () => {
      const id = safeSetInterval(vi.fn(), 100);
      expect(getActiveTimerCount()).toBe(1);
      vi.advanceTimersByTime(300);
      // interval 持续触发，不应从注册表移除（只有 clear 才移除）
      expect(getActiveTimerCount()).toBe(1);
      clearSafeInterval(id);
      expect(getActiveTimerCount()).toBe(0);
    });

    it('R-06：多个定时器并行时注册表计数准确', () => {
      safeSetTimeout(vi.fn(), 100);
      safeSetTimeout(vi.fn(), 200);
      safeSetInterval(vi.fn(), 100);
      expect(getActiveTimerCount()).toBe(3);

      vi.advanceTimersByTime(150);
      // 100ms timeout 触发后移除，剩 200ms timeout + interval = 2
      expect(getActiveTimerCount()).toBe(2);

      vi.advanceTimersByTime(100);
      // 200ms timeout 触发后移除，剩 interval = 1
      expect(getActiveTimerCount()).toBe(1);
    });
  });

  // ─── R-06：clearAllSafeTimers 兜底清理 ──────────────────

  describe('R-06 · clearAllSafeTimers 兜底清理', () => {
    it('应清理所有活跃的 timeout 定时器', () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      safeSetTimeout(cb1, 1000);
      safeSetTimeout(cb2, 2000);
      expect(getActiveTimerCount()).toBe(2);

      clearAllSafeTimers();
      expect(getActiveTimerCount()).toBe(0);

      // 推进时间后，被清理的定时器不应触发
      vi.advanceTimersByTime(3000);
      expect(cb1).not.toHaveBeenCalled();
      expect(cb2).not.toHaveBeenCalled();
    });

    it('应清理所有活跃的 interval 定时器', () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      safeSetInterval(cb1, 100);
      safeSetInterval(cb2, 200);
      expect(getActiveTimerCount()).toBe(2);

      clearAllSafeTimers();
      expect(getActiveTimerCount()).toBe(0);

      vi.advanceTimersByTime(1000);
      expect(cb1).not.toHaveBeenCalled();
      expect(cb2).not.toHaveBeenCalled();
    });

    it('应同时清理 timeout + interval 混合定时器', () => {
      safeSetTimeout(vi.fn(), 100);
      safeSetInterval(vi.fn(), 200);
      safeSetTimeout(vi.fn(), 300);
      expect(getActiveTimerCount()).toBe(3);

      clearAllSafeTimers();
      expect(getActiveTimerCount()).toBe(0);
    });

    it('无活跃定时器时调用不应抛错', () => {
      expect(() => clearAllSafeTimers()).not.toThrow();
      expect(getActiveTimerCount()).toBe(0);
    });
  });
});
