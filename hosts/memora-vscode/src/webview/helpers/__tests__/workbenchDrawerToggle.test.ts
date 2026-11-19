/**
 * 工作台抽屉显隐 toggle 判据（INLINE-WORKBENCH-1 真机订正 2026-11-19）
 *
 * 钉死三条判据：
 *   ① 展开态唯一真源 = 抽屉 DOM 的 hidden 属性，不在 JS 里另存开关态；
 *   ② shouldOpenWorkbench：隐藏时返回 true（请求宿主构建快照），已展开时置 hidden 并返回 false；
 *   ③ hideWorkbenchDrawer：只置 hidden，节点不存在（self 形态）时静默不抛。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { hideWorkbenchDrawer, shouldOpenWorkbench } from '../workbenchDrawerToggle.js';

const DRAWER_ID = 'assistantWorkbenchDrawer';

function mount(hidden = true): HTMLElement {
  document.body.innerHTML = `<section id="${DRAWER_ID}"${hidden ? ' hidden' : ''}></section>`;
  return document.getElementById(DRAWER_ID) as HTMLElement;
}

describe('工作台抽屉显隐 toggle（展开态真源 = DOM hidden）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('隐藏时 shouldOpenWorkbench 返回 true（调用方上行请求快照），不改变 hidden', () => {
    const drawer = mount(true);
    expect(shouldOpenWorkbench(document)).toBe(true);
    expect(drawer.hidden).toBe(true);
  });

  it('已展开时 shouldOpenWorkbench 置 hidden 折叠并返回 false（不再请求快照）', () => {
    const drawer = mount(false);
    expect(drawer.hidden).toBe(false);
    expect(shouldOpenWorkbench(document)).toBe(false);
    expect(drawer.hidden).toBe(true);
  });

  it('hideWorkbenchDrawer 只置 hidden；节点不存在（self 形态）时静默不抛', () => {
    const drawer = mount(false);
    hideWorkbenchDrawer(document);
    expect(drawer.hidden).toBe(true);
    document.body.innerHTML = '';
    expect(() => hideWorkbenchDrawer(document)).not.toThrow();
  });
});
