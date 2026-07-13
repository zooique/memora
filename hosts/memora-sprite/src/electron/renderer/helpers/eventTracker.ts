/**
 * 事件监听器跟踪器 — 统一管理事件监听器的注册与清理
 *
 * 职责：
 * - 提供 addEventListener 方法，自动记录清理函数
 * - 提供 cleanup 方法，统一清理所有已注册的监听器
 *
 * 设计原则：
 * - 组合优于继承：各管理类通过组合持有 EventTracker 实例，避免继承层次
 * - 防止内存泄漏：所有事件监听器纳入跟踪集合，cleanup 时统一清理
 * - 单一职责：仅负责事件监听器的跟踪与清理，不涉及业务逻辑
 *
 * 使用示例：
 * ```ts
 * class MyManager {
 *   private events = new EventTracker();
 *
 *   init() {
 *     this.events.addEventListener(btn, 'click', this.onClick);
 *   }
 *
 *   cleanup() {
 *     this.events.cleanup();
 *   }
 * }
 * ```
 */

/**
 * 事件监听器跟踪器
 *
 * 跟踪所有通过 addEventListener 注册的事件监听器，
 * 在 cleanup 时统一移除，避免内存泄漏。
 */
export class EventTracker {
  /** 已注册的清理函数集合（每个函数移除一个事件监听器） */
  private cleanupFunctions: Array<() => void> = [];

  /**
   * 添加事件监听器并自动记录清理函数
   *
   * @param element 事件目标元素（HTMLElement 或 Document 等 DOM 元素）
   * @param event 事件名称（如 'click'、'keydown'）
   * @param handler 事件处理函数
   * @param options 事件监听选项（如 { passive: true } 用于 scroll 事件性能优化）
   */
  addEventListener(element: EventTarget, event: string, handler: EventListener, options?: boolean | AddEventListenerOptions): void {
    element.addEventListener(event, handler, options);
    // 记录清理函数，cleanup 时移除监听器
    this.cleanupFunctions.push(() => {
      element.removeEventListener(event, handler, options);
    });
  }

  /**
   * 清理所有已注册的事件监听器
   *
   * 按注册顺序执行清理（与原有 eventCleanupFunctions.forEach 行为一致），
   * 清理完成后清空集合，避免重复清理。
   */
  cleanup(): void {
    // 正序执行清理，保持与原有 eventCleanupFunctions.forEach 行为一致
    this.cleanupFunctions.forEach((cleanup) => cleanup());
    this.cleanupFunctions = [];
  }
}
