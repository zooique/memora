/**
 * Agent 门面类 — Memora 宿主项目接入入口
 *
 * 设计文档（ADR-010 · Agent 门面类）要求宿主项目通过 `import { Agent } from '@memora/core'`
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
import { basename } from 'node:path';
import { AGENT_CONSTANTS } from '@/agent/constants.js';
import type { AgentLoop } from '@/agent/loop.js';
import type { AgentChunk, UIMessages } from '@/agent/types.js';
import type { ToolExecutor } from '@/agent/toolExecutor.js';
import type { MessageHistory } from '@/agent/messageHistory.js';
import { ProjectManager, type ProjectContext } from '@/memory/projectManager.js';
import { SecurityGuard } from '@/security/pathGuard.js';
import type { AutoConfigRefiner } from '@/agent/managers/autoConfigRefiner.js';
import { recall } from '@/memory/recall.js';
import type { PersonaManager } from '@/persona/personaManager.js';
import type { UserProfile } from '@/memory/userProfile.js';
import type { SkillManager } from '@/skill/skillManager.js';
import type { InsightExtractor } from '@/agent/managers/insightExtractor.js';
import type { ConfigManager } from '@/agent/managers/configManager.js';
import type { WorkProjectionManager } from '@/agent/managers/workProjection.js';
import type { MemoryInspector } from '@/agent/managers/memoryInspector.js';
import { extractUserFacts } from '@/agent/managers/userFactExtractor.js';
import { assembleComponents } from '@/agent/assembler.js';
import { configError, toError } from '@/utils/errors.js';
import { safeSetTimeout, clearSafeTimeout, safeSetInterval, clearSafeInterval } from '@/utils/safeTimer.js';
import { SessionManager, type AgentForkResult } from '@/agent/managers/sessionManager.js';
import { TypedEventEmitter, type AgentEventMap } from '@/utils/eventEmitter.js';
import type { LlmProvider } from '@/llm/provider.js';
import type { Memory } from '@/memory/types.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import type { IMemoryRelationStore } from '@/memory/relationStore.js';
import type { ISessionStore } from '@/memory/sessionStore.js';
import type { VectorStore } from '@/memory/vectorStore.js';
import { SOURCE_LABELS } from '@/memory/types.js';
import { logger } from '@/logging/logger.js';
import type { ITracer, AgentMetrics } from '@/agent/tracer.js';
import { NOOP_TRACER, TRACE_SPANS } from '@/agent/tracer.js';

// ─── 模块级常量 ─────────────────────────────────────────

/** Agent 事件名白名单，用于运行时校验 SessionManager 转发的事件类型 */
const AGENT_EVENT_NAMES: ReadonlySet<string> = new Set([
  'memoryAdded', 'personaSwitched', 'decayCompleted',
  'memoryRecalled', 'sessionForked', 'insightExtracted',
]);

// ─── 类型定义 ───────────────────────────────────────────

/** Agent 构造选项 */
export interface AgentOptions {
  /** 项目路径（必须） */
  projectPath: string;
  /** 前台 LLM Provider（必须，宿主负责创建） */
  provider: LlmProvider;
  /** 后台 LLM Provider（可选，用于投影等后台操作，不配时复用前台） */
  backgroundProvider?: LlmProvider;
  /** 配置目录（personas/rules/skills） */
  configDir?: string;
  /** 记忆数据目录（默认 ~/.memora） */
  dataDir?: string;
  /** 项目注册表目录（默认与 dataDir 相同）。设为用户级路径可避免每项目重复存储 */
  registryDir?: string;
  /** 最大上下文 token 数（默认 120000） */
  maxContextTokens?: number;
  /** 默认角色名 */
  persona?: string;
  /** 安全权限 */
  permission?: 'owner' | 'guest';
  /** 允许的路径白名单 */
  allowedPaths?: string[];
  /** 写入确认 */
  confirmWrites?: boolean;
  /** 向量存储（可选，提供时启用语义搜索召回） */
  vectorStore?: VectorStore;
  /** 召回时排除的 source 标签（默认 ['persona', 'rule', 'skill']，这些已由 bootstrap 注入） */
  recallExcludeSources?: string[];
  /** 外部注入的存储实例（可选，不传则内部创建 InMemoryStorage） */
  storage?: IMemoryStorage;
  /** 外部注入的记忆关系存储（可选，ADR-014 侧车模型，不传则跳过关系构建） */
  relationStore?: IMemoryRelationStore;
  /** 外部注入的会话存储（可选，不传则仅在内存中保存） */
  sessionStore?: ISessionStore;
  /** 可观测性 Tracer（可选，不传则使用 NoopTracer 静默丢弃所有 span） */
  tracer?: ITracer;
  /** 宿主可覆盖的 UI 消息文本（默认英文，宿主覆盖为中文等） */
  messages?: UIMessages;
  /** 上下文超限时是否自动生成摘要（默认 false，开启后首次截断时增加 ~1-2s 延迟） */
  enableContextSummary?: boolean;
}

/** Agent 初始化后暴露的运行时上下文 */
export type AgentContext = ProjectContext;

/** Agent 项目条目（来自 ProjectManager 注册表） */
export interface AgentProjectEntry {
  name: string;
  path: string;
  lastOpened: string;
}

/** Agent 内部配置（构造参数分组） */
interface AgentConfig {
  dataDir: string;
  registryDir: string | undefined;
  maxContextTokens: number;
  personaName: string | undefined;
  permission: 'owner' | 'guest';
  allowedPaths: string[];
  confirmWrites: boolean;
  vectorStore: VectorStore | undefined;
  recallExcludeSources: string[];
  storage: IMemoryStorage | undefined;
  relationStore: IMemoryRelationStore | undefined;
  sessionStore: ISessionStore | undefined;
  projectPath: string;
  configDir: string | undefined;
  tracer: ITracer | undefined;
  messages: UIMessages | undefined;
  enableContextSummary: boolean;
}

// ─── Agent 门面类 ───────────────────────────────────────

/**
 * Memora Agent 门面类
 *
 * **设计哲学**：单 Agent，单配置，单记忆。每个 Agent 实例拥有独立的
 * 对话管线（AgentLoop）、独立的消息历史（MessageHistory）和独立的
 * 运行时状态（activeSkill、chatBusy）。
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
  private workProjection: WorkProjectionManager | null = null;
  /** V-201: AutoConfigRefiner（模式 3：Agent 智能总结） */
  private autoConfigRefiner: AutoConfigRefiner | null = null;
  /** 会话管理器（从 Agent 拆分出的会话管理职责） */
  private _sessionManager: SessionManager | null = null;

  /** 当前激活的技能名（上一轮匹配，本轮注入） */
  private activeSkill: string | null = null;

  private _initialized = false;
  // 项目上下文（AgentContext 与 ProjectContext 等价，直接使用后者避免重复字段）
  private pctx: ProjectContext | null = null;

  /** chat() 并发锁 */
  private _chatBusy = false;
  /** 聊天锁超时计时器（防止 LLM 卡死时锁永久持有） */
  private chatLockTimer: ReturnType<typeof setTimeout> | null = null;
  /** chat() 内部 AbortController（超时时中断 generator，防止并发） */
  private chatAbortController: AbortController | null = null;
  /** 记忆衰减定时器 */
  private decayTimer: ReturnType<typeof setInterval> | null = null;
  /** 最近一次 chat() 调用的时间戳 */
  private _lastInteractionAt: Date | null = null;

  // ─── R-103 衰减指标统计字段 ──────────────────────────
  // 累计值，从 Agent.init() 起累加，close() 后随实例销毁。

  /** 衰减执行次数（每次 runMemoryDecay 实际执行 +1） */
  private metricDecayRunCount: number = 0;
  /** 累计衰减记忆数（score 被调低的记忆条数总和） */
  private metricTotalDecayedCount: number = 0;
  /** 上次衰减时间（ISO 8601，null 表示从未执行过） */
  private metricLastDecayAt: string | null = null;

  constructor(opts: AgentOptions) {
    super();
    this.#config = {
      projectPath: opts.projectPath,
      dataDir: opts.dataDir ?? '~/.memora',
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
    };
    this.#provider = opts.provider;
    this.#backgroundProvider = opts.backgroundProvider ?? null;
    // 如需自定义日志，请在创建 Agent 前调用 `import { setLogger } from '@memora/core'` 全局设置
  }

  // ─── 生命周期 ─────────────────────────────────────────

  /**
   * 初始化 Agent：加载索引、组装内部组件
   */
  async init(projectPathOverride?: string): Promise<ProjectContext> {
    if (this._initialized) {
      await this.close();
    }

    if (projectPathOverride) {
      this.#config.projectPath = projectPathOverride;
    }

    this.projectManager = new ProjectManager({
      dataDir: this.#config.dataDir,
      storage: this.#config.storage,
      registryDir: this.#config.registryDir,
      // A-004: SecurityGuard 由 Agent 层创建，解除 memory→security 反向依赖
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

    const pctx = await this.projectManager.initProject(
      this.#config.projectPath,
      undefined,
      this.#config.configDir,
    );

    await this.assembleComponents(pctx);

    this.pctx = pctx;

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

    this._initialized = true;

    // 启动时记忆衰减（insight/archive 来源）
    this.runMemoryDecay();

    // 定期记忆衰减（每小时）
    this.decayTimer = safeSetInterval(() => this.runMemoryDecay(), AGENT_CONSTANTS.DECAY_INTERVAL_MS);

    return pctx;
  }

  /**
   * 流式对话（核心 API）
   */
  async *chat(input: string, signal?: AbortSignal): AsyncGenerator<AgentChunk, void, unknown> {
    this.assertInitialized('chat');

    if (input.length > AGENT_CONSTANTS.CHAT_INPUT_MAX_LENGTH) {
      throw configError(
        '输入过长',
        `输入超过最大长度限制（${AGENT_CONSTANTS.CHAT_INPUT_MAX_LENGTH / 1024}KB）`,
        ['缩短输入内容', '分多次对话发送'],
      );
    }

    if (this._chatBusy) {
      throw configError('对话繁忙', '上一轮对话尚未完成，请等待其结束后再发起新对话', [
        '等待上一轮 chat() 的 AsyncGenerator 耗尽（收到 done 事件）',
        '宿主程序应确保同一时间只有一个 chat() 调用',
      ]);
    }
    this._chatBusy = true;
    // SEC-02: 内部 AbortController，超时时中断 generator 而非仅释放锁
    const internalAbort = new AbortController();
    this.chatAbortController = internalAbort;
    // 合并外部 signal：外部 abort 时也触发内部
    const onExternalAbort = () => internalAbort.abort();
    signal?.addEventListener('abort', onExternalAbort, { once: true });
    const combinedSignal = internalAbort.signal;

    // 超时保护：LLM 卡死时中断 generator + 释放锁，防止并发
    this.chatLockTimer = safeSetTimeout(() => {
      logger.warn(
        { timeoutMs: AGENT_CONSTANTS.CHAT_LOCK_TIMEOUT_MS },
        'chat() 锁超时，中断 generator 并释放锁',
      );
      internalAbort.abort();
      this._chatBusy = false;
      this.chatLockTimer = null;
      this.chatAbortController = null;
    }, AGENT_CONSTANTS.CHAT_LOCK_TIMEOUT_MS);
    try {
      this._lastInteractionAt = new Date();

      // 清理上一轮注入的临时 system 消息（recentConversation/skill/recall/truncation）
      // 防止多轮累积：每轮 chat() 开始前，只保留 messages[0] 和非 system 消息
      this.requireNonNull(this.loop, 'loop').cleanTemporarySystemMessages();

      // 基元驱动召回（双通道：语义 + 关键词）
      yield { type: 'thinking', phase: 'recalling' };
      const recalledMemories = await this.recallAndInject(input);

      if (combinedSignal.aborted) {
        yield {
          type: 'aborted',
          reason: this.#config.messages?.abortedByUser ?? 'User cancelled the conversation',
        };
        return;
      }

      // 注入上一轮匹配的技能 prompt
      yield { type: 'thinking', phase: 'processing' };
      this.injectActiveSkill();

      await this.requireNonNull(this.history, 'history').appendUser(input);

      let assistantContent = '';
      let wasAborted = false;
      for await (const chunk of this.requireNonNull(this.loop, 'loop').processUserInput(
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

      if (wasAborted) {
        return;
      }

      // 追加助手消息到历史（best-effort：失败不影响用户已收到的回答）
      try {
        await this.requireNonNull(this.history, 'history').appendAssistant(assistantContent);
      } catch (err) {
        logger.warn({ err }, '助手消息历史写入失败');
      }

      // 后处理阶段
      yield { type: 'thinking', phase: 'archiving' };
      await this.postProcess(input, assistantContent);
    } finally {
      this._chatBusy = false;
      this.chatAbortController = null;
      if (this.chatLockTimer) {
        clearSafeTimeout(this.chatLockTimer);
        this.chatLockTimer = null;
      }
      signal?.removeEventListener('abort', onExternalAbort);
    }
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
    const recalledMemories = await recall(
      this.requireNonNull(this.pctx, 'projectContext').index,
      input,
      {
        limit: 5,
        vectorStore: this.#config.vectorStore,
        excludeSources: this.#config.recallExcludeSources,
      },
    );
    if (recalledMemories.length > 0) {
      this.emit('memoryRecalled', { count: recalledMemories.length, query: input });
    }

    // Layer 5: 最近对话注入
    const loop = this.requireNonNull(this.loop, 'loop');
    const recentHistory = loop.getRecentHistory(3);
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
   * 注入上一轮匹配的技能 prompt
   */
  private injectActiveSkill(): void {
    if (this.activeSkill && this.skillManager && this.loop) {
      const skillPrompt = this.skillManager.buildSystemPrompt(this.activeSkill);
      if (skillPrompt) {
        this.loop.injectSystemMessage(skillPrompt);
        logger.debug({ skill: this.activeSkill }, '技能 prompt 已注入');
      }
      this.activeSkill = null;
    }
  }

  /**
   * 对话后处理：用户画像归档、角色匹配、技能匹配、Insight 提取
   *
   * 所有归档/匹配操作均为 best-effort：任何子步骤失败不应影响用户已收到的回答，
   * 失败仅记录日志，不向上抛出异常。
   */
  private async postProcess(input: string, assistantContent: string): Promise<void> {
    // 用户画像实时归档（语义解析在 agent/ 层，存储在 memory/ 层）
    if (this.#userProfile) {
      try {
        const turnIndex = `turn-${Date.now()}`;
        const facts = extractUserFacts(input, turnIndex);
        // FD-22: 注册到 pendingArchives，确保 close() 时等待后台归档完成，避免写入已关闭的存储
        const archiveFactsPromise = this.#userProfile.archiveFacts(facts).catch((err) => {
          logger.warn({ err }, '用户画像实时归档失败');
        });
        this.requireNonNull(this.history, 'history').registerPendingArchive(archiveFactsPromise);
      } catch (err) {
        logger.warn({ err }, '用户画像归档初始化失败');
      }
    }

    // 角色自动匹配（best-effort：失败不阻塞对话结束）
    if (this.personaManager) {
      try {
        const matchedPersona = this.personaManager.autoMatch(input);
        if (matchedPersona) {
          const prevName = this.personaManager.activeName;
          this.personaManager.switchPersona(matchedPersona);
          this.emit('personaSwitched', { from: prevName, to: matchedPersona });
          if (this.loop) {
            const profilePrompt = this.userProfile?.buildSystemPrompt() ?? '';
            const personaPrompt = this.personaManager.buildSystemPrompt();
            const newPrefix =
              [personaPrompt, profilePrompt].filter(Boolean).join('\n\n') +
              ([personaPrompt, profilePrompt].some(Boolean) ? '\n\n---\n\n' : '');
            this.loop.refreshPersonaPrefix(newPrefix);
          }
          logger.info({ persona: matchedPersona }, '角色自动切换');
        }
      } catch (err) {
        logger.warn({ err }, '角色自动匹配失败');
      }
    }

    // 技能关键词匹配（best-effort：失败不阻塞对话结束）
    if (this.skillManager) {
      try {
        const match = this.skillManager.match(input);
        if (match) {
          this.activeSkill = match.skill.name;
          logger.debug({ skill: match.skill.name, score: match.score }, '技能匹配，下一轮注入');
        }
      } catch (err) {
        logger.warn({ err }, '技能匹配失败');
      }
    }

    // 输入分类 → Insight 提取（委托给 InsightExtractor）
    if (this.insightExtractor) {
      try {
        const shouldExtract = this.insightExtractor.classify(input);
        if (shouldExtract === 'extract') {
          const p = this.insightExtractor.extract(input, assistantContent).catch((err) => {
            logger.warn({ err }, 'Insight 提取失败');
            return null;
          });
          this.requireNonNull(this.history, 'history').registerPendingArchive(p);
        }
      } catch (err) {
        logger.warn({ err }, 'Insight 提取初始化失败');
      }
    }

    // V-201: AutoConfigRefiner（模式 3：Agent 智能总结）
    if (this.autoConfigRefiner) {
      try {
        // FD-22: 注册到 pendingArchives，确保 close() 时等待后台分析完成，避免写入已关闭的存储
        const analyzePromise = this.autoConfigRefiner.analyze(input, assistantContent).catch((err) => {
          logger.warn({ err }, 'AutoConfigRefiner 分析失败');
        });
        this.requireNonNull(this.history, 'history').registerPendingArchive(analyzePromise);
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
    return this.requireNonNull(this._sessionManager, 'sessionManager').forkSession(targetSession);
  }

  /**
   * 切换到指定项目
   *
   * 切换后自动 rebuildComponents()，无需手动调用。
   * Agent 级记忆（memora.db）保留，项目级配置（.memora/）重新加载。
   */
  async switchProject(nameOrPath: string): Promise<AgentContext> {
    this.assertInitialized('switchProject', ['projectManager', 'provider']);

    // FD-21: 对话进行中切换项目会导致 loop/history 引用被替换，工作记忆与持久化状态不一致
    if (this._chatBusy) {
      throw configError('对话繁忙', '上一轮对话尚未完成，请等待其结束后再切换项目', [
        '等待上一轮 chat() 的 AsyncGenerator 耗尽',
      ]);
    }

    const pm = this.requireNonNull(this.projectManager, 'projectManager');
    const projects = pm.list;
    let target = projects.find((p) => p.name === nameOrPath || p.path === nameOrPath);
    if (!target) {
      const nameOrPathLower = nameOrPath.toLowerCase();
      target = projects.find(
        (p) => p.name.toLowerCase() === nameOrPathLower || p.path.toLowerCase() === nameOrPathLower,
      );
    }
    const projectPath = target ? target.path : nameOrPath;
    const projectName = target ? target.name : basename(nameOrPath);

    const newPctx = await pm.initProject(projectPath, projectName, this.#config.configDir);

    // A-003: 记录源项目路径（用于事件），切换前 pctx 可能不存在（首次初始化）
    const fromProjectPath = this.pctx?.projectPath ?? null;

    this.pctx = newPctx;
    await this.rebuildComponentsWithCurrentCtx();

    // A-003: 发射项目切换事件（供宿主 UI 刷新项目相关界面）
    this.emit('projectSwitched', {
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
    this.autoConfigRefiner = result.autoConfigRefiner;
    this.workProjection = result.workProjection;
    // V-101：注入 VectorStore 到 MemoryInspector，启用混合搜索
    if (this.memoryInspector && this.#config.vectorStore) {
      this.memoryInspector.setVectorStore(this.#config.vectorStore);
    }
    // 创建会话管理器（通过回调访问当前组件，支持 rebuildComponents 后自动获取最新引用）
    // 事件转发桥接：SessionManager 使用宽类型 (string, Record<string,unknown>)，
    // Agent 内部桥接到 TypedEventEmitter 的强类型 emit
    // 运行时校验事件名是否在 AgentEventMap 中，避免不安全的类型断言
    const forwardEvent = (event: string, data: Record<string, unknown>) => {
      if (AGENT_EVENT_NAMES.has(event)) {
        this.emit(event as keyof AgentEventMap, data as AgentEventMap[keyof AgentEventMap]);
      }
    };
    this._sessionManager = new SessionManager(
      () => this.requireNonNull(this.history, 'history'),
      () => this.requireNonNull(this.loop, 'loop'),
      this.#config.sessionStore,
      () => this._chatBusy,
      forwardEvent,
    );
  }

  /**
   * 用当前 pctx 重建 history / loop
   */
  private async rebuildComponentsWithCurrentCtx(): Promise<void> {
    if (!this.pctx) return;
    await this.assembleComponents(this.pctx);
    // 重建会话管理器：assembleComponents 创建了新的 history/loop 实例
    // 事件转发桥接（同 assembleComponents 中的逻辑，含运行时校验）
    const forwardEvent = (event: string, data: Record<string, unknown>) => {
      if (AGENT_EVENT_NAMES.has(event)) {
        this.emit(event as keyof AgentEventMap, data as AgentEventMap[keyof AgentEventMap]);
      }
    };
    this._sessionManager = new SessionManager(
      () => this.requireNonNull(this.history, 'history'),
      () => this.requireNonNull(this.loop, 'loop'),
      this.#config.sessionStore,
      () => this._chatBusy,
      forwardEvent,
    );
  }

  // ─── Provider 管理 ────────────────────────────────────

  setProvider(provider: LlmProvider): void {
    this.#provider = provider;
    if (this.loop) {
      this.loop.setProvider(provider);
    }
    logger.info({ provider: this.#provider.name }, 'Provider 已切换');
  }

  setBackgroundProvider(provider: LlmProvider | null): void {
    this.#backgroundProvider = provider;
    // V-201: 同步更新 AutoConfigRefiner 的后台 Provider
    if (this.autoConfigRefiner) {
      this.autoConfigRefiner.setBackgroundProvider(provider);
    }
    logger.info({ hasBackground: !!provider }, '后台 Provider 已切换');
  }

  // ─── 组件访问 ─────────────────────────────────────────

  /**
   * 重建内部组件（history / loop / managers）
   *
   * 通常不需要手动调用——switchProject() 已自动执行 rebuild。
   * 仅在宿主项目需要强制刷新组件时使用（如热更新配置后）。
   */
  async rebuildComponents(): Promise<void> {
    // FD-21: 对话进行中重建组件会导致 loop/history 引用被替换，工作记忆与持久化状态不一致
    if (this._chatBusy) {
      throw configError('对话繁忙', '上一轮对话尚未完成，请等待其结束后再重建组件', [
        '等待上一轮 chat() 的 AsyncGenerator 耗尽',
      ]);
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
   * 非空断言守卫——对 null/undefined 值抛出清晰错误的运行时检查
   *
   * @param value 可能为 null/undefined 的值
   * @param name 组件名称（用于错误消息）
   * @throws MemoraError 如果 value 为 null/undefined
   */
  private requireNonNull<T>(value: T | null | undefined, name: string): T {
    if (value === null || value === undefined) {
      throw configError('Agent 未初始化', `${name} 组件不可用`, ['请先调用 await agent.init()']);
    }
    return value;
  }

  // ─── 记忆生命周期 ───────────────────────────────────────

  /**
   * 对 insight/profile/work-projection 记忆执行 score 衰减
   *
   * 长期未访问的记忆 score 逐渐降低，体现"自然遗忘"
   * 不影响 persona/rule/skill（这些是配置型记忆，不应衰减）
   *
   * 衰减逻辑委派给 IMemoryStorage.decayScores()，
   * 宿主（SqliteStorage）可用一条 SQL UPDATE 批量完成，避免 O(n) 全量加载。
   */
  private runMemoryDecay(): void {
    if (!this.pctx) return;
    // R-103 衰减 Span：记录衰减执行过程，补全衰减可观测性缺口
    const decaySpan = this.#config.tracer?.startSpan(TRACE_SPANS.DECAY) ?? NOOP_TRACER.startSpan(TRACE_SPANS.DECAY);
    try {
      const sources = [SOURCE_LABELS.INSIGHT, SOURCE_LABELS.PROFILE, SOURCE_LABELS.WORK_PROJECTION];
      const decayedCount = this.pctx.index.decayScores(sources, new Date());
      logger.debug({ decayedCount }, '记忆衰减完成');

      // R-103 衰减指标统计：累计执行次数和衰减记忆数
      this.metricDecayRunCount++;
      this.metricTotalDecayedCount += decayedCount;
      this.metricLastDecayAt = new Date().toISOString();
      decaySpan.setAttribute('decayedCount', decayedCount);
      decaySpan.setAttribute('totalRuns', this.metricDecayRunCount);

      this.emit('decayCompleted', { decayedCount });
    } catch (err) {
      logger.warn({ err }, '记忆衰减异常，跳过本轮');
      decaySpan.recordException(toError(err));
    } finally {
      decaySpan.end();
    }
  }

  // ─── 关闭 ─────────────────────────────────────────────

  /**
   * 关闭 Agent，释放 SQLite 连接等资源
   */
  async close(): Promise<void> {
    // 清理定时器
    if (this.decayTimer) {
      clearSafeInterval(this.decayTimer);
      this.decayTimer = null;
    }
    if (this.chatLockTimer) {
      clearSafeTimeout(this.chatLockTimer);
      this.chatLockTimer = null;
    }
    if (this.chatAbortController) {
      this.chatAbortController.abort();
      this.chatAbortController = null;
    }
    // P2-1 清理 PersonaManager 的角色切换防抖锁计时器，防止关闭后回调触发
    if (this.personaManager) {
      this.personaManager.close();
    }
    this.removeAllListeners();

    if (this.history) {
      await this.history.awaitPendingArchives(5000);
    }

    if (this.projectManager) {
      await this.projectManager.shutdown();
    }
    this._initialized = false;
    this.#backgroundProvider = null;
    this._chatBusy = false;
    this.history = null;
    this.loop = null;
    this._sessionManager = null;
    this.projectManager = null;
    this.insightExtractor = null;
    this.configManager = null;
    this.memoryInspector = null;
    this.autoConfigRefiner = null;
    this.pctx = null;
  }

  // ─── 只读访问器 ───────────────────────────────────────

  get initialized(): boolean {
    return this._initialized;
  }

  get context(): AgentContext | null {
    return this.pctx;
  }

  get agentLoop(): AgentLoop | null {
    return this.loop;
  }

  get agentHistory(): MessageHistory | null {
    return this.history;
  }

  get provider(): LlmProvider {
    return this.#provider;
  }

  get isBusy(): boolean {
    return this._chatBusy;
  }

  get lastInteractionAt(): Date | null {
    return this._lastInteractionAt;
  }

  // ─── R-103 运行时指标 ────────────────────────────────

  /**
   * 获取 Agent 运行时指标快照（R-103 可观测性增强）
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
    // 未初始化时返回全零指标，避免调用方需要判空
    if (!this.loop) {
      return {
        llm: { callCount: 0, totalInputTokens: 0, totalOutputTokens: 0 },
        recall: { totalCount: 0, hitCount: 0, hitRate: 0 },
        tools: { callCount: 0, failureCount: 0 },
        context: { truncationCount: 0, messageCount: 0, estimatedTokens: 0 },
        decay: {
          runCount: this.metricDecayRunCount,
          totalDecayedCount: this.metricTotalDecayedCount,
          lastRunAt: this.metricLastDecayAt,
        },
      };
    }

    // 获取 AgentLoop 指标快照，填充衰减字段
    const loopMetrics = this.loop.getMetrics();
    return {
      ...loopMetrics,
      decay: {
        runCount: this.metricDecayRunCount,
        totalDecayedCount: this.metricTotalDecayedCount,
        lastRunAt: this.metricLastDecayAt,
      },
    };
  }

  // ─── Manager 暴露（激进拆分：调用方直接操作 Manager）──
  //
  // 设计策略（ADR-010 §Manager 访问器）：访问器返回 null，门面方法抛错。
  // - 访问器（getter）：返回 Manager | null，供宿主项目链式调用和优雅降级
  //   （如 `agent.persona?.activeName`、`if (!agent.memory) return []`）
  // - 门面方法（snapshot/inspect/stats/searchMemories 等）：通过
  //   assertInitialized + requireNonNull 抛 MemoraError，提供明确错误信息
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

  /** 记忆存储（宿主可直接调用 CRUD，如 delete/upsert） */
  get storage(): IMemoryStorage | null {
    return this.#config.storage ?? null;
  }
}
