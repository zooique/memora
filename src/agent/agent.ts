/**
 * Agent 门面类 — Memora 宿主项目接入入口
 *
 * 设计文档（01-主架构-v4.0.md §9）要求宿主项目通过 `import { Agent } from '@memora/core'`
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
 * 基元驱动记忆模型（2026-06-11 重构）：
 *   - MemoryType/Permanence 枚举 → source 开放字符串
 *   - 会话漂移检测 → recall() 简化关键词搜索
 *   - ArchiveManager → 移除
 *
 * 2026-06-12 God Object 拆分：
 *   - Insight 提取 → InsightExtractor
 *   - 配置管理 → ConfigManager
 *   - 记忆查看 → MemoryInspector
 *   - 薄包装方法移除，调用方改为 agent.<manager>.xxx()
 */
import { basename } from 'node:path';
import { AgentLoop } from './loop.js';
import type { AgentChunk } from './types.js';
import { ToolExecutor } from './toolExecutor.js';
import { MessageHistory, type SessionRecord } from './messageHistory.js';
import { ProjectManager, type ProjectContext } from '@/memory/projectManager.js';
import { recall, decayScores } from '@/memory/recall.js';
import { PersonaManager } from '@/persona/personaManager.js';
import { UserProfile } from '@/memory/userProfile.js';
import { WorkProjectionManager } from './workProjection.js';
import { SkillManager } from '@/skill/skillManager.js';
import { InsightExtractor } from './insightExtractor.js';
import { ConfigManager } from './configManager.js';
import { MemoryInspector } from './memoryInspector.js';
import { configError } from '@/utils/errors.js';
import { TypedEventEmitter, type AgentEventMap } from '@/utils/eventEmitter.js';
import type { LlmProvider, Message } from '@/llm/provider.js';
import type { Memory } from '@/memory/types.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import type { ISessionStore } from '@/memory/sessionStore.js';
import type { ILogger } from '@/logging/loggerInterface.js';
import type { VectorStore } from '@/memory/vectorStore.js';
import { SOURCE_LABELS } from '@/memory/types.js';
import { logger, setLogger } from '@/logging/logger.js';
import type { SecurityGuard } from '@/security/pathGuard.js';

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
  /** 召回时排除的 source 标签（默认 ['persona', 'rule']，这些已由 bootstrap 注入） */
  recallExcludeSources?: string[];
  /** 外部注入的存储实例（可选，不传则内部创建 InMemoryStorage） */
  storage?: IMemoryStorage;
  /** 外部注入的会话存储（可选，不传则仅在内存中保存） */
  sessionStore?: ISessionStore;
  /** 外部注入的日志实现（可选，不传则使用默认 PinoLogger） */
  logger?: ILogger;
}

/** Agent 初始化后暴露的运行时上下文 */
export type AgentContext = ProjectContext;

/** Agent 项目条目（来自 ProjectManager 注册表） */
export interface AgentProjectEntry {
  name: string;
  path: string;
  lastOpened: string;
}

/**
 * Agent 内部组件快照（供宿主项目重建 history/loop 等 CLI 可见对象）
 */
export interface AgentBuildCtx {
  security: SecurityGuard;
  index: IMemoryStorage;
  bootstrapMemories: Memory[];
}

// ─── Agent 门面类 ───────────────────────────────────────

export class Agent extends TypedEventEmitter<AgentEventMap> {
  // 构造参数
  private _provider: LlmProvider;
  private _backgroundProvider: LlmProvider | null;
  private _dataDir: string;
  private _registryDir: string | undefined;
  private _maxContextTokens: number;
  private _personaName: string | undefined;
  private _permission: 'owner' | 'guest';
  private _allowedPaths: string[];
  private _confirmWrites: boolean;
  private _vectorStore: VectorStore | undefined;
  private _recallExcludeSources: string[];
  private _storage: IMemoryStorage | undefined;
  private _sessionStore: ISessionStore | undefined;
  private projectPath: string;
  private configDir: string | undefined;

  // 运行时组件（init 后填充）
  private projectManager: ProjectManager | null = null;
  private history: MessageHistory | null = null;
  private loop: AgentLoop | null = null;
  private toolExec: ToolExecutor | null = null;

  // v4.0 新模块
  private personaManager: PersonaManager | null = null;
  private userProfile: UserProfile | null = null;
  private workProjection: WorkProjectionManager | null = null;
  private skillManager: SkillManager | null = null;

  // v4.0 拆分出的专职 Manager
  private insightExtractor: InsightExtractor | null = null;
  private configManager: ConfigManager | null = null;
  private memoryInspector: MemoryInspector | null = null;

  /** 当前激活的技能名（上一轮匹配，本轮注入） */
  private activeSkill: string | null = null;

  // 上下文
  private _ctx: AgentContext | null = null;
  private _initialized = false;
  private _pctx: ProjectContext | null = null;

  /** chat() 并发锁 */
  private _chatBusy = false;
  /** 聊天锁超时计时器（防止 LLM 卡死时锁永久持有） */
  private _chatLockTimer: ReturnType<typeof setTimeout> | null = null;
  /** 聊天锁超时时间（5 分钟） */
  private static readonly CHAT_LOCK_TIMEOUT_MS = 300_000;
  /** 记忆衰减定时器 */
  private _decayTimer: ReturnType<typeof setInterval> | null = null;
  /** 记忆衰减间隔（1 小时） */
  private static readonly DECAY_INTERVAL_MS = 3_600_000;
  /** 最近一次 chat() 调用的时间戳 */
  private _lastInteractionAt: Date | null = null;

  constructor(opts: AgentOptions) {
    super();
    this.projectPath = opts.projectPath;
    this._provider = opts.provider;
    this._backgroundProvider = opts.backgroundProvider ?? null;
    this.configDir = opts.configDir;
    this._dataDir = opts.dataDir ?? '~/.memora';
    this._registryDir = opts.registryDir;
    this._maxContextTokens = opts.maxContextTokens ?? 120000;
    this._personaName = opts.persona;
    this._permission = opts.permission ?? 'owner';
    this._allowedPaths = opts.allowedPaths ?? [];
    this._confirmWrites = opts.confirmWrites ?? false;
    this._vectorStore = opts.vectorStore;
    this._recallExcludeSources = opts.recallExcludeSources ?? ['persona', 'rule', 'skill'];
    this._storage = opts.storage;
    this._sessionStore = opts.sessionStore;
    if (opts.logger) {
      setLogger(opts.logger);
    }
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
      this.projectPath = projectPathOverride;
    }

    this.projectManager = new ProjectManager(
      this._dataDir,
      this._allowedPaths,
      this._confirmWrites,
      this._permission,
      this._storage,
      this._registryDir,
    );

    const pctx = await this.projectManager.initProject(this.projectPath, undefined, this.configDir);

    await this._assembleComponents(pctx);

    this._pctx = pctx;
    this._ctx = pctx;

    if (!this.loop || !this.history) {
      throw configError('Agent 初始化失败', 'LLM Provider 不可用或创建失败', [
        '检查传入的 provider 参数是否有效',
        '确认 API Key 已配置（环境变量或配置文件）',
        '使用 setProvider() 运行时切换 Provider',
      ]);
    }

    this._initialized = true;

    // 启动时 Lazy 扫描：兜底历史会话归档
    this.history.archiveMissingSessions(3000).catch((err: unknown) => {
      logger.warn({ err }, '启动时历史会话归档失败');
    });

    // 启动时记忆衰减（insight/archive 来源）
    this._runMemoryDecay();

    // 定期记忆衰减（每小时）
    this._decayTimer = setInterval(() => this._runMemoryDecay(), Agent.DECAY_INTERVAL_MS);

    return pctx;
  }

  /**
   * 流式对话（核心 API）
   */
  async *chat(input: string, signal?: AbortSignal): AsyncGenerator<AgentChunk, void, unknown> {
    if (!this._initialized || !this.history || !this.loop) {
      throw configError('Agent 未初始化', '请先调用 init()', [
        '在 chat() 前调用 await agent.init()',
      ]);
    }

    if (this._chatBusy) {
      throw configError('对话繁忙', '上一轮对话尚未完成，请等待其结束后再发起新对话', [
        '等待上一轮 chat() 的 AsyncGenerator 耗尽（收到 done 事件）',
        '宿主程序应确保同一时间只有一个 chat() 调用',
      ]);
    }
    this._chatBusy = true;
    // 超时保护：LLM 卡死时自动释放锁，防止永久锁定
    this._chatLockTimer = setTimeout(() => {
      logger.warn('chat() 锁超时（5 分钟），强制释放');
      this._chatBusy = false;
      this._chatLockTimer = null;
    }, Agent.CHAT_LOCK_TIMEOUT_MS);
    try {
      this._lastInteractionAt = new Date();

      // 基元驱动召回（双通道：语义 + 关键词）
      yield { type: 'thinking', phase: 'recalling' };
      const recalledMemories = await recall(this._pctx!.index, input, {
        limit: 5,
        vectorStore: this._vectorStore,
        excludeSources: this._recallExcludeSources,
      });
      if (recalledMemories.length > 0) {
        this.emit('memoryRecalled', { count: recalledMemories.length, query: input });
      }

      // Layer 5: 最近对话注入
      const recentHistory = this.loop.getRecentHistory(3);
      if (recentHistory.length > 0) {
        const recentPrompt = '[最近对话]\n' + recentHistory.map(m =>
          `${m.role === 'user' ? '用户' : '助手'}：${m.content}`
        ).join('\n');
        this.loop.injectSystemMessage(recentPrompt);
        logger.debug({ turns: recentHistory.length / 2 }, '最近对话已注入');
      }

      if (signal?.aborted) {
        yield { type: 'aborted', reason: '用户取消了对话' };
        return;
      }

      // v4.0：注入上一轮匹配的技能 prompt
      yield { type: 'thinking', phase: 'processing' };
      if (this.activeSkill && this.skillManager && this.loop) {
        const skillPrompt = this.skillManager.buildSystemPrompt(this.activeSkill);
        if (skillPrompt) {
          this.loop.injectSystemMessage(skillPrompt);
          logger.debug({ skill: this.activeSkill }, '技能 prompt 已注入');
        }
        this.activeSkill = null;
      }

      await this.history.appendUser(input);

      let assistantContent = '';
      let wasAborted = false;
      for await (const chunk of this.loop.processUserInput(input, recalledMemories, signal)) {
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

      await this.history.appendAssistant(assistantContent);

      // 后处理阶段
      yield { type: 'thinking', phase: 'archiving' };

      // v4.0：用户画像实时归档
      if (this.userProfile) {
        const turnIndex = `turn-${Date.now()}`;
        this.userProfile.archive(input, turnIndex).catch((err) => {
          logger.warn({ err }, '用户画像实时归档失败');
        });
      }

      // v1.1：角色自动匹配
      if (this.personaManager) {
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
      }

      // v4.0：技能关键词匹配
      if (this.skillManager) {
        const match = this.skillManager.match(input);
        if (match) {
          this.activeSkill = match.skill.name;
          logger.debug({ skill: match.skill.name, score: match.score }, '技能匹配，下一轮注入');
        }
      }

      // 输入分类 → Insight 提取（委托给 InsightExtractor）
      if (this.insightExtractor) {
        const shouldExtract = this.insightExtractor.classify(input);
        if (shouldExtract === 'extract') {
          const p = this.insightExtractor.extract(input, assistantContent).catch(() => null);
          this.history.registerPendingArchive(p);
        }
      }
    } finally {
      this._chatBusy = false;
      if (this._chatLockTimer) {
        clearTimeout(this._chatLockTimer);
        this._chatLockTimer = null;
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
   * 切换当前会话（切换前为旧会话生成摘要归档）
   */
  async switchSession(newSession: string): Promise<string> {
    if (!this._initialized || !this.history) {
      throw configError('Agent 未初始化', '请先调用 init()', [
        '在 switchSession() 前调用 await agent.init()',
      ]);
    }

    await this.history.archiveCurrentSession('switch');

    return this.history.switchSession(newSession);
  }

  /**
   * 分叉当前会话：复制完整消息历史到新分支，切换到新分支继续对话
   *
   * 分叉后：
   * - 原会话完整保留，可随时通过 switchSession() 切回
   * - 新分支拥有独立的消息历史，后续对话互不干扰
   * - 记忆索引（IMemoryStorage）全局共享，不受分叉影响
   *
   * @param targetSession - 自定义新分支名（可选，不传则自动生成）
   * @returns { newSession, messageCount }
   */
  forkSession(targetSession?: string): { newSession: string; messageCount: number } {
    if (!this._initialized || !this.history || !this.loop) {
      throw configError('Agent 未初始化', '请先调用 init()', [
        '在 forkSession() 前调用 await agent.init()',
      ]);
    }

    if (this._chatBusy) {
      throw configError('对话繁忙', '上一轮对话尚未完成，请等待其结束后再分叉', [
        '等待上一轮 chat() 的 AsyncGenerator 耗尽',
      ]);
    }

    // 记录源会话名（用于事件）
    const sourceSessionName = this.history.currentSessionName;

    // 委托 MessageHistory 完成分叉
    const result = this.history.forkSession(targetSession);

    // 将消息恢复到 AgentLoop 的工作记忆
    const messages: Message[] = result.messages.map((m) => ({
      role: m.role as Message['role'],
      content: m.content,
    }));
    this.loop.restoreHistory(messages);

    // 发射事件（供 UI 响应）
    this.emit('sessionForked', {
      from: sourceSessionName,
      to: `${result.date}-${result.newSession}`,
      messageCount: result.messages.length,
    });

    return {
      newSession: `${result.date}-${result.newSession}`,
      messageCount: result.messages.length,
    };
  }

  /**
   * 列出已注册项目
   */
  listProjects(): AgentProjectEntry[] {
    if (!this._initialized || !this.projectManager) {
      throw configError('Agent 未初始化', '请先调用 init()', [
        '在 listProjects() 前调用 await agent.init()',
      ]);
    }
    return this.projectManager.listProjects();
  }

  /**
   * 切换到指定项目
   *
   * 切换后自动 rebuildComponents()，无需手动调用。
   * Agent 级记忆（memora.db）保留，项目级配置（.memora/）重新加载。
   */
  async switchProject(nameOrPath: string): Promise<AgentContext> {
    if (!this._initialized || !this.projectManager || !this._provider) {
      throw configError('Agent 未初始化', '请先调用 init()', [
        '在 switchProject() 前调用 await agent.init()',
      ]);
    }

    const projects = this.projectManager.listProjects();
    let target = projects.find((p) => p.name === nameOrPath || p.path === nameOrPath);
    if (!target) {
      const nameOrPathLower = nameOrPath.toLowerCase();
      target = projects.find(
        (p) => p.name.toLowerCase() === nameOrPathLower || p.path.toLowerCase() === nameOrPathLower,
      );
    }
    const projectPath = target ? target.path : nameOrPath;
    const projectName = target ? target.name : basename(nameOrPath);

    const newPctx = await this.projectManager.initProject(projectPath, projectName, this.configDir);

    this._pctx = newPctx;
    this._ctx = newPctx;
    await this._rebuildComponentsWithCurrentCtx();

    return newPctx;
  }

  // ─── 组件组装 ─────────────────────────────────────────

  /**
   * 组装所有运行时组件（v4.0 统一入口）
   */
  private async _assembleComponents(pctx: ProjectContext): Promise<void> {
    const activeProvider = this._provider;
    if (!activeProvider) return;

    // 消息历史
    this.history = new MessageHistory(pctx.index, this._sessionStore);

    // v4.0：作品投影管理器
    this.workProjection = new WorkProjectionManager(
      pctx.index,
      this._backgroundProvider ?? activeProvider,
    );

    // Insight 提取器
    this.insightExtractor = new InsightExtractor(
      activeProvider,
      pctx.index,
      (rounds: number) => this.loop?.getRecentHistory(rounds) ?? [],
    );

    // 工具执行器（v4.0：注入 workProjection）
    const toolExec = new ToolExecutor(
      this.projectPath,
      pctx.security,
      pctx.index,
      this.workProjection,
    );
    this.toolExec = toolExec;

    // v4.0：角色管理器
    this.personaManager = new PersonaManager(this.configDir, pctx.index);
    const personaPrompt = await this.personaManager.load(this._personaName);

    // v4.0：用户画像管理器
    this.userProfile = new UserProfile(pctx.index);
    await this.userProfile.load();

    // v4.0：技能管理器（首次创建后复用）
    if (!this.skillManager) {
      this.skillManager = new SkillManager(this.configDir);
      this.skillManager.load();
    }

    // v4.0 拆分：配置管理器
    this.configManager = new ConfigManager(
      pctx.index,
      this.skillManager,
      (msg: string) => this.loop?.injectSystemMessage(msg),
      this.configDir,
    );

    // v4.0：构建系统 prompt 前缀
    const systemPrefixParts = [personaPrompt];
    const profilePrompt = this.userProfile.buildSystemPrompt();
    if (profilePrompt) systemPrefixParts.push(profilePrompt);
    const systemPromptPrefix =
      systemPrefixParts.filter(Boolean).join('\n\n') +
      (systemPrefixParts.length > 0 ? '\n\n---\n\n' : '');

    // Agent Loop
    this.loop = new AgentLoop({
      provider: activeProvider,
      bootstrapMemories: pctx.bootstrapMemories,
      toolExecutor: (name: string, args: string) =>
        toolExec.execute(
          name,
          args,
          this.insightExtractor?.writeExtensions ?? undefined,
        ),
      systemPromptPrefix,
      toolDefinitions: toolExec.getToolDefinitions(),
      maxContextTokens: this._maxContextTokens,
    });

    // v4.0 拆分：记忆查看器（依赖已创建的 loop + history）
    if (this.loop && this.history) {
      this.memoryInspector = new MemoryInspector(pctx.index, this.loop, this.history);
    }
  }

  /**
   * 用当前 _pctx 重建 history / loop
   */
  private async _rebuildComponentsWithCurrentCtx(): Promise<void> {
    if (!this._pctx) return;
    await this._assembleComponents(this._pctx);
  }

  // ─── Provider 管理 ────────────────────────────────────

  setProvider(provider: LlmProvider): void {
    this._provider = provider;
    if (this.loop) {
      this.loop.setProvider(provider);
    }
    logger.info('Provider 已切换');
  }

  setBackgroundProvider(provider: LlmProvider | null): void {
    this._backgroundProvider = provider;
    logger.info({ hasBackground: !!provider }, '后台 Provider 已切换');
  }

  // ─── 组件访问 ─────────────────────────────────────────

  getBuildCtx(): AgentBuildCtx | null {
    if (!this._pctx) return null;
    return {
      security: this._pctx.security,
      index: this._pctx.index,
      bootstrapMemories: this._pctx.bootstrapMemories,
    };
  }

  /**
   * 重建内部组件（history / loop / managers）
   *
   * 通常不需要手动调用——switchProject() 已自动执行 rebuild。
   * 仅在宿主项目需要强制刷新组件时使用（如热更新配置后）。
   */
  async rebuildComponents(): Promise<void> {
    await this._rebuildComponentsWithCurrentCtx();
  }

  /**
   * 恢复最近的会话对话
   */
  async restoreMostRecentSession(preferredSession = 'main'): Promise<number> {
    if (!this._initialized || !this.history || !this.loop) {
      throw configError('Agent 未初始化', '请先调用 init()', [
        '在 restoreMostRecentSession() 前调用 await agent.init()',
      ]);
    }

    const sessionMessages = await this.history.loadMostRecentSession(preferredSession);
    if (sessionMessages.length === 0) {
      logger.debug('没有找到可恢复的历史会话');
      return 0;
    }

    const messages: Message[] = sessionMessages.map((tm: { role: string; content: string }) => ({
      role: tm.role as Message['role'],
      content: tm.content,
    }));

    this.loop.restoreHistory(messages);

    return sessionMessages.length;
  }

  /**
   * 恢复指定会话的对话
   */
  async restoreSession(date: string, session: string): Promise<number> {
    if (!this._initialized || !this.history || !this.loop) {
      throw configError('Agent 未初始化', '请先调用 init()', [
        '在 restoreSession() 前调用 await agent.init()',
      ]);
    }

    const sessionMessages = await this.history.loadSessionMessages(date, session);
    if (sessionMessages.length === 0) {
      return 0;
    }

    const messages: Message[] = sessionMessages.map((tm: { role: string; content: string }) => ({
      role: tm.role as Message['role'],
      content: tm.content,
    }));

    this.loop.restoreHistory(messages);

    return sessionMessages.length;
  }

  /**
   * 对外暴露的 loadSessionMessages 委托
   * 加载指定会话的历史消息，加载后 Memora 状态同步切换到该会话
   */
  async loadSessionMessages(date: string, session: string): Promise<SessionRecord[]> {
    if (!this._initialized || !this.history) {
      throw configError('Agent 未初始化', '请先调用 init()', [
        '在 loadSessionMessages() 前调用 await agent.init()',
      ]);
    }
    return this.history.loadSessionMessages(date, session);
  }

  // ─── 记忆生命周期 ───────────────────────────────────────

  /**
   * 对 insight/archive 记忆执行 score 衰减
   *
   * 长期未访问的记忆 score 逐渐降低，体现"自然遗忘"
   * 不影响 persona/rule/skill（这些是配置型记忆，不应衰减）
   */
  private _runMemoryDecay(): void {
    if (!this._pctx) return;
    const now = new Date();
    const sources = [SOURCE_LABELS.INSIGHT, SOURCE_LABELS.PROFILE, SOURCE_LABELS.WORK_PROJECTION];
    let decayedCount = 0;
    for (const source of sources) {
      const memories = this._pctx.index.getBySource(source);
      if (memories.length === 0) continue;
      decayScores(memories, now);
      for (const m of memories) {
        this._pctx.index.upsert(m);
      }
      decayedCount += memories.length;
    }
    logger.debug({ decayedCount }, '记忆衰减完成');
    this.emit('decayCompleted', { decayedCount: decayedCount });
  }

  // ─── 关闭 ─────────────────────────────────────────────

  /**
   * 关闭 Agent，释放 SQLite 连接等资源
   */
  async close(): Promise<void> {
    // 清理定时器
    if (this._decayTimer) {
      clearInterval(this._decayTimer);
      this._decayTimer = null;
    }
    if (this._chatLockTimer) {
      clearTimeout(this._chatLockTimer);
      this._chatLockTimer = null;
    }
    this.removeAllListeners();

    if (this.history) {
      await this.history.awaitPendingArchives(5000);
    }

    if (this.projectManager) {
      await this.projectManager.shutdown();
    }
    this._initialized = false;
    this._backgroundProvider = null;
    this._chatBusy = false;
    this.history = null;
    this.loop = null;
    this.projectManager = null;
    this.insightExtractor = null;
    this.configManager = null;
    this.memoryInspector = null;
    this._ctx = null;
    this._pctx = null;
  }

  // ─── 只读访问器 ───────────────────────────────────────

  get initialized(): boolean {
    return this._initialized;
  }

  get context(): AgentContext | null {
    return this._ctx;
  }

  get agentLoop(): AgentLoop | null {
    return this.loop;
  }

  get agentHistory(): MessageHistory | null {
    return this.history;
  }

  get provider(): LlmProvider {
    return this._provider;
  }

  get isBusy(): boolean {
    return this._chatBusy;
  }

  get lastInteractionAt(): Date | null {
    return this._lastInteractionAt;
  }

  // ─── Manager 暴露（激进拆分：调用方直接操作 Manager）──

  /** 角色管理器 */
  get persona(): PersonaManager | null {
    return this.personaManager;
  }

  /** 工具执行器 */
  get tools(): ToolExecutor | null {
    return this.toolExec;
  }

  /** 技能管理器 */
  get skills(): SkillManager | null {
    return this.skillManager;
  }

  /** 配置管理器（规则/技能注入 + 配置建议） */
  get config(): ConfigManager | null {
    return this.configManager;
  }

  /** Insight 提取器（输入分类 + 记忆提取） */
  get insight(): InsightExtractor | null {
    return this.insightExtractor;
  }

  /** 记忆查看器（快照 + 搜索 + 统计） */
  get memory(): MemoryInspector | null {
    return this.memoryInspector;
  }
}
