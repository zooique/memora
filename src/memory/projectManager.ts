/**
 * 项目管理器 — 多项目并发
 *
 * 核心职责：
 *   - 管理项目注册表（~/.memora/projects.json）
 *   - 锁文件机制（.memora/.lock）防止同项目并发写入导致数据损坏
 *   - Agent 级资源管理（memora.db 全局共享，不随项目切换重建）
 *   - 两层记忆加载：项目级（projectPath/.memora/）→ Agent 级（configDir）
 *   - 项目切换（只更新 projectPath + security + 重新加载项目 rules/skills）
 *
 * 设计原则（单 Agent 模型）：
 *   - memora.db 只有一个（Agent 级），所有项目共享同一记忆数据库
 *   - 项目切换不重建数据库，只更新安全守卫 + 重新扫描项目规则
 *   - 项目级 .memora/ 仅存放 rules/ 和 skills/（无 memora.db）
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
import { hostname } from 'node:os';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { FileStore } from '@/memory/store.js';
import { InMemoryStorage } from '@/memory/inMemoryStorage.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import { MemoryLoader } from '@/memory/loader.js';
import type { LoadResult } from '@/memory/loader.js';
import type { SecurityGuard } from '@/security/pathGuard.js';
import { logger } from '@/logging/logger.js';
import { toError } from '@/utils/toError.js';
import { expandHome } from '@/utils/path.js';
import { SOURCE_LABELS, type Memory } from '@/memory/types.js';
import { nowIso } from '@/utils/time.js';

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
  /** SQLite 索引（通过 IMemoryStorage 接口访问） */
  index: IMemoryStorage;
  /** 安全守卫（可空，由 Agent 层注入工厂函数创建） */
  security: SecurityGuard | null;
  /** 启动时加载的必召记忆 */
  bootstrapMemories: Memory[];
  /** 加载结果 */
  loadResult: LoadResult;
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

// ─── QC-24 类型守卫 ─────────────────────────────────────
// 对不可信磁盘文件 JSON.parse 结果进行运行时校验，替代 `as` 类型断言

/**
 * 判断值是否为非数组对象（排除 null）
 *
 * @param value 待校验的值
 * @returns true 表示是普通对象
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 判断值是否为 LockInfo（锁文件结构）
 *
 * @param value 待校验的值
 * @returns true 表示符合 LockInfo 结构
 */
function isLockInfo(value: unknown): value is LockInfo {
  if (!isPlainObject(value)) return false;
  return (
    typeof value['pid'] === 'number' &&
    typeof value['acquiredAt'] === 'string' &&
    typeof value['hostname'] === 'string'
  );
}

/**
 * 判断值是否为 ProjectEntry（项目注册表条目）
 *
 * @param value 待校验的值
 * @returns true 表示符合 ProjectEntry 结构
 */
function isProjectEntry(value: unknown): value is ProjectEntry {
  if (!isPlainObject(value)) return false;
  return (
    typeof value['path'] === 'string' &&
    typeof value['name'] === 'string' &&
    typeof value['lastOpened'] === 'string'
  );
}

/**
 * 判断值是否为 ProjectEntry 数组
 *
 * 过滤掉不符合结构的条目，仅保留合法条目
 *
 * @param value 待校验的值
 * @returns 解析后的合法条目数组（损坏时返回空数组）
 */
function asProjectEntryArray(value: unknown): ProjectEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isProjectEntry);
}

/**
 * ProjectManager 构造选项
 */
export interface ProjectManagerOptions {
  /** Agent 级数据目录（memora.db 所在目录） */
  dataDir: string;
  /** 外部注入的存储实例（可选，不传则内部创建 InMemoryStorage 兜底） */
  storage?: IMemoryStorage;
  /** 注册表目录（可选，默认与 dataDir 相同） */
  registryDir?: string;
  /**
   * SecurityGuard 工厂函数（由 Agent 层注入，解除 memory→security 反向依赖）
   *
   * 在项目切换时调用，传入项目路径、.memora/ 目录、Agent 级配置目录和数据目录，
   * 返回一个配置好的 SecurityGuard 实例。
   * 不提供时 ProjectContext.security 为 null（宿主需自行处理安全校验）。
   */
  createSecurityGuard?: (
    projectPath: string,
    memoraDir: string,
    configDir?: string,
    agentDataDir?: string,
  ) => SecurityGuard;
}

/**
 * 项目管理器
 *
 * 管理多项目的生命周期：
 * 1. 初始化当前项目（加锁 + 加载两层配置）
 * 2. /project <name> 切换到新项目（解锁旧项目 + 加锁新项目）
 * 3. 退出时清理锁文件
 */
export class ProjectManager {
  /** 项目注册表路径 */
  private readonly registryPath: string;
  /** Agent 级数据目录（memora.db 所在目录） */
  private readonly agentDataDir: string;
  /** Agent 级存储实例（全局共享，不随项目切换重建） */
  private agentIndex: IMemoryStorage | null = null;
  /** 当前打开的项目路径 */
  private currentProjectPath: string | null = null;
  /** 当前持有的锁文件路径 */
  private currentLockPath: string | null = null;
  /** 外部注入的存储实例（可选，不传则内部创建 InMemoryStorage 兜底） */
  private externalStorage: IMemoryStorage | null;
  /** SecurityGuard 工厂函数（由 Agent 层注入） */
  private readonly createSecurityGuard?: (
    projectPath: string,
    memoraDir: string,
    configDir?: string,
    agentDataDir?: string,
  ) => SecurityGuard;

  constructor(options: ProjectManagerOptions) {
    const { dataDir, storage, registryDir, createSecurityGuard } = options;
    const memoraHome = resolve(expandHome(dataDir));
    this.agentDataDir = memoraHome;
    // 注册表目录：优先使用宿主指定的用户级路径，避免每项目重复存储
    const registryHome = registryDir ? resolve(expandHome(registryDir)) : memoraHome;
    this.registryPath = join(registryHome, 'projects.json');
    // 保存外部注入的存储实例（宿主项目注入时使用）
    this.externalStorage = storage ?? null;
    // 保存 SecurityGuard 工厂函数
    this.createSecurityGuard = createSecurityGuard;
  }

  /**
   * 确保 Agent 级资源已初始化（存储实例）
   * 存储实例在整个 Agent 生命周期内共享，不随项目切换重建
   *
   * 如果构造时注入了外部存储实例，直接使用；
   * 否则内部创建 InMemoryStorage（非持久化兜底，仅开发/测试用）。
   */
  private async ensureAgentResources(): Promise<{ index: IMemoryStorage }> {
    if (!this.agentIndex) {
      await mkdir(this.agentDataDir, { recursive: true });

      // 优先使用外部注入的存储实例
      if (this.externalStorage) {
        this.agentIndex = this.externalStorage;
      } else {
        // 兜底：InMemoryStorage（非持久化，不依赖 native 模块）
        // 生产环境应由宿主注入持久化实现（如 SqliteStorage）
        logger.warn({ hasStorage: false }, '未注入持久化存储实现，Agent 将使用 InMemoryStorage（数据重启后丢失）');
        this.agentIndex = new InMemoryStorage();
      }
    }
    return { index: this.agentIndex };
  }

  /**
   * 初始化指定项目
   *
   * 两层记忆加载：
   *   1) 项目级：扫描 projectPath/.memora/rules/ + skills/
   *   2) Agent 级：扫描 configDir 下的所有配置（rules/skills/personas/tools）
   *
   * 全局规则不再由内核硬编码路径，宿主可通过 configDir 统一管理。
   *
   * memora.db 是 Agent 级共享资源，不随项目切换重建。
   *
   * 主体编排（关闭旧项目 + 锁 + 错误回滚）+ loadAllResources（两层加载）
   * + buildProjectContext（上下文构建）三个子方法分工。
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
    // 1) 关闭旧项目（释放旧项目锁，但不关 Agent 级 DB）
    if (this.currentProjectPath) {
      await this.closeProject();
    }

    // 2) 解析 memoraDir + 获取项目级锁
    const memoraDir = this.resolveMemoraDir(projectPath);
    await this.acquireLock(memoraDir);
    this.currentProjectPath = projectPath;
    this.currentLockPath = join(memoraDir, '.lock');

    // FD-24: 后续步骤失败时释放锁并重置状态，避免锁文件残留导致下次启动检测失败
    try {
      // 3) 确保项目目录 + 加载两层资源
      await mkdir(memoraDir, { recursive: true });
      const { index, loadResult, projectFileStore } = await this.loadAllResources(
        memoraDir,
        configDir,
      );

      // 4) 构建并返回项目上下文
      return this.buildProjectContext(
        projectPath,
        projectName,
        memoraDir,
        index,
        projectFileStore,
        loadResult,
        configDir,
      );
    } catch (err) {
      // FD-24: 后续步骤失败时释放锁并重置状态，避免锁文件残留导致下次启动检测失败
      await this.releaseLock().catch((releaseErr: unknown) => {
        logger.warn({ err: releaseErr }, '释放项目锁失败');
      });
      this.currentProjectPath = null;
      this.currentLockPath = null;
      throw err;
    }
  }

  /**
   * 加载两层记忆资源
   *
   * 职责：确保 Agent 级存储 + 扫描项目级 + 扫描 Agent 级配置，合并加载结果。
   *
   * @param memoraDir 项目 .memora/ 目录
   * @param configDir Agent 级配置目录（可选）
   * @returns index 存储实例 + loadResult 合并加载结果 + projectFileStore 项目级 FileStore
   */
  private async loadAllResources(
    memoraDir: string,
    configDir?: string,
  ): Promise<{
    index: IMemoryStorage;
    loadResult: LoadResult;
    projectFileStore: FileStore;
  }> {
    // Agent 级共享资源（memora.db 只有一个）
    const { index } = await this.ensureAgentResources();

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

    return { index, loadResult, projectFileStore };
  }

  /**
   * 构建项目上下文
   *
   * 职责：bootstrap 过滤 + 安全守卫创建 + 项目注册 + 日志 + 返回上下文。
   *
   * @param projectPath 项目根目录
   * @param projectName 项目名称（可选，默认取目录名）
   * @param memoraDir 项目 .memora/ 目录
   * @param index 存储实例
   * @param projectFileStore 项目级 FileStore
   * @param loadResult 加载结果
   * @param configDir Agent 级配置目录（用于安全守卫创建）
   * @returns 完整的项目上下文
   */
  private buildProjectContext(
    projectPath: string,
    projectName: string | undefined,
    memoraDir: string,
    index: IMemoryStorage,
    projectFileStore: FileStore,
    loadResult: LoadResult,
    configDir: string | undefined,
  ): ProjectContext {
    // bootstrap 过滤：按 source 获取 rule + skill 必召记忆（跳过 persona，由 PersonaManager 管理）
    const rules = index.getBySource(SOURCE_LABELS.RULE);
    const skills = index.getBySource(SOURCE_LABELS.SKILL);
    const bootstrapMemories = [...rules, ...skills];

    // 安全守卫由 Agent 层注入的工厂函数创建，解除 memory→security 反向依赖
    const security = this.createSecurityGuard
      ? this.createSecurityGuard(projectPath, memoraDir, configDir, this.agentDataDir)
      : null;

    // 注册到项目表
    const name = projectName || this.inferProjectName(projectPath);
    this.registerProject(projectPath, name);

    logger.info(
      {
        projectPath,
        projectName: name,
        memoraDir,
        loaded: loadResult.loaded,
        bootstrapCount: bootstrapMemories.length,
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
      security,
      bootstrapMemories,
      loadResult,
    };
  }

  /**
   * 关闭当前项目
   * 释放锁文件，但不关闭 Agent 级数据库（memora.db 是共享的）
   */
  async closeProject(): Promise<void> {
    // Agent 级 index/sessionStore 不关闭——它们是共享的，在整个 Agent 生命周期内持久存在
    await this.releaseLock();
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
      try {
        this.agentIndex.close?.();
      } catch (err) {
        logger.warn({ err }, '关闭 Agent 数据库失败');
      }
      this.agentIndex = null;
    }
  }

  /**
   * 列出已注册的项目（IX-02：统一为 getter 风格，与 persona/skill 一致）
   */
  get list(): ProjectEntry[] {
    return this.readRegistry();
  }

  /**
   * 列出已注册的项目
   * @deprecated 请使用 `projectManager.list` getter 代替
   */
  listProjects(): ProjectEntry[] {
    return this.readRegistry();
  }

  /**
   * 注册项目到注册表
   */
  registerProject(projectPath: string, name: string): void {
    const registry = this.readRegistry();
    // Windows 文件系统不区分大小写，路径大小写不同视为同一项目
    const existing = registry.findIndex((e) => e.path.toLowerCase() === projectPath.toLowerCase());

    const entry: ProjectEntry = {
      path: projectPath,
      name,
      lastOpened: nowIso(),
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
    // Windows 文件系统不区分大小写，大小写不同视为同一项目
    const filtered = registry.filter((e) => e.path.toLowerCase() !== projectPath.toLowerCase());
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
  private async acquireLock(memoraDir: string): Promise<void> {
    const lockPath = join(memoraDir, '.lock');

    try {
      // 尝试读取锁文件（存在时）
      const raw = await readFile(lockPath, 'utf-8');
      // QC-24 使用类型守卫校验 JSON.parse 结果，替代 `as LockInfo` 类型断言
      const parsed: unknown = JSON.parse(raw);
      if (!isLockInfo(parsed)) {
        // 锁文件结构损坏，清理后重新获取
        logger.warn({ path: lockPath }, '锁文件结构损坏，清理残留');
        await this.safeUnlink(lockPath);
        return;
      }
      const info = parsed;

      // 检查进程是否存活
      if (this.isProcessAlive(info.pid)) {
        logger.warn(
          { pid: info.pid, acquiredAt: info.acquiredAt, hostname: info.hostname },
          '项目已被其他进程打开（锁文件存在），继续操作可能导致数据冲突',
        );
      } else {
        // 残留锁，清理
        logger.info({ pid: info.pid }, '清理残留锁文件（进程已退出）');
        await this.safeUnlink(lockPath);
      }
    } catch (err) {
      // 锁文件不存在或损坏，清理：记录 debug 日志便于排查（不存在属正常首次启动）
      logger.debug({ path: lockPath, err: toError(err).message }, '锁文件读取失败，清理残留');
      await this.safeUnlink(lockPath);
    }

    // 写入新锁
    const lockInfo: LockInfo = {
      pid: process.pid,
      acquiredAt: nowIso(),
      hostname: hostname(),
    };

    await mkdir(memoraDir, { recursive: true });
    await writeFile(lockPath, JSON.stringify(lockInfo, null, 2), 'utf-8');
  }

  /**
   * 释放锁文件
   */
  private async releaseLock(): Promise<void> {
    if (this.currentLockPath) {
      await this.safeUnlink(this.currentLockPath);
    }
  }

  /**
   * 安全删除文件（忽略不存在的错误）
   */
  private async safeUnlink(filePath: string): Promise<void> {
    try {
      await unlink(filePath);
    } catch (err) {
      logger.debug({ path: filePath, err: toError(err).message }, 'safeUnlink 忽略删除失败');
    }
  }

  /**
   * 检查进程是否存活
   *
   * 跨平台统一使用 process.kill(pid, 0) 探测进程存活
   * （Windows 上 process.kill(pid, 0) 同样有效）
   */
  private isProcessAlive(pid: number): boolean {
    try {
      // 发送信号 0 检查进程是否存在（POSIX 兼容）
      // Windows 上 process.kill(pid, 0) 也会抛出错误如果进程不存在
      process.kill(pid, 0);
      return true;
    } catch {
      logger.debug({ pid }, '进程不存在');
      return false;
    }
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
   *
   * 同步读取：list getter 契约要求同步返回，注册表操作低频，同步 I/O 影响可控
   * 损坏时返回空数组并记录警告日志，避免静默吞错掩盖磁盘故障
   */
  private readRegistry(): ProjectEntry[] {
    if (!existsSync(this.registryPath)) {
      return [];
    }

    try {
      const raw = readFileSync(this.registryPath, 'utf-8');
      // QC-24 使用类型守卫校验 JSON.parse 结果，替代 `as ProjectEntry[]` 类型断言
      // 过滤掉不符合结构的条目，仅保留合法条目
      const parsed: unknown = JSON.parse(raw);
      const entries = asProjectEntryArray(parsed);
      if (entries.length === 0 && Array.isArray(parsed) && parsed.length > 0) {
        // 数组存在但所有条目都不合法，记录警告
        logger.warn(
          { path: this.registryPath, totalEntries: parsed.length },
          '项目注册表所有条目结构不合法，返回空列表',
        );
      }
      return entries;
    } catch (err) {
      // 注册表损坏：记录警告日志便于排查（不存在属正常首次启动，损坏需排查）
      logger.warn({ path: this.registryPath, err: toError(err).message }, '项目注册表解析失败，返回空列表');
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
