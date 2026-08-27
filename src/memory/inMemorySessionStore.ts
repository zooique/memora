/**
 * 内存会话存储实现 — ISessionStore 的纯 JS 内存版
 *
 * 设计理念：
 * - 零依赖零 IO，用于单元测试、临时占位
 * - 同时支持 legacy 模式和 round-based 模式
 * - 不持久化（进程退出即丢失），仅限测试/开发
 *
 * 存储结构：
 * - messages: Map（date/session → SessionMessage[]）— legacy 模式
 * - metas: Map（sessionId → SessionMeta）— 元数据
 * - roundIds: Map（sessionId → string[]）— round-based 模式
 */

import type {
  ISessionStore,
  SessionMessage,
  SessionMeta,
} from '@/memory/sessionStore.js';

/**
 * 内存会话存储
 */
export class InMemorySessionStore implements ISessionStore {
  /** 消息存储：key = `${date}/${session}`，value = 消息数组（legacy 模式） */
  private readonly messages = new Map<string, SessionMessage[]>();
  /** 检查点存储：key = sessionId，value = checkpoint JSON 字符串 */
  private readonly checkpoints = new Map<string, string>();
  /** 会话元数据存储 */
  private readonly metas = new Map<string, SessionMeta>();
  /** Round ID 列表存储：key = sessionId，value = roundId 数组（round-based 模式） */
  private readonly roundIdsMap = new Map<string, string[]>();

  // ─── Legacy 模式方法 ───────────────────────────────────

  /**
   * 追加消息到指定会话（legacy 模式）
   */
  appendMessage(date: string, session: string, message: SessionMessage): void {
    const key = `${date}/${session}`;
    const messages = this.messages.get(key) ?? [];
    messages.push(message);
    this.messages.set(key, messages);

    // 更新元数据
    const sessionId = `${date}-${session}`;
    this.updateMessageCount(sessionId);
  }

  /**
   * 加载指定会话消息列表（legacy 模式）
   */
  loadMessages(date: string, session: string): SessionMessage[] {
    const key = `${date}/${session}`;
    return this.messages.get(key) ?? [];
  }

  // ─── 通用方法 ─────────────────────────────────────────

  /**
   * 列出所有会话标识
   */
  listSessions(): string[] {
    // 从 legacy 模式的消息中收集
    const legacySessions = new Set<string>();
    for (const key of this.messages.keys()) {
      const [date, session] = key.split('/');
      legacySessions.add(`${date}-${session}`);
    }

    // 从 round-based 模式的 roundIds 中收集
    for (const sessionId of this.roundIdsMap.keys()) {
      legacySessions.add(sessionId);
    }

    // 从 metas 中收集
    for (const sessionId of this.metas.keys()) {
      legacySessions.add(sessionId);
    }

    return Array.from(legacySessions).sort();
  }

  /**
   * 复制源会话消息到目标会话
   */
  copySession(
    sourceDate: string,
    sourceSession: string,
    targetDate: string,
    targetSession: string,
  ): void {
    const sourceKey = `${sourceDate}/${sourceSession}`;
    const targetKey = `${targetDate}/${targetSession}`;

    const messages = this.messages.get(sourceKey);
    if (!messages) return; // 源不存在静默返回

    // 覆盖写入（幂等）
    this.messages.set(targetKey, messages.map((m) => ({ ...m })));
  }

  /**
   * 保存会话检查点
   */
  saveCheckpoint(sessionId: string, checkpoint: string): void {
    this.checkpoints.set(sessionId, checkpoint);
  }

  /**
   * 加载会话检查点
   */
  loadCheckpoint(sessionId: string): string | null {
    return this.checkpoints.get(sessionId) ?? null;
  }

  /**
   * 删除会话检查点
   */
  deleteCheckpoint(sessionId: string): void {
    this.checkpoints.delete(sessionId);
  }

  /**
   * 获取会话元数据
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
      // 创建新的元数据
      const messageCount = this.countMessagesForSession(sessionId);
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
      const messageCount = this.countMessagesForSession(sessionId);
      this.metas.set(sessionId, {
        sessionId,
        updatedAt: new Date().toISOString(),
        messageCount,
        ...meta,
      });
    }
  }

  /**
   * 列出所有会话元数据
   */
  listSessionMetas(): SessionMeta[] {
    return Array.from(this.metas.values()).sort((a, b) =>
      a.updatedAt.localeCompare(b.updatedAt),
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

    // 同步更新 meta 中的 roundIds 字段
    this.syncMetaRoundIds(sessionId);

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

    // 同步更新 meta 中的 roundIds 字段
    this.syncMetaRoundIds(sessionId);

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

    // 同步更新 meta 中的 roundIds 字段
    this.syncMetaRoundIds(sessionId);

    // 更新元数据
    this.updateMessageCount(sessionId);
  }

  /**
   * 创建新会话元数据
   */
  createSession(meta: SessionMeta): void {
    this.metas.set(meta.sessionId, { ...meta });

    // 如果有 roundIds，同时存储
    if (meta.roundIds && meta.roundIds.length > 0) {
      this.roundIdsMap.set(meta.sessionId, [...meta.roundIds]);
    }
  }

  /**
   * 删除会话
   */
  deleteSession(sessionId: string): void {
    this.metas.delete(sessionId);
    this.roundIdsMap.delete(sessionId);
    this.checkpoints.delete(sessionId);

    // 同时清理 legacy 模式的消息
    // sessionId 格式：YYYY-MM-DD-sessionName
    const parts = sessionId.split('-');
    if (parts.length >= 4) {
      const date = `${parts[0]}-${parts[1]}-${parts[2]}`;
      const session = parts.slice(3).join('-');
      const key = `${date}/${session}`;
      this.messages.delete(key);
    }
  }

  // ─── 私有辅助方法 ─────────────────────────────────────

  /**
   * 同步 meta 中的 roundIds 字段
   *
   * 确保 meta.roundIds 和 roundIdsMap 保持一致
   */
  private syncMetaRoundIds(sessionId: string): void {
    const meta = this.metas.get(sessionId);
    if (!meta) return;

    const roundIds = this.roundIdsMap.get(sessionId) ?? [];
    this.metas.set(sessionId, {
      ...meta,
      roundIds: [...roundIds],
    });
  }

  /**
   * 更新会话的消息计数
   */
  private updateMessageCount(sessionId: string): void {
    const meta = this.metas.get(sessionId);
    if (!meta) return;

    // 计算消息数
    let messageCount = 0;

    if (meta.storageMode === 'round-based' || this.roundIdsMap.has(sessionId)) {
      // round-based 模式：每个 Round 估算为 2 条消息
      const roundIds = this.roundIdsMap.get(sessionId) ?? meta.roundIds ?? [];
      messageCount = roundIds.length * 2;
    } else {
      // legacy 模式：从消息列表统计
      messageCount = this.countMessagesForSession(sessionId);
    }

    this.metas.set(sessionId, {
      ...meta,
      messageCount,
      updatedAt: new Date().toISOString(),
    });
  }

  /**
   * 统计会话消息数（legacy 模式）
   */
  private countMessagesForSession(sessionId: string): number {
    // sessionId 格式：YYYY-MM-DD-sessionName
    const parts = sessionId.split('-');
    if (parts.length < 4) return 0;

    const date = `${parts[0]}-${parts[1]}-${parts[2]}`;
    const session = parts.slice(3).join('-');
    const key = `${date}/${session}`;
    return this.messages.get(key)?.length ?? 0;
  }

  /**
   * 清空所有存储（测试用）
   */
  clear(): void {
    this.messages.clear();
    this.metas.clear();
    this.checkpoints.clear();
    this.roundIdsMap.clear();
  }
}
