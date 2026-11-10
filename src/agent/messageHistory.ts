/**
 * 消息历史：封装用户输入/Agent 回复的会话持久化，维护当前会话（date+session），经 ISessionStore 落库。
 *
 * 存储模型（round-based 单一模式，SSOT）：
 * 所有消息经 appendUser/appendAssistant 写入 RoundStore（物理真相源），并登记 roundId 到会话的 roundIds 列表；
 * 会话仅持有 roundIds，不再另存扁平消息列表。
 */
import type { ISessionStore, SessionMessage, SessionMeta } from '@/memory/sessionStore.js';
import type { ImageRef } from '@/llm/provider.js';
import { isRoundSettled } from '@/memory/roundStore.js';
import type {
  InteractiveInputKind,
  IRoundStore,
  Round,
  RoundEvidenceEvent,
  RoundInteractiveInput,
  RoundMessage,
  RoundPendingAsk,
} from '@/memory/roundStore.js';
import { LOOP_CONSTANTS } from '@/agent/constants.js';
import { logger } from '@/logging/logger.js';
import { configError, sessionDriftError } from '@/utils/errors.js';
import { safeSetTimeout } from '@/utils/safeTimer.js';
import { nowIso, todayDate } from '@/utils/time.js';

/**
 * `appendUser` 的结果：
 * - `'ok'`：未触发 fail-closed 拒绝（含既有降级路径：无 roundStore、同 ID 轮已存在、存储写入失败仅记日志）。
 * - `'round-missing'`：**交互归属被拒绝**——目标轮在 RoundStore / pendingRounds 均不存在，
 *   未建轮、未落盘任何内容（含 `ASK_TIMEOUT_NOTICE` 等系统文案）。
 *   调用方须据此给出用户可见后果（当前唯一消费面 = `SeedOrchestrator.runResume` 的 error chunk）。
 */
export type AppendUserOutcome = 'ok' | 'round-missing';

/** 分叉结果（round-based 模式） */
export interface ForkResult {
  /** 新会话标识（不含日期前缀，平等普通会话） */
  newSession: string;
  /** 会话日期 */
  date: string;
  /** 新会话的 Round ID 列表（已复制的指针） */
  roundIds: string[];
}

/** 交互输入落档草稿（appendUser opts.group 元素）：逐题展开的最小描述，id/timestamp/role 由 buildInteractiveInputs 统一装配 */
interface InteractiveInputDraft {
  content: string;
  kind: InteractiveInputKind;
  /**
   * 题身份（ADR-043 单源）：来自内核 `AskQuestion.askCallId`（发起提问的工具调用 id）。
   * 有则**直接作为落盘 id**（运行时行与盘面行同一身份，去重可靠配对）；
   * 无（supplement / 历史数据 / 未带身份的收场转化）则回退轮内序号公式。
   */
  id?: string;
  question?: string;
  options?: string[];
}

/**
 * 整组交互输入 → 逐题 RoundInteractiveInput（ASK-MULTI-Q-1 单点装配）：
 * id 公式 / role / timestamp / question-options 摊开条件**只在此一处**。
 * appendUser 交互分支（作答/超时整组）与 appendInterrupted 收场转化（unanswered 整组）
 * 共用同一装配，两条消费路径从源头同宽。
 */
function buildInteractiveInputs(
  roundId: string,
  existingCount: number,
  drafts: ReadonlyArray<InteractiveInputDraft>,
  timestamp: string,
): RoundInteractiveInput[] {
  return drafts.map((d, i) => ({
    // ADR-043：题身份优先（内核 toolCallId，跨重启恒定 ⇒ 运行时与重放可配对）；
    // 缺省回退轮内序号（supplement 等无题身份来源的路径，行为与历史一致）。
    id: d.id ?? `msg-${roundId}-input-${existingCount + i + 1}`,
    role: 'user',
    content: d.content,
    timestamp,
    kind: d.kind,
    ...(d.question ? { question: d.question } : {}),
    ...(d.options && d.options.length > 0 ? { options: d.options } : {}),
  }));
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
  /**
   * 当前 turn 的会话快照（null = 无活动 turn）。
   *
   * E2 漂移判据：唯一写入口 = `beginTurnSessionSnapshot()`（调用方 `Agent.chat()` 持锁后），
   * 唯一清空点 = `endTurnSessionSnapshot()`（chat 的 finally）。turn 内任何身份写入点先经
   * `assertTurnSessionStable()` 比对；漂移即抛 `sessionDriftError`。
   */
  private turnSessionSnapshot: string | null = null;

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

  /**
   * 开启 turn 会话快照（E2）——唯一写入口，由 `Agent.chat()` 在持锁后调用。
   *
   * 背景：`switchSession` / `forkSession` 是**公开可调**且自身不判忙（判忙闸在 `SessionManager`），
   * 而 `Agent.agentHistory` 是公开 getter ⇒ 存在绕过闸直接改会话的路径（E2 勘察结论）。
   * 本快照把「turn 内会话身份不变」从隐含前提变成机判；当前无已知生产触发路径（宿主走闸）。
   */
  beginTurnSessionSnapshot(): void {
    this.turnSessionSnapshot = this.currentSessionName;
  }

  /** 结束 turn 会话快照（chat 的 finally 无条件调用，含异常/暂停边界） */
  endTurnSessionSnapshot(): void {
    this.turnSessionSnapshot = null;
  }

  /**
   * 会话漂移判据（E2）：turn 内有快照且当前会话名 ≠ 快照 ⇒ 抛 `sessionDriftError`。
   *
   * 仅防御性判据（非已知 bug 的修复）：无活动 turn（快照为 null）时零副作用，
   * 故注入 prepare / act / reflect 各写点的调用不会影响正常流程。
   *
   * @param writePoint 写入点中文名（错误文案定位用）
   */
  assertTurnSessionStable(writePoint: string): void {
    if (this.turnSessionSnapshot === null) return;
    const current = this.currentSessionName;
    if (current !== this.turnSessionSnapshot) {
      throw sessionDriftError(writePoint, this.turnSessionSnapshot, current);
    }
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
      throw configError('无法分叉会话', 'ISessionStore 未注入', [
        '在创建 Agent 时注入 sessionStore 参数',
      ]);
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
      throw configError('无法分叉会话', `Round 不存在于当前会话: ${effectiveRoundId}`, [
        '确认分叉点是当前会话中的问答闭环',
      ]);
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
        throw configError('无法分叉会话', `当天会话 "${targetSession}" 已存在`, [
          '使用不同的名称，或不传参数自动生成',
        ]);
      }
      newSession = targetSession;
    } else {
      newSession = this.generateSessionName();
    }

    // 6. 创建新会话（只复制 Round ID 指针，不触碰任何轮次文件）
    const newSessionId = `${todayDate()}-${newSession}`;

    // 设置 Round ID 列表（唯一 round-based 路径；新会话的 roundIds 即引用真源）
    store.setRoundIds(newSessionId, newRoundIds);

    // 保存会话元数据
    store.updateSessionMeta(newSessionId, {
      createdAt: new Date().toISOString(),
      // 分叉继承父会话的角色包名（「从这一支长出来」⇒ 能力不应突然变回默认）；
      // undefined 不写，避免给「从未选过角色」的会话造出假选择记录
      ...(currentSession.activeRolePackName
        ? { activeRolePackName: currentSession.activeRolePackName }
        : {}),
    });

    // 7. 切换到新会话（同步日期锚点为今天：分叉键 = todayDate()-newSession，
    //    切换身份必须与建键一致，防跨天后 currentDate 停在源会话旧日期导致写入错位）
    this.currentDate = todayDate();
    this.switchSession(newSession);

    logger.info(
      { from: currentSession.sessionId, to: newSession, roundCount: newRoundIds.length },
      '会话分叉完成',
    );

    return { newSession, date: todayDate(), roundIds: newRoundIds };
  }

  /**
   * 追加 user 消息到当前会话（持久化失败不抛出，不阻塞对话）。
   *
   * Round-based 路径：roundStore 注入且 roundId 存在时，创建 pending Round 并**立即**归属当前会话
   * （appendRoundId，ADR-044「建轮即入会话」）。存在性由**创建**决定、不由**收场**决定——
   * 未收场的轮同样可见、可删、可续跑。引用真源 = 会话 `roundIds`。
   *
   * 交互输入：opts.interactive 为真且 roundId 对应轮已存在（prepare 建 pending 或
   * 暂停已完成轮）时，不再创建/覆盖新轮——按序追加到该轮 interactiveInputs，保问答闭环不分裂。
   *
   * 🔴 交互归属 fail-closed（与 `appendAssistant` 同一口径）：交互输入**必须**挂到已存在的轮，
   * 轮缺失即拒绝（`'round-missing'`）——**不建轮**、不把内容（尤其 `ASK_TIMEOUT_NOTICE`
   * 这类系统文案）写进 `userMessage`。旧行为「降级新建 pending 轮」会让系统文案冒充用户输入，
   * 后续上下文与「重新生成」会把它当真实输入重放（FAKE-ROUND-TIMEOUT-1）。
   * 交互轮缺失属前置条件不满足，拒绝是唯一诚实处置；是否让用户看见由调用方决定。
   *
   * @param content 用户输入内容
   * @param roundId 闭环节点轮次 ID（可选，交互输入必须携带 = appendUser 的 head roundId）
   * @param opts 交互输入选项（interactive=是否交互归属；kind/question/options=单条形态的
   *        折叠块类型与所对 ask_user 提问原文/候选选项；group=整组形态，ASK-MULTI-Q-1：
   *        作答/超时多题批次逐题落档，与崩溃收场转化同宽——提供时按序展开为 N 条，
   *        单条形态等价于 1 元素组，同时提供以 group 为准）
   * @returns `'ok'` = 未触发 fail-closed 拒绝（含既有降级路径）；`'round-missing'` = 交互归属
   *        被拒绝（目标轮不存在，未建轮未落盘）。判据说明见 `AppendUserOutcome`。
   */
  async appendUser(
    content: string,
    roundId?: string,
    opts?: {
      interactive?: boolean;
      kind?: InteractiveInputKind;
      question?: string;
      options?: string[];
      /** 整组交互输入（多题批次逐题落档）；元素结构见 InteractiveInputDraft */
      group?: ReadonlyArray<InteractiveInputDraft>;
      /** 图片附件（可选，多模态输入）；须显式透传到 `userMessage` 白名单与 SessionMessage，否则重启 / 切会话后图静默消失（方案 §7 P0-12） */
      attachments?: readonly ImageRef[];
    },
  ): Promise<AppendUserOutcome> {
    // E2 会话漂移判据：用户消息的轮归属依赖当前会话，漂移时拒绝写入（防旧轮记入新会话）
    this.assertTurnSessionStable('持久化用户消息');
    const message: SessionMessage = {
      role: 'user',
      content,
      timestamp: nowIso(),
      ...(roundId ? { roundId } : {}),
      ...(opts?.attachments ? { attachments: opts.attachments } : {}),
    };
    // 会话日期锚点不随输入漂移：currentDate 由显式加载/新建决定，跨天续聊沿用原会话日期
    // Round-based 路径：roundStore 注入且有 roundId 时写入
    if (roundId && this.roundStore) {
      try {
        // 交互输入：同一问答闭环内续写（不新建/不覆盖轮），防闭环节点被交互输入分裂
        if (opts?.interactive) {
          const existing = this.roundStore.getById(roundId) ?? this.pendingRounds.get(roundId);
          if (existing) {
            // 单条形态 = 退化 1 元素组：一条装配路径承载两种入参（无分叉实现）
            const drafts: ReadonlyArray<InteractiveInputDraft> = opts.group ?? [
              {
                content,
                kind: opts.kind ?? 'supplement',
                ...(opts.question ? { question: opts.question } : {}),
                ...(opts.options && opts.options.length > 0 ? { options: opts.options } : {}),
              },
            ];
            const inputs = buildInteractiveInputs(
              roundId,
              existing.interactiveInputs?.length ?? 0,
              drafts,
              message.timestamp,
            );
            // 作答/超时记录落盘的**同一次 save 内**原子清 pendingAsk（生命周期不变量的清除点，
            // 见 RoundPendingAsk 注释）：提问已被消费（回答回填或超时收场），残留即脏数据——
            // 若留到收场才清，「已答 + 未答」双记录窗口会打开（appendInterrupted 会把残留
            // pendingAsk 再转化成重复的 unanswered 条目）。supplement 与提问无关，不动该字段。
            // 判据含 unanswered（ASK-MULTI-Q-1）：批次内全跳过（逐题均 unanswered）同样代表
            // 快照已被 takeAnsweredAsk 消费——不清则收场转化二次记账。
            // ⚠️ 勿在此点之前另加「提前清盘」层：答案此刻**尚未落盘**（`AgentLoop.appendToolMessage`
            // 只 push 进程内 `loop.messages`，`Round` 结构不承载 tool 消息），二者之间不存在
            // 「答案已持久而 pendingAsk 未清」的中间态 ⇒ 提前清的唯一净效应是把崩溃后一条
            // 诚实的 unanswered 记录换成「该题在盘面彻底消失」（2026-10-31 实测，据此回滚）。
            const askConsumed = drafts.some(
              (d) =>
                d.kind === 'question-answer' || d.kind === 'timeout' || d.kind === 'unanswered',
            );
            const updated: Round = {
              ...existing,
              interactiveInputs: [...(existing.interactiveInputs ?? []), ...inputs],
              ...(askConsumed ? { pendingAsk: undefined } : {}),
            };
            this.roundStore.save(updated);
            this.pendingRounds.set(roundId, updated);
            logger.debug(
              { roundId, count: inputs.length, firstKind: inputs[0]?.kind },
              'appendUser: 交互输入归属问答闭环',
            );
            return 'ok';
          }
          // 🔴 交互归属 fail-closed：轮不存在 = 前置条件不满足（该轮已被删除/清理，或身份已错位）。
          // 不建轮、不落盘——旧「降级新建 pending 轮」会把 timeout 的 ASK_TIMEOUT_NOTICE 写成
          // 用户真实输入（FAKE-ROUND-TIMEOUT-1），后续上下文与「重新生成」将重放这条假输入。
          // 拒绝的可见后果由调用方承担（runResume → error chunk，见 AppendUserOutcome）。
          logger.warn({ roundId }, 'appendUser: 交互输入对应轮缺失，拒绝建轮（fail-closed）');
          return 'round-missing';
        }
        // 重复 appendUser 到同一 roundId（异常路径）：**拒绝整体替换**。
        // 旧写法会用一个全新 pending 轮覆盖已存在的轮，正文 / 过程事件被静默抹掉
        // （已收场轮就是历史内容）。历史只读：同 ID 已存在即停手，只记日志不落盘。
        const preexisting = this.roundStore.getById(roundId) ?? this.pendingRounds.get(roundId);
        if (preexisting) {
          logger.warn({ roundId }, 'appendUser: 同 ID 轮已存在，拒绝整体替换（历史只读）');
          return 'ok';
        }
        const pendingRound: Round = {
          id: roundId,
          userMessage: {
            id: `msg-${roundId}-user`,
            role: 'user',
            content,
            timestamp: message.timestamp,
            ...(opts?.attachments ? { attachments: opts.attachments } : {}),
          } as RoundMessage,
          status: 'pending',
          createdAt: message.timestamp,
          // 🔴 ADR-044 建轮即入会话：存在性由「创建」决定，不由「收场」决定。
          // 创建它的会话立即持有引用（写入会话 roundIds ⇒ 会话视图立即可见、可删、可续跑）。
          // 引用状态只存在于会话 roundIds 上，分叉 / 删除不改写轮次文件。
        };
        this.roundStore.save(pendingRound);
        this.pendingRounds.set(roundId, pendingRound);
        this.registerRoundInSession(roundId);
        logger.debug({ roundId }, 'appendUser: pending Round created（已归属当前会话）');
      } catch (err) {
        logger.warn({ err, roundId }, 'appendUser: Round-based 写入失败');
        // 存储写入失败维持既有「不抛出、不阻塞对话」契约（与 fail-closed 拒绝不同类）：
        // 拒绝只针对「目标轮不存在」这一前置条件不满足，故此处仍报 'ok'。
        return 'ok';
      }
    }

    logger.debug({ role: message.role, session: this.currentSessionName }, 'appendUser');
    return 'ok';
  }

  /**
   * 把轮登记进当前会话的 `roundIds`（**ADR-044 归属登记单点**）。
   *
   * 语义：**建轮即登记**，收场不再登记。失败只记日志、不抛出——不阻塞对话。
   *
   * ⚠️ 失败的后果（勿再按旧口径理解「退回登记前行为」）：
   * 轮已落盘、但会话 `roundIds` 里没有它 ⇒ **不可见**，且不属任何会话引用集合
   * （会被启动清扫当作无引用轮、在存活保护后移入 `.trash`）。
   * 这是**有意的取舍**：宁可留一个看不见的文件，也不静默删掉用户刚输入的内容；
   * 触发条件 = 会话存储写入抛错（已 warn 日志可查）。
   *
   * 调用面**只有一处**：`appendUser` 建轮后（新轮必登记）。
   * `appendAssistant` 已 fail-closed（轮不存在即拒绝，不造轮、不登记），故不再是调用面；
   * 旧注释「appendAssistant 兜底分支」与实现相反，勿按旧口径扩充调用点。
   */
  private registerRoundInSession(roundId: string): void {
    const sessionId = this.currentSessionName;
    try {
      this.sessionStore?.appendRoundId(sessionId, roundId);
      logger.debug({ roundId, sessionId }, 'appendRoundId: 轮已归属当前会话');
    } catch (err) {
      logger.warn({ err, roundId, sessionId }, 'appendRoundId: 归属登记失败（轮不可见，不阻断）');
    }
  }

  /**
   * 追加裁决证据到在途 Round（悬案取证轨；持久化失败不抛出，不阻塞对话）。
   *
   * 挂载模式与 interactiveInputs 逐字同构：不新建/不覆盖轮，按序追加到该轮 `evidence`。
   * **必须同步 pendingRounds**——否则收场 appendAssistant/appendInterrupted 以旧缓存对象
   * 覆盖落盘，证据被静默丢弃（突变点：漏 set 即丢证据）。
   * 轮缺失（异常兜底）：warn 后丢弃——证据缺失不伪造第二轨道补写。
   *
   * @param roundId 闭环节点轮次 ID
   * @param ev 裁决证据事件（空响应 / 台账替身回显个案证据）
   */
  async appendEvidence(roundId: string, ev: RoundEvidenceEvent): Promise<void> {
    if (!this.roundStore) return;
    try {
      const existing = this.roundStore.getById(roundId) ?? this.pendingRounds.get(roundId);
      if (!existing) {
        logger.warn({ roundId, type: ev.type }, 'appendEvidence: 对应轮缺失，证据丢弃');
        return;
      }
      const updated: Round = { ...existing, evidence: [...(existing.evidence ?? []), ev] };
      this.roundStore.save(updated);
      this.pendingRounds.set(roundId, updated);
      logger.debug({ roundId, type: ev.type }, 'appendEvidence: 裁决证据归属问答闭环');
    } catch (err) {
      logger.warn({ err, roundId }, 'appendEvidence: 写入失败');
    }
  }

  /**
   * 登记在途提问到当前轮（E2E-ASK-LOSS-1 写点；持久化失败不抛出）。
   *
   * 调用时机 = 提问挂起（yield paused）**之前**（装配层经 loop.onPendingQuestion 接线），
   * 保证「AI 已提问」这一事实先于挂起落盘——挂起后崩溃，问题文本仍可从盘上恢复，
   * 不再只活在进程内存（loop.pendingAsk）。
   *
   * 形状收窄：入参直取内核 `AskQuestion`，落盘只留 `question/options` 两个重放必需面
   * （见 `RoundPendingAsk`——slot/allowCustom 是交互期参数，历史重放不消费）。
   * 轮缺失（异常兜底）：warn 后丢弃——挂起轮由 appendUser 建出，缺失即更上游已异常，
   * 此处不伪造第二轨道补写（与 appendEvidence 同款降级语义）。
   *
   * @param roundId 闭环节点轮次 ID（loop.getCurrentRoundId()，与 appendUser 同源同值）
   * @param questions 本批挂起提问（ask_user 解析产物，可多题）
   */
  async markPendingAsk(
    roundId: string,
    questions: readonly { question: string; options?: string[] }[],
  ): Promise<void> {
    if (!this.roundStore || !roundId || questions.length === 0) return;
    try {
      const existing = this.roundStore.getById(roundId) ?? this.pendingRounds.get(roundId);
      if (!existing) {
        logger.warn({ roundId }, 'markPendingAsk: 对应轮缺失，在途提问不落盘');
        return;
      }
      const snapshot: RoundPendingAsk[] = questions.map((q) => ({
        question: q.question,
        ...(q.options && q.options.length > 0 ? { options: [...q.options] } : {}),
      }));
      const updated: Round = { ...existing, pendingAsk: snapshot };
      this.roundStore.save(updated);
      this.pendingRounds.set(roundId, updated);
      logger.debug({ roundId, count: snapshot.length }, 'markPendingAsk: 在途提问已落盘');
    } catch (err) {
      logger.warn({ err, roundId }, 'markPendingAsk: 写入失败');
    }
  }

  /**
   * 追加 assistant 消息到当前会话（持久化失败不抛出）。
   *
   * Round-based 路径：完成 pending Round 时**只改状态**——归属已在建轮时登记（ADR-044），
   * 此处不再登记、不回写任何引用状态。旧档轮上的历史引用字段**不判、不改、不回写**。
   * pending 缓存丢失（跨重启）时从 RoundStore 取回补全；Round **不存在时 fail-closed**：
   * 不造轮、不登记——没有真实 user 原文，凭空造轮等于编造用户从未发过的历史。
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
      // 统一取现有轮：优先 RoundStore（SSOT——含宿主 step 检查点已落盘的 processEvents），
      // pending 缓存仅作 fallback（跨重启等 store 未命中时）。旧写法 pending 优先会用
      // 无 processEvents 的 stale 快照覆盖 store → 检查点事件被静默丢弃（已修）
      const existing = this.roundStore.getById(roundId) ?? this.pendingRounds.get(roundId) ?? null;
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
          // 防御清残留（正常完成轮不该有在途提问）：作答记录落盘时已原子清（appendUser
          // 交互分支），此处清异常窗口残留；终态轮不携带 pendingAsk（RoundPendingAsk 生命周期不变量）
          pendingAsk: undefined,
        };
        this.pendingRounds.delete(roundId);
      } else {
        logger.warn({ roundId }, 'appendAssistant: Round not found in RoundStore');
      }

      if (completed) {
        // 🔴 ADR-044：归属已在**建轮**时登记（appendUser），收场只改状态——不再登记、不加任何引用状态。
        // 旧档轮（含历史上「未被引用」的半截轮）**不判不改不回写**（引用真源 = 会话 roundIds）。
        // 由此 `isRoundSettled` 不承担「防重复登记」职责（收场已不登记），但保留给
        // appendInterrupted 的「已收场即跳过」幂等判据——两处语义不同，勿合并。
        this.roundStore.save(completed);
        logger.debug({ roundId }, 'appendAssistant: Round-based Round completed');
      } else {
        // 🔴 禁止凭空造轮（fail-closed）：轮不存在时**没有真实 user 原文**，
        // 旧写法写死 `<历史消息>` 是造假原文——历史里会多出一条用户从未发过的消息，
        // 且无任何测试会红。丢一条可重试的助手消息，优于永久污染历史。
        logger.error(
          { roundId },
          'appendAssistant: Round 不存在，拒绝凭空造轮（无真实 user 原文）',
        );
      }
    }

    logger.debug({ role: message.role, session: this.currentSessionName }, 'appendAssistant');
  }

  /**
   * 中断轮收场：把「未正常完成」的轮升级为正常 stop turn 并入会话。
   *
   * 语义定案（step-atomic-persistence.md §一·五）：崩溃残留轮 = 等同于用户点「停止」的正常 turn
   * ——可删、入会话 roundIds、作后续上下文，**不是**半成品草稿/孤儿。
   * ⚠️ ADR-044 起：新建轮**建轮即入会话**，本方法只负责收场，不再登记/改计数。
   * 宿主经 `IRoundStore.listInterruptedRecent` 打捞后再调本方法完成收场，恢复为普通 turn
   * 渲染无需特殊草稿卡。
   *
   * **两个调用时机**：
   * 1. 崩溃/断电后重启——宿主 `chatPanel.upgradeInterruptedRounds` 打捞后调用；
   * 2. **运行期非正常收场**——`seed/orchestrator.act()` 在中断（用户取消/超时）与失败
   *    （LLM/网络错误）两条路径上就地调用（SSOT 收口，见该处注释）。运行期即收尾可避免
   *    留下 pending 孤儿轮、须等下次重启才打捞（LLM 4xx 中断的长任务轮即此类）。
   *    依据 = `memory/roundStore.ts` RoundStatus 文档「运行时失败不翻状态机，一律按中断处理」。
   *
   * 收场约定与 appendAssistant 同一真理源（status interrupted + completedAt；「已收场即跳过」
   * 用 `isRoundSettled`），Round schema / 存储格式不变；
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
      // 统一取现有轮：优先 RoundStore（SSOT——含宿主 step 检查点已落盘的 processEvents），
      // pending 缓存仅作 fallback。与 appendAssistant 同源（store-first），防 stale 快照覆盖
      const existing = this.roundStore.getById(roundId) ?? this.pendingRounds.get(roundId) ?? null;
      if (!existing) {
        logger.warn({ roundId }, 'appendInterrupted: Round 未找到，跳过升级');
        return;
      }
      // 已收场（幂等重跑 / 防御）：complete / interrupted 均为终态（正常完成 或 中断收场），
      // 不再二次处理（判据 SSOT = isRoundSettled）
      if (isRoundSettled(existing.status)) {
        logger.debug(
          { roundId, status: existing.status },
          'appendInterrupted: 轮已收场，跳过重复升级',
        );
        return;
      }
      // 有恢复文本才写 assistantMessage（§一·五：无 assistantMessage 总结也按 stop 语义收场）
      const content = opts?.content?.trim() ?? '';
      // 在途提问收场转化（E2E-ASK-LOSS-1）：轮上残留 pendingAsk = 「问了但未答且作答记录
      // 未落盘」的窗口仍开着——收场即窗口关闭，转化成 kind:'unanswered' 交互输入并清字段，
      // 问题文本与候选选项从「进程内存」归位到「盘上重放面」（重放渲染复用 timeout 同型「未回答」行）。
      // 消费点统一在本方法（打捞收场 / 运行期失败收场共用），宿主打捞链零改动。
      const pendingAsk = existing.pendingAsk;
      // 多题整组转化（每题一条 unanswered）：pendingAsk 是整组快照，逐题保留 question/options——
      // 崩溃轮的问题文本只在收场这一刻归档进 interactiveInputs，取首问即丢 Q2..N。
      // 装配走 buildInteractiveInputs 单点（与 appendUser 作答/超时整组同宽，ASK-MULTI-Q-1）。
      const unansweredInputs: RoundInteractiveInput[] = pendingAsk?.length
        ? buildInteractiveInputs(
            roundId,
            existing.interactiveInputs?.length ?? 0,
            pendingAsk.map((q) => ({
              content: LOOP_CONSTANTS.ASK_UNANSWERED_NOTICE,
              kind: 'unanswered' as const,
              question: q.question,
              options: q.options,
            })),
            nowIso(),
          )
        : [];
      const completed: Round = {
        // 展开保留 userMessage / interactiveInputs / processEvents 等原字段
        //（existing 取自 RoundStore 时含宿主检查点已落盘的 processEvents——store-first 优先保证）
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
        ...(unansweredInputs.length
          ? {
              interactiveInputs: [...(existing.interactiveInputs ?? []), ...unansweredInputs],
            }
          : {}),
        status: 'interrupted',
        completedAt: nowIso(),
        // 生命周期不变量收口：转化后清字段（终态轮不残留 pendingAsk）
        pendingAsk: undefined,
      };
      this.pendingRounds.delete(roundId);
      // 🔴 ADR-044：归属已在建轮时登记，收场只改状态；旧档引用字段不判不改不回写。
      this.roundStore.save(completed);
      const sessionId = this.currentSessionName;
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
    const currentIdx = roundIds.length - 1;
    for (const roundId of roundIds) {
      const round = this.roundStore.getById(roundId);
      if (!round) {
        logger.warn({ roundId }, 'loadRoundBasedMessages: Round 不存在，跳过');
        continue;
      }
      // 历史图片窗口衰减（方案 §5.12 / D22 / D23）：只有最近 RETAIN_IMAGE_ROUNDS 轮内的
      // attachments 带上模型上下文；更早轮次不带（content 不变，仍是那句占位）。
      // 窗口 = `当前索引 − 消息索引`，纯计算、零状态。
      // 注意该常量是**四个消费点同值**（见 LOOP_CONSTANTS.RETAIN_IMAGE_ROUNDS 的注释）：
      // 此处窗口衰减 + 两个 `loadMessages` 实现的同判据衰减 + 宿主会话加载期预读
      // （`hosts/memora-vscode/.../imageCache.ts` 的 `preloadSession`），
      // 拆分条件的完整论证见该常量注释。
      const idx = roundIds.indexOf(roundId);
      const withImages = currentIdx - idx < LOOP_CONSTANTS.RETAIN_IMAGE_ROUNDS;
      const userAttachments = withImages ? round.userMessage.attachments : undefined;
      // User message
      messages.push({
        role: round.userMessage.role,
        content: round.userMessage.content,
        roundId: round.id,
        timestamp: round.userMessage.timestamp,
        ...(userAttachments ? { attachments: userAttachments } : {}),
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
