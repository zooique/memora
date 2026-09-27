/**
 * 项目管理器 — 多项目生命周期编排（单 Agent 模型）。
 * 职责：项目初始化编排（关旧项目→加锁→加载资源→构建上下文）、Agent 级资源管理
 * （memora.db 全局共享不随切换重建）、两层记忆加载。注册表/锁文件委托专职模块 ProjectRegistry / LockManager。
 * 原则：memora.db 只有一个（Agent 级）；项目切换不重建库，只更新安全守卫+重扫项目规则；
 * 项目级 .memora/ 仅存放 rules 与 skills（无 memora.db）。
 */
import { resolve, join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { InMemoryStorage } from '@/memory/inMemoryStorage.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import type { SecurityGuard } from '@/security/pathGuard.js';
import { logger } from '@/logging/logger.js';
import { expandHome } from '@/utils/path.js';
import { type Memory } from '@/memory/types.js';
import { ProjectRegistry, type ProjectEntry } from '@/memory/projectRegistry.js';
import { LockManager } from '@/memory/lockManager.js';

// ─── 类型 ────────────────────────────────────────────────

/** 项目上下文：打开一个项目后产出的一组组件（含项目级信息） */
export interface ProjectContext {
  /** 项目根目录的绝对路径 */
  projectPath: string;
  /** 项目名称（注册表读取或取目录名） */
  projectName: string;
  /** .memora/ 目录的绝对路径 */
  memoraDir: string;
  /** 记忆存储（经 IMemoryStorage 接口访问） */
  index: IMemoryStorage;
  /** 安全守卫（可空，由 Agent 层注入工厂创建） */
  security: SecurityGuard | null;
  /** 启动必召记忆（设定记忆唯一归角色包内容层，恒为空数组） */
  bootstrapMemories: Memory[];
}

/** ProjectManager 构造选项 */
export interface ProjectManagerOptions {
  /** Agent 级数据目录（宿主传入；内核不假设其下的文件形态） */
  dataDir: string;
  /** 外部注入存储实例（可选，不传则内部 InMemoryStorage 兜底） */
  storage?: IMemoryStorage;
  /** 注册表目录（可选，缺省同 dataDir；跨项目按名解析需要多项目共用一份注册表） */
  registryDir?: string;
  /**
   * SecurityGuard 工厂函数（Agent 层注入，解除 memory→security 反向依赖）。
   * 项目切换时调用；不提供则 ProjectContext.security 为 null。
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
 * 项目管理器：管理多项目生命周期——初始化当前项目（加锁+加载两层配置）、
 * 切换到新项目（解锁旧+锁新）、退出清理锁文件。注册表/锁文件委托专职模块，本类聚焦编排。
 */
export class ProjectManager {
  /** Agent 级数据目录（宿主传入；内核不假设其下的文件形态） */
  private readonly agentDataDir: string;
  /** Agent 级存储实例（全局共享，不随项目切换重建） */
  private agentIndex: IMemoryStorage | null = null;
  /** 当前打开的项目路径 */
  private currentProjectPath: string | null = null;
  /** 外部注入存储实例（不传则内部 InMemoryStorage 兜底） */
  private externalStorage: IMemoryStorage | null;
  /** SecurityGuard 工厂函数（Agent 层注入） */
  private readonly createSecurityGuard?: (
    projectPath: string,
    memoraDir: string,
    configDir?: string,
    agentDataDir?: string,
  ) => SecurityGuard;
  /** 项目注册表（专职 projects.json） */
  private readonly registry: ProjectRegistry;
  /** 锁文件管理器（专职 .memora/.lock） */
  private readonly lockManager: LockManager;

  constructor(options: ProjectManagerOptions) {
    const { dataDir, storage, registryDir, createSecurityGuard } = options;
    const memoraHome = resolve(expandHome(dataDir));
    this.agentDataDir = memoraHome;
    // 注册表目录：显式指定时用之（典型为用户级路径，使注册表跨项目共享）；
    // 缺省随 dataDir——此时注册表能否跨项目取决于调用方传的 dataDir 是共享还是项目级，
    // 内核不做假设：项目级 dataDir 下每个项目只注册自身，按名切换不成立（switchProject 已加守卫）。
    const registryHome = registryDir ? resolve(expandHome(registryDir)) : memoraHome;
    this.externalStorage = storage ?? null;
    this.createSecurityGuard = createSecurityGuard;
    // 注册表/锁文件委托专职模块
    this.registry = new ProjectRegistry(join(registryHome, 'projects.json'));
    this.lockManager = new LockManager();
  }

  /**
   * 确保 Agent 级资源（存储实例）已初始化，生命周期内共享不随项目切换重建。
   * 构造注入的外部实例直接用，否则内部 InMemoryStorage（非持久化，仅开发/测试）。
   */
  private async ensureAgentResources(): Promise<{ index: IMemoryStorage }> {
    if (!this.agentIndex) {
      await mkdir(this.agentDataDir, { recursive: true });

      if (this.externalStorage) {
        this.agentIndex = this.externalStorage;
      } else {
        logger.warn(
          { hasStorage: false },
          '未注入持久化存储实现，Agent 将使用 InMemoryStorage（数据重启后丢失）',
        );
        this.agentIndex = new InMemoryStorage();
      }
    }
    return { index: this.agentIndex };
  }

  /**
   * 初始化项目：关闭旧项目→取项目级锁→确保共享存储→构建上下文。
   * 任一步失败释放锁并重置状态，防锁文件残留导致下次启动检测失败。
   */
  async initProject(
    projectPath: string,
    projectName?: string,
    configDir?: string,
  ): Promise<ProjectContext> {
    // 1) 关闭旧项目（释放旧锁，不关 Agent 级 DB）
    if (this.currentProjectPath) {
      await this.closeProject();
    }
    // 2) 解析 memoraDir + 获取项目级锁（委托 LockManager）
    const memoraDir = this.resolveMemoraDir(projectPath);
    await this.lockManager.acquire(memoraDir);
    this.currentProjectPath = projectPath;

    try {
      // 3) 确保项目目录 + Agent 级共享存储
      await mkdir(memoraDir, { recursive: true });
      const { index } = await this.ensureAgentResources();
      // 4) 构建并返回项目上下文
      return this.buildProjectContext(projectPath, projectName, memoraDir, index, configDir);
    } catch (err) {
      // 失败时释放锁并重置状态，防锁文件残留
      await this.lockManager.release().catch((releaseErr: unknown) => {
        logger.warn({ err: releaseErr }, '释放项目锁失败');
      });
      this.currentProjectPath = null;
      throw err;
    }
  }

  /**
   * 构建项目上下文：bootstrap 过滤（恒为空，设定记忆归角色包层）+ 安全守卫创建 + 项目注册 + 日志。
   */
  private buildProjectContext(
    projectPath: string,
    projectName: string | undefined,
    memoraDir: string,
    index: IMemoryStorage,
    configDir: string | undefined,
  ): ProjectContext {
    // 设定记忆唯一归角色包内容层，由 assembler 角色包路径接管，恒为空数组
    const bootstrapMemories: Memory[] = [];

    // 安全守卫由 Agent 层注入工厂创建，解除 memory→security 反向依赖
    const security = this.createSecurityGuard
      ? this.createSecurityGuard(projectPath, memoraDir, configDir, this.agentDataDir)
      : null;

    // 注册到项目表（委托 ProjectRegistry）
    const name = projectName || ProjectRegistry.inferProjectName(projectPath);
    this.registry.register(projectPath, name);

    logger.info(
      {
        projectPath,
        projectName: name,
        memoraDir,
        bootstrapCount: bootstrapMemories.length,
      },
      '项目初始化完成',
    );

    return {
      projectPath,
      projectName: name,
      memoraDir,
      index,
      security,
      bootstrapMemories,
    };
  }

  /** 关闭当前项目：释放锁/清状态，但不关 Agent 级 DB（共享，Agent 生命周期内持久存在） */
  async closeProject(): Promise<void> {
    await this.lockManager.release();
    this.currentProjectPath = null;
  }

  /** 完全关闭：释放项目锁 + 关闭 Agent 级数据库（应在 Agent 整体关闭而非项目切换时调用） */
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

  /** 列出已注册项目（委托 ProjectRegistry） */
  get list(): ProjectEntry[] {
    return this.registry.list;
  }

  /** 注册项目（委托 ProjectRegistry） */
  registerProject(projectPath: string, name: string): void {
    this.registry.register(projectPath, name);
  }

  /** 移除项目（委托 ProjectRegistry） */
  unregisterProject(projectPath: string): void {
    this.registry.unregister(projectPath);
  }

  /** 当前项目路径 */
  get currentProject(): string | null {
    return this.currentProjectPath;
  }

  /** 解析项目 .memora/ 目录（项目根目录下，区别于用户级 dataDir） */
  private resolveMemoraDir(projectPath: string): string {
    return resolve(projectPath, '.memora');
  }
}
