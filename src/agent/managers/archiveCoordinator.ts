/**
 * 归档协调器：归档会话元数据（SessionMeta）+ 二态归档模式统一判断 + 失败事件发射。
 * 归档=更新 SessionMeta（summary/keyTopics/autoName），仅用于搜索索引，不进记忆召回。
 */

import type { SessionArchiver, SessionArchiveResult } from '@/agent/managers/sessionArchiver.js';
import type { AgentEventMap } from '@/utils/eventEmitter.js';
import type { ArchiveMode } from '@/agent/types.js';
import { logger } from '@/logging/logger.js';

/** 事件发射回调类型（Agent 注入 this.emit） */
type EmitCallback = <K extends keyof AgentEventMap>(event: K, payload: AgentEventMap[K]) => void;

/** ArchiveCoordinator 构造选项 */
export interface ArchiveCoordinatorOptions {
  /** 获取 SessionArchiver（可能为 null） */
  readonly getSessionArchiver: () => SessionArchiver | null;
  /** 获取当前 archiveMode（二态控制集中到本类，自动触发据此判断是否跳过） */
  readonly getArchiveMode: () => ArchiveMode;
  /** 事件发射回调（Agent 注入 this.emit） */
  readonly emit: EmitCallback;
}

/**
 * 归档触发选项：区分自动触发（postProcess/会话切换）与手动触发（用户点击）。
 * 自动触发由 archiveMode 判断是否跳过；手动触发无条件执行（用户意图优先）。
 */
export interface ArchiveTriggerOptions {
  /** 系统自动触发（默认 false=手动触发，不受模式限制） */
  autoTriggered?: boolean;
}

export class ArchiveCoordinator {
  private readonly getSessionArchiver: () => SessionArchiver | null;
  private readonly getArchiveMode: () => ArchiveMode;
  private readonly emit: EmitCallback;

  constructor(opts: ArchiveCoordinatorOptions) {
    this.getSessionArchiver = opts.getSessionArchiver;
    this.getArchiveMode = opts.getArchiveMode;
    this.emit = opts.emit;
  }

  /**
   * 派生会话归档自动触发允许性（archiveMode → 是否自动归档的唯一显式映射）：
   * ArchiveMode 'full' → 自动触发允许；'manual' → 仅手动。轮次摘要不受本映射影响（无模式开关，总是生成）。
   */
  private resolveAutoArchiveAllowed(): boolean {
    return this.getArchiveMode() === 'full';
  }

  /**
   * 归档会话。模式判断：自动触发+manual→跳过；自动+auto→执行；手动触发→无条件执行。
   * 异常 catch 后发射 archiveFailed 事件并返回空降级结果，保证调用方不中断主流程。
   * @returns updatedFields 可能为空（无归档价值或 LLM 失败）
   */
  async archiveSession(
    date: string,
    session: string,
    options?: ArchiveTriggerOptions,
  ): Promise<SessionArchiveResult> {
    // 手动触发无条件执行；自动触发受 resolveAutoArchiveAllowed 门控
    if (options?.autoTriggered && !this.resolveAutoArchiveAllowed()) {
      logger.debug(
        { mode: this.getArchiveMode(), stage: 'session' },
        'sessionArchive=manual 跳过自动会话归档',
      );
      return { updatedFields: [], sessionLabel: `${date}-${session}`, messageCount: 0 };
    }
    const sessionArchiver = this.getSessionArchiver();
    if (!sessionArchiver) {
      return { updatedFields: [], sessionLabel: `${date}-${session}`, messageCount: 0 };
    }
    try {
      const result = await sessionArchiver.archiveSession(date, session);
      return result;
    } catch (err) {
      this.handleArchiveError('session', err);
      return { updatedFields: [], sessionLabel: `${date}-${session}`, messageCount: 0 };
    }
  }

  /** 统一处理归档异常：记日志 + 发射 archiveFailed 事件。日志与事件二者互补不替代。 */
  private handleArchiveError(stage: 'session', err: unknown): void {
    const label = stage.charAt(0).toUpperCase() + stage.slice(1);
    logger.error({ err, stage }, `archive${label} 异常`);
    const message = err instanceof Error ? err.message : String(err);
    this.emit('archiveFailed', { stage, message: message.slice(0, 200) });
  }
}
