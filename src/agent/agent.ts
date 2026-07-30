/**
 * Agent 门面类 — Memora 宿主项目接入入口
 *
 * 设计文档（ADR-010 · Agent 门面类）要求宿主项目通过 `import { Agent } from '@zooique/memora'`
 * 一行代码接入。本类负责组件组装和核心对话编排，
 * 领域专属操作委托给专职 Manager（PersonaManager / ToolExecutor / SkillManager / ConfigManager / InsightExtractor / MemoryInspector）。
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
 *   - Insight 提取 → InsightExtractor
 *   - 配置管理 → ConfigManager
 *   - 记忆查看 → MemoryInspector
 *   - 薄包装方法移除，调用方改为 agent.<manager>.xxx()
 */
import { getBaseName } from '@/utils/path.js';
import { AGENT_CONSTANTS } from '@/agent/constants.js';
import type { AgentLoop } from '@/agent/loop.js';
import type { AgentChunk, ArchiveMode, AgentOptions, AgentContext, AgentConfig } from '@/agent/types.js';
import type { ToolExecutor } from '@/agent/toolExecutor.js';
import type { MessageHistory } from '@/agent/messageHistory.js';
import { ProjectManager, type ProjectContext } from '@/memory/projectManager.js';
import { SecurityGuard } from '@/security/pathGuard.js';
import type { AutoConfigRefiner } from '@/agent/managers/autoConfigRefiner.js';
import { recall, boostScores } from '@/memory/recall.js';
import type { PersonaManager } from '@/persona/personaManager.js';
import type { UserProfile, UserProfileEntry } from '@/memory/userProfile.js';
import type { SkillManager } from '@/skill/skillManager.js';
import type { InsightExtractor } from '@/agent/managers/insightExtractor.js';
import type { SessionArchiver, SessionArchiveResult } from '@/agent/managers/sessionArchiver.js';
import type { TextPolishManager } from '@/agent/managers/textPolishManager.js';
import type { ConfigManager } from '@/agent/managers/configManager.js';
import type { WorkProjectionManager } from '@/agent/managers/workProjection.js';
import type { MemoryInspector } from '@/agent/managers/memoryInspector.js';
import type { DedupManager } from '@/agent/managers/dedupManager.js';
import type { MemoryAdvisor } from '@/agent/managers/memoryAdvisor.js';
import { assembleComponents } from '@/agent/assembler.js';
import { matchPersonaByLlm } from '@/agent/personaMatcher.js';
import { chatBusyError, configError, isAbortError, toError } from '@/utils/errors.js';
import { SessionManager, type AgentForkResult } from '@/agent/managers/sessionManager.js';
import { ChatLockManager } from '@/agent/managers/chatLockManager.js';
import { MemoryDecayScheduler } from '@/agent/managers/memoryDecayScheduler.js';
import { MemoryGovernance } from '@/agent/managers/memoryGovernance.js';
import { ArchiveCoordinator, type ArchiveTriggerOptions } from '@/agent/managers/archiveCoordinator.js';
import { TypedEventEmitter, type AgentEventMap, AGENT_EVENTS, AGENT_EVENT_SET } from '@/utils/eventEmitter.js';
import type { LlmProvider, Message } from '@/llm/provider.js';
import type { Memory } from '@/memory/types.js';
import { logger } from '@/logging/logger.js';
import type { AgentMetrics } from '@/agent/tracer.js';
import { TRACE_SPANS, NOOP_TRACER } from '@/agent/tracer.js';

// ─── 模块级常量 ─────────────────────────────────────────

// AGENT_EVENTS / AGENT_EVENT_SET 已迁移至 utils/eventEmitter.ts（与 AgentEventMap 同处，单一真理源）

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

  // 运行时组件（init 后填充）
  private projectManager: ProjectManager | null = null;
  private history: MessageHistory | null = null;
  private loop: AgentLoop | null = null;
  private toolExec: ToolExecutor | null = null;

  // 新模块
  private personaManager: PersonaManager | null = null;
  #userProfile: UserProfile | null = null;
  private skillManager: SkillManager | null = null;

  // 拆分出的专职 Manager
  private insightExtractor: InsightExtractor | null = null;
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
  /** TextPolishManager（文本润色管理器，LLM 语法修正 + 表达优化） */
  private textPolisher: TextPolishManager | null = null;
  /** 会话管理器（从 Agent 拆分出的会话管理职责） */
  private _sessionManager: SessionManager | null = null;

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
      relationStore: opts.relationStore,
      sessionStore: opts.sessionStore,
      configDir: opts.configDir,
      tracer: opts.tracer,
      messages: opts.messages,
      enableContextSummary: opts.enableContextSummary ?? true,
      archiveMode: opts.archiveMode ?? 'full',
    };
    this.#provider = opts.provider;
    this.#backgroundProvider = opts.backgroundProvider ?? null;
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
    this._initialized = true;

    return pctx;
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

    // 归档操作委托给 ArchiveCoordinator
    this.archiveCoordinator = new ArchiveCoordinator({
      getUserProfile: () => this.#userProfile,
      getInsightExtractor: () => this.insightExtractor,
      getSessionArchiver: () => this.sessionArchiver,
      getArchiveMode: () => this.#config.archiveMode,
      emit: (event, payload) => this.emit(event, payload as never),
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

    // 角色自动匹配（回答前执行）
    await this.tryAutoMatchPersona(input);

    // 基元驱动召回（双通道：语义 + 关键词）
    yield { type: 'thinking', phase: 'recalling' };
    const recalledMemories = await this.recallAndInject(input);

    if (combinedSignal.aborted) return recalledMemories;

    // 技能关键词/正则匹配（当轮立即注入生效）
    yield { type: 'thinking', phase: 'processing' };
    this.matchAndInjectSkill(input);

    const history = this.requireHistory;
    await history.appendUser(input);

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

    let assistantContent = '';
    let wasAborted = false;

    try {
      for await (const chunk of loop.processUserInput(
        input,
        recalledMemories,
        combinedSignal,
      )) {
        yield chunk;
        if (chunk.type === 'text') {
          assistantContent += chunk.content;
        } else if (chunk.type === 'aborted') {
          wasAborted = true;
        }
      }
    } catch (err) {
      if (isAbortError(err)) {
        yield { type: 'aborted', reason: 'User cancelled the conversation' };
        return;
      } else {
        yield { type: 'error', message: err instanceof Error ? err.message : String(err) };
        return;
      }
    }

    if (wasAborted) {
      if (assistantContent.trim()) {
        const interruptedMark = this.#config.messages?.interrupted ?? '\n\n[已中断]';
        try {
          await history.appendAssistant(assistantContent + interruptedMark);
        } catch (err) {
          logger.warn({ err }, '中断消息历史写入失败');
        }
      }
      return;
    }

    // 追加助手消息到历史（best-effort）
    try {
      await history.appendAssistant(assistantContent);
    } catch (err) {
      logger.warn({ err }, '助手消息历史写入失败');
    }

    // 后处理阶段
    yield { type: 'thinking', phase: 'archiving' };
    await this.postProcess(input, assistantContent);
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
   *   1. 双通道召回（语义 + 关键词）
   *   2. Layer 5: 最近对话注入
   *
   * @param input 用户输入
   * @returns 召回的记忆列表
   */
  private async recallAndInject(input: string): Promise<Memory[]> {
    // 实际 recall() 函数耗时 span（区别于 loop.ts 的 RECALL 注入 span）
    const tracer = this.#config.tracer ?? NOOP_TRACER;
    const recallSpan = tracer.startSpan(TRACE_SPANS.RECALL_ACTUAL, {
      queryLength: input.length,
      hasVectorStore: !!this.#config.vectorStore,
    });

    let recalledMemories: Memory[] = [];
    try {
      recalledMemories = await recall(
        this.requirePctx.index,
        input,
        {
          limit: AGENT_CONSTANTS.DEFAULT_RECALL_LIMIT,
          vectorStore: this.#config.vectorStore,
          excludeSources: this.#config.recallExcludeSources,
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
      // FIX-P1-2：boost 持久化拆分为 fire-and-forget，不阻塞 chat 读路径
      // boost 是软指标（每次 +0.05，上限 1.0），写入失败仅 log 不影响 chat 流程
      const ids = recalledMemories.map((m) => m.id);
      void boostScores(this.requirePctx.index, ids).catch((err: unknown) => {
        logger.warn({ err }, 'boost 持久化失败（不影响 chat 流程）');
        this.emit(AGENT_EVENTS.boostPersistFailed, { memoryId: ids.join(','), message: toError(err).message });
      });
    }

    // Layer 5: 最近对话注入
    const loop = this.requireLoop;
    const recentHistory = loop.getRecentHistory(AGENT_CONSTANTS.DEFAULT_RECENT_HISTORY_ROUNDS);
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
   * 对话后处理：用户画像归档、角色匹配、技能匹配、Insight 提取
   *
   * 所有归档/匹配操作均为 best-effort：任何子步骤失败不应影响用户已收到的回答，
   * 失败仅记录日志，不向上抛出异常。
   *
   * ADR-015 归档模式控制：
   * - 角色匹配 + 技能匹配不受 archiveMode 影响（每轮都执行，非归档行为）
   * - `manual` 模式跳过所有自动归档（profile + insight），需用户手动调用
   *   archiveProfileFacts() / archiveInsight() 触发
   * - `full` / `insights-only` 模式下 profile + insight 都自动归档
   *   （会话归档实现后，`insights-only` 将跳过对话原始内容自动归档）
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

    // ADR-015 + FIX-P1-4: archiveMode 三态控制集中到 ArchiveCoordinator
    // 此处统一传 { autoTriggered: true }，由 ArchiveCoordinator 内部按 archiveMode 判断是否跳过：
    //   - manual 模式 → 跳过 profile/insight 自动归档（用户需手动调用）
    //   - full / insights-only 模式 → 执行
    // 角色匹配/技能匹配/AutoConfigRefiner 属"配置学习"行为，非归档，每轮都执行。
    const history = this.requireHistory;

    // 用户画像实时归档（委托 ArchiveCoordinator，与手动归档路径统一，消除 DRY 违反）
    try {
      // fire-and-forget 包装：registerPendingArchive 确保 close() 时等待后台归档完成
      // 失败时发射 archiveFailed 事件，让宿主 UI 可通知用户（而非静默吞没）
      const archiveFactsPromise = this.requireArchiveCoordinator.archiveProfileFacts(input, { autoTriggered: true }).then(
        () => {},
        (err) => {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn({ err, stage: 'profile' }, '归档失败');
          this.emit(AGENT_EVENTS.archiveFailed, { stage: 'profile', message: message.slice(0, 200) });
        },
      );
      history.registerPendingArchive(archiveFactsPromise);
    } catch (err) {
      logger.warn({ err }, '用户画像归档初始化失败');
    }

    // 输入分类 → Insight 提取（委托 ArchiveCoordinator，与手动归档路径统一）
    try {
      // fire-and-forget 包装：classify 判断由 ArchiveCoordinator 内部完成
      // 失败时发射 archiveFailed 事件，让宿主 UI 可通知用户（而非静默吞没）
      const archiveInsightPromise = this.requireArchiveCoordinator.archiveInsight(input, assistantContent, { autoTriggered: true }).then(
        () => {},
        (err) => {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn({ err, stage: 'insight' }, '归档失败');
          this.emit(AGENT_EVENTS.archiveFailed, { stage: 'insight', message: message.slice(0, 200) });
        },
      );
      history.registerPendingArchive(archiveInsightPromise);
    } catch (err) {
      logger.warn({ err }, 'Insight 提取初始化失败');
    }

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
    if (this.chatLockManager?.isBusy) {
      throw chatBusyError('切换项目');
    }

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
      await this.rebuildComponentsWithCurrentCtx();
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
      projectPath: this.#config.projectPath,
      configDir: this.#config.configDir,
      personaName: this.#config.personaName,
      maxContextTokens: this.#config.maxContextTokens,
      sessionStore: this.#config.sessionStore,
      relationStore: this.#config.relationStore,
      tracer: this.#config.tracer,
      messages: this.#config.messages,
      enableContextSummary: this.#config.enableContextSummary,
      existingSkillManager: this.skillManager,
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
    });

    this.history = result.history;
    this.loop = result.loop;
    this.toolExec = result.toolExec;
    this.personaManager = result.personaManager;
    this.#userProfile = result.userProfile;
    this.skillManager = result.skillManager;
    this.insightExtractor = result.insightExtractor;
    this.configManager = result.configManager;
    this.memoryInspector = result.memoryInspector;
    this.dedupManager = result.dedupManager;
    this.memoryAdvisor = result.memoryAdvisor;
    this.autoConfigRefiner = result.autoConfigRefiner;
    this.workProjection = result.workProjection;
    this.sessionArchiver = result.sessionArchiver;
    this.textPolisher = result.textPolisher;
    // 绑定冲突检测回调，InsightExtractor 检测到 contradicts 时 emit('conflictDetected')
    // 与 bindGetRecentHistory 同模式：解决 Agent 晚于 InsightExtractor 创建的时序循环依赖
    this.insightExtractor.bindOnConflict((info) => {
      this.emit(AGENT_EVENTS.conflictDetected, info);
    });
    // 注入 VectorStore 到 MemoryInspector，启用混合搜索
    if (this.memoryInspector && this.#config.vectorStore) {
      this.memoryInspector.setVectorStore(this.#config.vectorStore);
    }
    // 创建会话管理器（提取 createSessionManager 辅助方法，消除重复）
    this._sessionManager = this.createSessionManager();
  }

  /**
   * 用当前 pctx 重建 history / loop
   */
  private async rebuildComponentsWithCurrentCtx(): Promise<void> {
    if (!this.pctx) return;
    await this.assembleComponents(this.pctx);
    // 重建会话管理器：assembleComponents 创建了新的 history/loop 实例（复用 createSessionManager）
    this._sessionManager = this.createSessionManager();
  }

  /**
   * 创建会话管理器（提取重复的 forwardEvent + SessionManager 构造逻辑）
   *
   * assembleComponents 和 rebuildComponentsWithCurrentCtx 共享同一套构造逻辑：
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
    if (this.chatLockManager?.isBusy) {
      throw chatBusyError('切换 Provider');
    }
    this.#provider = provider;
    if (this.loop) {
      this.loop.setProvider(provider);
    }
    logger.info({ provider: this.#provider.name }, 'Provider 已切换');
  }

  setBackgroundProvider(provider: LlmProvider | null): void {
    // 与 setProvider 一致，对话进行中禁止切换后台 Provider
    if (this.chatLockManager?.isBusy) {
      throw chatBusyError('切换后台 Provider');
    }
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
    if (this.chatLockManager?.isBusy) {
      throw chatBusyError('切换归档模式');
    }
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
    if (this.chatLockManager?.isBusy) {
      throw chatBusyError('切换角色');
    }

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
   * 刷新 AgentLoop 的 systemPromptPrefix（角色 prompt + profile prompt）
   *
   * 提取自 doPostProcess 自动匹配 + switchPersona 手动切换两处共用逻辑（ADR-017 枝叶层 2 次提取）。
   * 组装规则：[personaPrompt, profilePrompt].filter(Boolean).join('\n\n') + 末尾分隔符 '---'
   *
   * 调用时机：
   * - tryAutoMatchPersona 中角色自动匹配成功后（chat() 回答前）
   * - switchPersona 手动切换成功后
   * - loop 为 null 时静默跳过（init 前或 close 后的边界场景）
   */
  private refreshPersonaPrefixOnLoop(): void {
    if (!this.loop) return;
    const profilePrompt = this.userProfile?.buildSystemPrompt() ?? '';
    const personaPrompt = this.personaManager?.buildSystemPrompt() ?? '';
    const newPrefix =
      [personaPrompt, profilePrompt].filter(Boolean).join('\n\n') +
      ([personaPrompt, profilePrompt].some(Boolean) ? '\n\n---\n\n' : '');
    this.loop.refreshPersonaPrefix(newPrefix);
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
   * 手动触发 profile facts 归档（manual 模式下使用）
   *
   * manual 模式下 postProcess 跳过自动归档，用户需通过此 API 主动归档。
   * full / insights-only 模式下也可调用（会重复归档，但不推荐）。
   *
   * FIX-P1-4：新增 options 参数透传给 ArchiveCoordinator。
   * 宿主自动触发时传 `{ autoTriggered: true }`，由 ArchiveCoordinator 内部按模式判断；
   * 用户手动触发时无需传 options（默认 autoTriggered=false，无条件执行）。
   *
   * 归档逻辑已委托给 ArchiveCoordinator
   *
   * @param input 本轮用户输入
   * @param options 触发选项（autoTriggered 默认 false，即手动触发）
   * @returns 写入/更新的 UserProfileEntry 列表
   */
  async archiveProfileFacts(input: string, options?: ArchiveTriggerOptions): Promise<UserProfileEntry[]> {
    this.assertInitialized('archiveProfileFacts');
    return this.requireArchiveCoordinator.archiveProfileFacts(input, options);
  }

  /**
   * 手动触发 insight 提取（manual 模式下使用）
   *
   * manual 模式下 postProcess 跳过自动归档，用户需通过此 API 主动归档。
   * 内部仍走 classify 判断（避免无价值输入浪费 LLM 调用）。
   *
   * FIX-P1-4：新增 options 参数透传给 ArchiveCoordinator。
   * 宿主自动触发时传 `{ autoTriggered: true }`，由 ArchiveCoordinator 内部按模式判断；
   * 用户手动触发时无需传 options（默认 autoTriggered=false，无条件执行）。
   *
   * 归档逻辑已委托给 ArchiveCoordinator
   *
   * @param input 本轮用户输入
   * @param assistantContent 本轮助手回复内容
   * @param options 触发选项（autoTriggered 默认 false，即手动触发）
   * @returns 写入/更新的 Memory 列表
   */
  async archiveInsight(
    input: string,
    assistantContent: string,
    options?: ArchiveTriggerOptions,
  ): Promise<Memory[]> {
    this.assertInitialized('archiveInsight');
    return this.requireArchiveCoordinator.archiveInsight(input, assistantContent, options);
  }

  /**
   * 手动归档会话内容（content 类记忆）
   *
   * 适用于 `insights-only` / `manual` 模式下用户手动触发会话内容归档。
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

  /**
   * 获取 pending 归档队列长度（MIND2-C3）
   *
   * 返回待重试的失败归档数。归档失败时输入入队，下次同阶段归档调用时自动重试。
   * 供宿主 UI 展示"N 条待补归档"提示，或判断是否需要手动触发重试。
   *
   * @returns pending 队列长度（0 表示无待补）
   */
  getPendingArchiveCount(): number {
    this.assertInitialized('getPendingArchiveCount');
    return this.requireArchiveCoordinator.getPendingArchiveCount();
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
    if (this.chatLockManager?.isBusy) {
      throw chatBusyError('重建组件');
    }
    await this.rebuildComponentsWithCurrentCtx();
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
    // FIX-P0-1：先 stop() abort L2 评估的 LLM 调用，再 awaitInflight() 等待 Promise 完成，
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
    // FIX-P0-1：等待 WorkProjection 的 inflight LLM 生成完成，防止 close 后 upsert 已关闭的 storage
    if (this.workProjection) {
      try {
        await this.workProjection.awaitInflight();
      } catch (err) {
        logger.warn({ err: toError(err) }, 'close: workProjection.awaitInflight 失败');
      }
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
    this.#userProfile = null;
    this.skillManager = null;
    this.insightExtractor = null;
    this.configManager = null;
    this.memoryInspector = null;
    this.dedupManager = null;
    this.memoryAdvisor = null;
    this._governance = null;
    this.workProjection = null;
    this.autoConfigRefiner = null;
    this.sessionArchiver = null;
    this.textPolisher = null;
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
   * @deprecated 直接暴露 AgentLoop 破坏封装，将在下一主版本移除。
   * 使用 getMessages() / getMessageCount() 等有界接口替代。
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
   * @deprecated 直接暴露 MessageHistory 破坏封装，将在下一主版本移除。
   * 使用 Agent 的对话管理方法（chat/chatSync/forkSession）替代直接操作。
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
   * Insight 提取器（可能为 null）—— 输入分类 + 记忆提取
   *
   * 返回 null 时表示 Agent 未初始化或 LLM Provider 未配置。
   */
  get insight(): InsightExtractor | null {
    return this.insightExtractor;
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
   * 用户画像管理器（可能为 null）—— 实时归档 + 确认/拒绝
   *
   * 返回 null 时表示 Agent 未初始化。
   * 宿主常用模式：
   *   - `agent.userProfile?.getPending()` 查询待确认条目
   *   - `await agent.userProfile?.confirm(id)` 确认条目
   *   - `await agent.userProfile?.reject(id)` 拒绝条目
   */
  get userProfile(): UserProfile | null {
    return this.#userProfile;
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
