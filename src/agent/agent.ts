/**
 * Agent 门面类 — Memora 宿主项目接入入口
 *
 * 宿主通过 `import { Agent } from '@zooique/memora'` 一行接入。
 * 负责组件组装和核心对话编排，领域专属操作委托给专职 Manager
 * （RolePackManager / ToolExecutor / SkillManager / MemoryInspector）。
 */
import { isAbsolute } from 'node:path';
import { getBaseName } from '@/utils/path.js';
import { AGENT_CONSTANTS } from '@/agent/constants.js';
import type { AgentLoop } from '@/agent/loop.js';
import type {
  AgentChunk,
  ArchiveMode,
  AgentOptions,
  AgentContext,
  AgentConfig,
  ToolExecutionRecord,
  SessionCheckpoint,
} from '@/agent/types.js';
import type { InteractiveInputKind } from '@/memory/roundStore.js';
import type { ToolExecutor } from '@/agent/toolExecutor.js';
import type { MessageHistory } from '@/agent/messageHistory.js';
import { ProjectManager, type ProjectContext } from '@/memory/projectManager.js';
import { SecurityGuard } from '@/security/pathGuard.js';
import type { SkillManager } from '@/skill/skillManager.js';
import type { RolePackManager } from '@/role-pack/rolePackManager.js';
import { DEFAULT_BEHAVIOR_STRATEGY } from '@/role-pack/strategyResolver.js';
import { isTemperature, MAX_OUTPUT_LIMIT } from '@/role-pack/strategyKeys.js';
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
import { createDefaultGCService, type GCService, type GCResult } from '@/memory/gcService.js';
import { assembleComponents, buildSystemPromptPrefix } from '@/agent/assembler.js';
import { estimateTokensMessages } from '@/agent/contextManager.js';
import { SeedOrchestrator } from '@/agent/seed/index.js';
// 输入增强管线（角色/记忆/技能增强，Agent 只保留编排调用点）
import type { ContextPreparer } from '@/agent/contextPreparer.js';
import {
  chatBusyError,
  configError,
  isAbortError,
  isTimeoutAbortSignal,
  isTimeoutError,
} from '@/utils/errors.js';
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
    /** chat() 并发锁管理器（并发锁 + token 校验 + 超时保护 + 外部 signal 合并，init 时创建、close 时销毁） */
    chatLockManager: ChatLockManager | null;
    /** 归档协调器（归档操作委托给 ArchiveCoordinator） */
    archiveCoordinator: ArchiveCoordinator | null;
    /**
     * 种子 turn 编排器（turn 的唯一编排真理源）：prepare → act → reflect。
     * chat() 委托 runChat()；续跑（continueAfterPause）走 runResume()，复用同一 turn 编排。
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
   * 流活跃标志：chat()/resumeExecution() 的 AsyncGenerator 生命周期内置 true、finally 置 false。
   * 与 chatLock.isBusy（并发锁，180s 超时后自动释放但**不中断生成流**）语义解耦——
   * requestPause 空闲守卫必须用「流是否在产出」而非「锁是否持有」判任务是否结束，
   * 否则长任务运行超锁期后点暂停会被误判为「任务已结束」——锁超时会自动释放但生成流仍在跑，
   * 故判据只能是流活跃，不能是锁持有。
   */
  private _flowActive = false;
  /**
   * 对话中因 chatLock 冲突暂存的配置重载请求（锁释放后补执行，兑现"对话后自动加载"）；
   * 用 Set 去重——同一 source 只需补执行一次。
   */
  private pendingConfigReload = new Set<string>();

  constructor(opts: AgentOptions) {
    super();
    this.#config = {
      projectPath: opts.projectPath,
      dataDir: opts.dataDir,
      registryDir: opts.registryDir,
      maxContextTokens: opts.maxContextTokens ?? AGENT_CONSTANTS.DEFAULT_MAX_CONTEXT_TOKENS,
      permission: opts.permission ?? 'owner',
      allowedPaths: opts.allowedPaths ?? [],
      confirmWrites: opts.confirmWrites ?? false,
      confirmScripts: opts.confirmScripts ?? false,
      storage: opts.storage,
      sessionStore: opts.sessionStore,
      roundStore: opts.roundStore,
      configDir: opts.configDir,
      // 启动时激活的角色包名（宿主注入持久化值，init 时优先激活——§4.1 单链第一层）
      activeRolePack: opts.activeRolePack,
      // 组（宿主装配级）：组长角色包 + 组员名单（会议名单容器，非选择对象；组员仅会议参与）
      // 内部运行态归一化必选（外部未配 = 无团队），保证装配链必传
      rolePackTeams: opts.rolePackTeams ?? [],
      // 程序级内置兜底角色（可选）：覆盖内核常量 BUILTIN_FALLBACK_PACK；须指向存在的包，否则回退内核常量
      builtinFallbackRole: opts.builtinFallbackRole,
      tracer: opts.tracer,
      messages: opts.messages,
      enableContextSummary: opts.enableContextSummary ?? true,
      archiveMode: opts.archiveMode ?? 'full',
      webSearchProvider: opts.webSearchProvider,
      fetchProvider: opts.fetchProvider,
      codeExecutionProvider: opts.codeExecutionProvider,
      projectSearchProvider: opts.projectSearchProvider,
      // 脚本执行 node 路径（可选）：宿主注入真实 node 路径，避免无独立 node 时 ENOENT
      scriptNodePath: opts.scriptNodePath,
      // 禁用技能清单（配置形态启停）：透传装配 → SkillManager 过滤 L1/L2/L3
      disabledSkills: opts.disabledSkills ?? [],
      // 宿主审批/审计/参数改写通道，透传供装配阶段与内部幂等检查组合为一处执行前检查点
      preExecutionCheck: opts.preExecutionCheck,
      // 宿主装配级策略覆盖（能力边界）：透传 #config → 装入策略解析链（resolveActiveStrategy），
      // 压过角色包声明（v0.13 后无宿主注入默认值；机制保留供宿主产品能力边界使用）
      strategyOverride: opts.strategyOverride,
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

    // 标记初始化完成
    this._initialized = true;

    // 注册暂停超时归档（同进程暂停超时：30min 无心跳则归档清理）
    this.registerPauseTimeoutArchiver();
    this.registerWorkProjectionRefresh();

    // 注：不加载持久化检查点——中止/断电一律走
    // 「中断轮补全为完整 turn 身份 → 参与下一轮」，不存在跨重启恢复；
    // 运行时暂停是同 turn 内续跑（内存态），无需磁盘载体。
    return pctx;
  }

  /**
   * 登记作品投影实时刷新处理器：register_work 工具 / 右键登记成功后，
   * 内核 WorkProjectionManager 触发 workProjectionGenerated 事件（携带已写入内存 entries 的投影），
   * 立即重建 AgentLoop 的 systemPromptPrefix，使 AI 在下一轮对话即可感知新索引——
   * 否则需切角色包 / reloadConfig / 开新会话才生效。
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
      // pendingPauseReason 由 resetToRunning() 内部统一清理
      //（checkPauseTimeout 经 sessionManager resetToRunning 已覆盖，此处无需再补 cancelPendingPause）。
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
          this.#config.confirmScripts,
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
      );
      this.internals.gcService.startPeriodic(AGENT_CONSTANTS.GC_INTERVAL_MS);
    }

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

    // 种子 turn 编排器（turn 唯一编排真理源）：依赖 sessionManager/loop/history 等
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
      }),
      tracer: this.#config.tracer ?? null,
      archiveMode: this.#config.archiveMode,
      messages: this.#config.messages,
      // 门面私有能力经回调注入 seed（物理实现仍在门面）
      applyRolePackToolExposure: () => this.applyRolePackToolExposure(),
      // 会议机制：按本轮表层装配视角刷新 loop 前缀（roundRole=null 回落 activePack）
      refreshRolePackPrefixForRound: (roundRole) => this.refreshRolePackPrefixForRound(roundRole),
      consumeExecutionStream: (source, signal) => this.consumeExecutionStream(source, signal),
      getBackgroundProvider: () => this.#backgroundProvider,
      // 宿主装配级策略覆盖（能力边界）：传给策略解析链，压过角色包声明（单一语义键不变）
      strategyOverride: this.#config.strategyOverride,
      // 事件发射回调：orchestrator.runSummary 完成后 emit roundSummaryGenerated，
      // 让宿主感知后台摘要收口 → 解锁 UI 生命周期（删除/分叉按钮解禁，防孤儿记忆）
      emit: (event, payload) => {
        if (AGENT_EVENT_SET.has(event)) {
          this.emit(event as keyof AgentEventMap, payload as never);
        }
      },
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
      // 流活跃置位：requestPause 空闲守卫据此判「任务进行中」——锁 180s 超时释放后
      // isBusy=false 但流仍在产出，必须以流生命周期（而非锁持有）为准（09-03 锁语义变更回归修补）
      this._flowActive = true;
      // 状态机翻转是副作用，必须在并发闸门内执行——PAUSED 态收到 chat = 自动恢复 + 继续（作为补充注入）；ERROR 态仍拒绝
      if (!this.autoResumeIfPaused()) {
        yield {
          type: 'error',
          message: '会话已超时，无法自动恢复，请重新开始新对话',
          category: 'timeout',
        };
        return;
      }
      this._lastInteractionAt = new Date();

      // 委托种子编排器：对话路径完整闭环（prepare → act → reflect）
      yield* this.internals.seedOrchestrator!.runChat(input, combinedSignal);
    } finally {
      // 流已退出：清除活跃标志（与置位对称；无论正常/异常退出都复位）
      this._flowActive = false;
      // 仅当本调用仍是当前锁持有者时才清理资源（token 校验）
      this.internals.chatLockManager?.release(myToken);
      cleanupExternalSignal();
      // turn 结束自动收尾：非暂停态无条件清理任务表（turn 内能力，不跨 turn 残留）
      this.clearPlanOnTurnEnd();
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
   * 软暂停后续跑（不中断工作模型 v2.1）
   *
   * 翻状态机为 RUNNING（触发 sessionResumed → 宿主转发 STATUS{running}），
   * 驱动 loop.continueAfterPause 续跑并转发 chunk，完成后追加历史 + 后处理（同 chat 尾处理）。
   * 硬停止（signal.abort）仍是唯一霸道中止路径，与软暂停严格区分。
   *
   * 归属：补充输入归属当前问答闭环（复用 prepare 分配的闭环节点 roundId，不分裂新轮），
   * 以 kind 区分交互类型（question-answer=主动提问回答 / supplement=暂停/流中补充）。
   *
   * @param input - 可选补充输入（空=续跑原路径；有=注入修正后续轮）
   * @param signal - 可选 AbortSignal（硬停止仍走此路径）
   * @param kind - 交互输入类型（默认 supplement；对主动提问的回答传 'question-answer'）
   */
  async *resumeExecution(
    input?: string,
    signal?: AbortSignal,
    kind: InteractiveInputKind = 'supplement',
  ): AsyncGenerator<AgentChunk, void, unknown> {
    const resumeStatus = this._sessionManager?.status;
    // 错误态续跑须明确失败而非静默吞没：error 态由检查点恢复回填进入，运行时异常走
    // yield { type: 'error' } 不翻状态机，生产链路不会自然离开，必须显式提示重新开始
    if (resumeStatus === 'error') {
      this.emit(AGENT_EVENTS.sessionResumeFailed, {
        sessionId: this._sessionManager?.getCheckpoint()?.sessionId,
        reason: '会话处于错误态，无法续跑',
      });
      yield {
        type: 'error',
        message: '当前会话处于错误态，无法续跑，请重新开始',
        category: 'unknown',
      };
      return;
    }
    if (resumeStatus !== 'paused') return;

    // resumeExecution 与 chat() 同构，必须加并发锁
    const lockCtx = this.acquireChatLock(signal);
    const { myToken, combinedSignal, cleanupExternalSignal } = lockCtx;
    try {
      // 流活跃置位：与 chat() 同构（requestPause 空闲守卫判据——续跑也是活跃流）
      this._flowActive = true;
      // 翻状态机为 RUNNING（触发 sessionResumed）
      if (!this.resume()) {
        // resume() 返回 false 时 yield error + 发事件，让宿主感知失败原因而非静默吞没
        this.emit(AGENT_EVENTS.sessionResumeFailed, {
          sessionId: this._sessionManager?.getCheckpoint()?.sessionId,
          reason: 'resume() 返回 false，可能因暂停超时或状态机拒绝',
        });
        yield {
          type: 'error',
          message: '会话已超时，无法自动恢复，请重新开始新对话',
          category: 'timeout',
        };
        return;
      }

      // 预判短路（收窄）：仅「计划全部 blocked」才拦——blocked=真停滞，继续调 LLM
      // 只会复读卡住状态、白烧 token。全 done / 无计划不再拦：用户主动点「继续」就是要 AI 产出
      // （可能收尾总结、补建计划、继续语境），且短问答暂停续跑本就无计划，拦了就没法继续聊。
      // 判定下沉 sessionManager.isPlanAllBlocked()（仅全 blocked 拦；全 done/空计划放行）。
      if (
        !input &&
        this._sessionManager?.isPlanAllBlocked() &&
        !this.requireLoop.isInAutonomousStep
      ) {
        yield {
          type: 'text',
          content: '计划任务项当前全部处于阻塞状态，无法自动推进。请提供新指令或修改计划',
        };
        yield { type: 'done' };
        return;
      }

      // 委托种子编排器：续跑路径闭环（act(continueAfterPause) → reflect；无回答前），
      // 预判短路与锁/状态机守卫留在门面，执行语义收在编排器内。
      yield* this.internals.seedOrchestrator!.runResume(input, combinedSignal, kind);
    } finally {
      // 流已退出：清除活跃标志（与置位对称；无论正常/异常退出都复位）
      this._flowActive = false;
      // 与 chat() 同构：释放锁 + 清理外部 signal
      this.internals.chatLockManager?.release(myToken);
      cleanupExternalSignal();
      // 续跑轮（resumeExecution）是同一 turn 的收尾半程：turn 真正结束 → 与 chat() 同构，
      // 无条件清空任务表（除非再次暂停——pauseMeta 由 loop 在边界重新挂起，guard 保留）。
      // 必须无条件清：若仅全 done 才清，resume 以非 done 且未重暂停结束（如某任务项标 blocked
      // 后收尾）时 plan 残留 → 跨 turn 污染下一个 chat()。
      // 两处 turn-end 清理统一为 clearPlanOnTurnEnd（单一收口点），plan 严格 turn 内、不跨 turn 残留。
      this.clearPlanOnTurnEnd();
    }
  }

  /**
   * 消费执行流的单一真理源
   *
   * chat() 与续跑（continueAfterPause）必须共用同一份消费逻辑——两份同构实现会漂移
   * （实证：续跑漏 paused 分支导致三方分叉）；收口于此，新增 chunk 类型只需改一处。
   * 暂停幂等锁的释放放 finally——清理是"退出本作用域的不变式"而非某分支动作，新增 return 分支无遗漏。
   *
   * @returns 消费结果；failed 为 true 时调用方应立即 return（错误 chunk 已 yield）
   */
  private async *consumeExecutionStream(
    source: AsyncGenerator<AgentChunk, void, unknown>,
    signal?: AbortSignal,
  ): AsyncGenerator<
    AgentChunk,
    { content: string; aborted: boolean; paused: boolean; failed: boolean },
    unknown
  > {
    let content = '';
    let aborted = false;
    // 软暂停标记：loop 在 step 边界挂起（用户 requestPause / ask_user 主动提问）时置真，
    // 供编排器据此推迟摘要——回合未完成不产摘要，保摘要与外部输入 1:1
    let paused = false;

    try {
      for await (const chunk of source) {
        // 内核事实驱动：loop 在 step 边界真正挂起时状态机才翻 PAUSED，非申请即翻转；
        // 与 requestPause 空闲分支同源，须传 lowRisk=true 保持同一暂停事件契约（否则流中暂停计入连续暂停配额）
        if (chunk.type === 'paused') {
          const pendingInfo = this._sessionManager?.consumePendingPause();
          // 暂停收口统一写 pauseMeta：reason/source 取自 pendingPause（与状态机一致）。
          // ask_user 主动提问等"直接暂停路径"不走 loop.onPaused，在此自然补齐，
          // 重启后宿主可展示"为什么暂停 + 问了什么"
          const pauseReason = pendingInfo?.reason ?? '用户主动暂停';
          const pauseSource = pendingInfo?.source ?? 'user';
          this.pause(pauseReason, pauseSource, true);
          this._sessionManager?.setPauseMeta({ reason: pauseReason, source: pauseSource });
          paused = true;
        }
        yield chunk;
        // 累积 assistantContent 用于持久化到 history：只累积正常回答（stage≠self_review）。
        // 自审查文本是内部思考过程——宿主渲染进 round-block § 自审查输出折叠区（不进正文流），
        // 也不应持久化到会话历史（重启后不应在对话记录里看到自审查内容）。
        // 注：loop.messages 里自审查 assistant 仍保留（LLM 下一轮迭代可能需参考），过滤只在持久化出口。
        if (chunk.type === 'text' && chunk.stage !== 'self_review') {
          content += chunk.content;
        } else if (chunk.type === 'narrate' && chunk.withdrawn) {
          // 回抽：首轮工具步的叙述文本先作为 text 流式累积进正文（上面分支），
          // 确认工具轮后从**持久化正文**扣除——与宿主正文撤回同源（同一 withdrawn 字段，SSOT）。
          // 契约：该段为最近追加的正文文本（后缀）；不符（多 turn 复用流/异常序）则忽略并告警，
          // 宁可正文多一段叙述也不误删真实答案。
          if (content.endsWith(chunk.withdrawn)) {
            content = content.slice(0, content.length - chunk.withdrawn.length);
          } else {
            logger.warn(
              { withdrawnLen: chunk.withdrawn.length, contentLen: content.length },
              'narrate 回抽：持久化正文不含该段（后缀契约不符），已忽略',
            );
          }
        } else if (chunk.type === 'aborted') {
          aborted = true;
        }
      }
    } catch (err) {
      if (isAbortError(err)) {
        // signal 已 abort（宿主/插话合并信号）→ 真用户取消：非失败——置 aborted 供 act() 走
        // 「中断保留已产出文本」分支，半截回答落盘。
        if (signal?.aborted) {
          // 锁超时中断（signal.reason=TimeoutError）≠ 用户取消：stopReason 区分，宿主映射超时文案
          yield {
            type: 'aborted',
            reason: isTimeoutAbortSignal(signal)
              ? 'LLM request timed out (no response)'
              : 'User cancelled the conversation',
            stopReason: isTimeoutAbortSignal(signal) ? 'timeout' : 'user',
          };
          return { content, aborted: true, paused, failed: false };
        }
        // signal 未 abort 却抛 AbortError → provider/网络内部中断（连接被抽断/代理异常）：
        // 非用户取消，判为「连接中断」——与普通错误同归 error 分支，用结构化 category
        // 标记连接中断（宿主按 category 映射友好文案），避免谎报为用户取消。
        logger.warn({ err }, 'LLM 请求非用户取消原因中断，判为连接中断');
        const raw = err instanceof Error ? err.message : String(err);
        yield {
          type: 'error',
          // 连接中断分类：语义走 category 字段，不携带裸前缀；message 保留原始细节（调试/报错可追溯）
          category: 'connection',
          message: raw,
        };
        return { content, aborted, paused, failed: true };
      }
      // 超时（典型 = SSE 停摆看门狗 reject 的 DOMException TimeoutError）补结构化分类：
      // 不补 → 宿主 `friendlyByCategory` 无键可映射 → 用户只能读到原始技术文案。
      // 判据 SSOT = isTimeoutError（与上方 isTimeoutAbortSignal 同族，同一 name 判据、不同载体）。
      // 注：非 abort 路径故不入 aborted 分支，它属「失败」并由本 catch 收口。
      yield {
        type: 'error',
        ...(isTimeoutError(err) ? { category: 'timeout' as const } : {}),
        message: err instanceof Error ? err.message : String(err),
      };
      return { content, aborted, paused, failed: true };
    } finally {
      // 释放暂停幂等锁覆盖三路——残留会让 requestPause 的幂等检查永久拒绝后续暂停请求
      this._sessionManager?.cancelPendingPause();
      // 同步清理 loop 的 pause 申请（clearPauseRequest 委托 interruptQueue 过滤 kind='pause' 条目）
      this.requireLoop.clearPauseRequest();
    }

    return { content, aborted, paused, failed: false };
  }

  /**
   * 暂停会话（用户/Agent/系统均可触发，暂停前自动创建检查点）
   * @param lowRisk 低风险暂停不计入连续暂停计数（默认 false）
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
   * 自动恢复暂停状态（chat() 与续跑共用）：
   * ERROR 态直接 throw（拒绝，须先 recover 保持状态一致）；PAUSED 态尝试自动恢复。
   * 续跑（continueAfterPause）不走自动恢复，由独立的暂停恢复短路逻辑处理。
   *
   * @returns true=恢复成功或无需恢复；false=恢复失败（暂停超时等）
   */
  private autoResumeIfPaused(): boolean {
    const sm = this._sessionManager;
    if (!sm) return true;
    const status = sm.status;
    if (status === 'error') {
      throw configError('会话异常', '会话处于异常状态，无法接收新消息', [
        '先标记 error.recovered=true 并调用 agent.recover()',
      ]);
    }
    if (status === 'paused') {
      return this.resume();
    }
    return true;
  }

  /**
   * 请求软暂停（不中断工作模型 v2.1）
   *
   * 经 sm.requestPause 暂存 pending（SessionStateMachine 是 pending 真理源）+ loop.pauseRequested
   * 入 interruptQueue（在下一 step 边界挂起，不 abort）。
   * 状态机翻 PAUSED 延后到 loop 边界真正挂起时——内核事实驱动而非申请即翻转；与硬停止（abort）严格区分，
   * 软暂停保留历史、可经 resumeExecution 续跑。
   *
   * @returns true=请求已注册（下一 step 边界生效）；false=无法暂停
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

    // 空闲守卫：无活跃流时暂停无消费方——若此时同步翻状态机并落盘 checkpoint，
    // 「turn 已完成后的暂停」会把会话钉在 paused，后续新输入被宿主路由成
    // supplement（新意图被吞成"上一个回答的补充"，毒化闭环节点；loop 无流消费的延迟翻转亦无意义）。
    // 任务已结束 = 暂停申请作废，返回 false 供宿主明确反馈；系统/Agent 触发（ask_user/drift）均在
    // 流中（_flowActive=true）不经过此分支，不受影响。
    // ⚠ 判据必须用 _flowActive（流活跃）而非 chatLock.isBusy（锁持有）——chatLock 锁
    // 180s 超时后自动释放（不中断生成流），长任务运行超锁期后 isBusy=false 但流
    // 仍在产出，用锁判据会把「进行中的暂停申请」误作废成「任务已结束」；_flowActive 由 chat()/resumeExecution()
    // 的流生命周期显式维护，与锁超时无关，是「任务是否仍在运行」的准确判据。
    if (!this._flowActive) {
      logger.debug({ reason, source }, 'requestPause 空闲守卫：任务已结束，暂停申请作废');
      return false;
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
   * cancelPauseRequest 主动清理；空闲态由 requestPause 空闲守卫作废（见上，return false 不触达状态机）——
   * isPausePending 仅在流中「申请在途」时为 true（空闲态不翻 PAUSED）。
   */
  isPausePending(): boolean {
    return this._sessionManager?.isPausePending() ?? false;
  }

  /**
   * 放弃当前暂停检查点（宿主 stop 语义的内核出口）
   *
   * 与 pause() 对称：pause 创建检查点；discardCurrentCheckpoint 销毁检查点。
   * 宿主 handleStop 在 paused 态调用——用户决定彻底放弃暂停执行，不再 resume。
   *
   * 除转发 SessionManager.discardCheckpoint（清内存 + 状态机 resetToRunning——检查点不落盘，无存储清理动作），
   *  还须协同 loop.clearPendingInterjections() 清排队插话——pause 生效时 step 边界优先返回不消费 queue，
   *  只清 checkpoint 会留孤儿 queue，下次 chat() 首个 step 误消费残留（坑）。
   *  返回值以 checkpoint 清理为主（queue 有残留不判失败）。
   * @returns true=成功清理；false=无暂停检查点（空闲态调了个空）
   */
  discardCurrentCheckpoint(): boolean {
    this.assertInitialized('discardCurrentCheckpoint');
    // 协同清理暂停上下文的两个组成部分：checkpoint（内存态暂停点，不落盘）+ pendingInterjections（排队插话）
    //  暂停上下文 = checkpoint + queue，stop 语义下两者必须同清，不留孤儿
    const checkpointCleared = this._sessionManager?.discardCheckpoint() ?? false;
    // queue 清理独立：即使 checkpoint 已不存在（空闲态调），残留 queue 也应顺手清掉
    const queueCleared = this.loop?.clearPendingInterjections() ?? 0;
    if (queueCleared > 0) {
      logger.info({ count: queueCleared }, 'discardCheckpoint 协同清理残留 pendingInterjections');
    }
    return checkpointCleared;
  }

  /**
   * 执行中插话（申请）：把用户补充输入排队，当前 step 完成后在 step 边界统一注入为 user 消息。
   *
   * 与 requestPause（step 边界挂起待续跑）同为「申请 → 气口生效」——不中断当前 LLM/工具执行，
   * 只在边界拿到补充输入后开始下一轮 step。插话是唯一写入口（interject → pendingInterjections 排队），
   * 无「立即中断」模式：只有单一申请模式（无 inputInterrupt 立即中断通道）。
   *
   * 归属：插话同时以「补充」交互输入持久化到当前闭环节点（interactiveInputs），
   * 保证跨重启重放时插话内容不丢失、不分裂新轮。持久化 fire-and-forget（appendUser 内部
   * 已 catch 写入失败，仅记日志），不阻塞插话本身。
   */
  interject(content: string): void {
    this.assertInitialized('interject');
    // 持久化插话为闭环节点交互补充输入（roundId 非空时才写；空=无在途闭环，跳过）
    const closureRoundId = this.loop?.getCurrentRoundId();
    if (closureRoundId) {
      void this.history?.appendUser(content, closureRoundId, {
        interactive: true,
        kind: 'supplement',
      });
    }
    this.requireLoop.interject(content);
  }

  /**
   * 删除待注入的插话（宿主 UI 层用户后悔）。与 interject 对称。
   * 注意：interject 时已持久化到 history（交互输入归属），此处只从内核队列移除，不删除已落盘记录——
   * 未来若需完整"撤回"需额外方案（如软删标记），当前先保证 step 边界不会注入已删除的补充。
   * @param index 要删除的插话在队列中的位置（宿主镜像数组与内核队列同序同长度）
   * @returns true=成功删除；false=index 越界或队列为空
   */
  removePendingInterject(index: number): boolean {
    this.assertInitialized('removePendingInterject');
    return this.requireLoop.removePendingInterject(index);
  }

  /**
   * 清空全部待注入插话（宿主「全部清空」按钮触发，或 stop→discard 协同清理）。
   *
   * 逻辑下沉 loop.clearPendingInterjections 原子方法——清队列唯一入口在内核，
   *  宿主不维护队列镜像，避免镜像与内核双写不一致；discardCurrentCheckpoint 经同一方法协同清理。
   *  @returns 被清除的条目数（宿主可用于 notice 反馈；无队列时返回 0）
   */
  clearPendingInterjections(): number {
    this.assertInitialized('clearPendingInterjections');
    return this.requireLoop.clearPendingInterjections();
  }

  /**
   * 读取当前待注入插话队列快照（宿主渲染层只读镜像，不修改内核状态）。
   * 返回副本，宿主无法暗改内核 queue；宿主渲染直接读本快照，不另维护队列镜像。
   */
  getPendingInterjections(): readonly string[] {
    this.assertInitialized('getPendingInterjections');
    return this.requireLoop.getPendingInterjections();
  }

  /**
   * 放弃在途主动提问（ask_user 工具挂起后，宿主「跳过/取消提问」时调用）：
   * 委托 loop.cancelAsk 补占位 tool 结果（防 assistant.tool_calls 无配对 → 400），
   * 随后 resumeExecution() 续跑。与 answerQuestion 二选一消费在途提问。
   */
  cancelAsk(): void {
    this.assertInitialized('cancelAsk');
    this.requireLoop.cancelAsk();
  }

  /**
   * 回答在途主动提问（ask_user 工具）：
   * 答案以 ask_user 的 tool result 回填（与 assistant.tool_calls 配对，结构合法）。
   * 调用后宿主以 resumeExecution(回答文本, undefined, 'question-answer') 续跑——
   * 回答文本同时作为新 user 输入注入并记录为闭环节点交互输入（round 不分裂），
   * 与既有续跑主流程一致（本方法只负责结构化回填，不做历史记录，避免双写）。
   * 返回 false 表示无在途提问（提供方未调用 / 已消费）。
   */
  answerQuestion(answers: readonly string[]): boolean {
    this.assertInitialized('answerQuestion');
    return this.requireLoop.answerQuestion(answers);
  }

  /**
   * 追加计划任务项（SESSION_APPEND_TASK 落点）：在现有 plan 末尾追加新任务项
   */
  appendPlanItem(description: string): number {
    this.assertInitialized('appendPlanItem');
    const sm = this.requireSessionManager;
    return sm.appendPlanItem(description);
  }

  /**
   * 卸载运行态挂载物：清空检查点计划与任务项推进日志（宿主任务流结束/停止/异常广播 idle 前调用），
   * 回到"空闲 = 无挂载物"的资源层常态；会话历史与记忆等资源层内容不受影响。
   */
  clearPlan(): void {
    this.assertInitialized('clearPlan');
    this.requireSessionManager.clearPlan();
  }

  /**
   * turn 结束自动收尾：非暂停态 → 无条件 clearPlan（任务表收紧为 turn 内能力，不跨 turn 残留）。
   *
   * 任务表生命周期 = 单个 turn：LLM 在 turn 内编排并完成任务表；chat() 流退出（turn 真正结束）
   * 时，无论任务项是否全部标记完成，都清空运行时挂载物（checkpoint.plan 与 planItemLog）。这样：
   * ① 宏任务一个 turn 完不成 → 本 turn 结束兜底丢弃，下个 turn 由 LLM 重新规划全新任务表；
   * ② 续跑轮（resumeExecution = ask_user 问答/暂停补充）是同一 turn 的闭环收尾，与 chat() 同构
   * 走本方法——turn 真正结束即无条件清空，chat() 与续跑轮共用本收口点。
   *
   * 唯一例外是暂停态（pauseMeta）：turn 尚未真正结束，暂停恢复后要继续用 plan 推进，
   * 故保留不清；恢复完成后该 turn 最终退出时仍会走本方法无条件清空。
   *
   * 运行时状态（plan/planItemLog）清空，但对话记录里的 round-block 折叠块已沉淀为历史（不落盘删除）。
   * 挂点：chat() 与 resumeExecution 的 finally 块（generator close 时触发，确保所有 yield 已被宿主消费）
   */
  private clearPlanOnTurnEnd(): void {
    const sm = this._sessionManager;
    if (!sm) return;
    const cp = sm.getCheckpoint();
    if (!cp?.plan || cp.plan.length === 0) return;
    if (cp.pauseMeta) return; // 暂停态：turn 未真正结束，恢复时需继续用 plan，保留不清
    sm.clearPlan();
  }

  /**
   * 内核→宿主信号：当前会话是否可"无输入续跑"（决定暂停按钮显隐 + 暂停后继续 UI）
   *
   * 真值条件：① 状态机已 paused（已软暂停必可续跑，最高优先级——pauseRequested 在下一 step 边界才挂起，
   * 彼时 inAutonomousStep 已重置为 false，仅看它会误报）；② loop 在自主工具步（可暴露暂停按钮在边界挂起）；
   * ③ 存在未完成的计划任务项（多轮任务可续跑下一轮）。三者皆否（纯单轮、无待续目标）→ 隐藏暂停按钮（仅停止）。
   */
  canContinueWithoutInput(): boolean {
    if (this._sessionManager?.status === 'paused') return true;
    // 错误态不展示"继续"：error 态由检查点恢复回填进入，须显式处理（重新开始或 recover），避免点了静默无反应
    if (this._sessionManager?.status === 'error') return false;
    // 仅 pending/active（可推进）任务项计入"可续跑"——blocked 不续（全 blocked 由 isPlanAllBlocked 拦，
    // 避免全 blocked 计划按钮可点但 resumeExecution 早退）。判定走 SessionManager.hasInflightPlan
    // 单一真理源（禁内联谓词，SSOT 见 sessionManager.ts hasInflightPlan 注释），与 prepare/loop 同源。
    const hasPendingPlan = this._sessionManager?.hasInflightPlan() ?? false;
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
   * 创建会话检查点：快照当前运行时状态（热记忆等），生成纯内存态快照
   * （不落盘、无序列化/恢复路径——中止/断电走「中断轮补全为完整 turn」）。
   * 无 role/standard 会话能力位，createCheckpoint 仅收 mainGoal。
   */
  createCheckpoint(mainGoal?: string): SessionCheckpoint | null {
    this.assertInitialized('createCheckpoint');
    return this.requireSessionManager.createCheckpoint(mainGoal);
  }

  /**
   * 获取当前检查点
   */
  getCheckpoint(): SessionCheckpoint | null {
    this.assertInitialized('getCheckpoint');
    return this.requireSessionManager.getCheckpoint();
  }

  /**
   * 获取最近一次处理线程的工具执行历史（loop 域聚合出口，补待办 #3）
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
      logger.debug(
        { hasRoundStore: !!roundStore },
        'ensureForkSessionTitle: 无 RoundStore/新会话为空，跳过',
      );
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
   * 切换到指定项目：切换后自动 rebuildComponents()；Agent 级记忆存储（宿主注入，实例不随项目切换重建）保留，项目级配置（.memora/）重新加载
   *
   * `nameOrPath` 只接受两种输入：① 项目注册表中的项目名（依赖注册表跨项目共享，见 dataDir/registryDir）；
   * ② 项目根目录的**绝对路径**。二者都不满足时抛 configError——否则相对串会以 process.cwd()
   * 为基准解析，静默造出非预期的项目目录并占用其锁。
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
    // 注册表未命中时按路径处理。相对路径会以 process.cwd() 为基准解析——宿主进程的 cwd
    // 不具项目语义，会静默创建出非预期的项目目录并占用其锁，故只接受绝对路径。
    if (!target && !isAbsolute(nameOrPath)) {
      throw configError('项目切换失败', `「${nameOrPath}」既不是已注册的项目名，也不是绝对路径`, [
        '按名切换：先经 agent.projects.registerProject(项目路径, 项目名) 注册，并保证注册表跨项目共享（多项目共用同一 dataDir 或 registryDir）',
        '按路径切换：传入项目根目录的绝对路径',
      ]);
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
      // 组数据（宿主装配级）：组长角色包 + 组员名单（会议名单容器）
      rolePackTeams: this.#config.rolePackTeams,
      maxContextTokens: this.#config.maxContextTokens,
      sessionStore: this.#config.sessionStore,
      roundStore: this.#config.roundStore,
      tracer: this.#config.tracer,
      messages: this.#config.messages,
      enableContextSummary: this.#config.enableContextSummary,
      webSearchProvider: this.#config.webSearchProvider,
      fetchProvider: this.#config.fetchProvider,
      codeExecutionProvider: this.#config.codeExecutionProvider,
      projectSearchProvider: this.#config.projectSearchProvider,
      // 脚本执行 node 路径（可选）：透传装配 → toolExecutor/assembler 脚本执行回调
      scriptNodePath: this.#config.scriptNodePath,
      // 禁用技能清单：透传装配 → SkillManager.setDisabledSkills
      disabledSkills: this.#config.disabledSkills,
      existingSkillManager: this.skillManager,
      // 策略覆盖不经组装器：AssembleInput 零消费，真实消费链 = 本类
      // 构造 SeedOrchestrator deps 时直传（见 #createSeedOrchestrator 的 strategyOverride），
      // 经 resolveActiveStrategy 压过角色包声明——策略解析唯一链在 seed 侧。
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
        // 检查点恢复协议角色契约重注入 → Agent 生命周期（工具暴露面 / loop 前缀刷新）
        applyRolePackToolExposure: () => this.applyRolePackToolExposure(),
        refreshRolePackPrefixOnLoop: () => this.refreshRolePackPrefixOnLoop(),
        // 会议逐项切换：随 active 任务项刷新本轮装配视角
        applyActivePlanItemAssembly: () => this.applyActivePlanItemAssemblyIfChanged(),
      },
    });

    this.history = result.history;
    this.loop = result.loop;
    // 有效窗口变更 → 同步 ContextPreparer。有效窗口的**唯一计算点在 loop**
    // （min(provider 窗口, 角色包 contextLimit)），此处只做分发；用闭包读最新
    // internals.contextPreparer，避免与装配顺序耦合。
    this.loop.onContextWindowChanged = (effectiveTokens: number) => {
      this.internals.contextPreparer?.setMaxContextTokens(effectiveTokens);
    };
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

  /**
   * 运行时更新上下文窗口上限（token）
   *
   * 模型热切换配套：同步三处装配期值拷贝（loop 截断/软上限、ContextManager 阈值、
   * ContextPreparer 预算与占用快照），全部对新窗口即刻生效。对话进行中禁止更新
   * （与 setProvider 同守卫）。
   *
   * @param tokens 新窗口 token 数
   */
  setContextWindow(tokens: number): void {
    this.assertNotBusy('切换上下文窗口');
    this.#config.maxContextTokens = tokens;
    if (this.loop) {
      // loop 内部按 min(provider 窗口, 角色包 contextLimit) 重算**有效窗口**，并经
      // onContextWindowChanged 回调把有效值同步到 contextPreparer —— 计算点唯一（在 loop）。
      this.loop.setContextWindow(tokens);
    } else if (this.internals.contextPreparer) {
      // loop 尚未装配（早期阶段）：无角色策略可叠加，直接用 provider 窗口
      this.internals.contextPreparer.setMaxContextTokens(tokens);
    }
    logger.info({ providerWindow: tokens }, 'provider 上下文窗口已更新');
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
   * 角色包是 system prompt 的唯一注入源。调用时机：手动切换成功后、reloadConfig 重载后；
   * loop 为 null 时静默跳过（init 前或 close 后边界）。统一走 buildSystemPromptPrefix 真理源，
   * 全局技能清单也在该前缀内（不能只拼 rolePackPrompt）。等价于「按 activePack 视角刷新」（roundRole=null）。
   */
  private refreshRolePackPrefixOnLoop(): void {
    this.refreshRolePackPrefixForRound(null);
  }

  /**
   * 会议阶梯推进：按当前 active 任务项的 rolePack 派生本轮装配视角。
   *
   * 由 assembler.getTaskTable 每轮注入时驱动（hooks.applyActivePlanItemAssembly），与任务表渲染同源，
   * 保证后继 step 换角色即时生效（装配视角不能只在 prepare.run 设一次，否则展示层正确/装配层冻结）。
   * roundRole=candidate（可能为 null，无有效覆盖时回落 activePack 组长），调 refreshRolePackPrefixForRound 重建前缀。
   * 防重：candidate 与 rolePackManager 当前 roundAssemblyPerspective 一致则跳过，避免每轮迭代重复重建。
   */
  private applyActivePlanItemAssemblyIfChanged(): void {
    const plan = this._sessionManager?.getCheckpoint()?.plan ?? [];
    const active = plan.find((s) => s.status === 'active');
    const candidate = this._rolePackManager?.resolveRoundAssemblyRole(active?.rolePack) ?? null;
    if (candidate === this._rolePackManager?.roundAssemblyPerspective) return;
    this._rolePackManager?.setRoundAssemblyRole(candidate);
    this.refreshRolePackPrefixForRound(candidate);
    logger.debug({ roundAssemblyRole: candidate }, '会议装配视角随 active 任务项切换');
  }

  /**
   * 按本轮表层装配视角刷新 AgentLoop 前缀（会议机制）
   *
   * roundRole=null（日常态）→ 回落 activePack 前缀；roundRole 为任务项角色 → 该角色
   * persona/rules/skills 全量表层装配（buildSystemPrompt(name)）。策略键恒为 activePack：
   * ChatOptions（temperature/outputLimit）由 activePack 策略构建，不随视角变（键不换防抖动）。
   * 由 seed prepare 每轮调用（`refreshRolePackPrefixForRound` 契约），保证前缀始终匹配本轮装配角色。
   */
  private refreshRolePackPrefixForRound(roundRole: string | null): void {
    if (!this.loop) return;
    const assemblyName = roundRole ?? this._rolePackManager?.activeName ?? undefined;
    const rolePackPrompt = this._rolePackManager?.buildSystemPrompt(assemblyName) ?? '';
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
    // 角色包底盘占用随切换实时更新（不依赖跑 prepare）：装配此刻即确定的真值
    this.loop.setRolePackBaseTokens(estimateTokensMessages([{ content: newPrefix }]));
    // 同步注入角色包策略的 ChatOptions 覆盖项（temperature / outputLimit）
    // 键恒为 activePack：buildChatOptionsFromStrategy 读激活包策略，不随本轮装配视角变
    this.loop.setChatOptions(this.buildChatOptionsFromStrategy());
  }

  /**
   * 从当前激活的角色包策略构建 ChatOptions 覆盖项
   * 将 act.temperature / act.outputLimit 映射到 ChatOptions 字段，优先级高于全局默认值。
   */
  private buildChatOptionsFromStrategy(): Partial<ChatOptions> | undefined {
    const strategy = this.getActiveStrategy();
    if (!strategy) return undefined;

    const chatOptions: Partial<ChatOptions> = {};
    const act = strategy.act;

    // act.temperature → ChatOptions.temperature（限 0-2；边界 SSOT = strategyKeys.isTemperature，不重复字面量）
    const temperature = act?.temperature;
    if (isTemperature(temperature)) {
      chatOptions.temperature = temperature;
    }

    // act.outputLimit → ChatOptions.maxTokens（需 ∈ [1, MAX_OUTPUT_LIMIT]，越界忽略防资源失控）
    const outputLimit = act?.outputLimit;
    if (typeof outputLimit === 'number' && outputLimit > 0 && outputLimit <= MAX_OUTPUT_LIMIT) {
      chatOptions.maxTokens = outputLimit;
    }

    return Object.keys(chatOptions).length > 0 ? chatOptions : undefined;
  }

  /**
   * 角色包系统的唯一切换入口（自动匹配 + 手动切换共用）：activate 更新激活态 → 发射 rolePackSwitched 事件
   * → 刷新 AgentLoop 前缀 → 同步工具白名单。
   * @returns 是否切换成功。false 有两种成因（**均不发射切换事件**）：角色包不存在、
   * 切换锁已激活（30s 内超 5 次限流）；调用方须以 getRolePackSwitchLockStatus() 区分，
   * 不可由「返回 false + 未收到 rolePackSwitchLocked」推断为"不存在"（被锁时该事件不发射，
   * 仅在**触发锁定**的那一次切换中发射，而那一次返回 true）。同名切换幂等返回 true。
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
   * 重载配置类记忆：从 configDir 重新扫描指定 source 并更新内存缓存（设定记忆纯文件装载，不写记忆库），使当前会话立即生效（无需重启）。
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
   * 关闭 Agent，释放存储连接等资源
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
    // 关键约束：等待 backgroundTask 全局在途任务完成（如 touchScores）。
    // 否则 close 后后台任务仍可能 upsert 已关闭的 storage，触发写失效或异常。
    try {
      const awaited = await awaitBackgroundTasks(AGENT_CONSTANTS.SHUTDOWN_ARCHIVE_TIMEOUT_MS);
      if (awaited > 0) {
        logger.debug(
          { awaited },
          'close: 背景任务等待结束（awaited = 初始在途数，超时放弃时非完成数）',
        );
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
      // 若状态机仍 running，同步翻 paused 使检查点内存态一致（无需触发挂起，仅修正一致性）；
      // 系统清理不消耗连续暂停配额 → lowRisk=true
      if (sm.status === 'running') {
        sm.pause('close 清理残留暂停', 'system', true);
      }
      sm.cancelPendingPause();
    }

    // 清理 SessionManager（须先于 nullifyAllComponents，destroy 需访问其内部状态）
    if (this._sessionManager) {
      // 清脏后再 destroy（纯内存，无落盘；检查点不落盘，本调用为保留语义边界的 no-op）
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

  /** 记忆治理统一门面（语义去重 / 来源健康诊断 / 冲突检测 / 建议推荐），Agent 上的记忆管理方法统一收口于此（无显式衰减层面） */
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
        llm: {
          callCount: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          actualInputTokens: 0,
          actualOutputTokens: 0,
          emptyResponseCount: 0,
          pairingGuardFires: 0,
        },
        tools: {
          callCount: 0,
          failureCount: 0,
          unparsedToolIntentCount: 0,
          ledgerStubEchoCount: 0,
        },
        context: { truncationCount: 0, messageCount: 0, estimatedTokens: 0 },
        plan: { taskTableWriteCount: 0, planItemBoundaryCount: 0 },
        tasks: {
          totalCount: 0,
          successCount: 0,
          failureCount: 0,
          successRate: 0,
          avgDurationMs: 0,
        },
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
