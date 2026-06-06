/**
 * 项目管理器 — M-207 多项目并发
 *
 * 核心职责：
 *   - 管理项目注册表（~/.memora/projects.json）
 *   - 锁文件机制（.memora/.lock）防止同项目并发写入导致数据损坏
 *   - Agent 级资源管理（memora.db + TopicStore 全局共享，不随项目切换重建）
 *   - 两层记忆加载：Agent 级（configDir）→ 项目级（projectPath/.memora/）
 *   - 全局规则加载（~/.memora/global/rules/）跨项目共享只读规则
 *   - 项目切换（只更新 projectPath + security + 重新加载项目 rules/skills）
 *
 * 设计原则（单 Agent 模型）：
 *   - memora.db 只有一个（Agent 级），所有项目共享同一记忆数据库
 *   - TopicStore 只有一个（Agent 级），对话历史跨项目持久化
 *   - 项目切换不重建数据库，只更新安全守卫 + 重新扫描项目规则
 *   - 项目级 .memora/ 仅存放 rules/ 和 skills/（无 memora.db、无 topics/）
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
import type { LoadResult } from './loader.js';
import { TopicStore } from './topic-store.js';
import { SecurityGuard } from '@/security/path-guard.js';
import { logger } from '@/logging/logger.js';
import { MemoryType, type Memory } from './types.js';

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
  /** Agent 级 memora.db 路径（全局共享，非项目级） */
  dbPath: string;
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
  loadResult: LoadResult;
  /** 全局规则记忆（从 ~/.memora/global/rules/ 加载） */
  globalMemories: Memory[];
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
  /** Agent 级数据目录（memora.db + topics/ 的父目录） */
  private readonly agentDataDir: string;
  /** 允许的路径白名单 */
  private readonly allowedPaths: string[];
  /** 写入确认 */
  private readonly confirmWrites: boolean;
  /** 安全权限 */
  private readonly permission: 'owner' | 'guest';
  /** Agent 级 SQLite 索引（全局共享，不随项目切换重建） */
  private agentIndex: MemoryIndex | null = null;
  /** Agent 级话题存储（全局共享，不随项目切换重建） */
  private agentTopicStore: TopicStore | null = null;
  /** 当前打开的项目路径 */
  private currentProjectPath: string | null = null;
  /** 当前持有的锁文件路径 */
  private currentLockPath: string | null = null;

  constructor(
    dataDir: string,
    allowedPaths: string[] = [],
    confirmWrites: boolean = false,
    permission: 'owner' | 'guest' = 'owner',
  ) {
    const memoraHome = resolve(dataDir.replace(/^~/, homedir()));
    this.agentDataDir = memoraHome;
    this.registryPath = join(memoraHome, 'projects.json');
    this.globalRulesDir = join(memoraHome, 'global', 'rules');
    this.allowedPaths = allowedPaths;
    this.confirmWrites = confirmWrites;
    this.permission = permission;
  }

  /**
   * 确保 Agent 级资源已初始化（memora.db + TopicStore）
   * 这些资源在整个 Agent 生命周期内共享，不随项目切换重建
   */
  private async ensureAgentResources(): Promise<{ index: MemoryIndex; topicStore: TopicStore }> {
    if (!this.agentIndex) {
      mkdirSync(this.agentDataDir, { recursive: true });
      const dbPath = join(this.agentDataDir, 'memora.db');
      this.agentIndex = new MemoryIndex(dbPath);
      this.agentTopicStore = new TopicStore(this.agentDataDir);
    }
    // agentTopicStore 与 agentIndex 同步设置，此处不可能为 null
    return { index: this.agentIndex, topicStore: this.agentTopicStore! };
  }

  /**
   * 初始化指定项目
   *
   * 两层记忆加载：
   *   1) 项目级：扫描 projectPath/.memora/rules/ + skills/
   *   2) Agent 级：扫描 configDir 下的所有配置（rules/skills/personas/tools）
   *   3) 全局规则：合并 ~/.memora/global/rules/
   *
   * memora.db 和 TopicStore 是 Agent 级共享资源，不随项目切换重建。
   *
   * @param projectPath 项目根目录
   * @param projectName 项目名称（可选，默认取目录名）
   * @param configDir Agent 级配置目录（personas/rules/skills/tools）
   */
  async initProject(
    projectPath: string,
    projectName?: string,
    configDir?: string,
  ): Promise<ProjectContext> {
    // 如果已有打开的项目，先关闭（释放旧项目锁，但不关 Agent 级 DB）
    if (this.currentProjectPath) {
      await this.closeProject();
    }

    const memoraDir = this.resolveMemoraDir(projectPath);

    // 获取锁文件（项目级锁，防止同项目并发）
    this.acquireLock(memoraDir);
    this.currentProjectPath = projectPath;
    this.currentLockPath = join(memoraDir, '.lock');

    // 确保项目 .memora/ 目录存在
    mkdirSync(memoraDir, { recursive: true });

    // Agent 级共享资源（memora.db 只有一个，TopicStore 只有一个）
    const { index, topicStore } = await this.ensureAgentResources();

    // 合并加载结果（两层扫描汇总）
    const loadResult: LoadResult = { loaded: 0, skipped: 0, errors: [] };

    // 1) 项目级 FileStore：扫描 projectPath/.memora/ 下的 rules/ + skills/
    const projectFileStore = new FileStore(memoraDir);
    const projectLoader = new MemoryLoader(projectFileStore, index);
    const projectResult = await projectLoader.loadAllToIndex();
    loadResult.loaded += projectResult.loaded;
    loadResult.skipped += projectResult.skipped;
    loadResult.errors.push(...projectResult.errors);

    // 2) Agent 级 FileStore：扫描 configDir 下的所有配置（rules/skills/personas/tools）
    if (configDir) {
      const configFileStore = new FileStore(configDir);
      const configLoader = new MemoryLoader(configFileStore, index);
      const configResult = await configLoader.loadAllToIndex();
      loadResult.loaded += configResult.loaded;
      loadResult.skipped += configResult.skipped;
      loadResult.errors.push(...configResult.errors);
    }

    // bootstrap 过滤：取 always + domain 必召记忆（排除 personality 类型）
    const always = await index.getByPermanence('always');
    const nonPersonality = always.filter((m) => m.type !== MemoryType.PERSONALITY);
    const domain = await index.getByPermanence('domain');
    const bootstrapMemories = [...nonPersonality, ...domain].filter(Boolean) as Memory[];

    // 3) 全局规则（~/.memora/global/rules/）
    const globalMemories = this.loadGlobalRules();
    const allBootstrap = [...bootstrapMemories, ...globalMemories];

    // 安全守卫（随项目切换更新）
    const security = new SecurityGuard(
      projectPath,
      memoraDir,
      this.allowedPaths,
      this.confirmWrites,
      this.permission,
    );

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
      dbPath: join(this.agentDataDir, 'memora.db'),
      fileStore: projectFileStore,
      index,
      topicStore,
      security,
      bootstrapMemories: allBootstrap,
      loadResult,
      globalMemories,
    };
  }

  /**
   * 关闭当前项目
   * 释放锁文件，但不关闭 Agent 级数据库（memora.db 是共享的）
   */
  async closeProject(): Promise<void> {
    // Agent 级 index/topicStore 不关闭——它们是共享的，在整个 Agent 生命周期内持久存在
    this.releaseLock();
    this.currentProjectPath = null;
    this.currentLockPath = null;
  }

  /**
   * 完全关闭：释放项目锁 + 关闭 Agent 级数据库
   * 应在 Agent 整体关闭时调用（而非项目切换时）
   */
  async shutdown(): Promise<void> {
    if (this.currentProjectPath) {
      await this.closeProject();
    }
    if (this.agentIndex) {
      await this.agentIndex.close().catch((err) => logger.warn({ err }, '关闭 Agent 数据库失败'));
      this.agentIndex = null;
      this.agentTopicStore = null;
    }
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
