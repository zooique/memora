/**
 * 精灵主控 — 唤醒调度 + 对话管理 + 事件驱动
 *
 * 职责（拆分后）：
 *   1. 监听触发器事件，决定是否唤醒精灵
 *   2. 唤醒后启动对话交互
 *   3. 管理精灵状态（idle / active / sleeping）
 *   4. 配置持久化
 *   5. 订阅 Agent 事件，委托 Controller 处理具体逻辑
 *
 * 设计原则（ADR-SP-004）：
 *   上下文感知而非内容感知——精灵通过文件变化、时间等上下文信号唤醒，
 *   不监听键盘输入内容。
 */
import type { Agent, AgentEventMap } from 'memora';
import type { VectorStore } from 'memora';
import { logger, toError } from 'memora';
import { resolve } from 'node:path';
import { TriggerBus, TimerTrigger } from './triggers.js';
import type { TriggerPayload } from './triggers.js';
import { FileWatcherTrigger } from './fileWatcherTrigger.js';
import type { IInteraction } from './interaction.js';
import { loadSpriteConfig, saveSpriteConfig } from './spriteConfig.js';
import type { SpriteConfig, SpriteConfigKey } from './spriteConfig.js';
import { MemoryController, PersonaController, ProactiveEngine } from './controllers/index.js';
import type { DashboardData } from './controllers/index.js';

/** 精灵状态 */
export type SpriteState = 'idle' | 'active' | 'sleeping';

/** 精灵事件载荷 — 宿主 UI 可订阅 */
export interface SpriteEventMap {
  /** 精灵注意到新记忆（insight/profile/guardrail 等） */
  memoryNoticed: { source: string; name: string };
  /** 精灵注意到角色切换 */
  personaChanged: { from: string | null; to: string };
  /** 精灵注意到洞察提取 */
  insightGained: { source: string; insight: string };
  /** 定时触发器唤醒 */
  timerTriggered: { reason: string };
  /** 精灵主动提示（累积事件后生成） */
  proactivePrompt: { prompt: string; triggers: string[]; silent: boolean };
}

// 重新导出 DashboardData 供外部使用
export type { DashboardData };

/** 毫秒/分钟转换常量（用于格式化显示） */
const MS_PER_MINUTE = 60_000;

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
  private agentHandlers: Partial<{ [K in keyof AgentEventMap]: (e: AgentEventMap[K]) => void }> =
    {};
  /** 项目路径（用于 FileWatcherTrigger 的默认监听目录） */
  private projectPath: string;

  // ─── 配置持久化 ────────────────────────────────────────
  private dataDir: string;
  private config: Required<SpriteConfig>;

  // ─── 控制器 ──────────────────────────────────────────────
  private memoryController: MemoryController;
  private personaController: PersonaController;
  private proactiveEngine: ProactiveEngine;

  constructor(
    agent: Agent,
    dataDir: string,
    projectPath?: string,
    vectorStore?: VectorStore,
    interaction?: IInteraction,
  ) {
    this.agent = agent;
    this.dataDir = dataDir;
    this.projectPath = projectPath ?? dataDir;
    this.config = loadSpriteConfig(dataDir);
    this.triggerBus = new TriggerBus();
    this.triggerBus.register(new TimerTrigger(this.config.triggerIntervalMs));

    // 初始化控制器
    this.memoryController = new MemoryController(agent, vectorStore);
    this.personaController = new PersonaController(agent);
    this.proactiveEngine = new ProactiveEngine({
      threshold: this.config.proactiveThreshold,
      cooldownMs: this.config.proactiveCooldownMs,
      silentMode: this.config.silentMode,
    });

    // 设置主动提示引擎的发射器和交互层
    this.proactiveEngine.setEmitter((event, payload) => {
      this.emitSprite(event, payload);
    });
    if (interaction) {
      this.proactiveEngine.setInteraction(interaction);
    }

    // 注册文件监听触发器（默认启用）
    if (this.config.fileWatcherEnabled) {
      this.registerFileWatcher();
    }
  }

  /** 注册 FileWatcherTrigger */
  private registerFileWatcher(): void {
    const watchPaths = this.config.fileWatcherPaths.map((p) => resolve(this.projectPath, p));
    this.triggerBus.register(
      new FileWatcherTrigger({
        watchPaths,
        ignore: this.config.fileWatcherIgnore,
        debounceMs: this.config.fileWatcherDebounceMs,
      }),
    );
  }

  /** 设置交互层（可在构造后注入，为 Electron 铺路） */
  setInteraction(interaction: IInteraction): void {
    this.proactiveEngine.setInteraction(interaction);
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
      } catch (err) {
        logger.warn({ event, err: toError(err).message }, '宿主事件处理器异常');
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

  /** 获取当前状态 */
  getState(): SpriteState {
    return this.state;
  }

  /** 手动唤醒精灵 */
  async wakeup(input: string): Promise<string> {
    this.state = 'active';
    try {
      return await this.agent.chatSync(input);
    } finally {
      this.state = 'idle';
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

  /** 切换角色 */
  switchPersona(name: string): string | null {
    return this.personaController.switch(name);
  }

  /** 设置角色匹配模式 */
  setPersonaMode(mode: 'auto' | 'manual'): boolean {
    return this.personaController.setMode(mode);
  }

  /** 获取当前角色匹配模式 */
  get personaMode(): string {
    return this.personaController.currentMode;
  }

  /** 格式化角色列表为可读文本 */
  formatPersonas(): string {
    return this.personaController.format();
  }

  // ─── 记忆管理（委托 MemoryController） ──────────────────

  /** 列出记忆（可按 source 过滤） */
  listMemories(
    source?: string,
    limit = 50,
  ): { id: string; name: string; source: string; score: number; contentPreview: string }[] {
    return this.memoryController.list(source, limit);
  }

  /** 查看单条记忆详情 */
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

  /** 删除记忆 */
  deleteMemory(id: string): boolean {
    return this.memoryController.delete(id);
  }

  /** 添加或更新记忆 */
  upsertMemory(source: string, name: string, content: string, score = 0.5): string {
    return this.memoryController.upsert(source, name, content, score);
  }

  /** 混合搜索记忆 */
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
   */
  updateConfig(key: SpriteConfigKey, value: unknown): void {
    this.setConfigField(key, value);
    saveSpriteConfig(this.dataDir, { [key]: value });

    // 特殊处理：触发器间隔变更时重建 TimerTrigger
    if (key === 'triggerIntervalMs' && typeof value === 'number') {
      this.triggerBus.unregister('timer');
      this.triggerBus.register(new TimerTrigger(value));
      if (this.running) {
        this.triggerBus.stop();
        this.triggerBus.start();
      }
    }

    // 特殊处理：文件监听配置变更时重建 FileWatcherTrigger
    if (key === 'fileWatcherEnabled') {
      this.triggerBus.unregister('fileWatcher');
      if (value === true) {
        this.registerFileWatcher();
      }
      if (this.running) {
        this.triggerBus.stop();
        this.triggerBus.start();
      }
    }

    if (
      key === 'fileWatcherPaths' ||
      key === 'fileWatcherIgnore' ||
      key === 'fileWatcherDebounceMs'
    ) {
      if (this.config.fileWatcherEnabled) {
        this.triggerBus.unregister('fileWatcher');
        this.registerFileWatcher();
        if (this.running) {
          this.triggerBus.stop();
          this.triggerBus.start();
        }
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
  }

  /**
   * 类型安全地设置配置字段
   *
   * 通过运行时类型检查将 unknown 类型的 value 写入对应类型的配置字段，
   * 替代原有的 `(this.config as Record<string, unknown>)[key] = value` 类型断言。
   * 不符合类型的 value 会被忽略（保持原值），由调用方保证传入正确类型。
   */
  private setConfigField(key: SpriteConfigKey, value: unknown): void {
    // 数值类型字段
    if (
      key === 'triggerIntervalMs' ||
      key === 'proactiveCooldownMs' ||
      key === 'fileWatcherDebounceMs'
    ) {
      if (typeof value === 'number') {
        this.config[key] = value;
      }
      return;
    }
    // 整数类型字段
    if (key === 'proactiveThreshold') {
      if (typeof value === 'number') {
        this.config[key] = value;
      }
      return;
    }
    // 布尔类型字段
    if (key === 'silentMode' || key === 'fileWatcherEnabled' || key === 'floatIconVisible') {
      if (typeof value === 'boolean') {
        this.config[key] = value;
      }
      return;
    }
    // 字符串类型字段
    if (key === 'defaultPersona') {
      if (typeof value === 'string') {
        this.config[key] = value;
      }
      return;
    }
    // 字符串数组类型字段
    if (key === 'fileWatcherPaths' || key === 'fileWatcherIgnore') {
      if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
        this.config[key] = value;
      }
      return;
    }
    // 对象类型字段
    if (key === 'floatIconPosition') {
      if (typeof value === 'object' && value !== null && 'x' in value && 'y' in value) {
        this.config[key] = value as { x: number; y: number };
      }
      return;
    }
    // 枚举类型字段
    if (key === 'windowState') {
      if (value === 'tray' || value === 'float' || value === 'full') {
        this.config[key] = value;
      }
      return;
    }
  }

  /** 格式化配置为可读文本 */
  formatConfig(): string {
    const lines: string[] = ['── 精灵配置 ──'];
    lines.push(`  触发器间隔：${this.config.triggerIntervalMs / MS_PER_MINUTE} 分钟`);
    lines.push(`  默认角色：${this.config.defaultPersona || '(未设置)'}`);
    lines.push(`  静默模式：${this.config.silentMode ? '开启' : '关闭'}`);
    lines.push(`  主动提示阈值：${this.config.proactiveThreshold} 个事件`);
    lines.push(`  主动提示冷却：${this.config.proactiveCooldownMs / MS_PER_MINUTE} 分钟`);
    lines.push(`  文件监听：${this.config.fileWatcherEnabled ? '开启' : '关闭'}`);
    if (this.config.fileWatcherEnabled) {
      lines.push(`  监听路径：${this.config.fileWatcherPaths.join(', ')}`);
      lines.push(`  忽略模式：${this.config.fileWatcherIgnore.join(', ')}`);
      lines.push(`  防抖时间：${this.config.fileWatcherDebounceMs} 毫秒`);
    }
    return lines.join('\n');
  }

  // ─── 记忆仪表盘（委托 MemoryController） ──────────────

  /** 获取记忆仪表盘数据 */
  dashboard(): DashboardData {
    return this.memoryController.dashboard();
  }

  /** 格式化仪表盘为可读文本 */
  formatDashboard(): string {
    return this.memoryController.formatDashboard(
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
  }

  /** 取消订阅 Agent 事件 */
  private unsubscribeAgentEvents(): void {
    for (const [event, handler] of Object.entries(this.agentHandlers)) {
      if (handler) {
        this.agent.off(event as keyof AgentEventMap, handler as never);
      }
    }
    this.agentHandlers = {};
  }

  // ─── 触发器处理 ────────────────────────────────────────

  /** 处理触发器事件 */
  private handleTrigger(payload: TriggerPayload): void {
    if (this.state !== 'idle') return;

    if (payload.source === 'fileWatcher') {
      // 文件变化触发：累积为 file 事件类型
      this.proactiveEngine.addNotice('file', payload.reason);
      logger.info({ reason: payload.reason, source: payload.source }, '文件变化触发');
    } else {
      // 定时触发
      this.emitSprite('timerTriggered', { reason: payload.reason });
      logger.info({ reason: payload.reason, source: payload.source }, '触发唤醒');
    }

    // 触发时检查是否有待提示的累积事件（由 ProactiveEngine 内部处理）
    logger.debug(this.formatDashboard());
  }
}
