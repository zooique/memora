/**
 * 消息历史：封装用户输入/Agent 回复的会话持久化，维护当前会话（date+session），经 ISessionStore 落库。
 *
 * 存储模型（round-based 单一模式，SSOT）：
 * 所有消息经 appendUser/appendAssistant 写入 RoundStore（物理真相源），并登记 roundId 到会话的 roundIds 列表；
 * 会话仅持有 roundIds，不再另存扁平消息列表。
 */
import type { ISessionStore, SessionMessage, SessionMeta } from '@/memory/sessionStore.js';
import { isRoundSettled } from '@/memory/roundStore.js';
import type {
  InteractiveInputKind,
  IRoundStore,
  Round,
  RoundInteractiveInput,
  RoundMessage,
} from '@/memory/roundStore.js';
import { LOOP_CONSTANTS } from '@/agent/constants.js';
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
   * 当前会话第一条轮次的 roundId（会话起点背景，互斥排除用）。
   * 装配时若第一条不在最近轮内（长会话），完整对话层显式补入第一条，其 roundId 须计入 exclude
   * 避免其摘要被二次召回。
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
   *
   * 交互输入：opts.interactive 为真且 roundId 对应轮已存在（prepare 建 pending 或
   * 暂停已完成轮）时，不再创建/覆盖新轮——按序追加到该轮 interactiveInputs，保问答闭环不分裂。
   *
   * @param content 用户输入内容
   * @param roundId 闭环节点轮次 ID（可选，交互输入必须携带 = appendUser 的 head roundId）
   * @param opts 交互输入选项（interactive=是否交互归属；kind=折叠块类型文案；
   *        question/options=该回答所对的 ask_user 提问原文与候选选项，随回答一并持久化）
   */
  async appendUser(
    content: string,
    roundId?: string,
    opts?: {
      interactive?: boolean;
      kind?: InteractiveInputKind;
      question?: string;
      options?: string[];
    },
  ): Promise<void> {
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
        // 交互输入：同一问答闭环内续写（不新建/不覆盖轮），防闭环节点被交互输入分裂
        if (opts?.interactive) {
          const existing = this.roundStore.getById(roundId) ?? this.pendingRounds.get(roundId);
          if (existing) {
            const input: RoundInteractiveInput = {
              id: `msg-${roundId}-input-${(existing.interactiveInputs?.length ?? 0) + 1}`,
              role: 'user',
              content,
              timestamp: message.timestamp,
              kind: opts.kind ?? 'supplement',
              // 提问原文/选项随回答落盘（question-answer 携带；supplement/缺省不落，旧数据向后兼容）
              ...(opts.question ? { question: opts.question } : {}),
              ...(opts.options && opts.options.length > 0 ? { options: opts.options } : {}),
            };
            const updated: Round = {
              ...existing,
              interactiveInputs: [...(existing.interactiveInputs ?? []), input],
            };
            this.roundStore.save(updated);
            this.pendingRounds.set(roundId, updated);
            logger.debug({ roundId, kind: input.kind }, 'appendUser: 交互输入归属问答闭环');
            return;
          }
          // 轮不存在（异常兜底）：降级为普通 pending Round（内容不丢失，GC 兜底）
          logger.warn({ roundId }, 'appendUser: 交互输入对应轮缺失，降级为新建 pending Round');
        }
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
   *
   * 闭环节点续写：同一 roundId 已存在 assistantMessage（跨暂停-续跑：
   * 暂停轮已把 ask_user 提问/中断半截落为 assistantMessage）时，旧段入 assistantLog，
   * assistantMessage 恒为末段（最终回答）——问答闭环不因续跑分裂新轮，且前序 LLM
   * 文本（如主动提问）不丢失。
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
      // 统一取现有轮：优先 pending 缓存（prepare 新建后未完成），否则 RoundStore（跨重启 / 暂停已完成轮）
      const existing =
        this.pendingRounds.get(roundId) ?? this.roundStore.getById(roundId) ?? null;
      if (existing) {
        // 旧 assistant 段入 assistantLog（仅当已存在 assistantMessage 时产生，普通单段轮零冗余）
        const assistantLog = existing.assistantLog
          ? [...existing.assistantLog]
          : existing.assistantMessage
            ? []
            : undefined;
        if (existing.assistantMessage) assistantLog!.push(existing.assistantMessage);
        completed = {
          ...existing,
          assistantMessage: {
            id: `msg-${roundId}-assistant`,
            role: 'assistant',
            content,
            timestamp: message.timestamp,
          } as RoundMessage,
          assistantLog: assistantLog && assistantLog.length > 0 ? assistantLog : undefined,
          status: 'complete',
          completedAt: message.timestamp,
        };
        this.pendingRounds.delete(roundId);
      } else {
        logger.warn({ roundId }, 'appendAssistant: Round not found in RoundStore');
      }

      if (completed) {
        this.roundStore.save(completed);
        // 首次收场才登记会话引用（refCount 0→1 + 列表登记），崩溃残留 pending 保持孤儿可由 GC 清理。
        // 续写同一闭环节点（assistantLog：跨暂停-续跑多次 appendAssistant 到同一 roundId）不重复登记——
        // 否则 roundIds 同 id 重复堆叠、refCount 虚增，会话视图出现「一个问答闭环多次登记」
        // 判据 = isRoundSettled（非自写 'complete'）：已是终态（含 interrupted）就不得再登记一次
        const isReappend = existing !== null && existing !== undefined && isRoundSettled(existing.status);
        if (!isReappend) {
          this.roundStore.incrementRef(roundId);
          const sessionId = this.currentSessionName;
          try {
            this.sessionStore?.appendRoundId(sessionId, roundId);
          } catch (err) {
            logger.warn({ err, sessionId, roundId }, 'appendAssistant: appendRoundId 失败');
          }
        } else {
          logger.debug(
            { roundId, status: existing?.status },
            'appendAssistant: 闭环节点续写段但不重复登记会话引用',
          );
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

  /**
   * 中断轮收场：把「未正常完成」的轮升级为正常 stop turn 并入会话。
   *
   * 语义定案（step-atomic-persistence.md §一·五）：崩溃残留轮（pending/error + refCount=0 + 有已
   * 落盘 processEvents）= 等同于用户点「停止」的正常 turn——可删、入会话 roundIds、作后续上下文，
   * **不是**半成品草稿/孤儿。宿主经 `IRoundStore.listInterruptedRecent` 打捞后再调本方法完成
   * 「升级登记」，恢复为普通 turn 渲染无需特殊草稿卡。
   *
   * **两个调用时机**：
   * 1. 崩溃/断电后重启——宿主 `chatPanel.upgradeInterruptedRounds` 打捞后调用；
   * 2. **运行期非正常收场**——`seed/orchestrator.act()` 在中断（用户取消/超时）与失败
   *    （LLM/网络错误）两条路径上就地调用（SSOT 收口，见该处注释）。运行期即收尾可避免
   *    留下 pending 孤儿轮、须等下次重启才打捞（LLM 4xx 中断的长任务轮即此类）。
   *    依据 = `memory/roundStore.ts` RoundStatus 文档「运行时失败不翻状态机，一律按中断处理」。
   *
   * 收场约定与 appendAssistant 同一真理源（refCount 0→1 + appendRoundId + status interrupted +
   * completedAt + isReappend 防重复登记，两处终态判据同为 `isRoundSettled`），Round schema /
   * 存储格式不变；
   * **有意不直接复用 appendAssistant**，两处差异：
   * - appendAssistant 顶层跳过空内容 → 无文本中断轮无法收场；本方法允许多段「即使无
   *   assistantMessage 总结也按 stop 语义收场」（§一·五验收口径）。
   * - 中断标记统一追加默认文案（LOOP_CONSTANTS.DEFAULT_INTERRUPTED_MARK），与运行期两条
   *   中断收场路径（loop 流式中断 / orchestrator 历史写入）的默认降级同源（SSOT）。
   *
   * 幂等：已收场（complete / interrupted 终态）的轮再调直接返回（宿主打捞与运行期收尾可能对同一轮各触发一次）。
   *
   * @param roundId 待收场轮 ID（须已存在于 RoundStore 或本实例 pendingRounds；缺失仅记日志不抛错，防御性降级）
   * @param opts.content 已产出的助手文本（运行期由 consumeExecutionStream 累积；宿主打捞时
   *        从 processEvents 的 narrate 内容拼接派生）。缺省/空则**不写** assistantMessage，
   *        仍按 stop 语义收场
   * @param opts.interruptedMark 中断标记（缺省用 LOOP_CONSTANTS.DEFAULT_INTERRUPTED_MARK）
   */
  async appendInterrupted(
    roundId: string,
    opts?: { content?: string; interruptedMark?: string },
  ): Promise<void> {
    if (!roundId || !this.roundStore) return;
    try {
      // 统一取现有轮：优先 pending 缓存（同实例未重启），否则 RoundStore（崩溃重启后的常态）
      const existing = this.pendingRounds.get(roundId) ?? this.roundStore.getById(roundId) ?? null;
      if (!existing) {
        logger.warn({ roundId }, 'appendInterrupted: Round 未找到，跳过升级');
        return;
      }
      // 已收场（幂等重跑 / 防御）：complete / interrupted 均为终态（正常完成 或 中断收场），
      // 不再二次登记会话引用，防止 roundIds 重复堆叠、refCount 虚增（判据 SSOT = isRoundSettled）
      if (isRoundSettled(existing.status)) {
        logger.debug({ roundId, status: existing.status }, 'appendInterrupted: 轮已收场，跳过重复升级');
        return;
      }
      // 有恢复文本才写 assistantMessage（§一·五：无 assistantMessage 总结也按 stop 语义收场）
      const content = opts?.content?.trim() ?? '';
      const completed: Round = {
        // 展开保留 userMessage / interactiveInputs / processEvents（宿主 step 检查点已落盘）等原字段
        ...existing,
        ...(content
          ? {
              assistantMessage: {
                id: `msg-${roundId}-assistant`,
                role: 'assistant',
                content:
                  content + (opts?.interruptedMark ?? LOOP_CONSTANTS.DEFAULT_INTERRUPTED_MARK),
                timestamp: nowIso(),
              } as RoundMessage,
            }
          : {}),
        status: 'interrupted',
        completedAt: nowIso(),
      };
      this.pendingRounds.delete(roundId);
      this.roundStore.save(completed);
      // 收场登记：与 appendAssistant 同一约定——refCount 0→1 + 会话 roundIds 追加
      this.roundStore.incrementRef(roundId);
      const sessionId = this.currentSessionName;
      try {
        this.sessionStore?.appendRoundId(sessionId, roundId);
      } catch (err) {
        logger.warn({ err, sessionId, roundId }, 'appendInterrupted: appendRoundId 失败');
      }
      logger.info(
        { roundId, sessionId, hasAssistant: content.length > 0 },
        'appendInterrupted: 崩溃残留轮升级为正常 stop turn',
      );
    } catch (err) {
      logger.warn({ err, roundId }, 'appendInterrupted: 中断轮升级失败');
    }
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
   * 等待所有挂起归档完成（Agent.close() 时调用），防止归档写入时存储已被关闭。
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