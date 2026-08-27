/**
 * 会话视图加载器 —— 将 Round ID 列表展开为完整对话
 *
 * 设计理念：
 * - 会话（Session）只存储 Round ID 列表
 * - RoundStore 存储问答闭环的物理数据
 * - SessionViewLoader 负责将两者组合成用户可见的逻辑视图
 *
 * 核心优势：
 * 1. 物理存储层与逻辑视图层解耦
 * 2. 支持分叉：多个会话可以引用同一组 Round
 * 3. 支持独立存储：Round 数据只存一份
 */

import type { Round, RoundMessage } from '@/memory/roundStore.js';
import type { SessionMeta } from '@/memory/sessionStore.js';

// ─── 会话视图 ───────────────────────────────────────────

/**
 * 会话视图：展开后的完整对话
 *
 * 这是用户可见的对话数据结构，包含：
 * - 会话元数据
 * - 问答闭环列表（按顺序）
 * - 展开后的消息列表（扁平结构）
 */
export interface SessionView {
  /** 会话 ID */
  sessionId: string;

  /** 会话元数据 */
  meta: SessionMeta;

  /** 问答闭环列表（按 roundIds 顺序） */
  rounds: Round[];

  /**
   * 展开后的消息列表（扁平结构）
   *
   * 顺序：round1.userMessage → round1.assistantMessage → round2.userMessage → ...
   * 仅包含 complete 状态的 assistantMessage
   */
  messages: RoundMessage[];
}

/**
 * 简化的会话视图（仅用于历史列表等轻量场景）
 */
export interface SessionSummary {
  /** 会话 ID */
  sessionId: string;

  /** 会话标题 */
  title: string;

  /** 问答闭环数量 */
  roundCount: number;

  /** 最后活跃时间 */
  updatedAt: string;

  /** 最后一条消息摘要（用于预览） */
  lastMessagePreview?: string;
}

// ─── 会话视图加载器接口 ─────────────────────────────────

/**
 * 会话视图加载器接口
 *
 * 职责：将 Session（Round ID 列表）+ RoundStore（物理存储）组合成完整视图
 *
 * 设计原则：
 * 1. 透明转换：调用方不需要关心底层存储结构
 * 2. 批量加载：避免 N+1 查询，一次性加载所有 Round
 * 3. 容错处理：部分 Round 加载失败时仍可返回可用视图
 */
export interface ISessionViewLoader {
  /**
   * 加载会话的完整对话视图
   *
   * 流程：
   * 1. 获取 SessionMeta（含 roundIds 列表）
   * 2. 从 RoundStore 批量加载所有 Round
   * 3. 展开为扁平消息列表
   *
   * @param sessionId - 会话 ID
   * @returns 完整会话视图
   * @throws Error 会话不存在时抛出
   */
  loadView(sessionId: string): SessionView;

  /**
   * 加载会话的简化摘要（用于历史列表等轻量场景）
   *
   * 与 loadView 的区别：
   * - 不加载完整 Round 数据
   * - 只返回元数据和统计信息
   *
   * @param sessionId - 会话 ID
   * @returns 会话摘要
   */
  loadSummary(sessionId: string): SessionSummary | null;

  /**
   * 批量加载多个会话的摘要
   *
   * 用于历史列表、批量操作等场景
   *
   * @param sessionIds - 会话 ID 数组
   * @returns 会话摘要数组
   */
  loadBatchSummaries(sessionIds: string[]): SessionSummary[];

  /**
   * 获取会话的消息数量（性能优化）
   *
   * 不加载完整 Round 数据，仅统计消息数
   *
   * @param sessionId - 会话 ID
   * @returns 消息数量（User + AI）
   */
  getMessageCount(sessionId: string): number;

  /**
   * 从指定 Round 位置截断会话视图
   *
   * 用途：分叉操作时获取分叉点之前的对话
   *
   * @param sessionId - 会话 ID
   * @param upToRoundId - 截断到哪个 Round（包含）
   * @returns 截断后的会话视图
   */
  loadViewUpTo(sessionId: string, upToRoundId: string): SessionView;
}

// ─── 辅助函数 ───────────────────────────────────────────

/**
 * 从 Round 列表展开为扁平消息列表
 *
 * @param rounds - Round 数组（按顺序）
 * @returns 展开后的消息数组
 */
export function flattenRoundsToMessages(rounds: Round[]): RoundMessage[] {
  const messages: RoundMessage[] = [];

  for (const round of rounds) {
    // 始终添加用户消息
    messages.push(round.userMessage);

    // 仅添加已完成的 AI 消息
    if (round.assistantMessage && round.status === 'complete') {
      messages.push(round.assistantMessage);
    }
  }

  return messages;
}

/**
 * 截断 Round 列表到指定位置
 *
 * @param rounds - Round 数组
 * @param upToRoundId - 截断到此 Round（包含）
 * @returns 截断后的 Round 数组
 */
export function truncateRoundsUpTo(rounds: Round[], upToRoundId: string): Round[] {
  const idx = rounds.findIndex((r) => r.id === upToRoundId);
  if (idx === -1) {
    return [...rounds]; // 未找到则返回全部
  }
  return rounds.slice(0, idx + 1);
}

/**
 * 计算 Round 列表的消息总数
 *
 * @param rounds - Round 数组
 * @returns 消息数量
 */
export function countMessagesInRounds(rounds: Round[]): number {
  let count = 0;
  for (const round of rounds) {
    count += 1; // 用户消息
    if (round.status === 'complete') {
      count += 1; // AI 消息（仅完成状态）
    }
  }
  return count;
}
