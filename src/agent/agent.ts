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
import type { AgentChunk, UIMessages, ArchiveMode } from '@/agent/types.js';
import type { ToolExecutor } from '@/agent/toolExecutor.js';
import type { MessageHistory } from '@/agent/messageHistory.js';
import { ProjectManager, type ProjectContext } from '@/memory/projectManager.js';
import { SecurityGuard } from '@/security/pathGuard.js';
import type { AutoConfigRefiner } from '@/agent/managers/autoConfigRefiner.js';
import { recall } from '@/memory/recall.js';
import type { PersonaManager } from '@/persona/personaManager.js';
import type { UserProfile, UserProfileEntry } from '@/memory/userProfile.js';
import type { SkillManager } from '@/skill/skillManager.js';
import type { InsightExtractor } from '@/agent/managers/insightExtractor.js';
import type { SessionArchiver, SessionArchiveResult } from '@/agent/managers/sessionArchiver.js';
import type { ConfigManager } from '@/agent/managers/configManager.js';
import type { WorkProjectionManager } from '@/agent/managers/workProjection.js';
import type { MemoryInspector } from '@/agent/managers/memoryInspector.js';
import type { MemoryMutator } from '@/agent/managers/memoryMutator.js';
import { extractUserFacts } from '@/agent/userFactExtractor.js';
import { assembleComponents } from '@/agent/assembler.js';
import { configError } from '@/utils/errors.js';
import { safeSetTimeout, clearSafeTimeout, clearSafeInterval } from '@/utils/safeTimer.js';
import { SessionManager, type AgentForkResult } from '@/agent/managers/sessionManager.js';
import { MemoryDecayScheduler } from '@/agent/managers/memoryDecayScheduler.js';
import { ArchiveCoordinator } from '@/agent/managers/archiveCoordinator.js';
import { TypedEventEmitter, type AgentEventMap } from '@/utils/eventEmitter.js';
import type { LlmProvider } from '@/llm/provider.js';
import type { Memory } from '@/memory/types.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import type { IMemoryRelationStore } from '@/memory/relationStore.js';
import type { ISessionStore } from '@/memory/sessionStore.js';
import type { IVectorStore } from '@/memory/vectorStore.js';
import { logger } from '@/logging/logger.js';
import type { ITracer, AgentMetrics } from '@/agent/tracer.js';
import { TRACE_SPANS, NOOP_TRACER } from '@/agent/tracer.js';

// ─── 模块级常量 ─────────────────────────────────────────

/** Agent 事件名白名单，用于运行时校验 SessionManager 转发的事件类型 */
// 必须与 utils/eventEmitter.ts 的 AgentEventMap 键集保持一致（9 个事件）
const AGENT_EVENT_NAMES: ReadonlySet<string> = new Set([
  'memoryAdded', 'personaSwitched', 'decayCompleted',
  'memoryRecalled', 'sessionForked', 'insightExtracted',
  'conflictDetected', 'projectSwitched', 'skillMatched',
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
  /** 向量存储（可选，提供时启用语义搜索召回；宿主可注入任意 IVectorStore 实现） */
  vectorStore?: IVectorStore;
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
  /** 上下文超限时是否自动生成摘要（默认 true，开启后首次截断时增加 ~1-2s 延迟） */
  enableContextSummary?: boolean;
  /**
   * 归档模式（ADR-015，默认 'full'）
   *
   * - 'full'：profile facts + insight 自动归档（对话原始内容待会话归档实现后自动）
   * - 'insights-only'：profile facts + insight 自动归档，对话原始内容需手动
   * - 'manual'：所有归档都需手动触发
   */
  archiveMode?: ArchiveMode;
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
  vectorStore: IVectorStore | undefined;
  recallExcludeSources: string[];
  storage: IMemoryStorage | undefined;
  relationStore: IMemoryRelationStore | undefined;
  sessionStore: ISessionStore | undefined;
  projectPath: string;
  configDir: string | undefined;
  tracer: ITracer | undefined;
  messages: UIMessages | undefined;
  enableContextSummary: boolean;
  /** 归档模式（ADR-015，默认 'full'） */
  archiveMode: ArchiveMode;
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
  /** 记忆写入器（P1-2 拆分，与 MemoryInspector 严格分工：写操作代理；ES 私有字段避免与 getter 重名递归） */
  #memoryMutator: MemoryMutator | null = null;
  private workProjection: WorkProjectionManager | null = null;
  /** AutoConfigRefiner（模式 3：Agent 智能总结） */
  private autoConfigRefiner: AutoConfigRefiner | null = null;
  /** SessionArchiver（会话内容归档器，content 类记忆） */
  private sessionArchiver: SessionArchiver | null = null;
  /** 会话管理器（从 Agent 拆分出的会话管理职责） */
  private _sessionManager: SessionManager | null = null;

  /** 当前激活的技能名（上一轮匹配，本轮注入） */
  private activeSkill: string | null = null;

  private _initialized = false;
  // 项目上下文（AgentContext 与 ProjectContext 等价，直接使用后者避免重复字段）
  private pctx: ProjectContext | null = null;

  /** chat() 并发锁 */
  private _chatBusy = false;
  /**
   * chat() 锁持有者 token（race condition 防护）
   *
   * 设计目的：
   *   原锁是简单布尔值 `_chatBusy`，无 owner 校验。超时回调与 finally 块无差别清理，
   *   导致 race condition：T=0 A 获取锁 → T=180s 超时释放 → T=181s B 获取锁
   *   → T=182s A 的 finally 误清 B 的锁/计时器/controller。
   *
   * 防护方案：
   *   - 获取锁时 token 递增：`const myToken = ++this._chatLockToken`
   *   - 超时回调校验 `this._chatLockToken === myToken` 后才释放
   *   - finally 块校验 `this._chatLockToken === myToken` 后才清理
   *   - 不匹配时跳过清理，避免误清新调用者的资源
   *
   * 选择 number 而非 Symbol：递增计数器可序列化、零依赖、足够唯一（同一 Agent 实例内）
   */
  private _chatLockToken: number = 0;
  /** 聊天锁超时计时器（防止 LLM 卡死时锁永久持有） */
  private chatLockTimer: ReturnType<typeof setTimeout> | null = null;
  /** chat() 内部 AbortController（超时时中断 generator，防止并发） */
  private chatAbortController: AbortController | null = null;
  /** 记忆衰减定时器（已迁移至 MemoryDecayScheduler，此字段保留用于 close 时引用判断） */
  private decayTimer: ReturnType<typeof setInterval> | null = null;
  /** 最近一次 chat() 调用的时间戳 */
  private _lastInteractionAt: Date | null = null;

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
      archiveMode: opts.archiveMode ?? 'full',
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
      // close() 失败不应阻塞 init() 重建
      // 原 close() 异常（如 awaitPendingArchives 超时）会传播到 init() 调用方，
      // 导致 Agent 处于不可用状态。此处捕获后继续重建。
      try {
        await this.close();
      } catch (err) {
        logger.warn({ err }, 'init() 中 close() 旧实例失败，继续重建');
      }
    }

    if (projectPathOverride) {
      this.#config.projectPath = projectPathOverride;
    }

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

    // 归档操作委托给 ArchiveCoordinator
    // 使用 getter 回调注入依赖，close 时 null 化字段后 getter 自然返回 null
    this.archiveCoordinator = new ArchiveCoordinator({
      getUserProfile: () => this.#userProfile,
      getInsightExtractor: () => this.insightExtractor,
      getSessionArchiver: () => this.sessionArchiver,
      emit: (event, payload) => this.emit(event, payload as never),
    });

    // 记忆衰减职责委托给 MemoryDecayScheduler
    this.memoryDecayScheduler = new MemoryDecayScheduler({
      tracer: this.#config.tracer,
      onDecayCompleted: (payload) => this.emit('decayCompleted', payload),
    });
    this.memoryDecayScheduler.start(pctx.index, AGENT_CONSTANTS.DECAY_INTERVAL_MS);
    // 保留 decayTimer 引用用于 close 时序兼容（实际定时器由 MemoryDecayScheduler 管理）
    this.decayTimer = null;

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
    // 分配本调用的 token，超时回调和 finally 块据此判断是否仍是当前持有者
    // 避免 race condition：超时释放后新调用获取锁，旧 finally 误清新调用者的资源
    const myToken = ++this._chatLockToken;
    // 内部 AbortController，超时时中断 generator 而非仅释放锁
    const internalAbort = new AbortController();
    this.chatAbortController = internalAbort;
    // 合并外部 signal：外部 abort 时也触发内部
    const onExternalAbort = () => internalAbort.abort();
    signal?.addEventListener('abort', onExternalAbort, { once: true });
    // addEventListener 对已 aborted 的 signal 不触发回调
    // 需手动检查并触发 internalAbort，否则外部已取消的请求仍会进入主流程
    if (signal?.aborted) {
      internalAbort.abort();
    }
    const combinedSignal = internalAbort.signal;

    // 超时保护：LLM 卡死时中断 generator + 释放锁，防止并发
    // 超时回调校验 token 后才清理，避免误清新调用者的资源
    this.chatLockTimer = safeSetTimeout(() => {
      // 令牌不匹配：锁已被新调用者获取（或本调用已正常退出），跳过清理
      if (this._chatLockToken !== myToken) {
        return;
      }
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
      // 把 provider 异常转为 yield error chunk，让宿主能优雅展示并清理 UI
      // （裸 throw 会导致未处理 rejection，UI 收不到错误展示机会）
      try {
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
      } catch (err) {
        // aborted 已由 loop.ts 内部 yield chunk 处理，此处只捕获真正的异常
        // （如 LLM 超时、连接断开、AbortError 未被 loop 拦截等）
        // 转为 error chunk 通知宿主，避免裸 throw 导致 UI 卡死
        if (err instanceof DOMException && err.name === 'AbortError') {
          // 必须 yield aborted chunk 让宿主能展示中断标记
          // （仅设置 wasAborted 会导致 chatHandlers catch 不触发，渲染层收不到 ABORTED）
          yield { type: 'aborted', reason: 'User cancelled the conversation' };
          return;
        } else {
          yield { type: 'error', message: err instanceof Error ? err.message : String(err) };
          return;
        }
      }

      if (wasAborted) {
        // 流式中断时仍保留已生成的部分文本到历史，避免下一轮上下文丢失
        // 追加 interrupted 标记让下一轮 LLM 和历史归档能识别这是中断响应（非完整回复）
        // 与下方正常路径一致采用 best-effort 写入（失败不影响中断流程）
        if (assistantContent.trim()) {
          const interruptedMark = this.#config.messages?.interrupted ?? '\n\n[已中断]';
          try {
            await this.requireNonNull(this.history, 'history').appendAssistant(
              assistantContent + interruptedMark,
            );
          } catch (err) {
            logger.warn({ err }, '中断消息历史写入失败');
          }
        }
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
      // 仅当本调用仍是当前锁持有者时才清理资源
      // 若 token 已变（超时释放后被新调用者获取），跳过清理避免误清新调用者的状态
      if (this._chatLockToken === myToken) {
        this._chatBusy = false;
        this.chatAbortController = null;
        if (this.chatLockTimer) {
          clearSafeTimeout(this.chatLockTimer);
          this.chatLockTimer = null;
        }
      }
      signal?.removeEventListener('abort', onExternalAbort);
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
   * 安全机制：
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
    if (!this._chatBusy) return;
    // 递增 token 让原 chat() 的 finally 块跳过清理（避免误清新调用者的资源）
    this._chatLockToken++;
    // abort 当前 generator（响应 signal 的 await 点会 throw AbortError 退出）
    if (this.chatAbortController) {
      this.chatAbortController.abort();
      this.chatAbortController = null;
    }
    // 清理锁超时定时器（避免后续触发重复清理）
    if (this.chatLockTimer) {
      clearSafeTimeout(this.chatLockTimer);
      this.chatLockTimer = null;
    }
    this._chatBusy = false;
    logger.warn('对话锁被强制释放（宿主无进展超时兜底）');
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
        this.requireNonNull(this.pctx, 'projectContext').index,
        input,
        {
          limit: 5,
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
      await this.postProcessInner(input, assistantContent);
    } finally {
      span.end();
    }
  }

  /**
   * postProcess 内部实现（为 span 埋点提供 try/finally 包裹边界）
   *
   * 原 postProcess 逻辑完整保留于此，由外层 postProcess 负责 span 生命周期管理。
   */
  private async postProcessInner(input: string, assistantContent: string): Promise<void> {
    // 角色自动匹配（best-effort：失败不阻塞对话结束，非归档行为不受 archiveMode 影响）
    if (this.personaManager) {
      try {
        const matchedPersona = await this.personaManager.autoMatch(input);
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

    // 技能关键词匹配（best-effort：失败不阻塞对话结束，非归档行为不受 archiveMode 影响）
    if (this.skillManager) {
      try {
        const match = this.skillManager.match(input);
        if (match) {
          this.activeSkill = match.skill.name;
          // 发射 skillMatched 事件：宿主 UI 可据此展示当前激活技能
          this.emit('skillMatched', { skill: match.skill.name, score: match.score });
          logger.debug({ skill: match.skill.name, score: match.score }, '技能匹配，下一轮注入');
        }
      } catch (err) {
        logger.warn({ err }, '技能匹配失败');
      }
    }

    // ADR-015: manual 模式跳过所有自动归档（profile + insight），
    // 需用户手动调用 archiveProfileFacts/archiveInsight 触发。
    // 角色匹配/技能匹配/AutoConfigRefiner 属"配置学习"行为，非归档，每轮都执行。
    const skipAutoArchive = this.#config.archiveMode === 'manual';
    if (skipAutoArchive) {
      logger.debug({ mode: 'manual' }, '归档模式为 manual，跳过自动归档');
    }

    // 用户画像实时归档（语义解析在 agent/ 层，存储在 memory/ 层）
    // ADR-015: full / insights-only 模式下 profile facts 自动归档
    if (!skipAutoArchive && this.#userProfile) {
      try {
        const turnIndex = `turn-${Date.now()}`;
        const facts = extractUserFacts(input, turnIndex);
        // 注册到 pendingArchives，确保 close() 时等待后台归档完成，避免写入已关闭的存储
        const archiveFactsPromise = this.#userProfile.archiveFacts(facts).then((entries) => {
          // 发射 memoryAdded 事件：仅对已确认且写入存储的条目（confirmed=true）
          for (const entry of entries) {
            if (entry.confirmed) {
              this.emit('memoryAdded', { id: entry.id, source: 'profile', name: entry.value });
            }
          }
        }).catch((err) => {
          logger.warn({ err }, '用户画像实时归档失败');
        });
        this.requireNonNull(this.history, 'history').registerPendingArchive(archiveFactsPromise);
      } catch (err) {
        logger.warn({ err }, '用户画像归档初始化失败');
      }
    }

    // 输入分类 → Insight 提取（委托给 InsightExtractor）
    // ADR-015: full / insights-only 模式下 insight 自动归档
    if (!skipAutoArchive && this.insightExtractor) {
      try {
        const shouldExtract = this.insightExtractor.classify(input);
        if (shouldExtract === 'extract') {
          const p = this.insightExtractor.extract(input, assistantContent).then((memories) => {
            // 发射 memoryAdded + insightExtracted 事件：每条写入/更新的 insight 均通知宿主
            for (const memory of memories) {
              this.emit('memoryAdded', { id: memory.id, source: memory.source, name: memory.name });
              this.emit('insightExtracted', { source: memory.source, insight: memory.content });
            }
          }).catch((err) => {
            logger.warn({ err }, 'Insight 提取失败');
          });
          this.requireNonNull(this.history, 'history').registerPendingArchive(p);
        }
      } catch (err) {
        logger.warn({ err }, 'Insight 提取初始化失败');
      }
    }

    // AutoConfigRefiner（模式 3：Agent 智能总结）
    if (this.autoConfigRefiner) {
      try {
        // 注册到 pendingArchives，确保 close() 时等待后台分析完成，避免写入已关闭的存储
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

    // 对话进行中切换项目会导致 loop/history 引用被替换，工作记忆与持久化状态不一致
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

    // 记录源项目路径（用于事件），切换前 pctx 可能不存在（首次初始化）
    const fromProjectPath = this.pctx?.projectPath ?? null;

    this.pctx = newPctx;
    await this.rebuildComponentsWithCurrentCtx();

    // 发射项目切换事件（供宿主 UI 刷新项目相关界面）
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
    this.#memoryMutator = result.memoryMutator;
    this.autoConfigRefiner = result.autoConfigRefiner;
    this.workProjection = result.workProjection;
    this.sessionArchiver = result.sessionArchiver;
    // 绑定冲突检测回调，InsightExtractor 检测到 contradicts 时 emit('conflictDetected')
    // 与 bindGetRecentHistory 同模式：解决 Agent 晚于 InsightExtractor 创建的时序循环依赖
    this.insightExtractor.bindOnConflict((info) => {
      this.emit('conflictDetected', info);
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
      if (AGENT_EVENT_NAMES.has(event)) {
        this.emit(event as keyof AgentEventMap, data as AgentEventMap[keyof AgentEventMap]);
      }
    };
    return new SessionManager(
      () => this.requireNonNull(this.history, 'history'),
      () => this.requireNonNull(this.loop, 'loop'),
      this.#config.sessionStore,
      () => this._chatBusy,
      forwardEvent,
    );
  }

  // ─── Provider 管理 ────────────────────────────────────

  setProvider(provider: LlmProvider): void {
    // 对话进行中切换 Provider 会导致同一 processUserInput 循环内前后两次 LLM 调用命中不同 Provider
    // （模型上下文窗口假设不一致 → 可能导致上下文截断逻辑误判或 tool_call 格式不兼容）
    if (this._chatBusy) {
      throw configError('对话繁忙', '上一轮对话尚未完成，请等待其结束后再切换 Provider', [
        '等待上一轮 chat() 的 AsyncGenerator 耗尽',
      ]);
    }
    this.#provider = provider;
    if (this.loop) {
      this.loop.setProvider(provider);
    }
    logger.info({ provider: this.#provider.name }, 'Provider 已切换');
  }

  setBackgroundProvider(provider: LlmProvider | null): void {
    // 与 setProvider 一致，对话进行中禁止切换后台 Provider
    if (this._chatBusy) {
      throw configError('对话繁忙', '上一轮对话尚未完成，请等待其结束后再切换后台 Provider', [
        '等待上一轮 chat() 的 AsyncGenerator 耗尽',
      ]);
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
    if (this._chatBusy) {
      throw configError('对话繁忙', '上一轮对话尚未完成，请等待其结束后再切换归档模式', [
        '等待上一轮 chat() 的 AsyncGenerator 耗尽',
      ]);
    }
    const prev = this.#config.archiveMode;
    if (prev === mode) return; // 幂等：无变更直接返回
    this.#config.archiveMode = mode;
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
   * 手动触发 profile facts 归档（manual 模式下使用）
   *
   * manual 模式下 postProcess 跳过自动归档，用户需通过此 API 主动归档。
   * full / insights-only 模式下也可调用（会重复归档，但不推荐）。
   *
   * 归档逻辑已委托给 ArchiveCoordinator
   *
   * @param input 本轮用户输入
   * @returns 写入/更新的 UserProfileEntry 列表
   */
  async archiveProfileFacts(input: string): Promise<UserProfileEntry[]> {
    this.assertInitialized('archiveProfileFacts');
    return this.archiveCoordinator!.archiveProfileFacts(input);
  }

  /**
   * 手动触发 insight 提取（manual 模式下使用）
   *
   * manual 模式下 postProcess 跳过自动归档，用户需通过此 API 主动归档。
   * 内部仍走 classify 判断（避免无价值输入浪费 LLM 调用）。
   *
   * 归档逻辑已委托给 ArchiveCoordinator
   *
   * @param input 本轮用户输入
   * @param assistantContent 本轮助手回复内容
   * @returns 写入/更新的 Memory 列表
   */
  async archiveInsight(input: string, assistantContent: string): Promise<Memory[]> {
    this.assertInitialized('archiveInsight');
    return this.archiveCoordinator!.archiveInsight(input, assistantContent);
  }

  /**
   * 手动归档会话内容（content 类记忆）
   *
   * 适用于 `insights-only` / `manual` 模式下用户手动触发会话内容归档。
   * `full` 模式下由宿主在会话切换前自动调用，无需用户干预。
   *
   * 归档逻辑已委托给 ArchiveCoordinator
   *
   * @param date 会话日期 YYYY-MM-DD
   * @param session 会话标识（不含日期前缀）
   * @returns 归档结果（memories 可能为空，表示无归档价值或 LLM 失败）
   */
  async archiveSessionContent(date: string, session: string): Promise<SessionArchiveResult> {
    this.assertInitialized('archiveSessionContent');
    return this.archiveCoordinator!.archiveSessionContent(date, session);
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
   * - 'rule' → 无操作（rule 类型已由 ConfigManager.addRule() 即时注入 system prompt）
   * - 'guardrail' → 抛错（guardrail 是 AgentLoop 的 readonly 数组，需 rebuildComponents 才能重载）
   * - undefined → 重载 skill + persona（全量重载，不含 guardrail）
   *
   * @param source 配置类型，缺省时重载全部可热更新的配置
   * @returns 重载结果统计
   */
  async reloadConfig(source?: string): Promise<{ skill: number; persona: number }> {
    this.assertInitialized('reloadConfig');
    if (this._chatBusy) {
      throw configError('对话繁忙', '上一轮对话尚未完成，请等待其结束后再重载配置', [
        '等待上一轮 chat() 的 AsyncGenerator 耗尽',
      ]);
    }

    // guardrail 需重建 AgentLoop，不属于热重载范畴
    if (source === 'guardrail') {
      throw configError(
        'guardrail 不支持热重载',
        'guardrail 规则是 AgentLoop 的 readonly 数组，需调用 rebuildComponents() 重建',
        ['使用 rebuildComponents() 重建组件（代价较高）'],
      );
    }

    // rule 类型已由 ConfigManager.addRule() 即时注入，无需重载
    if (source === 'rule') {
      logger.info('rule 类型已由 addRule() 即时注入，reloadConfig 跳过');
      return { skill: 0, persona: 0 };
    }

    const result = { skill: 0, persona: 0 };

    // 按需重载：source 缺省时全量重载，否则只重载指定类型
    const shouldReloadSkill = !source || source === 'skill';
    const shouldReloadPersona = !source || source === 'persona';

    if (shouldReloadSkill && this.skillManager) {
      result.skill = await this.skillManager.reload();
    }

    if (shouldReloadPersona && this.personaManager) {
      result.persona = await this.personaManager.reload();
      // 角色重载后，刷新 AgentLoop 的角色前缀（使新角色内容立即注入 system prompt）
      if (this.loop) {
        const newPrefix = this.personaManager.buildSystemPrompt();
        this.loop.refreshPersonaPrefix(newPrefix);
      }
    }

    logger.info({ source, ...result }, '配置已热重载');
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

  // ─── runMemoryDecay 已迁移至 MemoryDecayScheduler.runOnce ─────

  // ─── 关闭 ─────────────────────────────────────────────

  /**
   * 关闭 Agent，释放 SQLite 连接等资源
   */
  async close(): Promise<void> {
    // 递增 token，使任何进行中的 chat() generator 的 finally 块
    // 检测到 token 变化后跳过资源清理（close 已接管清理职责）
    this._chatLockToken++;
    // 清理 MemoryDecayScheduler（含定时器和 storage 引用）
    if (this.memoryDecayScheduler) {
      this.memoryDecayScheduler.stop();
      this.memoryDecayScheduler = null;
    }
    // 清理 ArchiveCoordinator（无定时器，只需释放引用）
    this.archiveCoordinator = null;
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
    // 清理 PersonaManager 的角色切换防抖锁计时器，防止关闭后回调触发
    if (this.personaManager) {
      this.personaManager.close();
    }
    this.removeAllListeners();

    if (this.history) {
      await this.history.awaitPendingArchives(AGENT_CONSTANTS.SHUTDOWN_ARCHIVE_TIMEOUT_MS);
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
    this.#memoryMutator = null;
    this.autoConfigRefiner = null;
    this.sessionArchiver = null;
    this.pctx = null;
    // 补全剩余 manager 字段 null 化，与上述字段处理方式一致
    // （原实现仅 null 化部分 manager，toolExec/personaManager/#userProfile/skillManager/workProjection 遗漏）
    this.toolExec = null;
    this.personaManager = null;
    this.#userProfile = null;
    this.skillManager = null;
    this.workProjection = null;
    // 清理次要状态字段，防止 re-init 后残留上一会话状态
    this.activeSkill = null;
    this._lastInteractionAt = null;
    // 衰减指标已迁移至 MemoryDecayScheduler，close 时通过 stop() 销毁实例
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

  /**
   * 注入情感基调到 system prompt（Phase 2.1：AffectController）
   *
   * 委托至 AgentLoop.injectAffect()，在角色前缀和 bootstrap 记忆之间插入情感描述。
   * 与角色切换独立——切换角色不会清除情感注入。
   *
   * @param affectString 情感描述文本，传空字符串清除注入
   */
  injectAffect(affectString: string): void {
    this.loop?.injectAffect(affectString);
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
   * 记忆写入器（可能为 null）—— upsert / delete / restore / purge / purgeExpired /
   * addRelation / removeRelation
   *
   * P1-2 拆分：从 MemoryInspector 拆出写操作代理，与 MemoryInspector 严格分工。
   * 返回 null 时表示 Agent 未初始化或存储层未就绪。
   * 宿主项目常用模式：`const m = agent.memoryMutator; if (!m) return; m.upsert(...)`
   */
  get memoryMutator(): MemoryMutator | null {
    return this.#memoryMutator;
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

  // storage getter 已删除（@deprecated 已确认宿主全部迁移到 agent.memory）
  // 扫描确认：hosts/memora-sprite 无 agent.storage 调用
  // MemoryInspector 提供等价 CRUD 能力且符合分层规范
}
