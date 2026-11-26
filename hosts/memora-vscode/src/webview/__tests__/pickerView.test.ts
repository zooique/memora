/**
 * 下拉选择器渲染域（pickerView）单元测试
 *
 * 覆盖判据全部落在本域自己的执行链（不拉整个 chatView）：
 *   - 不传 footerAction 时产物逐字不变（不引入 class / 额外节点）
 *   - 传 footerAction 时：分隔线 + 单按钮，.id 落到 data-treedd-id（点击委托命中即分流）
 *   - 尾项 label 走 textContent（本地化文本来自调用方，禁止 innerHTML 拼用户数据）
 *   - 空列表 + 尾项：空态文案与尾项共存，尾项仍可点（无模型时仍可去配置）
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
});
