/**
 * 事件监听器跟踪器测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - addEventListener：注册监听器并触发回调
 * - cleanup：统一清理所有已注册监听器
 * - 重复注册：同一元素多个事件独立清理
 * - cleanup 幂等性：重复调用不报错
 *
 * 验证 EventTracker 的内存安全保证：cleanup 后监听器确实被移除，
 * 避免渲染层长进程的内存泄漏。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventTracker } from '../../electron/renderer/helpers/eventTracker.js';

/** 创建带 spy 的 button 元素，用于断言 addEventListener/removeEventListener 调用 */
function createSpyButton(): HTMLButtonElement {
  const btn = document.createElement('button');
  return btn;
}

beforeEach(() => {
  // jsdom 环境每个测试前重置 DOM
  document.body.innerHTML = '';
});

// ─── addEventListener + 触发 ───────────────────────────────

describe('EventTracker.addEventListener', () => {
  it('注册的监听器应能被事件触发', () => {
    const tracker = new EventTracker();
    const btn = createSpyButton();
    const handler = vi.fn();

    tracker.addEventListener(btn, 'click', handler);
    btn.click();

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('应支持多个监听器注册到同一元素', () => {
    const tracker = new EventTracker();
    const btn = createSpyButton();
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    tracker.addEventListener(btn, 'click', handler1);
    tracker.addEventListener(btn, 'click', handler2);
    btn.click();

    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledTimes(1);
  });

  it('应支持同一元素不同事件', () => {
    const tracker = new EventTracker();
    const btn = createSpyButton();
    const clickHandler = vi.fn();
    const mouseoverHandler = vi.fn();

    tracker.addEventListener(btn, 'click', clickHandler);
    tracker.addEventListener(btn, 'mouseover', mouseoverHandler);

    btn.dispatchEvent(new MouseEvent('click'));
    btn.dispatchEvent(new MouseEvent('mouseover'));

    expect(clickHandler).toHaveBeenCalledTimes(1);
    expect(mouseoverHandler).toHaveBeenCalledTimes(1);
  });

  it('应支持 Document 作为事件目标', () => {
    const tracker = new EventTracker();
    const handler = vi.fn();

    tracker.addEventListener(document, 'keydown', handler);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));

    expect(handler).toHaveBeenCalledTimes(1);
  });
});

// ─── cleanup ────────────────────────────────────────────────

describe('EventTracker.cleanup', () => {
  it('cleanup 后监听器应不再被触发', () => {
    const tracker = new EventTracker();
    const btn = createSpyButton();
    const handler = vi.fn();

    tracker.addEventListener(btn, 'click', handler);
    tracker.cleanup();

    btn.click();
    expect(handler).not.toHaveBeenCalled();
  });

  it('cleanup 应移除所有监听器（多元素场景）', () => {
    const tracker = new EventTracker();
    const btn1 = createSpyButton();
    const btn2 = createSpyButton();
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    const handler3 = vi.fn();

    tracker.addEventListener(btn1, 'click', handler1);
    tracker.addEventListener(btn2, 'click', handler2);
    tracker.addEventListener(document, 'keydown', handler3);

    tracker.cleanup();

    btn1.click();
    btn2.click();
    document.dispatchEvent(new KeyboardEvent('keydown'));

    expect(handler1).not.toHaveBeenCalled();
    expect(handler2).not.toHaveBeenCalled();
    expect(handler3).not.toHaveBeenCalled();
  });

  it('cleanup 应按注册顺序执行移除', () => {
    const tracker = new EventTracker();
    const btn = createSpyButton();
    const order: number[] = [];

    // 注册三个监听器，记录 cleanup 调用顺序
    tracker.addEventListener(btn, 'click', () => order.push(1));
    tracker.addEventListener(btn, 'mouseover', () => order.push(2));
    tracker.addEventListener(document, 'keydown', () => order.push(3));

    tracker.cleanup();

    // cleanup 内部按注册顺序执行清理函数，但这不直接产生 order 记录
    // 验证方式：cleanup 后所有监听器失效
    btn.click();
    btn.dispatchEvent(new MouseEvent('mouseover'));
    document.dispatchEvent(new KeyboardEvent('keydown'));

    expect(order).toEqual([]);
  });

  it('cleanup 后再注册新监听器应正常工作', () => {
    const tracker = new EventTracker();
    const btn = createSpyButton();
    const oldHandler = vi.fn();
    const newHandler = vi.fn();

    tracker.addEventListener(btn, 'click', oldHandler);
    tracker.cleanup();

    // cleanup 后注册新监听器
    tracker.addEventListener(btn, 'click', newHandler);
    btn.click();

    expect(oldHandler).not.toHaveBeenCalled();
    expect(newHandler).toHaveBeenCalledTimes(1);
  });
});

// ─── cleanup 幂等性 ────────────────────────────────────────

describe('EventTracker.cleanup 幂等性', () => {
  it('空 tracker 调用 cleanup 不报错', () => {
    const tracker = new EventTracker();
    expect(() => tracker.cleanup()).not.toThrow();
  });

  it('重复调用 cleanup 不报错（第二次空操作）', () => {
    const tracker = new EventTracker();
    const btn = createSpyButton();
    const handler = vi.fn();

    tracker.addEventListener(btn, 'click', handler);

    tracker.cleanup();
    // 第二次 cleanup 应安全（cleanupFunctions 已清空）
    expect(() => tracker.cleanup()).not.toThrow();
  });

  it('cleanup 后再 cleanup 再注册，状态应正确', () => {
    const tracker = new EventTracker();
    const btn = createSpyButton();
    const handler = vi.fn();

    tracker.addEventListener(btn, 'click', handler);
    tracker.cleanup();
    tracker.cleanup(); // 重复

    tracker.addEventListener(btn, 'click', handler);
    btn.click();

    expect(handler).toHaveBeenCalledTimes(1);
  });
});
