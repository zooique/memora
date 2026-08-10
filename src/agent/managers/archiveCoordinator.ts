/**
 * 归档协调器（从 agent.ts 拆分）
 *
 * 职责：
 *   1. 归档用户画像事实（archiveProfileFacts）
 *   2. 归档洞察记忆（archiveInsight）
 *   3. 归档会话内容（archiveSessionContent）
 *   4. 归档完成事件发射（memoryAdded / insightExtracted / archiveFailed）
 *   5. archiveMode 三态控制集中判断（FIX-P1-4）
 *
 * 设计理由：
 *   agent.ts 原承担 15+ 职责，归档操作是独立的领域职责，
 *   拆分后 Agent 聚焦对话编排，ArchiveCoordinator 聚焦归档操作 + 模式判断。
 *
 * FIX-P1-4（2026-07-24）：archiveMode 三态控制集中到本类
 *   原实现三态判断散落在 3 处：
 *     - Agent.postProcessInner 判断 'manual' 跳过 profile/insight 自动归档
 *     - 宿主 sessionHandlers.ts 判断 'full' 触发 content 自动归档
 *     - ArchiveCoordinator 名为"协调器"实为"执行器"，不感知模式
 *   修复后：
 *     - ArchiveCoordinator 构造时注入 getArchiveMode getter
 *     - 3 个归档方法新增 autoTriggered 参数区分自动/手动触发
 *     - 自动触发时由本类内部按模式判断是否跳过（统一协调点）
 *     - setArchiveMode/getArchiveMode 仍保留在 Agent（涉及 _chatBusy 和 #config）
 *
 * 自然生长原则：
 *   - 使用 getter 回调注入依赖（getUserProfile / getInsightExtractor / getSessionArchiver / getArchiveMode）
 *     避免 close 时额外清理，Agent null 化字段后 getter 自然返回 null
 *   - 通过回调发射事件（不继承 TypedEventEmitter）
 *   - 不做 assertInitialized 检查（由 Agent 在调用前保证）
 */

import type { Memory } from '@/memory/types.js';
import type { UserProfile, UserProfileEntry } from '@/memory/userProfile.js';
import type { InsightExtractor } from '@/agent/managers/insightExtractor.js';
import type { SessionArchiver, SessionArchiveResult } from '@/agent/managers/sessionArchiver.js';
import { extractUserFacts } from '@/agent/userFactExtractor.js';
import type { AgentEventMap } from '@/utils/eventEmitter.js';
// archiveMode 三态类型，本类作为模式判断的统一协调点
import type { ArchiveMode } from '@/agent/types.js';
import { logger } from '@/logging/logger.js';

/** 事件发射回调类型（Agent 注入 this.emit） */
type EmitCallback = <K extends keyof AgentEventMap>(
  event: K,
  payload: AgentEventMap[K],
) => void;

/**
 * 待重试的归档项（MIND2-C3：归档失败不再永久丢失）
 *
 * 当 archiveProfileFacts / archiveInsight 失败时，将输入存入 pending 队列，
 * 下次同阶段归档调用时先重试 pending 项。content 阶段从 session store 读取，
 * 可手动重试，不进队列。
 */
interface PendingArchive {
  /** 归档阶段（profile / insight，content 不进队列） */
  readonly stage: 'profile' | 'insight';
  /** 本轮用户输入（profile/insight 提取的源文本） */
  readonly input: string;
  /** 助手回复内容（仅 insight 阶段需要） */
  readonly assistantContent?: string;
  /** 入队时间戳（用于淘汰过旧项 + 日志追踪） */
  readonly enqueuedAt: number;
}

/** ArchiveCoordinator 构造选项 */
export interface ArchiveCoordinatorOptions {
  /** 获取 UserProfile（可能为 null，Agent 未初始化或未加载时） */
  readonly getUserProfile: () => UserProfile | null;
  /** 获取 InsightExtractor（可能为 null） */
  readonly getInsightExtractor: () => InsightExtractor | null;
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
 * 归档协调器
 *
 * 使用方式：
 *   const coordinator = new ArchiveCoordinator({
 *     getUserProfile: () => this.#userProfile,
 *     getInsightExtractor: () => this.insightExtractor,
 *     getSessionArchiver: () => this.sessionArchiver,
 *     getArchiveMode: () => this.#config.archiveMode,
 *     emit: this.emit.bind(this),
 *   });
 *   // 手动触发（用户主动）
 *   await coordinator.archiveProfileFacts(input);
 *   // 自动触发（postProcess / 会话切换）
 *   await coordinator.archiveProfileFacts(input, { autoTriggered: true });
 */
export class ArchiveCoordinator {
  /** pending 队列上限——超过则丢弃最旧项，避免 LLM 长时间不可用时无限增长 */
  private static readonly MAX_PENDING = 50;

  /** 获取 UserProfile 的回调 */
  private readonly getUserProfile: () => UserProfile | null;
  /** 获取 InsightExtractor 的回调 */
  private readonly getInsightExtractor: () => InsightExtractor | null;
  /** 获取 SessionArchiver 的回调 */
  private readonly getSessionArchiver: () => SessionArchiver | null;
  /** 获取当前 archiveMode 的回调（FIX-P1-4） */
  private readonly getArchiveMode: () => ArchiveMode;
  /** 事件发射回调 */
  private readonly emit: EmitCallback;

  /**
   * 待重试归档队列（MIND2-C3）
   *
   * 归档失败时入队，下次同阶段归档调用时先重试。
   * 仅 profile/insight 阶段入队（content 从 session store 读取，可手动重试）。
   */
  private readonly pendingArchives: PendingArchive[] = [];

  constructor(opts: ArchiveCoordinatorOptions) {
    this.getUserProfile = opts.getUserProfile;
    this.getInsightExtractor = opts.getInsightExtractor;
    this.getSessionArchiver = opts.getSessionArchiver;
    this.getArchiveMode = opts.getArchiveMode;
    this.emit = opts.emit;
  }

  /**
   * 归档用户画像事实
   *
   * 模式判断（FIX-P1-4，集中到本类）：
   *   - 自动触发 + manual 模式 → 跳过（返回空），用户需手动调用
   *   - 自动触发 + full/insights-only 模式 → 执行
   *   - 手动触发（任何模式） → 执行（用户意图优先）
   *
   * @param input 本轮用户输入
   * @param options 触发选项（autoTriggered 默认 false）
   * @returns 写入/更新的 UserProfileEntry 列表
   */
  async archiveProfileFacts(
    input: string,
    options?: ArchiveTriggerOptions,
  ): Promise<UserProfileEntry[]> {
    // 自动触发 + manual 模式 → 跳过（原 Agent.postProcessInner 的 skipAutoArchive 逻辑）
    if (options?.autoTriggered && this.getArchiveMode() === 'manual') {
      logger.debug({ mode: 'manual', stage: 'profile' }, 'manual 模式跳过自动 profile 归档');
      return [];
    }
    const userProfile = this.getUserProfile();
    if (!userProfile) return [];

    // MIND2-C3：先重试 pending 队列中同阶段的失败归档（LLM 恢复后自动补录）
    await this.retryPendingArchives('profile');

    try {
      const turnIndex = `turn-${Date.now()}`;
      const facts = extractUserFacts(input, turnIndex);
      const entries = await userProfile.archiveFacts(facts);
      // 发射 memoryAdded 事件：与自动归档路径一致，保持宿主 UI 行为统一
      for (const entry of entries) {
        if (entry.confirmed) {
          this.emit('memoryAdded', { id: entry.id, source: 'profile', name: entry.value });
        }
      }
      return entries;
    } catch (err) {
      this.handleArchiveError('profile', err);
      // MIND2-C3：失败入队，下次同阶段归档时自动重试（不再永久丢失）
      this.enqueuePending('profile', input);
      return [];
    }
  }

  /**
   * 提取并归档洞察记忆
   *
   * 模式判断（FIX-P1-4，集中到本类）：
   *   - 自动触发 + manual 模式 → 跳过（返回空），用户需手动调用
   *   - 自动触发 + full/insights-only 模式 → 执行
   *   - 手动触发（任何模式） → 执行（用户意图优先）
   *
   * 内部仍走 classify 判断（避免无价值输入浪费 LLM 调用）。
   *
   * @param input 本轮用户输入
   * @param assistantContent 本轮助手回复内容
   * @param options 触发选项（autoTriggered 默认 false）
   * @returns 写入/更新的 Memory 列表
   */
  async archiveInsight(
    input: string,
    assistantContent: string,
    options?: ArchiveTriggerOptions,
  ): Promise<Memory[]> {
    // 自动触发 + manual 模式 → 跳过（原 Agent.postProcessInner 的 skipAutoArchive 逻辑）
    if (options?.autoTriggered && this.getArchiveMode() === 'manual') {
      logger.debug({ mode: 'manual', stage: 'insight' }, 'manual 模式跳过自动 insight 归档');
      return [];
    }
    const insightExtractor = this.getInsightExtractor();
    if (!insightExtractor) return [];

    // MIND2-C3：先重试 pending 队列中同阶段的失败归档（LLM 恢复后自动补录）
    await this.retryPendingArchives('insight');

    try {
      // 内部仍走 classify 判断，避免无价值输入浪费 LLM 调用
      const shouldExtract = insightExtractor.classify(input);
      if (shouldExtract !== 'extract') return [];
      const memories = await insightExtractor.extract(input, assistantContent);
      // 发射 memoryAdded + insightExtracted 事件：与自动归档路径一致
      for (const memory of memories) {
        this.emit('memoryAdded', { id: memory.id, source: memory.source, name: memory.name });
        this.emit('insightExtracted', { source: memory.source, insight: memory.content });
      }
      return memories;
    } catch (err) {
      this.handleArchiveError('insight', err);
      // MIND2-C3：失败入队（含 assistantContent），下次同阶段归档时自动重试
      this.enqueuePending('insight', input, assistantContent);
      return [];
    }
  }

  /**
   * 归档会话内容（content 类记忆）
   *
   * 模式判断（FIX-P1-4，集中到本类）：
   *   - 自动触发 + full 模式 → 执行（会话切换前自动归档）
   *   - 自动触发 + insights-only/manual 模式 → 跳过，用户需手动调用
   *   - 手动触发（任何模式） → 执行（用户意图优先，如"一键归档"按钮）
   *
   * 错误传播契约：
   *   - SessionArchiver LLM 异常 / 写入失败向上抛出（不内部吞掉）。
   *   - 本方法 catch 异常并发射 archiveFailed({ stage: 'content' }) 事件，
   *     让宿主 UI 可感知会话内容归档失败。
   *   - archiveProfileFacts / archiveInsight 同样 catch 并发射 archiveFailed
   *     事件（stage 分别为 'profile' / 'insight'），三阶段统一闭环。
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
      // 发射 memoryAdded 事件：与 insight 自动归档路径一致，宿主可据此刷新记忆面板
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
   * 三段归档方法（profile/insight/content）的 catch 模板完全相同，
   * 提取为私有方法消除重复（ADR-017 枝叶层 2 次提取原则，3 次阈值已满足）。
   *
   * @param stage 归档阶段标识（用于日志结构化字段 + archiveFailed 事件 payload）
   * @param err 捕获的异常
   */
  private handleArchiveError(stage: 'profile' | 'insight' | 'content', err: unknown): void {
    // 记录根因到日志（UI 通知走 archiveFailed 事件，日志走 logger.error，两者不替代）
    // 首字母大写拼接方法名（profile → Profile）保持日志可读性
    const label = stage.charAt(0).toUpperCase() + stage.slice(1);
    logger.error({ err, stage }, `archive${label} 异常`);
    const message = err instanceof Error ? err.message : String(err);
    this.emit('archiveFailed', { stage, message: message.slice(0, 200) });
  }

  // ─── MIND2-C3：pending 队列管理 ──────────────────────────

  /**
   * 将失败的归档输入入队（MIND2-C3）
   *
   * 仅 profile/insight 阶段入队——content 从 session store 读取可手动重试。
   * 队列满时丢弃最旧项（FIFO 淘汰），避免 LLM 长时间不可用时无限增长。
   *
   * @param stage 归档阶段（profile / insight）
   * @param input 本轮用户输入
   * @param assistantContent 助手回复（仅 insight 阶段）
   */
  private enqueuePending(
    stage: 'profile' | 'insight',
    input: string,
    assistantContent?: string,
  ): void {
    if (this.pendingArchives.length >= ArchiveCoordinator.MAX_PENDING) {
      // 队列满，丢弃最旧项（shift 弹出队首）
      const dropped = this.pendingArchives.shift();
      logger.warn(
        { droppedStage: dropped?.stage, queueSize: this.pendingArchives.length },
        'pending 归档队列已满，丢弃最旧项',
      );
    }
    this.pendingArchives.push({
      stage,
      input,
      assistantContent,
      enqueuedAt: Date.now(),
    });
    logger.info(
      { stage, queueSize: this.pendingArchives.length },
      '归档失败已入 pending 队列，下次同阶段归档时自动重试',
    );
  }

  /**
   * 重试 pending 队列中指定阶段的所有失败归档（MIND2-C3）
   *
   * 在 archiveProfileFacts / archiveInsight 入口调用，先清空同阶段 pending 项：
   *   - 成功 → 从队列移除（补录完成）
   *   - 失败 → 保留在队列（等下次再试，不无限重试——每次调用只重试一轮）
   *
   * 重试失败不发射 archiveFailed 事件（避免重复 toast 节流），仅 debug 日志。
   * 重试成功正常发射 memoryAdded / insightExtracted 事件（与首次成功一致）。
   *
   * @param stage 要重试的阶段（profile / insight）
   */
  private async retryPendingArchives(stage: 'profile' | 'insight'): Promise<void> {
    // 筛选同阶段的 pending 项（保留其他阶段的不动）
    const pending = this.pendingArchives.filter((p) => p.stage === stage);
    if (pending.length === 0) return;

    logger.debug({ stage, count: pending.length }, '开始重试 pending 归档');

    for (const item of pending) {
      try {
        if (stage === 'profile') {
          const userProfile = this.getUserProfile();
          if (!userProfile) continue; // UserProfile 仍不可用，保留在队列
          const turnIndex = `turn-${item.enqueuedAt}`;
          const facts = extractUserFacts(item.input, turnIndex);
          const entries = await userProfile.archiveFacts(facts);
          for (const entry of entries) {
            if (entry.confirmed) {
              this.emit('memoryAdded', { id: entry.id, source: 'profile', name: entry.value });
            }
          }
        } else {
          // stage === 'insight'
          const insightExtractor = this.getInsightExtractor();
          if (!insightExtractor) continue;
          const shouldExtract = insightExtractor.classify(item.input);
          if (shouldExtract !== 'extract') continue;
          const memories = await insightExtractor.extract(
            item.input,
            item.assistantContent ?? '',
          );
          for (const memory of memories) {
            this.emit('memoryAdded', { id: memory.id, source: memory.source, name: memory.name });
            this.emit('insightExtracted', { source: memory.source, insight: memory.content });
          }
        }
        // 重试成功 → 从队列移除
        const idx = this.pendingArchives.indexOf(item);
        if (idx !== -1) this.pendingArchives.splice(idx, 1);
        logger.info({ stage }, 'pending 归档重试成功，已从队列移除');
      } catch (err) {
        // 重试失败 → 保留在队列，下次再试（仅 debug 日志，不重复发射 archiveFailed）
        logger.debug({ err, stage }, 'pending 归档重试仍失败，保留在队列');
      }
    }
  }

  /**
   * 获取 pending 归档队列长度（MIND2-C3）
   *
   * 供宿主 UI 查询是否有待补归档，展示"N 条待补"提示。
   * Agent 不直接消费此值——通过 IPC 暴露给渲染层。
   *
   * @returns pending 队列中的待重试归档数
   */
  getPendingArchiveCount(): number {
    return this.pendingArchives.length;
  }
}
