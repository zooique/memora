/**
 * 内存会话视图加载器 — ISessionViewLoader 的内存版实现
 *
 * 职责：将 Session（Round ID 列表）+ RoundStore（物理存储）组合成完整视图
 *
 * 使用场景：
 * - 宿主生产：宿主封装本类并注入文件系统存储（VS Code 宿主 WorkspaceSessionViewLoader
 *   即委托本类，入口 extension.ts → sessionViewLoader.ts:delegate）
 * - 测试环境（零依赖）
 * - 开发调试
 */

import type { IRoundStore } from '@/memory/roundStore.js';
import type { ISessionStore, SessionMeta } from '@/memory/sessionStore.js';
// 会话显示名回退单一真理源（displayName→autoName），sessionId 兜底留在调用端
import { getSessionDisplayName } from '@/memory/sessionStore.js';
import {
  flattenRoundsToMessages,
  truncateRoundsUpTo,
  countMessagesInRounds,
} from '@/memory/sessionViewLoader.js';
import type {
  ISessionViewLoader,
  SessionView,
  SessionSummary,
} from '@/memory/sessionViewLoader.js';

/**
 * 内存会话视图加载器
 *
 * 实现策略：
 * 1. 从 SessionStore 获取 SessionMeta（含 roundIds）
 * 2. 从 RoundStore 批量加载所有 Round
 * 3. 展开为扁平消息列表
 * 4. 支持截断操作（分叉场景）
 */
export class InMemorySessionViewLoader implements ISessionViewLoader {
  private readonly roundStore: IRoundStore;
  private readonly sessionStore: ISessionStore;

  constructor(roundStore: IRoundStore, sessionStore: ISessionStore) {
    this.roundStore = roundStore;
    this.sessionStore = sessionStore;
  }

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
  loadView(sessionId: string): SessionView {
    // 1. 获取会话元数据
    const meta = this.getSessionMeta(sessionId);
    if (!meta) {
      throw new Error(`会话不存在: ${sessionId}`);
    }

    // 2. 获取 Round ID 列表
    const roundIds = this.getRoundIds(sessionId);

    // 3. 批量加载 Round
    const rounds = this.roundStore.getByIds(roundIds);

    // 4. 展开为扁平消息列表
    const messages = flattenRoundsToMessages(rounds);

    return {
      sessionId,
      meta,
      rounds,
      messages,
    };
  }

  /**
   * 加载会话的简化摘要（用于历史列表等轻量场景）
   *
   * @param sessionId - 会话 ID
   * @returns 会话摘要，不存在返回 null
   */
  loadSummary(sessionId: string): SessionSummary | null {
    // 获取会话元数据
    const meta = this.getSessionMeta(sessionId);
    if (!meta) return null;

    // 获取 Round ID 列表
    const roundIds = this.getRoundIds(sessionId);

    // 加载最后一个 Round（用于预览）
    const lastRoundId = roundIds[roundIds.length - 1];
    let lastMessagePreview: string | undefined;

    if (lastRoundId) {
      const lastRound = this.roundStore.getById(lastRoundId);
      if (lastRound) {
        // 取 AI 消息的前 50 个字符作为预览
        if (lastRound.assistantMessage) {
          lastMessagePreview = lastRound.assistantMessage.content.slice(0, 50);
          if (lastRound.assistantMessage.content.length > 50) {
            lastMessagePreview += '...';
          }
        }
      }
    }

    // 计算标题（SSOT 显示名回退 displayName→autoName，sessionId 作最后兜底）
    const title = getSessionDisplayName(meta) || sessionId;

    return {
      sessionId,
      title,
      roundCount: roundIds.length,
      updatedAt: meta.updatedAt,
      lastMessagePreview,
    };
  }

  /**
   * 批量加载多个会话的摘要
   *
   * @param sessionIds - 会话 ID 数组
   * @returns 会话摘要数组
   */
  loadBatchSummaries(sessionIds: string[]): SessionSummary[] {
    const summaries: SessionSummary[] = [];

    for (const sessionId of sessionIds) {
      const summary = this.loadSummary(sessionId);
      if (summary) {
        summaries.push(summary);
      }
    }

    // 按 updatedAt 降序排列
    summaries.sort((a, b) => {
      return b.updatedAt > a.updatedAt ? 1 : b.updatedAt < a.updatedAt ? -1 : 0;
    });

    return summaries;
  }

  /**
   * 获取会话的消息数量
   *
   * 不加载完整 Round 数据，仅统计消息数
   *
   * @param sessionId - 会话 ID
   * @returns 消息数量（User + AI）
   */
  getMessageCount(sessionId: string): number {
    const meta = this.getSessionMeta(sessionId);
    if (!meta) return 0;
    return meta.messageCount;
  }

  /**
   * 从指定 Round 位置截断会话视图
   *
   * 用途：分叉操作时获取分叉点之前的对话
   *
   * @param sessionId - 会话 ID
   * @param upToRoundId - 截断到哪个 Round（包含）
   * @returns 截断后的会话视图
   */
  loadViewUpTo(sessionId: string, upToRoundId: string): SessionView {
    // 1. 获取完整视图
    const fullView = this.loadView(sessionId);

    // 2. 截断 Round 列表
    const truncatedRounds = truncateRoundsUpTo(fullView.rounds, upToRoundId);

    // 3. 重新展开消息列表
    const messages = flattenRoundsToMessages(truncatedRounds);

    // 4. 更新元数据中的消息数
    const updatedMeta: SessionMeta = {
      ...fullView.meta,
      messageCount: countMessagesInRounds(truncatedRounds),
    };

    return {
      sessionId,
      meta: updatedMeta,
      rounds: truncatedRounds,
      messages,
    };
  }

  // ─── 私有辅助方法 ─────────────────────────────────────

  /**
   * 获取会话元数据
   *
   * 直接走 sessionStore.getSessionMeta——ISessionStore 接口**必选**方法（sessionStore.ts 契约），
   * 宿主与内核实现均齐备；历史「listSessionMetas 兜底」为类型兜底残留（接口已保证存在，
   * 运行时存在性判断恒真），2026-09-20 站 50 收口。返回浅拷贝防外部改 meta 污染存储。
   */
  private getSessionMeta(sessionId: string): SessionMeta | null {
    const meta = this.sessionStore.getSessionMeta(sessionId);
    return meta ? { ...meta } : null;
  }

  /**
   * 获取会话的 Round ID 列表（SSOT：唯一真源为 sessionStore.getRoundIds）
   *
   * SessionMeta 已回归纯展示 DTO（无 roundIds 字段），轮次一律经真源方法读取。
   * 接口契约保证返回 string[]（非空数组也可能），直接展开即可，无需存在性判断。
   */
  private getRoundIds(sessionId: string): string[] {
    return [...this.sessionStore.getRoundIds(sessionId)];
  }
}
