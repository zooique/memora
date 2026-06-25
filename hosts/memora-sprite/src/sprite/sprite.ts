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
import type { Agent, AgentEventMap, AgentMetrics } from 'memora';
import type { VectorStore, ITracer } from 'memora';
import type { PowerMonitor, App } from 'electron';
import { logger, toError } from 'memora';
import { TriggerBus, TimerTrigger } from './triggers.js';
import type { TriggerPayload } from './triggers.js';
import { FileWatcherTrigger } from './fileWatcherTrigger.js';
import { loadSpriteConfig, saveSpriteConfig, applyConfigField, type SpriteConfig, type SpriteConfigKey } from './spriteConfig.js';
import * as cliFormatter from './cli/formatter.js';
import { MemoryController, PersonaController, ProactiveEngine, PresenceController } from './controllers/index.js';
import type { DashboardData, RapportAssessment } from './controllers/index.js';
import { SPRITE_TRACE_SPANS } from './spriteTracer.js';

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
  proactivePrompt: { prompt: string; triggers: string[]; silent: boolean };
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
}

// 重新导出 DashboardData 供外部使用
export type { DashboardData };

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
  /** P2-S6: 可观测性 tracer，可选注入，为关键路径提供 span 埋点 */
  private readonly tracer: ITracer | null;

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

    logger.info('精灵已启动，等待唤醒...');
  }

  /** 停止精灵主控 */
  stop(): void {
    this.running = false;
    this.triggerBus.stop();
    this.unsubscribeAgentEvents();
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
   * 宿主只需传入 powerMonitor 和 app（Electron 模块）。
   *
   * @param powerMonitor Electron powerMonitor 模块
   * @param app Electron app 模块
   */
  bindPresence(powerMonitor: PowerMonitor, app: App): void {
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
    return this.agent.projects?.list.map((p) => ({ name: p.name, path: p.path })) ?? [];
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
    // P2-S3 重构：委托到 spriteConfig.ts 的纯函数，配置逻辑集中管理
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
      } else {
        // 定时触发
        logger.info({ reason: payload.reason, source: payload.source }, '触发唤醒');
      }

      // 触发时检查是否有待提示的累积事件（由 ProactiveEngine 内部处理）
      // P1-9 修复：移除全量 dashboard 计算 debug 日志——logger 不支持惰性求值，
      // 每次触发都计算 dashboard（含 memory.stats + suggest）是性能热点。
      // 触发事件已由上方 logger.info 记录，dashboard 可通过 sprite.formatDashboard() 主动查询。
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
}
