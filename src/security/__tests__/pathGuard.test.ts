/**
 * 单元测试：路径白名单
 * 验证安全模块的拒绝/允许逻辑
 * 覆盖：符号链接逃逸 + 包管理器凭证 + 系统目录覆盖
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { SecurityGuard, type WriteConfirmationInfo, type AuditEvent } from '@/security/pathGuard.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';

/**
 * 收集审计事件辅助：替代已删除的 getRecentAudits 缓冲查询——
 * onAudit 订阅是审计事件的唯一读取通道（流式），断言前订阅、操作后取最后一条。
 */
function collectAudits(guard: SecurityGuard): AuditEvent[] {
  const events: AuditEvent[] = [];
  guard.onAudit((e) => events.push(e));
  return events;
}

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

  // ─── 兄弟目录绕过防护 ──

  it('应该拒绝项目目录的兄弟目录（前缀匹配绕过防护）', () => {
    // 场景：projectPath = /tmp/memora-test-xxx
    // 攻击路径：/tmp/memora-test-xxx-evil/secret.txt
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

  // ─── 包管理器凭证文件拦截 ──────────────────────

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

  // ─── 环境变量文件多段后缀拦截 ──────────────────

  it('应该拒绝 .env.production.local 等多段后缀文件', () => {
    // 旧正则 [^\\/.]+ 不允许后缀含 .，导致 .env.production.local 被绕过
    const filePath = join(projectPath, '.env.production.local');
    expect(() => guard.assertPathAllowed(filePath)).toThrow(/黑名单/);
  });

  it('应该拒绝 .env.development.example 文件', () => {
    const filePath = join(projectPath, '.env.development.example');
    expect(() => guard.assertPathAllowed(filePath)).toThrow(/黑名单/);
  });

  // .envrc 不在 .env.* 后缀模式覆盖范围内，需独立拦截
  it('应该拒绝 .envrc 文件（direnv 配置）', () => {
    const filePath = join(projectPath, '.envrc');
    expect(() => guard.assertPathAllowed(filePath)).toThrow(/黑名单/);
  });

  // ─── Windows 系统目录覆盖 ──────────────────────

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

  // ─── Linux/macOS 系统目录覆盖（根目录锚定）───
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

  // ─── 符号链接逃逸防护 ────────────

  it.skipIf(process.platform === 'win32')('应该拒绝通过项目内符号链接逃逸到项目外目录', () => {
    // 攻击场景：项目内存在指向项目外的符号链接，read_file 通过该链接读取敏感文件
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

  // ─── NFKC 规范化防御（全角字符绕过防护）─────────
  // 攻击场景：攻击者使用全角字符（U+FF0E 等）绕过黑名单正则匹配，
  // NFKC 规范化将全角字符归一化为半角，确保黑名单/白名单匹配基于规范化后的路径。

  it('应该将全角 ．．/ 规范化为 ../ 并拦截路径遍历', () => {
    // 全角句号 U+FF0E，NFKC 后变为半角 . ，组合成 ../ 触发越界
    const fullWidthDots = '\uFF0E\uFF0E';
    const filePath = `${projectPath}${fullWidthDots}${fullWidthDots}/secret.txt`;
    expect(() => guard.assertPathAllowed(filePath)).toThrow(/越界|黑名单/);
  });

  it('应该将全角 ．ｅｎｖ 规范化为 .env 并命中黑名单', () => {
    // 全角 ．ｅｎｖ NFKC 后变为 .env，命中环境变量文件黑名单
    const fullWidthEnv = '\uFF0E\uFF45\uFF4E\uFF56';
    const filePath = join(projectPath, fullWidthEnv);
    expect(() => guard.assertPathAllowed(filePath)).toThrow(/黑名单/);
  });

  it('应该将全角 ．ｓｓｈ 目录规范化为 .ssh 并命中黑名单', () => {
    // 全角 ．ｓｓｈ NFKC 后变为 .ssh
    const fullWidthSsh = '\uFF0E\uFF53\uFF53\uFF48';
    const filePath = join(projectPath, fullWidthSsh, 'id_rsa');
    expect(() => guard.assertPathAllowed(filePath)).toThrow(/黑名单/);
  });

  it('应该将全角 ．ｎｐｍｒｃ 规范化为 .npmrc 并命中黑名单', () => {
    // 全角 ．ｎｐｍｒｃ NFKC 后变为 .npmrc
    const fullWidthNpmrc = '\uFF0E\uFF4E\uFF50\uFF4D\uFF52\uFF43';
    const filePath = join(projectPath, fullWidthNpmrc);
    expect(() => guard.assertPathAllowed(filePath)).toThrow(/黑名单/);
  });

  it('全角字符路径经 NFKC 规范化后仍在白名单内应放行', () => {
    // 验证 NFKC 不会误伤合法的全角文件名（非黑名单/白名单内）
    // 全角 ｄｏｃｓ NFKC 后变为 docs，在项目目录内应放行
    const fullWidthDocs = '\uFF44\uFF4F\uFF43\uFF53';
    const filePath = join(projectPath, fullWidthDocs);
    expect(() => guard.assertPathAllowed(filePath)).not.toThrow();
  });
});

describe('SecurityGuard · 动态 allowedPaths（G8）', () => {
  let projectPath: string;
  let dataDir: string;
  let guard: SecurityGuard;

  beforeEach(() => {
    projectPath = mkdtempSync(join(tmpdir(), 'memora-dyn-'));
    dataDir = mkdtempSync(join(tmpdir(), 'memora-data-'));
    guard = new SecurityGuard(projectPath, dataDir, []);
  });

  it('setAllowedPaths 新增额外目录后应允许其内路径', () => {
    const extra = mkdtempSync(join(tmpdir(), 'memora-extra-'));
    guard.setAllowedPaths([extra]);
    expect(() => guard.assertPathAllowed(join(extra, 'docs.md'))).not.toThrow();
  });

  it('setAllowedPaths([]) 应清空额外项，原额外目录越界', () => {
    const extra = mkdtempSync(join(tmpdir(), 'memora-extra-'));
    guard.setAllowedPaths([extra]);
    expect(() => guard.assertPathAllowed(join(extra, 'docs.md'))).not.toThrow();
    guard.setAllowedPaths([]);
    expect(() => guard.assertPathAllowed(join(extra, 'docs.md'))).toThrow(/越界/);
  });

  it('setAllowedPaths 不应移除基准根（基准目录仍放行）', () => {
    const extra = mkdtempSync(join(tmpdir(), 'memora-extra-'));
    guard.setAllowedPaths([extra]);
    // 基准根（projectPath）内路径仍应放行
    expect(() => guard.assertPathAllowed(join(projectPath, 'src', 'index.ts'))).not.toThrow();
    // 基准根（dataDir）内路径仍应放行
    expect(() => guard.assertPathAllowed(join(dataDir, 'sessions', '2026.md'))).not.toThrow();
  });

  it('黑名单对额外目录内敏感文件仍生效', () => {
    const extra = mkdtempSync(join(tmpdir(), 'memora-extra-'));
    guard.setAllowedPaths([extra]);
    // 额外目录内若含 .env，仍应被黑名单拦截（白名单非绕过黑名单的通行证）
    expect(() => guard.assertPathAllowed(join(extra, '.env'))).toThrow(/黑名单/);
  });

  it('setAllowedPaths 非字符串元素应 fail-closed 抛错', () => {
    expect(() => guard.setAllowedPaths([123 as unknown as string])).toThrow(/字符串/);
  });
});

describe('SecurityGuard · 审计日志', () => {
  let projectPath: string;
  let dataDir: string;

  beforeEach(() => {
    projectPath = mkdtempSync(join(tmpdir(), 'memora-audit-'));
    dataDir = mkdtempSync(join(tmpdir(), 'memora-data-'));
  });

  it('应该为允许的路径生成 path-allow 审计事件', () => {
    const guard = new SecurityGuard(projectPath, dataDir, []);
    const audits = collectAudits(guard);
    const filePath = join(projectPath, 'src/index.ts');
    guard.assertPathAllowed(filePath, 'read_file');

    expect(audits.length).toBeGreaterThan(0);
    const last = audits[audits.length - 1]!;
    expect(last.type).toBe('path-allow');
    expect(last.tool).toBe('read_file');
  });

  it('应该为拒绝的路径生成 path-deny 审计事件', () => {
    const guard = new SecurityGuard(projectPath, dataDir, []);
    const audits = collectAudits(guard);
    const filePath = join(projectPath, '.ssh/id_rsa');
    expect(() => guard.assertPathAllowed(filePath, 'read_file')).toThrow();

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

describe('SecurityGuard · 写入二次确认', () => {
  let projectPath: string;
  let dataDir: string;

  beforeEach(() => {
    projectPath = mkdtempSync(join(tmpdir(), 'memora-confirm-'));
    dataDir = mkdtempSync(join(tmpdir(), 'memora-data-'));
  });

  it('owner + confirmWrites=false 应该自动批准（不读取 stdin）', async () => {
    const guard = new SecurityGuard(projectPath, dataDir, [], false, 'owner');
    const audits = collectAudits(guard);
    const ok = await guard.requestWriteConfirmation(join(projectPath, 'out.txt'), 'write_file');
    expect(ok).toBe(true);

    const last = audits[audits.length - 1]!;
    expect(last.type).toBe('write-auto');
    expect(last.decision).toBe('auto-approved');
  });

  it('owner + confirmWrites=true + 未注入 handler 应 fail-closed 拒绝', async () => {
    // 未注入 confirmationHandler 时直接拒绝写入
    const guard = new SecurityGuard(projectPath, dataDir, [], true, 'owner');
    const audits = collectAudits(guard);
    const ok = await guard.requestWriteConfirmation(join(projectPath, 'out.txt'), 'write_file');
    expect(ok).toBe(false);

    // 审计应记录拒绝事件，reason 标注 fail-closed
    const last = audits[audits.length - 1]!;
    expect(last.type).toBe('write-decline');
    expect(last.decision).toBe('declined');
    expect(last.reason).toContain('fail-closed');
  });

  it('guest 模式 + 未注入 handler 应 fail-closed 拒绝', async () => {
    // guest 强制需要确认，未注入 handler 时同样 fail-closed
    const guard = new SecurityGuard(projectPath, dataDir, [], false, 'guest');
    expect(guard.permission).toBe('guest');
    const audits = collectAudits(guard);
    const ok = await guard.requestWriteConfirmation(join(projectPath, 'out.txt'), 'write_file');
    expect(ok).toBe(false);

    const last = audits[audits.length - 1]!;
    expect(last.type).toBe('write-decline');
    expect(last.decision).toBe('declined');
  });

  it('owner + confirmWrites=false 不受 fail-closed 影响（自动批准）', async () => {
    // 无需确认路径不依赖 confirmationHandler，fail-closed 不应误伤
    const guard = new SecurityGuard(projectPath, dataDir, [], false, 'owner');
    const ok = await guard.requestWriteConfirmation(join(projectPath, 'out.txt'), 'write_file');
    expect(ok).toBe(true);
  });

  // ─── beforeContent/afterContent diff 透传 ──────────

  it('onWriteConfirmation 回调应接收 beforeContent/afterContent', async () => {
    const guard = new SecurityGuard(projectPath, dataDir, [], true, 'owner');
    const received: WriteConfirmationInfo[] = [];
    guard.onWriteConfirmation(async (info) => {
      received.push(info);
      return true;
    });
    await guard.requestWriteConfirmation(
      join(projectPath, 'out.txt'),
      'write_file',
      '测试描述',
      { beforeContent: '旧内容', afterContent: '新内容' },
    );
    expect(received).toHaveLength(1);
    expect(received[0]!.beforeContent).toBe('旧内容');
    expect(received[0]!.afterContent).toBe('新内容');
  });

  it('beforeContent=null 时回调应接收 null（新文件语义）', async () => {
    const guard = new SecurityGuard(projectPath, dataDir, [], true, 'owner');
    const received: WriteConfirmationInfo[] = [];
    guard.onWriteConfirmation(async (info) => {
      received.push(info);
      return true;
    });
    await guard.requestWriteConfirmation(
      join(projectPath, 'new.txt'),
      'write_file',
      undefined,
      { beforeContent: null, afterContent: '新文件内容' },
    );
    expect(received[0]!.beforeContent).toBeNull();
    expect(received[0]!.afterContent).toBe('新文件内容');
  });

  it('超大内容应被截断到 10KB 并追加截断标记', async () => {
    const guard = new SecurityGuard(projectPath, dataDir, [], true, 'owner');
    const received: WriteConfirmationInfo[] = [];
    guard.onWriteConfirmation(async (info) => {
      received.push(info);
      return true;
    });
    // 构造 20KB 内容（超过 10KB 上限）
    const bigContent = 'A'.repeat(20_000);
    await guard.requestWriteConfirmation(
      join(projectPath, 'big.txt'),
      'write_file',
      undefined,
      { beforeContent: bigContent, afterContent: bigContent },
    );
    const before = received[0]!.beforeContent!;
    const after = received[0]!.afterContent!;
    // 截断后应小于原始 20KB
    expect(before.length).toBeLessThan(bigContent.length);
    expect(after.length).toBeLessThan(bigContent.length);
    // 应包含截断标记
    expect(before).toContain('已截断');
    expect(after).toContain('已截断');
    expect(before).toContain('20000');
  });

  it('未传 options 时 beforeContent/afterContent 应为 undefined', async () => {
    const guard = new SecurityGuard(projectPath, dataDir, [], true, 'owner');
    const received: WriteConfirmationInfo[] = [];
    guard.onWriteConfirmation(async (info) => {
      received.push(info);
      return true;
    });
    await guard.requestWriteConfirmation(
      join(projectPath, 'out.txt'),
      'write_file',
      '描述',
    );
    expect(received[0]!.beforeContent).toBeUndefined();
    expect(received[0]!.afterContent).toBeUndefined();
  });
});

describe('SecurityGuard · 脚本执行确认（confirmScriptRun，P1① 补锁）', () => {
  let projectPath: string;
  let dataDir: string;

  beforeEach(() => {
    projectPath = mkdtempSync(join(tmpdir(), 'memora-script-confirm-'));
    dataDir = mkdtempSync(join(tmpdir(), 'memora-script-data-'));
  });

  it('owner + confirmScripts=false 应该自动批准（审计 write-auto）', async () => {
    // 默认不弹窗：脚本执行自动放行，审计仍记录
    const guard = new SecurityGuard(projectPath, dataDir, [], false, 'owner');
    const audits = collectAudits(guard);
    const ok = await guard.confirmScriptRun(join(projectPath, 'scripts', 'test.py'), 'run_project_script');
    expect(ok).toBe(true);

    const last = audits[audits.length - 1]!;
    expect(last.type).toBe('write-auto');
    expect(last.decision).toBe('auto-approved');
  });

  it('owner + confirmScripts=true + 未注入 handler 应 fail-closed 拒绝', async () => {
    // confirmScripts 打开但宿主没接确认 UI → 拒绝（安全优先，审计标注 fail-closed）
    const guard = new SecurityGuard(projectPath, dataDir, [], false, 'owner', true);
    const audits = collectAudits(guard);
    const ok = await guard.confirmScriptRun(join(projectPath, 'scripts', 'test.py'), 'run_project_script');
    expect(ok).toBe(false);

    const last = audits[audits.length - 1]!;
    expect(last.type).toBe('write-decline');
    expect(last.decision).toBe('declined');
    expect(last.reason).toContain('fail-closed');
  });

  it('guest 模式（confirmScripts 默认 false 也强制确认）应 fail-closed 拒绝', async () => {
    // guest 对脚本执行同样强制确认，且独立于 confirmScripts 开关
    const guard = new SecurityGuard(projectPath, dataDir, [], false, 'guest');
    const ok = await guard.confirmScriptRun(join(projectPath, 'scripts', 'test.py'), 'run_project_script');
    expect(ok).toBe(false);
  });

  it('confirmScripts=true + 注入 handler 返回 true 应确认放行', async () => {
    const guard = new SecurityGuard(projectPath, dataDir, [], false, 'owner', true);
    const audits = collectAudits(guard);
    guard.onWriteConfirmation(async (info) => {
      expect(info.tool).toBe('run_project_script');
      expect(info.needsConfirm).toBe(true);
      expect(info.targetPath).toContain('test.py');
      return true;
    });
    const ok = await guard.confirmScriptRun(join(projectPath, 'scripts', 'test.py'), 'run_project_script', '运行项目脚本 scripts/test.py');
    expect(ok).toBe(true);

    const last = audits[audits.length - 1]!;
    expect(last.type).toBe('write-confirm');
    expect(last.decision).toBe('confirmed');
  });

  it('判据独立：confirmScripts 不影响写入确认（confirmWrites 仍为 false 时写自动批准）', async () => {
    // SSOT 收口验证：confirmGate 两入口判据互不串扰——开脚本确认不拖累写确认
    const guard = new SecurityGuard(projectPath, dataDir, [], false, 'owner', true);
    const scriptConfirmed = await guard.confirmScriptRun(join(projectPath, 'scripts', 'run.sh'), 'run_project_script');
    expect(scriptConfirmed).toBe(false); // 脚本需确认但无 handler → 拒绝

    const writeOk = await guard.requestWriteConfirmation(join(projectPath, 'out.txt'), 'write_file');
    expect(writeOk).toBe(true); // 写入判据独立：confirmWrites=false → 仍自动批准
  });
});
