/**
 * 消息历史：封装用户输入/Agent 回复的会话持久化，维护当前会话（date+session），经 ISessionStore 落库。
 *
 * 存储模式演进（2026-08-27）：
 * - legacy 模式：通过 appendMessage 写入消息列表（SessionMessage[]）
 * - round-based 模式：通过 appendUser/appendAssistant 同步写入 RoundStore + SessionStore 的 roundIds
 * 两种模式可共存：当 roundStore 注入时自动启用 round-based 模式，同时保持 legacy 写入以兼容
 */
import type { ISessionStore, SessionMessage } from '@/memory/sessionStore.js';
import type {
  IRoundStore,
  Round,
  RoundMessage,
} from '@/memory/roundStore.js';
import { logger } from '@/logging/logger.js';
import { configError } from '@/utils/errors.js';
import { safeSetTimeout } from '@/utils/safeTimer.js';
import { nowIso, todayDate } from '@/utils/time.js';

/** 分叉结果 */
export interface ForkResult {
  /** 新会话标识（不含日期前缀，如 "main-b1"） */
  newSession: string;
  /** 会话日期 */
  date: string;
  /** 从源会话复制的消息列表 */
  messages: SessionMessage[];
}

/** 消息历史类 */
export class MessageHistory {
  /** 当前日期 YYYY-MM-DD */
  private currentDate: string;
  /** 当前会话标识（不含日期前缀） */
  private currentSession: string;
  /** 挂起的 fire-and-forget 归档集合，Agent.close() 等待其完成 */
  private pendingArchives: Set<Promise<unknown>> = new Set();
  /** Round-based 模式下当前轮次的 pending Round 缓存（roundId → Round） */
  private pendingRounds: Map<string, Round> = new Map();

  constructor(
    /** 会话存储（可选）；注入则持久化，否则仅在内存保存（AgentLoop.messages[]） */
    private readonly sessionStore?: ISessionStore,
    initialDate?: string,
    initialSession = 'main',
    /** 问答闭环存储（可选）；注入则启用 round-based 模式，同时保留 legacy 写入 */
    private readonly roundStore?: IRoundStore,
  ) {
    this.currentDate = initialDate ?? todayDate();
    this.currentSession = initialSession;
  }

  /** 当前会话名（date-session 组合名） */
  get currentSessionName(): string {
    return `${this.currentDate}-${this.currentSession}`;
  }

  /** 当前日期 YYYY-MM-DD */
  get currentDateValue(): string {
    return this.currentDate;
  }

  /** 当前会话标识 */
  get currentSessionValue(): string {
    return this.currentSession;
  }

  /**
   * 是否启用 round-based 模式
   * 当 roundStore 注入且 sessionStore 支持 appendRoundId 时启用
   */
  private get isRoundBasedEnabled(): boolean {
    return !!this.roundStore && !!this.sessionStore?.appendRoundId;
  }

  /**
   * 最近 N 轮的 roundId 集合（互斥排除用）。
   * 已完整加载进上下文的轮次，其摘要不应再被召回注入，避免正文与摘要重复进上下文（浪费 token + 干扰判断）。
   * 从 sessionStore 取 roundId 非空的最近 N 轮去重；rounds = 上下文固定加载轮数；无 sessionStore/roundId 或异常时返回空数组。
   */
  getRecentRoundIds(rounds: number): string[] {
    if (!this.sessionStore || rounds <= 0) return [];
    try {
      const messages = this.sessionStore.loadMessages(this.currentDate, this.currentSession);
      const ids: string[] = [];
      const seen = new Set<string>();
      // 从后向前收集最近 rounds 轮的 roundId（去重，保最近）
      for (let i = messages.length - 1; i >= 0 && ids.length < rounds; i--) {
        const rid = messages[i]?.roundId;
        if (rid && !seen.has(rid)) {
          seen.add(rid);
          ids.push(rid);
        }
      }
      return ids;
    } catch (err) {
      logger.warn({ err }, '获取最近轮次 roundId 失败，跳过互斥排除');
      return [];
    }
  }

  /**
   * 当前会话第一条轮次的 roundId（会话起点背景，互斥排除用）。
   * 装配时若第一条不在最近轮内（长会话），完整对话层显式补入第一条，其 roundId 须计入 exclude
   * 避免其摘要被二次召回（与 getRecentRoundIds 同源同值）。
   */
  getFirstRoundId(): string | null {
    if (!this.sessionStore) return null;
    try {
      const messages = this.sessionStore.loadMessages(this.currentDate, this.currentSession);
      for (const m of messages) {
        if (m.roundId) return m.roundId;
      }
      return null;
    } catch (err) {
      logger.warn({ err }, '获取首轮 roundId 失败，跳过互斥排除');
      return null;
    }
  }

  /** 当前会话标识 */
  get session(): string {
    return this.currentSession;
  }

  /** 切换会话，返回新会话全名 */
  switchSession(newSession: string): string {
    this.currentSession = newSession;
    // 清空 pending rounds（会话切换后旧 pending round 不再有效）
    this.pendingRounds.clear();
    return this.currentSessionName;
  }

  /** 自动生成分支名：扫描已有 `sourceSession-bN` 会话，返回最大序号 +1（如 "main-b1"） */
  private autoBranchName(sourceSession: string): string {
    if (!this.sessionStore) return `${sourceSession}-b1`;
    const allSessions = this.sessionStore.listSessions();
    const prefix = `${sourceSession}-b`;
    const existingNumbers: number[] = [];
    for (const fullSession of allSessions) {
      // fullSession 格式为 YYYY-MM-DD-session
      const parts = fullSession.split('-');
      if (parts.length >= 4) {
        const sessionPart = parts.slice(3).join('-');
        if (sessionPart.startsWith(prefix)) {
          const numStr = sessionPart.slice(prefix.length);
          const num = parseInt(numStr, 10);
          if (!isNaN(num)) {
            existingNumbers.push(num);
          }
        }
      }
    }
    const nextNumber = existingNumbers.length > 0 ? Math.max(...existingNumbers) + 1 : 1;
    return `${prefix}${nextNumber}`;
  }

  /**
   * 分叉当前会话：加载消息 → 生成唯一新会话名 → copySession 复制 → 切换当前会话。
   * sessionStore 未注入 / copySession 未实现 / 无消息时抛错误；targetSession 当天不可与已有会话重名。
   */
  forkSession(targetSession?: string): ForkResult {
    if (!this.sessionStore) {
      throw configError('无法分叉会话', 'ISessionStore 未注入', ['在创建 Agent 时注入 sessionStore 参数']);
    }
    if (!this.sessionStore.copySession) {
      throw configError('无法分叉会话', 'ISessionStore.copySession 未实现', ['升级宿主项目的 ISessionStore 实现，添加 copySession() 方法']);
    }
    const sourceDate = this.currentDate;
    const sourceSession = this.currentSession;
    const messages = this.sessionStore.loadMessages(sourceDate, sourceSession);
    if (messages.length === 0) {
      throw configError('无法分叉会话', '当前会话无消息', ['先进行一些对话后再尝试分叉']);
    }
    let newSession: string;
    if (targetSession) {
      // 检查目标会话当天是否已存在
      const targetFullName = `${todayDate()}-${targetSession}`;
      const existingSessions = this.sessionStore.listSessions();
      if (existingSessions.includes(targetFullName)) {
        throw configError('无法分叉会话', `当天会话 "${targetSession}" 已存在`, ['使用不同的名称，或不传参数自动生成']);
      }
      newSession = targetSession;
    } else {
      newSession = this.autoBranchName(sourceSession);
    }
    const targetDate = todayDate();
    this.sessionStore.copySession(sourceDate, sourceSession, targetDate, newSession);
    this.switchSession(newSession);
    logger.info({ from: sourceSession, to: newSession, messageCount: messages.length }, '会话分叉完成');
    return { newSession, date: targetDate, messages };
  }

  /**
   * 追加 user 消息到当前会话（持久化失败不抛出，不阻塞对话）。
   * 日期用 todayDate() 动态获取，确保跨日后写入当天目录；roundId 用于 sessionStore 溯源。
   * 同步 currentDate：实际写入的日期即会话当下归属（SSOT），跨日后 currentDateValue/currentSessionName
   * 与持久化一致——摘要/标题/互斥排除的日期锚点不错位。
   *
   * Round-based 模式：当 roundStore 注入且 roundId 存在时，额外创建 pending Round 并保存到 RoundStore，
   * 同时将 roundId 追加到会话的 roundIds 列表。
   */
  async appendUser(content: string, roundId?: string): Promise<void> {
    const message: SessionMessage = {
      role: 'user',
      content,
      timestamp: nowIso(),
      ...(roundId ? { roundId } : {}),
    };
    if (this.sessionStore) {
      try {
        // 动态获取当天日期，避免跨日后写入旧目录
        const writeDate = todayDate();
        // 同步当前会话日期为实际写入日期（跨日首轮后读侧锚点与写入一致）
        this.currentDate = writeDate;
        this.sessionStore.appendMessage(writeDate, this.currentSession, message);
      } catch (err) {
        logger.warn({ err, session: this.currentSessionName }, 'appendUser: 会话持久化失败');
      }
    }

    // Round-based 模式：创建 pending Round 并关联到会话
    if (this.isRoundBasedEnabled && roundId) {
      try {
        const sessionId = this.currentSessionName;
        // 创建 pending Round
        const pendingRound: Round = {
          id: roundId,
          userMessage: {
            id: `msg-${roundId}-user`,
            role: 'user',
            content,
            timestamp: message.timestamp,
          } as RoundMessage,
          status: 'pending',
          createdAt: message.timestamp,
          refCount: 1,
        };
        // 保存到 RoundStore
        this.roundStore!.save(pendingRound);
        // 缓存 pending Round 供 appendAssistant 使用
        this.pendingRounds.set(roundId, pendingRound);
        // 将 roundId 追加到会话的 roundIds 列表
        this.sessionStore!.appendRoundId!(sessionId, roundId);
        logger.debug({ roundId, sessionId }, 'appendUser: Round-based pending Round created');
      } catch (err) {
        logger.warn({ err, roundId }, 'appendUser: Round-based 写入失败，降级为 legacy 模式');
      }
    }

    logger.debug({ role: message.role, session: this.currentSessionName }, 'appendUser');
  }

  /**
   * 追加 assistant 消息到当前会话（持久化失败不抛出）。日期动态获取保跨日；roundId 溯源。
   *
   * Round-based 模式：当 roundStore 注入且 roundId 存在时，查找 pending Round 并完成它（设置 AI 消息和状态）。
   */
  async appendAssistant(content: string, roundId?: string): Promise<void> {
    if (!content.trim()) return;
    const message: SessionMessage = {
      role: 'assistant',
      content,
      timestamp: nowIso(),
      ...(roundId ? { roundId } : {}),
    };
    if (this.sessionStore) {
      try {
        // 动态获取当天日期，避免跨日后写入旧目录
        const writeDate = todayDate();
        // 同步当前会话日期为实际写入日期（跨日首轮后读侧锚点与写入一致）
        this.currentDate = writeDate;
        this.sessionStore.appendMessage(writeDate, this.currentSession, message);
      } catch (err) {
        logger.warn({ err, session: this.currentSessionName }, 'appendAssistant: 会话持久化失败');
      }
    }

    // Round-based 模式：完成 pending Round
    if (this.isRoundBasedEnabled && roundId) {
      try {
        const pendingRound = this.pendingRounds.get(roundId);
        if (pendingRound) {
          // 完成 Round：设置 AI 消息和状态
          const completedRound: Round = {
            ...pendingRound,
            assistantMessage: {
              id: `msg-${roundId}-assistant`,
              role: 'assistant',
              content,
              timestamp: message.timestamp,
            } as RoundMessage,
            status: 'complete',
            completedAt: message.timestamp,
          };
          // 保存完成的 Round
          this.roundStore!.save(completedRound);
          // 清除缓存
          this.pendingRounds.delete(roundId);
          logger.debug({ roundId }, 'appendAssistant: Round-based Round completed');
        } else {
          // pending Round 不存在（可能是跨会话或异常），创建一个新的 complete Round
          const round = this.roundStore!.getById(roundId);
          if (round) {
            round.assistantMessage = {
              id: `msg-${roundId}-assistant`,
              role: 'assistant',
              content,
              timestamp: message.timestamp,
            } as RoundMessage;
            round.status = 'complete';
            round.completedAt = message.timestamp;
            this.roundStore!.save(round);
          } else {
            logger.warn({ roundId }, 'appendAssistant: Round not found in RoundStore, skipping round-based write');
          }
        }
      } catch (err) {
        logger.warn({ err, roundId }, 'appendAssistant: Round-based 写入失败');
      }
    }

    logger.debug({ role: message.role, session: this.currentSessionName }, 'appendAssistant');
  }

  /** 列出所有会话标识（YYYY-MM-DD-session）；未注入 ISessionStore 返回空 */
  async listAllSessions(): Promise<string[]> {
    if (!this.sessionStore) {
      logger.debug({ hasSessionStore: false }, 'listAllSessions: ISessionStore 未注入，返回空数组');
      return [];
    }
    return this.sessionStore.listSessions();
  }

  /** 恢复会话历史并同步当前会话到指定 date/session（保持状态一致）；未注入 ISessionStore 返回空 */
  async loadSessionMessages(date: string, session: string): Promise<SessionMessage[]> {
    this.currentDate = date;
    this.currentSession = session;
    if (!this.sessionStore) {
      logger.debug({ date, session }, 'loadSessionMessages: ISessionStore 未注入，返回空数组');
      return [];
    }
    const messages = this.sessionStore.loadMessages(date, session);
    logger.info({ date, session, count: messages.length }, 'loadSessionMessages');
    return messages;
  }

  /** 注册外部 fire-and-forget 归档到 pendingArchives，供 Agent.chat() 触发 signal 归档时使用 */
  registerPendingArchive(p: Promise<unknown>): void {
    this.pendingArchives.add(p);
    p.finally(() => {
      this.pendingArchives.delete(p);
    });
  }

  /**
   * 等待所有挂起归档完成（Agent.close() 时调用），防止归档写 SQLite 时 db 已被关闭。
   * 会捕获等待期间新加入的归档（解决 init() → archiveMissingSessions() 的 race）；
   * 50ms 轮询直到全部完成或超时。
   * @returns 是否全部完成（false = 超时）
   */
  async awaitPendingArchives(timeoutMs = 5000): Promise<boolean> {
    // 无挂起任务立即返回，避免空轮询耗时
    if (this.pendingArchives.size === 0) return true;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const current = Array.from(this.pendingArchives);
      if (current.length === 0) return true; // 所有归档已完成
      // 有挂起任务 → 等所有 settle 或到超时
      const timeout = new Promise<void>((resolve) =>
        safeSetTimeout(resolve, Math.max(50, deadline - Date.now())),
      );
      await Promise.race([Promise.allSettled(current), timeout]);
      // 等待期间可能新加入归档，未清空则下一轮继续等
      if (this.pendingArchives.size === 0) return true;
    }
    return this.pendingArchives.size === 0;
  }
}