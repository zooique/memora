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
  /**
   * 删除记忆时同步清理其关系边的回调（T13，2026-08-09）
   *
   * closeProject 撤销项目级记忆（软删除）时，若该项目级 rule/skill 被 insight
   * 引用为关系对端，索引删除不会级联清理 memory_relations → 切换项目后留下悬挂边。
   * 由调用方（Agent 层）注入关系清理实现（memoryInspector.writeRemoveRelationsByMemoryId），
   * 与 ConfigManager 的 removeRelationsByMemoryId 回调同模式——解耦 ProjectManager
   * 对关系存储的直接依赖。
   */
  removeRelationsByMemoryId?: (memoryId: string) => void;
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
  /** T13：关系边清理回调（closeProject 撤销项目级记忆时联动，由 Agent 层注入） */
  private readonly removeRelationsByMemoryId?: (memoryId: string) => void;
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
  /** 当前项目级记忆在共享 index 中的 ID 集合（closeProject 时撤销，修复跨项目隔离泄漏） */
  private currentProjectMemoryIds: Set<string> = new Set();

  constructor(options: ProjectManagerOptions) {
    const { dataDir, storage, registryDir, createSecurityGuard, removeRelationsByMemoryId } = options;
    const memoraHome = resolve(expandHome(dataDir));
    this.agentDataDir = memoraHome;
    // 注册表目录：优先使用宿主指定的用户级路径，避免每项目重复存储
    const registryHome = registryDir ? resolve(expandHome(registryDir)) : memoraHome;
    // 保存外部注入的存储实例（宿主项目注入时使用）
    this.externalStorage = storage ?? null;
    // 保存 SecurityGuard 工厂函数
    this.createSecurityGuard = createSecurityGuard;
    // T13：关系边清理回调（closeProject 撤销项目级记忆时联动）
    this.removeRelationsByMemoryId = removeRelationsByMemoryId;
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
    // 记录本项目级记忆 ID，供 closeProject 撤销（修复跨项目隔离泄漏）
    this.currentProjectMemoryIds = new Set(projectResult.loadedIds ?? []);

    // 2) Agent 级 FileStore：扫描 configDir 下的所有配置（rules/skills/personas/tools）
    let configResult: LoadResult | null = null;
    if (configDir) {
      const configFileStore = new FileStore(configDir);
      const configLoader = new MemoryLoader(configFileStore, index);
      configResult = await configLoader.loadAllToIndex();
      loadResult.loaded += configResult.loaded;
      loadResult.skipped += configResult.skipped;
      loadResult.errors.push(...configResult.errors);
    }

    // T6 对账：两层扫描完成（文件集合完整）后清理无文件支撑的孤儿 rule。
    // 必须在合并层执行——任一层单独对账都会误删另一层的规则。
    this.evictOrphanRules(index, projectResult, configResult);

    return { index, loadResult, projectFileStore };
  }

  /**
   * 对账：删除索引中"无任何文件支撑"的活跃 rule（T6，2026-08-09）
   *
   * 旧缺陷：loadAllToIndex 只 add 不 evict（loader.ts:63-100）→ 删除 rules/*.md 后
   * SQLite 行永生，继续被 bootstrap 经 getBySource(RULE) 全量拉取注入 messages[0]
   * （僵尸规则，文件面板不可见、用户不可删，但每一轮都在污染 system prompt）。
   *
   * 触发时机限定：仅本方法（项目切换 / 启动边界）——此处是文件集合唯一完整的时点。
   * 运行时注入（addRule）不跨项目边界且宿主零调用，不在对账误删面内。
   *
   * 范围仅 rule 源：persona/skill 的索引行是无召回消费者的展示镜像
   * （recall 排除、bootstrap 不取），由 T7 注释收窄为「重启自愈」，不对账。
   * guardrail 由 AgentLoop 运行时读取，不受索引残留影响。
   *
   * 软删除（deletedAt）而非物理删除：保留回收站语义，误删可恢复。
   *
   * @param index 共享记忆索引
   * @param projectResult 项目级扫描结果
   * @param configResult Agent 级扫描结果（configDir 未配置时为 null）
   */
  private evictOrphanRules(
    index: IMemoryStorage,
    projectResult: LoadResult,
    configResult: LoadResult | null,
  ): void {
    // T0-2：扫描不完整时整体停用对账。
    // errors 非空意味着有文件「存在但读不到」（EACCES/EISDIR 等），其 id 不可知
    // ——既进不了 seenIds，又会被下面的差集判为孤儿。宁可让僵尸规则多活一轮，
    // 也不能把用户磁盘上还在的规则软删掉：前者可被下次启动自愈，后者是数据损失。
    const scanErrorCount = projectResult.errors.length + (configResult?.errors.length ?? 0);
    if (scanErrorCount > 0) {
      logger.warn(
        { scanErrorCount },
        '索引对账已跳过：本次扫描存在读取失败，文件集合不完整，无法安全判定孤儿规则',
      );
      return;
    }

    // 扫描无误时，loadedIds 才等价于「磁盘上有文件支撑的 id 集合」：
    // 另两条 skip 路径（read 返回 null=ENOENT、内容为占位模板）不进 loadedIds
    // 恰恰是对账想要的结果——前者文件真的没了，后者内容已被清空成空壳，
    // 索引里的旧内容是陈旧副本，本就该软删。
    const fileBackedIds = new Set<string>([
      ...(projectResult.loadedIds ?? []),
      ...(configResult?.loadedIds ?? []),
    ]);
    const activeRules = index.getBySource(SOURCE_LABELS.RULE);
    for (const memory of activeRules) {
      if (!fileBackedIds.has(memory.id)) {
        index.delete(memory.id);
        logger.info({ id: memory.id }, '索引对账：无文件支撑的孤儿规则已软删除');
      }
    }
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
    // bootstrap 过滤：仅 Rule（跳过 Persona 由 PersonaManager 管理，跳过 Skill 由 matchAndInjectSkill 动态注入）
    const rules = index.getBySource(SOURCE_LABELS.RULE);
    const bootstrapMemories = [...rules];

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
    // S2 修复：撤销当前项目级记忆，防止跨项目隔离泄漏。
    // 项目级 rules/skills/personas 由 loadAllResources 写入共享 index（只 add 不 evict），
    // 若不撤销，切换项目后旧项目规则仍注入新项目 system prompt 与召回结果。
    // 项目文件仍在磁盘，重新打开同一项目时会重新 upsert 恢复（软删除不影响文件本体）。
    if (this.agentIndex) {
      for (const id of this.currentProjectMemoryIds) {
        try {
          // T13 修复：先清关系边再软删主记忆——项目级 rule/skill 被 insight 引用时，
          // 仅 delete 会留下悬挂关系边（sourceId/targetId 指向已撤销的记忆）。
          this.removeRelationsByMemoryId?.(id);
          this.agentIndex.delete(id);
        } catch (err) {
          logger.warn({ err, id }, '撤销项目级记忆失败（软删除）');
        }
      }
    }
    this.currentProjectMemoryIds.clear();
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
