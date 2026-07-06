/**
 * 精灵生命周期管理器 — 启动/停止 + 触发器处理 + Agent 事件订阅 + 回收站清理
 *
 * 从 sprite.ts 拆分出的独立模块，负责：
 *   1. start() / stop() 生命周期
 *   2. Agent 事件订阅/取消（9 种事件）并转发为精灵事件
 *   3. 触发器处理（handleTrigger + generateSmartSuggestions）
 *   4. 文件监听注册/重建
 *   5. 回收站自动清理（定时器 + 过期清理）
 *   6. 作品投影更新（文件变化触发）
 *
 * 不持有 Sprite 状态（spriteHandlers、emitSprite 等通过回调注入）。
 */
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { Agent, AgentEventMap, ITracer } from 'memora';
import { logger, toError } from 'memora';
import type { TriggerBus } from './triggers.js';
import type { TriggerPayload } from './triggers.js';
import { FileWatcherTrigger } from './fileWatcherTrigger.js';
import type { SpriteConfig } from './spriteConfig.js';
import type { MemoryController } from './controllers/index.js';
import type { ProactiveEngine } from './controllers/index.js';
import type { PerceptionCoordinator } from './controllers/perceptionCoordinator.js';
import { SPRITE_TRACE_SPANS } from './spriteTracer.js';
import { MS_PER_DAY } from './constants.js';

/** 回收站自动清理间隔（毫秒，默认 6 小时检查一次） */
const RECYCLE_BIN_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * 精灵事件发射回调类型
 * 将 Sprite.emitSprite 的签名抽象为独立类型，避免循环依赖
 */
export type SpriteEventEmitter = <K extends string>(event: K, payload: unknown) => void;

/** 生命周期管理器依赖项 */
export interface LifecycleDeps {
  agent: Agent;
  triggerBus: TriggerBus;
  config: Required<SpriteConfig>;
  proactiveEngine: ProactiveEngine;
  perceptionCoordinator: PerceptionCoordinator;
  memoryController: MemoryController;
  tracer: ITracer | null;
  projectPath: string;
  dataDir: string;
  allowedPaths: string[];
  /** 精灵事件发射器（由 Sprite.inject） */
  emit: SpriteEventEmitter;
}

/**
 * 精灵生命周期管理器
 *
 * 管理精灵的启动、停止、触发器响应和 Agent 事件订阅。
 * 所有状态由 Sprite 门面持有，LifecycleManager 仅负责编排逻辑。
 */
export class SpriteLifecycleManager {
  private agent: Agent;
  private triggerBus: TriggerBus;
  private config: Required<SpriteConfig>;
  private proactiveEngine: ProactiveEngine;
  private perceptionCoordinator: PerceptionCoordinator;
  private memoryController: MemoryController;
  private readonly tracer: ITracer | null;
  private projectPath: string;
  private dataDir: string;
  private allowedPaths: string[];
  private emit: SpriteEventEmitter;

  /** Agent 事件处理器引用（用于 off 取消订阅） */
  private agentHandlers: {
    memoryAdded?: (e: AgentEventMap['memoryAdded']) => void;
    personaSwitched?: (e: AgentEventMap['personaSwitched']) => void;
    insightExtracted?: (e: AgentEventMap['insightExtracted']) => void;
    conflictDetected?: (e: AgentEventMap['conflictDetected']) => void;
    projectSwitched?: (e: AgentEventMap['projectSwitched']) => void;
    skillMatched?: (e: AgentEventMap['skillMatched']) => void;
    memoryRecalled?: (e: AgentEventMap['memoryRecalled']) => void;
    decayCompleted?: (e: AgentEventMap['decayCompleted']) => void;
    sessionForked?: (e: AgentEventMap['sessionForked']) => void;
  } = {};

  /** 回收站自动清理定时器句柄 */
  private recycleBinCleanupTimer: ReturnType<typeof setInterval> | null = null;

  /** 触发器回调引用（用于 stop 时注销） */
  private triggerCallback: ((payload: TriggerPayload) => void) | null = null;

  /** 运行状态（start/stop 控制） */
  private running = false;

  constructor(deps: LifecycleDeps) {
    this.agent = deps.agent;
    this.triggerBus = deps.triggerBus;
    this.config = deps.config;
    this.proactiveEngine = deps.proactiveEngine;
    this.perceptionCoordinator = deps.perceptionCoordinator;
    this.memoryController = deps.memoryController;
    this.tracer = deps.tracer;
    this.projectPath = deps.projectPath;
    this.dataDir = deps.dataDir;
    this.allowedPaths = deps.allowedPaths;
    this.emit = deps.emit;
  }

  // ─── 生命周期 ──────────────────────────────────────────

  /** 启动精灵主控循环 */
  start(): void {
    this.running = true;

    // 注册触发器回调
    this.triggerCallback = (payload: TriggerPayload) => {
      this.handleTrigger(payload);
    };
    this.triggerBus.on(this.triggerCallback);
    this.triggerBus.start();

    // 订阅 Agent 事件
    this.subscribeAgentEvents();

    // 启动回收站自动清理定时器
    this.startRecycleBinCleanup();

    logger.info('精灵已启动，等待唤醒...');
  }

  /** 停止精灵主控 */
  stop(): void {
    this.running = false;
    this.triggerBus.stop();
    this.unsubscribeAgentEvents();
    this.stopRecycleBinCleanup();
    this.triggerCallback = null;
  }

  // ─── 文件监听 ──────────────────────────────────────────

  /** 注册 FileWatcherTrigger */
  registerFileWatcher(): void {
    const watchPaths = this.config.fileWatcherPaths.map((p) => resolve(this.projectPath, p));
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

  /**
   * 重建文件监听触发器
   * 先注销当前 fileWatcher，再根据 config.fileWatcherEnabled 决定是否重新注册。
   */
  rebuildFileWatcher(): void {
    this.triggerBus.unregister('fileWatcher');
    if (this.config.fileWatcherEnabled) {
      this.registerFileWatcher();
    }
    this.restartTriggersIfRunning();
  }

  /**
   * 若 TriggerBus 正在运行则重启
   * 配置变更后需重启 TriggerBus 使新触发器生效。
   */
  restartTriggersIfRunning(): void {
    if (this.running) {
      this.triggerBus.stop();
      this.triggerBus.start();
    }
  }

  // ─── 回收站自动清理 ──────────────────────────────

  /** 启动回收站自动清理定时器 */
  private startRecycleBinCleanup(): void {
    this.stopRecycleBinCleanup();

    const retentionDays = this.config.recycleBinRetentionDays;
    if (retentionDays <= 0) {
      logger.info({ retentionDays }, '回收站自动清理已禁用（retentionDays=0）');
      return;
    }

    // 启动时立即执行一次
    this.purgeExpiredMemories();

    this.recycleBinCleanupTimer = setInterval(
      () => this.purgeExpiredMemories(),
      RECYCLE_BIN_CLEANUP_INTERVAL_MS,
    );
    if (this.recycleBinCleanupTimer.unref) {
      this.recycleBinCleanupTimer.unref();
    }
    logger.info(
      { retentionDays, intervalHours: RECYCLE_BIN_CLEANUP_INTERVAL_MS / (60 * 60 * 1000) },
      '回收站自动清理定时器已启动',
    );
  }

  /** 停止回收站自动清理定时器 */
  private stopRecycleBinCleanup(): void {
    if (this.recycleBinCleanupTimer) {
      clearInterval(this.recycleBinCleanupTimer);
      this.recycleBinCleanupTimer = null;
    }
  }

  /** 执行一次过期记忆清理 */
  private purgeExpiredMemories(): void {
    const inspector = this.agent.memory;
    if (!inspector) return;

    const retentionDays = this.config.recycleBinRetentionDays;
    if (retentionDays <= 0) return;

    const threshold = new Date(Date.now() - retentionDays * MS_PER_DAY);
    try {
      const purgedCount = inspector.purgeExpired(threshold);
      if (purgedCount > 0) {
        logger.info(
          { purgedCount, retentionDays, threshold: threshold.toISOString() },
          '回收站自动清理完成',
        );
        // 通知 UI 显示清理数量（首次启动时 bridge 可能尚未注册，事件静默丢失不影响功能）
        this.deps.emit('trashPurged', { purgedCount });
      }
    } catch (err) {
      logger.warn(
        { err: toError(err).message, threshold: threshold.toISOString() },
        '回收站自动清理失败',
      );
    }
  }

  // ─── Agent 事件订阅 ────────────────────────────────────

  /** 订阅 Agent 事件，转发为精灵事件 */
  private subscribeAgentEvents(): void {
    // memoryAdded → memoryNoticed
    const onMemoryAdded = (e: AgentEventMap['memoryAdded']) => {
      this.emit('memoryNoticed', { source: e.source, name: e.name });
      this.proactiveEngine.addNotice('memory', `[${e.source}] ${e.name}`);
      logger.info({ source: e.source, name: e.name }, '注意到新记忆');
    };
    this.agentHandlers.memoryAdded = onMemoryAdded;
    this.agent.on('memoryAdded', onMemoryAdded);

    // personaSwitched → personaChanged
    const onPersonaSwitched = (e: AgentEventMap['personaSwitched']) => {
      this.emit('personaChanged', { from: e.from, to: e.to });
      this.proactiveEngine.addNotice('persona', `${e.from ?? '(无)'} → ${e.to}`);
      this.perceptionCoordinator.refreshBeforeChat();
      logger.info({ from: e.from, to: e.to }, '角色切换');
    };
    this.agentHandlers.personaSwitched = onPersonaSwitched;
    this.agent.on('personaSwitched', onPersonaSwitched);

    // insightExtracted → insightGained
    const onInsightExtracted = (e: AgentEventMap['insightExtracted']) => {
      this.emit('insightGained', { source: e.source, insight: e.insight });
      this.proactiveEngine.addNotice('insight', e.insight);
      logger.info({ insight: e.insight }, '获得洞察');
    };
    this.agentHandlers.insightExtracted = onInsightExtracted;
    this.agent.on('insightExtracted', onInsightExtracted);

    // conflictDetected → conflictDetected（直接转发）
    const onConflictDetected = (e: AgentEventMap['conflictDetected']) => {
      this.emit('conflictDetected', {
        newMemoryId: e.newMemoryId,
        newInsight: e.newInsight,
        targetId: e.targetId,
        targetContent: e.targetContent,
      });
      logger.info(
        { newMemoryId: e.newMemoryId, targetId: e.targetId },
        '检测到记忆冲突',
      );
    };
    this.agentHandlers.conflictDetected = onConflictDetected;
    this.agent.on('conflictDetected', onConflictDetected);

    // 项目切换 → projectSwitched
    const onProjectSwitched = (e: AgentEventMap['projectSwitched']) => {
      this.emit('projectSwitched', {
        from: e.from,
        to: e.to,
        projectName: e.projectName,
      });
      logger.info({ from: e.from, to: e.to, projectName: e.projectName }, '项目切换');
    };
    this.agentHandlers.projectSwitched = onProjectSwitched;
    this.agent.on('projectSwitched', onProjectSwitched);

    // 技能匹配 → skillMatched
    const onSkillMatched = (e: AgentEventMap['skillMatched']) => {
      this.emit('skillMatched', { skill: e.skill, score: e.score });
      logger.debug({ skill: e.skill, score: e.score }, '技能匹配');
    };
    this.agentHandlers.skillMatched = onSkillMatched;
    this.agent.on('skillMatched', onSkillMatched);

    // 记忆召回 → memoryRecalled
    const onMemoryRecalled = (e: AgentEventMap['memoryRecalled']) => {
      this.emit('memoryRecalled', { count: e.count, query: e.query });
    };
    this.agentHandlers.memoryRecalled = onMemoryRecalled;
    this.agent.on('memoryRecalled', onMemoryRecalled);

    // 衰减完成 → decayCompleted
    const onDecayCompleted = (e: AgentEventMap['decayCompleted']) => {
      this.emit('decayCompleted', { decayedCount: e.decayedCount });
      logger.info({ decayedCount: e.decayedCount }, '记忆衰减完成');
    };
    this.agentHandlers.decayCompleted = onDecayCompleted;
    this.agent.on('decayCompleted', onDecayCompleted);

    // 会话分叉 → sessionForked
    const onSessionForked = (e: AgentEventMap['sessionForked']) => {
      this.emit('sessionForked', {
        from: e.from,
        to: e.to,
        messageCount: e.messageCount,
      });
      logger.info({ from: e.from, to: e.to, messageCount: e.messageCount }, '会话分叉完成');
    };
    this.agentHandlers.sessionForked = onSessionForked;
    this.agent.on('sessionForked', onSessionForked);
  }

  /** 取消订阅 Agent 事件 */
  private unsubscribeAgentEvents(): void {
    if (this.agentHandlers.memoryAdded) {
      this.agent.off('memoryAdded', this.agentHandlers.memoryAdded);
    }
    if (this.agentHandlers.personaSwitched) {
      this.agent.off('personaSwitched', this.agentHandlers.personaSwitched);
    }
    if (this.agentHandlers.insightExtracted) {
      this.agent.off('insightExtracted', this.agentHandlers.insightExtracted);
    }
    if (this.agentHandlers.conflictDetected) {
      this.agent.off('conflictDetected', this.agentHandlers.conflictDetected);
    }
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
    if (this.agentHandlers.sessionForked) {
      this.agent.off('sessionForked', this.agentHandlers.sessionForked);
    }
    this.agentHandlers = {};
  }

  // ─── 触发器处理 ────────────────────────────────────────

  /**
   * 基于健康度数据生成智能建议
   * 纯代码计算，不依赖 LLM。检测重复记忆、过期记忆、用户画像缺失。
   */
  private generateSmartSuggestions(): void {
    try {
      const health = this.memoryController.getHealthDashboard();

      const dupCount = health.duplicates.reduce((sum, g) => sum + g.memories.length, 0);
      if (dupCount > 0) {
        this.proactiveEngine.addNotice('suggestion', `发现 ${dupCount} 条重复记忆，建议清理以保持记忆库整洁`);
      }

      if (health.staleMemories.length > 5) {
        this.proactiveEngine.addNotice('suggestion', `有 ${health.staleMemories.length} 条记忆可能已过时，需要回顾一下吗？`);
      }

      const dashboard = this.memoryController.dashboard();
      const profileCount = dashboard.bySource['profile'] ?? 0;
      if (profileCount === 0 && health.totalMemories > 10) {
        this.proactiveEngine.addNotice('suggestion', '还没有用户画像，告诉我更多关于你的信息吧，这样我能更好地帮助你');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, '智能建议生成失败');
    }
  }

  /** 处理触发器事件 */
  handleTrigger(payload: TriggerPayload): void {
    const span = this.tracer?.startSpan(SPRITE_TRACE_SPANS.TRIGGER, {
      source: payload.source,
      reason: payload.reason,
    });
    try {
      if (payload.source === 'fileWatcher') {
        this.proactiveEngine.addNotice('file', payload.reason);
        logger.info({ reason: payload.reason, source: payload.source }, '文件变化触发');
        this.tryUpdateWorkProjection(payload.reason);
      } else {
        logger.info({ reason: payload.reason, source: payload.source }, '触发唤醒');
      }

      this.generateSmartSuggestions();
    } catch (err) {
      span?.recordException(err instanceof Error ? err : new Error(String(err)));
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg, source: payload.source }, '触发器处理异常');
    } finally {
      span?.end();
    }
  }

  /**
   * 尝试更新作品投影（文件变化触发）
   * 只更新已有投影的文件，避免对无关文件做 LLM 调用。
   */
  private tryUpdateWorkProjection(reason: string): void {
    const works = this.agent.works;
    if (!works) return;

    const match = reason.match(/文件变化：(.+?)（/);
    if (!match || !match[1]) return;

    const filename = match[1];
    const fullPath = resolve(this.projectPath, filename);

    (async () => {
      try {
        if (!existsSync(fullPath)) {
          return;
        }

        const existing = await works.getProjection(fullPath);
        if (!existing) {
          return;
        }

        const content = await readFile(fullPath, 'utf-8');
        const entry = await works.ensureProjection(fullPath, content, filename);

        if (entry) {
          logger.info({ sourcePath: fullPath, summary: entry.summary }, '作品投影已更新');
          this.emit('workProjectionUpdated', {
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