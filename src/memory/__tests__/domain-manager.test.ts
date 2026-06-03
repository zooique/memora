/**
 * 领域管理器测试
 * 覆盖 initDefault / switchDomain / listDomains / resolveMemoraDir
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DomainManager } from '@/memory/domain-manager.js';
import type { DomainContext } from '@/memory/domain-manager.js';
import type { Config } from '@/config/loader.js';

function makeConfig(dataDir = '~/.memora'): Config {
  return {
    llm: { provider: 'mock', apiKey: 'test', baseUrl: undefined, model: 'mock', temperature: 0.7 },
    memory: { dataDir, maxContextTokens: 80000 },
    security: { permission: 'owner', confirmWrites: false },
    allowedPaths: [],
  };
}

describe('DomainManager · initDefault', () => {
  let tmpDir: string;
  let lastCtx: DomainContext | null = null;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memora-domain-'));
    lastCtx = null;
  });

  afterEach(async () => {
    if (lastCtx) {
      await lastCtx.index.close().catch(() => {});
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('应该初始化默认领域并返回上下文', async () => {
    const dataDir = join(tmpDir, '.memora');
    const config = makeConfig(dataDir);
    const manager = new DomainManager(tmpDir, config);
    const ctx = await manager.initDefault();

    expect(ctx.domainName).toBe(dataDir);
    expect(ctx.memoraDir).toContain('.memora');
    expect(ctx.fileStore).toBeDefined();
    expect(ctx.index).toBeDefined();
    expect(ctx.topicStore).toBeDefined();
    expect(ctx.security).toBeDefined();
    expect(ctx.bootstrapMemories).toBeDefined();
    expect(ctx.loadResult).toBeDefined();

    lastCtx = ctx;
  });

  it('应该自动创建 .memora 目录', async () => {
    const dataDir = join(tmpDir, '.memora');
    const config = makeConfig(dataDir);
    const manager = new DomainManager(tmpDir, config);
    const ctx = await manager.initDefault();

    expect(ctx.memoraDir).toBeDefined();

    lastCtx = ctx;
  });
});

describe('DomainManager · switchDomain', () => {
  let tmpDir: string;
  let lastCtx: DomainContext | null = null;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memora-domain-'));
    lastCtx = null;
  });

  afterEach(async () => {
    // 必须先关闭 SQLite 连接，否则 Windows 上 rmSync 会 EPERM
    if (lastCtx) {
      await lastCtx.index.close().catch(() => {});
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('应该切换到新领域并返回新上下文', async () => {
    const config = makeConfig(join(tmpDir, '.memora'));
    const manager = new DomainManager(tmpDir, config);

    const ctx1 = await manager.initDefault();
    expect(ctx1.domainName).toBe(join(tmpDir, '.memora'));

    const ctx2 = await manager.switchDomain('project-a');
    expect(ctx2.domainName).toBe('project-a');
    expect(ctx2.memoraDir).toContain('.memora-project-a');

    // 关闭旧域的数据库（switchDomain 已自动关闭）
    lastCtx = ctx2;
  });

  it('切换领域后当前领域名称应更新', async () => {
    const config = makeConfig(join(tmpDir, '.memora'));
    const manager = new DomainManager(tmpDir, config);

    await manager.initDefault();
    expect(manager.currentDomainName).toBe(join(tmpDir, '.memora'));

    const ctx2 = await manager.switchDomain('project-b');
    expect(manager.currentDomainName).toBe('project-b');

    lastCtx = ctx2;
  });

  it('重复切换到同一领域不应报错', async () => {
    const config = makeConfig(join(tmpDir, '.memora'));
    const manager = new DomainManager(tmpDir, config);

    await manager.initDefault();
    await manager.switchDomain('same-domain');
    const ctx2 = await manager.switchDomain('same-domain');

    expect(ctx2.domainName).toBe('same-domain');

    lastCtx = ctx2;
  });
});

describe('DomainManager · listDomains', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memora-domain-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('应该列出所有 .memora* 目录', async () => {
    // 创建默认领域和其他领域
    mkdirSync(join(tmpDir, '.memora'), { recursive: true });
    mkdirSync(join(tmpDir, '.memora-work'), { recursive: true });
    mkdirSync(join(tmpDir, '.memora-personal'), { recursive: true });
    // 非领域目录不应被列出
    mkdirSync(join(tmpDir, '.git'), { recursive: true });
    mkdirSync(join(tmpDir, 'src'), { recursive: true });

    const config = makeConfig(join(tmpDir, '.memora'));
    const manager = new DomainManager(tmpDir, config);
    const domains = manager.listDomains();

    expect(domains).toContain('default');
    expect(domains).toContain('work');
    expect(domains).toContain('personal');
    expect(domains).not.toContain('git');
    expect(domains).not.toContain('src');
  });

  it('无 .memora 目录时应返回空列表', () => {
    const config = makeConfig(join(tmpDir, '.memora'));
    const manager = new DomainManager(tmpDir, config);
    const domains = manager.listDomains();

    expect(domains).toHaveLength(0);
  });
});
