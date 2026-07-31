/**
 * 回到底部浮动按钮（从 chatPanelManager.ts 提取）
 *
 * 职责：
 * - 监听消息区滚动，当用户向上滚动超过一屏时显示回到底部浮动按钮
 * - 点击按钮平滑滚动回消息区底部
 *
 * 设计原则：
 * - 纯 DOM + 事件绑定，rAF 节流避免高频 scroll 事件触发强制 reflow
 * - 复用调用方注入的 EventTracker 统一管理监听生命周期
 * - 对齐 toolCallCard.ts / messageDecorations.ts helper 模式
 */

import type { EventTracker } from './eventTracker.js';

/**
 * 初始化回到底部浮动按钮
 *
 * @param messagesEl 消息容器元素（滚动监听源 + 平滑滚动目标）
 * @param events 事件跟踪器（复用调用方实例，统一管理监听生命周期）
 */
export function initScrollToBottomButton(messagesEl: HTMLElement, events: EventTracker): void {
  const btn = document.getElementById('scroll-to-bottom-btn');
  if (!btn) return;

  // 滚动监听：距离底部超过一屏时显示按钮
  // CHAT-A05 优化：rAF 节流避免高频 scroll 事件触发强制 reflow
  let scrollRafPending = false;
  events.addEventListener(messagesEl, 'scroll', () => {
    if (scrollRafPending) return;
    scrollRafPending = true;
    requestAnimationFrame(() => {
      scrollRafPending = false;
      const distanceFromBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
      const shouldShow = distanceFromBottom > messagesEl.clientHeight;
      btn.classList.toggle('hidden', !shouldShow);
    });
  }, { passive: true });

  // 点击回到底部
  events.addEventListener(btn, 'click', () => {
    messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: 'smooth' });
  });
}
