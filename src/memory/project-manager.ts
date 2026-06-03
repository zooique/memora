/**
 * 项目管理器 — M-207 多项目并发
 *
 * 核心职责：
 *   - 管理项目注册表（~/.memora/projects.json）
 *   - 锁文件机制（.memora/.lock）防止同项目并发写入导致数据损坏
 *   - 全局规则加载（~/.memora/global/rules/）跨项目共享只读规则
 *   - 项目切换（关闭旧项目 → 打开新项目）
 *
 * 设计原则（agent设计.md §9.9）：
 *   - 每个项目有独立的 SQLite 数据库文件，不存在锁竞争
 *   - 跨会话记忆共享的锁是项目级别的，不会误锁其他项目
 *   - 全局规则目录只读加载，无并发写入
 *
 * 锁文件策略：
 *   - 打开项目时创建 .lock 文件（含 PID + 时间戳 + 主机名）
 *   - 关闭/切换项目时删除 .lock 文件
 *   - 检测到残留锁时：判断进程是否存活 → 存活则警告 / 已死则清理
 *   - 不强制阻止并发（CLI-first，用户决定）
 *
 * 详见 ADR-008 · 目录结构按"职责分层"
 */
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { hostname } from 'node:os';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  readdirSync,
} from 'node:fs';
import { FileStore } from './store.js';
import { MemoryIndex } from './index.js';
import { MemoryLoader } from './loader.js';
import { TopicStore } from './topic-store.js';
import { DomainManager } from './domain-manager.js';
import { SecurityGuard } from '@/security/path-guard.js';
import { logger } from '@/logging/logger.js';
import type { Memory } from './types.js';
import type { Config } from '@/config/loader.js';

/**
 * 项目上下文：打开一个项目后产出的一组组件
 * 与 DomainContext 类似，但增加了项目级别的信息
 */
export interface ProjectContext {
  /** 项目根目录的绝对路径 */
  projectPath: string;
  /** 项目名称（从注册表读取，或取目录名） */
  projectName: string;
  /** .memora/ 目录的绝对路径 */
  memoraDir: string;
  /** 文件存储 */
  fileStore: FileStore;
  /** SQLite 索引 */
  index: MemoryIndex;
  /** 话题存储 */
  topicStore: TopicStore;
  /** 安全守卫 */
  security: SecurityGuard;
  /** 启动时加载的必召记忆（含全局规则） */
  bootstrapMemories: Memory[];
  /** 加载结果 */
  loadResult: { loaded: number; skipped: number; errors: Array<{ file: string; error: string }> };
  /** 全局规则记忆（从 ~/.memora/global/rules/ 加载） */
  globalMemories: Memory[];
  /** 领域管理器（用于后续 /domain 切换） */
  domainManager: DomainManager;
}

/**
 * 锁文件内容
 */
interface LockInfo {
  /** 持有锁的进程 PID */
  pid: number;
  /** 获取锁的时间 */
  acquiredAt: string;
  /** 主机名 */
  hostname: string;
}

/**
 * 项目注册表条目
 */
export interface ProjectEntry {
  /** 项目根目录的绝对路径 */
  path: string;
  /** 项目名称（用户自定义或目录名） */
  name: string;
  /** 最后打开时间 */
  lastOpened: string;
}

/**
 * 项目管理器
 *
 * 管理多项目的生命周期：
 * 1. 初始化当前项目（加锁 + 加载 + 全局规则合并）
 * 2. /project <name> 切换到新项目（解锁旧项目 + 加锁新项目）
 * 3. 退出时清理锁文件
 */
export class ProjectManager {
  /** 项目注册表路径 */
  private readonly registryPath: string;
  /** 全局规则目录 */
  private readonly globalRulesDir: string;
  /** 当前打开的项目路径 */
  private currentProjectPath: string | null = null;
  /** 当前持有的锁文件路径 */
  private currentLockPath: string | null = null;
  /** 当前项目的 SQLite 索引引用（用于关闭） */
  private currentIndex: MemoryIndex | null = null;

  constructor(private readonly config: Config) {
    const memoraHome = resolve(config.memory.dataDir.replace(/^~/, homedir()));
    this.registryPath = join(memoraHome, 'projects.json');
    this.globalRulesDir = join(memoraHome, 'global', 'rules');
  }

  /**
   * 初始化指定项目
   * 1. 获取锁文件
   * 2. 加载项目记忆
   * 3. 加载全局规则
   * 4. 返回项目上下文
   *
   * @param projectPath 项目根目录
   * @param projectName 项目名称（可选，默认取目录名）
   * @param configDir 配置目录（personality/rules/skills/tools），默认使用 memoraDir
   */
  async initProject(
    projectPath: string,
    projectName?: string,
    configDir?: string,
  ): Promise<ProjectContext> {
    // 如果已有打开的项目，先关闭
    if (this.currentProjectPath) {
      await this.closeProject();
    }

    const memoraDir = this.resolveMemoraDir(projectPath);

    // 获取锁文件
    this.acquireLock(memoraDir);
    this.currentProjectPath = projectPath;
    this.currentLockPath = join(memoraDir, '.lock');

    // 确保目录存在
    mkdirSync(memoraDir, { recursive: true });

    // 初始化组件
    const fileStore = new FileStore(memoraDir);
    const dbPath = join(memoraDir, 'memora.db');
    const index = new MemoryIndex(dbPath);
    this.currentIndex = index;

    // 加载记忆：如果提供了 configDir，使用独立的 FileStore 读取配置
    // 实现配置目录（agent-config/）与运行时数据目录（.memora/）分离
    const configFileStore = configDir ? new FileStore(configDir) : fileStore;
    const loader = new MemoryLoader(configFileStore, index);
    const { memories: bootstrapMemories, loadResult } = await loader.bootstrap();

    // 加载全局规则
    const globalMemories = this.loadGlobalRules();

    // 合并全局规则到必召记忆（全局规则追加到末尾，权重略低）
    const allBootstrap = [...bootstrapMemories, ...globalMemories];

    // 话题存储
    const topicStore = new TopicStore(memoraDir);

    // 安全守卫
    const security = new SecurityGuard(
      projectPath,
      memoraDir,
      this.config.allowedPaths,
      this.config.security.confirmWrites,
      this.config.security.permission,
    );

    // 领域管理器
    const domainManager = new DomainManager(projectPath, this.config);

    // 注册到项目表
    const name = projectName || this.inferProjectName(projectPath);
    this.registerProject(projectPath, name);

    logger.info(
      {
        projectPath,
        projectName: name,
        memoraDir,
        loaded: loadResult.loaded,
        bootstrapCount: allBootstrap.length,
        globalRulesCount: globalMemories.length,
      },
      '项目初始化完成',
    );

    return {
      projectPath,
      projectName: name,
      memoraDir,
      fileStore,
      index,
      topicStore,
      security,
      bootstrapMemories: allBootstrap,
      loadResult,
      globalMemories,
      domainManager,
    };
  }

  /**
   * 关闭当前项目
   * 1. 关闭 SQLite 连接
   * 2. 释放锁文件
   */
  async closeProject(): Promise<void> {
    if (this.currentIndex) {
      await this.currentIndex.close().catch((err) => logger.warn({ err }, '关闭项目数据库失败'));
      this.currentIndex = null;
    }

    this.releaseLock();
    this.currentProjectPath = null;
    this.currentLockPath = null;
  }

  /**
   * 列出已注册的项目
   */
  listProjects(): ProjectEntry[] {
    return this.readRegistry();
  }

  /**
   * 注册项目到注册表
   */
  registerProject(projectPath: string, name: string): void {
    const registry = this.readRegistry();
    const existing = registry.findIndex((e) => e.path === projectPath);

    const entry: ProjectEntry = {
      path: projectPath,
      name,
      lastOpened: new Date().toISOString(),
    };

    if (existing >= 0) {
      registry[existing] = entry;
    } else {
      registry.push(entry);
    }

    this.writeRegistry(registry);
  }

  /**
   * 从注册表移除项目
   */
  unregisterProject(projectPath: string): void {
    const registry = this.readRegistry();
    const filtered = registry.filter((e) => e.path !== projectPath);
    this.writeRegistry(filtered);
  }

  /**
   * 获取当前项目路径
   */
  get currentProject(): string | null {
    return this.currentProjectPath;
  }

  /**
   * 获取锁文件
   * 如果锁文件存在且进程存活，发出警告但不阻止
   * 如果锁文件存在但进程已死，清理残留锁
   */
  private acquireLock(memoraDir: string): void {
    const lockPath = join(memoraDir, '.lock');

    if (existsSync(lockPath)) {
      try {
        const raw = readFileSync(lockPath, 'utf-8');
        const info = JSON.parse(raw) as LockInfo;

        // 检查进程是否存活
        if (this.isProcessAlive(info.pid)) {
          logger.warn(
            { pid: info.pid, acquiredAt: info.acquiredAt, hostname: info.hostname },
            '项目已被其他进程打开（锁文件存在），继续操作可能导致数据冲突',
          );
        } else {
          // 残留锁，清理
          logger.info({ pid: info.pid }, '清理残留锁文件（进程已退出）');
          this.safeUnlink(lockPath);
        }
      } catch {
        // 锁文件损坏，清理
        this.safeUnlink(lockPath);
      }
    }

    // 写入新锁
    const lockInfo: LockInfo = {
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      hostname: hostname(),
    };

    mkdirSync(memoraDir, { recursive: true });
    writeFileSync(lockPath, JSON.stringify(lockInfo, null, 2), 'utf-8');
  }

  /**
   * 释放锁文件
   */
  private releaseLock(): void {
    if (this.currentLockPath) {
      this.safeUnlink(this.currentLockPath);
    }
  }

  /**
   * 安全删除文件（忽略不存在的错误）
   */
  private safeUnlink(filePath: string): void {
    try {
      unlinkSync(filePath);
    } catch {
      // 文件不存在或无法删除，忽略
    }
  }

  /**
   * 检查进程是否存活
   * Windows: tasklist /FI "PID eq <pid>"
   * POSIX: kill(pid, 0)
   */
  private isProcessAlive(pid: number): boolean {
    try {
      // 发送信号 0 检查进程是否存在（POSIX 兼容）
      // Windows 上 process.kill(pid, 0) 也会抛出错误如果进程不存在
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 加载全局规则
   * 从 ~/.memora/global/rules/ 读取所有 .md 文件
   * 全局规则是只读的，permanence = 'always'，weight = 0.9（略低于项目级规则）
   */
  private loadGlobalRules(): Memory[] {
    if (!existsSync(this.globalRulesDir)) {
      return [];
    }

    const memories: Memory[] = [];
    try {
      const files = readdirSync(this.globalRulesDir).filter((f) => f.endsWith('.md'));

      for (const file of files) {
        try {
          const filePath = join(this.globalRulesDir, file);
          const content = readFileSync(filePath, 'utf-8');
          const name = file.replace(/\.md$/, '');

          memories.push({
            id: `global:rule:${name}`,
            type: 'rule',
            permanence: 'always',
            name: `global:${name}`,
            content: content.trim(),
            tags: ['global'],
            weight: 0.9,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            filePath,
          });
        } catch (err) {
          logger.warn({ file, err }, '加载全局规则文件失败');
        }
      }
    } catch {
      // 目录不可读，返回空
    }

    if (memories.length > 0) {
      logger.info({ count: memories.length }, '加载全局规则');
    }

    return memories;
  }

  /**
   * 解析项目的 .memora/ 目录路径
   * 每个项目有独立的 .memora/ 目录（在项目根目录下）
   * 这与 config.memory.dataDir（用户级默认目录）不同
   */
  private resolveMemoraDir(projectPath: string): string {
    return resolve(projectPath, '.memora');
  }

  /**
   * 从项目路径推断项目名称
   * 取路径最后一段目录名
   */
  private inferProjectName(projectPath: string): string {
    const parts = projectPath.replace(/[/\\]+$/, '').split(/[/\\]/);
    return parts[parts.length - 1] || 'unnamed';
  }

  /**
   * 读取项目注册表
   */
  private readRegistry(): ProjectEntry[] {
    if (!existsSync(this.registryPath)) {
      return [];
    }

    try {
      const raw = readFileSync(this.registryPath, 'utf-8');
      return JSON.parse(raw) as ProjectEntry[];
    } catch {
      return [];
    }
  }

  /**
   * 写入项目注册表
   */
  private writeRegistry(entries: ProjectEntry[]): void {
    // 确保目录存在
    const dir = this.registryPath.replace(/[/\\][^/\\]+$/, '');
    mkdirSync(dir, { recursive: true });
    writeFileSync(this.registryPath, JSON.stringify(entries, null, 2), 'utf-8');
  }
}
