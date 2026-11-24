/**
 * 角色包工种分流（宿主策略）的单点直测
 *
 * 三处选择面（设置页 roles_loaded / 聊天页 chat_role_packs / 主控 list_role_packs）
 * 共用 isWorkRolePack，任何一处另写判据不会让本文件转红——code review 应拦住。
 * 白名单而非 `!== assistant`：未知工种默认不展示（fail-closed）。
 */
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { ASSISTANT_ROLE_PACK, isWorkRolePack } from '../rolePackKind.js';

describe('isWorkRolePack（工作会话可选清单的工种闸）', () => {
  it('缺省 / work 可展示（存量包零变化）', () => {
    expect(isWorkRolePack(undefined)).toBe(true);
    expect(isWorkRolePack('work')).toBe(true);
  });

  it('assistant 不展示（助手包只服务固定绑定）', () => {
    expect(isWorkRolePack('assistant')).toBe(false);
  });

  it('未知工种不展示（fail-closed，防未来新类漏进工作会话）', () => {
    expect(isWorkRolePack('future-kind' as 'work')).toBe(false);
  });
});

describe('ASSISTANT_ROLE_PACK', () => {
  it('独立于内核兜底包常量，名字即助手包目录', () => {
    expect(ASSISTANT_ROLE_PACK).toBe('memora宝');
  });
});
