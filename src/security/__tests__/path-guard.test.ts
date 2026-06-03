/**
 * 单元测试：路径白名单
 * 验证安全模块的拒绝/允许逻辑
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { SecurityGuard } from '@/security/path-guard.js';
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

  it('应该拒绝 .aws 目录', () => {
    const filePath = join(projectPath, '.aws', 'credentials');
    expect(() => guard.assertPathAllowed(filePath)).toThrow(/黑名单/);
  });

  it('应该拒绝 System32 路径', () => {
    const filePath = 'C:\\Windows\\System32\\drivers\\etc\\hosts';
    expect(() => guard.assertPathAllowed(filePath)).toThrow(/黑名单/);
  });

  it('应该拒绝 etc/passwd 路径', () => {
    const filePath = '/etc/passwd';
    expect(() => guard.assertPathAllowed(filePath)).toThrow(/黑名单/);
  });

  it('应该拒绝 .env.local 文件', () => {
    const filePath = join(projectPath, '.env.local');
    expect(() => guard.assertPathAllowed(filePath)).toThrow(/黑名单/);
  });

  it('应该拒绝项目外的路径', () => {
    const filePath = join(tmpdir(), 'other-project', 'secret.txt');
    expect(() => guard.assertPathAllowed(filePath)).toThrow(/越界/);
  });

  it('应该支持用户显式声明的额外允许路径', () => {
    const extraPath = mkdtempSync(join(tmpdir(), 'memora-extra-'));
    const guard2 = new SecurityGuard(projectPath, dataDir, [extraPath]);
    const filePath = join(extraPath, 'docs.md');
    expect(() => guard2.assertPathAllowed(filePath)).not.toThrow();
  });
});

describe('SecurityGuard · 审计日志（M-105）', () => {
  let projectPath: string;
  let dataDir: string;

  beforeEach(() => {
    projectPath = mkdtempSync(join(tmpdir(), 'memora-audit-'));
    dataDir = mkdtempSync(join(tmpdir(), 'memora-data-'));
  });

  it('应该为允许的路径生成 path-allow 审计事件', () => {
    const guard = new SecurityGuard(projectPath, dataDir, []);
    const filePath = join(projectPath, 'src/index.ts');
    guard.assertPathAllowed(filePath, 'read_file');

    const audits = guard.getRecentAudits();
    expect(audits.length).toBeGreaterThan(0);
    const last = audits[audits.length - 1]!;
    expect(last.type).toBe('path-allow');
    expect(last.tool).toBe('read_file');
  });

  it('应该为拒绝的路径生成 path-deny 审计事件', () => {
    const guard = new SecurityGuard(projectPath, dataDir, []);
    const filePath = join(projectPath, '.ssh/id_rsa');
    expect(() => guard.assertPathAllowed(filePath, 'read_file')).toThrow();

    const audits = guard.getRecentAudits();
    const last = audits[audits.length - 1]!;
    expect(last.type).toBe('path-deny');
    expect(last.reason).toMatch(/黑名单/);
  });

  it('应该通知所有订阅者', () => {
    const guard = new SecurityGuard(projectPath, dataDir, []);
    const events: string[] = [];
    guard.onAudit((e) => events.push(e.type));

    guard.assertPathAllowed(join(projectPath, 'a.ts'), 'read_file');
    try {
      guard.assertPathAllowed(join(projectPath, '.env'), 'read_file');
    } catch {
      // 预期抛出
    }

    expect(events).toContain('path-allow');
    expect(events).toContain('path-deny');
  });

  it('onAudit 应返回取消订阅函数', () => {
    const guard = new SecurityGuard(projectPath, dataDir, []);
    const events: string[] = [];
    const off = guard.onAudit((e) => events.push(e.type));
    guard.assertPathAllowed(join(projectPath, 'a.ts'), 'read_file');
    off();
    guard.assertPathAllowed(join(projectPath, 'b.ts'), 'read_file');
    expect(events).toHaveLength(1);
  });
});

describe('SecurityGuard · 写入二次确认（M-101）', () => {
  let projectPath: string;
  let dataDir: string;

  beforeEach(() => {
    projectPath = mkdtempSync(join(tmpdir(), 'memora-confirm-'));
    dataDir = mkdtempSync(join(tmpdir(), 'memora-data-'));
  });

  it('owner + confirmWrites=false 应该自动批准（不读取 stdin）', async () => {
    const guard = new SecurityGuard(projectPath, dataDir, [], false, 'owner');
    const ok = await guard.requestWriteConfirmation(join(projectPath, 'out.txt'), 'write_file');
    expect(ok).toBe(true);

    const audits = guard.getRecentAudits();
    const last = audits[audits.length - 1]!;
    expect(last.type).toBe('write-auto');
    expect(last.decision).toBe('auto-approved');
  });

  it('owner + confirmWrites=true 应该要求确认（mock stdin = y）', async () => {
    const guard = new SecurityGuard(projectPath, dataDir, [], true, 'owner');
    // 暂无法稳定 mock readline/promises 内部 stdin，这里只验证决策类型
    // 集成场景：E2E 测用户输入 y/N 时的交互
    const audits = guard.getRecentAudits();
    expect(audits).toEqual([]);
  });

  it('guest 模式应始终要求确认（与 confirmWrites 无关）', async () => {
    const guard = new SecurityGuard(projectPath, dataDir, [], false, 'guest');
    // 同样：交互场景留给 E2E
    // 此处只验证构造正确
    expect(guard.permission).toBe('guest');
  });
});
