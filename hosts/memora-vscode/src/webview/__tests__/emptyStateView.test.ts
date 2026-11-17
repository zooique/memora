/**
 * emptyStateView · 助手形态空态口径
 *
 * 钉三条边界（ASSISTANT-FORM，2026-11-16 泄漏修复）：
 * ④ 角色化空态（「开始与 XX 对话」+ 角色 chips）是自助会话语义，助手座位不渲染；
 * ⑤ 未配置模型的 onboarding 引导是功能引导，助手座位保留（唯一例外）；
 * ⑥ 自助形态不受影响（回归对照）。
 *
 * 注：草稿默认模式提示随「新建会话不再选运行模式」（2026-11-17 入口收口）一并退役。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { createEmptyStateView } from '../scripts/emptyStateView.js';
import type { UiForm } from '../../shared/protocol.js';

/** 最小骨架：与 chatPanelHtml 的空态结构同形，只铺本域读取的节点 */
function setup(form: UiForm | (() => UiForm) = 'self'): ReturnType<typeof createEmptyStateView> {
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
    // 形态真源读数：函数形式 = 可变形态（测跨形态切换的动态裁决）
    getForm: typeof form === 'function' ? form : () => form,
  });
}

describe('emptyStateView · 助手形态空态口径（ASSISTANT-FORM）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('④ 助手座位不渲染角色化空态：updateRole 不写标题/提示，chips 清空，空态整块隐藏', () => {
    const view = setup('assistant');
    view.updateRole('共鸣小说家', [{ displayName: '共鸣小说家', description: '小说角色' }]);

    // 标题/提示不写角色内容（保持空串——「开始与 XX 对话」不得出现在助手座位）
    expect(document.getElementById('emptyTitle')?.textContent).toBe('');
    expect(document.getElementById('emptyHint')?.textContent).toBe('');
    // 示例 chips（自助角色的提问）清空
    expect(document.getElementById('emptySuggestions')?.children).toHaveLength(0);
    // 空态整块隐藏：助手座位无消息 = 干净空白（微信式），不是一张自助空态卡
    expect(document.getElementById('emptyState')?.hidden).toBe(true);
  });

  it('⑤ onboarding 是唯一例外：未配置模型时助手座位仍显示引导', () => {
    const view = setup('assistant');
    view.onboarding();
    view.update();
    // onboarding 按钮在场 ⇒ 空态显形（功能性引导两个形态都要）
    expect(document.getElementById('emptyState')?.hidden).toBe(false);
    expect(document.querySelector('.empty-onboard-btn')).not.toBeNull();
    // onboarding 之后角色推送到达：不得清掉 onboarding 文案（updateRole 只清 chips）
    const title = document.getElementById('emptyTitle')?.textContent;
    view.updateRole('共鸣小说家', []);
    expect(document.getElementById('emptyTitle')?.textContent).toBe(title);
    expect(document.getElementById('emptyState')?.hidden).toBe(false);
  });

  it('自助形态不受影响：角色化空态照常渲染（回归对照）', () => {
    const view = setup('self');
    view.updateRole('共鸣小说家', [{ displayName: '共鸣小说家' }]);
    expect(document.getElementById('emptyTitle')?.textContent).toContain('共鸣小说家');
    expect(document.getElementById('emptySuggestions')?.children.length).toBeGreaterThan(0);
    // 显隐只归 update() 管（updateRole 是纯文案域，历史语义不变）
    view.update();
    expect(document.getElementById('emptyState')?.hidden).toBe(false);
  });
});
