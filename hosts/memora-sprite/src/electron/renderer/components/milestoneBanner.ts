/**
 * 里程碑 banner 组件 — 独立展示逻辑（从 chatPanelManager.ts 提取）
 *
 * 职责：
 * - 在对话流内联渲染里程碑 banner（奖杯图标 + 文本 + 关闭按钮）
 * - 关闭按钮通过 data-action="close-milestone" 走 messagesEl 事件委托，本模块不绑定监听
 *
 * 设计原则：
 * - 纯函数 + 一次性 DOM 构建，无实例状态
 * - 与聊天消息渲染解耦，ChatPanelManager.appendMilestoneBanner 委托本函数构建并 append
 * - 零行为变更，纯结构重构（对齐 startupSummaryBanner.ts 模式）
 */

/**
 * 构建对话区内联里程碑 banner 元素
 *
 * DOM 结构：
 *   <div class="milestone-banner text-truncate" role="status" aria-live="polite">
 *     <svg class="milestone-icon" ...><use href="#icon-trophy"/></svg>
 *     <span class="milestone-text"></span>
 *     <button class="milestone-close" data-action="close-milestone" ...>
 *       <svg class="icon" ...><use href="#icon-close"/></svg>
 *     </button>
 *   </div>
 *
 * 文本通过 textContent 设置（避免 XSS），SVG 图标复用 sprite symbol。
 * 构建后未挂载，由调用方（ChatPanelManager）自行 appendChild 到消息区。
 *
 * @param text 里程碑文本（如"达成里程碑：首次完成 UI 布局重构方案"）
 * @returns 已构建但未挂载的 banner 元素
 */
export function createMilestoneBanner(text: string): HTMLElement {
  const banner = document.createElement('div');
  banner.className = 'milestone-banner text-truncate';
  banner.setAttribute('role', 'status');
  banner.setAttribute('aria-live', 'polite');

  // 奖杯图标（复用 #icon-trophy symbol，与顶部 banner 一致）+ 文本占位 + 关闭按钮
  banner.innerHTML = `
    <svg class="milestone-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><use href="#icon-trophy"/></svg>
    <span class="milestone-text"></span>
    <button class="milestone-close" data-action="close-milestone" type="button" aria-label="关闭里程碑提示">
      <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><use href="#icon-close"/></svg>
    </button>
  `;
  // 使用 textContent 设置文本，避免 XSS
  const textEl = banner.querySelector<HTMLElement>('.milestone-text');
  if (textEl) textEl.textContent = text;

  return banner;
}
