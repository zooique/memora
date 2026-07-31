/**
 * 空状态引导（从 chatPanelManager.ts 提取）
 *
 * 职责：
 * - 绑定示例问题按钮点击（将问题填入输入框并触发发送）
 *
 * 设计原则：
 * - 纯 DOM + 事件绑定，复用调用方注入的 EventTracker
 * - 示例问题点击回调经 getter 注入，避免直接依赖 Manager 状态、运行时读取最新值
 * - 对齐 chatPanelEvents.ts 事件委托模式（此处为直接绑定，因元素在 messagesEl 外）
 */

import type { EventTracker } from './eventTracker.js';

/**
 * 初始化空状态引导的事件监听
 *
 * 点击示例问题按钮时，将问题文本填入输入框并触发发送。
 * 对齐 user_rules "主动可见"：示例问题始终可见，引导新用户快速开始对话。
 *
 * @param events 事件跟踪器（复用调用方实例，统一管理监听生命周期）
 * @param getSuggestionCallback 获取示例问题点击回调（运行时读取最新值）
 */
export function initEmptyStateListeners(
  events: EventTracker,
  getSuggestionCallback: () => ((text: string) => void) | null,
): void {
  const emptyState = document.getElementById('chat-empty-state');
  if (!emptyState) return;

  emptyState.querySelectorAll<HTMLElement>('.suggestion-btn').forEach((btn) => {
    const suggestion = btn.dataset.suggestion;
    if (suggestion) {
      events.addEventListener(btn, 'click', () => {
        // 将示例问题填入输入框并触发发送回调
        getSuggestionCallback()?.(suggestion);
      });
    }
  });
}
