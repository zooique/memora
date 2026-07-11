/**
 * 错误状态渲染模块 — 面板加载失败时的统一错误态 UI
 *
 * 职责：
 * - 提供统一的错误态 DOM 结构（图标 + 文字 + 重试按钮）
 * - 通过 EventTracker 绑定重试按钮事件，纳入统一生命周期管理
 *
 * 设计原则：
 * - 提取时机：3 处面板（profilePanel / auditPanel / workProjectionPanel）出现相同
 *   error-state 结构创建模式，遵循"3 次才提取"的自然生长原则
 * - 与 formValidation.ts 同模式：专用工具函数，职责单一
 * - 不依赖业务逻辑，仅负责 DOM 创建 + 事件绑定
 *
 * 集成点：
 * - profilePanelManager.ts：load() catch 块
 * - auditPanelManager.ts：renderError() 方法
 * - workProjectionPanelManager.ts：load() catch 块
 */

import type { EventTracker } from './eventTracker.js';
// clearElement 替代 innerHTML=''，遵循统一 DOM 操作模式
import { clearElement } from './domHelpers.js';

/**
 * 渲染错误状态到指定容器
 *
 * 清空容器后创建统一的 .error-state 结构：
 *   div.error-state
 *   ├── div.error-icon（⚠ 警告符号）
 *   ├── div.error-message（错误文案）
 *   └── button.btn-secondary.error-retry-btn（重试按钮）
 *
 * 重试按钮通过 EventTracker 绑定 click 事件，cleanup 时统一清理。
 *
 * @param container 目标容器（会先清空再追加错误态）
 * @param message 错误消息文案
 * @param onRetry 重试回调（点击重试按钮触发，通常为重新加载）
 * @param events EventTracker（统一管理事件监听器生命周期）
 * @returns 错误态根元素（.error-state）
 */
export function renderErrorState(
  container: HTMLElement,
  message: string,
  onRetry: () => void,
  events: EventTracker,
): HTMLElement {
  // 清空容器（替代 innerHTML=''，遵循统一 DOM 操作模式）
  clearElement(container);

  // 错误态根元素
  const errorEl = document.createElement('div');
  errorEl.className = 'error-state';

  // 警告图标（Unicode 符号，跨平台一致）
  const icon = document.createElement('div');
  icon.className = 'error-icon';
  icon.textContent = '⚠';
  errorEl.appendChild(icon);

  // 错误消息文案
  const msg = document.createElement('div');
  msg.className = 'error-message';
  msg.textContent = message;
  errorEl.appendChild(msg);

  // 重试按钮：内嵌在错误态内，便于用户发现恢复入口
  const retryBtn = document.createElement('button');
  retryBtn.className = 'btn-secondary error-retry-btn';
  retryBtn.textContent = '重试';
  // 通过 EventTracker 绑定事件，cleanup 时统一清理（避免内存泄漏）
  events.addEventListener(retryBtn, 'click', onRetry);
  errorEl.appendChild(retryBtn);

  container.appendChild(errorEl);
  return errorEl;
}
