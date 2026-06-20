/**
 * Toast 通知模块
 *
 * 职责：
 * - 显示操作反馈通知（保存成功/失败/警告等）
 * - 独立于对话历史，避免污染上下文
 * - 管理 Toast 自动消失定时器，cleanup 时统一清理
 *
 * 设计原则（IX-06）：
 * - error 类型不自动消失，需用户手动关闭，确保错误被看到
 * - 同时最多显示 5 条，超出时移除最早的，避免堆积
 * - 定时器纳入跟踪集合，cleanup 时统一清理，避免回调在 DOM 销毁后触发
 */

import type { ToastType } from './types.js';

/** Toast 类型与图标映射 */
const TOAST_ICONS: Record<ToastType, string> = {
  success: '✓',
  error: '✗',
  warning: '⚠',
  info: 'ℹ',
};

/** Toast 默认自动消失时长（毫秒），error 类型不自动消失 */
const TOAST_DEFAULT_DURATION = 4000;

/** Toast 最大同时显示数量（FIFO，超出时移除最早的） */
const TOAST_MAX_VISIBLE = 5;

/**
 * Toast 通知管理器
 *
 * 独立管理 Toast 容器和定时器，UIManager 通过组合持有。
 * cleanup 时清理所有定时器，避免回调在 DOM 销毁后触发。
 */
export class ToastManager {
  /** Toast 自动消失定时器集合（cleanup 时需清理，避免回调在 DOM 销毁后触发） */
  private toastTimers: Set<ReturnType<typeof setTimeout>> = new Set();

  /**
   * 显示 Toast 通知
   *
   * @param message 通知文本
   * @param type 通知类型（默认 info）
   * @param duration 自动消失时长（毫秒），0 表示不自动消失；默认按类型决定
   */
  showToast(message: string, type: ToastType = 'info', duration?: number): void {
    const container = document.getElementById('toast-container');
    if (!container) return;

    // 限制最多显示数量，移除最早的（FIFO）
    while (container.children.length >= TOAST_MAX_VISIBLE) {
      container.firstChild?.remove();
    }

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');

    // 图标
    const icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.textContent = TOAST_ICONS[type];
    toast.appendChild(icon);

    // 内容
    const content = document.createElement('div');
    content.className = 'toast-content';
    content.textContent = message;
    toast.appendChild(content);

    // 关闭按钮
    const closeBtn = document.createElement('button');
    closeBtn.className = 'toast-close';
    closeBtn.textContent = '✕';
    closeBtn.title = '关闭';
    closeBtn.addEventListener('click', () => this.removeToast(toast));
    toast.appendChild(closeBtn);

    container.appendChild(toast);

    // 自动消失（error 默认不消失，需用户手动关闭）
    const autoDuration = duration ?? (type === 'error' ? 0 : TOAST_DEFAULT_DURATION);
    if (autoDuration > 0) {
      // 纳入 toastTimers 跟踪，cleanup 时统一清理，避免回调在 DOM 销毁后触发
      const timer = setTimeout(() => {
        this.toastTimers.delete(timer);
        this.removeToast(toast);
      }, autoDuration);
      this.toastTimers.add(timer);
    }
  }

  /** 移除 Toast（带离场动画） */
  private removeToast(toast: HTMLElement): void {
    if (!toast.parentElement) return;
    toast.classList.add('leaving');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
  }

  /** 清理所有 Toast 定时器（UIManager.cleanup 时调用） */
  cleanup(): void {
    for (const timer of this.toastTimers) {
      clearTimeout(timer);
    }
    this.toastTimers.clear();
  }
}
