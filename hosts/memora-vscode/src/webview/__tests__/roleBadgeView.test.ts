// @vitest-environment node
/**
 * roleBadgeView 能力徽章「只读投影」测试
 *
 * 立此用例的伤：`strategyHint` 从内核一路传到 `capability_badge`（protocol.ts），
 * 但 chatView 曾只传 toolMode + capabilityState，把只读这一项丢弃 ⇒ 只读角色包
 * 在聊天面不可见（只有角色卡 rolesView 显示）。
 *
 * 断言边界：只读是**附加投影**，不改三态文案；无 strategyHint 时输出与旧版逐字相同。
 */
import { describe, it, expect } from 'vitest';
import type { CapabilityStateDto } from '../../shared/protocol.js';
import { CAPABILITY_STATE_TEXT } from '../helpers/capabilityLabels.js';
import { createRoleBadgeView } from '../scripts/roleBadgeView.js';

/** 徽章节点桩：只保留 updateCapabilityBadge 写入的三个字段（无需真实 DOM） */
function badgeStub(): HTMLElement {
  return { hidden: true, textContent: '', title: '' } as unknown as HTMLElement;
}

/** 构造被测视图（document 仅 createTeamMeetingIcon 使用，本用例不碰） */
function makeView(): { view: ReturnType<typeof createRoleBadgeView>; badge: HTMLElement } {
  const badge = badgeStub();
  const view = createRoleBadgeView({
    document: {} as Document,
    roleBadge: null,
    capabilityBadge: badge,
  });
  return { view, badge };
}

/** 三态矩阵：all / residentOnly / list */
const ALL: CapabilityStateDto = { kind: 'all' };
const RESIDENT_ONLY: CapabilityStateDto = { kind: 'residentOnly' };
const LIST: CapabilityStateDto = {
  kind: 'list',
  capabilities: [
    { capability: 'file:read', label: 'File' },
    { capability: 'memory:recall', label: 'Memory' },
  ],
};

describe('updateCapabilityBadge：只读投影', () => {
  it('只读会话显示事实文案（三态文案保留在句首）', () => {
    const { view, badge } = makeView();
    view.updateCapabilityBadge('allow', ALL, { toolReadonly: 'readonly' });
    expect(badge.hidden).toBe(false);
    expect(badge.textContent).toBe(
      `${CAPABILITY_STATE_TEXT.all.label} · Read-only mode (write tools are rejected)`,
    );
    expect(badge.title).toContain('Read-only mode (write tools are rejected)');
  });

  it('非只读（full / 未给 hint）不显示只读文案', () => {
    const { view, badge } = makeView();
    view.updateCapabilityBadge('allow', ALL, { toolReadonly: 'full' });
    expect(badge.textContent).toBe(CAPABILITY_STATE_TEXT.all.label);
    view.updateCapabilityBadge('allow', ALL);
    expect(badge.textContent).toBe(CAPABILITY_STATE_TEXT.all.label);
  });

  it('三态各态与只读并存：文案只追加、不替换', () => {
    const { view, badge } = makeView();
    view.updateCapabilityBadge('allow', RESIDENT_ONLY, { toolReadonly: 'readonly' });
    expect(badge.textContent).toBe(
      `${CAPABILITY_STATE_TEXT.residentOnly.label} · Read-only mode (write tools are rejected)`,
    );
    view.updateCapabilityBadge('allow', LIST, { toolReadonly: 'readonly' });
    expect(badge.textContent).toBe('File · Memory · Read-only mode (write tools are rejected)');
  });

  it('三态不被只读项干扰：无 hint 时与 SSOT 文案逐字一致', () => {
    const { view, badge } = makeView();
    view.updateCapabilityBadge('allow', RESIDENT_ONLY);
    expect(badge.textContent).toBe(CAPABILITY_STATE_TEXT.residentOnly.label);
    expect(badge.title).toBe(CAPABILITY_STATE_TEXT.residentOnly.title);
    view.updateCapabilityBadge('allow', LIST);
    expect(badge.textContent).toBe('File · Memory');
    expect(badge.title).toBe('Allowed: File · Memory');
  });

  it('block（纯 LLM）不混入只读文案', () => {
    const { view, badge } = makeView();
    view.updateCapabilityBadge('block', ALL, { toolReadonly: 'readonly' });
    expect(badge.textContent).toBe('Pure LLM');
  });
});
