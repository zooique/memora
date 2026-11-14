/**
 * emptyStateView · 草稿默认模式提示
 *
 * 钉三条边界，而不是「元素能创建」：
 * ① 仅 `'managed'` 渲染，文案必须说明「可切回自助」；
 * ② `'self'` / undefined 移除元素（普通用户不受打扰，且切会话不残留）；
 * ③ 重复投影幂等（进入 / 重建 / 建会话失败回滚共用同一次 setDefaultMode）。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { createEmptyStateView } from '../scripts/emptyStateView.js';

/** 最小骨架：与 chatPanelHtml 的空态结构同形，只铺本域读取的节点 */
function setup(): ReturnType<typeof createEmptyStateView> {
  document.body.innerHTML = `
    <div id="emptyState">
      <div id="emptyTitle"></div>
      <div id="emptyHint"></div>
      <div id="emptySuggestions"></div>
    </div>
    <div id="messages"></div>
  `;
  return createEmptyStateView({
    document,
    emptyState: document.getElementById('emptyState') as HTMLElement,
    emptyTitle: document.getElementById('emptyTitle') as HTMLElement,
    emptyHint: document.getElementById('emptyHint') as HTMLElement,
    emptySuggestions: document.getElementById('emptySuggestions') as HTMLElement,
    messages: document.getElementById('messages') as HTMLElement,
    postMessage: () => {},
  });
}

describe('emptyStateView · 草稿默认模式提示', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('托管：渲染结论 + 切回自助说明，且挂在空态描述之后', () => {
    const view = setup();
    view.setDefaultMode('managed');

    const hints = document.querySelectorAll('.empty-mode-hint');
    expect(hints).toHaveLength(1);
    expect(hints[0]?.textContent).toContain('Default mode: Managed');
    expect(hints[0]?.textContent).toContain('switch back to self mode');
    // 位置：紧跟在 emptyHint 之后（复用现有空态结构，不新增浮层）
    const hintEl = document.getElementById('emptyHint');
    expect(hintEl?.nextElementSibling?.classList.contains('empty-mode-hint')).toBe(true);
  });

  it('self / undefined：不渲染并清掉已有提示', () => {
    const view = setup();
    view.setDefaultMode('managed');
    expect(document.querySelector('.empty-mode-hint')).not.toBeNull();

    view.setDefaultMode('self');
    expect(document.querySelector('.empty-mode-hint')).toBeNull();

    view.setDefaultMode('managed');
    view.setDefaultMode(undefined);
    expect(document.querySelector('.empty-mode-hint')).toBeNull();
  });

  it('重复投影幂等：连续两次 managed 不叠加', () => {
    const view = setup();
    view.setDefaultMode('managed');
    view.setDefaultMode('managed');
    expect(document.querySelectorAll('.empty-mode-hint')).toHaveLength(1);
  });
});
