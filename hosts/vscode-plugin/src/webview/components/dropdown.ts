/**
 * 下拉菜单组件 — Trae 风格紧凑下拉，可复用、不绑定具体面板
 *
 * 设计（组件化，源码模块化，兼容 webview 内联字符串约束）：
 *   - 组件只负责「展开/收起」与「将点击项 id 转发给面板」的通用机制；
 *   - 面板通过全局回调接收命中项 id，自行处理业务：
 *       . 实例默认走 window.__treeddOnSelect(id)；
 *       . 也可在 buildDropdownHtml 传 onSelect 指定回调名（如模型选择器走 __modelPickerOnSelect）；
 *   - 选项点击采用「事件委托」（closest 命中 .treedd__item），
 *     支持动态渲染的选项（模型列表等），杜绝 forEach 静态绑定漏绑问题；
 *   - 初始化遍历所有 .treedd 实例，而非只取第一个；
 *   - 样式见 styles/dropdown.ts；本组件导出 HTML 模板 + 注入脚本两部分。
 */
import { dropdownStyles } from '../styles/dropdown.js';

export interface DropdownItem {
  /** 事件标识：面板在回调中据此分发 */
  id: string;
  /** 显示文本 */
  label: string;
  /** 危险操作（红色高亮，如清空对话） */
  danger?: boolean;
}

/** 生成下拉组件 HTML（默认触发器「⋯」；onSelect 指定该项点击后调用的全局回调名） */
export function buildDropdownHtml(items: DropdownItem[], opts?: { extraClass?: string; onSelect?: string }): string {
  const extra = opts?.extraClass ? ` ${opts.extraClass}` : '';
  // 实例级回调：data-on-select 指向全局回调名；缺省回退 __treeddOnSelect
  const onSelectAttr = opts?.onSelect ? ` data-on-select="${opts.onSelect}"` : '';
  const itemHtml = items
    .map(
      (it) =>
        `<button class="treedd__item${it.danger ? ' is-danger' : ''}" data-treedd-id="${it.id}" role="menuitem">${it.label}</button>`,
    )
    .join('');
  return `
    <div class="treedd${extra}" data-treedd${onSelectAttr}>
      <button class="treedd__trigger" title="更多操作" aria-label="更多操作" aria-haspopup="menu">⋯</button>
      <div class="treedd__menu" role="menu">${itemHtml}</div>
    </div>`;
}

/** 下拉初始化：绑定展开/收起 + 事件委托转发选择项。
 *  阶段 B（对抗评估 P2-1）：显式函数替代原「window.__xxx 全局回调名」模式——
 *  chatView 直接调用并传入回调映射，消除全局污染。data-on-select 属性值作为回调
 *  键名（缺省 __treeddOnSelect），与 buildDropdownHtml 生成的 HTML 契约一致。
 *  DOM 副作用仅在调用时执行（extension 端 import 安全）。
 *  @param root webview 文档对象（document）
 *  @param callbacks 回调映射：键为 data-on-select 属性值，值为选择项处理器 */
export function initDropdowns(
  root: Document,
  callbacks: Record<string, (id: string) => void>,
): void {
  // 遍历 root 下所有 .treedd 实例（而非只取第一个，避免多实例漏绑）
  root.querySelectorAll('.treedd').forEach((el) => {
    const trigger = el.querySelector('.treedd__trigger');
    const menu = el.querySelector('.treedd__menu');
    if (!trigger || !menu) return;
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      el.classList.toggle('is-open');
    });
    // 选择项用「事件委托」：菜单项可能动态渲染（模型列表），closest 命中即可转发
    menu.addEventListener('click', (e) => {
      e.stopPropagation();
      const target = e.target as HTMLElement | null;
      const item = target?.closest ? target.closest('.treedd__item') : null;
      if (!item) return;
      el.classList.remove('is-open');
      const cbName = el.getAttribute('data-on-select') || '__treeddOnSelect';
      const cb = callbacks[cbName];
      if (cb) cb(String(item.getAttribute('data-treedd-id')));
    });
  });
  // 点击任意位置关闭所有展开的下拉
  root.addEventListener('click', () => {
    root.querySelectorAll('.treedd.is-open').forEach((el) => el.classList.remove('is-open'));
  });
}

/** [双轨] 注入页面的脚本：通用展开/收起 + 事件委托转发（chatPanel 接线完成后删除） */
export const dropdownInitScript = `
(function () {
  // 通用下拉初始化：遍历页面上所有 .treedd 实例（而非只取第一个，避免多实例漏绑）。
  // 选择项用「事件委托」：菜单项可能动态渲染（模型列表），closest 命中即可转发。
  var roots = document.querySelectorAll('.treedd');
  roots.forEach(function (root) {
    var trigger = root.querySelector('.treedd__trigger');
    var menu = root.querySelector('.treedd__menu');
    if (!trigger || !menu) return;
    trigger.addEventListener('click', function (e) {
      e.stopPropagation();
      root.classList.toggle('is-open');
    });
    menu.addEventListener('click', function (e) {
      e.stopPropagation();
      var el = e.target && e.target.closest ? e.target.closest('.treedd__item') : null;
      if (!el) return;
      root.classList.remove('is-open');
      var cbName = root.getAttribute('data-on-select') || '__treeddOnSelect';
      var cb = window[cbName];
      if (cb) cb(el.getAttribute('data-treedd-id'));
    });
  });
  // 点击任意位置关闭所有展开的下拉
  document.addEventListener('click', function () {
    document.querySelectorAll('.treedd.is-open').forEach(function (el) { el.classList.remove('is-open'); });
  });
})();`;

export { dropdownStyles };