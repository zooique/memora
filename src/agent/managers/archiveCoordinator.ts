/**
 * 归档协调器（从 agent.ts 拆分）
 *
 * 职责：
 *   1. 归档会话内容（archiveSessionContent）
 *   2. 归档完成事件发射（memoryAdded / archiveFailed）
 *   3. archiveMode 三态控制集中判断（FIX-P1-4）
 *
 * 收敛说明（2026-08-14）：洞察层（InsightExtractor + archiveInsight + pending 队列）已移除，
 * 记忆收敛为 round-summary 单轨；本类仅保留 content 会话内容归档路径。
 *
 * 设计理由：
 *   agent.ts 原承担 15+ 职责，归档操作是独立的领域职责，
 *   拆分后 Agent 聚焦对话编排，ArchiveCoordinator 聚焦归档操作 + 模式判断。
 *
 * FIX-P1-4（2026-07-24）：archiveMode 三态控制集中到本类
 *   原实现三态判断散落在 3 处：
 *     - Agent.postProcessInner 判断 'manual' 跳过 insight 自动归档
 *     - 宿主 sessionHandlers.ts 判断 'full' 触发 content 自动归档
 *     - ArchiveCoordinator 名为"协调器"实为"执行器"，不感知模式
 *   修复后：
 *     - ArchiveCoordinator 构造时注入 getArchiveMode getter
 *     - 归档方法新增 autoTriggered 参数区分自动/手动触发
 *     - 自动触发时由本类内部按模式判断是否跳过（统一协调点）
 *     - setArchiveMode/getArchiveMode 仍保留在 Agent（涉及 _chatBusy 和 #config）
 */

import type { SessionArchiver, SessionArchiveResult } from '@/agent/managers/sessionArchiver.js';
import type { AgentEventMap } from '@/utils/eventEmitter.js';
// archiveMode 三态类型，本类作为模式判断的统一协调点
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
   * 获取当前 archiveMode（FIX-P1-4：三态控制集中到本类）
   * Agent 注入 `() => this.#config.archiveMode`，本类据此判断自动触发是否跳过
   */
  readonly getArchiveMode: () => ArchiveMode;
  /** 事件发射回调（Agent 注入 this.emit） */
  readonly emit: EmitCallback;
}

/**
 * 归档触发选项（FIX-P1-4）
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
   * 调用方（Agent / sprite handler）从 SessionManager.getCheckpoint().plan
   * 提取后传入，避免 SessionArchiver 直接依赖 SessionManager。
   * includeWorkContext 为 true 时必填。
   */
  workContextPlan?: Array<{ order: number; description: string; status: string }>;
}

/**
 * 归档协调器（content 会话归档）
 *
 * 使用方式：
 *   const coordinator = new ArchiveCoordinator({
 *     getSessionArchiver: () => this.sessionArchiver,
 *     getArchiveMode: () => this.#config.archiveMode,
 *     emit: this.emit.bind(this),
 *   });
 *   // 手动触发（用户主动）
 *   await coordinator.archiveSessionContent(date, session);
 *   // 自动触发（会话切换，full 模式）
 *   await coordinator.archiveSessionContent(date, session, { autoTriggered: true });
 */
export class ArchiveCoordinator {
  /** 获取 SessionArchiver 的回调 */
  private readonly getSessionArchiver: () => SessionArchiver | null;
  /** 获取当前 archiveMode 的回调（FIX-P1-4） */
  private readonly getArchiveMode: () => ArchiveMode;
  /** 事件发射回调 */
  private readonly emit: EmitCallback;

  constructor(opts: ArchiveCoordinatorOptions) {
    this.getSessionArchiver = opts.getSessionArchiver;
    this.getArchiveMode = opts.getArchiveMode;
    this.emit = opts.emit;
  }

  /**
   * 归档会话内容（content 类记忆）
   *
   * 模式判断（FIX-P1-4，集中到本类）：
   *   - 自动触发 + full 模式 → 执行（会话切换前自动归档）
   *   - 自动触发 + manual 模式 → 跳过，用户需手动调用
   *   - 手动触发（任何模式） → 执行（用户意图优先，如"一键归档"按钮）
   *
   * 错误传播契约：
   *   - SessionArchiver LLM 异常 / 写入失败向上抛出（不内部吞掉）。
   *   - 本方法 catch 异常并发射 archiveFailed({ stage: 'content' }) 事件，
   *     让宿主 UI 可感知会话内容归档失败。
   *   - 失败时返回空降级结果，保证调用方（如 SESSION_SWITCH 自动归档）不中断主流程。
   *
   * @param date 会话日期 YYYY-MM-DD
   * @param session 会话标识（不含日期前缀）
   * @param options 触发选项（autoTriggered 默认 false）
   * @returns 归档结果（memories 可能为空，表示无归档价值或 LLM 失败）
   */
  async archiveSessionContent(
    date: string,
    session: string,
    options?: ArchiveTriggerOptions,
  ): Promise<SessionArchiveResult> {
    // 自动触发 + 非 full 模式 → 跳过（原 sessionHandlers.ts 的外部判断逻辑）
    if (options?.autoTriggered && this.getArchiveMode() !== 'full') {
      logger.debug(
        { mode: this.getArchiveMode(), stage: 'content' },
        '非 full 模式跳过自动 content 归档',
      );
      return { memories: [], sessionLabel: `${date}-${session}`, messageCount: 0 };
    }
    const sessionArchiver = this.getSessionArchiver();
    if (!sessionArchiver) {
      return { memories: [], sessionLabel: `${date}-${session}`, messageCount: 0 };
    }
    try {
      const result = await sessionArchiver.archiveSessionContent(date, session, options);
      // 发射 memoryAdded 事件：宿主可据此刷新记忆面板
      for (const memory of result.memories) {
        this.emit('memoryAdded', { id: memory.id, source: memory.source, name: memory.name });
      }
      return result;
    } catch (err) {
      this.handleArchiveError('content', err);
      return { memories: [], sessionLabel: `${date}-${session}`, messageCount: 0 };
    }
  }

  /**
   * 统一处理归档异常：记录日志 + 发射 archiveFailed 事件
   *
   * @param stage 归档阶段标识（content，供 archiveFailed 事件 payload + 日志）
   * @param err 捕获的异常
   */
  private handleArchiveError(stage: 'content', err: unknown): void {
    // 记录根因到日志（UI 通知走 archiveFailed 事件，日志走 logger.error，两者不替代）
    const label = stage.charAt(0).toUpperCase() + stage.slice(1);
    logger.error({ err, stage }, `archive${label} 异常`);
    const message = err instanceof Error ? err.message : String(err);
    this.emit('archiveFailed', { stage, message: message.slice(0, 200) });
  }
}