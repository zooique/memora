/**
 * 内存会话存储实现 — ISessionStore 的纯 JS 内存版
 *
 * 设计理念：
 * - 零依赖零 IO，用于单元测试、临时占位
 * - 单一存储模型：round-based（会话仅持 roundIds，消息内容在 RoundStore）
 *
 * 存储结构：
 * - metas: Map（sessionId → SessionMeta）— 元数据
 * - roundIdsMap: Map（sessionId → string[]）— 会话的 Round ID 列表（唯一内容来源）
 * - roundStore: IRoundStore — 问答闭环物理存储（真相源）
 */

import { isRoundSettled } from '@/memory/roundStore.js';
import type { IRoundStore } from '@/memory/roundStore.js';
import type {
  ISessionStore,
  SessionMessage,
  SessionMeta,
} from '@/memory/sessionStore.js';
import { InMemoryRoundStore } from '@/memory/inMemoryRoundStore.js';

/**
 * 内存会话存储
 */
export class InMemorySessionStore implements ISessionStore {
  private readonly roundStore: IRoundStore;
  /** 会话元数据存储 */
  private readonly metas = new Map<string, SessionMeta>();
  /** Round ID 列表存储：key = sessionId，value = roundId 数组（round-based 模式） */
  private readonly roundIdsMap = new Map<string, string[]>();

  constructor(roundStore?: IRoundStore) {
    this.roundStore = roundStore ?? new InMemoryRoundStore();
  }

  // ─── 会话消息读写（round-based 唯一真相源） ──────────

  /**
   * 加载指定会话的完整消息列表（从 roundIds → RoundStore 展开）。
   */
  loadMessages(date: string, session: string): SessionMessage[] {
    const sessionId = `${date}-${session}`;
    const roundIds = this.getRoundIds(sessionId);
    if (roundIds.length === 0) return [];

    const rounds = this.roundStore.getByIds(roundIds);
    const messages: SessionMessage[] = [];
    for (const round of rounds) {
      messages.push({
        role: round.userMessage.role,
        content: round.userMessage.content,
        timestamp: round.userMessage.timestamp,
        roundId: round.id,
      });
      // 判据收口 isRoundSettled：中断轮（interrupted）同样计入——本方法是 LLM 历史注入
      // （restoreHistory）唯一上游，漏计会让中断轮回复从上下文消失（见该函数文档）
      if (round.assistantMessage && isRoundSettled(round.status)) {
        messages.push({
          role: round.assistantMessage.role,
          content: round.assistantMessage.content,
          timestamp: round.assistantMessage.timestamp,
          roundId: round.id,
        });
      }
    }
    return messages;
  }

  // ─── 通用方法 ─────────────────────────────────────────

  /**
   * 列出所有会话标识
   */
  listSessions(): string[] {
    const sessions = new Set<string>();
    // 从 roundIds 中收集
    for (const sessionId of this.roundIdsMap.keys()) {
      sessions.add(sessionId);
    }
    // 从 metas 中收集
    for (const sessionId of this.metas.keys()) {
      sessions.add(sessionId);
    }
    return Array.from(sessions).sort();
  }

  /**
   * 获取会话元数据
   *
   * SSOT：SessionMeta 为纯展示 DTO（不含 roundIds），Round ID 需经 getRoundIds() 真源读取
   */
  getSessionMeta(sessionId: string): SessionMeta | undefined {
    return this.metas.get(sessionId);
  }

  /**
   * 设置会话标题
   */
  setSessionTitle(sessionId: string, title: string): void {
    const existing = this.metas.get(sessionId);
    if (existing) {
      this.metas.set(sessionId, {
        ...existing,
        displayName: title,
        updatedAt: new Date().toISOString(),
      });
    } else {
      const messageCount = this.deriveMessageCount(sessionId);
      this.metas.set(sessionId, {
        sessionId,
        displayName: title,
        updatedAt: new Date().toISOString(),
        messageCount,
      });
    }
  }

  /**
   * 更新会话元数据
   */
  updateSessionMeta(sessionId: string, meta: Partial<SessionMeta>): void {
    const existing = this.metas.get(sessionId);
    if (existing) {
      this.metas.set(sessionId, {
        ...existing,
        ...meta,
        updatedAt: new Date().toISOString(),
      });
    } else {
      const messageCount = this.deriveMessageCount(sessionId);
      this.metas.set(sessionId, {
        sessionId,
        updatedAt: new Date().toISOString(),
        messageCount,
        ...meta,
      });
    }
  }

  /**
   * 列出所有会话元数据（按 updatedAt **降序**，最近活跃在前——ISessionStore 排序契约）
   *
   * 方向必须与宿主实现一致：SessionManager.restoreMostRecentSession 视 [0] 为「最近活跃
   * 唯一真理源」，升规则会恢复成最旧会话。
   */
  listSessionMetas(): SessionMeta[] {
    return Array.from(this.metas.values()).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
  }

  // ─── Round-based 模式方法 ──────────────────────────────

  /**
   * 追加 Round ID 到会话
   */
  appendRoundId(sessionId: string, roundId: string): void {
    const roundIds = this.roundIdsMap.get(sessionId) ?? [];
    roundIds.push(roundId);
    this.roundIdsMap.set(sessionId, roundIds);

    // 更新元数据
    this.updateMessageCount(sessionId);
  }

  /**
   * 批量追加 Round ID 到会话
   */
  appendRoundIds(sessionId: string, roundIds: string[]): void {
    const existing = this.roundIdsMap.get(sessionId) ?? [];
    const merged = [...existing, ...roundIds];
    this.roundIdsMap.set(sessionId, merged);

    // 更新元数据
    this.updateMessageCount(sessionId);
  }

  /**
   * 获取会话的 Round ID 列表
   */
  getRoundIds(sessionId: string): string[] {
    return this.roundIdsMap.get(sessionId) ?? [];
  }

  /**
   * 设置会话的 Round ID 列表
   */
  setRoundIds(sessionId: string, roundIds: string[]): void {
    this.roundIdsMap.set(sessionId, [...roundIds]);

    // 更新元数据
    this.updateMessageCount(sessionId);
  }

  /**
   * 创建新会话元数据
   */
  createSession(meta: SessionMeta): void {
    // SSOT：SessionMeta 为纯展示 DTO（无 roundIds），设置轮次请走 setRoundIds 真源
    this.metas.set(meta.sessionId, { ...meta });
  }

  /**
   * 删除会话
   */
  deleteSession(sessionId: string): void {
    // 引用递减：被删除会话放弃其 Round 引用（refCount 归零的轮由 GC 回收）
    const roundIds = this.roundIdsMap.get(sessionId) ?? [];
    for (const roundId of roundIds) {
      this.roundStore.decrementRef(roundId);
    }
    this.metas.delete(sessionId);
    this.roundIdsMap.delete(sessionId);
  }

  // ─── 私有辅助方法 ─────────────────────────────────────

  /**
   * 更新会话的消息计数（round-based 固有语义缓存：每个完整轮 = User+AI 2 条）。
   * 派生逻辑单一真源 = deriveMessageCount（本方法仅做「写回 meta」副作用）。
   */
  private updateMessageCount(sessionId: string): void {
    const meta = this.metas.get(sessionId);
    if (!meta) return;
    this.metas.set(sessionId, {
      ...meta,
      messageCount: this.deriveMessageCount(sessionId),
      updatedAt: new Date().toISOString(),
    });
  }

  /**
   * 派生会话消息数（round-based 固有语义：roundIds.length * 2）——**单一真源**。
   */
  private deriveMessageCount(sessionId: string): number {
    const roundIds = this.roundIdsMap.get(sessionId) ?? [];
    return roundIds.length * 2;
  }

  /**
   * 清空所有存储（测试用）
   */
  clear(): void {
    this.metas.clear();
    this.roundIdsMap.clear();
  }
}
