/**
 * Agent 门面类 — Memora 宿主项目接入入口
 *
 * 宿主通过 `import { Agent } from '@zooique/memora'` 一行接入。
 * 负责组件组装和核心对话编排，领域专属操作委托给专职 Manager
 * （RolePackManager / ToolExecutor / SkillManager / MemoryInspector）。
 */
import { getBaseName } from '@/utils/path.js';
import { AGENT_CONSTANTS } from '@/agent/constants.js';
import type { AgentLoop } from '@/agent/loop.js';
import { COMPLETION_LEVELS } from '@/agent/types.js';
import type {
  AgentChunk,
  ArchiveMode,
  AgentOptions,
  AgentContext,
  AgentConfig,
  Role,
  Standard,
  ToolExecutionRecord,
} from '@/agent/types.js';
import type { SessionEvent, SessionCheckpoint, ResolvedDelta } from '@/agent/types.js';
import { Composer } from '@/agent/composer.js';
import type { PlanContext } from '@/agent/types.js';
import type { ToolExecutor } from '@/agent/toolExecutor.js';
import type { MessageHistory } from '@/agent/messageHistory.js';
import { ProjectManager, type ProjectContext } from '@/memory/projectManager.js';
import { SecurityGuard } from '@/security/pathGuard.js';
import type { SkillManager } from '@/skill/skillManager.js';
import type { RolePackManager } from '@/role-pack/rolePackManager.js';
import { DEFAULT_BEHAVIOR_STRATEGY } from '@/role-pack/strategyResolver.js';
import { MAX_OUTPUT_LIMIT } from '@/role-pack/strategyKeys.js';
import type { BehaviorStrategy } from '@/role-pack/types.js';
import { resolveCapabilityTools } from '@/role-pack/capabilityMap.js';
import type { SessionArchiver, SessionArchiveResult } from '@/agent/managers/sessionArchiver.js';
import { SessionNamer } from '@/agent/managers/sessionNamer.js';
import type { TextPolishManager } from '@/agent/managers/textPolishManager.js';
import type { RoundSummaryGenerator } from '@/agent/managers/roundSummaryGenerator.js';
import type { WorkProjectionManager } from '@/agent/managers/workProjection.js';
import type { MemoryInspector } from '@/agent/managers/memoryInspector.js';
import type { DedupManager } from '@/agent/managers/dedupManager.js';
import type { MemoryAdvisor } from '@/agent/managers/memoryAdvisor.js';
import {
  createDefaultGCService,
  type GCService,
  type GCResult,
} from '@/memory/gcService.js';
import { assembleComponents, buildSystemPromptPrefix } from '@/agent/assembler.js';
import { SeedOrchestrator } from '@/agent/seed/index.js';
// 输入增强管线（角色/记忆/技能增强，Agent 只保留编排调用点）
import type { ContextPreparer } from '@/agent/contextPreparer.js';
import type { CheckpointRestoreCoordinator } from '@/agent/checkpointRestoreCoordinator.js';
import { chatBusyError, configError, isAbortError } from '@/utils/errors.js';
import { toError } from '@/utils/toError.js';
// SessionManager 实例由组装器创建，Agent 仅持有类型引用
import type { SessionManager, AgentForkResult } from '@/agent/managers/sessionManager.js';
import { ChatLockManager } from '@/agent/managers/chatLockManager.js';
import { MemoryGovernance } from '@/agent/managers/memoryGovernance.js';
import {
  ArchiveCoordinator,
  type ArchiveTriggerOptions,
} from '@/agent/managers/archiveCoordinator.js';
import {
  TypedEventEmitter,
  type AgentEventMap,
  AGENT_EVENTS,
  AGENT_EVENT_SET,
} from '@/utils/eventEmitter.js';
import type { LlmProvider, Message, ChatOptions } from '@/llm/provider.js';
import type { ProviderRouter } from '@/llm/types.js';
import { logger } from '@/logging/logger.js';
import type { AgentMetrics } from '@/agent/tracer.js';
import {
  getBackgroundTaskStats as readBackgroundTaskStats,
  awaitBackgroundTasks,
} from '@/utils/backgroundTask.js';
import type { BackgroundTaskStats } from '@/utils/backgroundTask.js';

// ─── 模块级常量 ─────────────────────────────────────────

// ─── Agent 门面类 ───────────────────────────────────────

/**
 * Memora Agent 门面类
 *
 * 单 Agent，单配置，单记忆：每个实例拥有独立的对话管线、消息历史与运行时状态。
 * 多实例只需 dataDir 不同即可彻底隔离记忆库与会话；forkSession() 分叉对话历史但记忆索引全局共享。
 * skill 为当轮实时注入，不跨轮缓存。
 */
export class Agent extends TypedEventEmitter<AgentEventMap> {
  // 构造参数分组
  #config: AgentConfig;
  /** 前台 Provider（独立字段，因 setProvider() 可变） */
  #provider: LlmProvider;
  /** 后台 Provider（独立字段，因 setBackgroundProvider() 可变） */
  #backgroundProvider: LlmProvider | null;
  /** Provider 路由选择器（多模型路由基础，可选） */
  #providerRouter: ProviderRouter | null = null;

  // 运行时组件（init 后填充）——宿主 getter 契约字段（projects/memory/works/polish/sessionManager 等）保持独立
  private projectManager: ProjectManager | null = null;
  private history: MessageHistory | null = null;
  private loop: AgentLoop | null = null;
  private toolExec: ToolExecutor | null = null;

  // 新模块
  private skillManager: SkillManager | null = null;
  /** 角色包管理器（角色+技能+规则的唯一真理源） */
  private _rolePackManager: RolePackManager | null = null;

  // 拆分出的专职 Manager
  private memoryInspector: MemoryInspector | null = null;
  /** 记忆治理统一门面（L0/L1/L2/L3 + 诊断） */
  private _governance: MemoryGovernance | null = null;
  /** TextPolishManager（文本润色管理器，LLM 语法修正 + 表达优化） */
  private textPolisher: TextPolishManager | null = null;
  /** 会话管理器（从 Agent 拆分出的会话管理职责） */
  private _sessionManager: SessionManager | null = null;
  /** WorkProjectionManager（作品投影极简 JSON 索引，宿主经 works getter 消费） */
  private workProjection: WorkProjectionManager | null = null;

  // ─── 纯内部组件聚合（无宿主 getter 契约，init 后填充、close 统一清空） ───
  /**
   * 内部组件聚合对象——收敛 12 个「仅门面内部消费、不对宿主暴露」的专职组件，
   * 减少门面扁平字段数；宿主 getter 契约字段（memory/works/polish 等）不在此列。
   */
  private internals: {
    /** 语义去重管理器（L1 LLM 记忆治理，从 MemoryInspector 拆出，令其回归纯存储读写） */
    dedupManager: DedupManager | null;
    /** 记忆顾问（L3 冲突检测 / sourceHealth / suggest，经 governance 门面统一暴露） */
    memoryAdvisor: MemoryAdvisor | null;
    /** SessionArchiver（会话归档器，负责生成/更新 SessionMeta） */
    sessionArchiver: SessionArchiver | null;
    /** 会话命名器（新建会话首次问答自动命名标题） */
    sessionNamer: SessionNamer | null;
    /** 轮次摘要生成器（记忆即摘要架构） */
    roundSummaryGenerator: RoundSummaryGenerator | null;
    /** 输入增强管线（角色/记忆/技能增强，Agent 只保留编排调用点） */
    contextPreparer: ContextPreparer | null;
    /** 检查点恢复协议（温记忆召回 / 契约重注入 / 任务表预判，Agent 保留公开 API 委托） */
    checkpointRestoreCoordinator: CheckpointRestoreCoordinator | null;
    /** 四级补全器（四元组 + 三源融合，不中断工作模型 v2.0） */
    composer: Composer | null;
    /** chat() 并发锁管理器（并发锁 + token 校验 + 超时保护 + 外部 signal 合并，init 时创建、close 时销毁） */
    chatLockManager: ChatLockManager | null;
    /** 归档协调器（归档操作委托给 ArchiveCoordinator） */
    archiveCoordinator: ArchiveCoordinator | null;
    /**
     * 种子闭环编排器（最小执行闭环唯一编排真理源）：prepare → act → reflect → handoff。
     * chat() 委托 run()；processEvent()/resumeExecution() 按路径复用单阶段能力。
     * 经 getParts() getter 取当前组件——rebuildComponents 更换组件后仍取到最新引用。
     */
    seedOrchestrator: SeedOrchestrator | null;
    /** 孤儿 Round 垃圾回收服务（引用计数归零 + 超龄才清理，init 时启动周期任务、close 时停止） */
    gcService: GCService | null;
  } = {
    dedupManager: null,
    memoryAdvisor: null,
    sessionArchiver: null,
    sessionNamer: null,
    roundSummaryGenerator: null,
    contextPreparer: null,
    checkpointRestoreCoordinator: null,
    composer: null,
    chatLockManager: null,
    archiveCoordinator: null,
    seedOrchestrator: null,
    gcService: null,
  };

  private _initialized = false;
  // 项目上下文（AgentContext 与 ProjectContext 等价，直接使用后者避免重复字段）
  private pctx: ProjectContext | null = null;

  /** 最近一次 chat() 调用的时间戳 */
  private _lastInteractionAt: Date | null = null;
  /**
   * 对话中因 chatLock 冲突暂存的配置重载请求（锁释放后补执行，兑现"对话后自动加载"）；
   * 用 Set 去重——同一 source 只需补执行一次。
   */
  private pendingConfigReload = new Set<string>();

  constructor(opts: AgentOptions) {
    super();
    this.#config = {
      projectPath: opts.projectPath,
      dataDir: opts.dataDir!,
      registryDir: opts.registryDir,
      maxContextTokens: opts.maxContextTokens ?? AGENT_CONSTANTS.DEFAULT_MAX_CONTEXT_TOKENS,
      permission: opts.permission ?? 'owner',
      allowedPaths: opts.allowedPaths ?? [],
      confirmWrites: opts.confirmWrites ?? false,
      vectorStore: opts.vectorStore,
      recallExcludeSources: opts.recallExcludeSources ?? [
        ...AGENT_CONSTANTS.DEFAULT_RECALL_EXCLUDE_SOURCES,
      ],
      storage: opts.storage,
      sessionStore: opts.sessionStore,
      roundStore: opts.roundStore,
      configDir: opts.configDir,
      // 启动时激活的角色包名（宿主注入持久化值，init 时优先激活）
      activeRolePack: opts.activeRolePack,
      tracer: opts.tracer,
      messages: opts.messages,
      enableContextSummary: opts.enableContextSummary ?? true,
      archiveMode: opts.archiveMode ?? 'full',
      webSearchProvider: opts.webSearchProvider,
      fetchProvider: opts.fetchProvider,
      codeExecutionProvider: opts.codeExecutionProvider,
      fileConsistencyCheck: opts.fileConsistencyCheck,
      // 宿主审批/审计/参数改写通道，透传供装配阶段与内部幂等检查组合为一处执行前检查点
      preExecutionCheck: opts.preExecutionCheck,
    };
    this.#provider = opts.provider;
    this.#backgroundProvider = opts.backgroundProvider ?? null;
    this.#providerRouter = opts.providerRouter ?? null;
    // 如需自定义日志，请在创建 Agent 前调用 `import { setLogger } from '@zooique/memora'` 全局设置
  }

  // ─── 生命周期 ─────────────────────────────────────────

  /**
   * 初始化 Agent：加载索引、组装内部组件
   */
  async init(projectPathOverride?: string): Promise<ProjectContext> {
    await this.disposePreviousInstance();

    if (projectPathOverride) {
      this.#config.projectPath = projectPathOverride;
    }

    const pctx = await this.initializeProject();
    await this.assembleComponents(pctx);
    this.pctx = pctx;

    this.validateCoreComponents();
    this.createPostInitComponents(pctx);

    // 标记初始化完成，后续 restoreFromCheckpoint 依赖此标志
    this._initialized = true;

    // 注册暂停超时归档；必须先于 loadPersistedCheckpoint()，否则启动路径的超时事件无人接收
    this.registerPauseTimeoutArchiver();
    this.registerWorkProjectionRefresh();

    // 加载持久化的会话检查点；若上次会话在暂停/异常中关闭，加载后恢复状态机；
    // 若为 paused 还需恢复热记忆 + 温记忆召回 + 契约重注入（重启后上下文完整）
    const persistedCheckpoint = this._sessionManager?.loadPersistedCheckpoint();
    if (persistedCheckpoint && persistedCheckpoint.status === 'paused') {
      await this.restoreFromCheckpoint(persistedCheckpoint);
    }

    return pctx;
  }

  /**
   * 登记作品投影实时刷新处理器：register_work 工具 / 右键登记成功后，
   * 内核 WorkProjectionManager 触发 workProjectionGenerated 事件（携带已写入内存 entries 的投影），
   * 立即重建 AgentLoop 的 systemPromptPrefix，使 AI 在下一轮对话即可感知新索引——
   * 否则需切角色包 / reloadConfig / 开新会话才生效（见作品投影复盘 P1）。
   * 与 registerPauseTimeoutArchiver 同生命周期（init 内注册，close 的 removeAllListeners 兜底）。
   */
  private registerWorkProjectionRefresh(): void {
    this.on(AGENT_EVENTS.workProjectionGenerated, () => {
      this.refreshRolePackPrefixOnLoop();
    });
  }

  /**
   * 注册暂停超时归档处理器（SessionManager 两条超时路径——启动加载与运行时定时器——统一在此消费）
   * 注册在 init() 内（close() 的 removeAllListeners + init 起始的 disposePreviousInstance 保证实例周期内恰好一个监听器），
   * 挂在生命周期稳定的 Agent 上，rebuildComponents() 重建管理器后仍有效。
   */
  private registerPauseTimeoutArchiver(): void {
    this.on(AGENT_EVENTS.sessionPauseTimedOut, (payload) => {
      // 清理残留 pending 暂停态（checkPauseTimeout 已复位状态机，但 pendingPauseReason 可能遗留），
      // 否则下次 requestPause() 会被幂等检查静默忽略
      this._sessionManager?.cancelPendingPause();

      const { sessionId, date, session } = payload;
      if (!date || !session) return;
      // fire-and-forget：归档失败不阻塞主流程，仅记录
      this.internals.archiveCoordinator
        ?.archiveSession(date, session, { autoTriggered: true })
        .catch((err) => {
          logger.warn({ err, sessionId }, '暂停超时会话自动归档失败');
        });
    });
  }

  /**
   * 关闭旧实例（如果已初始化），失败不阻塞重建
   */
  private async disposePreviousInstance(): Promise<void> {
    if (!this._initialized) return;
    try {
      await this.close();
    } catch (err) {
      logger.warn({ err }, 'init() 中 close() 旧实例失败，继续重建');
    }
  }

  /**
   * 创建 ProjectManager 并初始化项目上下文
   */
  private async initializeProject(): Promise<ProjectContext> {
    this.projectManager = new ProjectManager({
      dataDir: this.#config.dataDir,
      storage: this.#config.storage,
      registryDir: this.#config.registryDir,
      // SecurityGuard 由 Agent 层创建，解除 memory→security 反向依赖
      createSecurityGuard: (
        projectPath: string,
        memoraDir: string,
        configDir?: string,
        agentDataDir?: string,
      ) =>
        new SecurityGuard(
          projectPath,
          memoraDir,
          this.#config.allowedPaths,
          this.#config.confirmWrites,
          this.#config.permission,
          configDir ?? this.#config.configDir,
          agentDataDir ?? this.#config.dataDir,
        ),
    });

    return this.projectManager.initProject(
      this.#config.projectPath,
      undefined,
      this.#config.configDir,
    );
  }

  /**
   * 校验核心组件（loop / history）非空
   */
  private validateCoreComponents(): void {
    if (!this.loop || !this.history) {
      throw configError(
        'Agent 初始化失败',
        '组件组装后 loop 或 history 为空（可能 assembleComponents 抛异常被静默吞掉）',
        [
          '检查 assembleComponents() 是否有未捕获的异常',
          '检查传入的 provider 参数是否有效',
          '确认 API Key 已配置（环境变量或配置文件）',
        ],
      );
    }
  }

  /**
   * 创建 init() 后期组件（初始化完成后才需要的组件）
   */
  private createPostInitComponents(_pctx: ProjectContext): void {
    // chat() 并发锁管理器（生命周期与 Agent 实例一致）
    this.internals.chatLockManager = new ChatLockManager();

    // 孤儿 Round 垃圾回收服务：roundStore+storage 均为构造期稳定注入（不随 rebuildComponents 变化），
    // 每日周期清理 refCount=0 且超龄的孤立问答闭环（崩溃残留 pending / 已删会话遗留），防止存储膨胀。
    // shouldSkip：对话进行中跳过本次（minAgeMs 判龄对长任务不可靠，防进行中轮被误清）
    if (this.#config.roundStore && this.#config.storage) {
      this.internals.gcService = createDefaultGCService(
        this.#config.roundStore,
        this.#config.storage,
        // 忙碌检查：chatLock busy = 对话/长任务进行中，跳过本次 GC
        () => this.internals.chatLockManager?.isBusy ?? false,
        // 摘要 purge 时同步删向量索引
        this.#config.vectorStore ?? undefined,
      );
      this.internals.gcService.startPeriodic(AGENT_CONSTANTS.GC_INTERVAL_MS);
    }

    // 四级补全器（不中断工作模型 v2.0）
    this.internals.composer = new Composer();

    // 归档操作委托给 ArchiveCoordinator（content 会话归档）
    this.internals.archiveCoordinator = new ArchiveCoordinator({
      getSessionArchiver: () => this.internals.sessionArchiver,
      getArchiveMode: () => this.#config.archiveMode,
      emit: (event, payload) => this.emit(event, payload),
    });

    // 会话命名器：新建会话首次问答自动命名标题；惰性获取当前 provider（切换后仍命中最新模型）
    // 注入 onTitleUpdated 回调：标题生成后发射 sessionTitleUpdated 事件，宿主据此刷新 UI
    this.internals.sessionNamer = new SessionNamer({
      getProvider: () => this.#provider,
      sessionStore: this.#config.sessionStore,
      onTitleUpdated: (sessionId, title) => {
        this.emit(AGENT_EVENTS.sessionTitleUpdated, { sessionId, title });
      },
    });

    // 记忆治理统一门面（去重 / 冲突 / 诊断）
    this._governance = new MemoryGovernance(
      this.internals.dedupManager,
      this.internals.memoryAdvisor,
    );

    // 种子闭环编排器（最小执行闭环唯一编排真理源）：依赖 sessionManager/loop/history 等
    // 均已就绪（assembleComponents 已完成 + sessionNamer 本方法前段创建），在此构造一次。
    // getParts() 惰性取当前组件——rebuildComponents（switchProject）更换组件后仍取到最新引用。
    this.internals.seedOrchestrator = this.createSeedOrchestrator();
  }

  /**
   * 构造种子闭环编排器，注入门面稳定能力（getParts 快照 + 工具暴露 + 流收口协议）
   *
   * 构造偏好在 agent.ts 而非 assembler.ts（方案的"assembler 构造"）：seed 依赖
   * sessionNamer（post-init 才创建）与 consumeExecutionStream（门面私有流收口协议），
   * 二者均无法在 assembler 阶段就绪，故收敛到 post-init 门面组装处。
   *
   * @returns 已接线门面能力的 SeedOrchestrator
   */
  private createSeedOrchestrator(): SeedOrchestrator {
    return new SeedOrchestrator({
      // 组件快照经 getter 惰性取当前引用：rebuildComponents 更换组件后仍读到最新（关键）
      getParts: () => ({
        loop: this.loop!,
        history: this.history!,
        sessionManager: this._sessionManager,
        rolePackManager: this._rolePackManager,
        contextPreparer: this.internals.contextPreparer!,
        sessionNamer: this.internals.sessionNamer,
        roundSummaryGenerator: this.internals.roundSummaryGenerator,
        checkpointRestoreCoordinator: this.internals.checkpointRestoreCoordinator,
      }),
      tracer: this.#config.tracer ?? null,
      archiveMode: this.#config.archiveMode,
      messages: this.#config.messages,
      // 门面私有能力经回调注入 seed（物理实现仍在门面）
      applyRolePackToolExposure: () => this.applyRolePackToolExposure(),
      consumeExecutionStream: (source) => this.consumeExecutionStream(source),
      getBackgroundProvider: () => this.#backgroundProvider,
    });
  }

  /**
   * 流式对话（核心 API）
   */
  async *chat(input: string, signal?: AbortSignal): AsyncGenerator<AgentChunk, void, unknown> {
    this.assertInitialized('chat');
    this.validateChatInput(input);

    const lockCtx = this.acquireChatLock(signal);
    const { myToken, combinedSignal, cleanupExternalSignal } = lockCtx;
    try {
      // 状态机翻转是副作用，必须在并发闸门内执行——PAUSED 态收到 chat = 自动恢复 + 继续（作为补充注入）；ERROR 态仍拒绝
      if (!this.autoResumeIfPaused()) {
        yield { type: 'error', message: '会话已超时，无法自动恢复，请重新开始新对话' };
        return;
      }
      this._lastInteractionAt = new Date();

      // 委托种子编排器：对话路径完整闭环（prepare → act → reflect → handoff）
      yield* this.internals.seedOrchestrator!.runChat(input, combinedSignal);
    } finally {
      // 仅当本调用仍是当前锁持有者时才清理资源（token 校验）
      this.internals.chatLockManager?.release(myToken);
      cleanupExternalSignal();
      // 补执行对话期间暂存的配置重载请求
      await this.flushPendingConfigReload();
    }
  }

  /**
   * 校验 chat 输入
   */
  private validateChatInput(input: string): void {
    if (input.length > AGENT_CONSTANTS.CHAT_INPUT_MAX_LENGTH) {
      throw configError(
        '输入过长',
        `输入超过最大长度限制（${AGENT_CONSTANTS.CHAT_INPUT_MAX_LENGTH / 1024}KB）`,
        ['缩短输入内容', '分多次对话发送'],
      );
    }
  }

  /**
   * 获取对话锁 — 返回锁上下文
   */
  private acquireChatLock(signal?: AbortSignal) {
    const chatLock = this.internals.chatLockManager;
    if (!chatLock) throw configError('ChatLockManager', 'ChatLockManager 未初始化', []);
    if (chatLock.isBusy) {
      throw chatBusyError('发起新对话');
    }
    const { token: myToken, internalAbort } = chatLock.acquire(
      AGENT_CONSTANTS.CHAT_LOCK_TIMEOUT_MS,
    );
    const cleanupExternalSignal = chatLock.attachExternalSignal(signal, internalAbort);
    return { myToken, internalAbort, cleanupExternalSignal, combinedSignal: internalAbort.signal };
  }

  /**
   * 补执行对话期间暂存的配置重载请求
   */
  private async flushPendingConfigReload(): Promise<void> {
    if (this.pendingConfigReload.size === 0) return;
    const pending = Array.from(this.pendingConfigReload);
    this.pendingConfigReload.clear();
    for (const src of pending) {
      try {
        await this.reloadConfig(src);
        this.emit(AGENT_EVENTS.configReloaded, { source: src });
      } catch (err) {
        logger.warn({ err, source: src }, '补执行配置重载失败');
      }
    }
  }

  /**
   * 强制释放对话锁
   *
   * 宿主在"无进展超时"确认 generator 挂起后调用，使用户能立即发起新对话（否则需等锁超时）。
   * 安全机制委托 ChatLockManager.forceRelease：递增 token 让原 chat() 的 finally 跳过清理、abort signal 让响应点退出；
   * 原 generator 仍可能后台运行但不影响新调用。幂等（未忙时 no-op）。
   */
  forceReleaseChatLock(): void {
    this.internals.chatLockManager?.forceRelease();
  }

  /**
   * 发送用户消息，非流式返回完整回复
   */
  async chatSync(input: string, signal?: AbortSignal): Promise<string> {
    let result = '';
    for await (const chunk of this.chat(input, signal)) {
      if (chunk.type === 'text') {
        result += chunk.content;
      }
    }
    return result;
  }

  // ─── 不中断工作模型 v2.0：公开 API ──────────────────────

  /**
   * 处理增量事件（不中断工作模型核心入口）
   *
   * 替代 chat() 的结构化输入接口，接收 SessionEvent 按意图路由，与 chat() 共享同一并发锁（互斥调用）。
   *
   * @param event - 增量事件（含意图分类 + 内容 + 可选四元组增量）
   * @param signal - 可选的 AbortSignal
   * @yields AgentChunk 事件流
   */
  async *processEvent(
    event: SessionEvent,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentChunk, void, unknown> {
    this.assertInitialized('processEvent');
    this.validateChatInput(event.content);

    // auto-resume 必须在锁内执行（状态机翻转是副作用，须先通过并发闸门）：
    // PAUSED 态收到用户事件=自动恢复+作为补充注入继续；command 事件不触发自动恢复；ERROR 态仍拒绝。
    // 旧顺序（autoResume 先于加锁）会让锁忙时状态机已翻 RUNNING、异常被静默吞掉——故先加锁。
    const lockCtx = this.acquireChatLock(signal);
    const { myToken, combinedSignal, cleanupExternalSignal } = lockCtx;

    try {
      if (!this.autoResumeIfPaused(event.type)) {
        throw configError('会话超时', '暂停超时无法自动恢复，请重新开始新对话', []);
      }
      this._lastInteractionAt = new Date();

      // 四级补全：将 SessionEvent.delta 与当前检查点融合
      const checkpoint = this._sessionManager?.getCheckpoint();
      if (checkpoint && this.internals.composer) {
        // 收集计划上下文（执行计划管理）
        const sm = this._sessionManager!;
        const planCtx: PlanContext | undefined =
          checkpoint.plan.length > 0
            ? {
                stalled: sm.isPlanStalled(),
                activeStep: sm.getActiveStep()?.description,
                pendingStep: sm.getNextPendingStep()?.description,
              }
            : undefined;

        const composeResult = this.internals.composer.compose(event, checkpoint, planCtx);

        // 必须先应用已确定槽位（applyResolvedDelta 对 P4_CLARIFY 槽位有守卫），再处理 P4 澄清，
        // 否则本轮增量（如 correction 的 delta.role）随暂停丢弃，解析成果丢失
        this.applyResolvedDelta(composeResult.resolved);

        // P4 澄清问题处理：存在需澄清槽位时暂停等用户回答
        if (composeResult.needClarify && composeResult.needClarify.length > 0) {
          // P4 防滥用：连续高风险暂停达上限时过滤高风险问题、降级 P3 兜底（低风险仍可确认，不计入连续计数）
          const sm = this._sessionManager;
          if (sm && sm.isPauseLimitReached()) {
            const highRiskQuestions = composeResult.needClarify.filter((q) => !q.lowRisk);
            if (highRiskQuestions.length > 0) {
              logger.warn(
                {
                  consecutivePauseCount: sm.getConsecutivePauseCount(),
                  filteredCount: highRiskQuestions.length,
                },
                '连续高风险暂停已达上限，强制降级 P3 兜底',
              );
              composeResult.needClarify = composeResult.needClarify.filter((q) => q.lowRisk);
            }
          }

          // 过滤后仍有剩余问题（低风险）→ 正常暂停流程
          if (composeResult.needClarify.length > 0) {
            for (const q of composeResult.needClarify) {
              yield { type: 'text', content: `[需澄清] ${q.question}` };
            }
            this.emit(
              AGENT_EVENTS.needClarify,
              composeResult.needClarify.map((q) => ({
                slot: q.slot,
                question: q.question,
                options: q.options,
              })),
            );
            // 全为低风险才不计入连续暂停计数——用 every：只要存在高风险，本次暂停就确实在索取确认、应消耗配额；
            // some 会让混合场景免费逃逸计数，反向打开滥用面。
            const allLowRisk = composeResult.needClarify.every((q) => q.lowRisk);
            const clarifyReason = `需要澄清：${composeResult.needClarify
              .map((q) => q.question)
              .join('; ')}`;
            this.pause(clarifyReason, 'agent', allLowRisk);
            // P4 直接暂停不经流收口（无 paused chunk）→ 在此补写 pauseMeta，与流中暂停路径一致
            this._sessionManager?.setPauseMeta({ reason: clarifyReason, source: 'agent' });
            yield { type: 'done' };
            return;
          }
          // 高风险问题已被过滤降级、无剩余 → 继续执行（不暂停）
        }
      }

      // 意图分类防污染：command/correction 属控制/元信息，不写 chat 历史；
      // clarify 例外——回答已经 compose 应用至检查点、入口已 auto-resume，转 chat 语义继续执行，
      // 且需重置连续暂停计数恢复防滥用机制
      if (event.type === 'clarify') {
        this._sessionManager?.resetConsecutivePauseCount();
        event = { type: 'chat', content: this.formatClarifyAnswers(event.content), delta: {} };
      } else if (event.type !== 'chat') {
        yield* this.handleNonChatEvent(event, combinedSignal);
        return;
      }

      // ── chat 事件正常流程（写历史、后处理） ──────────────
      // 委托种子编排器：SessionEvent 路径闭环（prepare → 任务表预判注入 → act(processEvent)
      // → reflect → handoff）；任务表预判与流消费均收在编排器内，门面只做一行委托。
      yield* this.internals.seedOrchestrator!.runEvent(event, event.content, combinedSignal);
    } finally {
      this.internals.chatLockManager?.release(myToken);
      cleanupExternalSignal();
      await this.flushPendingConfigReload();
    }
  }

  /**
   * 软暂停后续跑（不中断工作模型 v2.1）
   *
   * 翻状态机为 RUNNING（触发 sessionResumed → 宿主转发 STATUS{running}），
   * 驱动 loop.continueAfterPause 续跑并转发 chunk，完成后追加历史 + 后处理（同 chat 尾处理）。
   * 硬停止（signal.abort）仍是唯一霸道中止路径，与软暂停严格区分。
   *
   * @param input - 可选补充输入（空=续跑原路径；有=注入修正后续轮）
   * @param signal - 可选 AbortSignal（硬停止仍走此路径）
   */
  async *resumeExecution(
    input?: string,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentChunk, void, unknown> {
    const resumeStatus = this._sessionManager?.status;
    // 错误态续跑须明确失败而非静默吞没：error 态由检查点恢复回填进入，运行时异常走
    // yield { type: 'error' } 不翻状态机，生产链路不会自然离开，必须显式提示重新开始
    if (resumeStatus === 'error') {
      this.emit(AGENT_EVENTS.sessionResumeFailed, {
        sessionId: this._sessionManager?.getCheckpoint()?.sessionId,
        reason: '会话处于错误态，无法续跑',
      });
      yield { type: 'error', message: '当前会话处于错误态，无法续跑，请重新开始' };
      return;
    }
    if (resumeStatus !== 'paused') return;

    // resumeExecution 与 chat() 同构，必须加并发锁
    const lockCtx = this.acquireChatLock(signal);
    const { myToken, combinedSignal, cleanupExternalSignal } = lockCtx;
    try {
      // 翻状态机为 RUNNING（触发 sessionResumed）
      if (!this.resume()) {
        // resume() 返回 false 时 yield error + 发事件，让宿主感知失败原因而非静默吞没
        this.emit(AGENT_EVENTS.sessionResumeFailed, {
          sessionId: this._sessionManager?.getCheckpoint()?.sessionId,
          reason: 'resume() 返回 false，可能因暂停超时或状态机拒绝',
        });
        yield { type: 'error', message: '会话已超时，无法自动恢复，请重新开始新对话' };
        return;
      }

      // 预判短路：计划停滞 + 无新输入 + 非自主工具步 → 无需续跑直接提示，避免浪费 token 调 LLM
      if (!input) {
        const sm = this._sessionManager!;
        if (sm.isPlanStalled() && !this.requireLoop.isInAutonomousStep) {
          // 区分"已完成"与"全部阻塞"——blocked ≠ done，避免误导用户以为任务已完成而实际一步未成
          const plan = sm.getCheckpoint()?.plan ?? [];
          const allDone = plan.length > 0 && plan.every((s) => s.status === 'done');
          const allBlocked = plan.length > 0 && plan.every((s) => s.status === 'blocked');
          yield {
            type: 'text',
            content: allDone
              ? '所有计划步骤已完成，请提供下一步指令'
              : allBlocked
                ? '计划步骤当前全部处于阻塞状态，无法自动推进。请提供新指令或修改计划'
                : '所有计划步骤已完成，请提供下一步指令',
          };
          yield { type: 'done' };
          return;
        }
      }

      // 委托种子编排器：续跑路径闭环（act(continueAfterPause) → reflect；无回答前、无 Handoff），
      // 预判短路与锁/状态机守卫留在门面，执行语义收在编排器内。
      yield* this.internals.seedOrchestrator!.runResume(input, combinedSignal);
    } finally {
      // 与 chat() 同构：释放锁 + 清理外部 signal
      this.internals.chatLockManager?.release(myToken);
      cleanupExternalSignal();
    }
  }

  /**
   * 消费执行流的单一真理源
   *
   * chat（processEvent）与续跑（continueAfterPause）此前各持一份同构消费逻辑且已实证漂移
   * （续跑漏 paused 分支导致三方分叉）；收口于此，新增 chunk 类型只需改一处。
   * 暂停幂等锁的释放放 finally——清理是"退出本作用域的不变式"而非某分支动作，新增 return 分支无遗漏。
   *
   * @returns 消费结果；failed 为 true 时调用方应立即 return（错误 chunk 已 yield）
   */
  private async *consumeExecutionStream(
    source: AsyncGenerator<AgentChunk, void, unknown>,
  ): AsyncGenerator<AgentChunk, { content: string; aborted: boolean; paused: boolean; failed: boolean; iterationLimitReached?: boolean }, unknown> {
    let content = '';
    let aborted = false;
    // 软暂停标记：loop 在迭代边界挂起（用户 requestPause / [ASK] 主动提问）时置真，
    // 供编排器据此推迟摘要——回合未完成不产摘要，保摘要与外部输入 1:1
    let paused = false;
    // 迭代上限标志：loop 因 maxIterations/stepBudget 上限而终止时置真
    let iterationLimitReached = false;

    try {
      for await (const chunk of source) {
        // 内核事实驱动：loop 在迭代边界真正挂起时状态机才翻 PAUSED，非申请即翻转；
        // 与 requestPause 空闲分支同源，须传 lowRisk=true 保持同一暂停事件契约（否则流中暂停计入 P4 配额）
        if (chunk.type === 'paused') {
          const pendingInfo = this._sessionManager?.consumePendingPause();
          // 暂停收口统一写 pauseMeta：reason/source 取自 pendingPause（与状态机一致）。
          // [ASK] 主动提问等"直接暂停路径"不走 loop.onPaused，在此自然补齐，
          // 重启后宿主可展示"为什么暂停 + 问了什么"
          const pauseReason = pendingInfo?.reason ?? '用户主动暂停';
          const pauseSource = pendingInfo?.source ?? 'user';
          this.pause(pauseReason, pauseSource, true);
          this._sessionManager?.setPauseMeta({ reason: pauseReason, source: pauseSource });
          paused = true;
        }
        yield chunk;
        if (chunk.type === 'text') {
          content += chunk.content;
        } else if (chunk.type === 'aborted') {
          aborted = true;
        }
      }
    } catch (err) {
      if (isAbortError(err)) {
        yield { type: 'aborted', reason: 'User cancelled the conversation' };
      } else {
        yield { type: 'error', message: err instanceof Error ? err.message : String(err) };
      }
      return { content, aborted, paused, failed: true, iterationLimitReached };
    } finally {
      // 释放暂停幂等锁覆盖三路——残留会让 requestPause 的幂等检查永久拒绝后续暂停请求
      this._sessionManager?.cancelPendingPause();
      // 同步清理 loop 的 pauseRequested 标志
      this.requireLoop.clearPauseRequest();
    }

    // 检查 loop 是否因迭代/步数上限而终止（兼容 mock）
    iterationLimitReached = this.requireLoop.isIterationLimitReached?.() ?? false;

    return { content, aborted, paused, failed: false, iterationLimitReached };
  }

  /**
   * 处理非 chat 事件（command/correction/clarify 不写 chat 历史、不触发后处理，
   * 经 onSessionEvent 回调同步状态机），避免控制/元信息污染对话流
   */
  private async *handleNonChatEvent(
    event: SessionEvent,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<AgentChunk, void, unknown> {
    for await (const chunk of this.requireLoop.processEvent(event, undefined, signal)) {
      yield chunk;
    }
  }

  /**
   * 将澄清回答 JSON 格式化为可读文本（clarify → chat 转换用）
   * 宿主将回答序列化为 [{slot, answer}, ...] JSON，此处解析为自然语言；解析失败原样返回（降级不阻断）。
   */
  private formatClarifyAnswers(content: string): string {
    const slotLabels: Record<string, string> = {
      role: '角色',
      task: '任务',
      standard: '标准',
      resource: '资源',
    };
    try {
      const answers = JSON.parse(content) as Array<{ slot: string; answer: string }>;
      if (Array.isArray(answers) && answers.length > 0) {
        return answers.map((a) => `${slotLabels[a.slot] ?? a.slot}：${a.answer}`).join('；');
      }
    } catch {
      // JSON 解析失败：原样返回，不阻断后续流程
    }
    return content;
  }

  /**
   * 暂停会话（用户/Agent/系统均可触发，暂停前自动创建检查点）
   * @param lowRisk 低风险暂停不计入 P4 连续暂停计数（默认 false）
   */
  pause(reason: string, source: 'user' | 'agent' | 'system' = 'user', lowRisk = false): boolean {
    this.assertInitialized('pause');
    return this.requireSessionManager.pause(reason, source, lowRisk);
  }

  /**
   * 恢复会话（从 PAUSED 恢复到 RUNNING）
   */
  resume(): boolean {
    this.assertInitialized('resume');
    return this.requireSessionManager.resume();
  }

  /**
   * 自动恢复暂停状态（chat() 与 processEvent() 共用）：
   * ERROR 态直接 throw（拒绝，须先 recover 保持状态一致）；PAUSED 态尝试自动恢复。
   * 双通道：暂停只停"工作通道"，PAUSED 收到用户事件=自动恢复+继续；command 事件不触发自动恢复。
   * resumeExecution() 不调用本方法（有独立短路逻辑）。
   *
   * @returns true=恢复成功或无需恢复；false=恢复失败（暂停超时等）
   */
  private autoResumeIfPaused(eventType?: string): boolean {
    const sm = this._sessionManager;
    if (!sm) return true;
    const status = sm.status;
    if (status === 'error') {
      throw configError('会话异常', '会话处于异常状态，无法接收新消息', [
        '先标记 error.recovered=true 并调用 agent.recover()',
      ]);
    }
    if (status === 'paused' && eventType !== 'command') {
      return this.resume();
    }
    return true;
  }

  /**
   * 请求软暂停（不中断工作模型 v2.1）
   *
   * 仅设 loop 的 pauseRequested 标志（在下一迭代边界挂起，不 abort），reason/source 暂存到 SessionStateMachine。
   * 状态机翻 PAUSED 延后到 loop 边界真正挂起时——内核事实驱动而非申请即翻转；与硬停止（abort）严格区分，
   * 软暂停保留历史、可经 resumeExecution 续跑。
   *
   * @returns true=请求已注册（下一迭代边界生效）；false=无法暂停
   */
  requestPause(reason: string, source: 'user' | 'agent' | 'system' = 'user'): boolean {
    this.assertInitialized('requestPause');

    const sm = this._sessionManager;
    if (!sm) return false;

    // 状态机阻止：已暂停/已异常时禁止再申请暂停
    const status = sm.status;
    if (status === 'paused') {
      logger.debug('requestPause 忽略：会话已处于暂停状态');
      return false;
    }
    if (status === 'error') {
      logger.debug('requestPause 忽略：会话处于异常状态，无法暂停');
      return false;
    }

    // 无活跃流时延迟翻转没有消费方（finally 不会执行，pending 会永驻锁死幂等）→ 直接同步翻状态机，
    // 这是"内核事实驱动延迟翻转"的正当例外：无流可延迟
    if (!this.isBusy) {
      // 用户主动暂停不消耗 P4 连续暂停配额 → lowRisk=true
      this.pause(reason, source, true);
      return true;
    }

    // 委托 SessionStateMachine 管理 pending 暂停状态（含幂等检查）
    if (!sm.requestPause(reason, source)) {
      logger.debug('requestPause 忽略：已有待处理的暂停请求');
      return false;
    }

    this.requireLoop.requestPause();
    return true;
  }

  /**
   * 取消待处理的软暂停请求：清空 loop 的 pauseRequested 标志（与 requestPause 对称），
   * 并同步清理 SessionStateMachine 的 pending 暂停状态。
   */
  cancelPauseRequest(): void {
    this.assertInitialized('cancelPauseRequest');
    this.requireLoop.clearPauseRequest();
    this._sessionManager?.cancelPendingPause();
  }

  /**
   * 是否存在待处理的暂停申请（申请已发、尚未在 loop 边界挂起）
   *
   * 供宿主 UI 区分三态：无申请（暂停）/ 申请在途（取消暂停）/ 已暂停（继续）。
   * 状态真理源 SessionStateMachine.isPausePending()：流中 requestPause 置位、边界挂起后 consumePendingPause 消费、
   * cancelPauseRequest 主动清理；空闲态 requestPause 直接翻 PAUSED（不置位 pending）——精确表达"申请在途"。
   */
  isPausePending(): boolean {
    return this._sessionManager?.isPausePending() ?? false;
  }

  /**
   * 执行中插话
   *
   * 在 LLM 执行过程中插入用户输入并中断当前调用，注入下一轮继续处理。
   * 与 requestPause 区别：requestPause 在边界挂起保留上下文待续跑；interject 立即中断、注入新内容继续，用户无感知
   * （调用链：Agent.interject → AgentLoop.interject → abort interjectController → 消费 pendingInterjections → 注入 user 消息继续循环）。
   */
  interject(content: string): void {
    this.assertInitialized('interject');
    this.requireLoop.interject(content);
  }

  /**
   * 设置运行时插话模式（无缝 vs 打断）。
   * - 'block'（无缝）：interject() 将输入排队，在下一迭代边界统一注入为 user 消息，不中断当前执行；
   * - 'allow'（默认）：interject() 立即中断当前 LLM/工具调用、注入后继续循环。
   * 宿主若要实现「loop 中直接输入补充内容、不打断执行」的无缝注入，应在发起 chat 前设为 'block'。
   */
  setInputInterrupt(mode: 'allow' | 'block'): void {
    this.assertInitialized('setInputInterrupt');
    this.requireLoop.setStrategy({ inputInterrupt: mode });
  }

  /**
   * 追加计划步骤（SESSION_APPEND_TASK 落点）：在现有 plan 末尾追加新步骤
   */
  appendPlanStep(description: string): number {
    this.assertInitialized('appendPlanStep');
    const sm = this.requireSessionManager;
    return sm.appendPlanStep(description);
  }

  /**
   * 卸载运行态挂载物：清空检查点计划与回合日志（宿主任务流结束/停止/异常广播 idle 前调用），
   * 回到"空闲 = 无挂载物"的资源层常态；会话历史与记忆等资源层内容不受影响。
   */
  clearPlan(): void {
    this.assertInitialized('clearPlan');
    this.requireSessionManager.clearPlan();
  }

  /**
   * 内核→宿主信号：当前会话是否可"无输入续跑"（决定暂停按钮显隐 + 暂停后继续 UI）
   *
   * 真值条件：① 状态机已 paused（已软暂停必可续跑，最高优先级——pauseRequested 在下一迭代边界才挂起，
   * 彼时 inAutonomousStep 已重置为 false，仅看它会误报）；② loop 在自主工具步（可暴露暂停按钮在边界挂起）；
   * ③ 存在未完成的计划步骤（多轮任务可续跑下一轮）。三者皆否（纯单轮、无待续目标）→ 隐藏暂停按钮（仅停止）。
   */
  canContinueWithoutInput(): boolean {
    if (this._sessionManager?.status === 'paused') return true;
    // 错误态不展示"继续"：error 态由检查点恢复回填进入，须显式处理（重新开始或 recover），避免点了静默无反应
    if (this._sessionManager?.status === 'error') return false;
    // 仅 pending/active（可推进）步骤计入"可续跑"——旧判据 s.status!=='done' 把 blocked 也算可续，
    // 与 isPlanStalled（视 blocked 为停滞）反向，导致全 blocked 计划按钮可点但 resumeExecution 早退
    const hasPendingPlan =
      this._sessionManager
        ?.getCheckpoint()
        ?.plan.some((s) => s.status === 'pending' || s.status === 'active') ?? false;
    return this.requireLoop.isInAutonomousStep || hasPendingPlan;
  }

  /**
   * 触发会话异常（公开 API，宿主显式调用）：仅 RUNNING 状态可触发，异常时自动创建检查点保存状态。
   * 生产内部无调用者——运行时异常（LLM 超时/工具失败）走 yield {type:'error'} 事件流不翻状态机；
   * 本 API 供宿主在自定义异常（如外部服务故障）显式触发，或经检查点恢复回填进入 ERROR 态。
   */
  triggerError(cause: string): boolean {
    this.assertInitialized('triggerError');
    return this.requireSessionManager.triggerError(cause);
  }

  /**
   * 从异常恢复：校验恢复条件（error.recovered === true 且 cause 已解除）
   */
  recover(): boolean {
    this.assertInitialized('recover');
    return this.requireSessionManager.recover();
  }

  /**
   * 创建会话检查点：快照当前运行时状态（热记忆、角色、标准等），生成可序列化检查点
   */
  createCheckpoint(mainGoal?: string, role?: Role, standard?: Standard): SessionCheckpoint | null {
    this.assertInitialized('createCheckpoint');
    return this.requireSessionManager.createCheckpoint(mainGoal, role, standard);
  }

  /**
   * 获取当前检查点
   */
  getCheckpoint(): SessionCheckpoint | null {
    this.assertInitialized('getCheckpoint');
    return this.requireSessionManager.getCheckpoint();
  }

  /**
   * 获取最近一次处理线程的工具执行历史（loop/执行闭环域聚合出口，补待办 #3）
   *
   * 数据源自 sessionManager 检查点的 completedToolCalls（已由
   * AGENT_CONSTANTS.COMPLETED_TOOL_CALLS_MAX 做 FIFO 封顶）。本方法剥离「恢复/幂等」内部
   * 语义，提供稳定的 execute 域只读契约——宿主可在透明面板/观测面消费本轮及历史的工具调用
   * 明细（工具名 / 成败 / 结果摘要），与累计 AgentMetrics.tools 互补。
   *
   * @param limit 返回条数上限（默认取封顶上限，超界由调用方控制，取最近 limit 条）
   * @returns 工具执行记录（记录顺序：时间正序即旧→新；无记录返回空数组；返回浅拷贝防宿主改动检查点）
   */
  getRecentToolExecutions(
    limit: number = AGENT_CONSTANTS.COMPLETED_TOOL_CALLS_MAX,
  ): ToolExecutionRecord[] {
    this.assertInitialized('getRecentToolExecutions');
    const calls = this.requireSessionManager.getCheckpoint()?.completedToolCalls;
    if (!calls || calls.length === 0) return [];
    // 取最近 limit 条并浅拷贝，避免宿主引用改动污染检查点（FIFO 封顶后 slice 安全）
    return calls.slice(-limit).map((r) => ({ ...r }));
  }

  /**
   * 向 loop 注入 system 消息
   */
  injectSystemMessage(message: string): void {
    this.requireLoop.injectSystemMessage(message);
  }

  /**
   * 从检查点恢复会话（完整恢复协议）：
   * ① 快照反序列化 + ② 热窗口载入（SessionManager）→ ③ 温记忆按需召回 → ④ 契约重注入；
   * 温记忆召回失败静默降级，仅恢复热窗口和契约，不影响继续对话。
   *
   * @returns 恢复的消息数量
   */
  async restoreFromCheckpoint(checkpoint: SessionCheckpoint): Promise<number> {
    this.assertInitialized('restoreFromCheckpoint');
    // 恢复协议单一真理源：委托 CheckpointRestoreCoordinator（热窗口载入 → 温记忆召回 → 契约重注入）
    return this.internals.checkpointRestoreCoordinator!.restore(checkpoint);
  }

  /**
   * 应用增量解析结果到检查点（P1 增量解析）：角色/标准/任务/资源各槽位独立更新；
   * P4 级别（澄清中）槽位不应用（等待用户回答）。
   */
  private applyResolvedDelta(resolved: ResolvedDelta): void {
    const sm = this._sessionManager;
    if (!sm) return;

    // 应用角色槽（P1→P3 级别才更新，P4 等待用户回答）
    if (resolved.role.source !== COMPLETION_LEVELS.P4_CLARIFY) {
      sm.updateRole(resolved.role.value);
    }

    // 应用任务槽（currentGoal 更新）
    if (resolved.task.source !== COMPLETION_LEVELS.P4_CLARIFY) {
      sm.updateGoal(resolved.task.value);
    }

    // 应用标准槽
    if (resolved.standard.source !== COMPLETION_LEVELS.P4_CLARIFY) {
      sm.updateStandard(resolved.standard.value);
    }

    // 应用资源槽
    if (resolved.resource.source !== COMPLETION_LEVELS.P4_CLARIFY) {
      sm.updateResource(resolved.resource.value);
    }
  }

  /**
   * 从指定 Round 位置分叉当前会话（委托至 SessionManager）：
   * round-based 模式唯一分叉方式——创建新会话，复制 Round ID 列表（指针复制），
   * 新会话是完全平等的普通会话。记忆索引全局共享不受影响。
   *
   * 自动命名场景（未传 targetSession）：分叉后异步触发 SessionNamer 为新会话生成标题
   * （best-effort，不阻塞分叉返回）；用户显式指定会话名时尊重用户命名，不触发 LLM 覆盖。
   *
   * @param roundId - 分叉点的 Round ID（可选；不传默认使用最后一个 Round）
   * @param targetSession - 可选，自定义新会话名
   */
  forkSession(roundId?: string, targetSession?: string): AgentForkResult {
    this.assertInitialized('forkSession');
    const result = this.requireSessionManager.forkSession(roundId, targetSession);

    // 分叉会话首轮命名：仅自动命名（未传 targetSession）时触发，
    // 以分叉点首轮用户消息为标题依据（与新会话首次问答命名同源语义）
    if (!targetSession) {
      void this.ensureForkSessionTitle(result).catch((err) => {
        logger.debug(
          { err, session: result.newSession },
          '分叉会话首轮命名失败（best-effort，不影响分叉结果）',
        );
      });
    }

    return result;
  }

  /**
   * 分叉会话首轮命名（best-effort，fire-and-forget）
   *
   * 分叉新会话是平等普通会话，自动命名（未提供 targetSession）时应拥有 LLM 生成的语义标题。
   * 取新会话第一个 Round 的用户消息作为命名输入（分叉点即新会话起点，语义=首轮问答）；
   * SessionNamer 内部已有 autoName 存在即跳过（幂等），LLM 失败/无价值降级占位标题。
   *
   * @param result - 分叉结果（含新会话名/日期/Round 列表）
   */
  private async ensureForkSessionTitle(result: AgentForkResult): Promise<void> {
    const namer = this.internals.sessionNamer;
    if (!namer) {
      logger.debug('ensureForkSessionTitle: sessionNamer 未创建，跳过分叉会话命名');
      return;
    }
    const roundStore = this.#config.roundStore;
    const firstRoundId = result.roundIds[0];
    if (!roundStore || !firstRoundId) {
      logger.debug({ hasRoundStore: !!roundStore }, 'ensureForkSessionTitle: 无 RoundStore/新会话为空，跳过');
      return;
    }
    // 分叉点首轮用户消息 = 新会话的"首条消息"，作为标题生成输入
    const firstRound = roundStore.getById(firstRoundId);
    const firstUserContent = firstRound?.userMessage?.content;
    if (!firstUserContent) {
      logger.debug({ roundId: firstRoundId }, 'ensureForkSessionTitle: 首轮无用户消息，跳过');
      return;
    }
    await namer.ensureSessionTitle(result.date, result.newSession, firstUserContent);
  }

  /**
   * 切换到指定项目：切换后自动 rebuildComponents()；Agent 级记忆（memora.db）保留，项目级配置（.memora/）重新加载
   */
  async switchProject(nameOrPath: string): Promise<AgentContext> {
    this.assertInitialized('switchProject', ['projectManager', 'provider']);

    // 对话进行中切换项目会导致 loop/history 引用被替换，工作记忆与持久化状态不一致
    this.assertNotBusy('切换项目');

    const pm = this.projectManager!;
    const projects = pm.list;
    let target = projects.find((p) => p.name === nameOrPath || p.path === nameOrPath);
    if (!target) {
      const nameOrPathLower = nameOrPath.toLowerCase();
      target = projects.find(
        (p) => p.name.toLowerCase() === nameOrPathLower || p.path.toLowerCase() === nameOrPathLower,
      );
    }
    const projectPath = target ? target.path : nameOrPath;
    const projectName = target ? target.name : getBaseName(nameOrPath);

    const newPctx = await pm.initProject(projectPath, projectName, this.#config.configDir);

    // 记录源项目路径（用于事件），切换前 pctx 可能不存在（首次初始化）
    const fromProjectPath = this.pctx?.projectPath ?? null;

    // 先尝试重建组件，失败时回滚 pctx 防止状态不一致
    try {
      this.pctx = newPctx;
      await this.rebuildComponents();
    } catch (err) {
      // 回滚：恢复旧 pctx（若存在）
      if (fromProjectPath) {
        logger.warn({ err: toError(err) }, 'switchProject: 组件重建失败，回滚项目上下文');
        this.pctx = { projectPath: fromProjectPath } as ProjectContext;
      }
      throw err;
    }

    // 发射项目切换事件（供宿主 UI 刷新项目相关界面）
    this.emit(AGENT_EVENTS.projectSwitched, {
      from: fromProjectPath,
      to: projectPath,
      projectName,
    });

    return newPctx;
  }

  // ─── 组件组装 ─────────────────────────────────────────

  /**
   * 组装所有运行时组件（一行委托给 assembler 工厂）
   *
   * 接线回调（工具幂等 outbox / 任务表 / loop 回调 / createSessionManager）与装配私有状态
   * （暂存队列 / 停滞计数器）全部由 assembler 组装收口——Agent 只注入稳定能力（hooks）。
   */
  private async assembleComponents(pctx: ProjectContext): Promise<void> {
    const result = await assembleComponents(pctx, {
      provider: this.provider,
      backgroundProvider: this.#backgroundProvider,
      providerRouter: this.#providerRouter,
      projectPath: this.#config.projectPath,
      configDir: this.#config.configDir,
      activeRolePack: this.#config.activeRolePack,
      maxContextTokens: this.#config.maxContextTokens,
      sessionStore: this.#config.sessionStore,
      roundStore: this.#config.roundStore,
      tracer: this.#config.tracer,
      messages: this.#config.messages,
      enableContextSummary: this.#config.enableContextSummary,
      webSearchProvider: this.#config.webSearchProvider,
      fetchProvider: this.#config.fetchProvider,
      codeExecutionProvider: this.#config.codeExecutionProvider,
      vectorStore: this.#config.vectorStore,
      recallExcludeSources: this.#config.recallExcludeSources,
      existingSkillManager: this.skillManager,
      // Agent 稳定能力（emit/守卫/暂停/角色切换）：接线下沉后仅传能力，接线语义在组装器唯一实现
      hooks: {
        // 桥接 SessionManager 宽类型事件到 Agent 强类型 emit（校验事件名在 AgentEventMap 内，避免不安全断言）
        emit: (event, data) => {
          if (AGENT_EVENT_SET.has(event)) {
            this.emit(event as keyof AgentEventMap, data as AgentEventMap[keyof AgentEventMap]);
          }
        },
        isChatBusy: () => this.internals.chatLockManager?.isBusy ?? false,
        requestPause: (reason, source) => {
          this.requestPause(reason, source);
        },
        preExecutionCheck: this.#config.preExecutionCheck,
        fileConsistencyCheck: this.#config.fileConsistencyCheck,
        // 输入增强管线角色匹配命中 → Agent 生命周期切换（activate → 事件 → 刷新前缀 → 工具暴露）
        switchRolePack: (name) => this.switchRolePack(name),
        // 检查点恢复协议角色契约重注入 → Agent 生命周期（工具暴露面 / loop 前缀刷新）
        applyRolePackToolExposure: () => this.applyRolePackToolExposure(),
        refreshRolePackPrefixOnLoop: () => this.refreshRolePackPrefixOnLoop(),
      },
    });

    this.history = result.history;
    this.loop = result.loop;
    this.toolExec = result.toolExec;
    this.skillManager = result.skillManager;
    this._rolePackManager = result.rolePackManager;
    // 角色包切换锁定事件：rolePackManager 触发锁定时，Agent 向宿主发射 rolePackSwitchLocked 事件
    this._rolePackManager.onRolePackSwitchLocked((reason, lockedSeconds) => {
      this.emit(AGENT_EVENTS.rolePackSwitchLocked, { reason, lockedSeconds });
    });
    this.memoryInspector = result.memoryInspector;
    this.internals.dedupManager = result.dedupManager;
    this.internals.memoryAdvisor = result.memoryAdvisor;
    this.workProjection = result.workProjection;
    this.internals.sessionArchiver = result.sessionArchiver;
    this.textPolisher = result.textPolisher;
    this.internals.roundSummaryGenerator = result.roundSummaryGenerator;
    // 会话管理器由组装器创建（先于 loop），Agent 直接持有
    this._sessionManager = result.sessionManager;
    // 输入增强管线由组装器创建，Agent 只保留编排调用点
    this.internals.contextPreparer = result.contextPreparer;
    // 检查点恢复协议由组装器创建，Agent 保留公开 API 委托
    this.internals.checkpointRestoreCoordinator = result.checkpointRestoreCoordinator;
  }

  // ─── Provider 管理 ────────────────────────────────────

  setProvider(provider: LlmProvider): void {
    // 对话中切换会导致同循环内前后两次 LLM 调用命中不同 Provider（上下文窗口假设/工具格式不一致）
    this.assertNotBusy('切换 Provider');
    this.#provider = provider;
    if (this.loop) {
      this.loop.setProvider(provider);
    }
    logger.info({ provider: this.#provider.name }, 'Provider 已切换');
  }

  setBackgroundProvider(provider: LlmProvider | null): void {
    // 与 setProvider 一致，对话进行中禁止切换后台 Provider
    this.assertNotBusy('切换后台 Provider');
    this.#backgroundProvider = provider;
    // 同步更新所有后台组件（统一消费 backgroundProvider）
    if (this.internals.roundSummaryGenerator) {
      this.internals.roundSummaryGenerator.setBackgroundProvider(provider);
    }
    if (this.internals.sessionArchiver) {
      this.internals.sessionArchiver.setBackgroundProvider(provider);
    }
    logger.info({ hasBackground: !!provider }, '后台 Provider 已切换');
  }

  // ─── 归档模式管理 ───────────────────────────

  /**
   * 运行时切换归档模式：对话进行中禁止切换（避免本轮 postProcess 行为不一致），无变更幂等返回
   */
  setArchiveMode(mode: ArchiveMode): void {
    this.assertNotBusy('切换归档模式');
    const prev = this.#config.archiveMode;
    if (prev === mode) return; // 幂等：无变更直接返回
    this.#config.archiveMode = mode;
    this.emit(AGENT_EVENTS.archiveModeChanged, { from: prev, to: mode });
    logger.info({ from: prev, to: mode }, '归档模式已切换');
  }

  /**
   * 查询当前归档模式（宿主 UI 可据此同步显示）
   */
  getArchiveMode(): ArchiveMode {
    return this.#config.archiveMode;
  }

  /**
   * 获取角色包切换锁定状态（透传 RolePackManager，宿主 IPC 层据此区分"切换失败"原因）
   * @returns locked 是否锁定；unlockAt 锁定自动恢复时间戳（ms epoch），未锁定时为 null
   */
  getRolePackSwitchLockStatus(): { locked: boolean; unlockAt: number | null } {
    this.assertInitialized('getRolePackSwitchLockStatus');
    if (!this._rolePackManager) return { locked: false, unlockAt: null };
    return this._rolePackManager.getSwitchLockStatus();
  }

  /**
   * 获取当前激活角色包的 traits（宿主情感计算 API）
   *
   * @returns traits 键值对，无激活角色包或无 traits 时返回 undefined
   */
  getActiveTraits(): Record<string, number> | undefined {
    return this._rolePackManager?.getActiveTraits();
  }

  /**
   * 刷新 AgentLoop 的 systemPromptPrefix（SSOT：buildSystemPromptPrefix）
   *
   * 角色包是 system prompt 的唯一注入源。调用时机：自动/手动切换成功后、reloadConfig 重载后；
   * loop 为 null 时静默跳过（init 前或 close 后边界）。统一走 buildSystemPromptPrefix 真理源，
   * 避免此前只拼 rolePackPrompt 丢失全局技能清单。
   */
  private refreshRolePackPrefixOnLoop(): void {
    if (!this.loop) return;
    const rolePackPrompt = this._rolePackManager?.buildSystemPrompt() ?? '';
    const globalSkillList = this.skillManager?.buildSkillList() ?? '';
    // 作品投影装配块：缓存于 manager（装配时刷新 + register_work 更新），同步读取即可
    const workProjectionContext = this.workProjection?.contextBlock() ?? '';
    const newPrefix = buildSystemPromptPrefix(
      rolePackPrompt,
      globalSkillList,
      undefined,
      workProjectionContext,
    );
    this.loop.refreshRolePackPrefix(newPrefix);
    // 同步注入角色包策略的 ChatOptions 覆盖项（temperature / outputLimit / streaming）
    this.loop.setChatOptions(this.buildChatOptionsFromStrategy());
  }

  /**
   * 从当前激活的角色包策略构建 ChatOptions 覆盖项
   * 将 act.temperature / act.outputLimit / act.streaming 映射到 ChatOptions 字段，优先级高于全局默认值。
   */
  private buildChatOptionsFromStrategy(): Partial<ChatOptions> | undefined {
    const strategy = this.getActiveStrategy();
    if (!strategy) return undefined;

    const chatOptions: Partial<ChatOptions> = {};
    const act = strategy.act;

    // act.temperature → ChatOptions.temperature（限 0-2）
    const temperature = act?.temperature;
    if (typeof temperature === 'number' && temperature >= 0 && temperature <= 2) {
      chatOptions.temperature = temperature;
    }

    // act.outputLimit → ChatOptions.maxTokens（需 ∈ [1, MAX_OUTPUT_LIMIT]，越界忽略防资源失控）
    const outputLimit = act?.outputLimit;
    if (
      typeof outputLimit === 'number' &&
      outputLimit > 0 &&
      outputLimit <= MAX_OUTPUT_LIMIT
    ) {
      chatOptions.maxTokens = outputLimit;
    }

    // act.streaming → ChatOptions.stream（'streaming' → true, 'non-streaming' → false）
    const streaming = act?.streaming;
    if (streaming === 'streaming') {
      chatOptions.stream = true;
    } else if (streaming === 'non-streaming') {
      chatOptions.stream = false;
    }

    return Object.keys(chatOptions).length > 0 ? chatOptions : undefined;
  }

  /**
   * 角色包系统的唯一切换入口（自动匹配 + 手动切换共用）：activate 更新激活态 → 发射 rolePackSwitched 事件
   * → 刷新 AgentLoop 前缀 → 同步工具白名单。
   * @returns 是否切换成功（不存在返回 false 且不触发事件；同名切换幂等返回 true）
   */
  switchRolePack(name: string): boolean {
    this.assertInitialized('switchRolePack');
    const rpm = this._rolePackManager;
    if (!rpm) return false;
    const prevName = rpm.activeName;
    if (prevName === name) return true;
    const ok = rpm.activate(name);
    if (!ok) {
      logger.warn({ name }, '切换角色包失败（不存在或切换锁已激活）');
      return false;
    }
    this.emit(AGENT_EVENTS.rolePackSwitched, { from: prevName ?? '', to: name });
    this.refreshRolePackPrefixOnLoop();
    this.applyRolePackToolExposure();
    logger.info({ rolePack: name }, '角色包切换');
    return true;
  }

  /**
   * 手动归档会话（更新 SessionMeta，委托 ArchiveCoordinator）
   *
   * 适用于 manual 模式（用户手动触发；full 模式由宿主切换前自动调用）。
   * options 透传给 ArchiveCoordinator：宿主自动触发传 { autoTriggered: true }（按其模式判断），
   * 用户手动触发省略 options（默认 autoTriggered=false，无条件执行）。
   *
   * @returns 归档结果（updatedFields 可能为空，表示无归档价值或 LLM 失败）
   */
  async archiveSession(
    date: string,
    session: string,
    options?: ArchiveTriggerOptions,
  ): Promise<SessionArchiveResult> {
    this.assertInitialized('archiveSession');
    return this.requireArchiveCoordinator.archiveSession(date, session, options);
  }

  // ─── 配置重载（事件驱动） ───────────────────────

  /**
   * 重载配置类记忆：从 configDir 重新扫描指定 source 并更新内存缓存 + SQLite 索引，使当前会话立即生效（无需重启）。
   * - 'skill' → SkillManager.reload() 重扫 skills/
   * - 'rolePack' → RolePackManager.reload() 重扫 role-packs/（保持激活角色，刷新 AgentLoop 前缀）
   * - 'rule' → 经角色包管理机制热更新（即 rolePack）
   * - undefined → 全量重载 skill + rolePack
   */
  async reloadConfig(source?: string): Promise<{ skill: number; rolePack: number }> {
    this.assertInitialized('reloadConfig');
    if (this.internals.chatLockManager?.isBusy) {
      // 对话中无法热重载：暂存 source 待锁释放后补执行；undefined（全量）不暂存——无具体来源，补执行语义不明
      if (source) {
        this.pendingConfigReload.add(source);
        logger.info({ source }, '对话进行中，配置重载已暂存，将在对话结束后补执行');
      }
      throw chatBusyError('重载配置');
    }

    // rule 是角色包的一部分，重载走 rolePack 路径
    if (source === 'rule') {
      logger.info('rule 类型重载：触发角色包重新扫描');
      return this.reloadConfig('rolePack');
    }

    const result = { skill: 0, rolePack: 0 };
    const errors: Error[] = [];

    // 按需重载：source 缺省时全量重载，否则只重载指定类型
    const shouldReloadSkill = !source || source === 'skill';
    const shouldReloadRolePack = !source || source === 'rolePack';

    if (shouldReloadSkill && this.skillManager) {
      try {
        result.skill = await this.skillManager.reload();
      } catch (err) {
        errors.push(toError(err));
        logger.warn({ err: toError(err) }, 'reloadConfig: skillManager.reload 失败');
      }
    }

    if (shouldReloadRolePack && this._rolePackManager) {
      try {
        result.rolePack = await this._rolePackManager.reload();
        // 角色重载后刷新 AgentLoop 前缀
        if (this.loop) {
          this.refreshRolePackPrefixOnLoop();
        }
      } catch (err) {
        errors.push(toError(err));
        logger.warn({ err: toError(err) }, 'reloadConfig: rolePackManager.reload 失败');
      }
    }

    if (errors.length > 0) {
      logger.warn({ source, ...result, errorCount: errors.length }, '配置热重载部分失败');
    } else {
      logger.info({ source, ...result }, '配置已热重载');
    }
    return result;
  }

  // ─── 组件访问 ─────────────────────────────────────────

  /**
   * 重建内部组件（history / loop / managers）：通常由 switchProject() 自动触发，仅强制刷新时手动调用
   */
  async rebuildComponents(): Promise<void> {
    // 对话进行中重建会导致 loop/history 引用被替换，工作记忆与持久化状态不一致
    this.assertNotBusy('重建组件');
    if (!this.pctx) return;
    // assembleComponents 内部重建 history/loop/managers，并返回新创建的 sessionManager
    await this.assembleComponents(this.pctx);
  }

  // ─── 守卫方法 ───────────────────────────────────────────

  /**
   * 检查 Agent 是否已初始化（methodName 用于错误消息，requires 为需检查的组件列表）
   */
  private assertInitialized(
    methodName: string,
    requires: Array<'history' | 'loop' | 'projectManager' | 'provider'> = ['history', 'loop'],
  ): void {
    if (!this._initialized) {
      throw configError('Agent 未初始化', '请先调用 init()', [
        `在 ${methodName}() 前调用 await agent.init()`,
      ]);
    }
    const deps: Record<string, unknown> = {
      history: this.history,
      loop: this.loop,
      projectManager: this.projectManager,
      provider: this.provider,
    };
    for (const dep of requires) {
      if (!deps[dep]) {
        throw configError('Agent 未初始化', `${dep} 组件不可用`, [
          `在 ${methodName}() 前调用 await agent.init()`,
        ]);
      }
    }
  }

  /**
   * 断言对话未进行中（统一守卫）：破坏状态一致性的入口统一在此做 isBusy 检查。
   * reloadConfig 不使用本方法——它在 isBusy 时需暂存 source 而非直接抛错。
   */
  private assertNotBusy(operation: string): void {
    if (this.internals.chatLockManager?.isBusy) {
      throw chatBusyError(operation);
    }
  }

  // 断言 getter：非空或抛明确错误，替代 this.loop!/history!/pctx! 非空断言
  private get requireLoop(): AgentLoop {
    if (!this.loop)
      throw configError('AgentLoop 未初始化', undefined, ['在调用此方法前执行 await agent.init()']);
    return this.loop;
  }

  private get requireArchiveCoordinator(): ArchiveCoordinator {
    if (!this.internals.archiveCoordinator)
      throw configError('ArchiveCoordinator 未初始化', undefined, [
        '在调用此方法前执行 await agent.init()',
      ]);
    return this.internals.archiveCoordinator;
  }

  private get requireSessionManager(): SessionManager {
    if (!this._sessionManager)
      throw configError('SessionManager 未初始化', undefined, [
        '在调用此方法前执行 await agent.init()',
      ]);
    return this._sessionManager;
  }

  /**
   * 获取角色包管理器（system prompt 的唯一注入源，返回 null 表示 Agent 未初始化）
   */
  get rolePackManager(): RolePackManager | null {
    return this._rolePackManager;
  }

  /**
   * 获取当前激活的 L2 行为策略：从激活角色包读取，未激活时用全局默认值；供各阶段按策略调整行为
   */
  getActiveStrategy(): BehaviorStrategy {
    return this._rolePackManager?.getActive()?.strategy ?? DEFAULT_BEHAVIOR_STRATEGY;
  }

  /**
   * 应用当前角色包的工具暴露面（换角色 → 工具集切换）：声明 capabilities 时解析为工具白名单，未声明放行全部。
   * 空数组（parseCapabilities 对 undefined 返回 []）同样视为"未声明能力"放行全部，避免误解释为"禁止所有"。
   * toolMode=block 全禁与此正交；变更经 setToolWhitelist → onToolsChanged 链路同步 loop 快照与 system prompt。
   */
  private applyRolePackToolExposure(): void {
    if (!this.toolExec) return;
    const active = this._rolePackManager?.getActive();
    const capabilities = active?.capabilities;
    const whitelist =
      capabilities && capabilities.length > 0 ? resolveCapabilityTools(capabilities) : null;
    this.toolExec.setToolWhitelist(whitelist);
  }

  // ─── 记忆生命周期 ───────────────────────────────────────

  /**
   * 立即执行一次孤儿 Round 垃圾回收（宿主手动触发入口）。
   *
   * roundStore+storage 未注入时返回空统计（降级不报错）；
   * 对话进行中（chatLock busy）经 shouldSkip 跳过并返回空统计。
   *
   * @returns GC 结果统计（scanned/deleted/memoryCleaned 等）
   */
  gcNow(): GCResult {
    const gc = this.internals.gcService;
    if (!gc) {
      logger.debug('gcNow: roundStore/storage 未注入，GCService 未创建（降级为空转）');
      return {
        scanned: 0,
        orphaned: 0,
        deleted: 0,
        failedDueToRefCount: 0,
        memoryCleaned: 0,
        elapsedMs: 0,
      };
    }
    return gc.run();
  }

  // ─── 关闭 ─────────────────────────────────────────────

  /**
   * 关闭 Agent，释放 SQLite 连接等资源
   */
  async close(): Promise<void> {
    // 清理 chat 锁管理器（递增 token 使进行中 chat() 的 finally 跳过清理，close 已接管）
    this.internals.chatLockManager?.dispose();
    this.internals.chatLockManager = null;
    // 孤儿 Round GC 停止定时任务（须先于下方 projectManager.shutdown——其会关闭 storage）
    this.internals.gcService?.stopPeriodic();
    this.internals.gcService = null;
    // 等待 WorkProjection 无 inflight 概念（作品投影改为用户主动触发同步写，无后台 LLM 任务）
    // 背景任务统一由下方 awaitBackgroundTasks 兜底
    // 关键修复：等待 backgroundTask 全局在途任务完成（如 boostScores）。
    // 否则 close 后后台任务仍可能 upsert 已关闭的 storage，触发写失效或异常。
    try {
      const awaited = await awaitBackgroundTasks(AGENT_CONSTANTS.SHUTDOWN_ARCHIVE_TIMEOUT_MS);
      if (awaited > 0) {
        logger.debug({ awaited }, 'close: 已等待背景任务完成');
      }
    } catch (err) {
      logger.warn({ err: toError(err) }, 'close: awaitBackgroundTasks 失败');
    }
    // 处理 pending 暂停残留：关闭前确保状态机与检查点一致
    const sm = this._sessionManager;
    if (sm?.isPausePending()) {
      const pendingInfo = sm.pendingPauseInfo;
      logger.warn(
        { reason: pendingInfo?.reason, source: pendingInfo?.source },
        'close() 时存在未消费的暂停请求，已自动清理',
      );
      // 若状态机仍 running，同步翻 paused 使检查点落盘准确（无需触发挂起，仅修正一致性）；
      // 系统清理不消耗 P4 配额 → lowRisk=true
      if (sm.status === 'running') {
        sm.pause('close 清理残留暂停', 'system', true);
      }
      sm.cancelPendingPause();
    }

    // 清理 SessionManager（须先于 nullifyAllComponents，destroy 需访问其内部状态）
    if (this._sessionManager) {
      // flush 脏检查点落盘后再 destroy，覆盖 logToolExecution 标脏后未 completeRound 的关闭窗口
      this._sessionManager.flushOnShutdown();
      this._sessionManager.destroy();
    }
    // ArchiveCoordinator 无定时器，仅释放引用
    this.internals.archiveCoordinator = null;
    // 清理 RolePackManager 切换防抖锁计时器，防止关闭后回调触发
    if (this._rolePackManager) {
      this._rolePackManager.close();
    }

    // 顺序敏感：先等后台归档完成再移除监听器，否则 await 期间归档 reject 的 emit 变 no-op、事件丢失
    if (this.history) {
      try {
        await this.history.awaitPendingArchives(AGENT_CONSTANTS.SHUTDOWN_ARCHIVE_TIMEOUT_MS);
      } catch (err) {
        logger.warn({ err: toError(err) }, 'close: awaitPendingArchives 失败');
      }
    }
    this.removeAllListeners();

    if (this.projectManager) {
      try {
        await this.projectManager.shutdown();
      } catch (err) {
        logger.warn({ err: toError(err) }, 'close: projectManager.shutdown 失败');
      }
    }
    this._initialized = false;
    this.nullifyAllComponents();
    // 清理次要状态字段，防止 re-init 后残留上一会话状态
    this._lastInteractionAt = null;
    this.pendingConfigReload.clear();
  }

  /**
   * 统一 null 化所有组件字段（新增 Manager 时在此追加一行）；带副作用的清理仍由 close() 显式调用，顺序敏感不可合并
   */
  private nullifyAllComponents(): void {
    this.#backgroundProvider = null;
    this.history = null;
    this.loop = null;
    this.toolExec = null;
    this.skillManager = null;
    this._rolePackManager = null;
    this.memoryInspector = null;
    this._governance = null;
    this.workProjection = null;
    this.textPolisher = null;
    this._sessionManager = null;
    this.projectManager = null;
    this.pctx = null;
    // 纯内部组件聚合整体置 null（新增内部组件只需在字段声明与 createPostInitComponents 登记）
    this.internals = {
      dedupManager: null,
      memoryAdvisor: null,
      sessionArchiver: null,
      sessionNamer: null,
      roundSummaryGenerator: null,
      contextPreparer: null,
      checkpointRestoreCoordinator: null,
      composer: null,
      chatLockManager: null,
      archiveCoordinator: null,
      seedOrchestrator: null,
      gcService: null,
    };
  }

  // ─── 只读访问器 ───────────────────────────────────────

  get initialized(): boolean {
    return this._initialized;
  }

  get context(): AgentContext | null {
    return this.pctx;
  }

  /**
   * 获取 AgentLoop 实例（宿主集成面，用于 restoreHistory 等底层操作；getMessages/getMessageCount 无法替代）
   */
  get agentLoop(): AgentLoop | null {
    return this.loop;
  }

  /**
   * 获取当前消息列表（只读副本，不可绕过编排链路直接修改）
   */
  getMessages(): readonly Message[] {
    return this.loop?.getMessages() ?? [];
  }

  /** 获取当前消息数量 */
  getMessageCount(): number {
    return this.loop?.getMessages().length ?? 0;
  }

  /**
   * 获取 MessageHistory 实例（宿主集成面，用于日期/会话判断等底层操作；
   * currentDateValue/currentSessionValue 等只读属性无替代接口）
   */
  get agentHistory(): MessageHistory | null {
    return this.history;
  }

  /**
   * 注入情感基调到 system prompt：委托 AgentLoop.injectAffect()，在角色前缀与 bootstrap 记忆间插入情感描述；
   * 与角色切换独立（切换角色不清除情感注入），传空串清除。
   */
  injectAffect(affectString: string): void {
    if (!this.loop) throw configError('AgentLoop', 'AgentLoop 未初始化，无法注入 affect', []);
    this.loop.injectAffect(affectString);
  }

  get provider(): LlmProvider {
    return this.#provider;
  }

  get isBusy(): boolean {
    return this.internals.chatLockManager?.isBusy ?? false;
  }

  get lastInteractionAt(): Date | null {
    return this._lastInteractionAt;
  }

  /** 记忆治理统一门面（语义去重 / 来源健康诊断 / 冲突检测 / 建议推荐），统一替代 Agent 上散落的管理方法（显式衰减层面已移除，2026-08-27） */
  get governance(): MemoryGovernance | null {
    return this._governance;
  }

  // ─── 运行时指标 ────────────────────────────────

  /**
   * 后台任务统计快照（宿主观测后台副作用健康度，纯只读转发 utils 单例）。
   * @returns 在途 / 成功 / 失败计数
   */
  getBackgroundTaskStats(): BackgroundTaskStats {
    return readBackgroundTaskStats();
  }

  /**
   * 获取 Agent 运行时指标快照（可观测性）：聚合 AgentLoop 指标与 Agent 层治理指标；
   * 未初始化返回全零默认值（不抛异常），纯只读同步零副作用，适合宿主定期轮询监控面板。
   */
  getMetrics(): AgentMetrics {
    // 未初始化时返回全零指标，避免调用方判空
    if (!this.loop) {
      return {
        llm: { callCount: 0, totalInputTokens: 0, totalOutputTokens: 0, actualInputTokens: 0, actualOutputTokens: 0 },
        recall: { totalCount: 0, hitCount: 0, hitRate: 0 },
        tools: { callCount: 0, failureCount: 0 },
        context: { truncationCount: 0, messageCount: 0, estimatedTokens: 0 },
        tasks: { totalCount: 0, successCount: 0, failureCount: 0, successRate: 0, avgDurationMs: 0 },
      };
    }

    const loopMetrics = this.loop.getMetrics();
    return {
      ...loopMetrics,
    };
  }

  // ─── Manager 暴露（调用方直接操作 Manager）──
  // 设计策略：访问器（getter）返回 Manager | null 供链式调用和优雅降级（如 `if (!agent.memory) return []`）；
  // 门面方法经 assertInitialized 抛明确错误；宿主用访问器需自行判空，或用门面方法获得自动错误处理。

  /** 角色包管理器（角色+技能+规则的唯一真理源，system prompt 的唯一注入源） */
  get rolePack(): RolePackManager | null {
    return this._rolePackManager;
  }

  /** 工具执行器（返回 null 表示 Agent 未初始化） */
  get tools(): ToolExecutor | null {
    return this.toolExec;
  }

  /** 技能管理器（返回 null 表示未初始化或技能系统未加载） */
  get skills(): SkillManager | null {
    return this.skillManager;
  }

  /** 角色包管理器（返回 null 表示未初始化或角色包系统未加载） */
  get rolePacks(): RolePackManager | null {
    return this._rolePackManager;
  }

  /** 记忆查看器（快照 + 搜索 + 统计；宿主常用 `const mem = agent.memory; if (!mem) return []`） */
  get memory(): MemoryInspector | null {
    return this.memoryInspector;
  }

  /** 项目管理器（返回 null 表示 Agent 未初始化） */
  get projects(): ProjectManager | null {
    return this.projectManager;
  }

  /** 安全守卫（写入确认回调注册：`onWriteConfirmation` 返回 true 放行、false 拒绝；未初始化/projectPath 未设为 null） */
  get security(): SecurityGuard | null {
    return this.pctx?.security ?? null;
  }

  /** 作品投影管理器（用户主动登记的 JSON 极简索引；`registerWork`/`listWorks`/`loadAndGetContextBlock`/`isFileMalformed`） */
  get works(): WorkProjectionManager | null {
    return this.workProjection;
  }

  /** 会话管理器（会话恢复/切换/分叉功能） */
  get sessionManager(): SessionManager | null {
    return this._sessionManager;
  }

  /** 文本润色管理器（polish 方法） */
  get polish(): TextPolishManager | null {
    return this.textPolisher;
  }
}
