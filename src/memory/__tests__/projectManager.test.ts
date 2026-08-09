/**
 * 项目管理器测试
 * 覆盖 initProject / closeProject / listProjects / registerProject / 锁文件
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectManager } from '@/memory/projectManager.js';
import { InMemoryStorage } from '@/memory/inMemoryStorage.js';
import { SecurityGuard } from '@/security/pathGuard.js';
import { SOURCE_LABELS } from '@/memory/types.js';
import type { Config } from '@/config/loader.js';

function makeConfig(dataDir?: string): Config {
  return {
    llm: { provider: 'mock', apiKey: 'test', baseUrl: 'https://mock.local', model: 'mock', temperature: 0.7 },
    memory: { dataDir: dataDir || join(tmpdir(), 'memora-pm-test'), maxContextTokens: 80000 },
    security: { permission: 'owner', confirmWrites: false },
    allowedPaths: [],
  };
}

describe('ProjectManager · initProject', () => {
  let tmpDir: string;
  let tmpHome: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memora-pm-'));
    tmpHome = mkdtempSync(join(tmpdir(), 'memora-pm-home-'));
    mkdirSync(join(tmpHome, '.memora'), { recursive: true });
  });

  afterEach(async () => {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('应该初始化项目并返回上下文', async () => {
    const config = makeConfig(join(tmpHome, '.memora'));
    const pm = new ProjectManager({
      dataDir: config.memory.dataDir,
      // 注入 SecurityGuard 工厂函数
      createSecurityGuard: (projectPath, memoraDir) =>
        new SecurityGuard(projectPath, memoraDir, [], false, 'owner'),
    });
    const ctx = await pm.initProject(tmpDir);

    expect(ctx.projectPath).toBe(tmpDir);
    expect(ctx.projectName).toBeDefined();
    expect(ctx.memoraDir).toBe(join(tmpDir, '.memora'));
    expect(ctx.fileStore).toBeDefined();
    expect(ctx.index).toBeDefined();
    expect(ctx.security).toBeDefined();
    expect(ctx.bootstrapMemories).toBeDefined();
    expect(ctx.loadResult).toBeDefined();

    await pm.shutdown();
  });

  it('应该自动创建 .memora 目录', async () => {
    const config = makeConfig(join(tmpHome, '.memora'));
    const pm = new ProjectManager({ dataDir: config.memory.dataDir });
    const ctx = await pm.initProject(tmpDir);

    expect(existsSync(ctx.memoraDir)).toBe(true);

    await pm.shutdown();
  });

  it('应该创建锁文件', async () => {
    const config = makeConfig(join(tmpHome, '.memora'));
    const pm = new ProjectManager({ dataDir: config.memory.dataDir });
    await pm.initProject(tmpDir);

    const lockPath = join(tmpDir, '.memora', '.lock');
    expect(existsSync(lockPath)).toBe(true);

    // 锁文件应包含 PID
    const lockContent = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(lockContent.pid).toBe(process.pid);

    await pm.shutdown();
  });

  it('关闭项目后应删除锁文件', async () => {
    const config = makeConfig(join(tmpHome, '.memora'));
    const pm = new ProjectManager({ dataDir: config.memory.dataDir });
    await pm.initProject(tmpDir);
    await pm.shutdown();

    const lockPath = join(tmpDir, '.memora', '.lock');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('应该注册项目到注册表', async () => {
    const config = makeConfig(join(tmpHome, '.memora'));
    const pm = new ProjectManager({ dataDir: config.memory.dataDir });
    await pm.initProject(tmpDir, 'test-project');

    const projects = pm.listProjects();
    const found = projects.find((p) => p.path === tmpDir);
    expect(found).toBeDefined();
    expect(found?.name).toBe('test-project');

    await pm.shutdown();
  });

  it('T6 对账：无文件支撑的孤儿 rule 在重开项目时被清理，文件规则保留', async () => {
    const config = makeConfig(join(tmpHome, '.memora'));
    const pm = new ProjectManager({
      dataDir: config.memory.dataDir,
      createSecurityGuard: (projectPath, memoraDir) =>
        new SecurityGuard(projectPath, memoraDir, [], false, 'owner'),
    });
    const ctx = await pm.initProject(tmpDir);

    // 模拟历史遗留：索引中有活跃的孤儿 rule（文件不存在）
    const now = new Date().toISOString();
    ctx.index.upsert({
      id: 'rule:orphan',
      content: '孤儿规则',
      source: SOURCE_LABELS.RULE,
      name: 'orphan',
      createdAt: now,
      accessedAt: now,
      score: 0.8,
    });

    // 同时写入一个真实 rule 文件（对账后必须保留）
    mkdirSync(join(tmpDir, '.memora', 'rules'), { recursive: true });
    writeFileSync(
      join(tmpDir, '.memora', 'rules', 'real.md'),
      '---\nid: rule:real\nsource: rule\nname: real\nscore: 0.8\n---\n\n真实规则',
      'utf-8',
    );

    // 重开项目：重新触发 loadAllResources → 对账清理孤儿
    const ctx2 = await pm.initProject(tmpDir);
    const rules = ctx2.index.getBySource(SOURCE_LABELS.RULE);
    const names = rules.map((r) => r.name);

    // 修复前（无对账）：orphan 残留 → 断言红
    expect(names).not.toContain('orphan');
    // 文件规则必须保留（防过度修复）
    expect(names).toContain('real');

    await pm.shutdown();
  });

  it('T13：closeProject 撤销项目级记忆时应同步清理关系边', async () => {
    const removeRelations = vi.fn();
    const config = makeConfig(join(tmpHome, '.memora'));
    const pm = new ProjectManager({
      dataDir: config.memory.dataDir,
      createSecurityGuard: (projectPath, memoraDir) =>
        new SecurityGuard(projectPath, memoraDir, [], false, 'owner'),
      removeRelationsByMemoryId: removeRelations,
    });
    await pm.initProject(tmpDir);

    // 写入项目级规则文件，使其进入 currentProjectMemoryIds
    mkdirSync(join(tmpDir, '.memora', 'rules'), { recursive: true });
    writeFileSync(
      join(tmpDir, '.memora', 'rules', 'proj-rule.md'),
      '---\nid: rule:proj-rule\nsource: rule\nname: proj-rule\nscore: 0.8\n---\n\n项目规则',
      'utf-8',
    );
    await pm.initProject(tmpDir);

    await pm.closeProject();

    // 修复前（仅 delete 主记忆）：回调未被调 → 断言红
    // （项目级 rule 被 insight 引用为关系对端时，索引删除不会级联清边 → 悬挂边）
    expect(removeRelations).toHaveBeenCalledWith('rule:proj-rule');
    await pm.shutdown();
  });
});

describe('ProjectManager · 项目注册表', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'memora-pm-reg-'));
    mkdirSync(join(tmpHome, '.memora'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('应该读写项目注册表', async () => {
    const config = makeConfig(join(tmpHome, '.memora'));
    const pm = new ProjectManager({ dataDir: config.memory.dataDir });

    pm.registerProject('/path/to/project-a', 'project-a');
    pm.registerProject('/path/to/project-b', 'project-b');

    const projects = pm.listProjects();
    expect(projects).toHaveLength(2);
    expect(projects.find((p) => p.name === 'project-a')).toBeDefined();
    expect(projects.find((p) => p.name === 'project-b')).toBeDefined();
  });

  it('注册相同路径应更新而非重复', async () => {
    const config = makeConfig(join(tmpHome, '.memora'));
    const pm = new ProjectManager({ dataDir: config.memory.dataDir });

    pm.registerProject('/path/to/project-a', 'project-a');
    pm.registerProject('/path/to/project-a', 'project-a-renamed');

    const projects = pm.listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]!.name).toBe('project-a-renamed');
  });

  it('应该从注册表移除项目', async () => {
    const config = makeConfig(join(tmpHome, '.memora'));
    const pm = new ProjectManager({ dataDir: config.memory.dataDir });

    pm.registerProject('/path/to/project-a', 'project-a');
    pm.registerProject('/path/to/project-b', 'project-b');
    pm.unregisterProject('/path/to/project-a');

    const projects = pm.listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]!.name).toBe('project-b');
  });

  it('FIX-P0-3：注册表 JSON 损坏时 list 降级为空列表，但 register 抛错避免覆盖', async () => {
    const config = makeConfig(join(tmpHome, '.memora'));
    // 写入损坏的 JSON
    writeFileSync(join(tmpHome, '.memora', 'projects.json'), 'not valid{{{', 'utf-8');

    const pm = new ProjectManager({ dataDir: config.memory.dataDir });
    // list 是只读操作，损坏时降级返回空列表（不破坏磁盘数据）
    const projects = pm.listProjects();
    expect(projects).toHaveLength(0);

    // FIX-P0-3：register 路径必须抛错，避免用空数据覆盖损坏文件导致数据永久丢失
    expect(() => pm.registerProject('/path/to/project-a', 'project-a')).toThrow(
      /项目注册表损坏/,
    );
    // 损坏文件应仍保留原内容（未被空数据覆盖）
    const rawContent = readFileSync(join(tmpHome, '.memora', 'projects.json'), 'utf-8');
    expect(rawContent).toBe('not valid{{{');
  });
});

describe('ProjectManager · 项目切换', () => {
  let tmpDir1: string;
  let tmpDir2: string;
  let tmpHome: string;

  beforeEach(() => {
    tmpDir1 = mkdtempSync(join(tmpdir(), 'memora-pm-switch1-'));
    tmpDir2 = mkdtempSync(join(tmpdir(), 'memora-pm-switch2-'));
    tmpHome = mkdtempSync(join(tmpdir(), 'memora-pm-home-'));
    mkdirSync(join(tmpHome, '.memora'), { recursive: true });
  });

  afterEach(async () => {
    rmSync(tmpDir1, { recursive: true, force: true });
    rmSync(tmpDir2, { recursive: true, force: true });
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('应该能切换到不同项目', async () => {
    const config = makeConfig(join(tmpHome, '.memora'));
    const pm = new ProjectManager({ dataDir: config.memory.dataDir });

    const ctx1 = await pm.initProject(tmpDir1, 'project-1');
    expect(ctx1.projectPath).toBe(tmpDir1);
    expect(ctx1.projectName).toBe('project-1');

    // 切换到第二个项目（initProject 会自动关闭旧项目）
    const ctx2 = await pm.initProject(tmpDir2, 'project-2');
    expect(ctx2.projectPath).toBe(tmpDir2);
    expect(ctx2.projectName).toBe('project-2');

    // 旧项目的锁文件应被释放
    expect(existsSync(join(tmpDir1, '.memora', '.lock'))).toBe(false);
    // 新项目的锁文件应存在
    expect(existsSync(join(tmpDir2, '.memora', '.lock'))).toBe(true);

    await pm.shutdown();
  });
});

describe('ProjectManager · 锁文件安全', () => {
  let tmpDir: string;
  let tmpHome: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memora-pm-lock-'));
    tmpHome = mkdtempSync(join(tmpdir(), 'memora-pm-home-'));
    mkdirSync(join(tmpHome, '.memora'), { recursive: true });
  });

  afterEach(async () => {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('残留锁文件（进程已死）应被自动清理', async () => {
    const memoraDir = join(tmpDir, '.memora');
    mkdirSync(memoraDir, { recursive: true });

    // 写入一个不存在的 PID 的锁文件
    const fakeLock = { pid: 99999999, acquiredAt: new Date().toISOString(), hostname: 'test' };
    writeFileSync(join(memoraDir, '.lock'), JSON.stringify(fakeLock), 'utf-8');

    const config = makeConfig(join(tmpHome, '.memora'));
    const pm = new ProjectManager({ dataDir: config.memory.dataDir });
    // initProject 应该能清理残留锁并正常启动
    await pm.initProject(tmpDir);

    // 新锁文件应包含当前进程 PID
    const lockContent = JSON.parse(readFileSync(join(memoraDir, '.lock'), 'utf-8'));
    expect(lockContent.pid).toBe(process.pid);

    await pm.shutdown();
  });

  it('损坏的锁文件应被清理', async () => {
    const memoraDir = join(tmpDir, '.memora');
    mkdirSync(memoraDir, { recursive: true });

    // 写入损坏的锁文件
    writeFileSync(join(memoraDir, '.lock'), 'not valid json{{{', 'utf-8');

    const config = makeConfig(join(tmpHome, '.memora'));
    const pm = new ProjectManager({ dataDir: config.memory.dataDir });
    const ctx = await pm.initProject(tmpDir);

    // 应该能正常启动
    expect(ctx.projectPath).toBe(tmpDir);

    await pm.shutdown();
  });
});

describe('ProjectManager · closeProject 撤销项目记忆 (S2)', () => {
  let tmpDir: string;
  let tmpHome: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memora-pm-s2-'));
    tmpHome = mkdtempSync(join(tmpdir(), 'memora-pm-s2-home-'));
    mkdirSync(join(tmpHome, '.memora'), { recursive: true });
  });

  afterEach(async () => {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(tmpHome, { recursive: true, force: true });
  });

  /**
   * 在 tmpDir/.memora/rules/ 下写入一条项目级规则记忆文件
   */
  const seedProjectRule = (): void => {
    const memoraDir = join(tmpDir, '.memora');
    mkdirSync(join(memoraDir, 'rules'), { recursive: true });
    writeFileSync(
      join(memoraDir, 'rules', 'proj-rule.md'),
      `---
id: rule:proj-rule
source: rule
name: proj-rule
score: 1.0
createdAt: 2026-01-01T00:00:00.000Z
accessedAt: 2026-01-01T00:00:00.000Z
---

# 项目专属规则
仅本项目生效，切换项目后不应泄漏。`,
      'utf-8',
    );
  };

  it('关闭项目应撤销本项目级记忆，防止跨项目泄漏', async () => {
    seedProjectRule();

    // 注入共享 Agent 级存储（InMemoryStorage），initProject 会把项目记忆加载进它
    const storage = new InMemoryStorage();
    const pm = new ProjectManager({
      dataDir: join(tmpHome, '.memora'),
      storage,
    });
    const ctx = await pm.initProject(tmpDir);

    // 项目记忆已加载进共享 index
    expect(ctx.index.getById('rule:proj-rule')).not.toBeNull();
    expect(ctx.index.getBySource(SOURCE_LABELS.RULE).length).toBeGreaterThanOrEqual(1);

    // S2 修复：关闭项目（不关闭 Agent 级 DB）应撤销本项目级记忆，
    // 否则切换项目后旧项目规则仍注入新项目 system prompt 与召回结果（跨项目泄漏）。
    await pm.closeProject();

    expect(ctx.index.getById('rule:proj-rule')).toBeNull();
    expect(ctx.index.getBySource(SOURCE_LABELS.RULE).length).toBe(0);
  });

  it('重新打开同一项目应从磁盘重新加载恢复项目记忆', async () => {
    seedProjectRule();

    const storage = new InMemoryStorage();
    const pm = new ProjectManager({
      dataDir: join(tmpHome, '.memora'),
      storage,
    });

    const ctx = await pm.initProject(tmpDir);
    expect(ctx.index.getById('rule:proj-rule')).not.toBeNull();

    // 关闭（软删除，文件本体仍在磁盘）
    await pm.closeProject();
    expect(ctx.index.getById('rule:proj-rule')).toBeNull();

    // 重新打开同一项目：文件仍在，应重新 upsert 恢复
    const ctx2 = await pm.initProject(tmpDir);
    expect(ctx2.index.getById('rule:proj-rule')).not.toBeNull();
  });
});
