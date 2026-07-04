/**
 * 记忆衰减调度器（HC-18 拆分自 agent.ts）
 *
 * 职责：
 *   1. 定期执行记忆 score 衰减（体现"自然遗忘"）
 *   2. 衰减指标统计（执行次数 / 累计衰减记忆数 / 上次衰减时间）
 *   3. 衰减可观测性（Tracer Span 埋点）
 *   4. 衰减完成事件发射（decayCompleted）
 *
 * 设计理由：
 *   agent.ts 原承担 15+ 职责，记忆衰减是独立的生命周期职责，
 *   拆分后 Agent 聚焦对话编排，MemoryDecayScheduler 聚焦记忆自然遗忘。
 *
 * 衰减范围：
 *   - insight（洞察记忆）
 *   - profile（用户画像记忆）
 *   - work-projection（作品投影）
 *   不衰减 persona/rule/skill（配置型记忆不应衰减）
 *
 * 自然生长原则：
 *   - 不持有 storage 引用（start 时注入，stop 时释放）
 *   - 通过回调发射事件（不继承 TypedEventEmitter，避免与 Agent 事件系统耦合）
 *   - 指标统计内聚（getMetrics 返回快照，Agent.getMetrics 直接合并）
 */

import { safeSetInterval, clearSafeInterval } from '@/utils/safeTimer.js';
import { logger } from '@/logging/logger.js';
import { toError } from '@/utils/errors.js';
import { nowIso } from '@/utils/time.js';
import { SOURCE_LABELS } from '@/memory/types.js';
import { NOOP_TRACER, TRACE_SPANS, type ITracer } from '@/agent/tracer.js';

/** 衰减完成的回调类型（Agent 注入 emit('decayCompleted', ...)） */
export type DecayCompletedCallback = (payload: { decayedCount: number }) => void;

/** MemoryDecayScheduler 构造选项 */
export interface MemoryDecaySchedulerOptions {
  /** 可观测性 Tracer（未注入时降级为 NOOP_TRACER） */
  readonly tracer?: ITracer;
  /** 衰减完成事件发射回调（Agent 注入 this.emit.bind(this, 'decayCompleted')） */
  readonly onDecayCompleted: DecayCompletedCallback;
}

/** 衰减指标快照（供 Agent.getMetrics 合并） */
export interface DecayMetrics {
  /** 衰减执行次数（每次 runOnce 实际执行 +1） */
  readonly runCount: number;
  /** 累计衰减记忆数（score 被调低的记忆条数总和） */
  readonly totalDecayedCount: number;
  /** 上次衰减时间（ISO 8601，null 表示从未执行过） */
  readonly lastRunAt: string | null;
}

/**
 * 记忆衰减调度器
 *
 * 使用方式：
 *   const scheduler = new MemoryDecayScheduler({ tracer, onDecayCompleted });
 *   scheduler.start(storage, intervalMs);  // 启动定时衰减
 *   scheduler.runOnce();                    // 立即执行一次衰减
 *   scheduler.stop();                       // 停止定时衰减
 *   scheduler.getMetrics();                 // 获取衰减指标快照
 */
export class MemoryDecayScheduler {
  /** 可观测性 Tracer（默认 NOOP，零开销） */
  private readonly tracer: ITracer;
  /** 衰减完成事件发射回调 */
  private readonly onDecayCompleted: DecayCompletedCallback;

  /** 衰减定时器（null 表示未启动） */
  private decayTimer: ReturnType<typeof setInterval> | null = null;
  /** 衰减目标存储（start 时注入，stop 时释放） */
  private storage: IMemoryStorageLike | null = null;

  // ─── 衰减指标统计字段 ──────────────────────────────────
  /** 衰减执行次数（每次 runOnce 实际执行 +1） */
  private metricDecayRunCount: number = 0;
  /** 累计衰减记忆数（score 被调低的记忆条数总和） */
  private metricTotalDecayedCount: number = 0;
  /** 上次衰减时间（ISO 8601，null 表示从未执行过） */
  private metricLastDecayAt: string | null = null;

  constructor(opts: MemoryDecaySchedulerOptions) {
    this.tracer = opts.tracer ?? NOOP_TRACER;
    this.onDecayCompleted = opts.onDecayCompleted;
  }

  /**
   * 启动定期衰减
   *
   * @param storage 衰减目标存储（IMemoryStorage.decayScores）
   * @param intervalMs 衰减间隔（毫秒，通常为 1 小时）
   */
  start(storage: IMemoryStorageLike, intervalMs: number): void {
    this.storage = storage;
    // 立即执行一次首次衰减
    this.runOnce();
    // 注册定期衰减
    this.decayTimer = safeSetInterval(() => this.runOnce(), intervalMs);
  }

  /**
   * 停止定期衰减，释放资源
   *
   * 清理定时器和 storage 引用，防止 close 后回调触发。
   */
  stop(): void {
    if (this.decayTimer) {
      clearSafeInterval(this.decayTimer);
      this.decayTimer = null;
    }
    this.storage = null;
  }

  /**
   * 执行一次记忆衰减
   *
   * 对 insight/profile/work-projection 记忆执行 score 衰减，
   * 长期未访问的记忆 score 逐渐降低，体现"自然遗忘"。
   * 不影响 persona/rule/skill（这些是配置型记忆，不应衰减）。
   *
   * 衰减逻辑委派给 IMemoryStorage.decayScores()，
   * 宿主（SqliteStorage）可用一条 SQL UPDATE 批量完成，避免 O(n) 全量加载。
   */
  runOnce(): void {
    if (!this.storage) return;
    // R-103 衰减 Span：记录衰减执行过程，补全衰减可观测性缺口
    const decaySpan = this.tracer.startSpan(TRACE_SPANS.DECAY);
    try {
      const sources = [SOURCE_LABELS.INSIGHT, SOURCE_LABELS.PROFILE, SOURCE_LABELS.WORK_PROJECTION];
      const decayedCount = this.storage.decayScores(sources, new Date());
      logger.debug({ decayedCount }, '记忆衰减完成');

      // R-103 衰减指标统计：累计执行次数和衰减记忆数
      this.metricDecayRunCount++;
      this.metricTotalDecayedCount += decayedCount;
      this.metricLastDecayAt = nowIso();
      decaySpan.setAttribute('decayedCount', decayedCount);
      decaySpan.setAttribute('totalRuns', this.metricDecayRunCount);

      this.onDecayCompleted({ decayedCount });
    } catch (err) {
      logger.warn({ err }, '记忆衰减异常，跳过本轮');
      decaySpan.recordException(toError(err));
    } finally {
      decaySpan.end();
    }
  }

  /**
   * 获取衰减指标快照
   *
   * 供 Agent.getMetrics() 合并到完整 AgentMetrics 中。
   */
  getMetrics(): DecayMetrics {
    return {
      runCount: this.metricDecayRunCount,
      totalDecayedCount: this.metricTotalDecayedCount,
      lastRunAt: this.metricLastDecayAt,
    };
  }
}

/**
 * IMemoryStorage 的衰减子接口（接口隔离原则）
 *
 * MemoryDecayScheduler 只需要 decayScores 方法，不需要完整 IMemoryStorage。
 * 使用结构子接口便于测试 mock，同时避免对完整接口的过度耦合。
 */
export interface IMemoryStorageLike {
  /** 对指定 source 的记忆执行 score 衰减，返回被衰减的记忆条数 */
  decayScores(sources: readonly string[], now: Date): number;
}
