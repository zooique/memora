/**
 * 权限模型测试
 * 覆盖 shouldConfirmWrite / auditPermissionDenied
 */
import { describe, it, expect } from 'vitest';
import {
  shouldConfirmWrite,
  auditPermissionDenied,
  type PermissionPolicy,
} from '@/security/permissions.js';

describe('shouldConfirmWrite · 写入二次确认判断', () => {
  it('confirmWrites 为 true 时应该返回 true', () => {
    const policy: PermissionPolicy = { mode: 'owner', confirmWrites: true };
    expect(shouldConfirmWrite(policy)).toBe(true);
  });

  it('owner 模式 + confirmWrites=false 时应该返回 false（默认不确认）', () => {
    const policy: PermissionPolicy = { mode: 'owner', confirmWrites: false };
    expect(shouldConfirmWrite(policy)).toBe(false);
  });

  it('guest 模式 + confirmWrites=false 时也应该返回 false（策略层不做额外判断，path-guard 负责）', () => {
    const policy: PermissionPolicy = { mode: 'guest', confirmWrites: false };
    expect(shouldConfirmWrite(policy)).toBe(false);
  });
});

describe('auditPermissionDenied · 权限拒绝审计', () => {
  it('应该不抛出异常（仅记录日志）', () => {
    expect(() =>
      auditPermissionDenied('delete_file', '权限不足', { path: '/etc/passwd' }),
    ).not.toThrow();
  });

  it('应该接受空 context', () => {
    expect(() => auditPermissionDenied('unknown_action', '测试拒绝', {})).not.toThrow();
  });
});
