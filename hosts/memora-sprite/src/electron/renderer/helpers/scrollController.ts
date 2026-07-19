/**
 * 滚动控制器 — 消息列表滚动控制 + rAF 节流
 *
 * 职责：
 * - 智能滚动到底部（仅当用户在底部附近时才滚动）
 * - 强制滚动到底部（用户主动操作时调用）
 * - 监听 scroll 事件更新 isNearBottom 状态（rAF 节流避免高频 reflow）
 *
 * 设计原则：
 * - 自包含 EventTracker，initListener() 绑定事件，dispose() 统一清理
 * - isNearBottom 状态内部持有，UIManager 无需直接访问
 * - 与 UIManager 的其他子管理器同模式
 */

import { EventTracker } from './eventTracker.js';

/** 判断"底部附近"的阈值（像素） */
const SCROLL_BOTTOM_THRESHOLD = 100;

/**
 * 滚动控制器
 *
 * 生命周期：initListener() 绑定 scroll 事件 → dispose() 清理 rAF + 事件
 */
export class ScrollController {
  /** 事件监听器跟踪器 */
  private events = new EventTracker();
  /** 用户是否在底部附近（用于智能滚动：用户向上滚动时不强制滚到底部） */
  private isNearBottom = true;
  /** rAF 请求 ID（节流 scroll 事件，dispose 时取消） */
  private rafId: number | null = null;

  /**
   * @param messagesEl 消息列表容器元素
   */
  constructor(private messagesEl: HTMLElement) {}

  /** 智能滚动到底部（仅当用户在底部附近时才滚动，避免打断历史查看） */
  scrollToBottom(): void {
    if (!this.isNearBottom) return;
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  /** 强制滚动到底部（用户主动操作时调用，如点击发送按钮、切换会话后） */
  forceScrollToBottom(): void {
    this.isNearBottom = true;
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  /**
   * 监听消息区滚动，更新 isNearBottom 状态
   *
   * rAF 节流避免高频 scroll 事件触发强制 reflow
   */
  initListener(): void {
    let scrollRafPending = false;
    this.events.addEventListener(this.messagesEl, 'scroll', () => {
      if (scrollRafPending) return;
      scrollRafPending = true;
      this.rafId = requestAnimationFrame(() => {
        scrollRafPending = false;
        this.rafId = null;
        const { scrollTop, scrollHeight, clientHeight } = this.messagesEl;
        this.isNearBottom = scrollHeight - scrollTop - clientHeight < SCROLL_BOTTOM_THRESHOLD;
      });
    }, { passive: true });
  }

  /** 清理 rAF 请求 + 事件监听器 */
  dispose(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.events.cleanup();
  }
}
