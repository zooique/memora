/**
 * 会话管理器：从 Agent 拆出的独立会话职责，负责会话切换/分叉/恢复/消息加载。
 * 通过回调访问 Agent 当前组件状态，避免与 history/loop 引用生命周期耦合。
 * 不中断工作模型：SessionCheckpoint 为同进程内存态快照（不落盘、无序列化/恢复路径）；SessionStateMachine 管理三态流转。
 */

import { logger } from '@/logging/logger.js';
import { chatBusyError, configError } from '@/utils/errors.js';
// 会话标识格式契约（SSOT）：恢复最近会话时把 sessionId 拆成 (date, session) 供 loadMessages
import { isValidSessionId, splitSessionId } from '@/utils/time.js';
import type { AgentLoop } from '@/agent/loop.js';
import type { MessageHistory, ForkResult } from '@/agent/messageHistory.js';
import type { SessionMessage } from '@/memory/sessionStore.js';
import type { ISessionStore, SessionMeta } from '@/memory/sessionStore.js';
import type { Message } from '@/llm/provider.js';
import { AGENT_CONSTANTS } from '@/agent/constants.js';
import { type AgentEventName } from '@/utils/eventEmitter.js';
import type {
  SessionCheckpoint,
  SessionStatus,
  PlanItem,
  ToolExecutionRecord,
  PlanItemOutcome,
  PauseMeta,
  PauseSource,
} from '@/agent/types.js';
import { GoalConsistencyChecker } from '@/agent/managers/goalConsistencyChecker.js';
import type { GoalConsistencyResult } from '@/agent/managers/goalConsistencyChecker.js';
import { SessionStateMachine } from '@/agent/sessionStateMachine.js';

/**
 * 分叉操作结果（round-based 模式）
 *
 * 在 MessageHistory 内部 ForkResult（newSession/date/roundIds）之上附加 roundCount，
 * 基础字段派生复用，不再手写重复声明。
 */
export type AgentForkResult = ForkResult & {
  /** 新会话的 Round ID 数量（问答闭环个数） */
  roundCount: number;
};

/** 会话管理器：经回调访问 Agent 当前组件状态，支持 Agent 重建后自动取最新引用 */
export class SessionManager {
  private getHistory: () => MessageHistory;
  private getLoop: () => AgentLoop;
  /** 会话存储（可选，由宿主注入） */
  private sessionStore: ISessionStore | undefined;
  private isChatBusy: () => boolean;
  /** 发射事件（委托给 Agent 的 TypedEventEmitter） */
  private emitEvent: (event: AgentEventName, data: Record<string, unknown>) => void;

  // ─── 不中断工作模型（检查点 + 状态机） ─────────────────
  /** 会话状态机（三态流转，经有界代理方法访问） */
  private stateMachine: SessionStateMachine;
  /** 当前会话检查点（运行时状态快照） */
  private checkpoint: SessionCheckpoint | null = null;
  /** 检查点脏标记（内存态收口）：touchCheckpoint 置位、settleCheckpoint 清理（纯内存态，不落盘） */
  private checkpointDirty = false;
  /** 目标一致性校验器（目标版本一致性校验） */
  private readonly consistencyChecker: GoalConsistencyChecker;
  /**
   * 连续暂停时间戳数组（防滥用窗口）：每次高风险暂停记录时间戳，窗口（1 小时）内连续 2 次则强制降为低风险暂停。
   * ⚠ 进程内状态，不入 SessionCheckpoint——重启归零是设计（反滥用卫生状态，非执行状态）；1h 窗口自愈防线，勿引入持久化。
   */
  private consecutivePauseTimestamps: number[] = [];

  /** 连续暂停时间窗口（毫秒），1 小时前的暂停不计入连续计数 */
  private static readonly CONSECUTIVE_PAUSE_WINDOW_MS = 3_600_000;

  // ── 运行时暂停超时检测 ────────────────────────────────

  /** 暂停超时检测定时器（只在 paused 状态时运行） */
  private _pauseTimeoutTimer: ReturnType<typeof setInterval> | null = null;

  /** 暂停超时检测间隔（毫秒），30 秒检查一次心跳 */
  private static readonly PAUSE_TIMEOUT_CHECK_INTERVAL = 30_000;

  constructor(
    getHistory: () => MessageHistory,
    getLoop: () => AgentLoop,
    sessionStore: ISessionStore | undefined,
    isChatBusy: () => boolean,
    emitEvent: (event: AgentEventName, data: Record<string, unknown>) => void,
  ) {
    this.getHistory = getHistory;
    this.getLoop = getLoop;
    this.sessionStore = sessionStore;
    this.isChatBusy = isChatBusy;
    this.emitEvent = emitEvent;
    this.stateMachine = new SessionStateMachine('running');
    this.consistencyChecker = new GoalConsistencyChecker();
  }

  // ─── SSOT 状态机代理（封装 stateMachine，暴露有界接口） ───

  /** 会话状态（状态机状态） */
  get status(): SessionStatus {
    return this.stateMachine.status;
  }

  /** 获取暂停信息（仅 PAUSED 时有效） */
  get pauseInfo(): { reason: string; source: PauseSource } | null {
    return this.stateMachine.pauseInfo;
  }

  /** 获取异常原因（仅 ERROR 时有效） */
  get errorInfo(): string | null {
    return this.stateMachine.errorInfo;
  }

  /** 获取待处理暂停信息（只读，不消费） */
  get pendingPauseInfo(): { reason: string; source: PauseSource } | null {
    return this.stateMachine.pendingPauseInfo;
  }

  /** 检查是否处于暂停态 */
  isPaused(): boolean {
    return this.stateMachine.status === 'paused';
  }

  /** 检查是否处于运行态 */
  isRunning(): boolean {
    return this.stateMachine.status === 'running';
  }

  /** 待处理暂停请求是否在等待中 */
  isPausePending(): boolean {
    return this.stateMachine.isPausePending();
  }

  /**
   * 请求软暂停（仅 RUNNING 状态允许）
   *
   * 暂存暂停原因和来源，待 loop 边界真正挂起时由 consumePendingPause() 消费。
   * 与 pause() 不同：pause() 立即翻状态机，requestPause() 仅注册待处理请求。
   */
  requestPause(reason: string, source: PauseSource = 'user'): boolean {
    return this.stateMachine.requestPause(reason, source);
  }

  /** 消费待处理暂停请求（在 loop 边界真正挂起时调用） */
  consumePendingPause(): { reason: string; source: PauseSource } | null {
    return this.stateMachine.consumePendingPause();
  }

  /** 取消待处理暂停请求 */
  cancelPendingPause(): void {
    this.stateMachine.cancelPendingPause();
  }

  /**
   * 会话替换 chokepoint：作废所有会话级派生缓存。
   * 任何替换 loop 工作记忆（switch/fork/restore）入口都必须经此，新增派生缓存在此注册一处避免"对称的另一半没写完"。
   */
  private invalidateSessionDerivedState(): void {
    // 真实 loop 必有 resetContextSummary；测试 mock 可能未实现，缺失时 no-op
    this.getLoop()?.resetContextSummary?.();
  }

  /** 切换当前会话。底层 MessageHistory.switchSession 为纯同步操作，不引入无意义 async 包装。 */
  switchSession(newSession: string): string {
    // 对话进行中切换会导致消息持久化分散
    if (this.isChatBusy()) {
      throw chatBusyError('切换会话');
    }

    // 暂停/错误态切换语义未定义，保守拒绝（与 fork/restore 繁忙守卫同构）
    if (this.stateMachine.status !== 'running') {
      throw configError('切换会话', `会话处于 ${this.stateMachine.status} 态，无法切换`, [
        '仅 running 态允许 switchSession',
      ]);
    }

    // 检查点是当前会话的工作状态，切换时清空内存态（检查点纯内存态，不落盘）
    if (this.checkpoint && this.checkpoint.sessionId !== newSession) {
      this.settleCheckpoint(true);
      this.checkpoint = null;
      this.checkpointDirty = false;
    }

    const result = this.getHistory().switchSession(newSession);
    // 会话已替换：作废上下文摘要等派生缓存，避免陈旧摘要注入新会话
    this.invalidateSessionDerivedState();
    return result;
  }

  /**
   * 打开指定会话（新建空/切换已有）= switchSession 的完整版：切换身份后同步 loadSessionMessages + restoreHistory。
   * 已有会话恢复历史到工作记忆；新建空会话 restoreHistory([]) 清空（保留 system prompt），避免旧会话上下文残留注入首条消息。
   * 使用正则 /^(\d{4}-\d{2}-\d{2})-(.+)$/ 解析，正确处理包含连字符的会话名（如 2024-01-15-my-session）。
   * @returns 恢复的消息数（0 表示新建空会话）
   */
  async switchToSession(sessionId: string): Promise<number> {
    // 对话进行中切换会话会导致消息持久化分散
    if (this.isChatBusy()) {
      throw chatBusyError('打开会话');
    }
    // 严格校验会话标识格式（SSOT：isValidSessionId 单一真源）+ 拆解（date/session，会话名可含连字符）
    if (!isValidSessionId(sessionId)) {
      throw configError('打开会话', `会话标识格式错误：${sessionId}`, [
        '格式应为 YYYY-MM-DD-sessionName',
      ]);
    }
    const { date, session } = splitSessionId(sessionId);
    // 切换会话身份（内部含 busy/状态守卫 + 作废派生缓存）
    this.switchSession(session);
    // 加载/清空工作记忆：空会话 → restoreHistory([]) 清空（缓存已作废，无陈旧注入）
    const messages = await this.getHistory().loadSessionMessages(date, session);
    this.applySessionToLoop(messages);
    return messages.length;
  }

  /** 获取当前会话的日期和会话名（供 switchSession 前触发 content 类归档）；history 未初始化返回 null */
  getCurrentSessionInfo(): { date: string; session: string } | null {
    try {
      const history = this.getHistory();
      return {
        date: history.currentDateValue,
        session: history.currentSessionValue,
      };
    } catch (err) {
      // history 未就绪属正常分支（首次调用）；其他异常也降级为 null，但记录日志便于排查状态损坏
      logger.debug({ err }, 'getCurrentSessionInfo: history 未就绪或读取失败，返回 null');
      return null;
    }
  }

  /** 读取会话标题元数据：供宿主历史列表展示；未注入 getSessionMeta 时标题层静默失效 */
  getSessionMeta(sessionId: string): SessionMeta | undefined {
    return this.sessionStore?.getSessionMeta?.(sessionId);
  }

  /** 手动改名会话：仅写 displayName（用户可改），不改 autoName（LLM 只读）。显示回退：displayName 非空用之，否则用 autoName */
  renameSession(sessionId: string, title: string): void {
    this.sessionStore?.updateSessionMeta?.(sessionId, { displayName: title });
  }

  /**
   * 从指定 Round 位置分叉当前会话（round-based 模式唯一分叉方式）。
   *
   * 分叉后：新会话包含分叉点及之前的所有 Round ID，是完全平等的普通会话。
   * 原会话完整保留可切回；新会话的问答闭环独立互不干扰。
   * ⚠ fork 不隔离记忆——分支 A 的 round-summary 会在分支 B 召回中出现。
   *
   * @param roundId - 分叉点的 Round ID（可选；不传默认使用最后一个 Round）
   * @param targetSession - 可选，自定义新会话名；不传则自动生成
   */
  forkSession(roundId?: string, targetSession?: string): AgentForkResult {
    if (this.isChatBusy()) {
      throw chatBusyError('分叉');
    }

    const history = this.getHistory();

    // 记录源会话名（含日期前缀完整名，用于事件）
    const sourceSessionName = history.currentSessionName;

    // 委托 MessageHistory 完成分叉（round-based：复制 Round ID 列表）
    const result = history.forkSession(roundId, targetSession);

    // 将新会话的问答闭环加载到 AgentLoop 工作记忆
    // round-based 模式：通过 roundIds 加载消息并应用到 loop
    const sessionMessages = history.loadRoundBasedMessages(result.roundIds);
    this.applySessionToLoop(sessionMessages);

    // 关键约束：分叉后清空 checkpoint，防止新分支的 plan/goal 写入源会话检查点。
    if (this.checkpoint) {
      this.settleCheckpoint(true);
      this.checkpoint = null;
      this.checkpointDirty = false;
    }

    this.emitEvent('sessionForked', {
      from: sourceSessionName,
      to: `${result.date}-${result.newSession}`,
      roundCount: result.roundIds.length,
    });

    return {
      newSession: result.newSession,
      // 透传分叉创建的会话日期（供分叉会话命名等场景按完整会话键定位）
      date: result.date,
      roundCount: result.roundIds.length,
      roundIds: result.roundIds,
    };
  }

  /**
   * 恢复最近活跃会话：经 ISessionStore 加载最近消息到工作记忆；宿主未注入则返回 0。
   *
   * 会话管理纯度：会话一律手动创建（宿主标题条「＋」唯一入口），
   * 本方法只做「恢复」、绝不隐式创建会话——无按天归档隐式语义
   * （「今天-main 优先」类规则），也无 preferredSession 参数。最近活跃的唯一时间序真理源 = listSessionMetas[0]（updatedAt 降序）。
   *
   * @returns 恢复的消息条数（0 = 无可恢复会话）
   */
  async restoreMostRecentSession(): Promise<number> {
    // 对话进行中恢复会导致 loop 工作记忆被替换
    if (this.isChatBusy()) {
      throw chatBusyError('恢复会话');
    }

    if (!this.sessionStore) {
      logger.debug({ hasSessionStore: false }, '未注入 ISessionStore，无法恢复会话');
      return 0;
    }

    // SSOT：listSessionMetas 依 updatedAt 降序，[0] 即最近活跃会话（唯一时间序真理源）
    const metas = this.sessionStore.listSessionMetas();
    const target = metas[0]?.sessionId;
    if (!target) {
      logger.debug({ sessionCount: metas.length }, '没有可恢复的历史会话');
      return 0;
    }

    // 解析 "YYYY-MM-DD-session"（sessionId 格式契约真理源 = splitSessionId，session 名可含连字符）
    const parsed = splitSessionId(target);
    if (!parsed.session) {
      logger.debug({ session: target }, '会话标识格式不匹配');
      return 0;
    }

    const sessionMessages = this.sessionStore.loadMessages(parsed.date, parsed.session);
    if (sessionMessages.length === 0) {
      logger.debug({ messageCount: 0 }, '没有找到可恢复的历史会话');
      return 0;
    }

    this.applySessionToLoop(sessionMessages);

    return sessionMessages.length;
  }

  /** 恢复指定会话的对话 */
  async restoreSession(date: string, session: string): Promise<number> {
    // 对话进行中恢复会导致 loop 工作记忆被替换
    if (this.isChatBusy()) {
      throw chatBusyError('恢复会话');
    }

    const sessionMessages = await this.getHistory().loadSessionMessages(date, session);
    if (sessionMessages.length === 0) {
      return 0;
    }

    this.applySessionToLoop(sessionMessages);

    return sessionMessages.length;
  }

  /** 对外暴露的 loadSessionMessages 委托。⚠ 会切换当前会话（更新 currentDate/currentSession），加载后下一条 chat 写入被加载会话 */
  async loadSessionMessages(date: string, session: string): Promise<SessionMessage[]> {
    // 对话进行中加载会切换 currentDate/currentSession，导致消息持久化分散
    if (this.isChatBusy()) {
      throw chatBusyError('加载会话');
    }

    return this.getHistory().loadSessionMessages(date, session);
  }

  /** 将会话消息恢复到 AgentLoop 工作记忆 */
  private applySessionToLoop(
    sessionMessages: ReadonlyArray<{ role: string; content: string }>,
  ): void {
    const messages: Message[] = sessionMessages.map((tm) => ({
      role: tm.role as Message['role'],
      content: tm.content,
    }));
    this.getLoop().restoreHistory(messages);
    // 消息集合整体替换：作废派生缓存（与 switchSession 共用同一 chokepoint）
    this.invalidateSessionDerivedState();
  }

  // ─── 不中断工作模型：检查点 + 状态机 ──────────────────

  /**
   * 检查点必需字段默认值工厂（默认值单一真理源）。
   * 仅 createCheckpoint 新建/合并时使用——反序列化采用严格模式，不做静默补齐。
   * 必须返回新实例：数组/对象默认值共享引用会让不同检查点互相污染（一个 push 计划任务项另一凭空多出）。
   */
  private static checkpointDefaults(): Pick<
    SessionCheckpoint,
    'mainGoal' | 'currentGoal' | 'goalChangeSeq' | 'plan'
  > {
    return {
      mainGoal: '',
      currentGoal: '',
      goalChangeSeq: 0,
      plan: [],
    };
  }

  /** 从当前运行时状态创建检查点：快照消息历史与会话标识生成 SessionCheckpoint（纯内存态，
   *  不落盘——中止/断电走中断轮补全，运行时暂停同 turn 内存续跑） */
  createCheckpoint(mainGoal?: string): SessionCheckpoint {
    const history = this.getHistory();

    const prev = this.checkpoint;
    const defaults = SessionManager.checkpointDefaults();

    // 合并语义：以已有检查点为基底展开，仅覆写本次重算的字段。
    // 【禁止改回对象字面量整体重建】——整体重建≈隐式字段白名单，任何未显式列出的字段每次 pause 被静默丢弃
    // （整体重建会使 planItemLog/completedToolCalls/pauseMeta 静默归零，非幂等工具恢复后重复执行）
    this.checkpoint = {
      ...(prev ?? {}),

      // 以下字段由本次快照重算，覆写基底
      sessionId: history.currentSessionName,
      // 状态真理源是状态机，检查点只是其投影
      status: this.stateMachine.status,
      // error 以状态机为准：状态机无异常即已脱离异常态，清除旧记录
      error: this.stateMachine.errorInfo
        ? {
            cause: this.stateMachine.errorInfo,
            at: Date.now(),
            recovered: false,
          }
        : undefined,
      mainGoal: mainGoal ?? prev?.mainGoal ?? defaults.mainGoal,
      // 不传 mainGoal 时保留已有 currentGoal（防 pause() 内调用覆盖 updateGoal 的更新）
      currentGoal: mainGoal ?? prev?.currentGoal ?? prev?.mainGoal ?? defaults.currentGoal,
      goalChangeSeq: prev?.goalChangeSeq ?? defaults.goalChangeSeq,
      plan: prev?.plan ?? defaults.plan,
      lastHeartbeat: Date.now(),
    };

    // 检查点内容已整体重算，强制清脏（纯内存，无落盘）
    this.settleCheckpoint(true);

    return this.checkpoint;
  }

  /**
   * 标记检查点已变更（内存写点统一入口）。刷新心跳并置脏标记。
   * 所有修改 this.checkpoint 的方法都必须调用本方法，不得直接赋值 lastHeartbeat——否则变更不被后续清脏感知，内存与清脏链路静默分叉。
   */
  private touchCheckpoint(): void {
    if (!this.checkpoint) return;
    this.checkpoint.lastHeartbeat = Date.now(); // 心跳唯一写点
    this.checkpointDirty = true;
  }

  /**
   * 检查点脏标记清理（**纯内存态**）：
   * `SessionCheckpoint` 不落盘——中止/断电走「中断轮补全为完整 turn」而非跨重启恢复，
   * 运行时暂停是同 turn 内续跑（内存态），无跨进程载体需求。故本方法仅清理脏标记，
   * 不再写存储层（保留方法语义边界，避免为纯净化波及 40+ 处调用点）。
   */
  private settleCheckpoint(force = false): void {
    if (!this.checkpoint) return;
    if (!force && !this.checkpointDirty) return;
    // 纯内存：无落盘动作，仅清脏
    this.checkpointDirty = false;
  }

  /** 获取当前检查点快照；未创建返回 null */
  getCheckpoint(): SessionCheckpoint | null {
    return this.checkpoint;
  }

  /**
   * 暂停会话（用户/Agent/系统均可触发）。暂停前自动创建检查点；高风险暂停计入连续计数（防滥用），低风险不计。
   * @param lowRisk 低风险暂停不计连续计数（默认 false）
   */
  pause(reason: string, source: PauseSource = 'user', lowRisk: boolean = false): boolean {
    const result = this.stateMachine.pause(reason, source);
    if (result.allowed) {
      // 先在 createCheckpoint 前记 pausedAt，检查点经 spread 继承，省去 pause() 内的二次补设分支
      if (this.checkpoint) {
        this.checkpoint.pausedAt = Date.now();
      }
      this.createCheckpoint();
      // 首轮暂停无现有检查点，pausedAt 未被 spread 继承，补设并标脏
      if (this.checkpoint && !this.checkpoint.pausedAt) {
        this.checkpoint.pausedAt = Date.now();
        this.touchCheckpoint();
      }
      // 仅高风险暂停记录时间戳（低风险由 Agent 自动兜底不累积）
      if (!lowRisk) {
        this.consecutivePauseTimestamps.push(Date.now());
        logger.debug(
          { consecutivePauseCount: this.consecutivePauseTimestamps.length, reason },
          '高风险暂停已记录时间戳',
        );
      } else {
        logger.debug({ reason }, '低风险暂停不记录时间戳（Agent 自动兜底）');
      }
      // 启动暂停超时检测，防暂停会话长时间占用资源
      this.startPauseTimeoutTimer();
      this.emitEvent('sessionPaused', {
        reason,
        source,
        sessionId: this.checkpoint?.sessionId,
      });
      logger.info({ reason, source, lowRisk }, '会话已暂停');
    }
    return result.allowed;
  }

  /** 恢复会话：从 PAUSED 恢复到 RUNNING。超时会话需重新开始，不能恢复 */
  resume(): boolean {
    // 暂停超时阻止恢复
    if (this.checkpoint && this.isPauseTimedOut(this.checkpoint)) {
      logger.warn({ sessionId: this.checkpoint.sessionId }, '暂停超时，无法恢复会话（请重新开始）');
      this.emitEvent('sessionResumeBlocked', {
        sessionId: this.checkpoint.sessionId,
        reason: 'pause_timed_out',
      });
      return false;
    }

    const result = this.stateMachine.resume();
    if (result.allowed) {
      this.stopPauseTimeoutTimer();
      if (this.checkpoint) {
        // 从状态机投影 status（SSOT），避免写死
        this.checkpoint.status = this.stateMachine.status;
        // 收口暂停态残留：pausedAt 是「暂停起点」标记，恢复即应卸载——
        // 否则检查点长期残留 pausedAt（status=running + pausedAt 并列的脏快照），
        // 且下一次暂停超时判定会被旧起点污染。随 setPauseMeta 一并更新（纯内存）。
        delete this.checkpoint.pausedAt;
        // 卸载 pauseMeta 状态层挂载物（仅含展示信息，恢复即"回到运行"应卸载，否则任务面板残留"继续"按钮）。
        // 走 setPauseMeta 唯一写入口而非内联赋值，避免绕过其兜底链路（其内部已含 touch+settle，此处不再重复调用）
        this.setPauseMeta(undefined);
      }
      // 连续暂停计数在暂停超时处理（checkPauseTimeout）对称重置，
      // 不在 resume() 里清零——避免用户回答前过早清零导致防滥用机制无效
      this.emitEvent('sessionResumed', {
        sessionId: this.checkpoint?.sessionId,
      });
      logger.info('会话已恢复');
    }
    return result.allowed;
  }

  /** 触发异常（仅 RUNNING 态）。异常时自动创建检查点；createCheckpoint 会从状态机投影 status/error，不再手工赋值避免并列真理源 */
  triggerError(cause: string): boolean {
    const result = this.stateMachine.triggerError(cause);
    if (result.allowed) {
      this.createCheckpoint();
      this.emitEvent('sessionError', {
        cause,
        sessionId: this.checkpoint?.sessionId,
      });
      logger.warn({ cause }, '会话异常');
    }
    return result.allowed;
  }

  // ── 防滥用：连续暂停计数 ───────────────────────────────

  /** 清理过期暂停时间戳（窗口过滤）：移除超过窗口（1 小时）的旧时间戳，仅保留窗口内暂停；每次查询计数时自动调用 */
  private pruneStalePauseTimestamps(): void {
    const cutoff = Date.now() - SessionManager.CONSECUTIVE_PAUSE_WINDOW_MS;
    const before = this.consecutivePauseTimestamps.length;
    this.consecutivePauseTimestamps = this.consecutivePauseTimestamps.filter((ts) => ts > cutoff);
    const pruned = before - this.consecutivePauseTimestamps.length;
    if (pruned > 0) {
      logger.debug(
        { pruned, remaining: this.consecutivePauseTimestamps.length },
        '过期暂停时间戳已清理',
      );
    }
  }

  /** 检查连续暂停是否已达上限（防滥用）：先清理窗口外时间戳，再查窗口内暂停≥2 次则强制降为低风险暂停。低风险不计数 */
  isPauseLimitReached(): boolean {
    this.pruneStalePauseTimestamps();
    return this.consecutivePauseTimestamps.length >= 2;
  }

  /** 获取当前连续暂停计数：先清理窗口外时间戳，返回窗口内有效暂停数 */
  getConsecutivePauseCount(): number {
    this.pruneStalePauseTimestamps();
    return this.consecutivePauseTimestamps.length;
  }

  /** 重置连续暂停计数（防滥用）：暂停超时处理后调用。与 resume() 分离，防回答前过早清零致防滥用失效 */
  resetConsecutivePauseCount(): void {
    this.consecutivePauseTimestamps = [];
    logger.debug('连续暂停时间戳已清空');
  }

  /**
   * 放弃当前暂停检查点（宿主 stop 语义的内核出口）
   *
   * 语义 = 用户决定**彻底放弃**暂停执行，不再 resume。清理内容：
   *   1. 停暂停超时定时器（防止已放弃的 checkpoint 继续被超时清理）
   *   2. 清内存态 checkpoint + checkpointDirty + pauseMeta
   *   3. 状态机 resetToRunning（回到 idle 之前的 running 基础态，下次 chat() 正常）
   *
   * 与 resume() 的区别：resume = 想继续跑暂停点；discardCheckpoint = 不想了，检查点作废。
   * 与 pause() 的对称：pause 创建检查点；discardCheckpoint 销毁检查点。
   * @returns true=成功清理；false=无暂停检查点（空闲态调了个空）
   */
  discardCheckpoint(): boolean {
    if (!this.checkpoint) {
      logger.debug('discardCheckpoint：无检查点可清理（可能已清理或从未暂停）');
      return false;
    }

    const sessionId = this.checkpoint.sessionId;
    logger.info({ sessionId }, '放弃暂停检查点（用户 stop 语义）');

    // 1. 停暂停超时定时器
    this.stopPauseTimeoutTimer();
    // 2. 清内存态（检查点纯内存态不落盘，无存储清理动作）
    this.checkpoint = null;
    this.checkpointDirty = false;
    this.setPauseMeta(undefined);
    // 3. 状态机回到 running
    this.stateMachine.resetToRunning();

    return true;
  }

  /** 从异常恢复：标记 error.recovered=true 并经 stateMachine.recover 校验。检查点不落盘，恢复仅活在内存态 */
  recover(): boolean {
    if (!this.checkpoint || !this.checkpoint.error) {
      logger.warn('无法恢复：无检查点或异常信息');
      return false;
    }

    this.checkpoint.error.recovered = true;
    this.touchCheckpoint();

    const result = this.stateMachine.recover(this.checkpoint);
    if (result.allowed) {
      if (this.checkpoint) {
        // 从状态机投影 status（SSOT）
        this.checkpoint.status = this.stateMachine.status;
        this.touchCheckpoint();
      }
      // 内存态收口（无落盘：recovered 只活内存，跨进程一律走中断补全）
      this.settleCheckpoint();
      this.emitEvent('sessionRecovered', {
        sessionId: this.checkpoint?.sessionId,
      });
      logger.info('会话已从异常恢复');
    }
    return result.allowed;
  }

  /**
   * 更新检查点目标版本：递增 goalChangeSeq 触发漂移检测。漂移处置由内核自兜底不依赖宿主：
   * drift 级内核直接低风险暂停强制确认；minor 级仅发射事件+日志不打断执行。
   * goalDriftDetected 事件为可观测性出口，宿主可选订阅，不订阅不影响正确性。
   */
  updateGoal(newGoal: string): GoalConsistencyResult | null {
    if (!this.checkpoint) {
      this.createCheckpoint(newGoal);
      return null;
    }

    // 幂等短路：目标值未变直接返回（返回 level='same'），不递增 goalChangeSeq、不触发漂移。
    // 续跑/补充输入每轮喂相同 currentGoal，若无短路 goalChangeSeq 会退化为轮次计数器
    if (newGoal === this.checkpoint.currentGoal) {
      return {
        level: 'same',
        similarity: 1,
        constraints: this.consistencyChecker.extractConstraints(this.checkpoint.mainGoal),
        constraintsConsistent: true,
      };
    }

    // 执行一致性校验，与 mainGoal 对比
    const mainGoal = this.checkpoint.mainGoal;
    const consistencyResult = this.consistencyChecker.checkConsistency(mainGoal, newGoal);

    this.checkpoint.currentGoal = newGoal;
    this.checkpoint.goalChangeSeq++;
    this.touchCheckpoint();
    // 目标变更是会话的语义骨架，立即清脏（纯内存，无落盘）
    this.settleCheckpoint();

    // 检测到漂移则发射 goalDriftDetected 事件；drift 级自动低风险暂停强制用户确认（不计入连续计数）
    if (consistencyResult.level !== 'same') {
      this.emitEvent('goalDriftDetected', {
        sessionId: this.checkpoint.sessionId,
        mainGoal,
        newGoal,
        similarity: consistencyResult.similarity,
        level: consistencyResult.level,
        constraints: consistencyResult.constraints,
        goalChangeSeq: this.checkpoint.goalChangeSeq,
      });

      if (consistencyResult.level === 'drift') {
        const pauseReason = `目标漂移：新目标与原始目标不一致（相似度 ${consistencyResult.similarity.toFixed(2)}）`;
        this.pause(pauseReason, 'system', true);
      }
    }

    return consistencyResult;
  }

  /** 全量替换计划任务项（与 appendPlanItem 仅追加正交；保留已有任务项 id/status）。唯一生产点：task_table_update mode='update' */
  updatePlan(plan: PlanItem[]): void {
    if (!this.checkpoint) return;
    this.checkpoint.plan = plan;
    this.touchCheckpoint();
  }

  // ── 执行计划管理：SSOT 写点 ──────────────────────────────

  /** 追加计划任务项：在 plan 末尾追加新任务项，不重排已有 order。rolePack 为会议表层装配角色（可选） */
  appendPlanItem(description: string, rolePack?: string): number {
    if (!this.checkpoint) return 0;
    const newOrder = this.checkpoint.plan.length;
    const planItem: PlanItem = {
      id: crypto.randomUUID(),
      order: newOrder,
      description,
      status: 'pending',
      ...(rolePack ? { rolePack } : {}),
    };
    this.checkpoint.plan.push(planItem);
    this.touchCheckpoint();
    return this.checkpoint.plan.length;
  }

  /**
   * 写入执行计划（计划写入口唯一分发点）。模式语义：
   *   'overwrite'：先清空现有 plan 再逐条追加（真重写——LLM task_table_write / 会议预置都依赖此语义，
   *                 若与 'append' 同分支只追加不清空，则 overwrite 名存实亡）；
   *   'append'   ：在现有 plan 后逐条追加；
   *   'update'   ：全量替换现有 plan（保留已有 id/status/rolePack，仅覆盖 description）。
   *   其它 mode 兜底 no-op。
   * 分发逻辑归本类承载，由 sessionCheckpointLifecycle.test.ts 覆盖。
   */
  writePlan(
    mode: 'overwrite' | 'append' | 'update',
    steps: Array<{ description: string; rolePack?: string }>,
  ): PlanItem[] {
    // 写点自愈：checkpoint 未就绪时先创建（任务表写点 = 任务上下文就绪点）。
    // 若静默 return [] 会让 LLM 收到 ok:true + 0 步 → 伪成功 → 反复重写（实测 6 次）。
    // 不改变已有 checkpoint 时的行为（仅补前置就绪）；约会骨架（SeedPrepare 内 writePlan('overwrite')）与普通 task_table_write 同路径生效。
    const cp = this.checkpoint ?? this.createCheckpoint();
    const existingPlan = cp.plan;
    if (mode === 'overwrite' || mode === 'append') {
      // overwrite 真清空：order 由 appendPlanItem 按清空后 plan.length 从 0 重建，自洽无需额外维护
      if (mode === 'overwrite') {
        cp.plan = [];
      }
      for (const step of steps) {
        this.appendPlanItem(step.description, step.rolePack);
      }
    } else if (mode === 'update') {
      const updatedPlan = steps.map((s, i) => {
        const existing = existingPlan[i];
        return existing
          ? { ...existing, description: s.description }
          : {
              id: crypto.randomUUID(),
              order: i,
              description: s.description,
              status: 'pending' as const,
              ...(s.rolePack ? { rolePack: s.rolePack } : {}),
            };
      });
      this.updatePlan(updatedPlan);
    }
    // 确保新写入/追加/更新后的 plan 有 active step（overwrite 清空后全 pending → 激活第一个）
    this.ensureActivePlanItem();
    return cp.plan;
  }

  /**
   * 更新计划任务项状态（plan 任务项状态的唯一写点）。必须经此写点置 checkpointDirty，
   * 否则状态变更可能丢失标脏，计划变更与标脏在此原子完成。
   *
   * 写完后自动 ensureActivePlanItem：如果变更导致 active 空缺（如把 active 标记为 done/blocked），
   * 则推进下一个 pending → active。这保证任何时刻 plan 中恰好有一个 active 任务项。
   */
  updatePlanItemStatus(planItemId: string, status: PlanItem['status']): boolean {
    const planItem = this.checkpoint?.plan.find((s) => s.id === planItemId);
    if (!planItem) return false;
    planItem.status = status;
    // 确保 active 任务项存在且正确推进（把 active 标记为 done/blocked 后自动激活下一个 pending）
    this.ensureActivePlanItem();
    this.touchCheckpoint();
    return true;
  }

  /**
   * 确保 plan 中存在且仅存在一个 active step（SSOT 自维护）。
   *
   * 三种场景会触发补偿：
   * 1. 全 pending，无 active → 激活第一个 pending（plan 刚写入时）
   * 2. 有 active，且刚被标记为 done/blocked → 激活下一个 pending（推进语义）
   * 3. 无 active 且全 done/blocked → 空操作（plan 已完成）
   *
   * 不在 updatePlanItemStatus 外部重复调用——它在每次写点后自动执行。
   */
  private ensureActivePlanItem(): void {
    if (!this.checkpoint) return;
    const plan = this.checkpoint.plan;
    if (plan.length === 0) return;

    // 已有 active step → 什么都不做。
    // 注：如果多 active 同时存在 → 脏数据（历史 checkpoint 迁移/外部旁路写可能产生）；
    // 此处不修、只保单调一，上层单一写点（writePlan + updatePlanItemStatus）契约保证不会产生多 active。
    const hasActive = plan.some((s) => s.status === 'active');
    if (hasActive) return;

    // 找到第一个 pending → 激活
    const firstPending = plan.find((s) => s.status === 'pending');
    if (firstPending) {
      firstPending.status = 'active';
      // 不 touchCheckpoint——调用方（updatePlanItemStatus / writePlan）会统一标脏
    }
  }

  /**
   * 是否存在「在途计划」= 有未完成步骤（pending 或 active）。
   *
   * SSOT：全库该命题唯一实现。消费方三处——会议骨架预置守卫（prepare，判断续会不重开）、
   * 任务表 nudge 跳过（loop，已有在途表则不再诱导建表）、canContinueWithoutInput（agent，
   * 可续跑信号）。禁任一消费方自行内联谓词。
   *
   * 口径取 pending||active（非仅 active）：与 ensureActivePlanItem 的补偿语义对齐——
   * plan 非空时恒有一个 active（见 :826 场景 1/2），全 done/blocked 时无 active（场景 3），
   * 两种判法在「有未完成步」上等价，但本口径直接表达「未完成」而非「借 active 存在性」。
   */
  hasInflightPlan(): boolean {
    return (this.checkpoint?.plan ?? []).some(
      (s) => s.status === 'pending' || s.status === 'active',
    );
  }

  /** 完成一个 step（显式完成原语）：单函数内顺序写步骤状态 + planItemLog + heartbeat 保证原子性。
   *  消费方 = turn 收尾兜底 concludeActivePlanItemIfPlanFullyReached（LLM 未显式 task_table_update
   *  的最后一步补标）；迭代边界 onPlanItemBoundary 只走 logPlanItemBoundary 写日志，
   *  不经本方法推进。 */
  completePlanItem(options: { planItemId?: string; summary: string }): void {
    if (!this.checkpoint) return;

    // 标记步骤状态（经 updatePlanItemStatus 单一写点，避免旁路契约）
    const { planItemId, summary } = options;
    if (planItemId) {
      this.updatePlanItemStatus(planItemId, 'done');
    }

    this.appendPlanItemLog({ planItemId, summary });

    // 心跳 + 清脏：step 边界即检查点语义边界（纯内存态；检查点不落盘，崩溃走中断轮补全）
    this.touchCheckpoint();
    this.settleCheckpoint();
  }

  /** 写 step 边界日志（时间轴投影，不改 plan 状态）。迭代边界
   *  onPlanItemBoundary 只做本写——plan 状态推进唯一写者 = LLM 的 task_table_update。 */
  logPlanItemBoundary(options: { planItemId?: string; summary: string }): void {
    if (!this.checkpoint) return;
    this.appendPlanItemLog(options);
    this.touchCheckpoint();
    this.settleCheckpoint();
  }

  /**
   * 兜底收尾（「LLM 未显式 update 即收尾」）：turn 正常完成且计划已「全部到达」——
   * 存在 active step 且无 pending step（LLM 已显式完成所有更早步骤、当前步为最后到达的一步）——
   * 时闭合该 active 步（completePlanItem：标 done + planItemLog）。LLM 忘标最后一步时由本兜底补上，
   * 使计划达到全 done（任务表 turn 内收敛，turn 结束兜底清理）；真实多轮任务（有 pending）不受影响。
   * 触发点 = seed/orchestrator.act 正常收尾分支（非暂停/中断/失败）。
   */
  concludeActivePlanItemIfPlanFullyReached(summary: string): void {
    if (!this.checkpoint) return;
    const plan = this.checkpoint.plan;
    if (plan.length === 0) return;
    // 仍有 pending = 后续步未到达 → 真实多轮可续跑语义，不闭合
    if (plan.some((s) => s.status === 'pending')) return;
    const active = plan.find((s) => s.status === 'active');
    if (!active) return;
    this.completePlanItem({ planItemId: active.id, summary });
  }

  /**
   * 追加任务项日志（completePlanItem / logPlanItemBoundary 共用）。按 planItemId
   * 分组截断，每任务项最多 3 条——若用全局 FIFO 12 条，5+ 任务项的任务中旧任务项的运行记录会被
   * 整段截没，用户翻旧已完成任务项的摘要看到「空」。
   */
  private appendPlanItemLog(options: { planItemId?: string; summary: string }): void {
    if (!this.checkpoint) return;
    const { planItemId, summary } = options;
    const outcome: PlanItemOutcome = {
      planItemId,
      summary,
      completedAt: Date.now(),
    };
    if (!this.checkpoint.planItemLog) {
      this.checkpoint.planItemLog = [];
    }
    this.checkpoint.planItemLog.push(outcome);
    // 每任务项截断上限：同 planItemId（含 undefined 兜底组）超过 3 条时移除最早进入的超出记录
    const PLAN_ITEM_LOG_PER_ITEM_LIMIT = 3;
    const groupCount = this.checkpoint.planItemLog.filter((s) => s.planItemId === planItemId).length;
    if (groupCount > PLAN_ITEM_LOG_PER_ITEM_LIMIT) {
      let excess = groupCount - PLAN_ITEM_LOG_PER_ITEM_LIMIT;
      this.checkpoint.planItemLog = this.checkpoint.planItemLog.filter((s) => {
        if (excess > 0 && s.planItemId === planItemId) {
          excess -= 1;
          return false;
        }
        return true;
      });
    }
  }

  /** 卸载运行态挂载物：任务流结束/转 idle 时清空 plan/planItemLog（SSOT 资源层 vs 状态层模型），回到"空闲=无挂载物"常态；与 updatePlan（运行态维护）正交 */
  clearPlan(): void {
    if (!this.checkpoint) return;
    this.checkpoint.plan = [];
    this.checkpoint.planItemLog = undefined;
    this.touchCheckpoint();
    this.settleCheckpoint();
  }

  /** 设置暂停元数据；传 undefined 清除。写后必须清脏（清除也清脏，纯内存态无磁盘残留） */
  setPauseMeta(meta: PauseMeta | undefined): void {
    // 意图：pauseMeta 通常随 pause()（建检查点后）写入，但检查点不一定已存在（首轮/未知状态），
    // 故保留防御性守卫——无检查点时静默 no-op，不抛弃 pause/resume 链路的其余语义。
    if (!this.checkpoint) return;
    this.checkpoint.pauseMeta = meta;
    this.touchCheckpoint();
    this.settleCheckpoint();
  }

  /**
   * 计划是否全部阻塞（预判短路收窄专用判定）：仅全 blocked 视为真停滞。
   * 全 done / 计划空不视为"需要拦截"——用户主动点「继续」= 要 AI 产出，
   * 全 done 可能只是本步收尾（还有总结未说出），空计划是普通问答暂停续跑，都应放行调 LLM。
   * 口径警告：不得把空计划/全 done 判为停滞，否则会误拦正常续跑。
   */
  isPlanAllBlocked(): boolean {
    if (!this.checkpoint) return false;
    const { plan } = this.checkpoint;
    return plan.length > 0 && plan.every((s) => s.status === 'blocked');
  }

  /** 获取下一个 pending 任务项（只读不推进，供上下文注入） */
  getNextPendingPlanItem(): PlanItem | null {
    if (!this.checkpoint) return null;
    return this.checkpoint.plan.find((s) => s.status === 'pending') ?? null;
  }

  /** 获取当前 active 步骤 */
  getActivePlanItem(): PlanItem | null {
    if (!this.checkpoint) return null;
    return this.checkpoint.plan.find((s) => s.status === 'active') ?? null;
  }

  // ── 工具执行日志（outbox 模式）：补偿管线不启用，以下仅日志 ──

  /**
   * 记录工具执行：追加到检查点日志（append-only，内存态）。
   * 标脏策略：仅标脏不即时清脏（completePlanItem step 边界统一清脏、createCheckpoint 暂停/异常强制清脏）。
   * 检查点纯内存态不落盘：completedToolCalls 仅内存态，回合中途崩溃即整体丢弃、走中断轮补全恢复；
   * 「工具重跑排重」仅在单进程存活期内有效，无跨重启持久化。
   */
  logToolExecution(record: ToolExecutionRecord): void {
    if (!this.checkpoint) return;
    if (!this.checkpoint.completedToolCalls) {
      this.checkpoint.completedToolCalls = [];
    }
    this.checkpoint.completedToolCalls.push(record);
    // FIFO 封顶，优先丢幂等最早记录、非幂等永不丢弃。注意 idempotent 是 IdempotencyLevel 字符串
    // （'non-idempotent' 也 truthy），不能用 truthy 判断，必须显式排除 'non-idempotent'
    if (this.checkpoint.completedToolCalls.length > AGENT_CONSTANTS.COMPLETED_TOOL_CALLS_MAX) {
      const discardable = this.checkpoint.completedToolCalls.findIndex(
        (r) => r.idempotent !== 'non-idempotent',
      );
      if (discardable >= 0) {
        this.checkpoint.completedToolCalls.splice(discardable, 1);
      }
    }
    this.touchCheckpoint();
    // 依赖 completePlanItem / createCheckpoint 在 step 边界统一清脏
  }

  /** 记录非幂等工具执行（补偿降级后仅日志）：不再逐副作用执行补偿，仅记录事实供宿主/人工排查 */
  compensateTool(record: ToolExecutionRecord): string {
    const msg = `${record.name}(${record.argsSignature.slice(0, 50)})：非幂等工具，需人工确认是否需要补偿`;
    logger.warn({ tool: record.name, argsSignature: record.argsSignature.slice(0, 80) }, msg);
    return msg;
  }

  /** 记录所有非幂等工具执行（补偿降级后仅日志）：直接记录所有非幂等工具，每条生成一条日志 */
  compensateAllNonIdempotent(): string[] {
    if (!this.checkpoint?.completedToolCalls) return [];
    return this.checkpoint.completedToolCalls
      .filter((r) => r.idempotent === 'non-idempotent')
      .map((r) => this.compensateTool(r));
  }

  /** 发送心跳，防僵尸会话 */
  heartbeat(): void {
    if (this.checkpoint) {
      this.touchCheckpoint();
    }
  }

  /**
   * 标记会话暂停超时（超时事实唯一写点）。广播式：超时信息经事件载荷传递，多监听器并行消费互不干扰。
   * 由 checkPauseTimeout 调用（唯一调用点，启动路径无跨重启恢复）。
   * 会话标识不符 YYYY-MM-DD-<会话名> 时 date/session 缺省但仍发射事件。
   */
  private markSessionTimedOut(sessionId: string, pauseDuration: number): void {
    const payload: Record<string, unknown> = { sessionId, pauseDuration };
    // 严格校验（SSOT：isValidSessionId 单一真源）；合法才拆解，非法走 warn 兜底
    if (isValidSessionId(sessionId)) {
      const { date, session } = splitSessionId(sessionId);
      payload.date = date;
      payload.session = session;
    } else {
      logger.warn({ sessionId }, '暂停超时会话标识不符合 YYYY-MM-DD-<会话名> 约定，跳过自动归档');
    }

    this.emitEvent('sessionPauseTimedOut', payload);
  }

  // ── 运行时暂停超时检测 ────────────────────────────────

  /** 启动暂停超时检测定时器（仅 paused 态生效）：超时自动清理检查点、重置状态机、发射事件。先 stop 防重复启动 */
  private startPauseTimeoutTimer(): void {
    this.stopPauseTimeoutTimer(); // 确保不重复启动
    this._pauseTimeoutTimer = setInterval(() => {
      this.checkPauseTimeout();
    }, SessionManager.PAUSE_TIMEOUT_CHECK_INTERVAL);
    // 允许定时器不阻止进程退出（Node.js unref）
    if (typeof this._pauseTimeoutTimer === 'object' && 'unref' in this._pauseTimeoutTimer) {
      (this._pauseTimeoutTimer as NodeJS.Timeout).unref();
    }
  }

  /** 停止暂停超时检测定时器 */
  private stopPauseTimeoutTimer(): void {
    if (this._pauseTimeoutTimer !== null) {
      clearInterval(this._pauseTimeoutTimer);
      this._pauseTimeoutTimer = null;
    }
  }

  /** 检查暂停超时并在超时时自动清理：清理检查点、重置状态机、发射事件并停止定时器 */
  private checkPauseTimeout(): void {
    const checkpoint = this.checkpoint;
    if (!checkpoint || checkpoint.status !== 'paused') return;

    if (!this.isPauseTimedOut(checkpoint)) return;

    // 暂停超时，自动清理
    const sessionId = checkpoint.sessionId;
    const pauseDuration = Date.now() - (checkpoint.pausedAt ?? checkpoint.lastHeartbeat);

    logger.warn({ sessionId, pauseDuration }, '运行时检测到暂停超时，自动清理检查点');

    // 清除检查点 + 状态机回到 running；残留脏标记无对应内存态一并清除
    this.checkpoint = null;
    this.checkpointDirty = false;
    this.stateMachine.resetToRunning();

    // 暂停超时意味着会话断裂，重置连续暂停计数（递增→衰减→重置闭合）
    this.resetConsecutivePauseCount();

    // 记录超时会话 + 发射事件（唯一入口）
    this.markSessionTimedOut(sessionId, pauseDuration);

    // 超时后不再需要继续检测
    this.stopPauseTimeoutTimer();
  }

  /** 关闭时清脏（纯内存，无落盘）：Agent 关闭、destroy 前调用。检查点不落盘，
   *  本方法为保留语义边界的 no-op 清脏（无持久化动作） */
  flushOnShutdown(): void {
    this.settleCheckpoint(true);
  }

  /** 立即清脏（纯内存，无落盘）：非只读工具完成后调用。⚠️ 检查点不落盘，completedToolCalls 仅内存态——
   *  「工具重跑排重」仅在单进程存活期内生效，进程崩溃/重启后失效（走中断轮补全）。无落盘设计，
   *  本方法为保留语义边界的 no-op 清脏 */
  flushNow(): void {
    this.settleCheckpoint(true);
  }

  /** 销毁 SessionManager，清理所有定时器（防阻止进程退出或悬空回调） */
  destroy(): void {
    this.stopPauseTimeoutTimer();
  }

  /**
   * 检查暂停是否超时：仅对 paused 态，距离暂停起点（pausedAt，缺失回退 lastHeartbeat）超过 PAUSE_TIMEOUT_MS 视为超时。
   * pausedAt 与 lastHeartbeat 解耦，避免暂停后 touchCheckpoint 刷新心跳让超时判定被无限推迟。超时会话自动清理不再恢复。
   */
  private isPauseTimedOut(checkpoint: SessionCheckpoint): boolean {
    if (checkpoint.status !== 'paused') return false;
    const pauseStart = checkpoint.pausedAt ?? checkpoint.lastHeartbeat;
    return Date.now() - pauseStart > AGENT_CONSTANTS.PAUSE_TIMEOUT_MS;
  }
}
