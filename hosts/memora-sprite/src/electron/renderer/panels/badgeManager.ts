/**
 * 未读徽章管理器 — 未读消息计数 + 徽章 DOM 更新
 *
 * 职责：
 * - 根据未读计数更新徽章文本（超过 99 显示 "99+"）
 * - 控制徽章可见性（count > 0 显示，否则隐藏）
 *
 * 设计原则：
 * - 纯 DOM 渲染，不持有业务状态（unreadCount 由 UIManager 管理）
 * - 接受 badge 元素引用，部分布局未提供该元素时静默降级
 * - 与 UIManager 的其他子管理器同模式
 */

/**
 * 未读徽章管理器
 *
 * 生命周期：构造时绑定 badge 元素 → updateBadge/clear/setCount 操作 DOM
 */
export class BadgeManager {
  /**
   * @param badge 未读计数徽章元素（部分布局可能未提供，null 时静默降级）
   */
  constructor(private badge: HTMLElement | null) {}

  /**
   * 更新未读徽章显示
   *
   * count > 0 时显示徽章并设置文本（超过 99 显示 "99+"），
   * count <= 0 时隐藏徽章。
   *
   * @param count 当前未读计数
   */
  updateBadge(count: number): void {
    // 若当前布局未提供 badge 元素则静默跳过，避免初始化崩溃
    if (!this.badge) return;

    if (count > 0) {
      this.badge.textContent = count > 99 ? '99+' : String(count);
      this.badge.classList.add('visible');
    } else {
      this.badge.classList.remove('visible');
    }
  }

  /** 清除徽章显示（隐藏） */
  clear(): void {
    this.updateBadge(0);
  }

  /**
   * 设置未读计数并更新徽章
   *
   * @param count 未读计数（负数会被截断为 0）
   */
  setCount(count: number): void {
    this.updateBadge(Math.max(0, count));
  }
}
