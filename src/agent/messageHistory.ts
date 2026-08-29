/**
 * 消息历史：封装用户输入/Agent 回复的会话持久化，维护当前会话（date+session），经 ISessionStore 落库。
 *
 * 存储模型（round-based 单一模式，SSOT）：
 * 所有消息经 appendUser/appendAssistant 写入 RoundStore（物理真相源），并登记 roundId 到会话的 roundIds 列表；
 * 会话仅持有 roundIds，不再另存扁平消息列表。
 */
import type { ISessionStore, SessionMessage, SessionMeta } from '@/memory/sessionStore.js';
import type {
  IRoundStore,
  Round,
  RoundMessage,
} from '@/memory/roundStore.js';
import { logger } from '@/logging/logger.js';
import { configError } from '@/utils/errors.js';
import { safeSetTimeout } from '@/utils/safeTimer.js';
import { nowIso, todayDate } from '@/utils/time.js';

/** 分叉结果（round-based 模式） */
export interface ForkResult {
  /** 新会话标识（不含日期前缀，平等普通会话） */
  newSession: string;
  /** 会话日期 */
  date: string;
  /** 新会话的 Round ID 列表（已复制的指针） */
  roundIds: string[];
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
  /** 问答闭环存储（可选）；注入则启用 round-based 模式（消息内容唯一真相源） */
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

  /**
   * 自动生成会话名（平等普通会话命名，无分叉标记）。
   * 使用时间戳生成唯一名称，实际应委托给 SessionNamer 生成有意义的标题。
   */
  private generateSessionName(): string {
    return `session-${Date.now().toString(36)}`;
  }

  /**
   * 获取当前会话的 Round ID 列表（单一 round-based 路径）
   */
  private getCurrentRoundIds(): string[] {
    if (!this.sessionStore) return [];
    const sessionId = this.currentSessionName;
    return this.sessionStore.getRoundIds(sessionId);
  }

  /**
   * 获取当前会话的元数据
   */
  private getCurrentSessionMeta(): SessionMeta | undefined {
    if (!this.sessionStore) return undefined;
    const getMetaFn = this.sessionStore.getSessionMeta;
    if (!getMetaFn) return undefined;
    return getMetaFn.call(this.sessionStore, this.currentSessionName);
  }

  /**
   * 从指定 Round 位置分叉会话（唯一分叉方式，round-based）
   *
   * 核心操作：复制 Round ID 列表（指针复制，不复制数据）
   * 新会话是完全平等的普通会话，无特殊标记。
   *
   * @param roundId - 分叉点的 Round ID（必须存在于当前会话）
   * @param targetSession - 可选，自定义新会话名；不传则自动生成
   * @returns 分叉结果（含新会话 ID 和 roundIds）
   * @throws 会话不存在 / Round 不存在 / 对话繁忙时抛错
   */
  forkSession(roundId?: string, targetSession?: string): ForkResult {
    if (!this.sessionStore) {
      throw configError('无法分叉会话', 'ISessionStore 未注入', ['在创建 Agent 时注入 sessionStore 参数']);
    }
    const store = this.sessionStore;

    // 1. 获取当前会话元数据
    const currentSession = this.getCurrentSessionMeta();
    if (!currentSession) {
      throw configError('无法分叉会话', '当前会话不存在', ['确认当前会话是否已正确创建']);
    }

    // 2. 获取 Round ID 列表
    const currentRoundIds = this.getCurrentRoundIds();
    if (!currentRoundIds.length) {
      throw configError('无法分叉会话', '当前会话无问答闭环', ['先进行一些对话后再尝试分叉']);
    }

    // 3. 定位分叉点（不传 roundId 则默认使用最后一个）
    const effectiveRoundId = roundId ?? currentRoundIds[currentRoundIds.length - 1]!;
    const forkIdx = currentRoundIds.indexOf(effectiveRoundId);
    if (forkIdx === -1) {
      throw configError('无法分叉会话', `Round 不存在于当前会话: ${effectiveRoundId}`, ['确认分叉点是当前会话中的问答闭环']);
    }

    // 4. 截取到分叉点的 ID 列表（包含分叉点）
    const newRoundIds = currentRoundIds.slice(0, forkIdx + 1);

    // 5. 生成新会话名（平等普通会话，无分叉标记）
    let newSession: string;
    if (targetSession) {
      // 检查目标会话当天是否已存在
      const targetFullName = `${todayDate()}-${targetSession}`;
      const existingSessions = store.listSessions();
      if (existingSessions.includes(targetFullName)) {
        throw configError('无法分叉会话', `当天会话 "${targetSession}" 已存在`, ['使用不同的名称，或不传参数自动生成']);
      }
      newSession = targetSession;
    } else {
      newSession = this.generateSessionName();
    }

    // 6. 创建新会话（Round ID 列表 + 引用计数增加）
    const newSessionId = `${todayDate()}-${newSession}`;

    // 设置 Round ID 列表（唯一 round-based 路径）
    store.setRoundIds(newSessionId, newRoundIds);

    // 保存会话元数据
    store.updateSessionMeta(newSessionId, {
      createdAt: new Date().toISOString(),
    });

    // 7. 增加引用计数（新会话引用这些 Round）
    for (const id of newRoundIds) {
      this.roundStore?.incrementRef(id);
    }

    // 8. 切换到新会话（同步日期锚点为今天：分叉键 = todayDate()-newSession，
    //    切换身份必须与建键一致，防跨天后 currentDate 停在源会话旧日期导致写入错位）
    this.currentDate = todayDate();
    this.switchSession(newSession);

    logger.info({ from: currentSession.sessionId, to: newSession, roundCount: newRoundIds.length }, '会话分叉完成');

    return { newSession, date: todayDate(), roundIds: newRoundIds };
  }

  /**
   * 追加 user 消息到当前会话（持久化失败不抛出，不阻塞对话）。
   *
   * Round-based 路径：roundStore 注入且 roundId 存在时，创建 pending Round
   * 写入 RoundStore（refCount=0，未完成不登记会话）。**仅 complete 才 appendRoundId**——
   * 崩溃残留的 pending 轮是孤儿（refCount=0），可由 GC 清理，不污染会话视图。
   */
  async appendUser(content: string, roundId?: string): Promise<void> {
    const message: SessionMessage = {
      role: 'user',
      content,
      timestamp: nowIso(),
      ...(roundId ? { roundId } : {}),
    };
    // 会话日期锚点不随输入漂移：currentDate 由显式加载/新建决定，跨天续聊沿用原会话日期
    // Round-based 路径：roundStore 注入且有 roundId 时写入
    if (roundId && this.roundStore) {
      try {
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
          // 未完成轮不被任何会话引用（complete 时 incrementRef + appendRoundId）
          refCount: 0,
        };
        this.roundStore.save(pendingRound);
        this.pendingRounds.set(roundId, pendingRound);
        logger.debug({ roundId }, 'appendUser: Round-based pending Round created');
      } catch (err) {
        logger.warn({ err, roundId }, 'appendUser: Round-based 写入失败');
      }
    }

    logger.debug({ role: message.role, session: this.currentSessionName }, 'appendUser');
  }

  /**
   * 追加 assistant 消息到当前会话（持久化失败不抛出）。
   *
   * Round-based 路径：完成 pending Round 时**才登记会话引用**——
   * incrementRef（refCount 0→1）+ appendRoundId。pending 缓存丢失（跨重启）时从
   * RoundStore 取回补全；Round 不存在（异常兜底）时创建独立 complete Round 并登记，
   * 保证用户消息不丢失。
   */
  async appendAssistant(content: string, roundId?: string): Promise<void> {
    if (!content.trim()) return;
    const message: SessionMessage = {
      role: 'assistant',
      content,
      timestamp: nowIso(),
      ...(roundId ? { roundId } : {}),
    };
    // 会话日期锚点不随输入漂移（同 appendUser 上方注释）

    // Round-based 路径：roundStore 注入且有 roundId 时完成 pending Round
    if (roundId && this.roundStore) {
      let completed: Round | null = null;
      const pendingRound = this.pendingRounds.get(roundId);
      if (pendingRound) {
        completed = {
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
        this.pendingRounds.delete(roundId);
      } else {
        // pending 缓存丢失（跨重启等）：从 RoundStore 取回补全
        const round = this.roundStore.getById(roundId);
        if (round) {
          completed = {
            ...round,
            assistantMessage: {
              id: `msg-${roundId}-assistant`,
              role: 'assistant',
              content,
              timestamp: message.timestamp,
            } as RoundMessage,
            status: 'complete',
            completedAt: message.timestamp,
          };
        } else {
          logger.warn({ roundId }, 'appendAssistant: Round not found in RoundStore');
        }
      }

      if (completed) {
        this.roundStore.save(completed);
        // complete 才登记会话引用（refCount 0→1 + 列表登记），崩溃残留 pending 保持孤儿可由 GC 清理
        this.roundStore.incrementRef(roundId);
        const sessionId = this.currentSessionName;
        try {
          this.sessionStore?.appendRoundId(sessionId, roundId);
        } catch (err) {
          logger.warn({ err, sessionId, roundId }, 'appendAssistant: appendRoundId 失败');
        }
        logger.debug({ roundId }, 'appendAssistant: Round-based Round completed');
      } else {
        // Round 不存在（异常兜底）：独立 complete Round，不让用户消息丢失
        const fallback: Round = {
          id: roundId,
          userMessage: {
            id: `msg-${roundId}-user`,
            role: 'user',
            content: '<历史消息>',
            timestamp: message.timestamp,
          } as RoundMessage,
          assistantMessage: {
            id: `msg-${roundId}-assistant`,
            role: 'assistant',
            content,
            timestamp: message.timestamp,
          } as RoundMessage,
          status: 'complete',
          createdAt: message.timestamp,
          completedAt: message.timestamp,
          refCount: 1,
        };
        this.roundStore.save(fallback);
        try {
          this.sessionStore!.appendRoundId(this.currentSessionName, roundId);
        } catch (err) {
          logger.warn({ err, roundId }, 'appendAssistant: 兜底 appendRoundId 失败');
        }
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

  /**
   * 从 Round ID 列表加载会话消息（round-based 模式）
   *
   * 将 Round ID 列表展开为扁平的 SessionMessage[]，
   * 供 AgentLoop 加载上下文使用。
   *
   * @param roundIds - Round ID 列表
   * @returns 展开后的消息列表（user + assistant 成对）
   */
  loadRoundBasedMessages(roundIds: string[]): SessionMessage[] {
    if (!this.roundStore || !roundIds.length) return [];

    const messages: SessionMessage[] = [];
    for (const roundId of roundIds) {
      const round = this.roundStore.getById(roundId);
      if (!round) {
        logger.warn({ roundId }, 'loadRoundBasedMessages: Round 不存在，跳过');
        continue;
      }
      // User message
      messages.push({
        role: round.userMessage.role,
        content: round.userMessage.content,
        roundId: round.id,
        timestamp: round.userMessage.timestamp,
      });
      // Assistant message（如果存在）
      if (round.assistantMessage) {
        messages.push({
          role: round.assistantMessage.role,
          content: round.assistantMessage.content,
          roundId: round.id,
          timestamp: round.assistantMessage.timestamp,
        });
      }
    }
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