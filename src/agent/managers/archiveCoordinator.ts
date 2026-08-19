/**
 * 归档协调器
 *
 * 职责：
 *   1. 归档会话元数据（SessionMeta）
 *   2. 归档失败事件发射（archiveFailed）
 *   3. archiveMode 二态控制集中判断
 *
 * 归档架构：
 *   - 记忆系统只有 round-summary（轮次摘要）
 *   - 会话归档 = 更新 SessionMeta（summary / keyTopics / autoName）
 *   - SessionMeta 仅用于搜索/索引，不参与记忆召回
 *   - archiveFailed 错误处理保留
 */

import type { SessionArchiver, SessionArchiveResult } from '@/agent/managers/sessionArchiver.js';
import type { AgentEventMap } from '@/utils/eventEmitter.js';
// archiveMode 二态类型，本类作为模式判断的统一协调点
import type { ArchiveMode } from '@/agent/types.js';
import { logger } from '@/logging/logger.js';

/** 事件发射回调类型（Agent 注入 this.emit） */
type EmitCallback = <K extends keyof AgentEventMap>(
  event: K,
  payload: AgentEventMap[K],
) => void;

/** ArchiveCoordinator 构造选项 */
export interface ArchiveCoordinatorOptions {
  /** 获取 SessionArchiver（可能为 null） */
  readonly getSessionArchiver: () => SessionArchiver | null;
  /**
   * 获取当前 archiveMode（二态控制集中到本类）
   * Agent 注入 `() => this.#config.archiveMode`，本类据此判断自动触发是否跳过
   */
  readonly getArchiveMode: () => ArchiveMode;
  /** 事件发射回调（Agent 注入 this.emit） */
  readonly emit: EmitCallback;
  /**
   * 获取当前记忆写入模式（Phase 1：reflect.memoryWrite）
   * 'auto' → 自动写入（默认）；'confirm' → 写入前等待宿主确认
   */
  readonly getMemoryWriteMode?: () => 'auto' | 'confirm';
  /**
   * 获取当前会话归档模式（Phase 1：reflect.sessionArchive）
   * 'auto' → 自动归档（默认）；'manual' → 仅手动归档
   * 若未注入，回退到 getArchiveMode 的值
   */
  readonly getSessionArchiveMode?: () => 'auto' | 'manual';
}

/**
 * 归档触发选项
 *
 * 区分"自动触发"（postProcess / 会话切换等系统调用）与"手动触发"（用户主动点击归档按钮）。
 * 自动触发时由 ArchiveCoordinator 按 archiveMode 判断是否跳过；
 * 手动触发时无条件执行（用户意图优先，不受模式限制）。
 */
export interface ArchiveTriggerOptions {
  /**
   * 是否为系统自动触发（默认 false，即手动触发）
   * - true：postProcessInner / 会话切换等系统路径调用
   * - false：用户通过 UI 主动触发归档
   */
  autoTriggered?: boolean;
  /**
   * P3-1: 是否包含工作上下文（plan 快照），仅当前活会话有效
   *
   * 为 true 时，归档内容会追加当前会话的 plan 步骤列表，
   * 让记忆包含工作进度信息，便于恢复时了解任务上下文。
   * 历史会话（非当前活会话）不应设置此标志。
   */
  includeWorkContext?: boolean;
  /**
   * P3-1: 工作上下文 plan 快照（由调用方从 getCheckpoint() 提取）
   *
   * 调用方（Agent / 宿主 handler）从 SessionManager.getCheckpoint().plan
   * 提取后传入，避免 SessionArchiver 直接依赖 SessionManager。
   * includeWorkContext 为 true 时必填。
   */
  workContextPlan?: Array<{ order: number; description: string; status: string }>;
}

/**
 * 归档协调器
 *
 * 使用方式：
 *   const coordinator = new ArchiveCoordinator({
 *     getSessionArchiver: () => this.sessionArchiver,
 *     getArchiveMode: () => this.#config.archiveMode,
 *     emit: this.emit.bind(this),
 *   });
 *   // 手动触发（用户主动）
 *   await coordinator.archiveSession(date, session);
 *   // 自动触发（会话切换，full 模式）
 *   await coordinator.archiveSession(date, session, { autoTriggered: true });
 */
export class ArchiveCoordinator {
  /** 获取 SessionArchiver 的回调 */
  private readonly getSessionArchiver: () => SessionArchiver | null;
  /** 获取当前 archiveMode 的回调 */
  private readonly getArchiveMode: () => ArchiveMode;
  /** 事件发射回调 */
  private readonly emit: EmitCallback;
  /** 获取当前会话归档模式（Phase 1） */
  private readonly getSessionArchiveMode?: () => 'auto' | 'manual';

  constructor(opts: ArchiveCoordinatorOptions) {
    this.getSessionArchiver = opts.getSessionArchiver;
    this.getArchiveMode = opts.getArchiveMode;
    this.emit = opts.emit;
    this.getSessionArchiveMode = opts.getSessionArchiveMode;
  }

  /**
   * 归档会话
   *
   * 模式判断：
   *   - 自动触发 + full 模式 → 执行（会话切换前自动归档）
   *   - 自动触发 + manual 模式 → 跳过，用户需手动调用
   *   - 手动触发（任何模式） → 执行（用户意图优先）
   *
   * 错误传播契约：
   *   - SessionArchiver LLM 异常 / 写入失败向上抛出（不内部吞掉）。
   *   - 本方法 catch 异常并发射 archiveFailed({ stage: 'session' }) 事件，
   *     让宿主 UI 可感知归档失败。
   *   - 失败时返回空降级结果，保证调用方（如 SESSION_SWITCH 自动归档）不中断主流程。
   *
   * @param date 会话日期 YYYY-MM-DD
   * @param session 会话标识（不含日期前缀）
   * @param options 触发选项（autoTriggered 默认 false）
   * @returns 归档结果（updatedFields 可能为空，表示无归档价值或 LLM 失败）
   */
  async archiveSession(
    date: string,
    session: string,
    options?: ArchiveTriggerOptions,
  ): Promise<SessionArchiveResult> {
    // Phase 1：sessionArchive='manual' 且自动触发 → 跳过（优先于 archiveMode 三态）
    const archiveMode = this.getSessionArchiveMode?.() ?? (this.getArchiveMode() === 'full' ? 'auto' : 'manual');
    if (options?.autoTriggered && archiveMode === 'manual') {
      logger.debug(
        { mode: archiveMode, stage: 'session' },
        'sessionArchive=manual 跳过自动会话归档',
      );
      return { updatedFields: [], sessionLabel: `${date}-${session}`, messageCount: 0 };
    }
    const sessionArchiver = this.getSessionArchiver();
    if (!sessionArchiver) {
      return { updatedFields: [], sessionLabel: `${date}-${session}`, messageCount: 0 };
    }
    try {
      const result = await sessionArchiver.archiveSession(date, session, options);
      return result;
    } catch (err) {
      this.handleArchiveError('session', err);
      return { updatedFields: [], sessionLabel: `${date}-${session}`, messageCount: 0 };
    }
  }

  /**
   * 统一处理归档异常：记录日志 + 发射 archiveFailed 事件
   *
   * @param stage 归档阶段标识（session，供 archiveFailed 事件 payload + 日志）
   * @param err 捕获的异常
   */
  private handleArchiveError(stage: 'session', err: unknown): void {
    // 记录根因到日志（UI 通知走 archiveFailed 事件，日志走 logger.error，两者不替代）
    const label = stage.charAt(0).toUpperCase() + stage.slice(1);
    logger.error({ err, stage }, `archive${label} 异常`);
    const message = err instanceof Error ? err.message : String(err);
    this.emit('archiveFailed', { stage, message: message.slice(0, 200) });
  }
}