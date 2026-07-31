/**
 * 加载更多 / 加载更早 控件（从 chatPanelManager.ts 提取）
 *
 * 职责：
 * - 构建"加载更多消息"容器（含剩余数量文案，data-action="load-more"）
 * - 构建"加载更早的对话"容器（data-action="load-earlier-day"）
 * - 移除 #load-more-container（两个控件共用同一容器，互斥显示）
 *
 * 设计原则：
 * - 纯函数 + 一次性 DOM 构建，无实例状态
 * - 点击回调经 ChatPanelManager 事件委托（data-action）分发，本模块只构建 DOM
 * - 对齐 toolCallCard.ts / messageDecorations.ts helper 模式
 */

/**
 * 构建"加载更多消息"容器
 *
 * @param remaining 剩余消息数（显示在按钮文案中）
 * @returns 已构建但未挂载的 #load-more-container 元素
 */
export function createLoadMoreContainer(remaining: number): HTMLElement {
  const container = document.createElement('div');
  container.id = 'load-more-container';
  container.className = 'load-more-container';

  const btn = document.createElement('button');
  btn.className = 'load-more-btn';
  btn.textContent = `加载更多消息（剩余 ${remaining} 条）`;
  // 使用 data-action 属性替代直接 addEventListener，由事件委托统一处理
  btn.dataset.action = 'load-more';
  container.appendChild(btn);

  return container;
}

/**
 * 构建"加载更早的对话"容器
 *
 * 与 createLoadMoreContainer 共用 #load-more-container（互斥显示），通过 data-action 区分回调。
 *
 * @returns 已构建但未挂载的 #load-more-container 元素
 */
export function createLoadEarlierDayContainer(): HTMLElement {
  const container = document.createElement('div');
  container.id = 'load-more-container';
  container.className = 'load-more-container';

  const btn = document.createElement('button');
  btn.className = 'load-more-btn';
  btn.textContent = '加载更早的对话';
  // 使用 data-action 区分回调（与 load-more 区分）
  btn.dataset.action = 'load-earlier-day';
  container.appendChild(btn);

  return container;
}

/**
 * 移除消息区的 #load-more-container
 *
 * 加载更多 / 加载更早控件共用同一容器（互斥），移除即同时清除两者。
 *
 * @param messagesEl 消息容器元素
 */
export function removeLoadMoreControl(messagesEl: HTMLElement): void {
  messagesEl.querySelector('#load-more-container')?.remove();
}
