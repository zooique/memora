/**
 * 权限模型
 *
 * 两级权限：owner / guest
 * 详见 安全权限设计 v0.1.md §2 + ADR-006
 */
import { logger } from '@/logging/logger.js';

export type Permission = 'owner' | 'guest';

export interface PermissionPolicy {
  mode: Permission;
  confirmWrites: boolean;
}

/**
 * 检查写操作是否需要二次确认
 */
export function shouldConfirmWrite(policy: PermissionPolicy): boolean {
  if (policy.confirmWrites) return true;
  // owner 模式默认不确认
  return false;
}

/**
 * 权限检查失败时记录审计日志
 */
export function auditPermissionDenied(
  action: string,
  reason: string,
  context: Record<string, unknown>,
): void {
  logger.warn({ audit: 'permission_denied', action, reason, ...context }, '权限被拒绝');
}
