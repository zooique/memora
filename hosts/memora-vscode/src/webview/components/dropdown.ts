/**
 * 下拉菜单组件 — Trae 风格紧凑下拉，可复用、不绑定具体面板
 *
 * 设计（组件化，源码模块化，兼容 webview 内联字符串约束）：
 *   - 组件只负责「展开/收起」与「将点击项 id 转发给面板」的通用机制；
 *   - 面板通过 initDropdowns 传入的显式回调映射接收命中项 id（不走 window.xxx
 *     全局函数名模式，避免全局污染）：
 *       . 回调键名 = buildDropdownHtml 的 data-on-select 属性值（缺省 __treeddOnSelect）；
 *       . 键名与 HTML 契约一一对应（如模型选择器走 __modelPickerOnSelect）；
 *   - 选项点击采用「事件委托」（closest 命中 .treedd__item），
 *     支持动态渲染的选项（模型列表等），杜绝 forEach 静态绑定漏绑问题；
 *   - 初始化遍历所有 .treedd 实例，而非只取第一个；
 *   - 样式见 styles/dropdown.ts；本组件导出 HTML 模板 + 初始化绑定两部分。
 *   - 依赖方向：本组件引 `../scripts/icons.js`（纯叶子：常量 +
 *     纯函数，零副作用、零外部 import）供默认触发器取图标，并引 `../styles/dropdown.js`。
 *     注意 scripts/chatView.ts 反向引本组件 → 目录层面构成 **components ⇄ scripts 双向**。
 *     当前因 icons.ts 为零依赖叶子故无真实循环；若本组件日后需要更多 scripts/ 能力，应先
 *     考虑把图标源下沉到 helpers/（scripts/chatView.ts 已正向引 helpers/*，方向更顺）。
 *   - 图标注入的两条路径（勿视为重复实现）：外部经 `triggerLabel` 注入（生产调用点用法）与
 *     内部默认值 `getIconSvg`（自足兜底），二者**同源于 icons.ts**；SSOT 未破，破的是
 *     「注入机制单一路径」。
 */
import { getIconSvg } from '../scripts/icons.js';
import { dropdownStyles } from '../styles/dropdown.js';

export interface DropdownItem {
  /** 事件标识：面板在回调中据此分发 */
  id: string;
  /** 显示文本 */
  label: string;
  /** 危险操作（红色高亮，如清空对话） */
  danger?: boolean;
}

/** 生成下拉组件 HTML（默认触发器 = ellipsis 内联 SVG；onSelect 指定该项点击后调用的全局回调名）
 *  SSOT 优化：触发器文本/title/aria-label 可通过 opts 自定义，避免硬编码「更多操作」
 *  对选择器场景（Skill/Model picker）语义不当。未指定时保持向后兼容默认值。 */
export function buildDropdownHtml(
  items: DropdownItem[],
  opts?: { extraClass?: string; onSelect?: string; triggerLabel?: string; triggerTitle?: string; triggerAriaLabel?: string },
): string {
  const extra = opts?.extraClass ? ` ${opts.extraClass}` : '';
  // 实例级回调：data-on-select 指向全局回调名；缺省回退 __treeddOnSelect
  const onSelectAttr = opts?.onSelect ? ` data-on-select="${opts.onSelect}"` : '';
  // 默认触发器 = ellipsis 内联 SVG（icons.ts 唯一图标语言）。
  // 取「内联」而非 data-icon 占位 span 的理由：本函数是**返回字符串的纯生成器**，调用上下文
  // （初始化模板 / 运行期拼接）由消费者决定，生成器无从约束。内联 SVG 使产物**自足**，消除
  // 「消费上下文是否覆盖 populateIcons」这一隐式契约（**契约收紧**，防调用点踩坑）；data-icon
  // 占位形态在该契约不成立时静默空白（.treedd__trigger 固定 26px、背景透明、无边框
  // → 空内容等同隐形可点区域）（坑）。
  const triggerLabel = opts?.triggerLabel ?? getIconSvg('ellipsis', 14, 14);
  const triggerTitle = opts?.triggerTitle ?? '更多操作';
  const triggerAriaLabel = opts?.triggerAriaLabel ?? '更多操作';
  const itemHtml = items
    .map(
      (it) =>
        `<button class="treedd__item${it.danger ? ' is-danger' : ''}" data-treedd-id="${it.id}" role="menuitem">${it.label}</button>`,
    )
    .join('');
  return `
    <div class="treedd${extra}" data-treedd${onSelectAttr}>
      <button class="treedd__trigger" title="${triggerTitle}" aria-label="${triggerAriaLabel}" aria-haspopup="menu">${triggerLabel}</button>
      <div class="treedd__menu" role="menu">${itemHtml}</div>
    </div>`;
}

/**
 * 统一开合下拉：同步 .is-open 类与触发器 aria-expanded 状态
 *
 * aria-expanded 必须与可视开合状态成对更新：aria-haspopup 是「承诺有菜单」，
 * aria-expanded 是「履约当前展开态」，只声明前者而不维护后者是对读屏的失约。
 *
 * @param el    下拉容器（.treedd）
 * @param open  是否展开
 */
function setDropdownOpen(el: HTMLElement, open: boolean): void {
  el.classList.toggle('is-open', open);
  el.querySelector('.treedd__trigger')?.setAttribute('aria-expanded', String(open));
  if (open) applyDropDirection(el);
}

/**
 * 自动翻转弹出方向：胶囊变体默认向上弹出，但当触发器贴近容器
 * 顶缘（如 toolbar 里的历史选择器）时向上会溢出被裁。以「菜单不溢出视口」为通用
 * 规则，打开时测量可用空间决定方向——而非按容器位置场景化配置方向。
 *
 * 复用 .treedd--drop-down 类让 CSS 向下弹出（默认 .treedd__menu 本就是向下，
 * capsule 向上是特例，故翻转仅需覆盖 capsule 的 bottom 定位）。
 *
 * @param el 下拉容器（.treedd）
 */
function applyDropDirection(el: HTMLElement): void {
  const trigger = el.querySelector<HTMLElement>('.treedd__trigger');
  const menu = el.querySelector<HTMLElement>('.treedd__menu');
  if (!trigger || !menu) return;
  // 菜单已展开（is-open 已加），offsetHeight 反映实际高度；取不到时按最大高兜底
  const menuH = menu.offsetHeight || 260;
  // 触发器顶缘到视口顶部的距离 < 菜单高度 + 间距 → 向上放不下，改为向下弹
  const flipDown = trigger.getBoundingClientRect().top < menuH + 6;
  el.classList.toggle('treedd--drop-down', flipDown);
}

/** 当前展开状态下可聚焦的菜单项列表（事件委托场景下可能动态渲染，实时查询） */
function menuItems(el: HTMLElement): HTMLElement[] {
  const menu = el.querySelector('.treedd__menu');
  return menu ? Array.from(menu.querySelectorAll<HTMLElement>('.treedd__item')) : [];
}

/** 下拉初始化：绑定展开/收起 + 事件委托转发选择项 + 键盘可访问性。
 *  显式函数（不用「window.__xxx 全局回调名」模式）——
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
  root.querySelectorAll('.treedd').forEach((rawEl) => {
    // querySelectorAll 返回 Element，此处收窄为 HTMLElement（需 focus/classList 等宿主能力）
    const el = rawEl as HTMLElement;
    const trigger = el.querySelector<HTMLElement>('.treedd__trigger');
    const menu = el.querySelector<HTMLElement>('.treedd__menu');
    if (!trigger || !menu) return;
    // 初始闭合态：aria-expanded=false（与 CSS 默认 display:none 一致）
    trigger.setAttribute('aria-expanded', 'false');

    // 关闭当前下拉（供 Escape / 失焦 / 点击外部复用）
    const close = (): void => setDropdownOpen(el, false);

    // 触发器：点击展开/收起，展开后聚焦首项（键盘可达）
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      // 先关闭其他已展开的下拉（同一视图内互斥，避免多菜单同时展开）
      root.querySelectorAll('.treedd.is-open').forEach((o) => {
        if (o !== el) setDropdownOpen(o as HTMLElement, false);
      });
      const willOpen = !el.classList.contains('is-open');
      setDropdownOpen(el, willOpen);
      if (willOpen) menuItems(el)[0]?.focus();
    });

    // 触发器键盘：Enter/Space 经 click 触发；Arrow 直接开菜单；Escape 关闭
    trigger.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
        trigger.focus();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!el.classList.contains('is-open')) {
          setDropdownOpen(el, true);
          const items = menuItems(el);
          // ArrowDown 聚焦首项，ArrowUp 聚焦末项（与原生组合框一致）
          const target = e.key === 'ArrowUp' ? items[items.length - 1] : items[0];
          target?.focus();
        }
      }
    });

    // 菜单内键盘导航：方向键在项间移动、Home/End 跳首/末、Escape 关闭并回触发器
    menu.addEventListener('keydown', (e: KeyboardEvent) => {
      const items = menuItems(el);
      if (items.length === 0) return;
      const idx = items.indexOf(root.activeElement as HTMLElement);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        items[Math.min(idx + 1, items.length - 1)].focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        items[Math.max(idx - 1, 0)].focus();
      } else if (e.key === 'Home') {
        e.preventDefault();
        items[0].focus();
      } else if (e.key === 'End') {
        e.preventDefault();
        items[items.length - 1].focus();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close();
        trigger.focus();
      } else if (e.key === 'Tab') {
        // Tab 离开菜单：收起菜单，让焦点自然落入下一个可聚焦元素
        close();
      }
    });

    // 选择项用「事件委托」：菜单项可能动态渲染（模型列表），closest 命中即可转发
    menu.addEventListener('click', (e) => {
      e.stopPropagation();
      const target = e.target as HTMLElement | null;
      const item = target?.closest ? target.closest('.treedd__item') : null;
      if (!item) return;
      close();
      const cbName = el.getAttribute('data-on-select') || '__treeddOnSelect';
      const cb = callbacks[cbName];
      if (cb) cb(String(item.getAttribute('data-treedd-id')));
    });
  });
  // 点击任意位置关闭所有展开的下拉
  root.addEventListener('click', () => {
    root.querySelectorAll('.treedd.is-open').forEach((o) =>
      setDropdownOpen(o as HTMLElement, false),
    );
  });
}

export { dropdownStyles };