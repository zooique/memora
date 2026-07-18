/**
 * 精灵主控 — 唤醒调度 + 对话管理 + 事件驱动
 *
 * 职责（拆分后）：
 *   1. 门面：对外暴露精灵 API（角色/记忆/归档/仪表盘/感知）
 *   2. 事件系统：精灵事件订阅/发射
 *   3. 唤醒调度：wakeup() + prepareForChat()
 *   4. 编排：连接 ConfigManager、LifecycleManager 和控制器
 *
 * 已拆分模块：
 *   - SpriteConfigManager：配置持久化 + 每日消息计数
 *   - SpriteLifecycleManager：生命周期 + Agent 事件 + 触发器 + 回收站
 *   - 控制器：MemoryController / PersonaController / ProactiveEngine 等
 *
 * 设计原则（ADR-SP-004）：
 *   上下文感知而非内容感知——精灵通过文件变化、时间等上下文信号唤醒。
 */
import type { Agent, AgentMetrics, Memory, UserProfileEntry } from 'memora';
import type { IVectorStore, ITracer } from 'memora';
// Phase 5.1/5.2：路径追溯 + 邻居查询返回类型（内核纯数据形态，IPC 传输可序列化）
import type { RelationPath, RelationNeighbor } from 'memora';
import { logger, toError } from 'memora';
import { watch } from 'node:fs';
import { join } from 'node:path';
import { TriggerBus, TimerTrigger } from './triggers.js';
import { loadSpriteConfig, type SpriteConfig, type SpriteConfigKey } from './spriteConfig.js';
import * as cliFormatter from './cli/formatter.js';
import { MemoryController, PersonaController, ProactiveEngine, PresenceController } from './controllers/index.js';
import { PerceptionCoordinator } from './controllers/perceptionCoordinator.js';
import { MS_PER_MINUTE, MS_PER_HOUR, MS_PER_DAY } from './constants.js';
import type { DashboardData, RapportAssessment, IPowerMonitor, IApp, ProactiveStats } from './controllers/index.js';
import { AffectController } from './controllers/affectController.js';
import type { AffectState } from './controllers/affectController.js';
import { RapportController } from './controllers/rapportController.js';
import type { RapportState } from './controllers/rapportController.js';
import { ContextAwareness } from './controllers/contextAwareness.js';
import type { ContextState } from './controllers/contextAwareness.js';
import { PatternDetector } from './controllers/patternDetector.js';
import type { DetectedPattern } from './controllers/patternDetector.js';
import { SPRITE_TRACE_SPANS } from './spriteTracer.js';
import { SpriteConfigManager, type ConfigSideEffects } from './spriteConfigManager.js';
import { SpriteLifecycleManager } from './spriteLifecycleManager.js';

/** 精灵主控状态：idle 空闲等待触发 / active 唤醒中（对话进行中） */
export type SpriteState = 'idle' | 'active';

/**
 * personas 目录热重载防抖间隔（毫秒）
 *
 * 编辑器保存文件时可能触发多次 change 事件（写入 + 重命名），500ms 防抖合并为一次 reload。
 * 与 fileWatcherTrigger 的默认防抖（1000ms）保持同量级，但稍短以提升响应感。
 */
const PERSONA_RELOAD_DEBOUNCE_MS = 500;

/**
 * 启动摘要（迭代一：Welcome Back Digest）
 *
 * 精灵启动/恢复时聚合已采集数据，生成一张摘要卡片展示给用户。
 * 所有数据均来自已有采集通路（memoryController / perceptionCoordinator / AgentMetrics），
 * 零新增采集开销。
 */
export interface StartupSummary {
  /** 记忆总数 */
  totalMemories: number;
  /** 洞察总数 */
  totalInsights: number;
  /** 技能总数 */
  skillCount: number;
  /** 衰减统计 */
  decay: {
    /** 衰减运行次数 */
    runCount: number;
    /** 累计衰减记忆数 */
    totalDecayedCount: number;
  } | null;
  /** 感知快照 */
  perception: {
    /** 温暖度 0-1 */
    warmth: number;
    /** 默契度等级（stranger/acquaintance/familiar/close） */
    rapportLevel: string;
    /** 默契度自然语言描述 */
    rapportDescription: string;
  } | null;
  /** 记忆源健康状态 */
  healthStatus: 'healthy' | 'warning' | 'critical' | null;
}

/** 精灵事件载荷 — 宿主 UI 可订阅 */
export interface SpriteEventMap {
  /** 精灵注意到新记忆（insight/profile/guardrail 等） */
  memoryNoticed: { source: string; name: string };
  /** 精灵注意到角色切换 */
  personaChanged: { from: string | null; to: string };
  /** 精灵注意到洞察提取 */
  insightGained: { source: string; insight: string };
  /** 记忆冲突被检测到（contradicts 关系写入时通知宿主 UI） */
  conflictDetected: { newMemoryId: string; newInsight: string; targetId: string; targetContent: string };
  /** 精灵主动提示（累积事件后生成） */
  proactivePrompt: {
    prompt: string;
    triggers: string[];
    silent: boolean;
    isMilestone?: boolean;
    /** 轻量提示标志：true 时宿主跳过系统通知（方向 A 召回场景） */
    lightweight?: boolean;
  };
  // L5：迭代 9 补齐的 4 种未订阅 Agent 事件
  /** 用户切换项目（专注模式） */
  projectSwitched: { from: string | null; to: string; projectName: string };
  /** 技能匹配命中 */
  skillMatched: { skill: string; score: number };
  /** 记忆被召回（用于"想起 X 条记忆"提示） */
  memoryRecalled: { count: number; query: string };
  /** 记忆衰减完成（24h 节流，避免噪音） */
  decayCompleted: { decayedCount: number };
  /**
   * 会话分叉完成（用户从当前会话分叉出独立分支）
   * from = 源会话 ID，to = 新会话 ID，messageCount = 复制的消息数
   */
  sessionForked: { from: string; to: string; messageCount: number };
  /** Phase 3.2：用户在场状态变化（离开/回来） */
  presenceChanged: { state: 'present' | 'away'; timestamp: string; awayDurationMs?: number; reason: string };
  /** Phase 2.1：情感基调更新（推导完成后触发） */
  affectUpdated: AffectState;
  /** Phase 3：默契度更新（推导完成后触发，与 affectUpdated 同时发射） */
  rapportUpdated: RapportState;
  /** Phase 4：对话上下文更新（推导完成后触发，与 affectUpdated 同时发射） */
  contextUpdated: ContextState;
  /** 作品投影更新（文件变化触发投影重新生成后发射） */
  workProjectionUpdated: { sourcePath: string; summary: string };
  /** Phase 2+：用户模式更新（PatternDetector 检测到新模式后发射） */
  patternsUpdated: { patterns: DetectedPattern[] };
  /** 回收站自动清理完成（定时器触发，通知 UI 显示清理数量） */
  trashPurged: { purgedCount: number };
  /** 归档操作失败（fire-and-forget catch 分支发射，宿主可通知用户） */
  archiveFailed: {
    /** 失败阶段：profile（用户画像）/ insight（洞察提取）/ content（会话内容归档） */
    stage: 'profile' | 'insight' | 'content';
    /** 失败原因摘要（error.message，截断 200 字符） */
    message: string;
  };
}

// 重新导出 DashboardData 和 AffectState 供外部使用
export type { DashboardData, AffectState };

/** 精灵主控构造选项（位置参数 → options 对象） */
export interface SpriteOptions {
  /** Agent 实例（必填，由宿主项目创建并注入） */
  agent: Agent;
  /** 数据目录（必填，存储 memora.db、sprite.json 等持久化数据） */
  dataDir: string;
  /** 项目路径（可选，默认取 dataDir。用于文件监听、项目规则加载等） */
  projectPath?: string;
  /** 向量存储（可选，注入后启用语义搜索） */
  vectorStore?: IVectorStore;
  /** 路径白名单（可选，来自 Agent 的 allowedPaths，用于 fileWatcher 安全校验） */
  allowedPaths?: string[];
  /** 可观测性 tracer（可选，注入后关键路径会记录 span 到 trace.log） */
  tracer?: ITracer;
  /**
   * Agent 级配置目录（可选，传入后启用 personas 目录热重载）
   *
   * - 传入：start() 时挂 fs.watch 监听 <configDir>/personas/，文件变化时防抖触发 agent.reloadConfig('persona')
   * - 不传：跳过热重载（测试场景默认行为）
   *
   * 持久化路径：~/.memora-sprite/config/personas/
   */
  configDir?: string;
}

/**
 * 精灵主控
 *
 * 门面模式：对外暴露精灵 API，内部委托给 ConfigManager、LifecycleManager 和控制器。
 * 拆分后 sprite.ts 仅保留门面职责（~450 行），编排逻辑移至独立模块。
 */
export class Sprite {
  private agent: Agent;
  private state: SpriteState = 'idle';
  private triggerBus: TriggerBus;
  private spriteHandlers = new Map<string, Set<(event: unknown) => void>>();

  /** 运行状态（start/stop 控制） */
  private started = false;
  private projectPath: string;
  /** 路径白名单（来自 Agent 配置，用于 fileWatcher 安全校验） */
  private allowedPaths: string[];
  /**
   * Agent 级配置目录（可选，传入后启用 personas 目录热重载）
   * 不传则跳过热重载（测试场景默认行为）
   */
  private configDir: string | null;
  /** personas 目录 fs.watch 监听器句柄（start 时创建，stop 时关闭） */
  private personaWatcher: ReturnType<typeof watch> | null = null;
  /** personas 热重载防抖计时器（500ms 内多次变化合并为一次 reload） */
  private personaReloadTimer: ReturnType<typeof setTimeout> | null = null;

  // ─── 拆分后的 Manager ────────────────────────────────
  private configManager: SpriteConfigManager;
  private lifecycleManager: SpriteLifecycleManager;

  // ─── 控制器（在 initControllers / initPerceptionStack 中初始化，使用 !: 断言） ───
  private memoryController!: MemoryController;
  private personaController!: PersonaController;
  private proactiveEngine!: ProactiveEngine;
  /** Phase 3.2：在场状态控制器（可选，需宿主注入 powerMonitor/app） */
  private presenceController: PresenceController | null = null;
  /** Phase 2.1：情感基调控制器 */
  private affectController!: AffectController;
  /** Phase 3：默契度控制器 */
  private rapportController!: RapportController;
  /** Phase 4：对话上下文感知器 */
  private contextAwareness!: ContextAwareness;
  /** Phase 2+：记忆模式检测器 */
  private patternDetector!: PatternDetector;
  /** 可观测性 tracer */
  private readonly tracer: ITracer | null;

  // ─── 感知数据缓存 ───
  /** 感知推导协调器 */
  private perceptionCoordinator!: PerceptionCoordinator;

  constructor(options: SpriteOptions) {
    // ─── 基础属性 ───
    this.agent = options.agent;
    this.projectPath = options.projectPath ?? options.dataDir;
    this.allowedPaths = options.allowedPaths ?? [];
    this.tracer = options.tracer ?? null;
    this.configDir = options.configDir ?? null;

    // ─── 初始化触发器总线 + 控制器 ───
    const config = loadSpriteConfig();
    this.triggerBus = new TriggerBus();
    this.triggerBus.register(new TimerTrigger(config.triggerIntervalMs));
    this.initControllers(config, options.vectorStore);

    // ─── 初始化感知栈（情感/默契/上下文/模式） ───
    this.initPerceptionStack();

    // ─── 创建 ConfigManager（配置持久化 + 副作用） ───
    this.configManager = new SpriteConfigManager(config, this.buildConfigSideEffects());

    // 注入 ProactiveEngine 状态持久化回调
    //   configManager 创建后才能调用 updateConfigBatch 持久化
    this.proactiveEngine.setPersistCallback((state) => {
      this.configManager.updateConfigBatch({
        proactiveNoticedMagnitudes: state.noticedMagnitudes,
        proactiveKnownSources: state.knownSources,
        proactiveLastRejectAt: state.lastRejectAt,
      });
    });

    // ─── 创建 LifecycleManager（生命周期编排） ───
    this.lifecycleManager = this.createLifecycleManager(config, options);

    // ─── 启动后注册 ───
    if (config.fileWatcherEnabled) {
      this.lifecycleManager.registerFileWatcher();
    }
    // ADR-015: 启动时从 spriteConfig 读取 archiveMode 并应用到 Agent
    this.agent.setArchiveMode(config.archiveMode);
  }

  /**
   * 初始化核心控制器（记忆/角色/主动提示引擎）
   *
   * @param config - 精灵配置（loadSpriteConfig 返回的完整配置）
   * @param vectorStore - 向量存储（可选，用于语义搜索召回）
   */
  private initControllers(config: Required<SpriteConfig>, vectorStore?: IVectorStore): void {
    this.memoryController = new MemoryController(this.agent, vectorStore);
    this.personaController = new PersonaController(this.agent);
    // 从持久化配置恢复 ProactiveEngine 状态，避免重启后冷却/里程碑状态丢失
    this.proactiveEngine = new ProactiveEngine(
      {
        threshold: config.proactiveThreshold,
        cooldownMs: config.proactiveCooldownMs,
        silentMode: config.silentMode,
      },
      {
        noticedMagnitudes: config.proactiveNoticedMagnitudes,
        knownSources: config.proactiveKnownSources,
        lastRejectAt: config.proactiveLastRejectAt,
      },
    );
    // 注入每日消息计数 provider（延迟访问 configManager，运行时才解析）
    this.memoryController.setMessageCountProvider(() => this.configManager.getDailyMessageCounts());
  }

  /**
   * 初始化感知栈（情感基调/默契度/上下文/模式检测 + 协调器）
   *
   * 创建感知控制器集群，并通过 PerceptionCoordinator 统一编排事件发射。
   */
  private initPerceptionStack(): void {
    this.affectController = new AffectController({
      acceptanceRate: 0.5,
      currentPersona: null,
    });
    this.rapportController = new RapportController({
      acceptanceRate: 0.5,
      interactionDays: 0,
      totalMessages: 0,
      sourceDiversity: 0,
    });
    this.contextAwareness = new ContextAwareness();
    this.patternDetector = new PatternDetector();

    // 初始化感知推导协调器（统一编排感知事件发射）
    this.perceptionCoordinator = new PerceptionCoordinator({
      agent: this.agent,
      affectController: this.affectController,
      rapportController: this.rapportController,
      contextAwareness: this.contextAwareness,
      patternDetector: this.patternDetector,
      proactiveEngine: this.proactiveEngine,
      emitter: {
        affectUpdated: (payload) => this.emitSprite('affectUpdated', payload),
        rapportUpdated: (payload) => this.emitSprite('rapportUpdated', payload),
        contextUpdated: (payload) => this.emitSprite('contextUpdated', payload),
        patternsUpdated: (payload) => this.emitSprite('patternsUpdated', payload),
      },
    });

    // 设置主动提示引擎的发射器
    this.proactiveEngine.setEmitter((event, payload) => {
      this.emitSprite(event as keyof SpriteEventMap, payload as SpriteEventMap[keyof SpriteEventMap]);
    });
  }

  /**
   * 构建配置变更副作用回调表
   *
   * ConfigManager 在配置变更时触发这些回调，将变更应用到运行时组件。
   * 回调在运行时执行，此时 lifecycleManager 等组件已初始化完成。
   *
   * @returns 配置副作用映射表
   */
  private buildConfigSideEffects(): ConfigSideEffects {
    return {
      onTriggerIntervalChanged: (ms) => {
        this.triggerBus.unregister('timer');
        this.triggerBus.register(new TimerTrigger(ms));
        this.lifecycleManager.restartTriggersIfRunning();
      },
      onFileWatcherChanged: (rebuild) => {
        if (rebuild) {
          this.lifecycleManager.rebuildFileWatcher();
        }
      },
      onProactiveConfigChanged: (threshold, cooldownMs, silentMode) => {
        this.proactiveEngine.updateConfig({ threshold, cooldownMs, silentMode });
      },
      onProjectModeChanged: () => {
        return this.applyProjectMode();
      },
      onArchiveModeChanged: (mode) => {
        // ADR-015: 归档模式变更时应用到 Agent（setArchiveMode 内部有 _chatBusy 守卫）
        this.agent.setArchiveMode(mode as 'full' | 'insights-only' | 'manual');
      },
    };
  }

  /**
   * 创建生命周期管理器
   *
   * @param config - 精灵配置（loadSpriteConfig 返回的完整配置）
   * @param options - 构造选项（提供 dataDir / allowedPaths 等）
   * @returns 生命周期管理器实例
   */
  private createLifecycleManager(config: Required<SpriteConfig>, options: SpriteOptions): SpriteLifecycleManager {
    return new SpriteLifecycleManager({
      agent: this.agent,
      triggerBus: this.triggerBus,
      config: config,
      proactiveEngine: this.proactiveEngine,
      perceptionCoordinator: this.perceptionCoordinator,
      memoryController: this.memoryController,
      tracer: this.tracer,
      projectPath: this.projectPath,
      dataDir: options.dataDir,
      allowedPaths: this.allowedPaths,
      emit: (event, payload) => {
        // LifecycleManager 使用 SpriteEventEmitter 类型（unknown payload），
        // 此处安全断言为 SpriteEventMap 的 payload 类型
        this.emitSprite(event as keyof SpriteEventMap, payload as SpriteEventMap[keyof SpriteEventMap]);
      },
    });
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
    // 幂等守卫：重复调用 start() 直接返回，避免 lifecycleManager / presenceController / watcher 重复启动
    if (this.started) return;
    this.started = true;
    this.state = 'idle';
    this.lifecycleManager.start();

    // 应用持久化的角色匹配模式（auto/manual）
    // 必须在应用 defaultPersona 之前设置，避免 auto 模式下默认角色被自动匹配覆盖
    const persistedMode = this.getConfig().personaMode;
    if (persistedMode === 'manual' || persistedMode === 'auto') {
      this.personaController.setMode(persistedMode);
    }

    // 应用默认角色（走 switchPersona 统一事件链路：刷新 AgentLoop + 发射 personaSwitched）
    // switchPersona 同名幂等路径返回非 null 但不发射事件，因此不能据此判断感知推导是否已触发
    // 改为追踪 personaChanged 事件是否实际发射，决定是否需要显式调用 refreshBeforeChat
    let personaEventFired = false;
    const personaChangedHandler = (): void => {
      personaEventFired = true;
    };
    this.on('personaChanged', personaChangedHandler);
    try {
      if (this.getConfig().defaultPersona) {
        this.switchPersona(this.getConfig().defaultPersona);
      }
    } finally {
      this.off('personaChanged', personaChangedHandler);
    }

    // Phase 3.2：启动在场状态控制器
    this.presenceController?.start();

    // Phase 2.1：首次推导情感基调
    // 仅在未通过 defaultPersona 切换触发事件链路时显式调用，避免重复推导
    // 同名幂等路径不触发事件，此时 personaEventFired=false，会显式调用一次 refreshBeforeChat
    if (!personaEventFired) {
      this.perceptionCoordinator.refreshBeforeChat();
    }

    // 启动 personas 目录热重载（configDir 提供时）
    // 用户在编辑器中修改 personas/*.md 后，自动触发 agent.reloadConfig('persona') 刷新缓存
    this.startPersonaWatcher();
  }

  /** 停止精灵主控 */
  stop(): void {
    this.started = false;
    this.lifecycleManager.stop();
    this.presenceController?.stop();
    this.spriteHandlers.clear();
    this.state = 'idle';
    // 关闭 personas 目录热重载监听器 + 清理防抖计时器
    this.stopPersonaWatcher();
  }

  /**
   * 启动 personas 目录热重载监听器
   *
   * 监听 <configDir>/personas/ 目录的文件变化（新增/修改/删除 .md 文件），
   * 500ms 防抖后触发 agent.reloadConfig('persona') 清空缓存重新扫描。
   * 重载期间对话繁忙时跳过本次（用户可手动调 reloadConfig）。
   *
   * 设计要点：
   * - 使用 fs.watch recursive 模式（Node 22 LTS 稳定支持）
   * - 监听器 error 事件仅记录日志，不抛错（目录被删除/权限丢失时优雅降级）
   * - configDir 未提供时直接跳过（测试场景默认行为）
   */
  private startPersonaWatcher(): void {
    if (!this.configDir) return;
    // 幂等守卫：已存在 watcher 则跳过，避免重复 start() 导致旧句柄泄漏
    if (this.personaWatcher) return;

    const personasDir = join(this.configDir, 'personas');
    try {
      this.personaWatcher = watch(personasDir, { recursive: true }, (_eventType, filename) => {
        // 仅响应 .md 文件变化，忽略其他文件（如 .swp 临时文件）
        if (!filename || !filename.endsWith('.md')) return;
        this.schedulePersonaReload();
      });
      // error 事件：关闭并清理 watcher 句柄，避免目录被删除后 watcher 进入僵尸状态
      this.personaWatcher.on('error', (err) => {
        logger.warn({ err: toError(err).message, personasDir }, 'personas 目录监听器错误，热重载已停止');
        try {
          this.personaWatcher?.close();
        } catch {
          // 二次错误（如句柄已损坏）忽略，避免 error handler 内抛错
        }
        this.personaWatcher = null;
      });
      logger.info({ personasDir }, 'personas 目录热重载已启动');
    } catch (err) {
      // 目录不存在或权限不足时优雅降级，不阻塞 start()
      logger.warn({ err: toError(err).message, personasDir }, 'personas 目录监听启动失败，跳过热重载');
    }
  }

  /**
   * 防抖调度 personas 重载
   *
   * 500ms 内多次文件变化合并为一次 reload，避免编辑器写入触发多次重载。
   */
  private schedulePersonaReload(): void {
    if (this.personaReloadTimer) {
      clearTimeout(this.personaReloadTimer);
    }
    this.personaReloadTimer = setTimeout(() => {
      this.personaReloadTimer = null;
      void this.agent.reloadConfig('persona').catch((err) => {
        logger.warn({ err: toError(err).message }, 'personas 热重载失败');
      });
    }, PERSONA_RELOAD_DEBOUNCE_MS);
  }

  /** 关闭 personas 目录监听器 + 清理防抖计时器 */
  private stopPersonaWatcher(): void {
    if (this.personaWatcher) {
      this.personaWatcher.close();
      this.personaWatcher = null;
    }
    if (this.personaReloadTimer) {
      clearTimeout(this.personaReloadTimer);
      this.personaReloadTimer = null;
    }
  }

  /**
   * 注入在场状态控制器（Phase 3.2）
   * 若 Sprite 已启动，自动调用 controller.start() 保持状态一致。
   */
  setPresenceController(controller: PresenceController): void {
    this.presenceController = controller;
    // 若 Sprite 已启动，确保 presenceController 也启动
    if (this.started) {
      controller.start();
    }
  }

  /**
   * 创建并注入在场状态控制器（Phase 3.2 便捷方法）
   *
   * 注入三个回调：
   *   - proactiveEngine：用户回来时检查累积事件
   *   - emit：转发 presenceChanged 为精灵事件
   *   - onWelcomeBack：长时间离开后回来时召回记忆（方向 A 遗忘召回）
   */
  bindPresence(powerMonitor: IPowerMonitor, app: IApp): void {
    const controller = new PresenceController(powerMonitor, app, {
      proactiveEngine: this.proactiveEngine,
      emit: (event, payload) => {
        this.emitSprite(event, payload);
      },
      onWelcomeBack: (awayDurationMs) => {
        this.welcomeBackRecall(awayDurationMs);
      },
    });
    this.setPresenceController(controller);
  }

  /**
   * 欢迎回来记忆召回（方向 A：遗忘召回）
   *
   * 长时间离开（>= 1 小时）后回来时，取离开期间产生的新记忆，
   * 构造摘要后通过 proactiveEngine.addNotice('recalled', summary) 注入主动提示队列。
   * 由 PresenceController.handlePresent 在 checkPending 之前触发，
   * 这样 checkPending 能一并消费召回事件。
   *
   * 记忆选取策略：取 50 条 → 按 createdAt 过滤出离开期间的记忆 → 取前 5 条。
   * 与 perceptionCoordinator.getCrossSessionContext 的选取范式相似（都先取 50 再按时间过滤），
   * 但时间窗口语义不同——此处是"离开期间"，getCrossSessionContext 是"gapMs + 2h"。
   * 不强行提取公共方法，因两处时间窗口语义不可统一。
   *
   * 零 LLM 调用，纯模板拼接。
   *
   * @param awayDurationMs 离开时长（毫秒），必定 >= WELCOME_BACK_THRESHOLD_MS
   */
  private welcomeBackRecall(awayDurationMs: number): void {
    try {
      // 复用 agent.memory（MemoryInspector），获取完整 Memory 对象
      const inspector = this.agent.memory;
      if (!inspector) return;

      // 取 50 条活跃记忆（按 score 降序），再按 createdAt 过滤出离开期间产生的新记忆
      // 离开期间的判定：createdAt >= (now - awayDurationMs)，即离开开始之后创建的记忆
      const now = Date.now();
      const awaySinceMs = now - awayDurationMs;
      const allMemories = inspector.list(50);
      const recentMemories = allMemories.filter((m) => {
        const createdMs = new Date(m.createdAt).getTime();
        return createdMs >= awaySinceMs;
      }).slice(0, 5);

      // 离开期间无新记忆则不提示（避免提示无关的旧记忆）
      if (recentMemories.length === 0) {
        logger.debug({ awayDurationMs }, '离开期间无新记忆，跳过召回');
        return;
      }

      // 构造时长描述（分钟/小时/天），复用 constants.ts 时间常量（DRY）
      // [SYNC-PERCEPTION-COORDINATOR] perceptionCoordinator.getCrossSessionContext 有相似的时长格式化，
      // 两处语义不同（此处是"离开时长"，彼处是"对话间隔"），不强行提取公共方法
      const minutes = Math.round(awayDurationMs / MS_PER_MINUTE);
      const durationText = awayDurationMs < MS_PER_HOUR
        ? `${minutes} 分钟`
        : awayDurationMs < MS_PER_DAY
          ? `${Math.round(awayDurationMs / MS_PER_HOUR)} 小时`
          : `${Math.round(awayDurationMs / MS_PER_DAY)} 天`;

      // 构造摘要：时长 + 数量 + 前 3 个 name（提升信息量）
      // 第一人称文案：体现精灵主动感知（presenceController 检测离开 + 记忆系统主动归档）
      const names = recentMemories
        .map((m) => m.name)
        .filter((n) => n.length > 0)
        .slice(0, 3);
      const nameList = names.length > 0 ? `（${names.join('、')}）` : '';
      const summary = `我注意到你离开了 ${durationText}，期间我整理了 ${recentMemories.length} 条新记忆${nameList}`;

      // 注入主动提示队列，type='recalled' 由 buildPrompt 专属分支处理
      this.proactiveEngine.addNotice('recalled', summary);

      logger.info(
        { awayDurationMs, memoryCount: recentMemories.length, names },
        '欢迎回来记忆召回已注入',
      );
    } catch (err) {
      // 召回失败不影响后续 checkPending（错误隔离，与 PresenceController 的 try/catch 双重保护）
      logger.warn({ err, awayDurationMs }, '欢迎回来记忆召回失败');
    }
  }

  /** 获取当前状态 */
  getState(): SpriteState {
    return this.state;
  }

  // ─── 项目模式 ──────────────────────────────────────────

  /**
   * 应用项目模式
   *
   * 专注模式切换时调用 agent.switchProject 切换 Agent 上下文。
   * 降级策略（§7 P4）：切换失败时 catch-only-warn，不中断配置更新流程——
   * 配置已持久化，运行时切换失败仅 warn，下次启动时会重新应用配置。
   */
  private async applyProjectMode(): Promise<void> {
    const config = this.getConfig();
    if (config.projectMode !== 'focus') return;
    const focusPath = config.focusProjectPath;
    if (!focusPath) {
      logger.warn('专注模式未设置 focusProjectPath，保持当前项目');
      return;
    }
    const span = this.tracer?.startSpan(SPRITE_TRACE_SPANS.PROJECT_MODE, { focusPath });
    try {
      await this.agent.switchProject(focusPath);
      logger.info({ focusPath }, '已切换到专注项目');
      if (config.fileWatcherEnabled) {
        this.lifecycleManager.rebuildFileWatcher();
      }
    } catch (err: unknown) {
      // §7 P4 降级：项目切换失败不中断配置更新流程（catch-only-warn）
      // 配置已由 ConfigManager 持久化，运行时切换失败仅记录，下次启动重新应用
      logger.warn({ focusPath, err: toError(err).message }, '专注项目切换失败，保持当前项目');
      span?.recordException(err instanceof Error ? err : new Error(String(err)));
    } finally {
      span?.end();
    }
  }

  // ─── 唤醒调度 ──────────────────────────────────────────

  /**
   * 手动唤醒精灵
   */
  async wakeup(input?: string): Promise<string> {
    this.state = 'active';
    const span = this.tracer?.startSpan(SPRITE_TRACE_SPANS.WAKEUP, input ? { hasInput: true } : { hasInput: false });
    try {
      this.prepareForChat(input);
      return await this.agent.chatSync(input ?? '');
    } catch (err) {
      span?.recordException(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      this.state = 'idle';
      span?.end();
    }
  }

  /**
   * 对话前感知刷新（供 Electron 流式路径复用）
   */
  prepareForChat(input?: string | null): void {
    this.perceptionCoordinator.pushUserMessage(input);
    this.perceptionCoordinator.refreshBeforeChat();
  }

  // ─── 角色交互（委托 PersonaController） ────────────────

  get activePersona(): string | null {
    return this.personaController.activeName;
  }

  listPersonas(): Array<{ name: string; description: string; active: boolean }> {
    return this.personaController.list();
  }

  switchPersona(name: string): string | null {
    // 委托到 agent.switchPersona 公共方法（统一事件链路）：
    //   1. 同步 AgentLoop 的 systemPromptPrefix
    //   2. 发射 personaSwitched 事件 → spriteLifecycleManager 转 personaChanged
    //      → proactiveEngine.addNotice + perceptionCoordinator.refreshBeforeChat
    //   3. 通过 spriteEventBridge 转发到渲染层 UI
    // 旧的 personaController.switch 路径不触发事件，已废弃。
    return this.agent.switchPersona(name);
  }

  setPersonaMode(mode: 'auto' | 'manual'): boolean {
    const set = this.personaController.setMode(mode);
    // 持久化到 sprite.json，下次启动时由 start() 读取应用
    // 失败不影响本次设置（内存中已生效），仅记录日志
    if (set) {
      try {
        this.updateConfig('personaMode', mode);
      } catch (err) {
        logger.warn({ err: toError(err).message, mode }, 'personaMode 持久化失败');
      }
    }
    return set;
  }

  get personaMode(): string {
    return this.personaController.currentMode;
  }

  formatPersonas(): string {
    return cliFormatter.formatPersonas(this.personaController.list(), this.personaController.activeName ?? undefined);
  }

  // ─── 项目管理 ──────────────────────────────────────────

  listProjects(): Array<{ name: string; path: string }> {
    return this.agent.projects?.list.map((p: { name: string; path: string }) => ({ name: p.name, path: p.path })) ?? [];
  }

  // ─── 记忆管理（委托 MemoryController） ──────────────────

  listMemories(source?: string, limit = 50): { id: string; name: string; source: string; score: number; contentPreview: string }[] {
    return this.memoryController.list(source, limit);
  }

  showMemory(id: string): { id: string; name: string; source: string; score: number; content: string; createdAt: string; accessedAt: string } | null {
    return this.memoryController.show(id);
  }

  deleteMemory(id: string): boolean {
    return this.memoryController.delete(id);
  }

  /**
   * 批量删除记忆（委托 memoryController.deleteBatch）
   *
   * @param ids 记忆 ID 列表
   * @returns { deleted, total } 成功删除数量和传入总数
   */
  deleteMemoriesBatch(ids: string[]): { deleted: number; total: number } {
    return this.memoryController.deleteBatch(ids);
  }

  restoreMemory(id: string): boolean {
    return this.memoryController.restore(id);
  }

  purgeMemory(id: string): boolean {
    return this.memoryController.purge(id);
  }

  restoreAllMemories(): { restored: number; failed: number } {
    return this.memoryController.restoreAll();
  }

  purgeAllMemories(): { purged: number; failed: number } {
    return this.memoryController.purgeAll();
  }

  listDeletedMemories(limit = 50): { id: string; name: string; source: string; contentPreview: string; deletedAt: string }[] {
    return this.memoryController.listDeleted(limit);
  }

  upsertMemory(source: string, name: string, content: string, score = 0.5): string {
    return this.memoryController.upsert(source, name, content, score);
  }

  /**
   * 提升记忆 score（L2 采纳反哺内核）
   *
   * 补全模块采纳某条候选后调用，将用户行为反馈到内核 Memory.score。
   */
  boostMemory(id: string): boolean {
    return this.memoryController.boostMemory(id);
  }

  // ─── LLM 记忆治理（L1~L3，G1：转发到 memoryController） ──

  /**
   * L1 语义去重（转发 memoryController.deduplicateMemories）
   *
   * 供 IPC handler 调用，返回去重报告。
   */
  async deduplicateMemories() {
    return this.memoryController.deduplicateMemories();
  }

  /**
   * L2 时效性评估（转发 memoryController.evaluateTimeliness）
   *
   * 供 IPC handler 调用（手动触发）。G2 自动触发走 agent.ts 内部钩子，不经此处。
   */
  async evaluateTimeliness() {
    return this.memoryController.evaluateTimeliness();
  }

  /**
   * 手动触发一次 L0 记忆衰减（转发 agent.runMemoryDecayOnce）
   *
   * 供 IPC handler 调用（手动触发）。定时器自动触发走 MemoryDecayScheduler 内部定时器，不经此处。
   */
  triggerDecayRun(): void {
    this.agent.runMemoryDecayOnce();
  }

  /**
   * L3 冲突检测（转发 memoryController.detectConflicts）
   *
   * 供 IPC handler 调用，返回冲突报告。
   */
  async detectConflicts() {
    return this.memoryController.detectConflicts();
  }

  async searchMemories(query: string, limit = 10): Promise<Array<{ id: string; name: string; source: string; score: number; contentPreview: string; similarity?: number }>> {
    return this.memoryController.search(query, limit);
  }

  getRelationGraph(): {
    nodes: Array<{ id: string; name: string; source: string; score: number; contentPreview: string }>;
    edges: Array<{ sourceId: string; targetId: string; type: string; weight: number; createdAt: string }>;
  } {
    return this.memoryController.getRelationGraph();
  }

  /** 获取记忆关系路径（Phase 5.1：路径追溯，用于展示记忆演化脉络） */
  getRelationPath(memoryId: string, maxDepth = 5, direction: 'incoming' | 'outgoing' | 'both' = 'incoming'): RelationPath[] {
    return this.memoryController.getRelationPath(memoryId, maxDepth, direction);
  }

  /** 获取记忆关系邻居（Phase 5.2：邻居查询，用于展示直接关联记忆） */
  getRelationNeighbors(memoryId: string, limit = 10): RelationNeighbor[] {
    return this.memoryController.getRelationNeighbors(memoryId, limit);
  }

  addRelation(sourceId: string, targetId: string, type: string, weight: number): void {
    this.memoryController.addRelation(sourceId, targetId, type, weight);
  }

  removeRelation(sourceId: string, targetId: string, type: string): void {
    this.memoryController.removeRelation(sourceId, targetId, type);
  }

  updateRelation(sourceId: string, targetId: string, type: string, weight: number): void {
    this.memoryController.updateRelation(sourceId, targetId, type, weight);
  }

  // ─── 归档 ──────────────────────────────────────────────

  async archiveProfileFacts(input: string): Promise<UserProfileEntry[]> {
    return this.agent.archiveProfileFacts(input);
  }

  async archiveInsight(input: string, assistantContent: string): Promise<Memory[]> {
    return this.agent.archiveInsight(input, assistantContent);
  }

  // ─── 仪表盘 ────────────────────────────────────────────

  getHealthDashboard() {
    return this.memoryController.getHealthDashboard();
  }

  getReviewData() {
    return this.memoryController.getReviewData();
  }

  dashboard(): DashboardData {
    const data = this.memoryController.dashboard();
    this.proactiveEngine.checkMilestones(data);
    return data;
  }

  checkPending(): void {
    this.proactiveEngine.checkPending();
  }

  rapportLevel(): RapportAssessment {
    return this.memoryController.rapportLevel();
  }

  sourceHealth() {
    return this.agent.memory?.sourceHealth() ?? null;
  }

  getMetrics(): AgentMetrics {
    return this.agent.getMetrics();
  }

  getPerceptionSnapshot(): {
    affect: AffectState;
    rapport: RapportState;
    context: ContextState;
    patterns: DetectedPattern[];
    proactiveStats: ProactiveStats;
  } | null {
    const snapshot = this.perceptionCoordinator.getSnapshot();
    if (!snapshot) return null;
    const proactiveStats = this.proactiveEngine.getStats();
    return { ...snapshot, proactiveStats };
  }

  /**
   * 获取在场状态快照（供初始推送使用）
   *
   * 返回当前在场状态，包括离开时长和原因。
   * 用于时序修复：presenceController.start() 后可能不发射初始事件（幂等保护），
   * 需要主动推送初始状态到渲染层。
   *
   * @returns 在场状态快照，presenceController 未注入时返回 null
   */
  getPresenceSnapshot(): {
    state: 'present' | 'away';
    timestamp: string;
    awayDurationMs?: number;
    reason?: string;
  } | null {
    if (!this.presenceController) return null;

    const state = this.presenceController.getState();
    const awaySince = this.presenceController.getAwaySince();
    const now = Date.now();

    return {
      state,
      timestamp: new Date().toISOString(),
      ...(state === 'away' && awaySince !== null ? { awayDurationMs: now - awaySince } : {}),
    };
  }

  /**
   * 获取启动摘要（迭代一：Welcome Back Digest）
   *
   * 聚合记忆/洞察/感知/衰减/健康数据，生成一张摘要卡片。
   * 所有数据均来自已有采集通路，零新增采集开销。
   * 返回 null 表示 Agent 未就绪，UI 应跳过摘要展示。
   */
  getStartupSummary(): StartupSummary | null {
    const dashboard = this.memoryController.dashboard();
    const metrics = this.agent.getMetrics();
    const snapshot = this.perceptionCoordinator.getSnapshot();
    const sourceHealth = this.agent.memory?.sourceHealth();
    const skillCount = this.agent.skills?.list.length ?? 0;

    return {
      totalMemories: dashboard.total,
      totalInsights: dashboard.bySource?.['llm:insight'] ?? 0,
      skillCount,
      decay: metrics.decay
        ? { runCount: metrics.decay.runCount, totalDecayedCount: metrics.decay.totalDecayedCount }
        : null,
      perception: snapshot
        ? {
            warmth: snapshot.affect.warmth,
            rapportLevel: snapshot.rapport.level,
            rapportDescription: snapshot.rapport.description,
          }
        : null,
      healthStatus: sourceHealth?.overallStatus ?? null,
    };
  }

  get pendingCount(): number {
    return this.proactiveEngine.pendingCount;
  }

  get proactiveThreshold(): number {
    return this.getConfig().proactiveThreshold;
  }

  get registeredTriggers(): string[] {
    return this.triggerBus.registeredTriggers;
  }

  recordProactiveAccept(): void {
    this.proactiveEngine.recordAccept();
    this.perceptionCoordinator.refreshBeforeChat();
    logger.info({ acceptanceRate: this.proactiveEngine.acceptanceRate }, '用户接受主动提示');
  }

  recordProactiveReject(): void {
    this.proactiveEngine.recordReject();
    logger.info('用户拒绝主动提示');
  }

  formatDashboard(): string {
    return cliFormatter.formatDashboard(
      this.memoryController.dashboard(),
      this.proactiveEngine.pendingCount,
      this.getConfig().proactiveThreshold,
      this.triggerBus.registeredTriggers,
    );
  }

  // ─── 配置代理（委托 ConfigManager） ─────────────────────

  getConfig(): Readonly<Required<SpriteConfig>> {
    return this.configManager.getConfig();
  }

  updateConfig(key: SpriteConfigKey, value: unknown): void {
    this.configManager.updateConfig(key, value);
  }

  updateConfigBatch(updates: Partial<SpriteConfig>): { updated: boolean; error?: string } {
    return this.configManager.updateConfigBatch(updates);
  }

  formatConfig(): string {
    return this.configManager.formatConfig();
  }

  incrementDailyMessageCount(): void {
    this.configManager.incrementDailyMessageCount();
  }

  getDailyMessageCounts(): Record<string, number> {
    return this.configManager.getDailyMessageCounts();
  }
}