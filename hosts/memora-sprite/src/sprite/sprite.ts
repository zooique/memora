/**
 * 精灵主控 — 唤醒调度 + 对话管理 + 事件驱动
 *
 * 职责（拆分后）：
 *   1. 监听触发器事件，决定是否唤醒精灵
 *   2. 唤醒后启动对话交互
 *   3. 管理精灵状态（idle / active）
 *   4. 配置持久化
 *   5. 订阅 Agent 事件，委托 Controller 处理具体逻辑
 *
 * 设计原则（ADR-SP-004）：
 *   上下文感知而非内容感知——精灵通过文件变化、时间等上下文信号唤醒，
 *   不监听键盘输入内容。
 */
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { Agent, AgentEventMap, AgentMetrics, Memory } from 'memora';
import type { VectorStore, ITracer } from 'memora';
import { logger, toError } from 'memora';
import { TriggerBus, TimerTrigger } from './triggers.js';
import type { TriggerPayload } from './triggers.js';
import { FileWatcherTrigger } from './fileWatcherTrigger.js';
import { loadSpriteConfig, saveSpriteConfig, applyConfigField, DEFAULT_SPRITE_CONFIG, type SpriteConfig, type SpriteConfigKey } from './spriteConfig.js';
import * as cliFormatter from './cli/formatter.js';
import { MemoryController, PersonaController, ProactiveEngine, PresenceController } from './controllers/index.js';
import type { DashboardData, RapportAssessment, IPowerMonitor, IApp } from './controllers/index.js';
import { AffectController } from './controllers/affectController.js';
import type { AffectState } from './controllers/affectController.js';
import { RapportController } from './controllers/rapportController.js';
import type { RapportState } from './controllers/rapportController.js';
import { ContextAwareness } from './controllers/contextAwareness.js';
import type { ContextState } from './controllers/contextAwareness.js';
import { PatternDetector } from './controllers/patternDetector.js';
import type { DetectedPattern } from './controllers/patternDetector.js';
import { SPRITE_TRACE_SPANS } from './spriteTracer.js';
import { DEFAULT_LIST_LIMIT, MS_PER_HOUR, MS_PER_DAY } from './constants.js';

/** 精灵主控状态：idle 空闲等待触发 / active 唤醒中（对话进行中） */
export type SpriteState = 'idle' | 'active';

/** 精灵事件载荷 — 宿主 UI 可订阅 */
export interface SpriteEventMap {
  /** 精灵注意到新记忆（insight/profile/guardrail 等） */
  memoryNoticed: { source: string; name: string };
  /** 精灵注意到角色切换 */
  personaChanged: { from: string | null; to: string };
  /** 精灵注意到洞察提取 */
  insightGained: { source: string; insight: string };
  /** 精灵主动提示（累积事件后生成） */
  proactivePrompt: { prompt: string; triggers: string[]; silent: boolean; isMilestone?: boolean };
  // L5：迭代 9 补齐的 4 种未订阅 Agent 事件
  /** 用户切换项目（专注模式） */
  projectSwitched: { from: string | null; to: string; projectName: string };
  /** 技能匹配命中 */
  skillMatched: { skill: string; score: number };
  /** 记忆被召回（用于"想起 X 条记忆"提示） */
  memoryRecalled: { count: number; query: string };
  /** 记忆衰减完成（24h 节流，避免噪音） */
  decayCompleted: { decayedCount: number };
  /** Phase 3.2：用户在场状态变化（离开/回来） */
  presenceChanged: { state: 'present' | 'away'; timestamp: string; awayDurationMs?: number; reason: string };
  /** Phase 2.1：情感基调更新（推导完成后触发） */
  affectUpdated: AffectState;
  /** Phase 3：默契度更新（推导完成后触发，与 affectUpdated 同时发射） */
  rapportUpdated: RapportState;
  /** Phase 4：对话上下文更新（推导完成后触发，与 affectUpdated 同时发射） */
  contextUpdated: ContextState;
  /** H3：作品投影更新（文件变化触发投影重新生成后发射） */
  workProjectionUpdated: { sourcePath: string; summary: string };
  /** Phase 2+：用户模式更新（PatternDetector 检测到新模式后发射） */
  patternsUpdated: { patterns: DetectedPattern[] };
}

// 重新导出 DashboardData 和 AffectState 供外部使用
export type { DashboardData, AffectState };

/** 精灵主控构造选项（P3-DESIGN-1：位置参数 → options 对象） */
export interface SpriteOptions {
  /** Agent 实例（必填，由宿主项目创建并注入） */
  agent: Agent;
  /** 数据目录（必填，存储 memora.db、sprite.json 等持久化数据） */
  dataDir: string;
  /** 项目路径（可选，默认取 dataDir。用于文件监听、项目规则加载等） */
  projectPath?: string;
  /** 向量存储（可选，注入后启用语义搜索） */
  vectorStore?: VectorStore;
  /** 路径白名单（可选，来自 Agent 的 allowedPaths，用于 fileWatcher 安全校验） */
  allowedPaths?: string[];
  /** 可观测性 tracer（可选，注入后关键路径会记录 span 到 trace.log） */
  tracer?: ITracer;
}

/**
 * 精灵主控
 */
export class Sprite {
  private agent: Agent;
  private state: SpriteState = 'idle';
  private triggerBus: TriggerBus;
  private running = false;
  private spriteHandlers = new Map<string, Set<(event: unknown) => void>>();
  /** Agent 事件处理器引用（用于 off 取消订阅） */
  private agentHandlers: {
    memoryAdded?: (e: AgentEventMap['memoryAdded']) => void;
    personaSwitched?: (e: AgentEventMap['personaSwitched']) => void;
    insightExtracted?: (e: AgentEventMap['insightExtracted']) => void;
    // L5：迭代 9 补齐的 4 种事件
    projectSwitched?: (e: AgentEventMap['projectSwitched']) => void;
    skillMatched?: (e: AgentEventMap['skillMatched']) => void;
    memoryRecalled?: (e: AgentEventMap['memoryRecalled']) => void;
    decayCompleted?: (e: AgentEventMap['decayCompleted']) => void;
  } = {};
  /** 项目路径（用于 FileWatcherTrigger 的默认监听目录） */
  private projectPath: string;
  /** 路径白名单（来自 Agent 配置，用于 fileWatcher 安全校验） */
  private allowedPaths: string[];

  // ─── 配置持久化 ────────────────────────────────────────
  private dataDir: string;
  private config: Required<SpriteConfig>;

  // ─── 控制器 ──────────────────────────────────────────────
  private memoryController: MemoryController;
  private personaController: PersonaController;
  private proactiveEngine: ProactiveEngine;
  /** Phase 3.2：在场状态控制器（可选，需宿主注入 powerMonitor/app） */
  private presenceController: PresenceController | null = null;
  /** Phase 2.1：情感基调控制器（纯代码推导，从记忆数据实时计算四维情感基调） */
  private affectController: AffectController;
  /** Phase 3：默契度控制器（纯代码推导，从行为信号推导信任度+熟悉度） */
  private rapportController: RapportController;
  /** Phase 4：对话上下文感知器（纯代码推导，从最近记忆推导节奏+话题+深度） */
  private contextAwareness: ContextAwareness;
  /** Phase 2+：记忆模式检测器 */
  private patternDetector: PatternDetector;
  /** P2-S6: 可观测性 tracer，可选注入，为关键路径提供 span 埋点 */
  private readonly tracer: ITracer | null;

  // ─── 感知数据缓存（Phase 1+2：注入 ProactiveEngine 用） ───
  /** 最近一次推导的情感基调（供 ProactiveEngine 个性化提示） */
  private lastAffect: AffectState | null = null;
  /** 最近一次推导的默契度状态（供 ProactiveEngine 自适应冷却） */
  private lastRapport: RapportState | null = null;
  /** 最近 N 轮用户消息文本（用于对话语气分析，最多保留 5 条） */
  private recentUserMessages: string[] = [];

  constructor(options: SpriteOptions) {
    this.agent = options.agent;
    this.dataDir = options.dataDir;
    this.projectPath = options.projectPath ?? options.dataDir;
    this.allowedPaths = options.allowedPaths ?? [];
    this.tracer = options.tracer ?? null;
    this.config = loadSpriteConfig();
    this.triggerBus = new TriggerBus();
    this.triggerBus.register(new TimerTrigger(this.config.triggerIntervalMs));

    // 初始化控制器
    this.memoryController = new MemoryController(this.agent, options.vectorStore);
    this.personaController = new PersonaController(this.agent);
    this.proactiveEngine = new ProactiveEngine({
      threshold: this.config.proactiveThreshold,
      cooldownMs: this.config.proactiveCooldownMs,
      silentMode: this.config.silentMode,
    });

    // Phase 2.1：初始化情感基调控制器
    this.affectController = new AffectController({
      acceptanceRate: 0.5, // 初始默认值，后续由 ProactiveEngine 更新
      currentPersona: null,
    });

    // Phase 3：初始化默契度控制器
    this.rapportController = new RapportController({
      acceptanceRate: 0.5,
      interactionDays: 0,
      totalMessages: 0,
      sourceDiversity: 0,
    });

    // Phase 4：初始化对话上下文感知器
    this.contextAwareness = new ContextAwareness();

    // Phase 2+：初始化记忆模式检测器
    this.patternDetector = new PatternDetector();

    // 设置主动提示引擎的发射器
    this.proactiveEngine.setEmitter((event, payload) => {
      this.emitSprite(event, payload);
    });

    // 注册文件监听触发器（默认启用）
    if (this.config.fileWatcherEnabled) {
      this.registerFileWatcher();
    }
  }

  /** 注册 FileWatcherTrigger */
  private registerFileWatcher(): void {
    const watchPaths = this.config.fileWatcherPaths.map((p) => resolve(this.projectPath, p));
    // 构建 fileWatcher 白名单：projectPath + dataDir + Agent 的 allowedPaths
    // 与内核 pathGuard 保持一致：projectPath 和 dataDir 自动允许，allowedPaths 为额外白名单
    const fileWatcherAllowedPaths = [
      this.projectPath,
      this.dataDir,
      ...this.allowedPaths,
    ];
    this.triggerBus.register(
      new FileWatcherTrigger({
        watchPaths,
        ignore: this.config.fileWatcherIgnore,
        debounceMs: this.config.fileWatcherDebounceMs,
        allowedPaths: fileWatcherAllowedPaths,
      }),
    );
  }

  // ─── 精灵事件系统（宿主 UI 可订阅） ──────────────────────

  /** 订阅精灵事件 */
  on<K extends keyof SpriteEventMap & string>(
    event: K,
    handler: (event: SpriteEventMap[K]) => void,
  ): void {
    let set = this.spriteHandlers.get(event);
    if (!set) {
      set = new Set();
      this.spriteHandlers.set(event, set);
    }
    set.add(handler as (event: unknown) => void);
  }

  /** 取消订阅精灵事件 */
  off<K extends keyof SpriteEventMap & string>(
    event: K,
    handler: (event: SpriteEventMap[K]) => void,
  ): void {
    this.spriteHandlers.get(event)?.delete(handler as (event: unknown) => void);
  }

  /** 发射精灵事件 */
  private emitSprite<K extends keyof SpriteEventMap & string>(
    event: K,
    payload: SpriteEventMap[K],
  ): void {
    const set = this.spriteHandlers.get(event);
    if (!set) return;
    for (const handler of set) {
      try {
        handler(payload);
      } catch (error) {
        logger.warn({ event, err: toError(error).message }, '宿主事件处理器异常');
      }
    }
  }

  // ─── 生命周期 ──────────────────────────────────────────

  /** 启动精灵主控循环 */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.state = 'idle';

    // 注册触发器回调
    this.triggerBus.on((payload: TriggerPayload) => {
      this.handleTrigger(payload);
    });
    this.triggerBus.start();

    // 订阅 Agent 事件
    this.subscribeAgentEvents();

    // 应用默认角色（配置指定时自动切换）
    if (this.config.defaultPersona) {
      this.personaController.switch(this.config.defaultPersona);
    }

    // Phase 3.2：启动在场状态控制器（如已注入）
    this.presenceController?.start();

    // Phase 2.1：首次推导情感基调并注入 system prompt
    const initialPrompt = this.deriveAndInjectAffect();
    if (initialPrompt) {
      this.agent.injectAffect(initialPrompt);
    }

    logger.info('精灵已启动，等待唤醒...');
  }

  /** 停止精灵主控 */
  stop(): void {
    this.running = false;
    this.triggerBus.stop();
    this.unsubscribeAgentEvents();
    // QC-SPRITE-01：停止在场状态控制器，取消注册事件监听器，防止 reinitAgent 后泄漏
    this.presenceController?.stop();
    this.spriteHandlers.clear();
    this.state = 'idle';
  }

  /**
   * 注入在场状态控制器（Phase 3.2）
   *
   * 宿主项目（main.ts）创建 PresenceController 后注入。
   * 若 Sprite 已启动（running=true），自动调用 presenceController.start()。
   * 未注入时跳过在场状态检测（向后兼容）。
   *
   * @param controller PresenceController 实例
   */
  setPresenceController(controller: PresenceController): void {
    this.presenceController = controller;
    // 若 Sprite 已启动，自动启动在场状态控制器
    if (this.running) {
      controller.start();
    }
  }

  /**
   * 创建并注入在场状态控制器（Phase 3.2 便捷方法）
   *
   * 由 Sprite 内部创建 PresenceController，自动绑定 emit 回调到 emitSprite。
   * 宿主只需传入满足 IPowerMonitor/IApp 接口的事件源
   * （Electron 的 powerMonitor/app 模块自动满足，结构子类型）。
   *
   * @param powerMonitor 满足 IPowerMonitor 接口的事件源
   * @param app 满足 IApp 接口的事件源
   */
  bindPresence(powerMonitor: IPowerMonitor, app: IApp): void {
    const controller = new PresenceController(powerMonitor, app, {
      proactiveEngine: this.proactiveEngine,
      emit: (event, payload) => {
        this.emitSprite(event, payload);
      },
    });
    this.setPresenceController(controller);
  }

  /** 获取当前状态 */
  getState(): SpriteState {
    return this.state;
  }

  /**
   * 手动唤醒精灵
   *
   * @param input 可选的用户输入，无输入时生成主动提示
   * @returns 精灵响应结果（静默模式返回 null）
   */
  async wakeup(input?: string): Promise<string> {
    this.state = 'active';
    // P2-S6: 唤醒是 LLM 调用主路径，记录 span 用于性能追踪
    const span = this.tracer?.startSpan(SPRITE_TRACE_SPANS.WAKEUP, input ? { hasInput: true } : { hasInput: false });
    try {
      // Phase 2.2：记录最近用户消息，用于对话语气实时分析
      if (input) {
        this.recentUserMessages.push(input);
        // 只保留最近 5 条，超出则移除最旧的
        if (this.recentUserMessages.length > 5) {
          this.recentUserMessages.shift();
        }
      }

      // 对话前刷新全量感知，确保 LLM 拿到最新的情感/默契度/上下文/模式/里程碑数据
      this.refreshPerceptionBeforeChat();

      // input 为 undefined 时，生成主动提示（无输入对话）
      return await this.agent.chatSync(input ?? '');
    } catch (err) {
      span?.recordException(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      this.state = 'idle';
      span?.end();
    }
  }

  // ─── 角色交互（委托 PersonaController） ────────────────

  /** 获取当前角色名称 */
  get activePersona(): string | null {
    return this.personaController.activeName;
  }

  /** 获取角色列表 */
  listPersonas(): Array<{ name: string; description: string; active: boolean }> {
    return this.personaController.list();
  }

  /**
   * 切换角色
   *
   * @param name 角色名称
   * @returns 切换后的角色名称，失败返回 null
   */
  switchPersona(name: string): string | null {
    return this.personaController.switch(name);
  }

  /**
   * 设置角色匹配模式
   *
   * @param mode 匹配模式（'auto' 自动匹配 / 'manual' 手动固定）
   * @returns 是否设置成功
   */
  setPersonaMode(mode: 'auto' | 'manual'): boolean {
    return this.personaController.setMode(mode);
  }

  /** 获取当前角色匹配模式 */
  get personaMode(): string {
    return this.personaController.currentMode;
  }

  // ─── 项目管理（FD-04 项目模式） ────────────────────────

  /**
   * 列出已注册项目（供 UI 项目模式选择器使用）
   *
   * FD-04 专注模式需要用户选择锁定项目，此方法返回 Agent 注册表中的项目列表。
   */
  listProjects(): Array<{ name: string; path: string }> {
    return this.agent.projects?.list.map((p: { name: string; path: string }) => ({ name: p.name, path: p.path })) ?? [];
  }

  /** 格式化角色列表为可读文本（委托 cliFormatter） */
  formatPersonas(): string {
    return cliFormatter.formatPersonas(this.personaController.list(), this.personaController.activeName ?? undefined);
  }

  // ─── 记忆管理（委托 MemoryController） ──────────────────

  /**
   * 列出记忆（可按 source 过滤）
   *
   * @param source 可选的来源过滤条件
   * @param limit 返回数量上限，默认 50
   * @returns 记忆列表项数组
   */
  listMemories(
    source?: string,
    limit = 50,
  ): { id: string; name: string; source: string; score: number; contentPreview: string }[] {
    return this.memoryController.list(source, limit);
  }

  /**
   * 查看单条记忆详情
   *
   * @param id 记忆唯一标识（${source}:${name} 格式）
   * @returns 记忆详情，不存在时返回 null
   */
  showMemory(
    id: string,
  ): {
    id: string;
    name: string;
    source: string;
    score: number;
    content: string;
    createdAt: string;
    accessedAt: string;
  } | null {
    return this.memoryController.show(id);
  }

  /**
   * 删除记忆
   *
   * @param id 记忆唯一标识
   * @returns 是否成功删除
   */
  deleteMemory(id: string): boolean {
    return this.memoryController.delete(id);
  }

  /**
   * 添加或更新记忆
   *
   * @param source 记忆来源
   * @param name 记忆名称
   * @param content 记忆内容
   * @param score 初始权重，默认 0.5
   * @returns 记忆唯一标识
   */
  upsertMemory(source: string, name: string, content: string, score = 0.5): string {
    return this.memoryController.upsert(source, name, content, score);
  }

  /**
   * 混合搜索记忆（语义 + 关键词双通道）
   *
   * 优先使用向量搜索，失败时降级为纯关键词搜索。
   *
   * @param query 搜索关键词
   * @param limit 返回数量上限，默认 10
   * @returns 搜索结果列表
   */
  async searchMemories(
    query: string,
    limit = 10,
  ): Promise<
    Array<{
      id: string;
      name: string;
      source: string;
      score: number;
      contentPreview: string;
      similarity?: number;
    }>
  > {
    return this.memoryController.search(query, limit);
  }

  /**
   * 获取记忆关系图谱数据（ADR-014：拓扑可视化）
   *
   * 返回所有记忆作为节点、所有关系作为边，供渲染层 Canvas 2D 力导向图渲染。
   * 节点上限 RELATION_GRAPH_MAX_NODES（200），避免大规模记忆库性能问题。
   *
   * @returns 图谱数据：nodes（记忆列表）+ edges（关系边列表）
   */
  getRelationGraph(): {
    nodes: Array<{ id: string; name: string; source: string; score: number; contentPreview: string }>;
    edges: Array<{ sourceId: string; targetId: string; type: string; weight: number; createdAt: string }>;
  } {
    return this.memoryController.getRelationGraph();
  }

  /**
   * 添加记忆关系（手动创建）
   *
   * 用于宿主 UI 关系图交互：右键菜单 → 连线 → 创建关系。
   */
  addRelation(sourceId: string, targetId: string, type: string, weight: number): void {
    this.memoryController.addRelation(sourceId, targetId, type, weight);
  }

  /**
   * 删除记忆关系
   *
   * 用于宿主 UI 关系图交互：编辑关系弹窗 → 删除关系。
   */
  removeRelation(sourceId: string, targetId: string, type: string): void {
    this.memoryController.removeRelation(sourceId, targetId, type);
  }

  /**
   * 更新记忆关系
   *
   * 用于宿主 UI 关系图交互：编辑关系弹窗 → 修改类型/权重 → 保存。
   */
  updateRelation(sourceId: string, targetId: string, type: string, weight: number): void {
    this.memoryController.updateRelation(sourceId, targetId, type, weight);
  }

  /**
   * 获取记忆健康度仪表盘数据（Phase 1：健康度诊断）
   *
   * 纯计算，不依赖 LLM。检测重复记忆、过期记忆和低质量记忆，
   * 生成健康度评分和清理建议。
   *
   * @returns 健康度仪表盘完整数据
   */
  getHealthDashboard() {
    return this.memoryController.getHealthDashboard();
  }

  /**
   * 获取对话回顾数据（Phase 2：对话回顾与摘要）
   *
   * 聚合最近对话的摘要、洞察和增长趋势。纯代码计算，不依赖 LLM。
   *
   * @returns 回顾面板完整数据
   */
  getReviewData() {
    return this.memoryController.getReviewData();
  }

  // ─── 配置持久化 ────────────────────────────────────────

  /** 获取当前配置（只读副本） */
  getConfig(): Readonly<Required<SpriteConfig>> {
    return { ...this.config };
  }

  /**
   * 更新配置项并持久化
   *
   * 类型安全写入：通过分支判断将 unknown 类型的 value 赋给对应类型的配置字段，
   * 避免 `as Record<string, unknown>` 类型断言。
   *
   * 触发器重建委托给 rebuildFileWatcher / restartTriggersIfRunning，
   * 避免 stop/start 逻辑在 3 处重复（DRY）。
   */
  updateConfig(key: SpriteConfigKey, value: unknown): void {
    this.setConfigField(key, value);
    // R6 传完整配置写入，避免 saveSpriteConfig 每次读文件
    saveSpriteConfig(this.config);

    // 特殊处理：触发器间隔变更时重建 TimerTrigger
    if (key === 'triggerIntervalMs' && typeof value === 'number') {
      this.triggerBus.unregister('timer');
      this.triggerBus.register(new TimerTrigger(value));
      this.restartTriggersIfRunning();
    }

    // 特殊处理：文件监听配置变更时重建 FileWatcherTrigger
    if (key === 'fileWatcherEnabled') {
      this.rebuildFileWatcher();
    }

    // 文件监听路径/忽略/防抖变更时，仅在已启用时重建
    if (
      key === 'fileWatcherPaths' ||
      key === 'fileWatcherIgnore' ||
      key === 'fileWatcherDebounceMs'
    ) {
      if (this.config.fileWatcherEnabled) {
        this.rebuildFileWatcher();
      }
    }

    // 特殊处理：主动提示配置变更时更新 ProactiveEngine
    if (key === 'proactiveThreshold' || key === 'proactiveCooldownMs' || key === 'silentMode') {
      this.proactiveEngine.updateConfig({
        threshold: this.config.proactiveThreshold,
        cooldownMs: this.config.proactiveCooldownMs,
        silentMode: this.config.silentMode,
      });
    }

    // FD-04 特殊处理：专注模式切换时调用 agent.switchProject 切换 Agent 上下文
    // 专注模式锁定特定项目，其他项目的文件变化被忽略
    if (key === 'projectMode' || key === 'focusProjectPath') {
      this.applyProjectMode();
    }
  }

  /**
   * 批量更新配置并持久化（QC-CONFIG-01：事务性保证）
   *
   * 相比逐项调用 updateConfig，本方法保证：
   *   1. 原子性：任一 key 非法或 value 类型校验失败时，全部更新不应用，config 状态不变
   *   2. 单次持久化：仅调用一次 saveSpriteConfig，避免 N 次 writeFileSync
   *   3. 副作用去重：批量内涉及同类副作用（如多个 fileWatcher* 键）只触发一次重建
   *
   * 校验策略：先在 config 浅副本上用 applyConfigField 校验全部更新，
   * 全部通过后再应用到真实 config，确保真实 config 不会被部分修改（事务性核心）。
   *
   * @param updates 批量更新对象（key → value），运行时校验每个 key/value 合法性
   * @returns 成功返回 { updated: true }；失败返回 { updated: false, error }，config 状态不变
   */
  updateConfigBatch(updates: Partial<SpriteConfig>): { updated: boolean; error?: string } {
    /** 本次批量更新涉及的键列表（运行时从入参提取） */
    const keys = Object.keys(updates) as SpriteConfigKey[];

    // 空批量：直接成功，不触发持久化和副作用（幂等）
    if (keys.length === 0) {
      return { updated: true };
    }

    // ─── 校验阶段：在 config 浅副本上校验，不修改真实 config ───
    // 副本校验是事务性的关键：任一校验失败时真实 config 完全不变
    /** config 浅副本（仅用于校验，应用失败时丢弃，不影响真实状态） */
    const configCopy: Required<SpriteConfig> = { ...this.config };
    for (const key of keys) {
      // key 合法性校验：必须是 SpriteConfig 已定义的字段
      if (!(key in DEFAULT_SPRITE_CONFIG)) {
        return { updated: false, error: `非法配置键：${key}` };
      }
      // value 类型校验：在副本上应用，applyConfigField 返回 false 表示类型不匹配
      const ok = applyConfigField(configCopy, key, updates[key]);
      if (!ok) {
        return { updated: false, error: `配置值类型非法：${key}` };
      }
    }

    // ─── 应用阶段：校验全部通过，逐个写入真实 config ───
    // 此时类型已校验，setConfigField 不会再失败，可安全应用
    for (const key of keys) {
      this.setConfigField(key, updates[key]);
    }

    // ─── 持久化：仅一次写盘（R6 完整配置写入，跳过读文件） ───
    saveSpriteConfig(this.config);

    // ─── 副作用统一触发（去重，每类副作用只触发一次） ───
    /** 本次批量更新涉及的键集合（O(1) 查询） */
    const keySet = new Set<string>(keys);

    // triggerIntervalMs → 重建 TimerTrigger（一次）
    if (keySet.has('triggerIntervalMs') && typeof updates.triggerIntervalMs === 'number') {
      this.triggerBus.unregister('timer');
      this.triggerBus.register(new TimerTrigger(updates.triggerIntervalMs));
      this.restartTriggersIfRunning();
    }

    // fileWatcher* 任一 → 重建 FileWatcherTrigger（一次）
    // rebuildFileWatcher 内部根据 this.config.fileWatcherEnabled 决定是否注册，
    // 因此 fileWatcherEnabled 与其他 fileWatcher* 键可统一走一次重建
    if (
      keySet.has('fileWatcherEnabled') ||
      keySet.has('fileWatcherPaths') ||
      keySet.has('fileWatcherIgnore') ||
      keySet.has('fileWatcherDebounceMs')
    ) {
      this.rebuildFileWatcher();
    }

    // proactive 阈值/冷却/静默 → 更新 ProactiveEngine（一次）
    if (
      keySet.has('proactiveThreshold') ||
      keySet.has('proactiveCooldownMs') ||
      keySet.has('silentMode')
    ) {
      this.proactiveEngine.updateConfig({
        threshold: this.config.proactiveThreshold,
        cooldownMs: this.config.proactiveCooldownMs,
        silentMode: this.config.silentMode,
      });
    }

    // projectMode/focusProjectPath → applyProjectMode（一次）
    // FD-04：专注模式切换时调用 agent.switchProject 切换 Agent 上下文
    if (keySet.has('projectMode') || keySet.has('focusProjectPath')) {
      this.applyProjectMode();
    }

    return { updated: true };
  }

  /**
   * 重建文件监听触发器
   *
   * 先注销当前 fileWatcher，再根据 config.fileWatcherEnabled 决定是否重新注册。
   * 若 Sprite 正在运行，重建后自动重启触发器总线。
   * 统一 fileWatcherEnabled / fileWatcherPaths / fileWatcherIgnore / fileWatcherDebounceMs
   * 四个配置变更时的重建逻辑（DRY）。
   */
  private rebuildFileWatcher(): void {
    this.triggerBus.unregister('fileWatcher');
    if (this.config.fileWatcherEnabled) {
      this.registerFileWatcher();
    }
    this.restartTriggersIfRunning();
  }

  /**
   * 若 Sprite 正在运行则重启触发器总线
   *
   * 配置变更（triggerIntervalMs / fileWatcher*）后，需重启 TriggerBus 使新触发器生效。
   * 提取为公共方法避免 stop/start 两行逻辑在多处重复（DRY）。
   */
  private restartTriggersIfRunning(): void {
    if (this.running) {
      this.triggerBus.stop();
      this.triggerBus.start();
    }
  }

  /**
   * FD-04 应用项目模式
   *
   * - smart 模式：保持当前 projectPath（启动时设定），不切换
   * - focus 模式：调用 agent.switchProject 切换到 focusProjectPath，
   *   使 Agent 上下文（安全守卫 + 项目规则/技能）聚焦到锁定项目
   *
   * 注意：switchProject 是异步操作，此处不 await（updateConfig 是同步方法）。
   * 切换在后台完成，失败时仅记录日志，不阻塞配置更新。
   */
  private applyProjectMode(): void {
    if (this.config.projectMode !== 'focus') return;
    const focusPath = this.config.focusProjectPath;
    if (!focusPath) {
      logger.warn('专注模式未设置 focusProjectPath，保持当前项目');
      return;
    }
    // P2-S6: 项目切换含 fileWatcher 重建，记录 span 用于追踪切换耗时与失败率
    const span = this.tracer?.startSpan(SPRITE_TRACE_SPANS.PROJECT_MODE, { focusPath });
    // 异步切换，不阻塞配置更新
    this.agent.switchProject(focusPath).then(() => {
      logger.info({ focusPath }, '已切换到专注项目');
      // 重建 FileWatcherTrigger 以监听新项目路径
      // 复用 rebuildFileWatcher() 封装的 unregister + register + restart 逻辑（DRY）
      if (this.config.fileWatcherEnabled) {
        this.rebuildFileWatcher();
      }
      span?.end();
    }).catch((err: unknown) => {
      logger.warn({ focusPath, err: toError(err).message }, '专注项目切换失败');
      span?.recordException(err instanceof Error ? err : new Error(String(err)));
      span?.end();
    });
  }

  /**
   * 类型安全地设置配置字段
   *
   * 基于 CONFIG_FIELD_SCHEMA 映射表做运行时类型校验，
   * 替代原来的 80 行 if-else 链。新增配置字段只需在 schema 表加一行映射。
   *
   * 不符合类型的 value 会被忽略（保持原值），由调用方保证传入正确类型。
   */
  private setConfigField(key: SpriteConfigKey, value: unknown): void {
    // 委托到 spriteConfig.ts 的纯函数，配置逻辑集中管理
    applyConfigField(this.config, key, value);
  }

  /**
   * 格式化配置为可读文本（委托 cliFormatter）
   *
   * @returns 格式化后的配置文本
   */
  formatConfig(): string {
    return cliFormatter.formatConfig(this.config);
  }

  // ─── 记忆仪表盘（委托 MemoryController） ──────────────

  /**
   * 获取记忆仪表盘数据
   *
   * @returns 仪表盘数据（总数、按来源分组、推荐列表）
   */
  dashboard(): DashboardData {
    const data = this.memoryController.dashboard();
    // Phase 2.3：检测里程碑事件并注入主动提示队列
    // 纯计算，幂等保护，空数据时静默
    this.proactiveEngine.checkMilestones(data);
    return data;
  }

  /**
   * 主动检查待提示事件并尝试发射（QC-SPRITE-06）
   *
   * 委托至 ProactiveEngine.checkPending()，用于外部主动触发"用户回来时检查"。
   * 与 addNotice 内部的自动触发（累积达阈值时）不同，此方法无视阈值，
   * 只要 pendingNotices 非空且不在冷却期就发射。
   *
   * 使用场景：
   *   1. 用户从托盘回来时，UI 调用此方法检查是否有累积的待提示事件
   *   2. 里程碑检测后，dashboard() 仅 addNotice 不自动触发，需外部主动检查
   *
   * 受 silentMode 和 cooldownMs 约束，与自动触发行为一致。
   */
  checkPending(): void {
    this.proactiveEngine.checkPending();
  }

  /**
   * 评估默契度等级（Phase 2.2）
   *
   * 委托至 MemoryController.rapportLevel()，从仪表盘数据实时推导。
   * 纯代码计算，不依赖 LLM，不持久化。
   *
   * @returns 默契度评估结果（等级 + 描述 + 影响因素）
   */
  rapportLevel(): RapportAssessment {
    return this.memoryController.rapportLevel();
  }

  /**
   * 记忆源健康诊断
   *
   * 委托至 Agent.sourceHealth()，为每个 source 计算健康指标
   * （数量、平均 score、新鲜度、healthy/warning/critical 状态）。
   * 宿主项目可据此判断是否需要触发衰减、清理或补充。
   */
  sourceHealth() {
    if (!this.agent) {
      return null;
    }
    return this.agent.memory?.sourceHealth() ?? null;
  }

  /**
   * 获取 Agent 运行时指标快照（OBS-01 可观测性对齐）
   *
   * 委托至 Agent.getMetrics()，返回 5 维度指标（llm/recall/tools/context/decay）。
   * 供宿主项目仪表盘展示 LLM 调用次数、token 数、召回命中率、工具失败率等。
   *
   * @returns AgentMetrics 完整快照，Agent 未就绪时返回全零指标
   */
  getMetrics(): AgentMetrics {
    return this.agent.getMetrics();
  }

  /** FD-03 累积事件数（供 UI 仪表盘显示） */
  get pendingCount(): number {
    return this.proactiveEngine.pendingCount;
  }

  /** FD-03 主动提示阈值（供 UI 仪表盘显示） */
  get proactiveThreshold(): number {
    return this.config.proactiveThreshold;
  }

  /** FD-03 已注册触发器列表（供 UI 仪表盘显示） */
  get registeredTriggers(): string[] {
    return this.triggerBus.registeredTriggers;
  }

  /**
   * Phase 2.1：记录用户接受了一次主动提示
   *
   * 由宿主 UI 在用户点击"查看"按钮时调用。
   * 调用后重新推导情感基调（主动度会随接受率提升），并发射 affectUpdated 事件。
   */
  recordProactiveAccept(): void {
    this.proactiveEngine.recordAccept();
    // 重新推导情感基调，更新主动度并注入 system prompt
    const prompt = this.deriveAndInjectAffect();
    if (prompt) {
      this.agent.injectAffect(prompt);
    }
    logger.info({ acceptanceRate: this.proactiveEngine.acceptanceRate }, '用户接受主动提示');
  }

  /**
   * Phase 2.1：记录用户拒绝/忽略了一次主动提示
   *
   * 由宿主 UI 在用户点击"稍后"、关闭 banner 或静默时调用。
   * 调用后更新连续拒绝计数（自适应冷却），但不立即重新推导 affect（拒绝只影响冷却，不直接降低主动度）。
   */
  recordProactiveReject(): void {
    this.proactiveEngine.recordReject();
    logger.info('用户拒绝主动提示');
  }

  /**
   * 格式化仪表盘为可读文本（委托 cliFormatter）
   *
   * @returns 格式化后的仪表盘文本
   */
  formatDashboard(): string {
    return cliFormatter.formatDashboard(
      this.memoryController.dashboard(),
      this.proactiveEngine.pendingCount,
      this.config.proactiveThreshold,
      this.triggerBus.registeredTriggers,
    );
  }

  // ─── Agent 事件订阅 ────────────────────────────────────

  /** 订阅 Agent 事件，转发为精灵事件 */
  private subscribeAgentEvents(): void {
    // memoryAdded → memoryNoticed
    const onMemoryAdded = (e: AgentEventMap['memoryAdded']) => {
      this.emitSprite('memoryNoticed', { source: e.source, name: e.name });
      this.proactiveEngine.addNotice('memory', `[${e.source}] ${e.name}`);
      logger.info({ source: e.source, name: e.name }, '注意到新记忆');
    };
    this.agentHandlers.memoryAdded = onMemoryAdded;
    this.agent.on('memoryAdded', onMemoryAdded);

    // personaSwitched → personaChanged
    const onPersonaSwitched = (e: AgentEventMap['personaSwitched']) => {
      this.emitSprite('personaChanged', { from: e.from, to: e.to });
      this.proactiveEngine.addNotice('persona', `${e.from ?? '(无)'} → ${e.to}`);
      // Phase 2.1：角色切换后重新推导情感基调（traits 可能不同）并注入 system prompt
      const prompt = this.deriveAndInjectAffect();
      if (prompt) {
        this.agent.injectAffect(prompt);
      }
      logger.info({ from: e.from, to: e.to }, '角色切换');
    };
    this.agentHandlers.personaSwitched = onPersonaSwitched;
    this.agent.on('personaSwitched', onPersonaSwitched);

    // insightExtracted → insightGained
    const onInsightExtracted = (e: AgentEventMap['insightExtracted']) => {
      this.emitSprite('insightGained', { source: e.source, insight: e.insight });
      this.proactiveEngine.addNotice('insight', e.insight);
      logger.info({ insight: e.insight }, '获得洞察');
    };
    this.agentHandlers.insightExtracted = onInsightExtracted;
    this.agent.on('insightExtracted', onInsightExtracted);

    // L5：项目切换 → projectSwitched
    // 用户在专注模式切换项目时，UI 可显示"已切换到 XXX 项目"通知
    const onProjectSwitched = (e: AgentEventMap['projectSwitched']) => {
      this.emitSprite('projectSwitched', {
        from: e.from,
        to: e.to,
        projectName: e.projectName,
      });
      logger.info({ from: e.from, to: e.to, projectName: e.projectName }, '项目切换');
    };
    this.agentHandlers.projectSwitched = onProjectSwitched;
    this.agent.on('projectSwitched', onProjectSwitched);

    // L5：技能匹配 → skillMatched
    // 当 Agent 调用技能时通知 UI（用于"匹配到技能 X"提示）
    const onSkillMatched = (e: AgentEventMap['skillMatched']) => {
      this.emitSprite('skillMatched', { skill: e.skill, score: e.score });
      logger.debug({ skill: e.skill, score: e.score }, '技能匹配');
    };
    this.agentHandlers.skillMatched = onSkillMatched;
    this.agent.on('skillMatched', onSkillMatched);

    // L5：记忆召回 → memoryRecalled
    // 每次对话召回记忆时触发，UI 可显示"想起 X 条记忆"提示
    const onMemoryRecalled = (e: AgentEventMap['memoryRecalled']) => {
      this.emitSprite('memoryRecalled', { count: e.count, query: e.query });
    };
    this.agentHandlers.memoryRecalled = onMemoryRecalled;
    this.agent.on('memoryRecalled', onMemoryRecalled);

    // L5：衰减完成 → decayCompleted
    // 每小时定时衰减触发，UI 可显示"已衰减 N 条记忆"通知（24h 节流避免噪音）
    const onDecayCompleted = (e: AgentEventMap['decayCompleted']) => {
      this.emitSprite('decayCompleted', { decayedCount: e.decayedCount });
      logger.info({ decayedCount: e.decayedCount }, '记忆衰减完成');
    };
    this.agentHandlers.decayCompleted = onDecayCompleted;
    this.agent.on('decayCompleted', onDecayCompleted);
  }

  /** 取消订阅 Agent 事件 */
  private unsubscribeAgentEvents(): void {
    // P2-004 修复：直接枚举每个事件，避免 Object.entries + as never 的类型安全问题。
    // Object.entries 会丢失 key-value 类型关联，导致 agent.off 的参数类型不匹配需要 as never。
    // 显式枚举每个事件，TypeScript 可为每个 agent.off 调用精确推断事件名和 handler 的对应类型。
    if (this.agentHandlers.memoryAdded) {
      this.agent.off('memoryAdded', this.agentHandlers.memoryAdded);
    }
    if (this.agentHandlers.personaSwitched) {
      this.agent.off('personaSwitched', this.agentHandlers.personaSwitched);
    }
    if (this.agentHandlers.insightExtracted) {
      this.agent.off('insightExtracted', this.agentHandlers.insightExtracted);
    }
    // L5：迭代 9 补齐的 4 种事件清理
    if (this.agentHandlers.projectSwitched) {
      this.agent.off('projectSwitched', this.agentHandlers.projectSwitched);
    }
    if (this.agentHandlers.skillMatched) {
      this.agent.off('skillMatched', this.agentHandlers.skillMatched);
    }
    if (this.agentHandlers.memoryRecalled) {
      this.agent.off('memoryRecalled', this.agentHandlers.memoryRecalled);
    }
    if (this.agentHandlers.decayCompleted) {
      this.agent.off('decayCompleted', this.agentHandlers.decayCompleted);
    }
    this.agentHandlers = {};
  }

  // ─── 触发器处理 ────────────────────────────────────────

  /**
   * 推导情感基调，返回 prompt 文本（不再直接注入，由 refreshPerceptionBeforeChat 统一注入）
   *
   * 副作用：更新 lastAffect 缓存、发射 affectUpdated 事件、推导默契度+上下文
   */
  private deriveAndInjectAffect(): string {
    // 更新 AffectController 配置（角色 + 接受率）
    this.affectController.updateOptions({
      acceptanceRate: this.proactiveEngine.acceptanceRate,
      currentPersona: this.agent.persona?.getActive() ?? null,
    });

    // 获取所有记忆用于推导（上限 1000 条，MemoryInspector.list 按 score 降序）
    const memories = this.agent.memory?.list(1000) ?? [];
    let affect = this.affectController.deriveAffect(memories);

    // Phase 2.2：对话语气实时分析——从最近用户消息推导语气修正值，平滑融合
    if (this.recentUserMessages.length > 0) {
      const delta = AffectController.deriveAffectFromMessages(this.recentUserMessages);
      affect = AffectController.blendAffect(affect, delta);
    }

    this.lastAffect = affect; // Phase 1+2：缓存供 ProactiveEngine 注入

    // 发射情感基调更新事件（供 UI 仪表盘展示）
    this.emitSprite('affectUpdated', affect);

    // 生成情感描述文本（不再直接注入，由调用方统一注入）
    const affectPrompt = this.affectController.buildAffectPrompt(affect);

    // Phase 3：同时推导默契度（返回 prompt 文本）
    const rapportPrompt = this.deriveAndInjectRapport();

    // Phase 4：同时推导对话上下文（返回 prompt 文本）
    const contextPrompt = this.deriveAndInjectContext();

    // 累积所有提示文本，用空行分隔
    return [affectPrompt, rapportPrompt, contextPrompt].filter(Boolean).join('\n\n');
  }

  /**
   * 推导默契度，返回 prompt 文本（不再直接注入，由 refreshPerceptionBeforeChat 统一注入）
   *
   * 副作用：更新 lastRapport 缓存、发射 rapportUpdated 事件
   */
  private deriveAndInjectRapport(): string {
    // 获取所有记忆用于推导
    const memories = this.agent.memory?.list(DEFAULT_LIST_LIMIT) ?? [];

    // 计算交互天数（从最早记忆的创建时间推算）
    const interactionDays = this.calculateInteractionDays(memories);

    // 更新 RapportController 配置
    this.rapportController.updateOptions({
      acceptanceRate: this.proactiveEngine.acceptanceRate,
      interactionDays,
      totalMessages: this.agent.getMetrics?.().llm.callCount ?? 0,
      sourceDiversity: new Set(memories.map((m) => m.source)).size,
    });

    const rapport = this.rapportController.deriveRapport(memories);
    this.lastRapport = rapport; // Phase 1+2：缓存供 ProactiveEngine 注入

    // 发射默契度更新事件（供 UI 仪表盘展示）
    this.emitSprite('rapportUpdated', rapport);

    // 生成默契度描述文本（不再直接注入，由调用方统一注入）
    return this.rapportController.buildRapportPrompt(rapport);
  }

  /**
   * 计算交互天数（从最早记忆的创建时间推算）
   *
   * @param memories 记忆列表
   * @returns 交互天数（最早记忆距今的天数）
   */
  private calculateInteractionDays(memories: Memory[]): number {
    if (memories.length === 0) return 0;
    const oldestTimestamp = memories.reduce((min, m) => {
      const ts = new Date(m.createdAt).getTime();
      return ts < min ? ts : min;
    }, Date.now());
    return Math.floor((Date.now() - oldestTimestamp) / MS_PER_DAY);
  }

  /**
   * 推导对话上下文，返回 prompt 文本（不再直接注入，由 refreshPerceptionBeforeChat 统一注入）
   *
   * 副作用：发射 contextUpdated 事件、注入 ProactiveEngine、检测模式
   */
  private deriveAndInjectContext(): string {
    // 获取所有记忆用于推导
    const memories = this.agent.memory?.list(1000) ?? [];

    const context = this.contextAwareness.deriveContext(memories);

    // 发射对话上下文更新事件（供 UI 仪表盘展示）
    this.emitSprite('contextUpdated', context);

    // Phase 1+2：将感知数据注入 ProactiveEngine，实现智能触发和个性化提示
    this.injectPerceptionToProactiveEngine(context);

    // Phase 2+：检测记忆模式并返回 pattern prompt
    const patternPrompt = this.detectAndInjectPatterns(memories);

    // 生成上下文感知描述文本（不再直接注入，由调用方统一注入）
    const contextPrompt = this.contextAwareness.buildContextPrompt(context);

    return [contextPrompt, patternPrompt].filter(Boolean).join('\n\n');
  }

  /**
   * 将感知系统推导结果注入 ProactiveEngine（Phase 1+2）
   *
   * 使 ProactiveEngine 能够根据：
   *   - context.rhythm → 决定触发时机（快节奏静默，空闲更主动）
   *   - rapport.trust → 调整冷却时间（高信任 → 短冷却）
   *   - affect → 个性化提示语气（温暖/调皮/直接）
   *
   * 在 deriveAndInjectContext() 末尾调用，确保三个感知系统都已推导完成。
   */
  private injectPerceptionToProactiveEngine(context: ContextState): void {
    this.proactiveEngine.setContextState(context);
    if (this.lastRapport) {
      this.proactiveEngine.setRapportLevel(this.lastRapport.trust);
    }
    if (this.lastAffect) {
      this.proactiveEngine.setAffectState(this.lastAffect);
    }
  }

  /**
   * 检测记忆模式，返回 prompt 文本（不再直接注入，由 refreshPerceptionBeforeChat 统一注入）
   *
   * 副作用：注入 ProactiveEngine、发射 patternsUpdated 事件
   *
   * @param memories 所有记忆列表
   * @returns 模式洞察 prompt 文本，无模式时返回空字符串
   */
  private detectAndInjectPatterns(memories: Memory[]): string {
    const patterns = this.patternDetector.detectPatterns(memories);
    this.proactiveEngine.setPatterns(patterns);

    // 发射模式更新事件（供 UI 洞察面板展示）
    if (patterns.length > 0) {
      this.emitSprite('patternsUpdated', { patterns });
    }

    // 将模式洞察返回（不再直接注入，由调用方统一注入）
    return this.patternDetector.buildPatternPrompt(patterns) ?? '';
  }

  /**
   * 对话前刷新全量感知，确保 LLM 拿到最新状态
   *
   * 每次 wakeup() 对话前调用，重新推导并一次性注入所有感知提示。
   * 之前因各方法独立调用 injectAffect 导致相互覆盖（仅最后生效），
   * 现已改为累积所有 prompt 统一注入。
   *
   * 注入内容：
   *   1. 情感基调（AffectController）
   *   2. 默契度（RapportController）
   *   3. 对话上下文（ContextAwareness）
   *   4. 用户模式（PatternDetector）
   *   5. 里程碑信号（ProactiveEngine）
   *   6. 跨会话上下文（新）
   */
  private refreshPerceptionBeforeChat(): void {
    // 收集所有感知提示文本
    const prompts: string[] = [];

    // 1-4. 情感基调 + 默契度 + 对话上下文 + 用户模式（链式推导）
    const perceptionPrompt = this.deriveAndInjectAffect();
    if (perceptionPrompt) {
      prompts.push(perceptionPrompt);
    }

    // 5. 里程碑信号（若有待处理的里程碑事件）
    const milestonePrompt = this.getMilestonePrompt();
    if (milestonePrompt) {
      prompts.push(milestonePrompt);
    }

    // 6. 跨会话上下文（检测到长时间间隔时注入上次对话摘要）
    const crossSessionPrompt = this.getCrossSessionContext();
    if (crossSessionPrompt) {
      prompts.push(crossSessionPrompt);
    }

    // 一次性注入所有提示，避免相互覆盖
    if (prompts.length > 0) {
      this.agent.injectAffect(prompts.join('\n\n'));
    }
  }

  /**
   * 获取里程碑提示文本（不再直接注入，由 refreshPerceptionBeforeChat 统一注入）
   *
   * 当 ProactiveEngine 中有待处理的里程碑事件时，
   * 告知 LLM 这是一个值得庆祝/提及的特殊时刻。
   * 里程碑是一次性信号：对话时注入，UI banner 独立展示，互不干扰。
   *
   * @returns 里程碑 prompt 文本，无里程碑时返回空字符串
   */
  private getMilestonePrompt(): string {
    const milestones = this.proactiveEngine.peekPendingMilestones();
    if (milestones.length === 0) return '';

    const lines: string[] = ['【里程碑时刻】我们刚刚达成了一个值得注意的里程碑：'];
    for (const m of milestones) {
      lines.push(`- ${m}`);
    }
    lines.push('→ 这是我们关系中的一个小节点，可以自然地提及或庆祝，但不要刻意生硬');
    return lines.join('\n');
  }

  /**
   * 获取跨会话上下文提示（A1 新功能）
   *
   * 当用户距离上次交互超过 1 小时时，从记忆系统中提取最近的关键记忆，
   * 生成"上次聊到..."上下文，让 LLM 能够自然地接续对话。
   *
   * 纯代码计算，不依赖 LLM。不直接注入，由 refreshPerceptionBeforeChat 统一注入。
   *
   * @returns 跨会话上下文 prompt 文本，间隔不足 1 小时或无历史时返回空字符串
   */
  private getCrossSessionContext(): string {
    const lastInteraction = this.agent.lastInteractionAt;
    if (!lastInteraction) return ''; // 首次交互，无历史

    const gapMs = Date.now() - lastInteraction.getTime();

    if (gapMs < MS_PER_HOUR) return ''; // 间隔太短，不需要跨会话上下文

    // 获取最近的记忆（按创建时间排序，最新的在前）
    const memories = this.agent.memory?.list(50) ?? [];
    if (memories.length === 0) return '';

    // 提取上次交互以来的记忆
    const recentMemories = memories.filter((m) => {
      const createdMs = new Date(m.createdAt).getTime();
      return (Date.now() - createdMs) < gapMs + MS_PER_HOUR * 2;
    });

    // 取最近 5 条关键记忆作为上下文
    const keyMemories = recentMemories.slice(0, 5);
    if (keyMemories.length === 0) return '';

    // 生成时间间隔描述
    const gapHours = Math.round(gapMs / MS_PER_HOUR);
    const gapText = gapHours < 24
      ? `${gapHours} 小时`
      : `${Math.round(gapHours / 24)} 天`;

    const lines: string[] = [
      `【跨会话上下文】距离上次对话已经过了 ${gapText}。以下是上次对话中涉及的关键信息，你可能想自然地提及或追问：`,
    ];

    for (const mem of keyMemories) {
      const label = mem.source === 'profile' ? '用户信息'
        : mem.source === 'insight' ? '洞察'
        : '记忆';
      // 取 content 前 80 字作为摘要
      const preview = (mem.content ?? '').substring(0, 80);
      lines.push(`- [${label}] ${mem.name}: ${preview}`);
    }

    lines.push('→ 如果合适，可以自然地提及或追问这些内容，让对话有连续感。但不要生硬地列举。');
    return lines.join('\n');
  }

  /**
   * 基于健康度数据生成智能建议（Phase 3）
   *
   * 在每次触发器唤醒时调用，检测可操作问题并注入 ProactiveEngine 待提示队列。
   * 纯代码计算，不依赖 LLM。ProactiveEngine 的智能触发时机（Phase 1）会
   * 决定何时实际展示给用户。
   *
   * 检测类型：
   *   1. 重复记忆 → 建议清理
   *   2. 过期记忆 → 建议回顾
   *   3. 用户画像缺失 → 建议补充
   *
   * 幂等保护：ProactiveEngine 的冷却机制自然防止重复提示。
   */
  private generateSmartSuggestions(): void {
    try {
      const health = this.memoryController.getHealthDashboard();

      // 检测重复记忆（超过 1 组时建议清理）
      const dupCount = health.duplicates.reduce((sum, g) => sum + g.memories.length, 0);
      if (dupCount > 0) {
        this.proactiveEngine.addNotice('suggestion', `发现 ${dupCount} 条重复记忆，建议清理以保持记忆库整洁`);
      }

      // 检测过期记忆（超过 5 条时建议回顾）
      if (health.staleMemories.length > 5) {
        this.proactiveEngine.addNotice('suggestion', `有 ${health.staleMemories.length} 条记忆可能已过时，需要回顾一下吗？`);
      }

      // 检测用户画像是否缺失（profile 记忆为 0 时建议补充）
      const dashboard = this.memoryController.dashboard();
      const profileCount = dashboard.bySource['profile'] ?? 0;
      if (profileCount === 0 && health.totalMemories > 10) {
        this.proactiveEngine.addNotice('suggestion', '还没有用户画像，告诉我更多关于你的信息吧，这样我能更好地帮助你');
      }
    } catch (err) {
      // 健康度诊断失败不应阻塞触发流程
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, '智能建议生成失败');
    }
  }

  /** 处理触发器事件 */
  private handleTrigger(payload: TriggerPayload): void {
    if (this.state !== 'idle') return;

    // P2-S6: 触发器响应是精灵主路径，记录 span 用于触发频率与耗时追踪
    const span = this.tracer?.startSpan(SPRITE_TRACE_SPANS.TRIGGER, {
      source: payload.source,
      reason: payload.reason,
    });
    try {
      if (payload.source === 'fileWatcher') {
        // 文件变化触发：累积为 file 事件类型
        this.proactiveEngine.addNotice('file', payload.reason);
        logger.info({ reason: payload.reason, source: payload.source }, '文件变化触发');

        // H3：文件变化→作品投影更新
        // 从 reason 中提取文件名，检查是否有已存在的投影，有则触发生成
        this.tryUpdateWorkProjection(payload.reason);
      } else {
        // 定时触发
        logger.info({ reason: payload.reason, source: payload.source }, '触发唤醒');
      }

      // 触发时检查是否有待提示的累积事件（由 ProactiveEngine 内部处理）
      // P1-9 修复：移除全量 dashboard 计算 debug 日志——logger 不支持惰性求值，
      // 每次触发都计算 dashboard（含 memory.stats + suggest）是性能热点。
      // 触发事件已由上方 logger.info 记录，dashboard 可通过 sprite.formatDashboard() 主动查询。

      // Phase 3：智能建议生成 — 基于健康度数据检测可操作问题
      this.generateSmartSuggestions();
    } catch (err) {
      span?.recordException(err instanceof Error ? err : new Error(String(err)));
      // P2-ERR-02 移除 rethrow：事件处理器中 rethrow 是反模式
      // emit() 已有 try/catch 兜底，此处仅记录异常即可
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg, source: payload.source }, '触发器处理异常');
    } finally {
      span?.end();
    }
  }

  /**
   * H3 尝试更新作品投影（文件变化触发）
   *
   * 从 FileWatcher 的 reason 中提取文件名，检查该文件是否已有投影记录。
   * 如果已有投影，则读取最新文件内容，调用 ensureProjection 触发 hash 比对和
   * 可能的重新生成（hash 检查在内核 WorkProjectionManager 中完成，只在内容真正
   * 变化时调用 LLM）。
   *
   * 设计决策：只更新已有投影的文件，不对所有变化文件都生成投影——避免对
   * node_modules、.git 等无关文件无意义地调用 LLM。首次投影由 read_file 工具
   * 调用或启动时最小投影覆盖。
   *
   * 预后更新通过 emitSprite('workProjectionUpdated') 通知宿主 UI。
   *
   * @param reason FileWatcher 的 reason 字符串，格式："文件变化：filename（eventType）"
   */
  private tryUpdateWorkProjection(reason: string): void {
    const works = this.agent.works;
    if (!works) return;

    // 从 reason 中提取文件名（格式："文件变化：filename（eventType）"）
    const match = reason.match(/文件变化：(.+?)（/);
    if (!match || !match[1]) return;

    const filename = match[1];
    // 构造完整路径（fileWatcher 的 reason 是相对路径，拼接 projectPath）
    const fullPath = resolve(this.projectPath, filename);

    // 异步执行：不阻塞触发器处理主流程
    (async () => {
      try {
        // 1. 检查文件是否存在（删除/移动事件可能导致文件不存在）
        if (!existsSync(fullPath)) {
          return;
        }

        // 2. 先检查是否已有投影——只更新已有投影的文件，避免对无关文件做 LLM 调用
        const existing = await works.getProjection(fullPath);
        if (!existing) {
          return;
        }

        // 3. 读取最新文件内容
        const content = await readFile(fullPath, 'utf-8');

        // 4. 调用 ensureProjection：内部 hash 比对，只在内容真正变化时重新生成
        const entry = await works.ensureProjection(fullPath, content, filename);

        // 5. 更新成功则通知 UI
        if (entry) {
          logger.info({ sourcePath: fullPath, summary: entry.summary }, '作品投影已更新');
          this.emitSprite('workProjectionUpdated', {
            sourcePath: fullPath,
            summary: entry.summary,
          });
        }
      } catch (err) {
        logger.warn({ err: toError(err).message, filePath: fullPath }, '作品投影更新失败');
      }
    })();
  }
}
