/**
 * Agent 门面类 — Memora 宿主项目接入入口
 *
 * 设计文档（ADR-010 · Agent 门面类）要求宿主项目通过 `import { Agent } from '@zooique/memora'`
 * 一行代码接入。本类负责组件组装和核心对话编排，
 * 领域专属操作委托给专职 Manager（PersonaManager / ToolExecutor / SkillManager / ConfigManager / MemoryInspector）。
 *
 * 使用方式（最简）：
 *   const agent = new Agent({ projectPath: './my-project', configDir: './agent-config' });
 *   await agent.init();
 *   for await (const chunk of agent.chat('你好')) {
 *     if (chunk.type === 'text') process.stdout.write(chunk.content);
 *   }
 *   await agent.close();
 *
 * 使用方式（高级）：
 *   const agent = new Agent({ projectPath: './my-project', provider: myProvider, configDir: './agent-config' });
 *
 * 2026-06-12 God Object 拆分：
 *   - 配置管理 → ConfigManager
 *   - 记忆查看 → MemoryInspector
 *   - 薄包装方法移除，调用方改为 agent.<manager>.xxx()
 */
import { getBaseName } from '@/utils/path.js';
import { AGENT_CONSTANTS } from '@/agent/constants.js';
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
import type { AutoConfigRefiner } from '@/agent/managers/autoConfigRefiner.js';
import { recall, boostScores } from '@/memory/recall.js';
import type { PersonaManager } from '@/persona/personaManager.js';
import type { SkillManager } from '@/skill/skillManager.js';
import type { RolePackManager } from '@/role-pack/rolePackManager.js';
import {
  DEFAULT_BEHAVIOR_STRATEGY,
  resolveRecentRounds,
  resolveHandoff,
  resolveMemoryRecallMode,
  resolveMinFallback,
  resolveSummaryFocus,
  resolveToolMode,
} from '@/role-pack/types.js';
import type { BehaviorStrategy, MemoryRecallMode } from '@/role-pack/types.js';
import { resolveCapabilityTools } from '@/role-pack/capabilityMap.js';
import type { SessionArchiver, SessionArchiveResult } from '@/agent/managers/sessionArchiver.js';
import { SessionNamer } from '@/agent/managers/sessionNamer.js';
import type { TextPolishManager } from '@/agent/managers/textPolishManager.js';
import type { RoundSummaryGenerator } from '@/agent/managers/roundSummaryGenerator.js';
import type { ConfigManager } from '@/agent/managers/configManager.js';
import type { WorkProjectionManager } from '@/agent/managers/workProjection.js';
import type { MemoryInspector } from '@/agent/managers/memoryInspector.js';
import type { DedupManager } from '@/agent/managers/dedupManager.js';
import type { MemoryAdvisor } from '@/agent/managers/memoryAdvisor.js';
import { assembleComponents } from '@/agent/assembler.js';
import { matchPersonaByLlm } from '@/agent/personaMatcher.js';
import { chatBusyError, configError, isAbortError, toError } from '@/utils/errors.js';
import { SessionManager, type AgentForkResult } from '@/agent/managers/sessionManager.js';
import { renderTaskTable } from '@/agent/taskTableRenderer.js';
import { ChatLockManager } from '@/agent/managers/chatLockManager.js';
import { MemoryDecayScheduler } from '@/agent/managers/memoryDecayScheduler.js';
import { MemoryGovernance } from '@/agent/managers/memoryGovernance.js';
import { ArchiveCoordinator, type ArchiveTriggerOptions } from '@/agent/managers/archiveCoordinator.js';
import { TypedEventEmitter, type AgentEventMap, AGENT_EVENTS, AGENT_EVENT_SET } from '@/utils/eventEmitter.js';
import type { LlmProvider, Message } from '@/llm/provider.js';
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
 * **设计哲学**：单 Agent，单配置，单记忆。每个 Agent 实例拥有独立的
 * 对话管线（AgentLoop）、独立的消息历史（MessageHistory）和独立的
 * 运行时状态（chatBusy）。activeSkill 已移除——技能匹配改为当轮实时注入，无需跨轮状态缓存。
 *
 * **多实例**：宿主可通过 new Agent({ dataDir: './agent2' }) 创建
 * 独立实例。只要 dataDir 不同，它们拥有完全隔离的记忆库和会话。
 * 内核不负责多 Agent 编排——那是宿主层的职责。
 *
 * **fork vs 多实例**：
 * - forkSession() 分叉对话历史，但记忆索引全局共享
 * - new Agent() + 独立 dataDir 实现完全隔离的记忆空间
 *
 * @example
 * ```ts
 * const agent = new Agent({
 *   projectPath: '/path/to/project',
 *   provider: new OpenAIProvider({ apiKey: '...' }),
 *   configDir: '/path/to/config',
 *   dataDir: '/path/to/data',
 *   permission: 'owner',
 *   allowedPaths: ['/path/to/project'],
 * });
 * await agent.init();
 * const iter = agent.chat('你好');
 * for await (const chunk of iter) { ... }
 * ```
 */
export class Agent extends TypedEventEmitter<AgentEventMap> {
  // 构造参数分组
  #config: AgentConfig;
  /** 前台 Provider（独立字段，因 setProvider() 可变） */
  #provider: LlmProvider;
  /** 后台 Provider（独立字段，因 setBackgroundProvider() 可变） */
  #backgroundProvider: LlmProvider | null;
  /** Provider 路由选择器（P1-2 多模型路由基础，可选） */
  #providerRouter: ProviderRouter | null = null;

  // 运行时组件（init 后填充）
  private projectManager: ProjectManager | null = null;
  private history: MessageHistory | null = null;
  private loop: AgentLoop | null = null;
  private toolExec: ToolExecutor | null = null;

  // 新模块
  private personaManager: PersonaManager | null = null;
  private skillManager: SkillManager | null = null;
  /** 角色包管理器（M1 清单抽象，为插卡式预留生长点） */
  private rolePackManager_: RolePackManager | null = null;

  // 拆分出的专职 Manager
  private configManager: ConfigManager | null = null;
  private memoryInspector: MemoryInspector | null = null;
  /**
   * 语义去重管理器（L1 LLM 记忆治理）
   *
   * SPLIT-3 闭环（2026-07-21）：从 MemoryInspector 拆分出 deduplicateMemories 职责，
   * 让 MemoryInspector 回归纯存储读写。Agent.deduplicateMemories() 委托本对象。
   */
  private dedupManager: DedupManager | null = null;
  /**
   * 记忆顾问（L3 冲突检测 / sourceHealth / suggest）
   *
   * v2 PROXY-1 闭环：Agent.detectConflicts 直接调用 advisor，
   * 不再经 MemoryInspector 转发，消除 3 层无意义代理。
   * sourceHealth/suggest 仍由 inspector 转发以保持 agent.memory 统一入口语义。
   */
  private memoryAdvisor: MemoryAdvisor | null = null;
  /** 记忆治理统一门面（L0/L1/L2/L3 + 诊断） */
  private _governance: MemoryGovernance | null = null;
  private workProjection: WorkProjectionManager | null = null;
  /** AutoConfigRefiner（模式 3：Agent 智能总结） */
  private autoConfigRefiner: AutoConfigRefiner | null = null;
  /** SessionArchiver（会话内容归档器，content 类记忆） */
  private sessionArchiver: SessionArchiver | null = null;
  /** 会话命名器（ADR-024：新建会话首次问答自动命名标题） */
  private sessionNamer: SessionNamer | null = null;
  /** TextPolishManager（文本润色管理器，LLM 语法修正 + 表达优化） */
  private textPolisher: TextPolishManager | null = null;
  /** RoundSummaryGenerator（轮次摘要生成器，记忆即摘要架构 Phase 1） */
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

  /**
   * chat() 并发锁管理器（init 时创建，close 时销毁）
   *
   * 职责：chat() 并发锁 + token 校验（race condition 防护）+ 超时保护 + 外部 signal 合并。
   * 详见 ChatLockManager 类注释。
   */
  private chatLockManager: ChatLockManager | null = null;
  /** 最近一次 chat() 调用的时间戳 */
  private _lastInteractionAt: Date | null = null;
  /**
   * 最近一次角色包粘性匹配所属的会话 ID
   *
   * 会话切换时检测到变化 → 复位角色包粘性（粘性不跨会话，agent-design-philosophy §6.2）。
   * 由 prepareChatContext 每轮比对并驱动 resetSticky()。
   */
  private lastStickySessionId: string | null = null;
  /**
   * 对话进行中暂存的配置重载请求集合（chatLock 释放后补执行）
   *
   * 场景：用户在对话中通过 create_persona / create_skill 工具创建配置，
   * reloadConfig 因 chatLock 冲突失败时，将 source 暂存于此。
   * chat() 的 finally 块释放锁后遍历此集合逐个补执行 reloadConfig，
   * 兑现"对话结束后自动加载"的承诺（见 tools.ts createConfigHandler 提示文案）。
   *
   * 用 Set 而非数组：同一 source 多次请求只需补执行一次（去重）。
   */
  private pendingConfigReload = new Set<string>();
  /**
   * 工具执行暂存队列（P3.3 工具幂等 outbox 模式）
   *
   * 因 assembler 中 loop 先于 sessionManager 创建，
   * 工具执行完成回调无法立即写入 sessionManager。
   * 暂存于此，待 assembleComponents 完成后的 flush 阶段统一写入。
   */
  private _pendingToolExecutions: ToolExecutionRecord[] = [];

  // ─── 衰减职责已拆分至 MemoryDecayScheduler ──────────
  // metricDecayRunCount / metricTotalDecayedCount / metricLastDecayAt 字段
  // 位于 MemoryDecayScheduler 内部，Agent 通过 memoryDecayScheduler.getMetrics() 读取
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
      personaName: opts.persona,
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
      // 宿主审批/审计/参数改写通道（§7.2.1）：透传进内部配置，
      // 供装配阶段与内部幂等检查组合为单一执行前检查点
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

    // 标记初始化完成，后续 restoreFromCheckpoint 需要此标志
    this._initialized = true;

    // P0-3：暂停超时自动归档——注册唯一消费点
    // 必须先于 loadPersistedCheckpoint()，否则启动路径的超时事件无人接收
    this.registerPauseTimeoutArchiver();

    // 加载持久化的会话检查点（P0-2：会话状态持久化）
    // 若上次会话在暂停/异常状态中关闭，加载后恢复状态机
    // 若检查点状态为 paused，同时恢复热记忆（重启后上下文恢复），见 P0-4
    const persistedCheckpoint = this._sessionManager?.loadPersistedCheckpoint();
    if (persistedCheckpoint && persistedCheckpoint.status === 'paused') {
      // P0-4：恢复热记忆到 loop + 温记忆召回 + 契约重注入
      // 确保重启后暂停会话的上下文完整，resumeExecution() 时 LLM 有历史上下文
      await this.restoreFromCheckpoint(persistedCheckpoint);
    }

    return pctx;
  }

  /**
   * 注册暂停超时归档处理器（P0-3：超时会话内容的唯一消费点）
   *
   * SessionManager 的两条超时路径——启动加载（loadPersistedCheckpoint）与
   * 运行时定时器（checkPauseTimeout）——都经 markSessionTimedOut() 发射
   * sessionPauseTimedOut 事件（含 date/session 载荷）。此处统一消费。
   *
   * F1.3 广播式改造：从事件载荷 payload.date / payload.session 直接读取，
   * 从事件载荷直接读取，支持多监听器并行消费。
   *
   * 注册位置在 init() 内而非构造器：close() 会 removeAllListeners()，
   * 而 init() 起始必先 disposePreviousInstance()，故实例周期内恰好一个监听器。
   * 监听器挂在 Agent（生命周期稳定）而非 SessionManager 上，
   * rebuildComponents() 重建管理器后仍然有效。
   */
  private registerPauseTimeoutArchiver(): void {
    this.on(AGENT_EVENTS.sessionPauseTimedOut, (payload) => {
      // P2-2: 暂停超时后清理 Agent 残留的 pending 暂停状态。
      // checkPauseTimeout() 已清除 SessionManager 的检查点并复位状态机，
      // 但 SessionStateMachine 的 pendingPauseReason 可能仍残留
      // （如 requestPause 后 loop 尚未到达边界，超时先行触发）。
      // 若不清理，下次 requestPause() 会被幂等检查静默忽略。
      this._sessionManager?.cancelPendingPause();

      // F1.3：从事件载荷直接读取 date/session
      const { sessionId, date, session } = payload;
      if (!date || !session) return;
      // fire-and-forget：归档失败不阻塞主流程，仅记录
      this.archiveCoordinator
        ?.archiveSessionContent(date, session, { autoTriggered: true })
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

    // 会话命名器（ADR-024 会话标题层）：新建会话首次问答自动命名标题
    // 惰性获取当前 provider（setProvider 切换后命名仍命中最新模型）
    this.sessionNamer = new SessionNamer({
      getProvider: () => this.#provider,
      sessionStore: this.#config.sessionStore,
    });

    // 记忆衰减职责委托给 MemoryDecayScheduler
    this.memoryDecayScheduler = new MemoryDecayScheduler({
      tracer: this.#config.tracer,
      onDecayCompleted: (payload) => {
        this.emit(AGENT_EVENTS.decayCompleted, payload);
        // MIND2-D4：从 agent.evaluateTimeliness() 迁移到 governance.evaluateTimeliness()
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

    // 会话切换时复位角色包粘性（粘性不跨会话，agent-design-philosophy §6.2）
    const sessionId = this._sessionManager?.getCheckpoint()?.sessionId ?? '';
    if (sessionId !== this.lastStickySessionId) {
      this.rolePackManager_?.resetSticky();
      this.lastStickySessionId = sessionId;
    }

    // 角色包优先匹配（粘性），persona 兜底（角色包优先/persona 兜底策略）
    if (!this.tryAutoMatchRolePack(input)) {
      await this.tryAutoMatchPersona(input);
    }

    // 基元驱动召回（双通道：语义 + 关键词），受 L2 策略控制
    const strategy = this.getActiveStrategy();
    // 枚举键经集中解析（SSOT 兜底）：非法值归位内核默认，不透传
    const memoryRecallMode = resolveMemoryRecallMode(strategy);

    // 根据 L2 策略设置工具调用权限（影响整轮对话），标准键 act.toolMode（§六）
    loop.setToolCallsBlocked(resolveToolMode(strategy) === 'block');

    // 根据 L2 策略设置自审查轮次（LLM 纯文本回复后自动审查 N 轮），标准键 reflect.loopContinue（§六）
    // Phase 9：loopContinue 为 number（0=关闭，N=最多 N 轮）；兼容旧格式 'on'→1 轮 / 'off'→0 轮
    const loopContinue = strategy.reflect?.loopContinue;
    const maxSelfReviewRounds =
      typeof loopContinue === 'number'
        ? loopContinue
        : loopContinue === 'on'
          ? 1
          : 0;
    loop.setMaxSelfReviewRounds(maxSelfReviewRounds);

    // M2.1 换角色 → 工具集切换：按激活角色包的 capabilities 应用工具暴露面
    // （toolMode=block 全禁与此正交；未声明 capabilities 时保持全部暴露）
    this.applyRolePackToolExposure();

    yield { type: 'thinking', phase: 'recalling' };
    const recalledMemories = await this.recallAndInject(input, memoryRecallMode);

    if (combinedSignal.aborted) return recalledMemories;

    // 技能关键词/正则匹配（当轮立即注入生效）
    yield { type: 'thinking', phase: 'processing' };
    this.matchAndInjectSkill(input);

    // 生成当前轮次 ID（在 processUserInput 之前，供 appendUser 溯源使用）
    const roundId = `round-${Date.now()}`;
    loop.setCurrentRoundId(roundId);

    const history = this.requireHistory;
    await history.appendUser(input, roundId);

    // 会话标题自动命名（fire-and-forget，ADR-024）：
    // 仅新建会话首次问答触发（SessionNamer 内部以"会话无标题"判定，不覆盖手动改名）
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

    // 流消费收口于 consumeExecutionStream（与 processEvent / resumeExecution 共用同一实现，
    // 杜绝 chat 主路径再持一份逐行同构的流消费逻辑——此前该副本漏了 paused 分支与
    // finally 锁清理，导致 chat 暂停时状态机不翻 PAUSED、幂等锁泄漏）。
    const streamResult = yield* this.consumeExecutionStream(
      // 传入当前轮次 ID（prepareChatContext 已分配 R1 并写入 user 消息），
      // 保证 user/assistant/摘要同 roundId，traceSummary 溯源完整（排雷雷-1）
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

    // 追加助手消息到历史（best-effort）
    try {
      await history.appendAssistant(assistantContent, loop.getCurrentRoundId());
    } catch (err) {
      logger.warn({ err }, '助手消息历史写入失败');
    }

    // 后处理阶段
    yield { type: 'thinking', phase: 'archiving' };
    // 非阻塞后处理：即使 LLM 摘要生成慢（如网络抖动），generator 不阻塞，立即继续
    // yield handoff + done，让 UI 能正常结束生成态。后处理结果在后台异步完成。
    this.postProcess(input, assistantContent).catch((err) => {
      logger.warn({ err }, '非阻塞后处理失败');
    });

    // Handoff 衔接决策：基于 L2 策略的 handoff 配置（标准键 reflect.handoff，§六），
    // 经 resolveHandoff 归位非法值，避免透传无法识别的衔接决策给宿主
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
   * 场景：宿主主进程"无进展超时"兜底后，generator 可能仍卡在不可中断的 await 点
   *   （executeToolCalls 和 generateContextSummary 已覆盖 signal 响应，但其他
   *   第三方库或未来新增的 await 点仍可能不响应 signal）。
   *   此时 _chatBusy 锁未释放，用户再发消息会被 chat() 的竞态保护拒绝，
   *   表现为"UI 能操作但发不出消息"，需等到 3 分钟锁超时才能恢复。
   *
   * 本方法让宿主在确认 generator 挂起后强制释放锁，让用户能立即发起新对话。
   *
   * 安全机制（委托至 ChatLockManager.forceRelease）：
   *   - 递增 _chatLockToken，让原 chat() 的 finally 块检测到 token 不匹配后
   *     跳过资源清理（避免误清新调用者的 _chatBusy/chatAbortController）
   *   - abort chatAbortController，让响应 signal 的 await 点（如 fetch）退出
   *   - 原 generator 仍可能在后台运行（无法真正中断不响应 signal 的 await），
   *     但其 finally 块的 token 校验会阻止它影响新调用
   *
   * 幂等性：_chatBusy 已 false 时 no-op（多次调用安全）
   *
   * 使用约束：
   *   - 仅在宿主确认 generator 挂起（如无进展超时）后调用
   *   - 不应在常规 abort 路径调用（常规 abort 走 signal，generator 自然退出）
   *   - 调用后不应再消费原 chat() generator 的后续 chunk（token 已变，chunk 无意义）
   */
  forceReleaseChatLock(): void {
    this.chatLockManager?.forceRelease();
  }

  /**
   * 召回记忆 + 注入最近对话上下文
   *
   * 从 chat() 中提取，职责：
   *   1. 双通道召回（语义 + 关键词），受 L2 策略 memoryRecall 模式控制
   *   2. Layer 5: 最近对话注入
   *
   * 策略控制：
   *   - 'full'：全量召回（当前默认行为）
   *   - 'limited'：限额召回（使用 strategy.memoryRecallQuota 限制）
   *   - 'none'：跳过召回，仅注入最近对话
   *
   * @param input 用户输入
   * @param memoryRecallMode L2 策略指定的记忆召回模式
   * @returns 召回的记忆列表
   */
  private async recallAndInject(input: string, memoryRecallMode: MemoryRecallMode): Promise<Memory[]> {
    // 策略控制：'none' 模式跳过实际召回，仅注入最近对话
    let recalledMemories: Memory[] = [];

    // 上下文固定加载轮数 N（SSOT 单一来源）：角色包 recentRounds 为合法"0 以上正整数"时
    // 一律采用角色包定义，缺失/非法才降级内核默认。互斥窗口与最近对话注入共用同一 N，
    // 保证"正文加载 N 轮 ⟺ 互斥排除 N 轮"严格一致（memory-as-summary §4.3）。
    const recentRounds = resolveRecentRounds(this.getActiveStrategy());

    // 互斥 roundId 集合（memory-as-summary §4.3）：当前会话最近 N 轮正文已完整加载进上下文，
    // 其 round-summary 不应再被召回注入。前置传入 recall() 在 hybridMerge 取 limit 前过滤，
    // 避免被排除摘要挤占 top-limit 预算（跨会话记忆补位）。
    // 与最近对话注入共用同一 N（resolveRecentRounds），保证"正文加载 N 轮 ⟺ 互斥排除 N 轮"。
    const recentRoundIds = new Set(this.requireHistory.getRecentRoundIds(recentRounds));

    if (memoryRecallMode !== 'none') {
      // 实际 recall() 函数耗时 span（区别于 loop.ts 的 RECALL 注入 span）
      const tracer = this.#config.tracer ?? NOOP_TRACER;
      const recallSpan = tracer.startSpan(TRACE_SPANS.RECALL_ACTUAL, {
        queryLength: input.length,
        hasVectorStore: !!this.#config.vectorStore,
        memoryRecallMode,
      });

      try {
        recalledMemories = await recall(
          this.requirePctx.index,
          input,
          {
            limit: memoryRecallMode === 'limited'
              ? (this.getActiveStrategy().prepare?.memoryRecallQuota ?? AGENT_CONSTANTS.DEFAULT_RECALL_LIMIT)
              : AGENT_CONSTANTS.DEFAULT_RECALL_LIMIT,
            vectorStore: this.#config.vectorStore,
            excludeSources: this.#config.recallExcludeSources,
            // 会话窗口标识：与 round-summary 写入侧 metadata.sessionName 同源同值
            // （currentSessionName = `${date}-${session}`），保证"同窗口优先"命中当前会话
            sessionId: this.requireHistory.currentSessionName,
            // 召回保底下限：角色包 prepare.minFallback 控制，非法/缺失回退默认 2
            minFallback: resolveMinFallback(this.getActiveStrategy()),
            // 前置互斥排除（§4.3）：在 recall 内取 limit 前过滤当前会话最近 N 轮 round-summary
            excludeRoundIds: recentRoundIds,
          },
        );
      } catch (err) {
        recallSpan.recordException(err instanceof Error ? err : new Error(String(err)));
        throw err;
      } finally {
        recallSpan.setAttribute('resultCount', recalledMemories.length);
        recallSpan.end();
      }
      if (recalledMemories.length > 0) {
        this.emit(AGENT_EVENTS.memoryRecalled, { count: recalledMemories.length, query: input });
        // boost 持久化拆分为 fire-and-forget，不阻塞 chat 读路径
        // boost 是软指标（每次 +0.05，上限 1.0），写入失败仅 log 不影响 chat 流程
        const ids = recalledMemories.map((m) => m.id);
        void boostScores(this.requirePctx.index, ids).catch((err: unknown) => {
          logger.warn({ err }, 'boost 持久化失败（不影响 chat 流程）');
          this.emit(AGENT_EVENTS.boostPersistFailed, { memoryId: ids.join(','), message: toError(err).message });
        });
      }
    }

    // Layer 5: 最近对话注入
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

    // ── Phase 2：跨窗口召回的摘要按 createdAt 升序排列 ──
    // 帮助 LLM 自然识别"最近偏好"——时间线越早的记忆排在前面
    recalledMemories = [...recalledMemories].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );

    return recalledMemories;
  }

  /**
   * 匹配技能并立即注入本轮对话（当轮生效，不延迟到下一轮）
   *
   * 与 persona 的 tryAutoMatchPersona 同模式：匹配 → 注入 → 本轮 LLM 即生效。
   * 原设计为 injectActiveSkill（注入上一轮匹配结果），导致用户说"写代码"的第一轮
   * 得不到技能增强，需再发一条消息才生效。已改为实时匹配注入。
   *
   * 匹配策略：regex trigger 优先（score=1.0），其次关键词匹配（阈值 0.3）。
   * 清理机制：cleanTemporarySystemMessages() 每轮开头清除临时 system 消息，
   * 技能 prompt 自然不会累积到下一轮。
   *
   * @param input 用户输入文本
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
   * 对话后处理：round-summary 生成、角色匹配、技能匹配、AutoConfigRefiner
   *
   * 所有归档/匹配操作均为 best-effort：任何子步骤失败不应影响用户已收到的回答，
   * 失败仅记录日志，不向上抛出异常。
   *
   * ADR-015 归档模式控制（2026-08-14 收敛为二态）：
   * - 角色匹配 + 技能匹配不受 archiveMode 影响（每轮都执行，非归档行为）
   * - 洞察自动抽取已移除（2026-08-14），记忆收敛为 round-summary 单轨
   * - `full` 模式：会话切换前自动归档会话内容（content）
   * - `manual` 模式：跳过会话内容自动归档，需用户手动调用 archiveSessionContent()
   */
  private async postProcess(input: string, assistantContent: string): Promise<void> {
    // postProcess 全流程 span（角色匹配 + 技能匹配 + 归档 + AutoConfigRefiner）
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
   * postProcess 内部实现（为 span 埋点提供 try/finally 包裹边界）
   *
   * 原 postProcess 逻辑完整保留于此，由外层 postProcess 负责 span 生命周期管理。
   */
  private async doPostProcess(input: string, assistantContent: string): Promise<void> {
    // 技能匹配已迁移到 chat() 开头的 matchAndInjectSkill()（当轮实时生效），
    // 与 persona 的 tryAutoMatchPersona 同模式，消除"第一轮无技能"的一轮延迟问题。

    // ADR-015 + FIX-P1-4: archiveMode 二态控制集中到 ArchiveCoordinator
    // 此处统一传 { autoTriggered: true }，由 ArchiveCoordinator 内部按 archiveMode 判断是否跳过：
    //   - manual 模式 → 跳过 content 自动归档（用户需手动调用）
    //   - full 模式 → 执行
    // 角色匹配/技能匹配/AutoConfigRefiner 属"配置学习"行为，非归档，每轮都执行。
    const history = this.requireHistory;

    // 用户画像已收敛为 round-summary 召回（2026-08-14），不再有独立画像归档路径。
    // 洞察自动抽取已移除（2026-08-14）：其能力被 round-summary 吸收，记忆收敛为单轨。

    // AutoConfigRefiner（模式 3：Agent 智能总结）
    if (this.autoConfigRefiner) {
      try {
        // 注册到 pendingArchives，确保 close() 时等待后台分析完成，避免写入已关闭的存储
        const analyzePromise = this.autoConfigRefiner.analyze(input, assistantContent).catch((err) => {
          logger.warn({ err }, 'AutoConfigRefiner 分析失败');
        });
        history.registerPendingArchive(analyzePromise);
      } catch (err) {
        logger.warn({ err }, 'AutoConfigRefiner 初始化失败');
      }
    }

    // 轮次摘要生成（记忆即摘要架构 Phase 1）
    if (this.roundSummaryGenerator) {
      try {
        const roundId = this.requireLoop.getCurrentRoundId();
        const sessionName = history.currentSessionName;
        // 提炼视角（结构化保真 + 提炼侧视角下沉）：激活角色包 prepare.summaryFocus → 注入摘要生成。
        // 领域无关机制，编程等结构化角色包声明后以该视角替换通用归纳框架，引导浓缩摘要保留领域结构。
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
   * 替代 `chat()` 的结构化输入接口。接收 SessionEvent（含意图分类 + 内容 + delta），
   * 按意图路由到不同处理路径。与 `chat()` 共享同一并发锁，互斥调用。
   *
   * 使用方式：
   *   const event = { type: 'chat', content: '帮我写一个排序函数', delta: { task: '写排序函数' } };
   *   for await (const chunk of agent.processEvent(event)) { ... }
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

    // P2-1: 双通道模型——使用统一 autoResumeIfPaused 方法处理 ERROR 态拒绝 + PAUSED 态自动恢复。
    // PAUSED 态收到用户事件（chat/correction/clarify）= 自动恢复工作通道 + 作为补充注入继续；
    // 仅 command 事件（显式暂停/恢复命令）不触发自动恢复，保持状态机语义。
    // ERROR 态仍拒绝（须先 recover，防止状态不一致）。
    // auto-resume 必须在锁内执行：状态机翻转是副作用，须先通过并发闸门。
    // 旧顺序：autoResumeIfPaused 先于 acquireChatLock → 锁忙时状态机已翻 RUNNING
    // 才抛 chatBusyError → PAUSED 态被静默吞掉（会话以为自己在跑，实际未获执行权）。
    // 抛错路径由 finally 统一释放锁与外部 signal（与正常路径同构，无泄漏）。
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
        // 收集计划上下文（P3.3 执行计划管理）
        const sm = this._sessionManager!;
        const planCtx: PlanContext | undefined = checkpoint.plan.length > 0
          ? {
              stalled: sm.isPlanStalled(),
              activeStep: sm.getActiveStep()?.description,
              pendingStep: sm.getNextPendingStep()?.description,
            }
          : undefined;

        const composeResult = this.composer.compose(event, checkpoint, planCtx);

        // 先应用已确定槽位（P1→P3），再处理 P4 澄清——解析成果不随暂停丢失。
        // applyResolvedDelta 对 P4_CLARIFY 槽位有守卫（等待用户回答，仅应用已确定槽位）；
        // 且 needClarify 非空 ⟺ task 槽为 P4（唯一无默认值的槽位），被守卫跳过
        // ⇒ 不会触发 updateGoal 的 drift 级自动暂停，外层澄清 pause 语义不受干扰。
        // 若放在下方 needClarify 分支 return 之后（历史位置），本轮增量
        // （如 correction 的 delta.role）随暂停丢弃，用户回答后只能依赖 LLM
        // 重新解析回答文本碰运气恢复——解析成果丢弃（P1）。
        this.applyResolvedDelta(composeResult.resolved);

        // 若有 P4 澄清问题，暂停并等待用户回答
        if (composeResult.needClarify && composeResult.needClarify.length > 0) {
          // P4 防滥用检查：连续高风险暂停已达上限时，过滤高风险问题，使用 P3 兜底
          // 低风险问题（lowRisk=true）仍可继续请求用户确认，不计入连续暂停计数
          const sm = this._sessionManager;
          if (sm && sm.isPauseLimitReached()) {
            const highRiskQuestions = composeResult.needClarify.filter((q) => !q.lowRisk);
            if (highRiskQuestions.length > 0) {
              logger.warn(
                { consecutivePauseCount: sm.getConsecutivePauseCount(), filteredCount: highRiskQuestions.length },
                '连续高风险暂停已达上限，强制降级 P3 兜底',
              );
              // 过滤高风险问题，仅保留低风险问题继续请求用户确认
              composeResult.needClarify = composeResult.needClarify.filter((q) => q.lowRisk);
            }
          }

          // 过滤后仍有剩余问题（低风险）→ 正常暂停流程
          if (composeResult.needClarify.length > 0) {
            for (const q of composeResult.needClarify) {
              yield { type: 'text', content: `[需澄清] ${q.question}` };
            }
            // 发射 needClarify 事件，宿主通过 IPC 转发到渲染进程展示澄清面板
            this.emit(AGENT_EVENTS.needClarify, composeResult.needClarify.map((q) => ({
              slot: q.slot,
              question: q.question,
              options: q.options,
            })));
            // 兑现 :873 的注释契约：剩余问题全为低风险时不计入连续暂停计数。
            // 用 every 而非 some——只要存在一个高风险问题，本次暂停就确实在为高风险
            // 决策索取用户确认，理应消耗配额；some 会让混合场景免费逃逸计数，反向打开滥用面。
            const allLowRisk = composeResult.needClarify.every((q) => q.lowRisk);
            this.pause(
              `需要澄清：${composeResult.needClarify.map((q) => q.question).join('; ')}`,
              'agent',
              allLowRisk,
            );
            yield { type: 'done' };
            return;
          }
          // 所有高风险问题已被过滤降级，无剩余问题 → 继续执行（不暂停）
        }
      }

      // P1: 意图分类防污染——非 chat 事件不写 chat 历史
      // command/correction 属控制/元信息，不参与对话流：
      //   - command: 控制信号（暂停/恢复/重置），写入历史会污染对话
      //   - correction: 目标修正，写入历史会让 LLM 误以为这是普通对话
      // clarify 例外：回答已通过 compose 应用到检查点（applyResolvedDelta），
      // 入口已 auto-resume（双通道 v2.0），转 chat 语义继续执行——回答内容作为
      // 用户输入进入对话流，驱动 LLM 完成原任务（否则提交回答后无响应）。
      // Phase 2：用户回答澄清问题后重置连续暂停计数，恢复防滥用机制（P4 防滥用死代码修复）
      if (event.type === 'clarify') {
        // 用户回答了澄清问题，表明已配合完成澄清流程，重置连续暂停计数
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

      // P2.5-1: 预判是否提示 LLM 生成任务表（仅 plan 为空时触发）
      if (this.shouldGenerateTaskTable(event, this._sessionManager?.getCheckpoint() ?? undefined)) {
        loop.injectSystemMessage(
          '如果需要分步完成任务，请使用 task_table_write 工具创建任务表，' +
          '包含各步骤的描述（description）。每完成一步使用 task_table_update 工具更新对应步骤状态。' +
          '任务表仅作参考，LLM 可自行决定执行顺序。',
        );
      }

      // 委托给 AgentLoop 的 processEvent（流消费收口于 consumeExecutionStream）
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

      // 追加助手消息到历史
      try {
        await this.requireHistory.appendAssistant(assistantContent, loop.getCurrentRoundId());
      } catch (err) {
        logger.warn({ err }, '助手消息历史写入失败');
      }

      // 后处理（非阻塞：不阻塞 generator 发送 handoff/done，UI 能正常结束生成态）
      yield { type: 'thinking', phase: 'archiving' };
      this.postProcess(event.content, assistantContent).catch((err) => {
        logger.warn({ err }, '非阻塞后处理失败');
      });

      // Handoff 衔接决策：基于 L2 策略的 handoff 配置（标准键 reflect.handoff，§六），
      // 经 resolveHandoff 归位非法值，避免透传无法识别的衔接决策给宿主
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
   * 内核软暂停在 loop 边界挂起后，用户点击"继续"触发：
   * 翻状态机为 RUNNING（触发 sessionResumed → 宿主转发 STATUS{running}），
   * 重新驱动 loop.continueAfterPause 续跑生成器并转发 chunk，
   * 完成后追加助手消息历史 + 后处理（与 chat 尾处理一致）。
   *
   * 硬停止（signal.abort）仍是唯一霸道中止路径，与软暂停严格区分。
   *
   * @param input - 可选补充输入（空=续跑原路径；有=注入修正后续轮）
   * @param signal - 可选 AbortSignal（硬停止仍走此路径）
   */
  async *resumeExecution(input?: string, signal?: AbortSignal): AsyncGenerator<AgentChunk, void, unknown> {
    const resumeStatus = this._sessionManager?.status;
    // 错误态续跑应明确失败而非静默吞没——error 态由检查点恢复回填进入，运行时异常走
    // `yield { type: 'error' }` 不翻状态机，故生产链路不会自然离开 error 态，
    // 必须显式提示用户重新开始，而非被 `status !== 'paused'` 的静默 return 吞没。
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
      // 翻状态机为 RUNNING（触发 sessionResumed，宿主据此转发 STATUS{running}）
      if (!this.resume()) {
        // P1-2: resume() 返回 false 时 yield error chunk + 发射事件，
        // 让调用方（宿主 generator 消费者）可感知失败原因而非静默吞没
        this.emit(AGENT_EVENTS.sessionResumeFailed, {
          sessionId: this._sessionManager?.getCheckpoint()?.sessionId,
          reason: 'resume() 返回 false，可能因暂停超时或状态机拒绝',
        });
        yield { type: 'error', message: '会话已超时，无法自动恢复，请重新开始新对话' };
        return;
      }

      // P0-1：预判短路——计划停滞 + 无新输入 + 非自主工具步 → 无需续跑，直接提示
      // 避免 continueAfterPause 在无意义场景下调用 LLM 浪费 token
      // 条件拆解：isPlanStalled() 需检查点存在（resume() 成功后必定存在），
      // isInAutonomousStep 需 loop 存在（requireLoop 保证）。
      if (!input) {
        const sm = this._sessionManager!;
        if (sm.isPlanStalled() && !this.requireLoop.isInAutonomousStep) {
          // 区分"已完成"与"全部阻塞"——blocked ≠ done，用户被告知任务完成而实际一步未成。
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

      // 追加助手消息到历史
      try {
        await this.requireHistory.appendAssistant(assistantContent, loop.getCurrentRoundId());
      } catch (err) {
        logger.warn({ err }, '助手消息历史写入失败');
      }

      // 后处理（非阻塞：不阻塞 generator 发送 handoff/done，UI 能正常结束生成态）
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
   * chat 主路径（`loop.processEvent`）与续跑路径（`loop.continueAfterPause`）此前
   * 各持一份逐行同构的消费逻辑，且已实证漂移——续跑路径漏了 `paused` 分支，导致
   * loop 挂起时 pauseMeta 写成 suspended 而状态机/检查点停留 running（三方分叉）。
   * 收口于此后，新增 chunk 类型只需改一处。
   *
   * 暂停幂等锁的释放放在 finally：清理是「退出本作用域的不变式」而非某条分支的动作，
   * 使今后新增 return 分支不再有遗漏可能。
   *
   * @param source - 待消费的执行流（processEvent 或 continueAfterPause）
   * @returns 消费结果；`failed` 为 true 时调用方应立即 return（错误 chunk 已 yield）
   */
  private async *consumeExecutionStream(
    source: AsyncGenerator<AgentChunk, void, unknown>,
  ): AsyncGenerator<AgentChunk, { content: string; aborted: boolean; failed: boolean }, unknown> {
    let content = '';
    let aborted = false;

    try {
      for await (const chunk of source) {
        // 内核事实驱动：loop 在迭代边界真正挂起时，状态机才翻 PAUSED（修 D1）
        // 不在 requestPause 同步翻转——避免"申请即暂停"错位
        if (chunk.type === 'paused') {
          // 延迟翻转挂起 = 用户暂停请求的消费端，与 requestPause 空闲分支同源，
          // 必须传 lowRisk=true 保持同一暂停事件契约一致（否则流中暂停会被计入 P4 配额）。
          // 从 SessionStateMachine 消费 pending 暂停信息（SSOT 收口）
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
      // 释放暂停幂等锁，覆盖正常结束 / abort / error 三路。
      // 残留会让 requestPause 的幂等检查永久拒绝后续暂停请求（暂停按钮全失效）。
      this._sessionManager?.cancelPendingPause();
      // 同步清理 loop 的 pauseRequested 标志（P1-1：复用 isBusy 后，finally 块需显式清理）
      this.requireLoop.clearPauseRequest();
    }

    return { content, aborted, failed: false };
  }

  /**
   * 处理非 chat 事件（P1 意图分类防污染）
   *
   * command/correction/clarify 事件不写 chat 历史，不触发后处理。
   * 直接在 loop 层处理，通过 onSessionEvent 回调同步状态机。
   * 避免控制信号/元信息污染对话流。
   *
   * @param event - 非 chat 类型的事件
   * @param signal - 可选的 AbortSignal
   */
  private async *handleNonChatEvent(
    event: SessionEvent,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<AgentChunk, void, unknown> {
    // 非 chat 事件不需要完整上下文准备（召回、角色匹配、技能注入、写历史等）
    // 仅通过 onSessionEvent 回调同步状态机，loop 层处理具体响应
    for await (const chunk of this.requireLoop.processEvent(event, undefined, signal)) {
      yield chunk;
    }
  }

  /**
   * 将澄清回答 JSON 格式化为可读文本（clarify → chat 转换用）
   *
   * 宿主（chatHandlers）将用户回答序列化为 `[{slot, answer}, ...]` JSON 字符串，
   * 此处解析为自然语言，写历史后用户可见、LLM 可理解。
   * 解析失败时原样返回（降级不阻断）。
   *
   * @param content - 澄清回答的 JSON 字符串
   * @returns 可读回答文本
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

  // ─── P2.1：检查点恢复协议（温记忆按需召回 + 契约重注入） ──

  /**
   * 温记忆按需召回（P2.1 检查点恢复协议·步骤③）
   *
   * 以 mainGoal/currentGoal 为查询条件，从温记忆（归档 recall）召回窗口外的早期上下文，
   * 合并到资源槽（resource.memories + resource.context），同时注入 AgentLoop 的 system message
   * 作为早期上下文参考，让 Agent 恢复后能感知暂停前的完整上下文。
   *
   * 召回失败时静默降级，仅记录日志，不影响热窗口恢复和契约重注入。
   *
   * @param checkpoint - 当前检查点（含 mainGoal/currentGoal）
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

      // 将召回的温记忆 ID 合并到资源槽（去重）
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
            // 在 context 末尾追加温记忆召回摘要，标记召回来源
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
   * 契约重注入（P2.1 检查点恢复协议·步骤④）
   *
   * 重新注入角色契约和技能契约，确保 Agent 恢复后的 system prompt 与暂停前一致：
   * - 角色契约：根据检查点 role 信息切换 persona 并刷新系统 prompt
   * - 技能契约：按资源槽文档路径尝试匹配技能注入
   * - 规则契约：由 AgentLoop 的 bootstrap 机制（bootstrapMemories）自动注入，无需额外处理
   *
   * 角色不存在时静默降级（保持当前角色），技能匹配失败仅记录日志。
   *
   * @param checkpoint - 当前检查点（含 role/resource 信息）
   */
  private reinjectContracts(checkpoint: SessionCheckpoint): void {
    // ① 角色契约重注入：根据检查点角色信息刷新系统 prompt
    if (this.personaManager && checkpoint.role.name) {
      try {
        const prevName = this.personaManager.activeName;
        if (prevName !== checkpoint.role.name) {
          // 尝试按检查点角色名切换角色（角色不存在时 switchPersona 抛异常，由 catch 静默降级）
          this.personaManager.switchPersona(checkpoint.role.name);
          this.emit(AGENT_EVENTS.personaSwitched, {
            from: prevName,
            to: checkpoint.role.name,
          });
        }
        // 刷新角色前缀（无论是否切换都执行，确保角色 prompt 被注入到 loop）
        this.refreshPersonaPrefixOnLoop();
      } catch (err) {
        // 角色不存在时静默降级：保持当前角色，仅记录日志
        logger.warn(
          { err, roleName: checkpoint.role.name },
          '契约重注入：角色切换失败，保持当前角色',
        );
      }
    }

    // ② 技能契约重注入：按资源槽文档路径尝试匹配技能
    if (this.skillManager && this.loop) {
      try {
        for (const doc of checkpoint.resource.documents) {
          this.matchAndInjectSkill(doc);
        }
      } catch (err) {
        logger.warn({ err }, '契约重注入：技能重注入失败');
      }
    }

    // ③ 规则契约：由 AgentLoop 的 bootstrap 机制（bootstrapMemories）自动注入
    // 在 restoreFromCheckpoint 中 loop.restoreHistory(messages) 后，
    // bootstrap 系统消息会在下一轮 processUserInput 时由 cleanTemporarySystemMessages 清理后重新注入
    // 不需要额外处理

    logger.info(
      {
        role: checkpoint.role.name,
        skillDocCount: checkpoint.resource.documents.length,
      },
      '契约重注入完成',
    );
  }

  /**
   * 暂停会话
   *
   * 双向暂停：用户/Agent/系统均可触发。
   * 暂停前自动创建检查点保存当前状态。
   *
   * @param reason - 暂停原因
   * @param source - 暂停来源（默认 'user'）
   * @param lowRisk - 低风险暂停不计入 P4 连续暂停计数（默认 false）
   * @returns 是否暂停成功
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
   * 恢复会话
   *
   * 从 PAUSED 状态恢复到 RUNNING。
   *
   * @returns 是否恢复成功
   */
  resume(): boolean {
    this.assertInitialized('resume');
    return this.requireSessionManager.resume();
  }

  /**
   * 自动恢复暂停状态（P2-1: 路径统一）
   *
   * 从 chat() 和 processEvent() 提取的共同逻辑：
   * 检查状态机是否处于 ERROR/PAUSED 状态，ERROR 态直接 throw（拒绝），
   * PAUSED 态尝试自动恢复。调用方根据返回值决定失败处理方式：
   * - chat() 用 yield error chunk 友好提示用户
   * - processEvent() 用 throw 向上传播
   * - resumeExecution() 不调用本方法（有独立的预判短路逻辑，见 P0-1）
   *
   * 双通道模型（v2.0）：暂停只停「工作通道」，输入通道永不冻结。
   * PAUSED 态收到用户事件 = 自动恢复工作通道 + 作为补充注入继续；
   * command 事件（显式暂停/恢复命令）不触发自动恢复，保持状态机语义。
   * ERROR 态仍拒绝（须先 recover，防止状态不一致）。
   *
   * @param eventType - 事件类型（可选），'command' 事件不触发自动恢复
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

  // P0-2：软暂停申请时暂存的 reason/source 已收口到 SessionStateMachine（SSOT 四方冗余修复 2026-08-10）
  /** P2-11: 兜底停滞计数器——连续无 task_table_update 的回合数 */
  private _stalledRoundCount = 0;

  /**
   * 请求软暂停（不中断工作模型 v2.1）
   *
   * 仅设置 loop 的 pauseRequested 标志（loop 在下一迭代边界挂起，不 abort），
   * 并暂存 reason/source 到 SessionStateMachine（SSOT 收口）。
   * 状态机翻 PAUSED **延后到 loop 边界真正挂起时**
   * （见 chat() 对 {type:'paused'} chunk 的处理）——内核事实驱动，而非申请即翻转（修 D1）。
   * 与硬停止（signal.abort）严格区分：软暂停保留 this.messages，可经 resumeExecution 续跑。
   *
   * @param reason - 暂停原因（用于状态展示）
   * @param source - 暂停来源
   * @returns true=暂停请求已注册（将在下一迭代边界生效）；false=无法暂停（状态机不接受）
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

    // 无活跃流时（isBusy=false），延迟翻转机制没有消费方——
    // consumeExecutionStream 的 finally 不会执行，pending 状态将永驻并锁死幂等，
    // 且此时本就没有正在执行的工具需要「延迟到迭代边界挂起」。直接同步翻状态机，
    // 不产生悬挂副本（这是内核事实驱动延迟翻转的正当例外：无流可延迟）。
    if (!this.isBusy) {
      // 用户主动暂停不消耗 P4 连续暂停配额 → lowRisk=true
      this.pause(reason, source, true);
      return true;
    }

    // 委托给 SessionStateMachine 管理 pending 暂停状态（含幂等检查）
    if (!sm.requestPause(reason, source)) {
      logger.debug('requestPause 忽略：已有待处理的暂停请求');
      return false;
    }

    // 设置 loop 边界挂起标志
    this.requireLoop.requestPause();
    return true;
  }

  /**
   * 取消待处理的软暂停请求（P1-6: SESSION_CANCEL_PAUSE 落点）
   *
   * 清空 loop 的 pauseRequested 标志，让工作通道继续运行。
   * 与 requestPause 对称：申请→loop 边界挂起，取消→清标志继续。
   * SessionStateMachine 的 pending 状态同步清理（SSOT 收口）。
   */
  cancelPauseRequest(): void {
    this.assertInitialized('cancelPauseRequest');
    this.requireLoop.clearPauseRequest();
    this._sessionManager?.cancelPendingPause();
  }

  /**
   * 是否存在待处理的暂停申请（申请已发、尚未在 loop 边界挂起）
   *
   * 供宿主 UI 区分三态：运行中无申请（显示「暂停」）/ 申请已发未触发
   * （显示「取消暂停」）/ 已暂停（显示「继续」）。
   *
   * 状态真理源：SessionStateMachine.isPausePending()——流中 requestPause 置位，
   * loop 边界真正挂起后由 consumePendingPause() 消费，
   * cancelPauseRequest 主动清理。空闲态 requestPause 直接翻 PAUSED（不置位 pending），
   * 故 `isPausePending()` 精确表达「申请在途」。
   *
   * @returns true=暂停申请在途（状态机仍 running）；false=无在途申请或已暂停
   */
  isPausePending(): boolean {
    return this._sessionManager?.isPausePending() ?? false;
  }

  /**
   * 执行中插话（Phase 5）
   *
   * 在 LLM 执行过程中插入用户输入，中断当前 LLM 调用 / 工具执行，
   * 将插话内容注入下一轮迭代继续处理。
   *
   * 与 requestPause 的区别：
   *   - requestPause 在迭代边界挂起，保留上下文待续跑
   *   - interject 立即中断当前操作，注入新内容后继续，用户无感知中断
   *
   * 使用场景：Agent 正在生成长回答时用户补充关键信息，
   * 宿主（如精灵）的快捷输入框收到用户输入时调用此方法。
   *
   * 调用链：Agent.interject() → AgentLoop.interject() → abort interjectController
   * → effectiveSignal.aborted → 子方法返回 → processUserInput 消费 pendingInterjections
   * → 注入 user 消息 → 继续循环
   *
   * @param content 插话内容
   */
  interject(content: string): void {
    this.assertInitialized('interject');
    this.requireLoop.interject(content);
  }

  /**
   * 追加计划步骤（P1-6: SESSION_APPEND_TASK 落点）
   *
   * 在现有 plan 末尾追加一个新步骤。
   * 简单实现：读取当前 plan，追加新步骤后调用 updatePlan。
   *
   * @param description 步骤描述
   * @returns 追加后的步骤总数
   */
  appendPlanStep(description: string): number {
    this.assertInitialized('appendPlanStep');
    const sm = this.requireSessionManager;
    return sm.appendPlanStep(description);
  }

  /**
   * 卸载运行态挂载物：清空检查点计划与回合日志（SSOT 资源层 vs 状态层模型 2026-08-10）
   *
   * 宿主在任务流结束/停止/异常广播 idle 前调用，将运行期任务状态（plan/roundLog）
   * 整体卸载，回到"空闲 = 无挂载物"的资源层常态；会话历史与记忆等资源层内容不受影响。
   */
  clearPlan(): void {
    this.assertInitialized('clearPlan');
    this.requireSessionManager.clearPlan();
  }

  /**
   * P2.5-1: 预判是否应提示 LLM 生成任务表
   *
   * 保守默认 false，仅 plan 为空且用户输入含明确多步信号时返回 true。
   * 候选信号：用户显式多步指示（步骤列举/顺序词/计划词）。
   * 不依赖 composer 补全器，保持职责分离。
   *
   * @param event - 当前用户事件
   * @param checkpoint - 当前检查点（可选）
   * @returns 是否应提示 LLM 生成任务表
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
   * 内核→宿主信号：当前会话是否可"无输入续跑"（决定 sprite 暂停按钮显隐 + 暂停后继续 UI）
   *
   * 真值条件（按优先级）：
   *  1. 状态机已处于 paused —— 已软暂停，必可经 resumeExecution 续跑（最高优先级）。
   *     注意：pauseRequested 在 loop 下一迭代边界才真正挂起生成器，彼时 inAutonomousStep
   *     已被重置为 false；若仅看 isInAutonomousStep 会在"刚暂停"瞬间误报 false。
   *     故 paused 状态本身即"可续跑"的充分条件。
   *  2. loop 正处于自主工具步（isInAutonomousStep）—— 流式进行中、有自主任务在跑，
   *     此刻应暴露暂停按钮（用户可在边界挂起）。
   *  3. 检查点存在未完成的计划步骤（hasPendingPlan）—— 多轮推进任务，可续跑下一轮。
   *
   * 三者皆否（纯单轮问答、无待续目标）→ 返回 false，sprite 对该轮隐藏暂停按钮（仅停止）。
   */
  canContinueWithoutInput(): boolean {
    if (this._sessionManager?.status === 'paused') return true;
    // 错误态不展示"继续"——error 态由检查点恢复回填进入，必须显式处理
    // （重新开始或 recover），不应诱导用户点"继续"后静默无反应。
    if (this._sessionManager?.status === 'error') return false;
    // 仅 pending/active（可推进）步骤计入"可续跑"。
    // 旧判据 `s.status !== 'done'` 把 blocked 也算可续 → 与 isPlanStalled 判据反向
    // （sessionManager.ts:1056 视 blocked 为停滞）→ 全 blocked 计划按钮可点但
    // resumeExecution 早退、点了没反应。blocked 步骤无法推进，不应展示"继续"。
    const hasPendingPlan =
      this._sessionManager?.getCheckpoint()?.plan.some(
        (s) => s.status === 'pending' || s.status === 'active',
      ) ?? false;
    return this.requireLoop.isInAutonomousStep || hasPendingPlan;
  }

  /**
   * 触发会话异常（公开 API，宿主显式调用）
   *
   * 仅 RUNNING 状态可触发异常。异常时自动创建检查点保存当前状态。
   *
   * 触发面说明（SSOT 排雷 T2-2 定性）：生产内部**无调用者**——
   * 运行时异常（LLM 超时/工具失败等）走 `yield { type: 'error' }` 事件流
   * （本文件 :540/:979/:1057），不翻状态机。本 API 供宿主在自定义异常
   * 场景（如外部服务故障）显式触发，或经检查点恢复回填进入 ERROR 态
   * （sessionManager.ts:481/:541）。
   *
   * @param cause - 异常原因
   * @returns 是否触发成功
   */
  triggerError(cause: string): boolean {
    this.assertInitialized('triggerError');
    return this.requireSessionManager.triggerError(cause);
  }

  /**
   * 从异常恢复
   *
   * 校验恢复条件：error.recovered === true 且 cause 已解除。
   *
   * @returns 是否恢复成功
   */
  recover(): boolean {
    this.assertInitialized('recover');
    return this.requireSessionManager.recover();
  }

  /**
   * 创建会话检查点
   *
   * 快照当前运行时状态（热记忆、角色、标准等），生成可序列化的检查点。
   *
   * @param mainGoal - 原始目标（首次创建时必填）
   * @param role - 当前角色
   * @param standard - 当前执行标准
   * @returns 当前会话检查点
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
   *
   * @returns 当前检查点快照，若未创建则返回 null
   */
  getCheckpoint(): SessionCheckpoint | null {
    this.assertInitialized('getCheckpoint');
    return this.requireSessionManager.getCheckpoint();
  }

  /**
   * P2.5-3: 向 loop 注入 system 消息
   *
   * @param message - system 消息内容
   */
  injectSystemMessage(message: string): void {
    this.requireLoop.injectSystemMessage(message);
  }

  /**
   * 从检查点恢复会话（完整恢复协议）
   *
   * 执行完整恢复协议：
   * ① 快照反序列化 + ② 热窗口载入（由 SessionManager 完成）
   * ③ 温记忆按需召回：以 mainGoal/currentGoal 为查询条件，从温记忆（归档 recall）召回早期上下文
   * ④ 契约重注入：persona/skill 重新注入
   * ⑤ 恢复校验：由状态机 ERROR 恢复时校验
   *
   * 温记忆召回失败时静默降级，仅恢复热窗口和契约，不影响用户继续对话。
   *
   * @param checkpoint - 要恢复的检查点
   * @returns 恢复的消息数量
   */
  async restoreFromCheckpoint(checkpoint: SessionCheckpoint): Promise<number> {
    this.assertInitialized('restoreFromCheckpoint');

    // ① 快照反序列化 + ② 热窗口载入（由 SessionManager 完成）
    // F2.1：SessionManager.restoreFromCheckpoint 已改为 async，await 等待完成
    const messageCount = await this.requireSessionManager.restoreFromCheckpoint(checkpoint);

    // ③ 温记忆按需召回：以 mainGoal/currentGoal 为查询条件，从温记忆召回早期上下文
    await this.warmRecallForCheckpoint(checkpoint);

    // ④ 契约重注入：persona/skill 重新注入
    this.reinjectContracts(checkpoint);

    logger.info(
      { sessionId: checkpoint.sessionId, messageCount },
      '检查点恢复协议完成（热窗口 + 温记忆 + 契约重注入）',
    );

    return messageCount;
  }

  /**
   * 处理会话事件回调（从 AgentLoop 接收）
   *
   * 根据事件类型触发状态机转换或检查点更新。
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
   * 应用增量解析结果到检查点（P1 增量解析）
   *
   * 将 Composer 解析后的 ResolvedDelta 应用到 SessionManager 检查点，
   * 实现增量事件的槽位级更新。
   *
   * 更新规则：
   * - 角色、标准、任务、资源各槽位独立更新
   * - P4 级别（澄清中）的槽位不应用（等待用户回答）
   *
   * @param resolved - Composer 解析后的增量结果
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
   * 分叉当前会话（委托至 SessionManager）
   *
   * 分叉后原会话完整保留，新分支拥有独立消息历史。
   * 记忆索引（IMemoryStorage）全局共享，不受分叉影响。
   */
  forkSession(targetSession?: string): AgentForkResult {
    this.assertInitialized('forkSession');
    return this.requireSessionManager.forkSession(targetSession);
  }

  /**
   * 切换到指定项目
   *
   * 切换后自动 rebuildComponents()，无需手动调用。
   * Agent 级记忆（memora.db）保留，项目级配置（.memora/）重新加载。
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
      personaName: this.#config.personaName,
      activeRolePack: this.#config.activeRolePack,
      maxContextTokens: this.#config.maxContextTokens,
      sessionStore: this.#config.sessionStore,
      tracer: this.#config.tracer,
      messages: this.#config.messages,
      enableContextSummary: this.#config.enableContextSummary,
      webSearchProvider: this.#config.webSearchProvider,
      existingSkillManager: this.skillManager,
      // 事件回调组（T-C2 收敛：8 个平铺回调收进 callbacks，与 AssembleCallbacks 接口对齐）
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
        onGuardrailError: (rule, message) => {
          this.emit(AGENT_EVENTS.guardrailError, { rule, message });
        },
        onSessionEvent: (eventType, detail) => {
          this.handleSessionEvent(eventType, detail);
        },
        // 工具执行完成回调（P3.3 工具幂等 outbox 模式 + P3.4 补偿机制）
        // 记录已执行的工具调用到会话检查点，供恢复时检查重复执行
        // 同时记录工具的幂等性级别，供补偿机制识别非幂等操作
        onToolExecuted: (name, args, toolResult, ok) => {
          // 查找工具的幂等性级别（内置工具查映射表，自定义工具默认非幂等）
          const idempotent: IdempotencyLevel = BUILTIN_TOOL_IDEMPOTENCY[name] ?? 'non-idempotent';
          const record: ToolExecutionRecord = {
            name,
            argsSignature: args,
            executedAt: Date.now(),
            resultSummary: toolResult.slice(0, 100),
            ok,
            idempotent,
          };
          // 会话管理器可能尚未创建（assembler 中 loop 先于 sessionManager 创建），
          // 暂存到队列，待 sessionManager 就绪后由 _flushPendingToolExecutions 统一写入。
          // 一旦就绪则直接写入：缓冲仅作装配期瞬态，避免「先 push 缓冲又直写」导致的
          // 双写污染 completedToolCalls，以及稳态下缓冲无限增长（内存泄漏）。
          if (!this._sessionManager) {
            this._pendingToolExecutions.push(record);
          } else {
            this._sessionManager.logToolExecution(record);
          }
        },
        // 工具执行前检查回调（设计文档 §7.2.1，统一执行前检查点）
        // 组合宿主审批 + 内部幂等检查为单一检查点：
        //   1. 宿主审批优先（可拒绝/跳过/改写参数）——denied 直接短路返回；
        //   2. 宿主放行后，再做内部幂等检查（outbox 仅一次语义）。
        // 未注入宿主回调时完全降级为现状（仅内部幂等检查）。
        preExecutionCheck: (name, args): PreExecutionResult => {
          // 1. 宿主审批（审批/审计/参数改写/白名单/只读拦截通道）
          const hostResult = this.#config.preExecutionCheck?.(name, args);
          if (hostResult?.denied) return hostResult; // 拒绝：直接短路，阻止工具意图
          if (hostResult?.skip) return hostResult; // 跳过：宿主决定不执行
          // 2. 内部幂等检查（P3.4 补偿机制·仅一次语义）
          // 检查工具是否已在当前会话的检查点中执行过
          // 仅对幂等工具生效（idempotent / idempotent-key），非幂等工具不跳过
          const sm = this._sessionManager;
          if (!sm) return { skip: false, overrideArgs: hostResult?.overrideArgs };
          // 幂等契约判断委托 shouldSkipForIdempotency（builtinTools.ts SSOT）：
          // - non-idempotent 不跳过（失败可重试，恢复由补偿机制兜底）
          // - 幂等工具仅上次执行成功（ok === true）时跳过（J1 修复，与注释对齐）
          const idempotent: IdempotencyLevel = BUILTIN_TOOL_IDEMPOTENCY[name] ?? 'non-idempotent';
          const idemResult = shouldSkipForIdempotency(
            sm.getCheckpoint()?.completedToolCalls,
            name,
            args,
            idempotent,
          );
          // 组合：幂等跳过优先；放行时透传宿主的参数改写
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
    this.personaManager = result.personaManager;
    this.skillManager = result.skillManager;
    this.rolePackManager_ = result.rolePackManager;
    this.configManager = result.configManager;
    this.memoryInspector = result.memoryInspector;
    this.dedupManager = result.dedupManager;
    this.memoryAdvisor = result.memoryAdvisor;
    this.autoConfigRefiner = result.autoConfigRefiner;
    this.workProjection = result.workProjection;
    this.sessionArchiver = result.sessionArchiver;
    this.textPolisher = result.textPolisher;
    this.roundSummaryGenerator = result.roundSummaryGenerator;
    // 绑定记忆写入回调：新记忆（round-summary）沉淀后 emit('memoryAdded')
    // 替代原洞察层的「已沉淀」通知出口，保持内核"新记忆产生必通知"契约
    this.roundSummaryGenerator?.setOnMemoryAdded((info) => {
      this.emit(AGENT_EVENTS.memoryAdded, info);
    });
    // 注入 VectorStore 到 MemoryInspector，启用混合搜索
    if (this.memoryInspector && this.#config.vectorStore) {
      this.memoryInspector.setVectorStore(this.#config.vectorStore);
    }
    // 创建会话管理器（提取 createSessionManager 辅助方法，消除重复）
    this._sessionManager = this.createSessionManager();
    // 冲洗工具执行暂存队列：会话管理器已就绪，将暂存的执行记录写入检查点
    this._flushPendingToolExecutions();

    // P2-5: 装配 loop 回调 —— 接线 onPaused / onRoundBoundary
    this.loop.onPaused = () => {
      // onPaused 在 loop 边界真正挂起时触发
      // 设置 pauseMeta，标记已挂起（含暂停原因/来源）
      // 暂停原因/来源从 SessionStateMachine 读取（SSOT 收口）
      const pendingInfo = this._sessionManager?.pendingPauseInfo;
      this._sessionManager?.setPauseMeta({
        reason: pendingInfo?.reason ?? '用户主动暂停',
        source: pendingInfo?.source ?? 'user',
      });
    };
    // 主动提问（mvp-scope §三）：回答中检测到 LLM 结构化输出 [ASK] 时，
    // 发射 questionPending 事件（宿主渲染提问 UI）+ 触发暂停，等待用户回答。
    // 与 needClarify（P4 目标槽位补全）触发源不同，但共享 pause/resume 机制。
    this.loop.onPendingQuestion = (questions) => {
      if (questions.length === 0) return;
      // 发射结构化事件，宿主据此渲染提问输入框
      this.emit(AGENT_EVENTS.questionPending, questions);
      // 触发软暂停：handleTextResponse 返回 'paused'，consumeExecutionStream 翻 PAUSED
      // requestPause 已负责记录 reason/source 和状态检查
      const reason = `需要澄清：${questions.map((q) => q.question).join('; ')}`;
      this.requestPause(reason, 'agent');
    };
    this.loop.onRoundBoundary = (roundInfo) => {
      // onRoundBoundary 在每次迭代完成后触发
      // 通过 SessionManager.completeRound 写入 roundLog
      // roundLog 关联 plan 步骤——取当前 active 步骤的 ID 传入。
      // 此前不传 stepId（恒 undefined）→ roundLog 与 plan 无法关联，
      // 「哪一回合推进了哪一步」不可追溯。单向引用：plan 仍是任务状态真理源，
      // roundLog 成为 plan 的时间轴投影（不做双向同步，避免双写）。
      const activeStepId = this._sessionManager?.getCheckpoint()?.plan.find(
        (s) => s.status === 'active',
      )?.id;
      this._sessionManager?.completeRound({
        stepId: activeStepId,
        summary: roundInfo.summary,
      });

      // P2-11: 兜底停滞检测——连续 3 轮无 task_table_update 且 plan 有未完任务
      this._stalledRoundCount++;
      if (this._stalledRoundCount >= 3) {
        const sm = this._sessionManager;
        const cp = sm?.getCheckpoint();
        if (cp) {
          const activeStep = cp.plan.find((s) => s.status === 'active');
          const hasPending = cp.plan.some((s) => s.status === 'pending' || s.status === 'active');
          if (activeStep && hasPending) {
            // 经 updatePlanStepStatus 标脏——checkpointDirty 置位确保阻塞标记可落盘
            sm?.updatePlanStepStatus(activeStep.id, 'blocked');
            // 注入 system 消息提示 LLM
            this.loop?.injectSystemMessage(
              `[系统] 检测到任务表停滞（连续 3 回合未更新步骤状态），已自动将步骤 "${activeStep.description}" 标记为 blocked。请使用 task_table_update 推进剩余任务，或使用 task_table_write 重新规划。`,
            );
          }
        }
        // 复位计数器（无论是否触发，防止无限触发）
        this._stalledRoundCount = 0;
      }
    };

    // P2-8: 装配任务表注入回调——每次迭代 LLM 调用前统一注入
    this.loop.getTaskTable = () => {
      const cp = this._sessionManager?.getCheckpoint();
      if (!cp) return '';
      return renderTaskTable(cp.plan, cp.roundLog);
    };

    // P2-6: 装配任务表工具回调（planManager）
    this.toolExec.planManager = {
      writePlan: (mode, steps) => {
        const sm = this._sessionManager;
        if (!sm) return '[ERR] 会话管理器未就绪';
        // 分发逻辑归位 SessionManager.writePlan（计划写入口 SSOT，可被单测直接覆盖）
        const newPlan = sm.writePlan(mode, steps);
        return `任务表已更新（${mode}），当前共 ${newPlan.length} 个步骤：\n${
          newPlan.map((s) => `  - [${s.id.slice(0, 8)}] ${s.description}`).join('\n')
        }`;
      },
      updateStep: (stepId, status) => {
        const sm = this._sessionManager;
        if (!sm) return '[ERR] 会话管理器未就绪';
        // plan 步骤状态变更收口到 SessionManager.updatePlanStepStatus
        // （内部 touchCheckpoint 标脏 + 心跳，唯一写点）。
        // 旧实现直改 step.status + 手写 lastHeartbeat → checkpointDirty 未置位 →
        // 计划状态变更可能永不落盘（flushCheckpoint 见脏才写）。
        if (!sm.updatePlanStepStatus(stepId, status)) {
          return `[ERR:STEP_NOT_FOUND] 未找到步骤 ${stepId}`;
        }
        const step = sm.getCheckpoint()?.plan.find((s) => s.id === stepId);
        // P2-11: 兜底停滞计数器复位（LLM 调用了 task_table_update，说明未停滞）
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
   * 冲洗工具执行暂存队列（P3.3 工具幂等 outbox 模式）
   *
   * 将 assembler 期间暂存的工具执行记录写入会话管理器检查点。
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
   * 创建会话管理器（提取重复的 forwardEvent + SessionManager 构造逻辑）
   *
   * assembleComponents 与 rebuildComponents 共享同一套构造逻辑：
   * - 通过回调访问当前组件（支持 rebuild 后自动获取最新引用）
   * - 事件转发桥接：SessionManager 使用宽类型 (string, Record<string,unknown>)，
   *   Agent 内部桥接到 TypedEventEmitter 的强类型 emit
   * - 运行时校验事件名是否在 AgentEventMap 中，避免不安全的类型断言
   *
   * @returns 新的 SessionManager 实例
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
    // 对话进行中切换 Provider 会导致同一 processUserInput 循环内前后两次 LLM 调用命中不同 Provider
    // （模型上下文窗口假设不一致 → 可能导致上下文截断逻辑误判或 tool_call 格式不兼容）
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
    // 同步更新 AutoConfigRefiner 的后台 Provider
    if (this.autoConfigRefiner) {
      this.autoConfigRefiner.setBackgroundProvider(provider);
    }
    logger.info({ hasBackground: !!provider }, '后台 Provider 已切换');
  }

  // ─── 归档模式管理（ADR-015） ───────────────────────────

  /**
   * 运行时切换归档模式
   *
   * 与 setProvider 一致，对话进行中禁止切换（避免本轮 postProcess 行为不一致）。
   *
   * @param mode 目标模式
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
   * 查询当前归档模式
   *
   * 宿主 UI（如设置面板）可据此同步显示当前模式。
   */
  getArchiveMode(): ArchiveMode {
    return this.#config.archiveMode;
  }

  /**
   * 手动切换角色（宿主 UI 角色选择器入口）
   *
   * 与 doPostProcess 中的自动匹配走同一条事件链路，确保：
   *   1. AgentLoop 的 systemPromptPrefix 立即刷新（下一次对话使用新角色 prompt）
   *   2. 发射 personaSwitched 事件，触发 spriteLifecycleManager 的完整副作用：
   *      - emit('personaChanged') 通知宿主 UI
   *      - proactiveEngine.addNotice('persona', ...) 记录通知
   *      - perceptionCoordinator.refreshBeforeChat() 基于新角色 traits 重新推导情感基调
   *
   * 对话进行中切换角色会破坏当前 system prompt，与项目切换一致拒绝。
   *
   * @param name 目标角色名
   * @returns 切换成功返回新角色的 system prompt 段；角色不存在或切换失败返回 null
   */
  switchPersona(name: string): string | null {
    this.assertInitialized('switchPersona');
    this.assertNotBusy('切换角色');

    if (!this.personaManager) return null;

    // 同名切换幂等：直接返回当前 prompt，不触发事件链路
    if (this.personaManager.activeName === name) {
      return this.personaManager.buildSystemPrompt();
    }

    const prevName = this.personaManager.activeName;
    try {
      this.personaManager.switchPersona(name);
    } catch (err) {
      // 角色不存在时 PersonaManager 抛 MemoraError，降级为 null 返回
      logger.warn({ err: toError(err).message, name }, '手动切换角色失败');
      return null;
    }

    // 同步刷新 AgentLoop 的角色前缀（关键：否则下一次对话仍用旧角色 prompt）
    // 与 doPostProcess 自动匹配共用同一段逻辑，ADR-017 枝叶层 2 次提取
    this.refreshPersonaPrefixOnLoop();

    // 发射切换事件，触发宿主 UI 刷新 + 感知重推导 + 通知队列记录
    this.emit(AGENT_EVENTS.personaSwitched, { from: prevName, to: name });
    logger.info({ from: prevName, to: name }, '角色手动切换');
    return this.personaManager.buildSystemPrompt();
  }

  /**
   * 获取角色切换锁定状态（透传 PersonaManager，P0-2 用户体验打磨）
   *
   * 与 switchPersona 分离：switchPersona 仍返回 string | null 不变，
   * 锁定原因查询走独立路径，避免破坏既有契约（cli.ts、sprite.test.ts 等消费者无感）。
   *
   * 宿主 IPC 层调用此方法前置判断锁定状态，区分"切换失败"原因
   * （locked / busy / not_found / invalid），让用户知道为什么没反应。
   *
   * @returns locked 是否处于锁定状态；unlockAt 锁定自动恢复时间戳（ms epoch），未锁定时为 null
   */
  getPersonaSwitchLockStatus(): { locked: boolean; unlockAt: number | null } {
    this.assertInitialized('getPersonaSwitchLockStatus');
    if (!this.personaManager) return { locked: false, unlockAt: null };
    return this.personaManager.getSwitchLockStatus();
  }

  /**
   * 刷新 AgentLoop 的 systemPromptPrefix（角色 prompt）
   *
   * 提取自 doPostProcess 自动匹配 + switchPersona 手动切换两处共用逻辑（ADR-017 枝叶层 2 次提取）。
   * 用户画像已收敛为 round-summary 召回（2026-08-14），前缀仅含 persona。
   *
   * 调用时机：
   * - tryAutoMatchPersona 中角色自动匹配成功后（chat() 回答前）
   * - switchPersona 手动切换成功后
   * - loop 为 null 时静默跳过（init 前或 close 后的边界场景）
   */
  private refreshPersonaPrefixOnLoop(): void {
    if (!this.loop) return;
    // 角色包优先：激活角色包时用其 L1 persona，否则回退 personaManager（角色包优先/persona 兜底）
    const rolePackPrompt = this.rolePackManager_?.buildSystemPrompt() ?? '';
    const personaPrompt = rolePackPrompt || (this.personaManager?.buildSystemPrompt() ?? '');
    const newPrefix =
      personaPrompt ? `${personaPrompt}\n\n---\n\n` : '';
    this.loop.refreshPersonaPrefix(newPrefix);
  }

  /**
   * 手动切换激活角色包（宿主 UI 角色视图 / 角色选择器入口）
   *
   * 角色包系统（rolePackManager）的「单一切换入口」：与 tryAutoMatchRolePack 自动
   * 匹配共用同一条链路（ADR-017 枝叶层提取），确保任何切换路径都一致地：
   *   1. RolePackManager.activate 更新激活态（单一真理源 activePackName）
   *   2. 发射 personaSwitched 事件（from → to）——宿主各视图（设置/对话）订阅此事件刷新
   *   3. refreshPersonaPrefixOnLoop 刷新 AgentLoop 前缀（下一次对话即用新角色包 L1 persona）
   *
   * 与 switchPersona 的区别：本方法操作角色包系统（rolePackManager），switchPersona
   * 操作 persona 系统；角色包优先于 persona（refreshPersonaPrefixOnLoop 角色包优先）。
   * 不做 assertNotBusy（与自动匹配一致）：切换只影响后续对话的 system prompt，不破坏
   * 进行中生成。
   *
   * @param name 目标角色包名
   * @returns 是否切换成功（角色包不存在返回 false 且不触发事件；同名切换幂等返回 true）
   */
  switchRolePack(name: string): boolean {
    const rpm = this.rolePackManager_;
    if (!rpm) return false;
    const prevName = rpm.activeName;
    // 同名切换幂等：不触发事件链路（对齐 switchPersona 语义）
    if (prevName === name) return true;
    const ok = rpm.activate(name);
    if (!ok) return false;
    this.emit(AGENT_EVENTS.personaSwitched, { from: prevName ?? '', to: name });
    // 刷新 system prompt 前缀（角色包优先，装载其 L1 persona）
    this.refreshPersonaPrefixOnLoop();
    logger.info({ rolePack: name }, '角色包切换');
    return true;
  }

  /**
   * 角色包自动匹配（粘性，角色包优先于 persona）
   *
   * 在 chat() 回答前执行，优先于 tryAutoMatchPersona。经 RolePackManager.autoMatch
   * 的粘性语义匹配（§6.2）：首次外部输入命中即锁定当前会话，后续仅互斥包命中才切换。
   * 命中后激活角色包并刷新 system prompt 前缀（装载其 L1 persona）。
   *
   * @param input 用户输入文本
   * @returns 是否发生了角色包匹配/切换（true 时不再走 persona 兜底）
   */
  private tryAutoMatchRolePack(input: string): boolean {
    const rpm = this.rolePackManager_;
    if (!rpm) return false;
    const matched = rpm.autoMatch(input); // 粘性匹配（含会话内锁定副作用）
    if (!matched) return false;
    // 与 switchRolePack 共用同一切换链路（activate + personaSwitched + 前缀刷新，
    // ADR-017 枝叶层提取），autoMatch 保证 matched ≠ 当前激活名，不触发幂等分支
    return this.switchRolePack(matched);
  }

  /**
   * 角色自动匹配（best-effort：失败不阻塞对话流程）
   *
   * 在 chat() 回答前执行，确保本轮 LLM 调用就用匹配到的角色 system prompt。
   * 两层匹配策略：关键词高置信度 → LLM 辅助（低置信度且 backgroundProvider 已注入时）。
   * LLM 辅助匹配在 agent 层执行，遵循 backend_layers_rules §分层职责（persona/ 不直接调 LLM）。
   *
   * 匹配成功时：切换角色 + 发射 personaSwitched 事件 + 刷新 AgentLoop 前缀。
   * 匹配失败/异常时：静默降级，保持当前角色。
   *
   * @param input 用户输入文本
   */
  private async tryAutoMatchPersona(input: string): Promise<void> {
    if (!this.personaManager) return;
    try {
      let matchedPersona: string | null = null;
      if (this.personaManager.canAutoMatch()) {
        matchedPersona = this.personaManager.autoMatch(input);
        // 关键词低置信度且 backgroundProvider 已注入 → LLM 辅助语义匹配
        const bgProvider = this.#backgroundProvider;
        if (!matchedPersona && bgProvider) {
          matchedPersona = await matchPersonaByLlm(
            bgProvider,
            this.personaManager.list,
            this.personaManager.activeName,
            input,
          );
        }
      }
      if (matchedPersona) {
        const prevName = this.personaManager.activeName;
        this.personaManager.switchPersona(matchedPersona);
        this.emit(AGENT_EVENTS.personaSwitched, { from: prevName, to: matchedPersona });
        // 刷新 AgentLoop 的角色前缀（与 switchPersona 共用同一段逻辑，ADR-017 枝叶层 2 次提取）
        this.refreshPersonaPrefixOnLoop();
        logger.info({ persona: matchedPersona }, '角色自动切换');
      } else {
        // 关键词 + LLM 均未命中，且当前角色不是列表首个角色 → 回退到首个角色
        // "切过去回不来"：用户从默认切到散文作者后，输入无关话题应回到默认角色
        // 使用 list[0] 而非硬编码 'default'：防止 default 角色被删除后 fallback 抛异常
        const shouldFallback = this.shouldFallbackToDefault();
        if (shouldFallback) {
          const fallbackTarget = this.personaManager.list[0]?.name ?? 'default';
          const prevName = this.personaManager.activeName;
          this.personaManager.switchPersona(fallbackTarget);
          this.emit(AGENT_EVENTS.personaSwitched, { from: prevName, to: fallbackTarget });
          this.refreshPersonaPrefixOnLoop();
          logger.info({ persona: fallbackTarget }, '角色回退默认');
        }
      }
    } catch (err) {
      logger.warn({ err }, '角色自动匹配失败');
    }
  }

  /**
   * 判断是否应回退到默认角色
   *
   * 回退条件（全部满足）：
   *   1. 当前激活角色不是默认角色（已在默认角色则无需回退）
   *   2. 角色管理器存在且非锁定状态（锁定时 switchPersona 也会被拦截，回退无意义）
   *
   * 注意：bgProvider 未配置时也会触发回退——因为关键词 + LLM 均未命中说明当前角色不匹配本轮对话，
   * 回退默认角色比卡在错误角色上更合理。
   *
   * @returns 是否应回退到默认角色
   */
  private shouldFallbackToDefault(): boolean {
    if (!this.personaManager) return false;
    // manual 模式下不回退：用户明确固定了角色，回退会破坏其意图
    if (this.personaManager.currentMode !== 'auto') return false;
    const status = this.personaManager.getSwitchLockStatus();
    if (status.locked) return false; // 锁定中不回退，避免无意义调用 switchPersona
    // 当前角色已是���表首个角色（"默认"角色）→ 无需回退
    const defaultName = this.personaManager.list[0]?.name;
    return defaultName !== undefined && this.personaManager.activeName !== defaultName;
  }

  /**
   * 手动归档会话内容（content 类记忆）
   *
   * 适用于 `manual` 模式下用户手动触发会话内容归档。
   * `full` 模式下由宿主在会话切换前自动调用，无需用户干预。
   *
   * FIX-P1-4：新增 options 参数透传给 ArchiveCoordinator。
   * 宿主自动触发时传 `{ autoTriggered: true }`，由 ArchiveCoordinator 内部按模式判断；
   * 用户手动触发时无需传 options（默认 autoTriggered=false，无条件执行）。
   *
   * 归档逻辑已委托给 ArchiveCoordinator
   *
   * @param date 会话日期 YYYY-MM-DD
   * @param session 会话标识（不含日期前缀）
   * @param options 触发选项（autoTriggered 默认 false，即手动触发）
   * @returns 归档结果（memories 可能为空，表示无归档价值或 LLM 失败）
   */
  async archiveSessionContent(
    date: string,
    session: string,
    options?: ArchiveTriggerOptions,
  ): Promise<SessionArchiveResult> {
    this.assertInitialized('archiveSessionContent');
    return this.requireArchiveCoordinator.archiveSessionContent(date, session, options);
  }

  // ─── 配置重载（事件驱动） ───────────────────────

  /**
   * 重载配置类记忆：从 configDir 重新扫描指定 source 的配置文件并更新内存缓存 + SQLite 索引
   *
   * 解决方案：installSkill 写入文件后或 confirmConfigSuggestion 写入配置文件后，
   * 调用此方法使当前会话立即生效，无需重启 Agent。
   *
   * 支持的 source：
   * - 'skill' → SkillManager.reload() 清空缓存重新扫描 skills/ 目录
   * - 'persona' → PersonaManager.reload() 清空缓存重新扫描 personas/ 目录（保持激活角色）
   * - 'rule' → 无操作（rule 类型由 ConfigManager CRUD 即时同步 bootstrap 段，详见 deleteRule/updateRule）
   * - 'guardrail' → 抛错（guardrail 是 AgentLoop 的 readonly 数组，需 rebuildComponents 才能重载）
   * - undefined → 重载 skill + persona（全量重载，不含 guardrail）
   *
   * @param source 配置类型，缺省时重载全部可热更新的配置
   * @returns 重载结果统计
   */
  async reloadConfig(source?: string): Promise<{ skill: number; persona: number }> {
    this.assertInitialized('reloadConfig');
    if (this.chatLockManager?.isBusy) {
      // 对话进行中无法热重载：将 source 暂存，待 chat() finally 块释放锁后补执行
      // source 为 undefined（全量重载）时不暂存——全量重载无具体来源，补执行语义不明
      if (source) {
        this.pendingConfigReload.add(source);
        logger.info({ source }, '对话进行中，配置重载已暂存，将在对话结束后补执行');
      }
      throw chatBusyError('重载配置');
    }

    // guardrail 需重建 AgentLoop，不属于热重载范畴
    if (source === 'guardrail') {
      throw configError(
        'guardrail 不支持热重载',
        'guardrail 规则是 AgentLoop 的 readonly 数组，需调用 rebuildComponents() 重建',
        ['使用 rebuildComponents() 重建组件（代价较高）'],
      );
    }

    // rule 类型由 ConfigManager.deleteRule/updateRule CRUD 即时同步 bootstrap 段（refreshBootstrapMemories 回调），无需 reloadConfig
    if (source === 'rule') {
      logger.info('rule 类型由 ConfigManager CRUD 即时同步 bootstrap 段，reloadConfig 跳过');
      return { skill: 0, persona: 0 };
    }

    const result = { skill: 0, persona: 0 };
    const errors: Error[] = [];

    // 按需重载：source 缺省时全量重载，否则只重载指定类型
    const shouldReloadSkill = !source || source === 'skill';
    const shouldReloadPersona = !source || source === 'persona';

    if (shouldReloadSkill && this.skillManager) {
      try {
        result.skill = await this.skillManager.reload();
      } catch (err) {
        errors.push(toError(err));
        logger.warn({ err: toError(err) }, 'reloadConfig: skillManager.reload 失败');
      }
    }

    if (shouldReloadPersona && this.personaManager) {
      try {
        result.persona = await this.personaManager.reload();
        // 角色重载后，刷新 AgentLoop 的角色前缀（使新角色内容立即注入 system prompt）
        if (this.loop) {
          const newPrefix = this.personaManager.buildSystemPrompt();
          this.loop.refreshPersonaPrefix(newPrefix);
        }
      } catch (err) {
        errors.push(toError(err));
        logger.warn({ err: toError(err) }, 'reloadConfig: personaManager.reload 失败');
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
   * 重建内部组件（history / loop / managers）
   *
   * 通常不需要手动调用——switchProject() 已自动执行 rebuild。
   * 仅在宿主项目需要强制刷新组件时使用（如热更新配置后）。
   */
  async rebuildComponents(): Promise<void> {
    // 对话进行中重建组件会导致 loop/history 引用被替换，工作记忆与持久化状态不一致
    this.assertNotBusy('重建组件');
    if (!this.pctx) return;
    await this.assembleComponents(this.pctx);
    // 重建会话管理器：assembleComponents 创建了新的 history/loop 实例（复用 createSessionManager）
    this._sessionManager = this.createSessionManager();
  }

  // ─── 守卫方法 ───────────────────────────────────────────

  /**
   * 检查 Agent 是否已初始化
   *
   * @param methodName 调用方法名（用于错误消息）
   * @param requires 需要检查的组件列表
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
   * 断言对话未进行中 — 统一守卫，避免在 chat() 进行中执行会破坏状态一致性的操作
   *
   * 提取原因：switchProject / setProvider / setBackgroundProvider / setArchiveMode /
   * switchPersona / rebuildComponents 等 6 处方法均有相同的 `if (isBusy) throw chatBusyError('XXX')` 守卫，
   * 违反 DRY 原则。
   *
   * 注意：reloadConfig 不使用本方法——它在 isBusy 时需暂存 source 而非直接抛错。
   *
   * @param operation 操作名称（用于错误消息，如 "切换项目"）
   */
  private assertNotBusy(operation: string): void {
    if (this.chatLockManager?.isBusy) {
      throw chatBusyError(operation);
    }
  }

  /**
   * 断言 getter：获取 loop，若 null 则抛出明确错误
   * 替代 `this.loop!` 非空断言，提供更好的重构安全性
   */
  private get requireLoop(): AgentLoop {
    if (!this.loop) throw configError('AgentLoop 未初始化', undefined, ['在调用此方法前执行 await agent.init()']);
    return this.loop;
  }

  /**
   * 断言 getter：获取 history，若 null 则抛出明确错误
   */
  private get requireHistory(): MessageHistory {
    if (!this.history) throw configError('MessageHistory 未初始化', undefined, ['在调用此方法前执行 await agent.init()']);
    return this.history;
  }

  /**
   * 断言 getter：获取 pctx，若 null 则抛出明确错误
   */
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
   * 获取角色包管理器（M1 清单抽象）
   *
   * 为插卡式角色包预留的生长点。
   * 当前与 PersonaManager + SkillManager 共存。
   * 返回 null 表示 Agent 未初始化。
   */
  get rolePackManager(): RolePackManager | null {
    return this.rolePackManager_;
  }

  /**
   * 获取当前激活的 L2 行为策略
   *
   * 从当前激活的角色包中读取策略声明，未激活时使用全局默认值。
   * 供 Agent 内部各阶段（Prepare/Act/Reflect）按策略调整行为。
   *
   * @returns 完整的 L2 行为策略（所有维度都有值）
   */
  getActiveStrategy(): BehaviorStrategy {
    return this.rolePackManager_?.getActive()?.strategy ?? DEFAULT_BEHAVIOR_STRATEGY;
  }

  /**
   * 应用当前角色包的工具暴露面（M2.1：换角色 → 工具集切换）
   *
   * 范式主张（role-pack-spec §四 + mvp-scope 验收标准 7）：
   * 「换装 = 换 Agent」——角色包声明的 capabilities（中立能力）经 capabilityMap
   * 映射为 memora 工具白名单，控制 LLM 可见/可调的工具集。
   *
   * 规则：
   * - 激活角色包声明了 capabilities → 白名单 = resolveCapabilityTools(capabilities)；
   * - 激活角色包未声明 capabilities（或无角色包）→ 白名单 = null（全部暴露，保持现状）；
   * - toolMode=block 已在 setToolCallsBlocked 处理（全禁），与白名单正交。
   *
   * 每轮 chat Prepare 阶段调用（与 setToolCallsBlocked 同位），角色包切换后
   * 下一轮自动生效。变更经 setToolWhitelist → onToolsChanged → refreshToolDefinitions
   * 链路同步 AgentLoop 快照与 system prompt。
   */
  private applyRolePackToolExposure(): void {
    if (!this.toolExec) return;
    const active = this.rolePackManager_?.getActive();
    const capabilities = active?.capabilities;
    // 仅角色包明确声明了能力（非空）时才限定工具白名单；未声明（空数组，parseCapabilities
    // 对 undefined 返回 []）视为"全部暴露"（role-pack-spec §四 + mvp-scope 验收 7）。
    // 否则空数组会解析为"空白名单=全禁"，误伤未声明能力的角色包。
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
    // 清理 chat 锁管理器（递增 token 使进行中的 chat() generator 的 finally 块
    // 检测到 token 变化后跳过资源清理，close 已接管清理职责）
    this.chatLockManager?.dispose();
    this.chatLockManager = null;
    // 清理 MemoryDecayScheduler（含定时器和 storage 引用）
    // 先 stop() abort L2 评估的 LLM 调用，再 awaitInflight() 等待 Promise 完成，
    // 防止 close 后 LLM 回调 upsert 已关闭的 storage
    if (this.memoryDecayScheduler) {
      this.memoryDecayScheduler.stop();
      try {
        await this.memoryDecayScheduler.awaitInflight();
      } catch (err) {
        logger.warn({ err: toError(err) }, 'close: memoryDecayScheduler.awaitInflight 失败');
      }
      this.memoryDecayScheduler = null;
    }
    // 等待 WorkProjection 的 inflight LLM 生成完成，防止 close 后 upsert 已关闭的 storage
    if (this.workProjection) {
      try {
        await this.workProjection.awaitInflight();
      } catch (err) {
        logger.warn({ err: toError(err) }, 'close: workProjection.awaitInflight 失败');
      }
    }
    // P0-2：处理 pending 暂停状态残留——关闭前确保状态机与检查点一致
    // 关闭时若仍有 pending 的暂停请求，记录警告并清理（暂停不会在关闭后被执行）
    const sm = this._sessionManager;
    if (sm?.isPausePending()) {
      const pendingInfo = sm.pendingPauseInfo;
      logger.warn(
        { reason: pendingInfo?.reason, source: pendingInfo?.source },
        'close() 时存在未消费的暂停请求，已自动清理',
      );
      // 若状态机仍为 running（暂停请求尚未被 loop 边界消费或 processEvent 尚未翻状态机），
      // 同步翻状态机使检查点记录 paused 状态，确保磁盘快照准确。
      // 无需触发生成器挂起（close 后不再运行），仅修正状态机与检查点的一致性。
      // 系统清理暂停不消耗 P4 配额 → lowRisk=true（与 requestPause 空闲分支语义对齐）
      if (sm.status === 'running') {
        sm.pause('close 清理残留暂停', 'system', true);
      }
      // 清理 pending 状态字段
      sm.cancelPendingPause();
    }

    // 清理 SessionManager（停止暂停超时定时器，防止悬空定时器阻止进程退出）
    // 必须在 nullifyAllComponents 之前调用，因为 destroy() 需要访问 sessionManager 内部状态
    if (this._sessionManager) {
      // flush 脏检查点落盘后再 destroy——覆盖 logToolExecution 标脏后、completeRound 之前关闭的窗口
      this._sessionManager.flushOnShutdown();
      this._sessionManager.destroy();
    }
    // 清理 ArchiveCoordinator（无定时器，只需释放引用）
    this.archiveCoordinator = null;
    // 清理 PersonaManager 的角色切换防抖锁计时器，防止关闭后回调触发
    if (this.personaManager) {
      this.personaManager.close();
    }

    // 先等待后台归档完成，再移除事件监听器
    // 顺序敏感：若先 removeAllListeners，fire-and-forget 的归档 Promise 在 await 期间
    // reject 时 emit 会变成 no-op（listeners 已清空），archiveFailed 事件丢失
    if (this.history) {
      try {
        await this.history.awaitPendingArchives(AGENT_CONSTANTS.SHUTDOWN_ARCHIVE_TIMEOUT_MS);
      } catch (err) {
        logger.warn({ err: toError(err) }, 'close: awaitPendingArchives 失败');
      }
    }
    // pending archives 完成后再移除监听器，确保归档失败的 emit 能送达
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
   * 统一 null 化所有组件字段（新增 Manager 时在此处追加一行）
   *
   * 仅处理"纯 null 化"字段，带副作用的清理（dispose/stop/close/shutdown）
   * 仍由 close() 显式调用，顺序敏感不可合并。
   */
  private nullifyAllComponents(): void {
    // Provider
    this.#backgroundProvider = null;
    // 核心组件
    this.history = null;
    this.loop = null;
    this.toolExec = null;
    // 专职 Manager
    this.personaManager = null;
    this.skillManager = null;
    this.configManager = null;
    this.memoryInspector = null;
    this.dedupManager = null;
    this.memoryAdvisor = null;
    this._governance = null;
    this.workProjection = null;
    this.autoConfigRefiner = null;
    this.sessionArchiver = null;
    this.sessionNamer = null;
    this.textPolisher = null;
    this.roundSummaryGenerator = null;
    this._sessionManager = null;
    // 项目管理
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
   * 获取 AgentLoop 实例（宿主集成面，用于会话恢复等底层操作）
   *
   * 有界替代方案：getMessages() / getMessageCount() 可覆盖只读场景，
   * 但 restoreHistory() 等操作需要直接访问 loop，当前无替代接口。
   * 若未来需要进一步封装，请注意：getMessages/getMessageCount 无法替代 restoreHistory。
   */
  get agentLoop(): AgentLoop | null {
    return this.loop;
  }

  /**
   * 获取当前消息列表（只读副本，不可绕过 Agent 编排链路直接修改）
   */
  getMessages(): readonly Message[] {
    return this.loop?.getMessages() ?? [];
  }

  /** 获取当前消息数量 */
  getMessageCount(): number {
    return this.loop?.getMessages().length ?? 0;
  }

  /**
   * 获取 MessageHistory 实例（宿主集成面，用于日期/会话判断等底层操作）
   *
   * 有界替代方案：chat/chatSync/forkSession 可覆盖对话管理场景，
   * 但 currentDateValue/currentSessionValue 等只读属性当前无替代接口。
   * 若未来需要进一步封装，请注意：对话管理方法无法替代日期/会话属性读取。
   */
  get agentHistory(): MessageHistory | null {
    return this.history;
  }

  /**
   * 注入情感基调到 system prompt（Phase 2.1：AffectController）
   *
   * 委托至 AgentLoop.injectAffect()，在角色前缀和 bootstrap 记忆之间插入情感描述。
   * 与角色切换独立——切换角色不会清除情感注入。
   *
   * @param affectString 情感描述文本，传空字符串清除注入
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

  /**
   * 记忆治理统一门面（L0 衰减 / L1 去重 / L2 时效性 / L3 冲突 / 诊断 / 推荐）
   *
   * 统一入口替代散落在 Agent 上的 6 个独立方法：
   *   agent.governance.decay()           → 原 runMemoryDecayOnce()
   *   agent.governance.deduplicate()     → 原 deduplicateMemories()
   *   agent.governance.evaluateTimeliness() → 原 evaluateTimeliness()
   *   agent.governance.detectConflicts() → 原 detectConflicts()
   *   agent.governance.sourceHealth()    → 原 sourceHealth()
   *   agent.governance.suggest()         → 原 suggest()
   */
  get governance(): MemoryGovernance | null {
    return this._governance;
  }

  // ─── 运行时指标 ────────────────────────────────

  /**
   * 获取 Agent 运行时指标快照（可观测性增强）
   *
   * 聚合 AgentLoop 指标（LLM 调用、记忆召回、工具调用、上下文管理）
   * 与 Agent 层指标（记忆衰减），返回完整的 AgentMetrics 快照。
   *
   * 未初始化时返回全零指标（合理的默认值，不抛异常）。
   * 纯只读、同步、零副作用——适合宿主项目定期轮询构建监控面板。
   *
   * 使用方式：
   *   const metrics = agent.getMetrics();
   *   console.log(`LLM 调用 ${metrics.llm.callCount} 次，命中率 ${metrics.recall.hitRate}`);
   *
   * @returns AgentMetrics 完整快照（含衰减指标）
   */
  getMetrics(): AgentMetrics {
    // 衰减指标从 MemoryDecayScheduler 读取
    const decayMetrics = this.memoryDecayScheduler?.getMetrics() ?? {
      runCount: 0,
      totalDecayedCount: 0,
      lastRunAt: null,
    };
    // 未初始化时返回全零指标，避免调用方需要判空
    if (!this.loop) {
      return {
        llm: { callCount: 0, totalInputTokens: 0, totalOutputTokens: 0 },
        recall: { totalCount: 0, hitCount: 0, hitRate: 0 },
        tools: { callCount: 0, failureCount: 0 },
        context: { truncationCount: 0, messageCount: 0, estimatedTokens: 0 },
        decay: decayMetrics,
      };
    }

    // 获取 AgentLoop 指标快照，填充衰减字段
    const loopMetrics = this.loop.getMetrics();
    return {
      ...loopMetrics,
      decay: decayMetrics,
    };
  }

  // ─── Manager 暴露（激进拆分：调用方直接操作 Manager）──
  //
  // 设计策略（ADR-010 §Manager 访问器）：访问器返回 null，门面方法抛错。
  // - 访问器（getter）：返回 Manager | null，供宿主项目链式调用和优雅降级
  //   （如 `agent.persona?.activeName`、`if (!agent.memory) return []`）
  // - 门面方法（snapshot/inspect/stats/searchMemories 等）：通过
  //   assertInitialized 抛 MemoraError，提供明确错误信息
  // 宿主项目使用访问器时需自行判空，或使用门面方法获得自动错误处理。

  /**
   * 角色管理器（可能为 null）
   *
   * 返回 null 时表示 Agent 未初始化或角色系统未加载。
   * 链式调用建议使用可选链：`agent.persona?.activeName`
   */
  get persona(): PersonaManager | null {
    return this.personaManager;
  }

  /**
   * 工具执行器（可能为 null）
   *
   * 返回 null 时表示 Agent 未初始化。
   */
  get tools(): ToolExecutor | null {
    return this.toolExec;
  }

  /**
   * 技能管理器（可能为 null）
   *
   * 返回 null 时表示 Agent 未初始化或技能系统未加载。
   */
  get skills(): SkillManager | null {
    return this.skillManager;
  }

  /**
   * 配置管理器（可能为 null）—— 规则/技能注入 + 配置建议
   *
   * 返回 null 时表示 Agent 未初始化。
   */
  get config(): ConfigManager | null {
    return this.configManager;
  }

  /**
   * 记忆查看器（可能为 null）—— 快照 + 搜索 + 统计
   *
   * 返回 null 时表示 Agent 未初始化或存储层未就绪。
   * 宿主项目常用模式：`const mem = agent.memory; if (!mem) return [];`
   */
  get memory(): MemoryInspector | null {
    return this.memoryInspector;
  }

  /**
   * 项目管理器（可能为 null）
   *
   * 返回 null 时表示 Agent 未初始化。
   */
  get projects(): ProjectManager | null {
    return this.projectManager;
  }

  /**
   * 安全守卫（可能为 null）—— 写入确认回调注册
   *
   * 返回 null 时表示 Agent 未初始化或 projectPath 未设置。
   * 宿主常用模式：
   *   - `agent.security?.onWriteConfirmation(callback)` 注册写入确认回调
   *   - 回调返回 true 允许写入，返回 false 拒绝写入
   *
   * 详见 M1 写入确认 UI 闭环
   */
  get security(): SecurityGuard | null {
    return this.pctx?.security ?? null;
  }

  /**
   * 作品投影管理器（可能为 null）—— 文件内容 → 概要+结构+决策
   *
   * 返回 null 时表示 Agent 未初始化。
   * 宿主常用模式：
   *   - `agent.works?.ensureProjection(filePath, content)` 读取文件后触发生成
   *   - `agent.works?.loadAll()` 获取所有投影
   */
  get works(): WorkProjectionManager | null {
    return this.workProjection;
  }

  /** 会话管理器（宿主可通过此 getter 访问会话恢复/切换/分叉功能） */
  get sessionManager(): SessionManager | null {
    return this._sessionManager;
  }

  /** 文本润色管理器（宿主可通过此 getter 调用 polish 方法） */
  get polish(): TextPolishManager | null {
    return this.textPolisher;
  }

}
