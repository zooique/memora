/**
 * 轻量 DOM 创建辅助函数
 *
 * 减少 `document.createElement` + 逐行设置属性的样板代码。
 * 不引入虚拟 DOM，不改变现有架构模式。
 *
 * 设计原则：
 * - 零依赖，纯函数
 * - 属性名用 DOM API 标准命名（class → className，for → htmlFor）
 * - 不支持嵌套 children（保持简单，复杂结构用现有 createElement 模式）
 */

export interface CreateElOptions {
  /** CSS 类名（映射到 className） */
  class?: string;
  /** 文本内容（XSS 安全：通过 textContent 设置，不经过 innerHTML） */
  text?: string;
  /** HTML 内容（谨慎使用：仅在内容可信时使用，否则用 text） */
  html?: string;
  /** 自定义属性映射（如 { 'data-id': 'x', 'aria-label': 'y' }） */
  attrs?: Record<string, string>;
}

/**
 * 创建单个 DOM 元素
 *
 * @param tag HTML 标签名
 * @param options 可选的类名、文本、属性配置
 * @returns 创建的 DOM 元素
 *
 * @example
 * // 简单用法
 * createEl('div', { class: 'toast', text: '操作成功' });
 *
 * @example
 * // 带属性
 * createEl('button', { class: 'btn-primary btn-sm', text: '保存', attrs: { 'data-action': 'save', 'aria-label': '保存配置' } });
 */
export function createEl<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options?: CreateElOptions,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);

  if (options?.class) {
    el.className = options.class;
  }
  if (options?.text) {
    el.textContent = options.text;
  }
  if (options?.html) {
    el.innerHTML = options.html;
  }
  if (options?.attrs) {
    for (const [key, value] of Object.entries(options.attrs)) {
      el.setAttribute(key, value);
    }
  }

  return el;
}
