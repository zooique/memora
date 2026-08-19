/**
 * Agent 门面类 — Memora 宿主项目接入入口
 *
 * 宿主通过 `import { Agent } from '@zooique/memora'` 一行接入。
 * 负责组件组装和核心对话编排，领域专属操作委托给专职 Manager
 * （RolePackManager / ToolExecutor / SkillManager / MemoryInspector）。
 */
import { getBaseName } from '@/utils/path.js';
import { AGENT_CONSTANTS, LOOP_CONSTANTS } from '@/agent/constants.js';
import type { AgentLoop } from '@/agent/loop.js';
import { COMPLETION_LEVELS } from '@/agent/types.js';
import type { AgentChunk, ArchiveMode, AgentOptions, AgentContext, AgentConfig, Role, Standard, IdempotencyLevel } from '@/agent/types.js';
import type { SessionEvent, SessionCheckpoint, ResolvedDelta, ToolExecutionRecord } from '@/agent/types.js';
import type { PreExecutionResult } from '@/agent/types.js';
import { BUILTIN_TOOL_IDEMPOTENCY, shouldSkipForIdempotency } from '@/agent/builtinTools.js';
import { Composer } from '@/agent/composer.js';
import type { PlanContext } from '@/agent/types.js';
import type { ToolExecutor } from '@/agent/toolExecutor.js';
import type { MessageHistory } from '@/agent/messageHistory.js';
import { ProjectManager, type ProjectContext } from '@/memory/projectManager.js';
import { SecurityGuard } from '@/security/pathGuard.js';
import { recall, boostScores } from '@/memory/recall.js';
import type { SkillManager } from '@/skill/skillManager.js';
import type { RolePackManager } from '@/role-pack/rolePackManager.js';
import {
  DEFAULT_BEHAVIOR_STRATEGY,
  resolveRecentRounds,
  resolveHandoff,
  resolveMemoryRecallMode,
  resolveMinFallback,
  resolveSummary,
  resolveSummaryFocus,
  resolveContextAssembly,
  resolveAutoSwitch,
  resolveL2Strategy,
  resolveRecallConfidence,
  resolveSummaryRecall,
} from '@/role-pack/types.js';
import type { BehaviorStrategy, MemoryRecallMode } from '@/role-pack/types.js';
import { resolveCapabilityTools } from '@/role-pack/capabilityMap.js';
import type { SessionArchiver, SessionArchiveResult } from '@/agent/managers/sessionArchiver.js';
import { SessionNamer } from '@/agent/managers/sessionNamer.js';
import type { TextPolishManager } from '@/agent/managers/textPolishManager.js';
import type { RoundSummaryGenerator } from '@/agent/managers/roundSummaryGenerator.js';
import type { WorkProjectionManager } from '@/agent/managers/workProjection.js';
import type { MemoryInspector } from '@/agent/managers/memoryInspector.js';
import type { DedupManager } from '@/agent/managers/dedupManager.js';
import type { MemoryAdvisor } from '@/agent/managers/memoryAdvisor.js';
import { assembleComponents, buildSystemPromptPrefix } from '@/agent/assembler.js';
import { chatBusyError, configError, isAbortError, toError } from '@/utils/errors.js';
import { SessionManager, type AgentForkResult } from '@/agent/managers/sessionManager.js';
import { renderTaskTable } from '@/agent/taskTableRenderer.js';
import { ChatLockManager } from '@/agent/managers/chatLockManager.js';
import { MemoryDecayScheduler } from '@/agent/managers/memoryDecayScheduler.js';
import { MemoryGovernance } from '@/agent/managers/memoryGovernance.js';
import { ArchiveCoordinator, type ArchiveTriggerOptions } from '@/agent/managers/archiveCoordinator.js';
import { TypedEventEmitter, type AgentEventMap, AGENT_EVENTS, AGENT_EVENT_SET } from '@/utils/eventEmitter.js';
import type { LlmProvider, Message, ChatOptions } from '@/llm/provider.js';
import type { ProviderRouter } from '@/llm/types.js';
import type { Memory } from '@/memory/types.js';
import { logger } from '@/logging/logger.js';
import type { AgentMetrics } from '@/agent/tracer.js';
import { TRACE_SPANS, NOOP_TRACER } from '@/agent/tracer.js';

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

  // 运行时组件（init 后填充）
  private projectManager: ProjectManager | null = null;
  private history: MessageHistory | null = null;
  private loop: AgentLoop | null = null;
  private toolExec: ToolExecutor | null = null;

  // 新模块
  private skillManager: SkillManager | null = null;
  /** 角色包管理器（角色+技能+规则的唯一真理源） */
  private rolePackManager_: RolePackManager | null = null;

  // 拆分出的专职 Manager
  private memoryInspector: MemoryInspector | null = null;
  /** 语义去重管理器（L1 LLM 记忆治理，从 MemoryInspector 拆出，令其回归纯存储读写） */
  private dedupManager: DedupManager | null = null;
  /**
   * 记忆顾问（L3 冲突检测 / sourceHealth / suggest）
   * detectConflicts 直连 advisor（免转发），sourceHealth/suggest 仍由 inspector 转发保持统一入口。
   */
  private memoryAdvisor: MemoryAdvisor | null = null;
  /** 记忆治理统一门面（L0/L1/L2/L3 + 诊断） */
  private _governance: MemoryGovernance | null = null;
  private workProjection: WorkProjectionManager | null = null;
  /** SessionArchiver（会话归档器，负责生成/更新 SessionMeta） */
  private sessionArchiver: SessionArchiver | null = null;
  /** 会话命名器（新建会话首次问答自动命名标题） */
  private sessionNamer: SessionNamer | null = null;
  /** TextPolishManager（文本润色管理器，LLM 语法修正 + 表达优化） */
  private textPolisher: TextPolishManager | null = null;
  /** 轮次摘要生成器（记忆即摘要架构） */
  private roundSummaryGenerator: RoundSummaryGenerator | null = null;
  /** 会话管理器（从 Agent 拆分出的会话管理职责） */
  private _sessionManager: SessionManager | null = null;

  // ─── 不中断工作模型 v2.0 ───────────────────────────────
  /** 四级补全器（四元组 + 三源融合） */
  private composer: Composer | null = null;

  // activeSkill 字段已移除：matchAndInjectSkill 改为当轮实时匹配注入，无需跨轮状态缓存

  private _initialized = false;
  // 项目上下文（AgentContext 与 ProjectContext 等价，直接使用后者避免重复字段）
  private pctx: ProjectContext | null = null;

  /** chat() 并发锁管理器（并发锁 + token 校验 + 超时保护 + 外部 signal 合并，init 时创建、close 时销毁） */
  private chatLockManager: ChatLockManager | null = null;
  /** 最近一次 chat() 调用的时间戳 */
  private _lastInteractionAt: Date | null = null;
  /** 最近一次角色包粘性匹配的会话 ID（粘性不跨会话，会话切换时复位，由 prepareChatContext 驱动） */
  private lastStickySessionId: string | null = null;
  /**
   * 对话中因 chatLock 冲突暂存的配置重载请求（锁释放后补执行，兑现"对话后自动加载"）；
   * 用 Set 去重——同一 source 只需补执行一次。
   */
  private pendingConfigReload = new Set<string>();
  /**
   * 工具执行暂存队列（工具幂等 outbox）
   * assembler 中 loop 先于 sessionManager 创建，回调暂存于此，flush 阶段统一写入。
   */
  private _pendingToolExecutions: ToolExecutionRecord[] = [];

  // 衰减职责已拆分至 MemoryDecayScheduler，指标经 getMetrics() 读取
  /** 记忆衰减调度器（init 时创建，close 时销毁） */
  private memoryDecayScheduler: MemoryDecayScheduler | null = null;
  /** 归档协调器（归档操作委托给 ArchiveCoordinator） */
  private archiveCoordinator: ArchiveCoordinator | null = null;

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
      configDir: opts.configDir,
      // 启动时激活的角色包名（宿主注入持久化值，init 时优先激活）
      activeRolePack: opts.activeRolePack,
      tracer: opts.tracer,
      messages: opts.messages,
      enableContextSummary: opts.enableContextSummary ?? true,
      archiveMode: opts.archiveMode ?? 'full',
      webSearchProvider: opts.webSearchProvider,
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

    // 加载持久化的会话检查点；若上次会话在暂停/异常中关闭，加载后恢复状态机；
    // 若为 paused 还需恢复热记忆 + 温记忆召回 + 契约重注入（重启后上下文完整）
    const persistedCheckpoint = this._sessionManager?.loadPersistedCheckpoint();
    if (persistedCheckpoint && persistedCheckpoint.status === 'paused') {
      await this.restoreFromCheckpoint(persistedCheckpoint);
    }

    return pctx;
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
      this.archiveCoordinator
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
  private createPostInitComponents(pctx: ProjectContext): void {
    // chat() 并发锁管理器（生命周期与 Agent 实例一致）
    this.chatLockManager = new ChatLockManager();

    // 四级补全器（不中断工作模型 v2.0）
    this.composer = new Composer();

    // 归档操作委托给 ArchiveCoordinator（content 会话归档）
    this.archiveCoordinator = new ArchiveCoordinator({
      getSessionArchiver: () => this.sessionArchiver,
      getArchiveMode: () => this.#config.archiveMode,
      emit: (event, payload) => this.emit(event, payload as never),
    });

    // 会话命名器：新建会话首次问答自动命名标题；惰性获取当前 provider（切换后仍命中最新模型）
    this.sessionNamer = new SessionNamer({
      getProvider: () => this.#provider,
      sessionStore: this.#config.sessionStore,
    });

    // 记忆衰减职责委托给 MemoryDecayScheduler
    this.memoryDecayScheduler = new MemoryDecayScheduler({
      tracer: this.#config.tracer,
      onDecayCompleted: (payload) => {
        this.emit(AGENT_EVENTS.decayCompleted, payload);
        // 衰减循环完成时触发 L2 时效性评估
        void this._governance?.evaluateTimeliness().catch((err: unknown) => {
          logger.warn({ err }, 'L2 时效性评估自动触发失败（已降级，不影响衰减循环）');
        });
      },
      backgroundProvider: this.#backgroundProvider,
      index: pctx.index,
    });
    this.memoryDecayScheduler.start(pctx.index, AGENT_CONSTANTS.DECAY_INTERVAL_MS);

    // 记忆治理统一门面（L0/L1/L2/L3 + 诊断）
    this._governance = new MemoryGovernance(
      this.dedupManager,
      this.memoryDecayScheduler,
      this.memoryAdvisor,
    );
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

      // 上下文准备：角色匹配 → 记忆召回 → 技能注入 → 历史追加
      const recalledMemories = yield* this.prepareChatContext(input, combinedSignal);

      if (combinedSignal.aborted) {
        yield {
          type: 'aborted',
          reason: this.#config.messages?.abortedByUser ?? 'User cancelled the conversation',
        };
        return;
      }

      // LLM 流式调用 → 助手消息写历史 → 后处理
      yield* this.executeChatLoop(input, recalledMemories, combinedSignal);
    } finally {
      // 仅当本调用仍是当前锁持有者时才清理资源（token 校验）
      this.chatLockManager?.release(myToken);
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
    const chatLock = this.chatLockManager;
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
   * 准备对话上下文：角色匹配 → 记忆召回 → 技能注入 → 用户消息写历史
   * @returns 召回的记忆列表（供 loop.processUserInput 注入为 system 消息）
   */
  private async *prepareChatContext(
    input: string,
    combinedSignal: AbortSignal,
  ): AsyncGenerator<AgentChunk, Memory[], unknown> {
    const loop = this.requireLoop;
    loop.cleanTemporarySystemMessages();

    // 会话切换时复位角色包粘性（粘性不跨会话）
    const sessionId = this._sessionManager?.getCheckpoint()?.sessionId ?? '';
    if (sessionId !== this.lastStickySessionId) {
      this.rolePackManager_?.resetSticky();
      this.lastStickySessionId = sessionId;
    }

    // autoSwitch 决定是否允许角色自动匹配（'off' 时锁定当前角色包）
    const preMatchStrategy = this.getActiveStrategy();
    const autoSwitch = resolveAutoSwitch(preMatchStrategy);

    // 角色包自动匹配（粘性 + LLM 兜底，角色包为唯一入口）
    if (autoSwitch === 'on') {
      await this.tryAutoMatchRolePack(input);
    }

    const strategy = this.getActiveStrategy();
    // 枚举键经集中解析（SSOT 兜底）：非法值归位内核默认，不透传
    const memoryRecallMode = resolveMemoryRecallMode(strategy);
    // 上下文装配策略：fixed=仅固定轮次 / query=仅语义召回 / hybrid=混合
    const contextAssembly = resolveContextAssembly(strategy);

    // 单一 setStrategy 聚合 L2 策略（工具权限/步数/错误处理/路由/预算/推理/只读/审批/自审查）
    loop.setStrategy(resolveL2Strategy(strategy));

    // 换角色 → 按激活角色包的 capabilities 应用工具暴露面（toolMode=block 全禁与此正交）
    this.applyRolePackToolExposure();

    yield { type: 'thinking', phase: 'recalling' };
    const recalledMemories = await this.recallAndInject(input, memoryRecallMode, contextAssembly);

    if (combinedSignal.aborted) return recalledMemories;

    // 技能当轮注入生效，生成 roundId 供 appendUser 溯源（user/assistant/摘要同 roundId）
    yield { type: 'thinking', phase: 'processing' };
    this.matchAndInjectSkill(input);

    const roundId = `round-${Date.now()}`;
    loop.setCurrentRoundId(roundId);

    const history = this.requireHistory;
    await history.appendUser(input, roundId);

    // 会话标题自动命名（fire-and-forget）：仅新建会话首次问答触发（以"会话无标题"判定，不覆盖手动改名）
    if (this.sessionNamer) {
      void this.sessionNamer
        .ensureSessionTitle(history.currentDateValue, history.currentSessionValue, input)
        .catch((err: unknown) => {
          logger.warn({ err }, '会话标题自动命名失败（best-effort，不阻塞对话）');
        });
    }

    return recalledMemories;
  }

  /**
   * 执行 LLM 流式循环 → 追加助手消息 → 触发后处理
   */
  private async *executeChatLoop(
    input: string,
    recalledMemories: Memory[],
    combinedSignal: AbortSignal,
  ): AsyncGenerator<AgentChunk, void, unknown> {
    const loop = this.requireLoop;
    const history = this.requireHistory;

    // 流消费统一收口于 consumeExecutionStream（与 processEvent / resumeExecution 共用同构实现，
    // 避免此前续跑路径漏 paused 分支导致的锁泄漏）
    const streamResult = yield* this.consumeExecutionStream(
      // 传 roundId 保证 user/assistant/摘要同 roundId，traceSummary 溯源完整
      loop.processUserInput(input, recalledMemories, combinedSignal, loop.getCurrentRoundId()),
    );
    if (streamResult.failed) return;
    const assistantContent = streamResult.content;
    const wasAborted = streamResult.aborted;

    if (wasAborted) {
      if (assistantContent.trim()) {
        const interruptedMark = this.#config.messages?.interrupted ?? '\n\n[已中断]';
        try {
          await history.appendAssistant(assistantContent + interruptedMark, loop.getCurrentRoundId());
        } catch (err) {
          logger.warn({ err }, '中断消息历史写入失败');
        }
      }
      return;
    }

    try {
      await history.appendAssistant(assistantContent, loop.getCurrentRoundId());
    } catch (err) {
      logger.warn({ err }, '助手消息历史写入失败');
    }

    yield { type: 'thinking', phase: 'archiving' };
    // 非阻塞：即使 LLM 摘要生成慢，generator 立即 yield handoff/done 让 UI 结束生成态，后处理后台异步完成
    this.postProcess(input, assistantContent).catch((err) => {
      logger.warn({ err }, '非阻塞后处理失败');
    });

    // Handoff 衔接决策：经 resolveHandoff 归位非法值，避免透传无法识别的衔接决策给宿主
    const handoffStrategy = resolveHandoff(this.getActiveStrategy());
    yield { type: 'handoff', decision: handoffStrategy, reason: handoffStrategy === 'wait' ? undefined : 'L2 策略自动衔接' };
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
    this.chatLockManager?.forceRelease();
  }

  /**
   * 召回记忆 + 注入最近对话上下文
   *
   * 策略控制：'full' 全量 / 'limited' 限额（memoryRecallQuota token 配额裁剪）/ 'none' 跳过仅注入最近对话。
   * 装配方式 prepare.contextAssembly：'fixed' 仅加载最近 N 轮 / 'query' 仅语义召回 / 'hybrid' 混合（默认）。
   *
   * @param memoryRecallMode L2 策略指定的记忆召回模式
   * @param contextAssembly L2 策略指定的上下文装配方式
   * @returns 召回的记忆列表
   */
  private async recallAndInject(
    input: string,
    memoryRecallMode: MemoryRecallMode,
    contextAssembly: 'fixed' | 'query' | 'hybrid',
  ): Promise<Memory[]> {
    // 策略控制：'none' 模式跳过实际召回，仅注入最近对话
    let recalledMemories: Memory[] = [];

    // 固定加载轮数 N（SSOT 单一来源）：角色包 recentRounds 为合法正整数时采用，缺失/非法降级内核默认；
    // 互斥窗口与最近对话注入共用同一 N，保证"正文加载 N 轮 ⟺ 互斥排除 N 轮"一致
    const recentRounds = resolveRecentRounds(this.getActiveStrategy());

    // 互斥 roundId 集合：当前会话最近 N 轮正文已完整加载，其 round-summary 不应再被召回注入。
    // 前置传入 recall() 在取 limit 前过滤，避免被排除摘要挤占 top-limit 预算（跨会话记忆补位）
    const recentRoundIds = new Set(this.requireHistory.getRecentRoundIds(recentRounds));

    // ── 语义召回：contextAssembly !== 'fixed' 时执行（query / hybrid） ──
    if (contextAssembly !== 'fixed' && memoryRecallMode !== 'none') {
      const tracer = this.#config.tracer ?? NOOP_TRACER;
      const recallSpan = tracer.startSpan(TRACE_SPANS.RECALL_ACTUAL, {
        queryLength: input.length,
        hasVectorStore: !!this.#config.vectorStore,
        memoryRecallMode,
      });

      try {
        // 条数上限统一 DEFAULT_RECALL_LIMIT（full/limited 共用有界条数）；
        // limited 模式在返回后按 token 配额换算的字符预算裁剪
        recalledMemories = await recall(
          this.requirePctx.index,
          input,
          {
            limit: AGENT_CONSTANTS.DEFAULT_RECALL_LIMIT,
            vectorStore: this.#config.vectorStore,
            excludeSources: this.#config.recallExcludeSources,
            // 会话窗口标识与写入侧 sessionName 同源同值，保证"同窗口优先"命中当前会话
            sessionId: this.requireHistory.currentSessionName,
            // 召回保底下限：角色包 prepare.minFallback 控制，非法/缺失回退默认 2
            minFallback: resolveMinFallback(this.getActiveStrategy()),
            // 前置互斥排除：取 limit 前过滤当前会话最近 N 轮 round-summary
            excludeRoundIds: recentRoundIds,
            // 召回置信度阈值（0.0-1.0）
            minSimilarity: resolveRecallConfidence(this.getActiveStrategy()),
          },
        );

        // limited 配额分层（记忆与摘要各有 token 配额，避免挤占）
        if (memoryRecallMode === 'limited') {
          const quotaTokens = this.getActiveStrategy().prepare?.memoryRecallQuota;
          if (typeof quotaTokens === 'number' && quotaTokens > 0) {
            const charBudget = quotaTokens * LOOP_CONSTANTS.CHARS_PER_TOKEN;
            let usedChars = 0;
            const trimmed: Memory[] = [];
            for (const m of recalledMemories) {
              const cost = m.content.length + 1;
              if (usedChars + cost > charBudget) break;
              usedChars += cost;
              trimmed.push(m);
            }
            recalledMemories = trimmed;
          }
        }
      } catch (err) {
        recallSpan.recordException(err instanceof Error ? err : new Error(String(err)));
        throw err;
      } finally {
        recallSpan.setAttribute('resultCount', recalledMemories.length);
        recallSpan.end();
      }

      // summaryRecall='off' → 过滤摘要类记忆（保留原始记忆）
      const summaryRecall = resolveSummaryRecall(this.getActiveStrategy());
      if (summaryRecall === 'off') {
        recalledMemories = recalledMemories.filter((m) => m.source !== 'round-summary');
      }

      if (recalledMemories.length > 0) {
        this.emit(AGENT_EVENTS.memoryRecalled, { count: recalledMemories.length, query: input });
        // boost 持久化为 fire-and-forget（软指标 +0.05/次 上限 1.0），失败仅 log 不阻塞 chat 读路径
        const ids = recalledMemories.map((m) => m.id);
        void boostScores(this.requirePctx.index, ids).catch((err: unknown) => {
          logger.warn({ err }, 'boost 持久化失败（不影响 chat 流程）');
          this.emit(AGENT_EVENTS.boostPersistFailed, { memoryId: ids.join(','), message: toError(err).message });
        });
      }
    }

    // ── 固定轮次注入：contextAssembly !== 'query' 时执行（fixed / hybrid） ──
    if (contextAssembly !== 'query') {
      const loop = this.requireLoop;
      const recentHistory = loop.getRecentHistory(recentRounds);
      if (recentHistory.length > 0) {
        const msgs = this.#config.messages;
        const label = msgs?.recentConversationLabel ?? '[Recent conversation]';
        const userLabel = msgs?.userLabel ?? 'User';
        const assistantLabel = msgs?.assistantLabel ?? 'Assistant';
        const recentPrompt =
          `${label}\n` +
          recentHistory
            .map((m) => `${m.role === 'user' ? userLabel : assistantLabel}：${m.content}`)
            .join('\n');
        loop.injectSystemMessage(recentPrompt);
        logger.debug({ turns: recentHistory.length / 2 }, '最近对话已注入');
      }
    }

    // 跨窗口召回摘要按 createdAt 升序排列，帮助 LLM 识别"最近偏好"（越早越靠前）
    recalledMemories = [...recalledMemories].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );

    return recalledMemories;
  }

  /**
   * 匹配技能并立即注入本轮对话（当轮生效，与角色包自动匹配同模式）
   * 匹配策略：regex trigger 优先（score=1.0），其次关键词匹配（阈值 0.3）；
   * cleanTemporarySystemMessages() 每轮清临时 system 消息，技能 prompt 不跨轮累积。
   */
  private matchAndInjectSkill(input: string): void {
    if (!this.skillManager || !this.loop) return;
    try {
      const match = this.skillManager.match(input);
      if (match) {
        const skillPrompt = this.skillManager.buildSystemPrompt(match.skill.name);
        if (skillPrompt) {
          this.loop.injectSystemMessage(skillPrompt);
          logger.debug({ skill: match.skill.name, score: match.score }, '技能 prompt 已注入（当轮生效）');
        }
        this.emit(AGENT_EVENTS.skillMatched, { skill: match.skill.name, score: match.score });
      }
    } catch (err) {
      logger.warn({ err }, '技能匹配失败');
    }
  }

  /**
   * 对话后处理：round-summary 生成、角色匹配、技能匹配
   *
   * 所有操作均 best-effort：失败仅记日志，不向上抛、不影响用户已收到的回答。
   * 归档模式二态：'full' 会话切换前自动归档 / 'manual' 跳过自动归档（用户手动调用 archiveSession()）；
   * 角色匹配 + 技能匹配非归档行为，不受 archiveMode 影响，每轮都执行。
   */
  private async postProcess(input: string, assistantContent: string): Promise<void> {
    const tracer = this.#config.tracer ?? NOOP_TRACER;
    const span = tracer.startSpan(TRACE_SPANS.POST_PROCESS, {
      archiveMode: this.#config.archiveMode,
    });

    try {
      await this.doPostProcess(input, assistantContent);
    } finally {
      span.end();
    }
  }

  /**
   * postProcess 内部实现（外层负责 span 生命周期），归档二态控制集中在 ArchiveCoordinator：
   * 统一传 { autoTriggered: true } 由其按 archiveMode 判断是否跳过；角色/技能匹配属"配置学习"，每轮执行。
   */
  private async doPostProcess(input: string, assistantContent: string): Promise<void> {
    const history = this.requireHistory;

    // 记忆为 round-summary 单轨，无独立画像/洞察归档路径。

    // 轮次摘要生成（记忆即摘要架构）：reflect.summary='off' 时跳过
    if (this.roundSummaryGenerator && resolveSummary(this.getActiveStrategy()) === 'on') {
      try {
        const roundId = this.requireLoop.getCurrentRoundId();
        const sessionName = history.currentSessionName;
        // 提炼视角：激活角色包 prepare.summaryFocus → 注入摘要生成（结构化角色包以此替换通用归纳框架）
        const summaryFocus = resolveSummaryFocus(this.getActiveStrategy());
        // fire-and-forget：不阻塞主流程，失败仅记日志
        const summaryPromise = this.roundSummaryGenerator.generate(input, assistantContent, roundId, sessionName, summaryFocus);
        history.registerPendingArchive(summaryPromise);
      } catch (err) {
        logger.warn({ err }, '轮次摘要生成初始化失败');
      }
    }
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
      if (checkpoint && this.composer) {
        // 收集计划上下文（执行计划管理）
        const sm = this._sessionManager!;
        const planCtx: PlanContext | undefined = checkpoint.plan.length > 0
          ? {
              stalled: sm.isPlanStalled(),
              activeStep: sm.getActiveStep()?.description,
              pendingStep: sm.getNextPendingStep()?.description,
            }
          : undefined;

        const composeResult = this.composer.compose(event, checkpoint, planCtx);

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
                { consecutivePauseCount: sm.getConsecutivePauseCount(), filteredCount: highRiskQuestions.length },
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
            this.emit(AGENT_EVENTS.needClarify, composeResult.needClarify.map((q) => ({
              slot: q.slot,
              question: q.question,
              options: q.options,
            })));
            // 全为低风险才不计入连续暂停计数——用 every：只要存在高风险，本次暂停就确实在索取确认、应消耗配额；
            // some 会让混合场景免费逃逸计数，反向打开滥用面。
            const allLowRisk = composeResult.needClarify.every((q) => q.lowRisk);
            this.pause(
              `需要澄清：${composeResult.needClarify.map((q) => q.question).join('; ')}`,
              'agent',
              allLowRisk,
            );
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
      const loop = this.requireLoop;
      const recalledMemories = yield* this.prepareChatContext(event.content, combinedSignal);

      if (combinedSignal.aborted) {
        yield {
          type: 'aborted',
          reason: this.#config.messages?.abortedByUser ?? 'User cancelled the conversation',
        };
        return;
      }

      // 预判是否提示 LLM 生成任务表（仅 plan 为空时触发）
      if (this.shouldGenerateTaskTable(event, this._sessionManager?.getCheckpoint() ?? undefined)) {
        loop.injectSystemMessage(
          '如果需要分步完成任务，请使用 task_table_write 工具创建任务表，' +
          '包含各步骤的描述（description）。每完成一步使用 task_table_update 工具更新对应步骤状态。' +
          '任务表仅作参考，LLM 可自行决定执行顺序。',
        );
      }

      // 委托给 AgentLoop.processEvent（流消费收口于 consumeExecutionStream）
      const streamResult = yield* this.consumeExecutionStream(
        loop.processEvent(event, recalledMemories, combinedSignal),
      );
      if (streamResult.failed) return;
      const assistantContent = streamResult.content;
      const wasAborted = streamResult.aborted;

      if (wasAborted) {
        if (assistantContent.trim()) {
          const interruptedMark = this.#config.messages?.interrupted ?? '\n\n[已中断]';
          try {
            await this.requireHistory.appendAssistant(assistantContent + interruptedMark, loop.getCurrentRoundId());
          } catch (err) {
            logger.warn({ err }, '中断消息历史写入失败');
          }
        }
        return;
      }

      try {
      await this.requireHistory.appendAssistant(assistantContent, loop.getCurrentRoundId());
    } catch (err) {
      logger.warn({ err }, '助手消息历史写入失败');
    }

    yield { type: 'thinking', phase: 'archiving' };
      this.postProcess(event.content, assistantContent).catch((err) => {
        logger.warn({ err }, '非阻塞后处理失败');
      });

      // Handoff 衔接决策：经 resolveHandoff 归位非法值，避免透传无法识别的衔接决策给宿主
      const handoffDecision = resolveHandoff(this.getActiveStrategy());
      yield { type: 'handoff', decision: handoffDecision, reason: handoffDecision === 'wait' ? undefined : 'L2 策略自动衔接' };
    } finally {
      this.chatLockManager?.release(myToken);
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
  async *resumeExecution(input?: string, signal?: AbortSignal): AsyncGenerator<AgentChunk, void, unknown> {
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

      const loop = this.requireLoop;

      // 流消费与 chat 主路径共用同一实现，杜绝两条路径再次漂移
      const streamResult = yield* this.consumeExecutionStream(loop.continueAfterPause(input, combinedSignal));
      if (streamResult.failed) return;
      const assistantContent = streamResult.content;
      const wasAborted = streamResult.aborted;

      if (wasAborted) {
        if (assistantContent.trim()) {
          const interruptedMark = this.#config.messages?.interrupted ?? '\n\n[已中断]';
          try {
            await this.requireHistory.appendAssistant(assistantContent + interruptedMark, loop.getCurrentRoundId());
          } catch (err) {
            logger.warn({ err }, '中断消息历史写入失败');
          }
        }
        return;
      }

      try {
      await this.requireHistory.appendAssistant(assistantContent, loop.getCurrentRoundId());
    } catch (err) {
      logger.warn({ err }, '助手消息历史写入失败');
    }

    yield { type: 'thinking', phase: 'archiving' };
      this.postProcess(input ?? '', assistantContent).catch((err) => {
        logger.warn({ err }, '非阻塞后处理失败');
      });
    } finally {
      // 与 chat() 同构：释放锁 + 清理外部 signal
      this.chatLockManager?.release(myToken);
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
  ): AsyncGenerator<AgentChunk, { content: string; aborted: boolean; failed: boolean }, unknown> {
    let content = '';
    let aborted = false;

    try {
      for await (const chunk of source) {
        // 内核事实驱动：loop 在迭代边界真正挂起时状态机才翻 PAUSED，非申请即翻转；
        // 与 requestPause 空闲分支同源，须传 lowRisk=true 保持同一暂停事件契约（否则流中暂停计入 P4 配额）
        if (chunk.type === 'paused') {
          const pendingInfo = this._sessionManager?.consumePendingPause();
          this.pause(pendingInfo?.reason ?? '用户主动暂停', pendingInfo?.source ?? 'user', true);
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
      return { content, aborted, failed: true };
    } finally {
      // 释放暂停幂等锁覆盖三路——残留会让 requestPause 的幂等检查永久拒绝后续暂停请求
      this._sessionManager?.cancelPendingPause();
      // 同步清理 loop 的 pauseRequested 标志
      this.requireLoop.clearPauseRequest();
    }

    return { content, aborted, failed: false };
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
        return answers
          .map((a) => `${slotLabels[a.slot] ?? a.slot}：${a.answer}`)
          .join('；');
      }
    } catch {
      // JSON 解析失败：原样返回，不阻断后续流程
    }
    return content;
  }

  // ─── 检查点恢复协议（温记忆按需召回 + 契约重注入） ──

  /**
   * 温记忆按需召回（检查点恢复协议步骤③）
   *
   * 以 mainGoal/currentGoal 查询，从温记忆（归档 recall）召回窗口外早期上下文，
   * 合并进资源槽（memories + context）并注入 loop 的 system message，让恢复后感知暂停前完整上下文。
   * 召回失败静默降级，仅记日志，不影响热窗口恢复与契约重注入。
   */
  private async warmRecallForCheckpoint(checkpoint: SessionCheckpoint): Promise<void> {
    // 以 mainGoal/currentGoal 拼接为查询条件
    const query = [checkpoint.mainGoal, checkpoint.currentGoal]
      .filter((s) => s && s.trim().length > 0)
      .join(' ');

    if (!query.trim()) {
      logger.debug('温记忆按需召回：mainGoal/currentGoal 均为空，跳过');
      return;
    }

    try {
      const recalledMemories = await recall(
        this.requirePctx.index,
        query,
        {
          limit: AGENT_CONSTANTS.DEFAULT_RECALL_LIMIT,
          vectorStore: this.#config.vectorStore,
          excludeSources: this.#config.recallExcludeSources,
        },
      );

      if (recalledMemories.length === 0) {
        logger.debug({ query }, '温记忆按需召回：无相关记忆');
        return;
      }

      // 将召回的温记忆 ID 去重合并到资源槽 memories
      const sm = this.requireSessionManager;
      const currentResource = sm.getCheckpoint()?.resource;
      if (currentResource) {
        const existingIds = new Set(currentResource.memories);
        const newIds = recalledMemories
          .map((m) => m.id)
          .filter((id) => !existingIds.has(id));
        if (newIds.length > 0) {
          sm.updateResource({
            ...currentResource,
            memories: [...currentResource.memories, ...newIds],
            // context 末尾追加温记忆召回摘要，标记召回来源
            context:
              currentResource.context +
              (currentResource.context ? '\n' : '') +
              `[温记忆召回: ${recalledMemories.map((m) => `${m.source}:${m.name || m.id}`).join(', ')}]`,
          });
        }
      }

      // 将温记忆注入为系统消息，让 Agent 感知暂停前的早期上下文
      const loop = this.requireLoop;
      const warmContext = recalledMemories
        .map((m) => `[${m.source}:${m.name || m.id}] ${m.content}`)
        .join('\n\n');
      loop.injectSystemMessage(
        `[恢复的早期上下文]\n以下为会话暂停前归档的早期上下文：\n\n${warmContext}`,
      );

      this.emit(AGENT_EVENTS.memoryRecalled, {
        count: recalledMemories.length,
        query,
      });

      logger.info(
        { count: recalledMemories.length, query },
        '温记忆按需召回完成，已合并到资源槽并注入参考上下文',
      );
    } catch (err) {
      // 温记忆召回失败时静默降级：仅记录日志，不影响热窗口恢复和后续流程
      logger.warn({ err }, '温记忆按需召回失败（降级：仅恢复热窗口和契约）');
    }
  }

  /**
   * 契约重注入（检查点恢复协议步骤④），确保恢复后 system prompt 与暂停前一致：
   * - 角色契约：按检查点角色切换 persona 并刷新 system prompt
   * - 技能契约：按资源槽文档路径匹配技能注入
   * - 规则契约：由 AgentLoop 的 bootstrap 机制自动注入，无需额外处理
   * 角色不存在静默降级（保持当前角色），技能匹配失败仅记日志。
   */
  private reinjectContracts(checkpoint: SessionCheckpoint): void {
    // 角色包契约重注入：按检查点角色名刷新系统 prompt
    if (this.rolePackManager_ && checkpoint.role.name) {
      try {
        const prevName = this.rolePackManager_.activeName;
        if (prevName !== checkpoint.role.name) {
          // 角色包不存在时 activate 返回 false
          const success = this.rolePackManager_.activate(checkpoint.role.name);
          if (success) {
            this.emit(AGENT_EVENTS.rolePackSwitched, {
              from: prevName,
              to: checkpoint.role.name,
            });
            this.applyRolePackToolExposure();
          }
        }
        // 无论是否切换都刷新前缀，确保角色包 prompt 注入 loop
        this.refreshRolePackPrefixOnLoop();
      } catch (err) {
        // 角色包不存在时静默降级：保持当前角色，仅记日志
        logger.warn(
          { err, roleName: checkpoint.role.name },
          '契约重注入：角色包切换失败，保持当前角色',
        );
      }
    }

    // 技能契约重注入：按资源槽文档路径尝试匹配技能
    if (this.skillManager && this.loop) {
      try {
        for (const doc of checkpoint.resource.documents) {
          this.matchAndInjectSkill(doc);
        }
      } catch (err) {
        logger.warn({ err }, '契约重注入：技能重注入失败');
      }
    }

    // 规则契约由 AgentLoop 的 bootstrapMemories 自动注入，无需额外处理

    logger.info(
      {
        role: checkpoint.role.name,
        skillDocCount: checkpoint.resource.documents.length,
      },
      '契约重注入完成',
    );
  }

  /**
   * 暂停会话（用户/Agent/系统均可触发，暂停前自动创建检查点）
   * @param lowRisk 低风险暂停不计入 P4 连续暂停计数（默认 false）
   */
  pause(
    reason: string,
    source: 'user' | 'agent' | 'system' = 'user',
    lowRisk = false,
  ): boolean {
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

  /** 兜底停滞计数器——连续无 task_table_update 的回合数 */
  private _stalledRoundCount = 0;

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
   * 执行中插话（Phase 5）
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
   * 预判是否应提示 LLM 生成任务表：保守默认 false，仅 plan 为空且输入含明确多步信号时返回 true（不依赖 composer）
   */
  private shouldGenerateTaskTable(event: SessionEvent, checkpoint?: SessionCheckpoint): boolean {
    // 已有任务表不再生成
    if (!checkpoint || checkpoint.plan.length > 0) return false;

    const content = event.content ?? '';

    // 多步信号关键词（中英文，保守匹配）
    const multiStepSignals = [
      '第一步', '第二步', '步骤', '首先', '然后', '接下来',
      '先做', '再做', '最后', '分步', '逐步',
      'step 1', 'step1', 'step 2', 'step2',
      'first', 'then', 'next', 'finally',
      '计划', '规划', '安排', '任务表',
      'plan', 'task list', 'todo',
    ];

    return multiStepSignals.some((signal) => content.includes(signal));
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
      this._sessionManager?.getCheckpoint()?.plan.some(
        (s) => s.status === 'pending' || s.status === 'active',
      ) ?? false;
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
  createCheckpoint(
    mainGoal?: string,
    role?: Role,
    standard?: Standard,
  ): SessionCheckpoint | null {
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

    // ①② 快照反序列化 + 热窗口载入（SessionManager，async 需 await）
    const messageCount = await this.requireSessionManager.restoreFromCheckpoint(checkpoint);

    // ③ 温记忆按需召回（以 mainGoal/currentGoal 查询早期上下文）
    await this.warmRecallForCheckpoint(checkpoint);

    // ④ 契约重注入（persona/skill）
    this.reinjectContracts(checkpoint);

    logger.info(
      { sessionId: checkpoint.sessionId, messageCount },
      '检查点恢复协议完成（热窗口 + 温记忆 + 契约重注入）',
    );

    return messageCount;
  }

  /**
   * 处理会话事件回调（从 AgentLoop 接收），按事件类型触发状态机转换或检查点更新
   */
  private handleSessionEvent(eventType: string, detail: string): void {
    const sm = this._sessionManager;
    if (!sm) return;

    switch (eventType) {
      case 'correction':
        // 修正事件：更新目标版本
        sm.updateGoal(detail);
        break;
      case 'clarify':
        // 澄清事件：记录心跳
        sm.heartbeat();
        break;
      case 'chat':
        // 对话事件：记录心跳
        sm.heartbeat();
        break;
      default:
        break;
    }
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
   * 分叉当前会话（委托至 SessionManager）：原会话完整保留，新分支独立消息历史；记忆索引全局共享不受影响
   */
  forkSession(targetSession?: string): AgentForkResult {
    this.assertInitialized('forkSession');
    return this.requireSessionManager.forkSession(targetSession);
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
   * 组装所有运行时组件（委托给 assembler 工厂）
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
      tracer: this.#config.tracer,
      messages: this.#config.messages,
      enableContextSummary: this.#config.enableContextSummary,
      webSearchProvider: this.#config.webSearchProvider,
      existingSkillManager: this.skillManager,
      // 事件回调组（8 个平铺回调收进 callbacks，与 AssembleCallbacks 接口对齐）
      callbacks: {
        onWorkProjectionGenerated: (sourcePath, summary) => {
          this.emit(AGENT_EVENTS.workProjectionGenerated, { sourcePath, summary });
        },
        onContextTruncated: (skippedCount, keptCount) => {
          this.emit(AGENT_EVENTS.contextTruncated, { skippedCount, keptCount });
        },
        onDedupCompleted: (report) => {
          this.emit(AGENT_EVENTS.dedupCompleted, { deduplicatedCount: report.deduplicatedCount, demotedIds: report.demotedIds });
        },
        onSessionEvent: (eventType, detail) => {
          this.handleSessionEvent(eventType, detail);
        },
        // 工具执行完成回调（幂等 outbox + 补偿机制）：记录执行到检查点供恢复排重，幂等级别供补偿识别
        onToolExecuted: (name, args, toolResult, ok) => {
          // 幂等级别查内置映射表，自定义工具默认非幂等
          const idempotent: IdempotencyLevel = BUILTIN_TOOL_IDEMPOTENCY[name] ?? 'non-idempotent';
          const record: ToolExecutionRecord = {
            name,
            argsSignature: args,
            executedAt: Date.now(),
            resultSummary: toolResult.slice(0, 100),
            ok,
            idempotent,
          };
          // loop 先于 sessionManager 创建，回调可能早于其就绪——暂存队列待 flush 统一写入；
          // 就绪则直写，避免"先 push 缓冲又直写"双写污染及稳态下缓冲无限增长
          if (!this._sessionManager) {
            this._pendingToolExecutions.push(record);
          } else {
            this._sessionManager.logToolExecution(record);
          }
        },
        // 工具执行前检查（统一执行入口·单点聚合）：宿主审批优先（denied 短路返回），放行后再做内部幂等检查；
        // 未注入宿主回调时完全降级为仅内部幂等检查
        preExecutionCheck: (name, args): PreExecutionResult => {
          // 1. 宿主审批（审批/审计/参数改写/白名单/只读拦截）
          const hostResult = this.#config.preExecutionCheck?.(name, args);
          if (hostResult?.denied) return hostResult; // 拒绝：直接短路，阻止工具意图
          if (hostResult?.skip) return hostResult; // 跳过：宿主决定不执行
          // 2. 内部幂等检查（补偿机制·仅一次语义）：仅对幂等工具生效，非幂等工具不跳过
          const sm = this._sessionManager;
          if (!sm) return { skip: false, overrideArgs: hostResult?.overrideArgs };
          // 幂等契约委托 shouldSkipForIdempotency（SSOT）：non-idempotent 不跳过（失败可重试）；
          // 幂等工具仅上次执行成功（ok=true）时跳过
          const idempotent: IdempotencyLevel = BUILTIN_TOOL_IDEMPOTENCY[name] ?? 'non-idempotent';
          const idemResult = shouldSkipForIdempotency(
            sm.getCheckpoint()?.completedToolCalls,
            name,
            args,
            idempotent,
          );
          return {
            skip: idemResult.skip,
            previousResult: idemResult.previousResult,
            overrideArgs: hostResult?.overrideArgs,
          };
        },
        fileConsistencyCheck: this.#config.fileConsistencyCheck,
      },
    });

    this.history = result.history;
    this.loop = result.loop;
    this.toolExec = result.toolExec;
    this.skillManager = result.skillManager;
    this.rolePackManager_ = result.rolePackManager;
    this.memoryInspector = result.memoryInspector;
    this.dedupManager = result.dedupManager;
    this.memoryAdvisor = result.memoryAdvisor;
    this.workProjection = result.workProjection;
    this.sessionArchiver = result.sessionArchiver;
    this.textPolisher = result.textPolisher;
    this.roundSummaryGenerator = result.roundSummaryGenerator;
    // 绑定记忆写入回调：round-summary 沉淀后 emit('memoryAdded')
    this.roundSummaryGenerator?.setOnMemoryAdded((info) => {
      this.emit(AGENT_EVENTS.memoryAdded, info);
    });
    // 注入 VectorStore 到 MemoryInspector，启用混合搜索
    if (this.memoryInspector && this.#config.vectorStore) {
      this.memoryInspector.setVectorStore(this.#config.vectorStore);
    }
    // 创建会话管理器（复用 createSessionManager，随后冲洗暂存队列）
    this._sessionManager = this.createSessionManager();
    this._flushPendingToolExecutions();

    // 装配 loop 回调：接线 onPaused / onRoundBoundary
    this.loop.onPaused = () => {
      // loop 在边界真正挂起时触发，设置 pauseMeta（暂停原因/来源从 SessionStateMachine 读取）
      const pendingInfo = this._sessionManager?.pendingPauseInfo;
      this._sessionManager?.setPauseMeta({
        reason: pendingInfo?.reason ?? '用户主动暂停',
        source: pendingInfo?.source ?? 'user',
      });
    };
    // 主动提问（回答中检测到 LLM 结构化输出 [ASK]）：发射 questionPending 事件（宿主渲染提问 UI）+ 触发暂停。
    // 与 needClarify（P4 目标槽位补全）触发源不同，但共享 pause/resume 机制
    this.loop.onPendingQuestion = (questions) => {
      if (questions.length === 0) return;
      this.emit(AGENT_EVENTS.questionPending, questions);
      // 触发软暂停：handleTextResponse 返回 'paused' 后由 consumeExecutionStream 翻 PAUSED
      const reason = `需要澄清：${questions.map((q) => q.question).join('; ')}`;
      this.requestPause(reason, 'agent');
    };
    this.loop.onRoundBoundary = (roundInfo) => {
      // completeRound 写 roundLog 关联 plan 步骤（取 active 步骤 ID）。此前不传 stepId 使 roundLog 与 plan
      // 无法关联（不可追溯）；单向引用——plan 仍是任务状态真理源，roundLog 是其时间轴投影（避免双写）
      const activeStepId = this._sessionManager?.getCheckpoint()?.plan.find(
        (s) => s.status === 'active',
      )?.id;
      this._sessionManager?.completeRound({
        stepId: activeStepId,
        summary: roundInfo.summary,
      });

      // 兜底停滞检测：连续 3 轮无 task_table_update 且 plan 有未完任务 → 将 active step 标记为 blocked
      this._stalledRoundCount++;
      if (this._stalledRoundCount >= 3) {
        const sm = this._sessionManager;
        const cp = sm?.getCheckpoint();
        if (cp) {
          const activeStep = cp.plan.find((s) => s.status === 'active');
          const hasPending = cp.plan.some((s) => s.status === 'pending' || s.status === 'active');
          if (activeStep && hasPending) {
            // 经 updatePlanStepStatus 标脏，checkpointDirty 置位确保阻塞标记可落盘
            sm?.updatePlanStepStatus(activeStep.id, 'blocked');
            this.loop?.injectSystemMessage(
              `[系统] 检测到任务表停滞（连续 3 回合未更新步骤状态），已自动将步骤 "${activeStep.description}" 标记为 blocked。请使用 task_table_update 推进剩余任务，或使用 task_table_write 重新规划。`,
            );
          }
        }
        // 复位计数器（无论是否触发，防止无限触发）
        this._stalledRoundCount = 0;
      }
    };

    // 装配任务表注入回调：每次迭代 LLM 调用前统一注入
    this.loop.getTaskTable = () => {
      const cp = this._sessionManager?.getCheckpoint();
      if (!cp) return '';
      return renderTaskTable(cp.plan, cp.roundLog);
    };

    // 装配任务表工具回调（planManager）
    this.toolExec.planManager = {
      writePlan: (mode, steps) => {
        const sm = this._sessionManager;
        if (!sm) return '[ERR] 会话管理器未就绪';
        // 分发归位 SessionManager.writePlan（计划写入口 SSOT，可被单测直接覆盖）
        const newPlan = sm.writePlan(mode, steps);
        return `任务表已更新（${mode}），当前共 ${newPlan.length} 个步骤：\n${
          newPlan.map((s) => `  - [${s.id.slice(0, 8)}] ${s.description}`).join('\n')
        }`;
      },
      updateStep: (stepId, status) => {
        const sm = this._sessionManager;
        if (!sm) return '[ERR] 会话管理器未就绪';
        // 状态变更收口 SessionManager.updatePlanStepStatus（内部标脏 + 心跳，唯一写点）——
        // 旧实现直改 step.status 未置 checkpointDirty → 计划变更可能永不落盘
        if (!sm.updatePlanStepStatus(stepId, status)) {
          return `[ERR:STEP_NOT_FOUND] 未找到步骤 ${stepId}`;
        }
        const step = sm.getCheckpoint()?.plan.find((s) => s.id === stepId);
        // 兜底停滞计数器复位（LLM 调用了 task_table_update，说明未停滞）
        this._stalledRoundCount = 0;
        return `步骤 [${stepId.slice(0, 8)}] "${step!.description}" 已标记为 ${status}`;
      },
      getPlan: () => {
        const sm = this._sessionManager;
        const cp = sm?.getCheckpoint();
        return (cp?.plan ?? []).map((s) => ({ id: s.id, description: s.description, status: s.status, order: s.order }));
      },
    };
  }

  /**
   * 冲洗工具执行暂存队列（工具幂等 outbox）：将 assembler 期间暂存的执行记录写入会话管理器检查点，
   * 适用于首次组装和重建两种场景。
   */
  private _flushPendingToolExecutions(): void {
    if (this._pendingToolExecutions.length === 0) return;
    const sm = this._sessionManager;
    if (!sm) {
      logger.warn({ pending: this._pendingToolExecutions.length }, '冲洗工具执行队列失败：会话管理器未就绪');
      return;
    }
    for (const record of this._pendingToolExecutions) {
      sm.logToolExecution(record);
    }
    this._pendingToolExecutions = [];
    logger.debug('工具执行暂存队列冲洗完成');
  }

  /**
   * 创建会话管理器（assembleComponents 与 rebuildComponents 共享）：回调访问当前组件（rebuild 后拿最新引用），
   * forwardEvent 将 SessionManager 宽类型桥接到 Agent 强类型 emit，并校验事件名在 AgentEventMap 内避免不安全断言。
   */
  private createSessionManager(): SessionManager {
    const forwardEvent = (event: string, data: Record<string, unknown>) => {
      if (AGENT_EVENT_SET.has(event)) {
        this.emit(event as keyof AgentEventMap, data as AgentEventMap[keyof AgentEventMap]);
      }
    };
    return new SessionManager(
      // 惰性 getter：SessionManager 内部调用时 Agent 已 init，用 ! 窄化
      () => this.history!,
      () => this.loop!,
      this.#config.sessionStore,
      () => this.chatLockManager?.isBusy ?? false,
      forwardEvent,
    );
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
    if (this.roundSummaryGenerator) {
      this.roundSummaryGenerator.setBackgroundProvider(provider);
    }
    if (this.sessionArchiver) {
      this.sessionArchiver.setBackgroundProvider(provider);
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
    if (!this.rolePackManager_) return { locked: false, unlockAt: null };
    return this.rolePackManager_.getSwitchLockStatus();
  }

  /**
   * 获取当前激活角色包的 traits（宿主情感计算 API）
   *
   * @returns traits 键值对，无激活角色包或无 traits 时返回 undefined
   */
  getActiveTraits(): Record<string, number> | undefined {
    return this.rolePackManager_?.getActiveTraits();
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
    const rolePackPrompt = this.rolePackManager_?.buildSystemPrompt() ?? '';
    const globalSkillList = this.skillManager?.buildSkillList() ?? '';
    const newPrefix = buildSystemPromptPrefix(rolePackPrompt, globalSkillList);
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

    // act.outputLimit → ChatOptions.maxTokens
    const outputLimit = act?.outputLimit;
    if (typeof outputLimit === 'number' && outputLimit > 0) {
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
    const rpm = this.rolePackManager_;
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
   * 角色包自动匹配（粘性，角色包唯一入口）：在 chat() 回答前经 RolePackManager.autoMatch 粘性语义匹配——
   * 首次外部输入命中即锁定当前会话，后续仅互斥包命中才切换；命中后激活并刷新 system prompt 前缀（装 L1 persona）。
   * 关键词未命中时尝试 LLM 辅助语义匹配（低置信度兜底）。
   */
  private async tryAutoMatchRolePack(input: string): Promise<boolean> {
    const rpm = this.rolePackManager_;
    if (!rpm) return false;

    // 第一层：关键词高置信度匹配（含粘性锁定副作用）
    const matched = rpm.autoMatch(input);
    if (matched) {
      return this.switchRolePack(matched);
    }

    // 第二层：LLM 辅助语义匹配（低置信度兜底，需 backgroundProvider）
    const bgProvider = this.#backgroundProvider;
    if (bgProvider && rpm.activeName) {
      const llmMatched = await this.matchRolePackByLlm(input);
      if (llmMatched && llmMatched !== rpm.activeName) {
        return this.switchRolePack(llmMatched);
      }
    }

    return false;
  }

  /**
   * LLM 辅助角色包语义匹配
   * @returns 匹配到的角色包名，无匹配返回 null
   */
  private async matchRolePackByLlm(input: string): Promise<string | null> {
    const rpm = this.rolePackManager_;
    if (!rpm) return null;
    const bgProvider = this.#backgroundProvider;
    if (!bgProvider) return null;

    try {
      const metaList = rpm.listMeta();
      if (metaList.length === 0) return null;

      // 构建提示：让 LLM 选择最匹配的角色包
      const roleList = metaList.map((m) => `${m.name}：${m.description ?? m.displayName ?? ''}`).join('\n');
      const messages = [
        { role: 'system' as const, content: `根据用户输入，从以下角色中选择最合适的角色（只输出角色名，不要其他内容）：\n\n${roleList}` },
        { role: 'user' as const, content: input },
      ];

      // 流式获取 LLM 响应
      const stream = bgProvider.chat(messages, { maxTokens: 10, temperature: 0.1 });
      let response = '';
      for await (const chunk of stream) {
        if (chunk.content) response += chunk.content;
      }
      const matchedName = response.trim();
      if (matchedName && metaList.some((m) => m.name === matchedName)) {
        return matchedName;
      }
    } catch (err) {
      logger.warn({ err }, 'LLM 辅助角色包匹配失败');
    }
    return null;
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
    if (this.chatLockManager?.isBusy) {
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

    if (shouldReloadRolePack && this.rolePackManager_) {
      try {
        result.rolePack = await this.rolePackManager_.reload();
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
    await this.assembleComponents(this.pctx);
    // assembleComponents 创建新的 history/loop，需重建会话管理器（复用 createSessionManager）
    this._sessionManager = this.createSessionManager();
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
   * 断言对话未进行中（统一守卫）：6 处破坏状态一致性操作的相同 isBusy 检查已收敛于此。
   * reloadConfig 不使用本方法——它在 isBusy 时需暂存 source 而非直接抛错。
   */
  private assertNotBusy(operation: string): void {
    if (this.chatLockManager?.isBusy) {
      throw chatBusyError(operation);
    }
  }

  // 断言 getter：非空或抛明确错误，替代 this.loop!/history!/pctx! 非空断言
  private get requireLoop(): AgentLoop {
    if (!this.loop) throw configError('AgentLoop 未初始化', undefined, ['在调用此方法前执行 await agent.init()']);
    return this.loop;
  }

  private get requireHistory(): MessageHistory {
    if (!this.history) throw configError('MessageHistory 未初始化', undefined, ['在调用此方法前执行 await agent.init()']);
    return this.history;
  }

  private get requirePctx(): ProjectContext {
    if (!this.pctx) throw configError('ProjectContext 未初始化', undefined, ['在调用此方法前执行 await agent.init()']);
    return this.pctx;
  }

  private get requireArchiveCoordinator(): ArchiveCoordinator {
    if (!this.archiveCoordinator) throw configError('ArchiveCoordinator 未初始化', undefined, ['在调用此方法前执行 await agent.init()']);
    return this.archiveCoordinator;
  }

  private get requireSessionManager(): SessionManager {
    if (!this._sessionManager) throw configError('SessionManager 未初始化', undefined, ['在调用此方法前执行 await agent.init()']);
    return this._sessionManager;
  }

  /**
   * 获取角色包管理器（system prompt 的唯一注入源，返回 null 表示 Agent 未初始化）
   */
  get rolePackManager(): RolePackManager | null {
    return this.rolePackManager_;
  }

  /**
   * 获取当前激活的 L2 行为策略：从激活角色包读取，未激活时用全局默认值；供各阶段按策略调整行为
   */
  getActiveStrategy(): BehaviorStrategy {
    return this.rolePackManager_?.getActive()?.strategy ?? DEFAULT_BEHAVIOR_STRATEGY;
  }

  /**
   * 应用当前角色包的工具暴露面（换角色 → 工具集切换）：声明 capabilities 时解析为工具白名单，未声明放行全部。
   * 空数组（parseCapabilities 对 undefined 返回 []）同样视为"未声明能力"放行全部，避免误解释为"禁止所有"。
   * toolMode=block 全禁与此正交；变更经 setToolWhitelist → onToolsChanged 链路同步 loop 快照与 system prompt。
   */
  private applyRolePackToolExposure(): void {
    if (!this.toolExec) return;
    const active = this.rolePackManager_?.getActive();
    const capabilities = active?.capabilities;
    const whitelist =
      capabilities && capabilities.length > 0 ? resolveCapabilityTools(capabilities) : null;
    this.toolExec.setToolWhitelist(whitelist);
  }

  // ─── 记忆生命周期 ───────────────────────────────────────

  // ─── runMemoryDecay 已迁移至 MemoryDecayScheduler.runOnce ─────

  // ─── 关闭 ─────────────────────────────────────────────

  /**
   * 关闭 Agent，释放 SQLite 连接等资源
   */
  async close(): Promise<void> {
    // 清理 chat 锁管理器（递增 token 使进行中 chat() 的 finally 跳过清理，close 已接管）
    this.chatLockManager?.dispose();
    this.chatLockManager = null;
    // 先 stop() abort L2 LLM 调用再 awaitInflight()，防止 close 后 LLM 回调 upsert 已关闭的 storage
    if (this.memoryDecayScheduler) {
      this.memoryDecayScheduler.stop();
      try {
        await this.memoryDecayScheduler.awaitInflight();
      } catch (err) {
        logger.warn({ err: toError(err) }, 'close: memoryDecayScheduler.awaitInflight 失败');
      }
      this.memoryDecayScheduler = null;
    }
    // 等待 WorkProjection inflight 生成完成，防止 close 后 upsert 已关闭的 storage
    if (this.workProjection) {
      try {
        await this.workProjection.awaitInflight();
      } catch (err) {
        logger.warn({ err: toError(err) }, 'close: workProjection.awaitInflight 失败');
      }
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
    this.archiveCoordinator = null;
    // 清理 RolePackManager 切换防抖锁计时器，防止关闭后回调触发
    if (this.rolePackManager_) {
      this.rolePackManager_.close();
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
    this.rolePackManager_ = null;
    this.memoryInspector = null;
    this.dedupManager = null;
    this.memoryAdvisor = null;
    this._governance = null;
    this.workProjection = null;
    this.sessionArchiver = null;
    this.sessionNamer = null;
    this.textPolisher = null;
    this.roundSummaryGenerator = null;
    this._sessionManager = null;
    this.projectManager = null;
    this.pctx = null;
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
    return this.chatLockManager?.isBusy ?? false;
  }

  get lastInteractionAt(): Date | null {
    return this._lastInteractionAt;
  }

  /** 记忆治理统一门面（L0 衰减 / L1 去重 / L2 时效性 / L3 冲突 / 诊断 / 推荐），统一替代 Agent 上散落的 6 个方法 */
  get governance(): MemoryGovernance | null {
    return this._governance;
  }

  // ─── 运行时指标 ────────────────────────────────

  /**
   * 获取 Agent 运行时指标快照（可观测性）：聚合 AgentLoop 指标与 Agent 层衰减指标；
   * 未初始化返回全零默认值（不抛异常），纯只读同步零副作用，适合宿主定期轮询监控面板。
   */
  getMetrics(): AgentMetrics {
    // 衰减指标从 MemoryDecayScheduler 读取
    const decayMetrics = this.memoryDecayScheduler?.getMetrics() ?? {
      runCount: 0,
      totalDecayedCount: 0,
      lastRunAt: null,
    };
    // 未初始化时返回全零指标，避免调用方判空
    if (!this.loop) {
      return {
        llm: { callCount: 0, totalInputTokens: 0, totalOutputTokens: 0 },
        recall: { totalCount: 0, hitCount: 0, hitRate: 0 },
        tools: { callCount: 0, failureCount: 0 },
        context: { truncationCount: 0, messageCount: 0, estimatedTokens: 0 },
        decay: decayMetrics,
      };
    }

    const loopMetrics = this.loop.getMetrics();
    return {
      ...loopMetrics,
      decay: decayMetrics,
    };
  }

  // ─── Manager 暴露（调用方直接操作 Manager）──
  // 设计策略：访问器（getter）返回 Manager | null 供链式调用和优雅降级（如 `if (!agent.memory) return []`）；
  // 门面方法经 assertInitialized 抛明确错误；宿主用访问器需自行判空，或用门面方法获得自动错误处理。

  /** 角色包管理器（角色+技能+规则的唯一真理源，system prompt 的唯一注入源） */
  get rolePack(): RolePackManager | null {
    return this.rolePackManager_;
  }

  /** 工具执行器（返回 null 表示 Agent 未初始化） */
  get tools(): ToolExecutor | null {
    return this.toolExec;
  }

  /** 技能管理器（返回 null 表示未初始化或技能系统未加载） */
  get skills(): SkillManager | null {
    return this.skillManager;
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

  /** 作品投影管理器（文件内容 → 概要+结构+决策；`ensureProjection`/`loadAll`） */
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
