/**
 * 下拉选择器渲染域（pickerView）单元测试
 *
 * 覆盖判据全部落在本域自己的执行链（不拉整个 chatView）：
 *   - 不传 footerAction 时产物逐字不变（不引入 class / 额外节点）
 *   - 传 footerAction 时：分隔线 + 单按钮，.id 落到 data-treedd-id（点击委托命中即分流）
 *   - 尾项 label 走 textContent（本地化文本来自调用方，禁止 innerHTML 拼用户数据）
 *   - 空列表 + 尾项：空态文案与尾项共存，尾项仍可点（无模型时仍可去配置）
 *   - 选中态语义通道：aria-current 从 isActive 派生，动作尾项不冒领（MODEL-PICKER-STATE-1）
 *   - 新出现项通道（MODEL-PICKER-NEW-1）：is-new + title 从 justAddedNames 派生，
 *     与 is-active 正交（同项可并存），不传则产物逐字不变
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { createPickerView } from '../scripts/pickerView.js';

const OPTS = { labelFallback: 'Select model', ariaLabel: 'Select model' };

describe('pickerView 固定尾项（MODEL-PICKER-ADD-1）', () => {
  let view: ReturnType<typeof createPickerView>;
  let menu: HTMLElement;
  let trigger: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    view = createPickerView({ document });
    menu = document.createElement('div');
    menu.className = 'treedd__menu';
    trigger = document.createElement('button');
    trigger.className = 'treedd__trigger';
    document.body.append(menu, trigger);
  });

  it('不传 footerAction：产物逐字不变（无分隔线、无额外按钮）', () => {
    view.renderPicker(menu, trigger, [{ name: 'mimo', displayName: 'Mimo' }], 'mimo', OPTS);
    expect(menu.children).toHaveLength(1);
    expect(menu.querySelector('.treedd__divider')).toBeNull();
    expect([...menu.querySelectorAll('.treedd__item')].map((b) => b.textContent)).toEqual(['Mimo']);
  });

  it('传 footerAction：分隔线 + 单按钮，id 落到 data-treedd-id 供委托分流', () => {
    view.renderPicker(
      menu,
      trigger,
      [{ name: 'mimo', displayName: 'Mimo' }],
      'mimo',
      { ...OPTS, footerAction: { id: '+add-provider', label: 'Add model' } },
    );
    expect(menu.querySelector('.treedd__divider')).not.toBeNull();
    const items = [...menu.querySelectorAll('.treedd__item')];
    expect(items.map((b) => b.textContent)).toEqual(['Mimo', 'Add model']);
    expect(items[1].getAttribute('data-treedd-id')).toBe('+add-provider');
  });

  it('尾项文本走 textContent：含尖括号的本地化文案不被当成 HTML 注入', () => {
    view.renderPicker(menu, trigger, [], undefined, {
      ...OPTS,
      emptyText: 'No model configured',
      footerAction: { id: '+add-provider', label: '<img src=x onerror=alert(1)>' },
    });
    expect(menu.querySelector('img')).toBeNull();
    expect(menu.querySelector('[data-treedd-id="+add-provider"]')?.textContent).toBe(
      '<img src=x onerror=alert(1)>',
    );
  });

  it('空列表 + 尾项：空态文案保留且尾项可点（无模型仍能去配置）', () => {
    view.renderPicker(menu, trigger, [], undefined, {
      ...OPTS,
      emptyText: 'No model configured',
      footerAction: { id: '+add-provider', label: 'Add model' },
    });
    expect(menu.querySelector('.treedd__empty')?.textContent).toBe('No model configured');
    expect(menu.querySelector('[data-treedd-id="+add-provider"]')).not.toBeNull();
  });

  it('选中态语义通道：aria-current 由 isActive 派生，动作尾项不冒领', () => {
    view.renderPicker(
      menu,
      trigger,
      [
        { name: 'a', displayName: 'A' },
        { name: 'b', displayName: 'B' },
      ],
      'b',
      { ...OPTS, footerAction: { id: '+add-provider', label: 'Add model' } },
    );
    const items = [...menu.querySelectorAll<HTMLElement>('.treedd__item')];
    expect(items[0].getAttribute('aria-current')).toBe('false');
    expect(items[1].getAttribute('aria-current')).toBe('true');
    expect(items[1].classList.contains('is-active')).toBe(true);
    // 尾项是「添加模型」动作，不是候选模型，不携带选中语义
    expect(items[2].hasAttribute('aria-current')).toBe(false);
  });

  it('不传 justAddedNames：产物逐字不变（无 is-new class、无 title 角标）', () => {
    view.renderPicker(menu, trigger, [{ name: 'a', displayName: 'A' }], 'a', OPTS);
    const item = menu.querySelector('.treedd__item') as HTMLElement;
    expect(item.classList.contains('is-new')).toBe(false);
    expect(item.hasAttribute('title')).toBe(false);
  });

  it('新出现项：is-new + title 只落命中 name，aria-current 仍由 isActive 独立派生', () => {
    view.renderPicker(
      menu,
      trigger,
      [
        { name: 'a', displayName: 'A' },
        { name: 'b', displayName: 'B' },
      ],
      'a', // 选中 a，新出现 b ⇒ 两通道落在同一集合的不同项，互不冒充
      {
        ...OPTS,
        justAddedNames: new Set(['b']),
        newLabel: 'Newly added model',
        footerAction: { id: '+add-provider', label: 'Add model' },
      },
    );
    const items = [...menu.querySelectorAll<HTMLElement>('.treedd__item')];
    expect(items[0].classList.contains('is-active')).toBe(true);
    expect(items[0].classList.contains('is-new')).toBe(false);
    expect(items[1].classList.contains('is-new')).toBe(true);
    expect(items[1].getAttribute('title')).toBe('Newly added model');
    expect(items[1].getAttribute('aria-current')).toBe('false');
    // 尾项不冒领新项语义
    expect(items[2].classList.contains('is-new')).toBe(false);
  });

  it('同一项可既是 is-active 又是 is-new（选中刚新增的模型后两通道并存）', () => {
    view.renderPicker(menu, trigger, [{ name: 'a', displayName: 'A' }], 'a', {
      ...OPTS,
      justAddedNames: new Set(['a']),
      newLabel: 'Newly added model',
    });
    const item = menu.querySelector('.treedd__item') as HTMLElement;
    expect(item.classList.contains('is-active')).toBe(true);
    expect(item.classList.contains('is-new')).toBe(true);
    expect(item.getAttribute('aria-current')).toBe('true');
  });
});
