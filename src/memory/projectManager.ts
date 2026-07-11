/**
 * 项目管理器 — 多项目生命周期编排（瘦身后）
 *
 * 核心职责（聚焦编排）：
 *   - 项目初始化编排（关闭旧项目 → 加锁 → 加载资源 → 构建上下文）
 *   - Agent 级资源管理（memora.db 全局共享，不随项目切换重建）
 *   - 两层记忆加载：项目级（projectPath/.memora/）→ Agent 级（configDir）
 *   - 项目切换（只更新 projectPath + security + 重新加载项目 rules/skills）
 *
 * 已拆分至专职模块（1.0 接口稳定化）：
 *   - ProjectRegistry（src/memory/projectRegistry.ts）：注册表读写 + 条目管理
 *   - LockManager（src/memory/lockManager.ts）：锁文件获取/释放 + 残留锁检测
 *
 * 设计原则（单 Agent 模型）：
 *   - memora.db 只有一个（Agent 级），所有项目共享同一记忆数据库
 *   - 项目切换不重建数据库，只更新安全守卫 + 重新扫描项目规则
 *   - 项目级 .memora/ 仅存放 rules/ 和 skills/（无 memora.db）
 *
 * 详见 ADR-008 · 目录结构按"职责分层"
 */
import { resolve, join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { FileStore } from '@/memory/store.js';
import { InMemoryStorage } from '@/memory/inMemoryStorage.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import { MemoryLoader } from '@/memory/loader.js';
import type { LoadResult } from '@/memory/loader.js';
import type { SecurityGuard } from '@/security/pathGuard.js';
import { logger } from '@/logging/logger.js';
import { expandHome } from '@/utils/path.js';
import { SOURCE_LABELS, type Memory } from '@/memory/types.js';
import { ProjectRegistry, type ProjectEntry } from '@/memory/projectRegistry.js';
import { LockManager } from '@/memory/lockManager.js';

// ProjectEntry 已迁移至 projectRegistry.ts，此处重导出保持公共 API 向后兼容
export type { ProjectEntry } from '@/memory/projectRegistry.js';

// ─── 类型 ────────────────────────────────────────────────

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

// ─── 类 ──────────────────────────────────────────────────

/**
 * 项目管理器
 *
 * 管理多项目的生命周期：
 * 1. 初始化当前项目（加锁 + 加载两层配置）
 * 2. /project <name> 切换到新项目（解锁旧项目 + 加锁新项目）
 * 3. 退出时清理锁文件
 *
 * 注册表/锁文件实现委托给 ProjectRegistry / LockManager，
 * 本类聚焦生命周期编排。
 */
export class ProjectManager {
  /** Agent 级数据目录（memora.db 所在目录） */
  private readonly agentDataDir: string;
  /** Agent 级存储实例（全局共享，不随项目切换重建） */
  private agentIndex: IMemoryStorage | null = null;
  /** 当前打开的项目路径 */
  private currentProjectPath: string | null = null;
  /** 外部注入的存储实例（可选，不传则内部创建 InMemoryStorage 兜底） */
  private externalStorage: IMemoryStorage | null;
  /** SecurityGuard 工厂函数（由 Agent 层注入） */
  private readonly createSecurityGuard?: (
    projectPath: string,
    memoraDir: string,
    configDir?: string,
    agentDataDir?: string,
  ) => SecurityGuard;
  /** 项目注册表（专职管理 projects.json） */
  private readonly registry: ProjectRegistry;
  /** 锁文件管理器（专职管理 .memora/.lock） */
  private readonly lockManager: LockManager;

  constructor(options: ProjectManagerOptions) {
    const { dataDir, storage, registryDir, createSecurityGuard } = options;
    const memoraHome = resolve(expandHome(dataDir));
    this.agentDataDir = memoraHome;
    // 注册表目录：优先使用宿主指定的用户级路径，避免每项目重复存储
    const registryHome = registryDir ? resolve(expandHome(registryDir)) : memoraHome;
    // 保存外部注入的存储实例（宿主项目注入时使用）
    this.externalStorage = storage ?? null;
    // 保存 SecurityGuard 工厂函数
    this.createSecurityGuard = createSecurityGuard;
    // 委托注册表/锁文件管理给专职模块
    this.registry = new ProjectRegistry(join(registryHome, 'projects.json'));
    this.lockManager = new LockManager();
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

    // 2) 解析 memoraDir + 获取项目级锁（委托给 LockManager）
    const memoraDir = this.resolveMemoraDir(projectPath);
    await this.lockManager.acquire(memoraDir);
    this.currentProjectPath = projectPath;

    // 后续步骤失败时释放锁并重置状态，避免锁文件残留导致下次启动检测失败
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
      // 后续步骤失败时释放锁并重置状态，避免锁文件残留导致下次启动检测失败
      await this.lockManager.release().catch((releaseErr: unknown) => {
        logger.warn({ err: releaseErr }, '释放项目锁失败');
      });
      this.currentProjectPath = null;
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

    // 注册到项目表（委托给 ProjectRegistry）
    const name = projectName || ProjectRegistry.inferProjectName(projectPath);
    this.registry.register(projectPath, name);

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
    await this.lockManager.release();
    this.currentProjectPath = null;
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
   *
   * 委托给 ProjectRegistry。
   */
  get list(): ProjectEntry[] {
    return this.registry.list;
  }

  /**
   * 列出已注册的项目
   *
   * v1.0 公共 API（CHANGELOG 迁移路径：`agent.listProjects()` → `agent.projects.listProjects()`）。
   * 与 `.list` getter 等价，保留方法形式以兼容 0.3 迁移路径。
   */
  listProjects(): ProjectEntry[] {
    return this.registry.list;
  }

  /**
   * 注册项目到注册表
   *
   * 委托给 ProjectRegistry。
   *
   * @param projectPath 项目根目录
   * @param name 项目名称
   */
  registerProject(projectPath: string, name: string): void {
    this.registry.register(projectPath, name);
  }

  /**
   * 从注册表移除项目
   *
   * 委托给 ProjectRegistry。
   *
   * @param projectPath 项目根目录
   */
  unregisterProject(projectPath: string): void {
    this.registry.unregister(projectPath);
  }

  /**
   * 获取当前项目路径
   */
  get currentProject(): string | null {
    return this.currentProjectPath;
  }

  /**
   * 解析项目的 .memora/ 目录路径
   * 每个项目有独立的 .memora/ 目录（在项目根目录下）
   * 这与 config.memory.dataDir（用户级默认目录）不同
   */
  private resolveMemoraDir(projectPath: string): string {
    return resolve(projectPath, '.memora');
  }
}
