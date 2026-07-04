/**
 * 归档协调器（HC-18 拆分自 agent.ts）
 *
 * 职责：
 *   1. 手动归档用户画像事实（archiveProfileFacts）
 *   2. 手动归档洞察记忆（archiveInsight）
 *   3. 手动归档会话内容（archiveSessionContent）
 *   4. 归档完成事件发射（memoryAdded / insightExtracted）
 *
 * 设计理由：
 *   agent.ts 原承担 15+ 职责，归档操作是独立的领域职责，
 *   拆分后 Agent 聚焦对话编排，ArchiveCoordinator 聚焦手动归档操作。
 *
 * 与 setArchiveMode 的关系：
 *   setArchiveMode / getArchiveMode 保留在 Agent 中（涉及 _chatBusy 和 #config 私有字段）。
 *   ArchiveCoordinator 只负责归档操作执行，不管理模式状态。
 *
 * 自然生长原则：
 *   - 使用 getter 回调注入依赖（getUserProfile / getInsightExtractor / getSessionArchiver）
 *     避免 close 时额外清理，Agent null 化字段后 getter 自然返回 null
 *   - 通过回调发射事件（不继承 TypedEventEmitter）
 *   - 不做 assertInitialized 检查（由 Agent 在调用前保证）
 */

import type { Memory } from '@/memory/types.js';
import type { UserProfile, UserProfileEntry } from '@/memory/userProfile.js';
import type { InsightExtractor } from '@/agent/managers/insightExtractor.js';
import type { SessionArchiver, SessionArchiveResult } from '@/agent/managers/sessionArchiver.js';
import { extractUserFacts } from '@/agent/managers/userFactExtractor.js';
import type { AgentEventMap } from '@/utils/eventEmitter.js';

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
  /** 事件发射回调（Agent 注入 this.emit） */
  readonly emit: EmitCallback;
}

/**
 * 归档协调器
 *
 * 使用方式：
 *   const coordinator = new ArchiveCoordinator({
 *     getUserProfile: () => this.#userProfile,
 *     getInsightExtractor: () => this.insightExtractor,
 *     getSessionArchiver: () => this.sessionArchiver,
 *     emit: this.emit.bind(this),
 *   });
 *   await coordinator.archiveProfileFacts(input);
 *   await coordinator.archiveInsight(input, assistantContent);
 *   await coordinator.archiveSessionContent(date, session);
 */
export class ArchiveCoordinator {
  /** 获取 UserProfile 的回调 */
  private readonly getUserProfile: () => UserProfile | null;
  /** 获取 InsightExtractor 的回调 */
  private readonly getInsightExtractor: () => InsightExtractor | null;
  /** 获取 SessionArchiver 的回调 */
  private readonly getSessionArchiver: () => SessionArchiver | null;
  /** 事件发射回调 */
  private readonly emit: EmitCallback;

  constructor(opts: ArchiveCoordinatorOptions) {
    this.getUserProfile = opts.getUserProfile;
    this.getInsightExtractor = opts.getInsightExtractor;
    this.getSessionArchiver = opts.getSessionArchiver;
    this.emit = opts.emit;
  }

  /**
   * 手动触发 profile facts 归档（manual 模式下使用）
   *
   * manual 模式下 postProcess 跳过自动归档，用户需通过此 API 主动归档。
   * full / insights-only 模式下也可调用（会重复归档，但不推荐）。
   *
   * @param input 本轮用户输入
   * @returns 写入/更新的 UserProfileEntry 列表
   */
  async archiveProfileFacts(input: string): Promise<UserProfileEntry[]> {
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
   * 手动触发 insight 提取（manual 模式下使用）
   *
   * manual 模式下 postProcess 跳过自动归档，用户需通过此 API 主动归档。
   * 内部仍走 classify 判断（避免无价值输入浪费 LLM 调用）。
   *
   * @param input 本轮用户输入
   * @param assistantContent 本轮助手回复内容
   * @returns 写入/更新的 Memory 列表
   */
  async archiveInsight(input: string, assistantContent: string): Promise<Memory[]> {
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
   * GAP-2：手动归档会话内容（content 类记忆）
   *
   * 适用于 `insights-only` / `manual` 模式下用户手动触发会话内容归档。
   * `full` 模式下由宿主在会话切换前自动调用，无需用户干预。
   *
   * @param date 会话日期 YYYY-MM-DD
   * @param session 会话标识（不含日期前缀）
   * @returns 归档结果（memories 可能为空，表示无归档价值或 LLM 失败）
   */
  async archiveSessionContent(date: string, session: string): Promise<SessionArchiveResult> {
    const sessionArchiver = this.getSessionArchiver();
    if (!sessionArchiver) {
      return { memories: [], sessionLabel: `${date}-${session}`, messageCount: 0 };
    }
    const result = await sessionArchiver.archiveSessionContent(date, session);
    // 发射 memoryAdded 事件：与 insight 自动归档路径一致，宿主可据此刷新记忆面板
    for (const memory of result.memories) {
      this.emit('memoryAdded', { id: memory.id, source: memory.source, name: memory.name });
    }
    return result;
  }
}
