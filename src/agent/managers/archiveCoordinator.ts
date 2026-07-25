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
// FIX-P1-4：archiveMode 三态类型，本类作为模式判断的统一协调点
import type { ArchiveMode } from '@/agent/types.js';
import { logger } from '@/logging/logger.js';

/** 事件发射回调类型（Agent 注入 this.emit） */
type EmitCallback = <K extends keyof AgentEventMap>(
  event: K,
  payload: AgentEventMap[K],
) => void;

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
    // FIX-P1-4：自动触发 + manual 模式 → 跳过（原 Agent.postProcessInner 的 skipAutoArchive 逻辑）
    if (options?.autoTriggered && this.getArchiveMode() === 'manual') {
      logger.debug({ mode: 'manual', stage: 'profile' }, 'manual 模式跳过自动 profile 归档');
      return [];
    }
    const userProfile = this.getUserProfile();
    if (!userProfile) return [];
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
    // FIX-P1-4：自动触发 + manual 模式 → 跳过（原 Agent.postProcessInner 的 skipAutoArchive 逻辑）
    if (options?.autoTriggered && this.getArchiveMode() === 'manual') {
      logger.debug({ mode: 'manual', stage: 'insight' }, 'manual 模式跳过自动 insight 归档');
      return [];
    }
    const insightExtractor = this.getInsightExtractor();
    if (!insightExtractor) return [];
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
   *     让宿主 UI 可感知会话内容归档失败（与 profile / insight 阶段对齐）。
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
    // FIX-P1-4：自动触发 + 非 full 模式 → 跳过（原 sessionHandlers.ts 的外部判断逻辑）
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
      const result = await sessionArchiver.archiveSessionContent(date, session);
      // 发射 memoryAdded 事件：与 insight 自动归档路径一致，宿主可据此刷新记忆面板
      for (const memory of result.memories) {
        this.emit('memoryAdded', { id: memory.id, source: memory.source, name: memory.name });
      }
      return result;
    } catch (err) {
      // LLM 异常 / 写入失败：发射 archiveFailed({ stage: 'content' }) 通知宿主 UI
      const message = err instanceof Error ? err.message : String(err);
      this.emit('archiveFailed', { stage: 'content', message: message.slice(0, 200) });
      return { memories: [], sessionLabel: `${date}-${session}`, messageCount: 0 };
    }
  }
}
