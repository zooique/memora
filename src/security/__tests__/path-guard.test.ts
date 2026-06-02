/**
 * 单元测试：路径白名单
 * 验证安全模块的拒绝/允许逻辑
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { SecurityGuard } from '../path-guard.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';

describe('SecurityGuard · 路径白名单', () => {
  let projectPath: string;
  let dataDir: string;
  let guard: SecurityGuard;

  beforeEach(() => {
    projectPath = mkdtempSync(join(tmpdir(), 'memora-test-'));
    dataDir = mkdtempSync(join(tmpdir(), 'memora-data-'));
    guard = new SecurityGuard(projectPath, dataDir, []);
  });

  it('应该允许项目目录内的路径', () => {
    const filePath = join(projectPath, 'src', 'index.ts');
    expect(() => guard.assertPathAllowed(filePath)).not.toThrow();
  });

  it('应该允许数据目录内的路径', () => {
    const filePath = join(dataDir, 'topics', '2026-06-02.md');
    expect(() => guard.assertPathAllowed(filePath)).not.toThrow();
  });

  it('应该拒绝 .ssh 目录', () => {
    const filePath = join(projectPath, '.ssh', 'id_rsa');
    expect(() => guard.assertPathAllowed(filePath)).toThrow(/黑名单/);
  });

  it('应该拒绝 .env 文件', () => {
    const filePath = join(projectPath, '.env');
    expect(() => guard.assertPathAllowed(filePath)).toThrow(/黑名单/);
  });

  it('应该拒绝项目外的路径', () => {
    const filePath = join(tmpdir(), 'other-project', 'secret.txt');
    expect(() => guard.assertPathAllowed(filePath)).toThrow(/白名单/);
  });

  it('应该支持用户显式声明的额外允许路径', () => {
    const extraPath = mkdtempSync(join(tmpdir(), 'memora-extra-'));
    const guard2 = new SecurityGuard(projectPath, dataDir, [extraPath]);
    const filePath = join(extraPath, 'docs.md');
    expect(() => guard2.assertPathAllowed(filePath)).not.toThrow();
  });
});
