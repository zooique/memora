/**
 * 项目管理器测试
 * 覆盖 initProject / closeProject / listProjects / registerProject / 锁文件
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectManager } from '@/memory/project-manager.js';
import type { Config } from '@/config/loader.js';

function makeConfig(dataDir?: string): Config {
  return {
    llm: { provider: 'mock', apiKey: 'test', baseUrl: undefined, model: 'mock', temperature: 0.7 },
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
    const pm = new ProjectManager(config.memory.dataDir);
    const ctx = await pm.initProject(tmpDir);

    expect(ctx.projectPath).toBe(tmpDir);
    expect(ctx.projectName).toBeDefined();
    expect(ctx.memoraDir).toBe(join(tmpDir, '.memora'));
    expect(ctx.fileStore).toBeDefined();
    expect(ctx.index).toBeDefined();
    // TopicStore 已移除（基元驱动模型）
    expect(ctx.security).toBeDefined();
    expect(ctx.bootstrapMemories).toBeDefined();
    expect(ctx.loadResult).toBeDefined();

    await pm.shutdown();
  });

  it('应该自动创建 .memora 目录', async () => {
    const config = makeConfig(join(tmpHome, '.memora'));
    const pm = new ProjectManager(config.memory.dataDir);
    const ctx = await pm.initProject(tmpDir);

    expect(existsSync(ctx.memoraDir)).toBe(true);

    await pm.shutdown();
  });

  it('应该创建锁文件', async () => {
    const config = makeConfig(join(tmpHome, '.memora'));
    const pm = new ProjectManager(config.memory.dataDir);
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
    const pm = new ProjectManager(config.memory.dataDir);
    await pm.initProject(tmpDir);
    await pm.shutdown();

    const lockPath = join(tmpDir, '.memora', '.lock');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('应该注册项目到注册表', async () => {
    const config = makeConfig(join(tmpHome, '.memora'));
    const pm = new ProjectManager(config.memory.dataDir);
    await pm.initProject(tmpDir, 'test-project');

    const projects = pm.listProjects();
    const found = projects.find((p) => p.path === tmpDir);
    expect(found).toBeDefined();
    expect(found?.name).toBe('test-project');

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
    const pm = new ProjectManager(config.memory.dataDir);

    pm.registerProject('/path/to/project-a', 'project-a');
    pm.registerProject('/path/to/project-b', 'project-b');

    const projects = pm.listProjects();
    expect(projects).toHaveLength(2);
    expect(projects.find((p) => p.name === 'project-a')).toBeDefined();
    expect(projects.find((p) => p.name === 'project-b')).toBeDefined();
  });

  it('注册相同路径应更新而非重复', async () => {
    const config = makeConfig(join(tmpHome, '.memora'));
    const pm = new ProjectManager(config.memory.dataDir);

    pm.registerProject('/path/to/project-a', 'project-a');
    pm.registerProject('/path/to/project-a', 'project-a-renamed');

    const projects = pm.listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]!.name).toBe('project-a-renamed');
  });

  it('应该从注册表移除项目', async () => {
    const config = makeConfig(join(tmpHome, '.memora'));
    const pm = new ProjectManager(config.memory.dataDir);

    pm.registerProject('/path/to/project-a', 'project-a');
    pm.registerProject('/path/to/project-b', 'project-b');
    pm.unregisterProject('/path/to/project-a');

    const projects = pm.listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]!.name).toBe('project-b');
  });

  it('注册表 JSON 损坏时应降级为空列表', async () => {
    const config = makeConfig(join(tmpHome, '.memora'));
    // 写入损坏的 JSON
    writeFileSync(join(tmpHome, '.memora', 'projects.json'), 'not valid{{{', 'utf-8');

    const pm = new ProjectManager(config.memory.dataDir);
    const projects = pm.listProjects();
    // 应降级为返回空列表
    expect(projects).toHaveLength(0);

    // 注册后应能正常工作
    pm.registerProject('/path/to/project-a', 'project-a');
    expect(pm.listProjects()).toHaveLength(1);
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
    const pm = new ProjectManager(config.memory.dataDir);

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
    const pm = new ProjectManager(config.memory.dataDir);
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
    const pm = new ProjectManager(config.memory.dataDir);
    const ctx = await pm.initProject(tmpDir);

    // 应该能正常启动
    expect(ctx.projectPath).toBe(tmpDir);

    await pm.shutdown();
  });
});
