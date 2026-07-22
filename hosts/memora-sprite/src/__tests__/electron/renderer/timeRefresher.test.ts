/**
 * 全局相对时间刷新器测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - start/stop 生命周期：幂等保护、监听器注册与移除
 * - refreshAll：遍历 [data-timestamp] 元素并重算 textContent
 * - 触发时机：window focus / visibilitychange / setInterval
 * - refreshIfVisible：窗口隐藏时不刷新
 *
 * 验证 TimeRefresher 的核心保证：
 * - DOM 上保留原始时间戳的元素能被正确刷新
 * - 定时器仅在窗口可见时执行
 * - stop 后所有监听与定时器被清理，无内存泄漏
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { timeRefresher } from '../../../electron/renderer/helpers/timeRefresher.js';

/** 创建带 data-timestamp 的时间元素并附加到 body */
function createTimeElement(iso: string, initialText = ''): HTMLElement {
  const el = document.createElement('span');
  el.className = 'test-time';
  el.dataset.timestamp = iso;
  el.textContent = initialText;
  document.body.appendChild(el);
  return el;
}

beforeEach(() => {
  // jsdom 环境每个测试前重置 DOM + 确保刷新器处于停止状态
  document.body.innerHTML = '';
  timeRefresher.stop();
});

afterEach(() => {
  // 每个测试后清理，避免监听器跨测试污染
  timeRefresher.stop();
});

// ─── start/stop 生命周期 ───────────────────────────────────

describe('TimeRefresher 生命周期', () => {
  it('start 后 stop 应能正确清理（可重复调用）', () => {
    // 幂等：start 后再 start 不报错
    timeRefresher.start();
    timeRefresher.start();
    // stop 后再 stop 不报错
    timeRefresher.stop();
    timeRefresher.stop();
    expect(true).toBe(true);
  });

  it('stop 后 refreshAll 仍可手动调用', () => {
    const el = createTimeElement(new Date(Date.now() - 5 * 60_000).toISOString(), '旧文本');
    timeRefresher.stop();
    timeRefresher.refreshAll();
    // 即使停止，手动调用 refreshAll 仍能刷新
    expect(el.textContent).toBe('5 分钟前');
  });
});

// ─── refreshAll ────────────────────────────────────────────

describe('TimeRefresher.refreshAll', () => {
  it('应刷新带 data-timestamp 的元素为"刚刚"', () => {
    const el = createTimeElement(new Date().toISOString(), '初始');
    timeRefresher.refreshAll();
    expect(el.textContent).toBe('刚刚');
  });

  it('应刷新带 data-timestamp 的元素为"N 分钟前"', () => {
    // 5 分钟前
    const iso = new Date(Date.now() - 5 * 60_000).toISOString();
    const el = createTimeElement(iso, '初始');
    timeRefresher.refreshAll();
    expect(el.textContent).toBe('5 分钟前');
  });

  it('应刷新带 data-timestamp 的元素为"N 小时前"', () => {
    // 3 小时前
    const iso = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    const el = createTimeElement(iso, '初始');
    timeRefresher.refreshAll();
    expect(el.textContent).toBe('3 小时前');
  });

  it('应同时刷新多个元素', () => {
    const el1 = createTimeElement(new Date().toISOString(), 'a');
    const el2 = createTimeElement(new Date(Date.now() - 10 * 60_000).toISOString(), 'b');
    timeRefresher.refreshAll();
    expect(el1.textContent).toBe('刚刚');
    expect(el2.textContent).toBe('10 分钟前');
  });

  it('无 data-timestamp 的元素不应被刷新', () => {
    const el = document.createElement('span');
    el.textContent = '保持不变';
    document.body.appendChild(el);
    timeRefresher.refreshAll();
    expect(el.textContent).toBe('保持不变');
  });

  it('data-timestamp 为空字符串时应跳过（不报错）', () => {
    const el = document.createElement('span');
    el.dataset.timestamp = '';
    el.textContent = '原文本';
    document.body.appendChild(el);
    timeRefresher.refreshAll();
    // 空 timestamp 被跳过，textContent 不变
    expect(el.textContent).toBe('原文本');
  });
});

// ─── 触发时机 ──────────────────────────────────────────────

describe('TimeRefresher 触发时机', () => {
  it('window focus 应触发刷新', () => {
    const el = createTimeElement(new Date().toISOString(), '初始');
    timeRefresher.start();
    // 模拟窗口获得焦点
    window.dispatchEvent(new Event('focus'));
    expect(el.textContent).toBe('刚刚');
  });

  it('visibilitychange (hidden→visible) 应触发刷新', () => {
    const el = createTimeElement(new Date().toISOString(), '初始');
    timeRefresher.start();
    // 模拟从隐藏变为可见
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(el.textContent).toBe('刚刚');
  });

  it('visibilitychange (visible→hidden) 不应触发刷新', () => {
    const el = createTimeElement(new Date().toISOString(), '初始');
    timeRefresher.start();
    // 模拟从可见变为隐藏
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    // 隐藏方向不刷新，textContent 不变
    expect(el.textContent).toBe('初始');
  });

  it('setInterval 到期且窗口可见时应刷新', () => {
    vi.useFakeTimers();
    try {
      // fake timers 会冻结 Date.now()，元素创建时记录的是"当前"时间
      const el = createTimeElement(new Date().toISOString(), '初始');
      timeRefresher.start();
      // 窗口可见状态下推进定时器
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      });
      // 推进 60 秒触发 setInterval 回调：此时 Date.now() 已 +60s，
      // 元素的 timestamp 距"现在"正好 1 分钟，应显示"1 分钟前"（验证刷新确实发生）
      vi.advanceTimersByTime(60_000);
      expect(el.textContent).toBe('1 分钟前');
    } finally {
      vi.useRealTimers();
    }
  });

  it('setInterval 到期但窗口隐藏时不应刷新', () => {
    vi.useFakeTimers();
    try {
      const el = createTimeElement(new Date().toISOString(), '初始');
      timeRefresher.start();
      // 窗口隐藏状态
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      });
      vi.advanceTimersByTime(60_000);
      // 隐藏时不刷新，textContent 不变
      expect(el.textContent).toBe('初始');
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── stop 后监听清理 ───────────────────────────────────────

describe('TimeRefresher.stop 监听清理', () => {
  it('stop 后 window focus 不再触发刷新', () => {
    const el = createTimeElement(new Date().toISOString(), '初始');
    timeRefresher.start();
    timeRefresher.stop();
    // stop 后 dispatch focus 不应刷新
    window.dispatchEvent(new Event('focus'));
    expect(el.textContent).toBe('初始');
  });

  it('stop 后 visibilitychange 不再触发刷新', () => {
    const el = createTimeElement(new Date().toISOString(), '初始');
    timeRefresher.start();
    timeRefresher.stop();
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(el.textContent).toBe('初始');
  });

  it('stop 后 setInterval 不再触发刷新', () => {
    vi.useFakeTimers();
    try {
      const el = createTimeElement(new Date().toISOString(), '初始');
      timeRefresher.start();
      timeRefresher.stop();
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      });
      vi.advanceTimersByTime(120_000);
      expect(el.textContent).toBe('初始');
    } finally {
      vi.useRealTimers();
    }
  });
});
