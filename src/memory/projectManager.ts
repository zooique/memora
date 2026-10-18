/**
 * 项目管理器 — 单个项目的生命周期编排（单 Agent 模型）。
 * 职责：项目初始化编排（加锁 → 确保 Agent 级存储 → 构建上下文）、关闭与锁释放。
 * 边界（2026-10-18 定案）：一个 Agent 绑定一个项目；**多项目由宿主创建多个 Agent 实例**，
 * 内核既不提供单实例内切换、也不维护跨项目名单（历史 `switchProject` / `projects.json`
 * 注册表整链已随 PR-SWITCH-1 删除）。项目名只从路径推断，内核不落任何跨项目状态。
 */
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { InMemoryStorage } from '@/memory/inMemoryStorage.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import type { SecurityGuard } from '@/security/pathGuard.js';
import { logger } from '@/logging/logger.js';
import { expandHome } from '@/utils/path.js';
import { type Memory } from '@/memory/types.js';
import { LockManager } from '@/memory/lockManager.js';

/**
 * 从路径推断项目名称（取最后一段目录名，无法推断返回 'unnamed'）。
 * 原为 ProjectRegistry 静态方法，注册表整链删除后摘为本模块级纯函数——项目名是
 * `ProjectContext.projectName` 的唯一来源，推断逻辑不该随注册表一起消失。
 */
function inferProjectName(projectPath: string): string {
  const parts = projectPath.replace(/[/\\]+$/, '').split(/[/\\]/);
  return parts[parts.length - 1] || 'unnamed';
}

// ─── 类型 ────────────────────────────────────────────────

/** 项目上下文：打开一个项目后产出的一组组件（含项目级信息） */
export interface ProjectContext {
  /** 项目根目录的绝对路径 */
  projectPath: string;
  /** 项目名称（显式传入优先，否则取目录名；内核不读任何注册表） */
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
  /**
   * SecurityGuard 工厂函数（Agent 层注入，解除 memory→security 反向依赖）。
   * 在 initProject 时调用一次；不提供则 ProjectContext.security 为 null。
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
 * 项目管理器：**单个**项目的生命周期编排——初始化（加锁 → 确保存储 → 构建上下文）、
 * 关闭与锁释放。一个 Agent 绑定一个项目（2026-10-18 形态定案），因此本类**不持跨项目状态**：
 * 无切换入口、无注册表、无项目名单。多项目由宿主各建一个 Agent 实例。
 */
export class ProjectManager {
  /** Agent 级数据目录（宿主传入；内核不假设其下的文件形态） */
  private readonly agentDataDir: string;
  /** Agent 级存储实例（实例内唯一，init 后不再重建） */
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
  /** 锁文件管理器（专职 .memora/.lock） */
  private readonly lockManager: LockManager;

  constructor(options: ProjectManagerOptions) {
    const { dataDir, storage, createSecurityGuard } = options;
    this.agentDataDir = resolve(expandHome(dataDir));
    this.externalStorage = storage ?? null;
    this.createSecurityGuard = createSecurityGuard;
    this.lockManager = new LockManager();
  }

  /**
   * 确保 Agent 级资源（存储实例）已初始化，Agent 实例生命周期内保持同一实例。
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
   * 初始化项目：防重入释放旧锁→取项目级锁→确保存储→构建上下文。
   * 任一步失败释放锁并重置状态，防锁文件残留导致下次启动检测失败。
   */
  async initProject(
    projectPath: string,
    projectName?: string,
    configDir?: string,
  ): Promise<ProjectContext> {
    // 1) 防重入：本实例已打开过项目则先释放旧锁（不关 Agent 级 DB）
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
   * 构建项目上下文：bootstrap 过滤（恒为空，设定记忆归角色包层）+ 安全守卫创建 + 名称推断 + 日志。
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

    const name = projectName || inferProjectName(projectPath);

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

  /** 完全关闭：释放项目锁 + 关闭 Agent 级数据库（由 `Agent.close()` 调用） */
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

  /** 当前项目路径 */
  get currentProject(): string | null {
    return this.currentProjectPath;
  }

  /** 解析项目 .memora/ 目录（项目根目录下，区别于用户级 dataDir） */
  private resolveMemoraDir(projectPath: string): string {
    return resolve(projectPath, '.memora');
  }
}
