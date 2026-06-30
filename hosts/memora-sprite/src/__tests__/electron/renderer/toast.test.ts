/**
 * Toast 通知管理器测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - showToast 容器缺失：静默退出
 * - showToast FIFO 限制：达到 maxVisible=5 移除最早 / 未达不移除
 * - showToast 4 类型图标：success(✓) / error(✗) / warning(⚠) / info(ℹ)
 * - showToast role 属性：error→alert / 其他→status
 * - showToast 重试按钮：显示 + 点击触发 onRetry + 移除 toast
 * - showToast 自定义操作按钮：显示 + 点击触发 onAction + 移除 toast
 * - showToast 关闭按钮：点击移除 toast（淡出动画）
 * - showToast 自动消失：默认 4000ms / error 不消失 / 有按钮不消失
 * - cleanup：清理所有定时器
 *
 * Mock 策略：
 * - vi.useFakeTimers 验证自动消失定时器
 * - JSDOM 提供真实 DOM API（classList/appendChild/querySelector/dispatchEvent）
 * - animationend 事件需手动 dispatch（JSDOM 不触发真实动画）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToastManager } from '../../../electron/renderer/components/toast.js';

// ─── 测试辅助 ─────────────────────────────────────────────

/** 创建 ToastManager + toast-container */
function createManager(opts?: { html?: string }): ToastManager {
  document.body.innerHTML = opts?.html ?? '<div id="toast-container"></div>';
  return new ToastManager();
}

/** 派发 animationend 事件（removeToast 用 animationend 监听移除元素） */
function dispatchAnimationEnd(toast: HTMLElement): void {
  const event = new Event('animationend', { bubbles: true });
  toast.dispatchEvent(event);
}

/** 获取最后添加的 toast 元素 */
function getLastToast(): HTMLElement {
  return document.querySelector('#toast-container .toast:last-child') as HTMLElement;
}

// ─── 全局设置 ─────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

// ─── showToast · 容器缺失 ───────────────────────────────

describe('showToast · 容器缺失', () => {
  it('toast-container 不存在时应静默退出', () => {
    document.body.innerHTML = '';
    const manager = new ToastManager();
    expect(() => manager.showToast('测试', 'info')).not.toThrow();
    // 不应创建任何 toast
    expect(document.querySelectorAll('.toast').length).toBe(0);
  });
});

// ─── showToast · FIFO 限制 ───────────────────────────────

describe('showToast · FIFO 限制', () => {
  it('达到 maxVisible=5 时应移除最早的 toast', () => {
    const manager = createManager();
    // 添加 5 条（达到上限）
    for (let i = 0; i < 5; i++) {
      manager.showToast(`消息${i}`, 'info');
    }
    expect(document.querySelectorAll('.toast').length).toBe(5);

    // 添加第 6 条，应移除最早的（消息0）
    manager.showToast('消息5', 'info');
    const toasts = document.querySelectorAll('.toast');
    expect(toasts.length).toBe(5);
    // 第一条应为消息1（消息0 被移除）
    expect(toasts[0].querySelector('.toast-content')!.textContent).toBe('消息1');
  });

  it('未达到 maxVisible 时不应移除 toast', () => {
    const manager = createManager();
    manager.showToast('消息1', 'info');
    manager.showToast('消息2', 'info');
    expect(document.querySelectorAll('.toast').length).toBe(2);
  });

  it('新 toast 应追加到容器末尾', () => {
    const manager = createManager();
    manager.showToast('消息1', 'info');
    manager.showToast('消息2', 'info');
    const toasts = document.querySelectorAll('.toast');
    expect(toasts[0].querySelector('.toast-content')!.textContent).toBe('消息1');
    expect(toasts[1].querySelector('.toast-content')!.textContent).toBe('消息2');
  });
});

// ─── showToast · 4 类型图标 ─────────────────────────────

describe('showToast · 类型图标', () => {
  it('success 应显示 ✓ 图标', () => {
    const manager = createManager();
    manager.showToast('成功', 'success');
    expect(getLastToast().querySelector('.toast-icon')!.textContent).toBe('✓');
  });

  it('error 应显示 ✗ 图标', () => {
    const manager = createManager();
    manager.showToast('错误', 'error');
    expect(getLastToast().querySelector('.toast-icon')!.textContent).toBe('✗');
  });

  it('warning 应显示 ⚠ 图标', () => {
    const manager = createManager();
    manager.showToast('警告', 'warning');
    expect(getLastToast().querySelector('.toast-icon')!.textContent).toBe('⚠');
  });

  it('info（默认）应显示 ℹ 图标', () => {
    const manager = createManager();
    manager.showToast('提示'); // 默认 info
    expect(getLastToast().querySelector('.toast-icon')!.textContent).toBe('ℹ');
  });
});

// ─── showToast · role 属性 ───────────────────────────────

describe('showToast · role 属性（无障碍）', () => {
  it('error 应设置 role="alert"', () => {
    const manager = createManager();
    manager.showToast('错误', 'error');
    expect(getLastToast().getAttribute('role')).toBe('alert');
  });

  it('非 error 应设置 role="status"', () => {
    const manager = createManager();
    manager.showToast('成功', 'success');
    expect(getLastToast().getAttribute('role')).toBe('status');
  });
});

// ─── showToast · 重试按钮 ────────────────────────────────

describe('showToast · 重试按钮', () => {
  it('提供 onRetry 时应显示重试按钮', () => {
    const manager = createManager();
    manager.showToast('失败', 'error', undefined, { onRetry: vi.fn() });
    const retryBtn = getLastToast().querySelector('.toast-retry') as HTMLButtonElement;
    expect(retryBtn).not.toBeNull();
    expect(retryBtn.textContent).toBe('重试');
    expect(retryBtn.title).toBe('重新发送上一条消息');
  });

  it('未提供 onRetry 时不应显示重试按钮', () => {
    const manager = createManager();
    manager.showToast('消息', 'info');
    expect(getLastToast().querySelector('.toast-retry')).toBeNull();
  });

  it('click 重试按钮应触发 onRetry + 移除 toast', () => {
    const manager = createManager();
    const onRetry = vi.fn();
    manager.showToast('失败', 'error', undefined, { onRetry });
    const retryBtn = getLastToast().querySelector('.toast-retry') as HTMLButtonElement;
    retryBtn.click();
    expect(onRetry).toHaveBeenCalledTimes(1);
    // toast 应触发淡出
    expect(getLastToast().classList.contains('leaving')).toBe(true);
    // 触发 animationend 完成移除
    dispatchAnimationEnd(getLastToast());
    expect(document.querySelectorAll('.toast').length).toBe(0);
  });
});

// ─── showToast · 自定义操作按钮 ─────────────────────────

describe('showToast · 自定义操作按钮', () => {
  it('提供 onAction + actionLabel 时应显示操作按钮', () => {
    const manager = createManager();
    manager.showToast('提示', 'info', undefined, {
      onAction: vi.fn(),
      actionLabel: '分析',
    });
    const actionBtn = getLastToast().querySelector('.toast-retry') as HTMLButtonElement;
    expect(actionBtn).not.toBeNull();
    expect(actionBtn.textContent).toBe('分析');
    expect(actionBtn.title).toBe('分析');
  });

  it('click 操作按钮应触发 onAction + 移除 toast', () => {
    const manager = createManager();
    const onAction = vi.fn();
    manager.showToast('提示', 'info', undefined, {
      onAction,
      actionLabel: '分析',
    });
    const actionBtn = getLastToast().querySelector('.toast-retry') as HTMLButtonElement;
    actionBtn.click();
    expect(onAction).toHaveBeenCalledTimes(1);
    dispatchAnimationEnd(getLastToast());
    expect(document.querySelectorAll('.toast').length).toBe(0);
  });

  it('仅提供 onAction 无 actionLabel 时不应显示按钮', () => {
    const manager = createManager();
    manager.showToast('提示', 'info', undefined, {
      onAction: vi.fn(),
      // 缺失 actionLabel
    });
    expect(getLastToast().querySelector('.toast-retry')).toBeNull();
  });
});

// ─── showToast · 关闭按钮 ────────────────────────────────

describe('showToast · 关闭按钮', () => {
  it('应显示关闭按钮（SVG 图标）', () => {
    const manager = createManager();
    manager.showToast('消息', 'info');
    const closeBtn = getLastToast().querySelector('.toast-close') as HTMLButtonElement;
    expect(closeBtn).not.toBeNull();
    // 关闭按钮已从 emoji ✕ 改为 SVG 图标（UX-FD-03）
    expect(closeBtn.innerHTML).toContain('icon-close');
    expect(closeBtn.title).toBe('关闭');
  });

  it('click 关闭按钮应移除 toast（淡出动画）', () => {
    const manager = createManager();
    manager.showToast('消息', 'info');
    const closeBtn = getLastToast().querySelector('.toast-close') as HTMLButtonElement;
    closeBtn.click();
    expect(getLastToast().classList.contains('leaving')).toBe(true);
    dispatchAnimationEnd(getLastToast());
    expect(document.querySelectorAll('.toast').length).toBe(0);
  });
});

// ─── showToast · 自动消失 ────────────────────────────────

describe('showToast · 自动消失', () => {
  it('info 类型应在 4000ms 后自动消失', () => {
    const manager = createManager();
    manager.showToast('消息', 'info');
    expect(document.querySelectorAll('.toast').length).toBe(1);
    // 推进 3999ms，不应消失
    vi.advanceTimersByTime(3999);
    expect(document.querySelectorAll('.toast').length).toBe(1);
    // 推进到 4000ms，应触发淡出
    vi.advanceTimersByTime(1);
    expect(getLastToast().classList.contains('leaving')).toBe(true);
    // 触发 animationend 完成移除
    dispatchAnimationEnd(getLastToast());
    expect(document.querySelectorAll('.toast').length).toBe(0);
  });

  it('error 类型不应自动消失', () => {
    const manager = createManager();
    manager.showToast('错误', 'error');
    // 推进很长时间，不应消失
    vi.advanceTimersByTime(10000);
    expect(document.querySelectorAll('.toast').length).toBe(1);
    expect(getLastToast().classList.contains('leaving')).toBe(false);
  });

  it('有重试按钮时不应自动消失', () => {
    const manager = createManager();
    manager.showToast('失败', 'error', undefined, { onRetry: vi.fn() });
    vi.advanceTimersByTime(10000);
    expect(document.querySelectorAll('.toast').length).toBe(1);
    expect(getLastToast().classList.contains('leaving')).toBe(false);
  });

  it('有操作按钮时不应自动消失', () => {
    const manager = createManager();
    manager.showToast('提示', 'info', undefined, {
      onAction: vi.fn(),
      actionLabel: '分析',
    });
    vi.advanceTimersByTime(10000);
    expect(document.querySelectorAll('.toast').length).toBe(1);
  });

  it('自定义 duration=0 应不自动消失', () => {
    const manager = createManager();
    manager.showToast('消息', 'info', 0);
    vi.advanceTimersByTime(10000);
    expect(document.querySelectorAll('.toast').length).toBe(1);
  });

  it('自定义 duration 应覆盖默认时长', () => {
    const manager = createManager();
    manager.showToast('消息', 'info', 2000);
    vi.advanceTimersByTime(1999);
    expect(document.querySelectorAll('.toast').length).toBe(1);
    vi.advanceTimersByTime(1);
    expect(getLastToast().classList.contains('leaving')).toBe(true);
  });
});

// ─── cleanup ─────────────────────────────────────────────

describe('cleanup', () => {
  it('cleanup 应清理所有自动消失定时器', () => {
    const manager = createManager();
    manager.showToast('消息1', 'info');
    manager.showToast('消息2', 'info');
    manager.showToast('消息3', 'info');
    // cleanup 后推进时间，toast 不应被定时器移除
    manager.cleanup();
    vi.advanceTimersByTime(10000);
    // toast 仍存在（定时器已被清理）
    expect(document.querySelectorAll('.toast').length).toBe(3);
  });

  it('cleanup 后再 showToast 应正常工作', () => {
    const manager = createManager();
    manager.cleanup();
    manager.showToast('新消息', 'info');
    expect(document.querySelectorAll('.toast').length).toBe(1);
  });

  it('cleanup 无定时器时不应抛错', () => {
    const manager = createManager();
    expect(() => manager.cleanup()).not.toThrow();
  });
});
