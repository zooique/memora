/**
 * 下拉菜单组件 — Trae 风格紧凑下拉，可复用、不绑定具体面板
 *
 * 设计（组件化，源码模块化，兼容 webview 内联字符串约束）：
 *   - 组件只负责「展开/收起」与「将点击项 id 转发给面板」的通用机制；
 *   - 面板通过全局回调 window.__treeddOnSelect(id) 接收命中项 id，自行处理业务；
 *   - 样式见 styles/dropdown.ts；本组件导出 HTML 模板 + 注入脚本两部分。
 */
import { dropdownStyles } from '../styles/dropdown.js';

export interface DropdownItem {
  /** 事件标识：面板在 __treeddOnSelect 中据此分发 */
  id: string;
  /** 显示文本 */
  label: string;
  /** 危险操作（红色高亮，如清空对话） */
  danger?: boolean;
}

/** 生成下拉组件 HTML（默认触发器「⋯」） */
export function buildDropdownHtml(items: DropdownItem[], opts?: { extraClass?: string }): string {
  const extra = opts?.extraClass ? ` ${opts.extraClass}` : '';
  const itemHtml = items
    .map(
      (it) =>
        `<button class="treedd__item${it.danger ? ' is-danger' : ''}" data-treedd-id="${it.id}" role="menuitem">${it.label}</button>`,
    )
    .join('');
  return `
    <div class="treedd${extra}" data-treedd>
      <button class="treedd__trigger" title="更多操作" aria-haspopup="menu">⋯</button>
      <div class="treedd__menu" role="menu">${itemHtml}</div>
    </div>`;
}

/** 注入页面的脚本：通用展开/收起 + 点击项转发（面板定义 window.__treeddOnSelect） */
export const dropdownInitScript = `
(function () {
  var root = document.querySelector('.treedd');
  if (!root) return;
  var trigger = root.querySelector('.treedd__trigger');
  var onSelect = window.__treeddOnSelect;
  trigger.addEventListener('click', function (e) {
    e.stopPropagation();
    root.classList.toggle('is-open');
  });
  document.addEventListener('click', function () {
    root.classList.remove('is-open');
  });
  root.addEventListener('click', function (e) {
    e.stopPropagation();
  });
  root.querySelectorAll('.treedd__item').forEach(function (el) {
    el.addEventListener('click', function () {
      root.classList.remove('is-open');
      if (onSelect) onSelect(el.getAttribute('data-treedd-id'));
    });
  });
})();`;

export { dropdownStyles };