/**
 * dropdown 组件测试 — 键盘可访问性（对抗评估 P1-2 锁定）
 *
 * 用 @vitest-environment jsdom 提供 DOM 环境（per-file，不污染仓库其余 node 测试）。
 * 覆盖 initDropdowns 的：
 *   - aria-expanded 状态与 .is-open 同步（开合一致性）
 *   - 触发器 Arrow/Escape 键盘语义
 *   - 菜单内方向键 / Home / End / Escape 导航
 *   - 点击项触发回调 + 关闭；点击外部关闭
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildDropdownHtml, initDropdowns } from '../components/dropdown.js';

/** 当前测试的挂载宏：构造一个带菜单的下拉 + 外部元素，返回可断言句柄 */
type Mounted = {
  el: HTMLElement;
  trigger: HTMLButtonElement;
  menu: HTMLElement;
  items: HTMLElement[];
  onSelect: ReturnType<typeof vi.fn>;
};

function mountDropdown(): Mounted {
  document.body.innerHTML = `
    ${buildDropdownHtml(
      [
        { id: 'a', label: '选项A' },
        { id: 'b', label: '选项B' },
        { id: 'c', label: '选项C' },
      ],
      { onSelect: '__onSelect' },
    )}
    <button id="outside">外部元素</button>
  `;
  const onSelect = vi.fn();
  initDropdowns(document, { __onSelect: onSelect });
  const el = document.querySelector('.treedd') as HTMLElement;
  const trigger = el.querySelector('.treedd__trigger') as HTMLButtonElement;
  const menu = el.querySelector('.treedd__menu') as HTMLElement;
  const items = Array.from(menu.querySelectorAll('.treedd__item')) as HTMLElement[];
  return { el, trigger, menu, items, onSelect };
}

/** 向目标元素派发一个键盘事件 */
function key(el: HTMLElement, k: string): void {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
}

describe('dropdown 键盘可访问性', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('默认触发器 = 内联 ellipsis SVG（自足，不依赖 populateIcons）', () => {
    // 本用例直接挂载组件产物、不走 chatView 初始化流程（mountDropdown 只做 innerHTML +
    // initDropdowns），即「消费方未调 populateIcons」的形态——锁的是组件的**自足性契约**。
    // 注：两处生产调用点位于 chatPanel.buildHtml 的静态模板内、由初始化
    // populateIcons 覆盖，故本用例属**前瞻性锁定**（防未来动态调用点踩坑）；
    // 若默认值退回 data-icon 占位 span，此处只会拿到空 span（.treedd__trigger 固定 26px/
    // 透明背景/无边框 → 隐形可点区域）。
    const { trigger } = mountDropdown();
    const svg = trigger.querySelector('svg');
    expect(svg, '默认触发器必须是内联 <svg>').not.toBeNull();
    expect(svg!.querySelectorAll('circle').length, 'ellipsis 为三点').toBe(3);
    expect(svg!.getAttribute('stroke')).toBe('currentColor');
    expect(svg!.getAttribute('fill')).toBe('none');
    expect(svg!.getAttribute('width')).toBe('14');
    // 反向守卫：不得残留字符图标（触发器文本必须为空）
    expect(trigger.textContent).toBe('');
  });

  it('初始闭合态：aria-expanded=false 且菜单未展开', () => {
    const { el, trigger, menu } = mountDropdown();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(el.classList.contains('is-open')).toBe(false);
    expect((menu as HTMLElement).style.display).toBe('');
  });

  it('点击触发器展开：aria-expanded=true 且聚焦首项', () => {
    const { el, trigger, items } = mountDropdown();
    trigger.click();
    expect(el.classList.contains('is-open')).toBe(true);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(items[0]);
  });

  it('再次点击触发器收起：aria-expanded=false', () => {
    const { el, trigger } = mountDropdown();
    trigger.click();
    trigger.click();
    expect(el.classList.contains('is-open')).toBe(false);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('触发器 ArrowDown 直接展开并聚焦首项；ArrowUp 聚焦末项', () => {
    const { el, trigger, items } = mountDropdown();
    key(trigger, 'ArrowDown');
    expect(el.classList.contains('is-open')).toBe(true);
    expect(document.activeElement).toBe(items[0]);

    // 关闭后 ArrowUp 聚焦末项
    trigger.click();
    key(trigger, 'ArrowUp');
    expect(document.activeElement).toBe(items[items.length - 1]);
  });

  it('菜单内 ArrowDown / ArrowUp 在项间移动焦点', () => {
    const { trigger, items } = mountDropdown();
    key(trigger, 'ArrowDown'); // 聚焦首项
    key(items[0], 'ArrowDown');
    expect(document.activeElement).toBe(items[1]);
    key(items[1], 'ArrowUp');
    expect(document.activeElement).toBe(items[0]);
  });

  it('菜单内 Home 跳首项、End 跳末项', () => {
    const { trigger, items } = mountDropdown();
    key(trigger, 'ArrowDown');
    key(items[0], 'End');
    expect(document.activeElement).toBe(items[items.length - 1]);
    key(items[items.length - 1], 'Home');
    expect(document.activeElement).toBe(items[0]);
  });

  it('Escape 关闭菜单并聚焦回触发器', () => {
    const { el, trigger, items } = mountDropdown();
    key(trigger, 'ArrowDown');
    expect(el.classList.contains('is-open')).toBe(true);
    key(items[0], 'Escape');
    expect(el.classList.contains('is-open')).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it('点击菜单项触发对应回调并收起菜单', () => {
    const { el, trigger, items, onSelect } = mountDropdown();
    trigger.click();
    items[1].click();
    expect(onSelect).toHaveBeenCalledWith('b');
    expect(el.classList.contains('is-open')).toBe(false);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('点击外部元素关闭已展开的下拉', () => {
    const { el, trigger } = mountDropdown();
    trigger.click();
    expect(el.classList.contains('is-open')).toBe(true);
    (document.getElementById('outside') as HTMLElement).click();
    expect(el.classList.contains('is-open')).toBe(false);
  });

  it('自动翻转方向（P1-2）：贴近顶缘向下弹，远离顶缘保持向上', () => {
    document.body.innerHTML = buildDropdownHtml([{ id: 'm', label: '模型A' }], {
      onSelect: '__onSelect',
      extraClass: 'treedd--capsule',
    });
    const onSelect = vi.fn();
    initDropdowns(document, { __onSelect: onSelect });
    const el = document.querySelector('.treedd') as HTMLElement;
    const trigger = el.querySelector('.treedd__trigger') as HTMLElement;

    // 场景1：触发器贴近容器顶缘（top=10）→ 向上放不下 → 翻转向下弹
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      top: 10, bottom: 36, left: 0, right: 50, width: 50, height: 26, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    trigger.click();
    expect(el.classList.contains('treedd--drop-down')).toBe(true);

    // 收起后换场景
    trigger.click();

    // 场景2：触发器远离顶缘（top=500）→ 向上空间足 → 保持向上弹（不翻转）
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      top: 500, bottom: 526, left: 0, right: 50, width: 50, height: 26, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    trigger.click();
    expect(el.classList.contains('treedd--drop-down')).toBe(false);
  });
});