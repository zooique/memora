/**
 * SVG sprite 图标 helper
 *
 * 基于 index.html 中的 `<symbol id="icon-xxx">` sprite 定义，
 * 通过 `<use href="#icon-xxx"/>` 引用，统一 innerHTML 图标注入模式。
 *
 * 设计目的：
 * - 替代散落在各 Manager 的 `el.innerHTML = '<svg class="icon"><use href="#icon-xxx"/></svg>'` 模板拼接
 * - 统一图标注入入口，便于未来切换图标方案（如 webfont 或独立 SVG component）时单点修改
 * - 配合 setIconWithLabel 消除"图标 + 文本 span"组合的 XSS 面（label 用 textContent 赋值）
 */

/** 图标尺寸修饰类（附加到 .icon 基类，对应 CSS 的 .icon-sm / .icon-xs） */
export type IconSizeClass = 'icon-sm' | 'icon-xs';

/**
 * 为元素设置 SVG sprite 图标
 *
 * 替代 `el.innerHTML = '<svg class="icon"><use href="#icon-xxx"/></svg>'` 模板拼接。
 * 仅注入 sprite 引用（不含 SVG path），保持与现有图标系统一致。
 *
 * @param el 目标元素（通常是 button/span/div）
 * @param iconId 图标 symbol id，如 'icon-send'（不含 # 前缀，函数内部自动拼接）
 * @param sizeClass 可选尺寸修饰类，'icon-sm' | 'icon-xs'（默认无，仅 .icon 基类）
 *
 * @example
 * setIcon(btnSend, 'icon-send');
 * setIcon(btnToggleVisibility, 'icon-eye', 'icon-sm');
 */
export function setIcon(el: HTMLElement, iconId: string, sizeClass?: IconSizeClass): void {
  // 拼接 class 列表：基础 .icon + 可选尺寸修饰类
  const cls = sizeClass ? `icon ${sizeClass}` : 'icon';
  el.innerHTML = `<svg class="${cls}"><use href="#${iconId}"/></svg>`;
}

/**
 * 为元素设置 SVG sprite 图标 + 文本标签（span 包裹）
 *
 * 替代 `el.innerHTML = '<svg.../><span>${label}</span>'` 模板拼接。
 * label 使用 textContent 赋值（防 XSS），图标部分复用 setIcon。
 *
 * @param el 目标元素
 * @param iconId 图标 symbol id（不含 # 前缀）
 * @param label 标签文本（将放入 <span> 中，自动转义 HTML 特殊字符）
 *
 * @example
 * setIconWithLabel(indicator, 'icon-gear', '正在思考…');
 */
export function setIconWithLabel(el: HTMLElement, iconId: string, label: string): void {
  // 先设置图标（会清空 el 子节点）
  setIcon(el, iconId);
  // 追加 label span（textContent 防 XSS）
  const span = document.createElement('span');
  span.textContent = label;
  el.appendChild(span);
}
