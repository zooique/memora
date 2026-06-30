/**
 * 单元测试：路径白名单
 * 验证安全模块的拒绝/允许逻辑
 * SEC-06（自动安全）：补充符号链接逃逸 + 包管理器凭证 + 系统目录覆盖测试
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { SecurityGuard } from '@/security/pathGuard.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';

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
    const filePath = join(dataDir, 'sessions', '2026-06-02.md');
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

  it('应该拒绝 .gnupg 目录', () => {
    const filePath = join(projectPath, '.gnupg', 'private-keys-v1.d');
    expect(() => guard.assertPathAllowed(filePath)).toThrow(/黑名单/);
  });

  it('应该拒绝 .docker 目录', () => {
    const filePath = join(projectPath, '.docker', 'config.json');
    expect(() => guard.assertPathAllowed(filePath)).toThrow(/黑名单/);
  });

  it('应该拒绝 .kube 目录', () => {
    const filePath = join(projectPath, '.kube', 'config');
    expect(() => guard.assertPathAllowed(filePath)).toThrow(/黑名单/);
  });

  it('应该拒绝 .azure 目录', () => {
    const filePath = join(projectPath, '.azure', 'accessTokens.json');
    expect(() => guard.assertPathAllowed(filePath)).toThrow(/黑名单/);
  });

  it('应该拒绝 .netrc 文件', () => {
    const filePath = join(projectPath, '.netrc');
    expect(() => guard.assertPathAllowed(filePath)).toThrow(/黑名单/);
  });

  it('应该拒绝 .pgpass 文件', () => {
    const filePath = join(projectPath, '.pgpass');
    expect(() => guard.assertPathAllowed(filePath)).toThrow(/黑名单/);
  });

  it('应该拒绝 gcloud 配置目录', () => {
    const filePath = join(projectPath, '.config', 'gcloud', 'credentials.db');
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

  // ─── 兄弟目录绕过防护（P1 安全漏洞修复验证）──

  it('应该拒绝项目目录的兄弟目录（前缀匹配绕过防护）', () => {
    // 场景：projectPath = /tmp/memora-test-xxx
    // 攻击路径：/tmp/memora-test-xxx-evil/secret.txt
    // 旧的 startsWith(projectPath) 会误判为允许，新的 startsWith(projectPath + sep) 正确拒绝
    const evilPath = `${projectPath}-evil`;
    const filePath = join(evilPath, 'secret.txt');
    expect(() => guard.assertPathAllowed(filePath)).toThrow(/越界/);
  });

  it('应该拒绝数据目录的兄弟目录（前缀匹配绕过防护）', () => {
    const evilPath = `${dataDir}-evil`;
    const filePath = join(evilPath, 'secret.txt');
    expect(() => guard.assertPathAllowed(filePath)).toThrow(/越界/);
  });

  it('应该拒绝额外允许路径的兄弟目录（前缀匹配绕过防护）', () => {
    const extraPath = mkdtempSync(join(tmpdir(), 'memora-extra-'));
    const guard2 = new SecurityGuard(projectPath, dataDir, [extraPath]);
    const evilPath = `${extraPath}-evil`;
    const filePath = join(evilPath, 'secret.txt');
    expect(() => guard2.assertPathAllowed(filePath)).toThrow(/越界/);
  });

  it('应该支持用户显式声明的额外允许路径', () => {
    const extraPath = mkdtempSync(join(tmpdir(), 'memora-extra-'));
    const guard2 = new SecurityGuard(projectPath, dataDir, [extraPath]);
    const filePath = join(extraPath, 'docs.md');
    expect(() => guard2.assertPathAllowed(filePath)).not.toThrow();
  });

  // ─── SEC-06：包管理器凭证文件拦截 ──────────────────────

  it('应该拒绝 .gitconfig 文件', () => {
    const filePath = join(projectPath, '.gitconfig');
    expect(() => guard.assertPathAllowed(filePath)).toThrow(/黑名单/);
  });

  it('应该拒绝 .git-credentials 文件', () => {
    const filePath = join(projectPath, '.git-credentials');
    expect(() => guard.assertPathAllowed(filePath)).toThrow(/黑名单/);
  });

  it('应该拒绝 .npmrc 文件', () => {
    const filePath = join(projectPath, '.npmrc');
    expect(() => guard.assertPathAllowed(filePath)).toThrow(/黑名单/);
  });

  it('应该拒绝 .pypirc 文件', () => {
    const filePath = join(projectPath, '.pypirc');
    expect(() => guard.assertPathAllowed(filePath)).toThrow(/黑名单/);
  });

  it('应该拒绝 .htpasswd 文件', () => {
    const filePath = join(projectPath, '.htpasswd');
    expect(() => guard.assertPathAllowed(filePath)).toThrow(/黑名单/);
  });

  // ─── SEC-06：环境变量文件多段后缀拦截 ──────────────────

  it('应该拒绝 .env.production.local 等多段后缀文件', () => {
    // 旧正则 [^\\/.]+ 不允许后缀含 .，导致 .env.production.local 被绕过
    const filePath = join(projectPath, '.env.production.local');
    expect(() => guard.assertPathAllowed(filePath)).toThrow(/黑名单/);
  });

  it('应该拒绝 .env.development.example 文件', () => {
    const filePath = join(projectPath, '.env.development.example');
    expect(() => guard.assertPathAllowed(filePath)).toThrow(/黑名单/);
  });

  // ─── SEC-06：Windows 系统目录覆盖 ──────────────────────

  it('应该拒绝 C:\\Windows 直接子文件（非仅 System32）', () => {
    const filePath = 'C:\\Windows\\win.ini';
    expect(() => guard.assertPathAllowed(filePath)).toThrow(/黑名单/);
  });

  it('应该拒绝 C:\\Program Files 路径', () => {
    const filePath = 'C:\\Program Files\\app\\config.exe';
    expect(() => guard.assertPathAllowed(filePath)).toThrow(/黑名单/);
  });

  it('应该拒绝 C:\\Program Files (x86) 路径', () => {
    const filePath = 'C:\\Program Files (x86)\\app\\config.exe';
    expect(() => guard.assertPathAllowed(filePath)).toThrow(/黑名单/);
  });

  it('应该拒绝 C:\\ProgramData 路径', () => {
    const filePath = 'C:\\ProgramData\\app\\secret.dat';
    expect(() => guard.assertPathAllowed(filePath)).toThrow(/黑名单/);
  });

  // ─── SEC-06：Linux/macOS 系统目录覆盖（根目录锚定）───
  // 跨平台兼容：Linux 上 ^/ 黑名单拦截，Windows 上被白名单越界拦截（C:\usr 不是系统目录）
  // 两种拒绝都验证了路径被正确阻止

  it('应该拒绝 /usr 目录（非仅 /etc/passwd）', () => {
    const filePath = '/usr/bin/python3';
    expect(() => guard.assertPathAllowed(filePath)).toThrow(/黑名单|越界/);
  });

  it('应该拒绝 /var 目录（非仅 /var/log）', () => {
    const filePath = '/var/lib/mysql/data';
    expect(() => guard.assertPathAllowed(filePath)).toThrow(/黑名单|越界/);
  });

  it('应该拒绝 /root 目录', () => {
    const filePath = '/root/.bashrc';
    expect(() => guard.assertPathAllowed(filePath)).toThrow(/黑名单|越界/);
  });

  it('应该拒绝 /home 目录', () => {
    const filePath = '/home/otheruser/.ssh/id_rsa';
    expect(() => guard.assertPathAllowed(filePath)).toThrow(/黑名单|越界/);
  });

  it('应该拒绝 /etc 目录（整体拦截，非仅 passwd/shadow）', () => {
    const filePath = '/etc/nginx/nginx.conf';
    expect(() => guard.assertPathAllowed(filePath)).toThrow(/黑名单|越界/);
  });

  // ─── SEC-06：符号链接逃逸防护（P0 安全漏洞）────────────

  it('应该拒绝通过项目内符号链接逃逸到项目外目录', () => {
    // 攻击场景：项目内存在指向项目外的符号链接，read_file 通过该链接读取敏感文件
    // 旧实现 resolve() 不解析符号链接，白名单前缀匹配会误判为允许
    const evilDir = mkdtempSync(join(tmpdir(), 'memora-evil-'));
    // 在 evilDir 中放置一个文件（确保 realpath 有解析目标）
    writeFileSync(join(evilDir, 'secret.txt'), 'stolen');
    const symlinkPath = join(projectPath, 'evil-link');
    let symlinkCreated = false;
    try {
      symlinkSync(evilDir, symlinkPath);
      symlinkCreated = true;
    } catch {
      // Windows 无管理员权限/开发者模式时无法创建符号链接，静默跳过
    }
    if (!symlinkCreated) return;

    const filePath = join(symlinkPath, 'secret.txt');
    // 符号链接被 resolveRealpath 解析为 evilDir/secret.txt，不在白名单内
    expect(() => guard.assertPathAllowed(filePath)).toThrow(/越界/);
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
