/**
 * 精灵主控 — 唤醒调度 + 对话管理 + 事件驱动
 *
 * 职责：
 *   1. 监听触发器事件，决定是否唤醒精灵
 *   2. 唤醒后启动对话交互
 *   3. 管理精灵状态（idle / active / sleeping）
 *   4. 提供记忆仪表盘（stats + suggest）
 *   5. 订阅 Agent 事件，主动响应记忆变化
 *
 * 设计原则（ADR-SP-004）：
 *   上下文感知而非内容感知——精灵通过文件变化、时间等上下文信号唤醒，
 *   不监听键盘输入内容。
 */
import type { Agent, AgentEventMap } from 'memora';
import type { SuggestHit } from 'memora';
import { logger } from 'memora';
import { resolve } from 'node:path';
import { TriggerBus, TimerTrigger } from './triggers.js';
import type { TriggerPayload } from './triggers.js';
import { FileWatcherTrigger } from './fileWatcherTrigger.js';
import type { IInteraction } from './interaction.js';
import {
  loadSpriteConfig,
  saveSpriteConfig,
} from './spriteConfig.js';
import type { SpriteConfig, SpriteConfigKey } from './spriteConfig.js';

/** 精灵状态 */
export type SpriteState = 'idle' | 'active' | 'sleeping';

/** 仪表盘数据 */
export interface DashboardData {
  /** 记忆总数 */
  total: number;
  /** 按来源分组的记忆数量 */
  bySource: Record<string, number>;
  /** 关联推荐列表 */
  suggestions: SuggestHit[];
}

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
  proactivePrompt: { prompt: string; triggers: string[] };
}

/** 待提示事件 */
interface PendingNotice {
  type: string;
  summary: string;
  timestamp: number;
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
  private agentHandlers: Partial<{ [K in keyof AgentEventMap]: (e: AgentEventMap[K]) => void }> = {};
  /** 交互层（可选，用于主动提示输出） */
  private interaction: IInteraction | null = null;
  /** 项目路径（用于 FileWatcherTrigger 的默认监听目录） */
  private projectPath: string;

  // ─── 配置持久化 ────────────────────────────────────────
  private dataDir: string;
  private config: Required<SpriteConfig>;

  // ─── 主动行为 ──────────────────────────────────────────
  /** 待提示事件队列 */
  private pendingNotices: PendingNotice[] = [];
  /** 上次主动提示时间戳 */
  private lastProactiveAt = 0;

  constructor(agent: Agent, dataDir: string, projectPath?: string, interaction?: IInteraction) {
    this.agent = agent;
    this.dataDir = dataDir;
    this.projectPath = projectPath ?? dataDir;
    this.interaction = interaction ?? null;
    this.config = loadSpriteConfig(dataDir);
    this.triggerBus = new TriggerBus();
    this.triggerBus.register(new TimerTrigger(this.config.triggerIntervalMs));

    // 注册文件监听触发器（默认启用）
    if (this.config.fileWatcherEnabled) {
      this.registerFileWatcher();
    }
  }

  /** 注册 FileWatcherTrigger */
  private registerFileWatcher(): void {
    const watchPaths = this.config.fileWatcherPaths.map(p =>
      resolve(this.projectPath, p),
    );
    this.triggerBus.register(new FileWatcherTrigger({
      watchPaths,
      ignore: this.config.fileWatcherIgnore,
      debounceMs: this.config.fileWatcherDebounceMs,
    }));
  }

  /** 设置交互层（可在构造后注入，为 Electron 铺路） */
  setInteraction(interaction: IInteraction): void {
    this.interaction = interaction;
  }

  // ─── 精灵事件系统（宿主 UI 可订阅） ──────────────────────

  /** 订阅精灵事件 */
  on<K extends keyof SpriteEventMap & string>(event: K, handler: (event: SpriteEventMap[K]) => void): void {
    let set = this.spriteHandlers.get(event);
    if (!set) {
      set = new Set();
      this.spriteHandlers.set(event, set);
    }
    set.add(handler as (event: unknown) => void);
  }

  /** 取消订阅精灵事件 */
  off<K extends keyof SpriteEventMap & string>(event: K, handler: (event: SpriteEventMap[K]) => void): void {
    this.spriteHandlers.get(event)?.delete(handler as (event: unknown) => void);
  }

  /** 发射精灵事件 */
  private emitSprite<K extends keyof SpriteEventMap & string>(event: K, payload: SpriteEventMap[K]): void {
    const set = this.spriteHandlers.get(event);
    if (!set) return;
    for (const handler of set) {
      try { handler(payload); } catch (err) { logger.warn({ event, err: (err as Error).message }, '宿主事件处理器异常'); }
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
      const pm = this.agent.persona;
      if (pm && pm.list.some(p => p.name === this.config.defaultPersona)) {
        pm.switchPersona(this.config.defaultPersona);
      }
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

  // ─── 角色交互 ──────────────────────────────────────────

  /** 获取当前角色名称 */
  get activePersona(): string | null {
    return this.agent.persona?.activeName ?? null;
  }

  /** 获取角色列表 */
  listPersonas(): Array<{ name: string; description: string; active: boolean }> {
    const pm = this.agent.persona;
    if (!pm) return [];
    const activeName = pm.activeName;
    return pm.list.map(p => ({
      name: p.name,
      description: p.description ?? '',
      active: p.name === activeName,
    }));
  }

  /** 切换角色 */
  switchPersona(name: string): string | null {
    const pm = this.agent.persona;
    if (!pm) return null;
    return pm.switchPersona(name);
  }

  /** 格式化角色列表为可读文本 */
  formatPersonas(): string {
    const personas = this.listPersonas();
    if (personas.length === 0) return '暂无可用角色';

    const lines: string[] = ['── 角色列表 ──'];
    for (const p of personas) {
      const marker = p.active ? ' *' : '';
      const desc = p.description ? ` — ${p.description}` : '';
      lines.push(`  ${p.name}${marker}${desc}`);
    }
    lines.push(`\n当前角色：${this.activePersona ?? '(无)'}`);
    return lines.join('\n');
  }

  // ─── 配置持久化 ────────────────────────────────────────

  /** 获取当前配置（只读副本） */
  getConfig(): Readonly<Required<SpriteConfig>> {
    return { ...this.config };
  }

  /** 更新配置项并持久化 */
  updateConfig(key: SpriteConfigKey, value: unknown): void {
    (this.config as Record<string, unknown>)[key] = value;
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

    if (key === 'fileWatcherPaths' || key === 'fileWatcherIgnore' || key === 'fileWatcherDebounceMs') {
      if (this.config.fileWatcherEnabled) {
        this.triggerBus.unregister('fileWatcher');
        this.registerFileWatcher();
        if (this.running) {
          this.triggerBus.stop();
          this.triggerBus.start();
        }
      }
    }
  }

  /** 格式化配置为可读文本 */
  formatConfig(): string {
    const lines: string[] = ['── 精灵配置 ──'];
    lines.push(`  触发器间隔：${this.config.triggerIntervalMs / 60_000} 分钟`);
    lines.push(`  默认角色：${this.config.defaultPersona || '(未设置)'}`);
    lines.push(`  静默模式：${this.config.silentMode ? '开启' : '关闭'}`);
    lines.push(`  主动提示阈值：${this.config.proactiveThreshold} 个事件`);
    lines.push(`  主动提示冷却：${this.config.proactiveCooldownMs / 60_000} 分钟`);
    lines.push(`  文件监听：${this.config.fileWatcherEnabled ? '开启' : '关闭'}`);
    if (this.config.fileWatcherEnabled) {
      lines.push(`  监听路径：${this.config.fileWatcherPaths.join(', ')}`);
      lines.push(`  忽略模式：${this.config.fileWatcherIgnore.join(', ')}`);
      lines.push(`  防抖时间：${this.config.fileWatcherDebounceMs} 毫秒`);
    }
    return lines.join('\n');
  }

  // ─── 记忆仪表盘 ────────────────────────────────────────

  /** 获取记忆仪表盘数据 */
  dashboard(): DashboardData {
    const stats = this.agent.memory!.stats();
    const suggestions = this.agent.memory!.suggest(undefined, { limit: 5 });
    return {
      total: stats.total,
      bySource: stats.bySource,
      suggestions,
    };
  }

  /** 格式化仪表盘为可读文本 */
  formatDashboard(): string {
    const data = this.dashboard();
    const lines: string[] = [];

    lines.push('── 记忆仪表盘 ──');
    lines.push(`总记忆数：${data.total}`);

    // 精灵状态
    const registeredTriggers = this.triggerBus.registeredTriggers;
    lines.push(`累积事件：${this.pendingNotices.length}（阈值 ${this.config.proactiveThreshold}）`);
    lines.push(`已注册触发器：${registeredTriggers.join(', ')}`);

    if (Object.keys(data.bySource).length > 0) {
      const sourceList = Object.entries(data.bySource)
        .sort(([, a], [, b]) => b - a)
        .map(([source, count]) => `  ${source}: ${count}`)
        .join('\n');
      lines.push(`按来源：\n${sourceList}`);
    }

    if (data.suggestions.length > 0) {
      lines.push('推荐关注：');
      for (const hit of data.suggestions) {
        lines.push(`  [${hit.source}] ${hit.name} (${hit.reason}, 相关度 ${hit.relevance})`);
      }
    } else {
      lines.push('暂无推荐（记忆库为空或尚无足够数据）');
    }

    return lines.join('\n');
  }

  // ─── 主动行为 ────────────────────────────────────────────

  /** 累积待提示事件，达到阈值后尝试发射主动提示 */
  private addPendingNotice(type: string, summary: string): void {
    this.pendingNotices.push({ type, summary, timestamp: Date.now() });
    if (this.pendingNotices.length >= this.config.proactiveThreshold) {
      this.tryEmitProactivePrompt();
    }
  }

  /** 尝试发射主动提示（冷却保护 + 上下文感知提示生成） */
  private tryEmitProactivePrompt(): void {
    if (this.pendingNotices.length === 0) return;
    if (this.config.silentMode) return;

    const now = Date.now();
    if (now - this.lastProactiveAt < this.config.proactiveCooldownMs) return;

    // 取出所有待提示事件
    const notices = this.pendingNotices.splice(0);
    this.lastProactiveAt = now;

    // 生成上下文感知提示文本
    const triggers = notices.map(n => n.type);
    const summaries = notices.map(n => n.summary);
    const prompt = this.buildProactivePrompt(triggers, summaries);

    this.emitSprite('proactivePrompt', { prompt, triggers });

    // 通过交互层输出主动提示
    if (this.interaction) {
      this.interaction.output(`\n[精灵] ${prompt}\n`);
    }

    logger.info({ prompt }, '主动提示');
  }

  /** 根据累积事件生成上下文感知提示文本 */
  private buildProactivePrompt(triggers: string[], summaries: string[]): string {
    const parts: string[] = [];

    // 按事件类型分组统计
    const typeCounts = new Map<string, number>();
    for (const t of triggers) {
      typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);
    }

    // 构建提示
    if (typeCounts.has('memory')) {
      const count = typeCounts.get('memory')!;
      parts.push(count > 1 ? `积累了 ${count} 条新记忆` : '有新的记忆');
    }
    if (typeCounts.has('insight')) {
      const count = typeCounts.get('insight')!;
      parts.push(count > 1 ? `提取了 ${count} 条洞察` : '获得了新的洞察');
    }
    if (typeCounts.has('persona')) {
      parts.push('角色发生了变化');
    }
    if (typeCounts.has('file')) {
      const count = typeCounts.get('file')!;
      parts.push(count > 1 ? `检测到 ${count} 次文件变化` : '检测到文件变化');
    }

    // 摘要中最有信息量的一条
    const bestSummary = summaries.find(s => s.length > 0);

    if (parts.length === 0) {
      return '有些事情发生了变化，你可能想看看。';
    }

    let prompt = parts.join('，');
    if (bestSummary) {
      prompt += `（${bestSummary}）`;
    }
    prompt += '——需要我帮你整理一下吗？';

    return prompt;
  }

  // ─── Agent 事件订阅 ────────────────────────────────────

  /** 订阅 Agent 事件，转发为精灵事件 */
  private subscribeAgentEvents(): void {
    // memoryAdded → memoryNoticed
    const onMemoryAdded = (e: AgentEventMap['memoryAdded']) => {
      this.emitSprite('memoryNoticed', { source: e.source, name: e.name });
      this.addPendingNotice('memory', `[${e.source}] ${e.name}`);
      logger.info({ source: e.source, name: e.name }, '注意到新记忆');
    };
    this.agentHandlers.memoryAdded = onMemoryAdded;
    this.agent.on('memoryAdded', onMemoryAdded);

    // personaSwitched → personaChanged
    const onPersonaSwitched = (e: AgentEventMap['personaSwitched']) => {
      this.emitSprite('personaChanged', { from: e.from, to: e.to });
      this.addPendingNotice('persona', `${e.from ?? '(无)'} → ${e.to}`);
      logger.info({ from: e.from, to: e.to }, '角色切换');
    };
    this.agentHandlers.personaSwitched = onPersonaSwitched;
    this.agent.on('personaSwitched', onPersonaSwitched);

    // insightExtracted → insightGained
    const onInsightExtracted = (e: AgentEventMap['insightExtracted']) => {
      this.emitSprite('insightGained', { source: e.source, insight: e.insight });
      this.addPendingNotice('insight', e.insight);
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
      this.addPendingNotice('file', payload.reason);
      logger.info({ reason: payload.reason, source: payload.source }, '文件变化触发');
    } else {
      // 定时触发
      this.emitSprite('timerTriggered', { reason: payload.reason });
      logger.info({ reason: payload.reason, source: payload.source }, '触发唤醒');
    }

    // 触发时检查是否有待提示的累积事件
    this.tryEmitProactivePrompt();
    logger.debug(this.formatDashboard());
  }
}
