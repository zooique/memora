/**
 * 会话管理器：从 Agent 拆出的独立会话职责，负责会话切换/分叉/恢复/消息加载。
 * 通过回调访问 Agent 当前组件状态，避免与 history/loop 引用生命周期耦合。
 * 不中断工作模型：会话状态可序列化为 SessionCheckpoint，支持暂停后断点续跑；SessionStateMachine 管理三态流转。
 */

import { logger } from '@/logging/logger.js';
import { chatBusyError, configError } from '@/utils/errors.js';
// todayDate() 按本地时区取会话日期键；toISOString().slice(0,10) 是 UTC 日期，本地跨天会产生错位
import { todayDate } from '@/utils/time.js';
import type { AgentLoop } from '@/agent/loop.js';
import type { MessageHistory } from '@/agent/messageHistory.js';
import type { SessionMessage } from '@/memory/sessionStore.js';
import type { ISessionStore, SessionMeta } from '@/memory/sessionStore.js';
import type { Message } from '@/llm/provider.js';
import { AGENT_CONSTANTS } from '@/agent/constants.js';
import { type AgentEventName } from '@/utils/eventEmitter.js';
import type {
  SessionCheckpoint,
  SessionStatus,
  ChatMessage,
  Role,
  Standard,
  ResourceState,
  PlanStep,
  ToolExecutionRecord,
  RoundOutcome,
  PauseMeta,
} from '@/agent/types.js';
import { GoalConsistencyChecker } from '@/agent/managers/goalConsistencyChecker.js';
import type { GoalConsistencyResult } from '@/agent/managers/goalConsistencyChecker.js';
import { SessionStateMachine } from '@/agent/sessionStateMachine.js';
import type { PauseSource } from '@/agent/sessionStateMachine.js';

/**
 * Agent.forkSession() 返回值类型（相对 MessageHistory 内部 ForkResult 的简化封装，只暴露宿主需要字段）。
 */
export interface AgentForkResult {
  /** 新分支会话名（不含日期前缀，可直接传给 switchSession()） */
  newSession: string;
  /** 分叉时复制的消息数量 */
  messageCount: number;
}

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
  /** 检查点脏标记（落盘收口）：内存态≠磁盘态时为 true，touchCheckpoint 置位、flushCheckpoint 写盘后清除 */
  private checkpointDirty = false;
  /** 目标一致性校验器（目标版本一致性校验） */
  private readonly consistencyChecker: GoalConsistencyChecker;
  /**
   * 连续暂停时间戳数组（时间衰减机制）：每次高风险暂停记录时间戳，窗口（1 小时）内连续 2 次则强制降级 P3。
   * ⚠ 进程内状态，不入 SessionCheckpoint——重启归零是设计（反滥用卫生状态，非执行状态）；1h 窗口衰减为自愈防线，勿引入持久化。
   */
  private consecutivePauseTimestamps: number[] = [];

  /** 连续暂停时间衰减窗口（毫秒），1 小时前的暂停不计入连续计数 */
  private static readonly CONSECUTIVE_PAUSE_DECAY_MS = 3_600_000;

  /** 会话标识解析模式 `YYYY-MM-DD-<会话名>`：日期段定长，正则无歧义还原二元组，会话名含连字符也不误切 */
  private static readonly SESSION_ID_PATTERN = /^(\d{4}-\d{2}-\d{2})-(.+)$/;

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

    // 检查点是当前会话的工作状态，切换时 flush 落盘并清空内存态
    if (this.checkpoint && this.checkpoint.sessionId !== newSession) {
      this.flushCheckpoint(true);
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
    // 使用正则解析 sessionId：日期段（YYYY-MM-DD）+ 会话名（可含连字符）
    const match = sessionId.match(SessionManager.SESSION_ID_PATTERN);
    if (!match || !match[1] || !match[2]) {
      throw configError('打开会话', `会话标识格式错误：${sessionId}`, [
        '格式应为 YYYY-MM-DD-sessionName',
      ]);
    }
    const [, date, session] = match;
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
   * 分叉当前会话：复制完整消息历史到新分支并切过去继续。原会话完整保留可切回；新分支消息历史独立互不干扰。
   * ⚠ fork 不隔离记忆——分支 A 的 round-summary 会在分支 B 召回中出现。需完全独立记忆空间（如多用户）应创建独立 Agent+dataDir，而非 fork。
   */
  forkSession(targetSession?: string): AgentForkResult {
    if (this.isChatBusy()) {
      throw chatBusyError('分叉');
    }

    const history = this.getHistory();

    // 记录源会话名（含日期前缀完整名，用于事件）
    const sourceSessionName = history.currentSessionName;

    // 委托 MessageHistory 完成分叉
    const result = history.forkSession(targetSession);

    // 将消息恢复到 AgentLoop 工作记忆
    this.applySessionToLoop(result.messages);

    // 关键修复：分叉后清空 checkpoint，防止新分支的 plan/goal 写入源会话持久化检查点。
    // 对比 switchSession（:180-184）有 flush+清空，forkSession 必须做同样的隔离处理。
    // 否则 updateGoal→flushCheckpoint 会把新分支状态写入源会话，造成跨会话数据污染。
    if (this.checkpoint) {
      this.flushCheckpoint(true);
      this.checkpoint = null;
      this.checkpointDirty = false;
    }

    this.emitEvent('sessionForked', {
      from: sourceSessionName,
      to: `${result.date}-${result.newSession}`,
      messageCount: result.messages.length,
    });

    return {
      newSession: result.newSession,
      messageCount: result.messages.length,
    };
  }

  /** 恢复最近会话：经 ISessionStore 加载最近消息到工作记忆；宿主未注入则返回 0 */
  async restoreMostRecentSession(preferredSession = 'main'): Promise<number> {
    // 对话进行中恢复会导致 loop 工作记忆被替换
    if (this.isChatBusy()) {
      throw chatBusyError('恢复会话');
    }

    if (!this.sessionStore) {
      logger.debug({ hasSessionStore: false }, '未注入 ISessionStore，无法恢复会话');
      return 0;
    }

    // 从 sessionStore 列出所有会话，找到最近的
    const sessions = this.sessionStore.listSessions();
    if (sessions.length === 0) {
      logger.debug({ sessionCount: 0 }, '没有找到可恢复的历史会话');
      return 0;
    }

    // 优先匹配 preferredSession，否则取最后一个；用 todayDate()（本地时区）避免 UTC 跨天写"昨天"
    const today = todayDate();
    const preferred =
      sessions.find((s) => s === `${today}-${preferredSession}`) ?? sessions[sessions.length - 1];

    // 解析 "YYYY-MM-DD-session" 格式（正则已保证两捕获组存在，仅用于类型收窄）
    const match = (preferred ?? '').match(/^(\d{4}-\d{2}-\d{2})-(.+)$/);
    if (!match) {
      logger.debug({ session: preferred }, '会话标识格式不匹配');
      return 0;
    }

    const [, date, session] = match;
    if (!date || !session) {
      logger.debug({ session: preferred }, '会话标识解析失败');
      return 0;
    }
    const sessionMessages = this.sessionStore.loadMessages(date, session);
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
   * 必须返回新实例：数组/对象默认值共享引用会让不同检查点互相污染（一个 push 计划步骤另一凭空多出）。
   */
  private static checkpointDefaults(): Pick<
    SessionCheckpoint,
    | 'mainGoal'
    | 'currentGoal'
    | 'goalChangeSeq'
    | 'plan'
    | 'role'
    | 'standard'
    | 'resource'
    | 'hotMemory'
  > {
    return {
      mainGoal: '',
      currentGoal: '',
      goalChangeSeq: 0,
      plan: [],
      role: { name: 'assistant' },
      standard: { quality: '', constraints: [] },
      resource: { documents: [], memories: [], context: '' },
      hotMemory: [],
    };
  }

  /** 从当前运行时状态创建检查点：快照消息历史与会话标识生成可序列化 SessionCheckpoint 并持久化 */
  createCheckpoint(mainGoal?: string, role?: Role, standard?: Standard): SessionCheckpoint {
    const history = this.getHistory();

    // 从 AgentLoop 获取热记忆（FIFO 截断 + 内容截断）
    const { messages: hotMemory, truncatedCount } = this.extractHotMemory();

    const prev = this.checkpoint;
    const defaults = SessionManager.checkpointDefaults();

    // 合并语义：以已有检查点为基底展开，仅覆写本次重算的字段。
    // 【禁止改回对象字面量整体重建】——整体重建≈隐式字段白名单，任何未显式列出的字段每次 pause 被静默丢弃
    // （整体重建曾使 roundLog/completedToolCalls/pauseMeta 静默归零，非幂等工具恢复后重复执行）
    this.checkpoint = {
      ...(prev ?? {}),

      // 以下字段由本次快照重算，覆写基底
      // schemaVersion 恒为当前版本：合并语义下 prev 可能出于旧版本无此字段，
      // 须显式覆写（旧版本 createCheckpoint 未写 schemaVersion → 绝对版本路由）
      schemaVersion: AGENT_CONSTANTS.CHECKPOINT_SCHEMA_VERSION,
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
      role: role ?? prev?.role ?? defaults.role,
      standard: standard ?? prev?.standard ?? defaults.standard,
      resource: prev?.resource ?? defaults.resource,
      // hotMemory 与 truncatedCount 必须配套重算，不可从基底继承
      hotMemory,
      truncatedCount: truncatedCount > 0 ? truncatedCount : undefined,
      lastHeartbeat: Date.now(),
    };

    // 检查点内容已整体重算，强制落盘
    this.flushCheckpoint(true);

    return this.checkpoint;
  }

  /**
   * 标记检查点已变更（内存写点统一入口）。刷新心跳并置脏标记。
   * 所有修改 this.checkpoint 的方法都必须调用本方法，不得直接赋值 lastHeartbeat——否则变更不被后续 flush 感知，内存与磁盘静默分叉。
   */
  private touchCheckpoint(): void {
    if (!this.checkpoint) return;
    this.checkpoint.lastHeartbeat = Date.now(); // 心跳唯一写点
    this.checkpointDirty = true;
  }

  /**
   * 冲洗检查点到存储层（落盘唯一入口）。写盘失败保留脏标记使其下个语义边界自动重试，单次 IO 抖动不丢变更。
   * @param force 忽略脏标记强制落盘（用于检查点被整体替换场景）
   */
  private flushCheckpoint(force = false): void {
    if (!this.checkpoint) return;
    if (!force && !this.checkpointDirty) return;
    if (!this.sessionStore?.saveCheckpoint) {
      // 无存储层：降级纯内存模式，清脏避免无意义累积
      this.checkpointDirty = false;
      return;
    }
    try {
      const json = JSON.stringify(this.checkpoint);
      this.sessionStore.saveCheckpoint(this.checkpoint.sessionId, json);
      this.checkpointDirty = false;
    } catch (err) {
      logger.warn({ err }, '检查点持久化失败（保留脏标记，下个语义边界重试）');
    }
  }

  /** 加载持久化检查点（Agent 重启后恢复暂停/异常会话）；不存在返回 null */
  loadPersistedCheckpoint(): SessionCheckpoint | null {
    if (!this.sessionStore?.loadCheckpoint) return null;

    try {
      const history = this.getHistory();
      const sessionId = history.currentSessionName;

      const json = this.sessionStore.loadCheckpoint(sessionId);
      if (!json) return null;

      // 反序列化收口：解析 + 严格校验统一由 parseCheckpoint 承担
      // （`JSON.parse(json) as` 断言无运行时效力，残缺检查点会抛错被外层 catch 静默吞掉整个会话）。
      const checkpoint = SessionManager.parseCheckpoint(json, sessionId);
      if (!checkpoint) {
        logger.warn({ sessionId }, '持久化检查点无法解析或不可修复，降级为内存模式');
        return null;
      }

      this.checkpoint = checkpoint;
      // 刚从磁盘读入，内存态与磁盘态一致
      this.checkpointDirty = false;

      // 暂停超时检测：超时会话自动清理检查点，不恢复暂停状态
      if (this.isPauseTimedOut(checkpoint)) {
        const pauseDuration = Date.now() - (checkpoint.pausedAt ?? checkpoint.lastHeartbeat);
        logger.warn(
          { sessionId, pauseDuration, status: checkpoint.status },
          '暂停超时，自动清理检查点（会话将继续，但不会恢复暂停状态）',
        );

        // 从存储层删除防下次 init 重复加载；状态机保持运行中
        this.sessionStore.deleteCheckpoint?.(sessionId);
        this.checkpoint = null;
        this.checkpointDirty = false;
        // 与 checkPauseTimeout 对称地重置连续暂停计数
        this.resetConsecutivePauseCount();
        this.markSessionTimedOut(sessionId, pauseDuration);

        return null;
      }

      // 恢复状态机状态
      if (checkpoint.status === 'paused') {
        this.stateMachine.pause('从持久化检查点恢复', 'system');
        // 补启暂停超时定时器（唯一调用点在 pause()，此处绕过需补启，否则恢复的 paused 会话本次运行期无超时检测）
        this.startPauseTimeoutTimer();
      } else if (checkpoint.status === 'error' && checkpoint.error) {
        this.stateMachine.triggerError(checkpoint.error.cause);
      }
      // running 无需额外操作

      logger.info({ sessionId, status: checkpoint.status }, '已从持久化存储加载会话检查点');
      return checkpoint;
    } catch (err) {
      logger.warn({ err }, '加载持久化检查点失败（降级为内存模式）');
      return null;
    }
  }

  /**
   * 检查点归一化（反序列化唯一收口）。
   * 为什么：反序列化此前各写各的，残缺数据或静默丢整会话（loadPersistedCheckpoint 断言无运行时效力被 catch 吞）或崩进程（restore 直接信任外部对象 map() 抛 TypeError）。
   * 严格模式：检查点由当前版本 createCheckpoint 全量写入，任一必需字段缺失或类型错误即视为数据损坏，拒绝恢复（返回 null），
   * 不做静默补齐——兜底填充掩盖根因（缺字段=写入 bug 或存储损坏，应暴露而非糊过去）。
   * 版本策略＝「版本门控」而非「字段迁移」：当前仅 CHECKPOINT_SCHEMA_VERSION（v1）。高于本版本拒绝恢复；
   * 若未来引入 v2 新增必需字段，旧 checkpoint 须在下方版本路由处实现显式迁移，否则按损坏拒绝——绝不静默补字段。
   * 原地改写入参而非返回副本（restore 本就改写同一引用，返回副本会制造双份并列副本）。
   */
  private static normalizeCheckpoint(
    raw: unknown,
    fallbackSessionId?: string,
  ): SessionCheckpoint | null {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      logger.warn(
        { rawType: Array.isArray(raw) ? 'array' : typeof raw, fallbackSessionId },
        '检查点归一化失败：内容不是对象（按无检查点处理）',
      );
      return null;
    }

    const cp = raw as Partial<SessionCheckpoint>;

    // sessionId 是会话定位键，不可编造：本体缺失时只接受调用方已知的值
    if (typeof cp.sessionId !== 'string' || !cp.sessionId) {
      if (!fallbackSessionId) {
        logger.warn('检查点归一化失败：缺少 sessionId 且调用方未提供回填值');
        return null;
      }
      cp.sessionId = fallbackSessionId;
    }

    // K1 版本路由：schemaVersion 缺失视为旧版本（向后兼容由未写版本的内核生成）；
    // 缺失即旧版本签注为当前版本，使后续必需字段校验可用当前 schema 约束；
    // 高于当前版本拒绝恢复（来自未来内核，结构可能不匹配，静默恢复比拒绝更危险）。
    const declaredVersion =
      cp.schemaVersion === undefined
        ? AGENT_CONSTANTS.CHECKPOINT_SCHEMA_VERSION
        : cp.schemaVersion;
    if (typeof declaredVersion !== 'number' || !Number.isFinite(declaredVersion) || declaredVersion <= 0) {
      logger.warn(
        { sessionId: cp.sessionId, schemaVersion: cp.schemaVersion },
        '检查点版本非法（非正整数），视为数据损坏拒绝恢复',
      );
      return null;
    }
    if (declaredVersion > AGENT_CONSTANTS.CHECKPOINT_SCHEMA_VERSION) {
      logger.warn(
        { sessionId: cp.sessionId, declaredVersion, currentVersion: AGENT_CONSTANTS.CHECKPOINT_SCHEMA_VERSION },
        '检查点来自未来版本，结构可能不匹配，拒绝恢复（请升级内核或迁移检查点）',
      );
      return null;
    }
    // 掉入此处：declaredVersion === 当前版本（含缺失回退）。新创建路径由 createCheckpoint
    // 写入当前版本；缺失回退在此未回写字段——恢复路径只读不写，回写交由 createCheckpoint
    // 下次落盘时自然覆盖为新版本（单次恢复场景不重写磁盘，保持只读）。
    cp.schemaVersion = declaredVersion;

    // 必需字段严格校验：任一缺失或类型错误即视为损坏，拒绝恢复（不静默补齐）
    const invalidFields: string[] = [];
    const isFiniteNumber = (v: unknown): v is number =>
      typeof v === 'number' && Number.isFinite(v);
    const isPlainObject = (v: unknown): v is Record<string, unknown> =>
      typeof v === 'object' && v !== null && !Array.isArray(v);

    if (cp.status !== 'running' && cp.status !== 'paused' && cp.status !== 'error') {
      invalidFields.push('status');
    }
    if (typeof cp.mainGoal !== 'string') invalidFields.push('mainGoal');
    if (typeof cp.currentGoal !== 'string') invalidFields.push('currentGoal');
    if (!isFiniteNumber(cp.goalChangeSeq)) invalidFields.push('goalChangeSeq');
    if (!isFiniteNumber(cp.lastHeartbeat)) invalidFields.push('lastHeartbeat');
    if (!Array.isArray(cp.plan)) invalidFields.push('plan');
    if (!Array.isArray(cp.hotMemory)) invalidFields.push('hotMemory');
    if (!isPlainObject(cp.role)) invalidFields.push('role');
    if (!isPlainObject(cp.standard)) invalidFields.push('standard');
    if (!isPlainObject(cp.resource)) invalidFields.push('resource');

    if (invalidFields.length > 0) {
      logger.warn(
        { sessionId: cp.sessionId, invalidFields },
        '检查点归一化失败：必需字段缺失或类型错误（数据损坏），拒绝恢复',
      );
      return null;
    }

    // 可选字段结构非法视为缺席：optional 字段有合法「未设置」语义，清空而非编造
    if (cp.pausedAt !== undefined && !isFiniteNumber(cp.pausedAt)) {
      delete cp.pausedAt;
    }
    if (
      cp.error !== undefined &&
      (!isPlainObject(cp.error) ||
        typeof cp.error.cause !== 'string' ||
        !cp.error.cause ||
        !isFiniteNumber(cp.error.at) ||
        typeof cp.error.recovered !== 'boolean')
    ) {
      // 异常态无法重建时清空，交由 restoreFromCheckpoint 降级为 running 并记录
      cp.error = undefined;
    }

    return cp as SessionCheckpoint;
  }

  /**
   * 检查点反序列化（JSON 入口唯一收口）。JSON.parse 失败（内容损坏）与必需字段残缺是两类故障，
   * 解析失败按无检查点处理；解析成功交 normalizeCheckpoint 严格校验。损坏或不可修复返回 null。
   */
  private static parseCheckpoint(
    json: string,
    fallbackSessionId?: string,
  ): SessionCheckpoint | null {
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch (err) {
      logger.warn({ err, fallbackSessionId }, '检查点 JSON 解析失败（内容损坏，按无检查点处理）');
      return null;
    }
    return SessionManager.normalizeCheckpoint(raw, fallbackSessionId);
  }

  /** 获取当前检查点快照；未创建返回 null */
  getCheckpoint(): SessionCheckpoint | null {
    return this.checkpoint;
  }

  /**
   * 从检查点恢复会话：恢复热记忆到 AgentLoop 工作记忆 + 恢复状态机到记录状态。
   * 异步：内部 await loadSessionMessages 切换会话，调用方 await 等待完成。
   */
  async restoreFromCheckpoint(checkpoint: SessionCheckpoint): Promise<number> {
    // 与 loadPersistedCheckpoint 共用归一化入口：严格校验必需字段，损坏即拒绝恢复
    if (!SessionManager.normalizeCheckpoint(checkpoint)) {
      // 可选链非冗余：外部（宿主 IPC）可能传入 null
      logger.error(
        { sessionId: checkpoint?.sessionId },
        '检查点结构不可修复，恢复中止（会话保持当前状态，不做部分恢复）',
      );
      return 0;
    }

    this.checkpoint = checkpoint;
    // 外部整体注入，视为与来源一致；后续变更由 touchCheckpoint 标脏
    this.checkpointDirty = false;

    // 恢复热记忆到 AgentLoop
    const messages: Message[] = checkpoint.hotMemory.map((cm) => ({
      role: cm.role,
      content: cm.content,
      // 恢复 name 字段（LLM 上下文一致性）
      name: cm.name,
      toolCalls: cm.toolCalls,
      toolCallId: cm.toolCallId,
    }));
    this.getLoop().restoreHistory(messages);
    // 恢复替换了消息集合：作废派生缓存（与 switch/fork 共用 chokepoint）
    this.invalidateSessionDerivedState();

    // 注入截断一致性标记：热记忆被截断时告知 LLM 有早期消息被截断（可触发温记忆召回），避免上下文缺失困惑
    if (checkpoint.truncatedCount && checkpoint.truncatedCount > 0) {
      this.getLoop().injectSystemMessage(
        `[热记忆截断提示] 本次恢复的会话有 ${checkpoint.truncatedCount} 条早期消息已被截断。这些消息已不在当前上下文中，但相关信息已归档到温记忆中，可通过温记忆召回获取。`,
      );
    }

    // 恢复状态机：先强制归零再按检查点重建——triggerError/pause 仅允许从 running 出发，
    // 不先归零时若残留 paused/error 会静默失败 → 磁盘检查点 status 与内存状态机分叉。
    this.stateMachine.resetToRunning();
    if (checkpoint.status === 'error') {
      if (checkpoint.error) {
        const transition = this.stateMachine.triggerError(checkpoint.error.cause);
        if (!transition.allowed) {
          logger.error(
            { transition, sessionId: checkpoint.sessionId },
            '检查点错误态恢复失败，状态机与检查点分叉',
          );
        }
      } else {
        // error 字段缺失/结构非法无法重建 error 态：强制检查点状态跟随归零结果并显式记录降级，避免永久分叉无日志
        checkpoint.status = this.stateMachine.status;
        logger.warn(
          { sessionId: checkpoint.sessionId },
          '检查点 error 态缺少 error 字段，无法重建异常状态，已降级为 running',
        );
      }
    } else if (checkpoint.status === 'paused') {
      const transition = this.stateMachine.pause('从检查点恢复', 'system');
      if (transition.allowed) {
        // 补启暂停超时定时器（唯一调用点在 pause() 此处绕过，否则恢复的 paused 会话本次运行期无超时检测）
        this.startPauseTimeoutTimer();
      } else {
        logger.error(
          { transition, sessionId: checkpoint.sessionId },
          '检查点暂停态恢复失败，状态机与检查点分叉',
        );
      }
    }
    // running 状态由 resetToRunning() 承担

    // 切换到检查点记录的会话。await loadSessionMessages 消除 void 悬空的 unhandledRejection；
    // 单 Agent 单线程下期间无其他写入者，切换失败时降级继续（热记忆已由 restoreHistory 恢复）。
    const history = this.getHistory();
    // 使用统一正则解析 sessionId，与 switchToSession 保持一致（SSOT 单一真理源）
    const match = checkpoint.sessionId.match(SessionManager.SESSION_ID_PATTERN);
    if (match && match[1] && match[2]) {
      const [, date, session] = match;
      try {
        await history.loadSessionMessages(date, session);
      } catch (err) {
        logger.warn(
          { err, sessionId: checkpoint.sessionId },
          '恢复检查点时切换会话失败（热记忆已恢复，继续运行）',
        );
      }
    }

    // 恢复时补偿降级：补偿管线已降为纯日志，仅记录非幂等工具执行事实供宿主/人工排查
    const nonIdempotentCount =
      this.checkpoint.completedToolCalls?.filter((r) => r.idempotent === 'non-idempotent').length ??
      0;
    if (nonIdempotentCount > 0) {
      logger.warn(
        { sessionId: checkpoint.sessionId, nonIdempotentCount },
        `恢复时发现 ${nonIdempotentCount} 个非幂等工具执行（补偿管线已降级，跳过自动补偿）`,
      );
    }

    logger.info(
      {
        sessionId: checkpoint.sessionId,
        messageCount: messages.length,
        truncatedCount: checkpoint.truncatedCount ?? 0,
      },
      '从检查点恢复会话',
    );

    return messages.length;
  }

  /**
   * 暂停会话（用户/Agent/系统均可触发）。暂停前自动创建检查点；高风险暂停计入连续计数（防滥用），低风险不计。
   * @param lowRisk 低风险暂停不计连续计数（默认 false）
   */
  pause(reason: string, source: PauseSource = 'user', lowRisk: boolean = false): boolean {
    const result = this.stateMachine.pause(reason, source);
    if (result.allowed) {
      // 先在 createCheckpoint 前记 pausedAt，检查点经 spread 继承，合并为单次落盘
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
        // 卸载 pauseMeta 状态层挂载物（仅含展示信息，恢复即"回到运行"应卸载，否则任务面板残留"继续"按钮）。
        // 走 setPauseMeta 唯一写入口而非内联赋值，避免绕过其兜底与落盘链路（其内部已含 touch+flush，此处不再重复调用）
        this.setPauseMeta(undefined);
      }
      // 连续暂停计数不在 resume() 重置，而在 Agent.processEvent clarify 完成后显式重置，
      // 避免用户回答前过早清零导致防滥用机制无效
      this.emitEvent('sessionResumed', {
        sessionId: this.checkpoint?.sessionId,
      });
      logger.info('会话已恢复');
    }
    return result.allowed;
  }

  /** 触发异常（仅 RUNNING 态）。异常时自动创建检查点；createCheckpoint 会从状态机投影 status/error 落盘，不再手工赋值避免并列真理源 */
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

  /** 清理过期暂停时间戳（时间衰减）：移除超过窗口（1 小时）的旧时间戳，仅保留窗口内暂停；每次查询计数时自动调用 */
  private pruneStalePauseTimestamps(): void {
    const cutoff = Date.now() - SessionManager.CONSECUTIVE_PAUSE_DECAY_MS;
    const before = this.consecutivePauseTimestamps.length;
    this.consecutivePauseTimestamps = this.consecutivePauseTimestamps.filter((ts) => ts > cutoff);
    const pruned = before - this.consecutivePauseTimestamps.length;
    if (pruned > 0) {
      logger.debug(
        { pruned, remaining: this.consecutivePauseTimestamps.length },
        '过期暂停时间戳已衰减',
      );
    }
  }

  /** 检查连续暂停是否已达上限（防滥用）：先衰减过期时间戳，再查窗口内暂停≥2 次则强制降级 P3。低风险不计数 */
  isPauseLimitReached(): boolean {
    this.pruneStalePauseTimestamps();
    return this.consecutivePauseTimestamps.length >= 2;
  }

  /** 获取当前连续暂停计数：先衰减过期时间戳，返回窗口内有效暂停数 */
  getConsecutivePauseCount(): number {
    this.pruneStalePauseTimestamps();
    return this.consecutivePauseTimestamps.length;
  }

  /** 重置连续暂停计数（防滥用）：用户 clarify 回答后调用。与 resume() 分离，由 Agent.processEvent 显式调用，防回答前过早清零致防滥用失效 */
  resetConsecutivePauseCount(): void {
    this.consecutivePauseTimestamps = [];
    logger.debug('连续暂停时间戳已清空');
  }

  /** 从异常恢复：标记 error.recovered=true 并经 stateMachine.recover 校验。恢复必须落盘——recovered 若只在内存，进程崩溃后磁盘仍是未恢复 error 快照，恢复链永久断裂 */
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
      // 恢复必须落盘（见方法注释：recovered 只活内存会让崩溃重启后恢复链断裂）
      this.flushCheckpoint();
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
    // composer 对"继续"事件每轮都喂相同 currentGoal，若无短路 goalChangeSeq 会退化为轮次计数器
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
    // 目标变更是会话的语义骨架，立即落盘
    this.flushCheckpoint();

    this.emitEvent('goalUpdated', {
      newGoal,
      goalChangeSeq: this.checkpoint.goalChangeSeq,
      sessionId: this.checkpoint.sessionId,
    });

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

  /** 全量替换计划步骤（与 appendPlanStep 仅追加正交；保留已有步骤 id/status）。唯一生产点：task_table_update mode='update' */
  updatePlan(plan: PlanStep[]): void {
    if (!this.checkpoint) return;
    this.checkpoint.plan = plan;
    this.touchCheckpoint();
  }

  /** 更新检查点资源状态 */
  updateResource(resource: ResourceState): void {
    if (!this.checkpoint) return;
    this.checkpoint.resource = resource;
    this.touchCheckpoint();
  }

  /** 更新检查点执行标准 */
  updateStandard(standard: Standard): void {
    if (!this.checkpoint) return;
    this.checkpoint.standard = standard;
    this.touchCheckpoint();
  }

  /** 更新检查点角色 */
  updateRole(role: Role): void {
    if (!this.checkpoint) return;
    this.checkpoint.role = role;
    this.touchCheckpoint();
  }

  // ── 执行计划管理：SSOT 写点 ──────────────────────────────

  /** 追加计划步骤：在 plan 末尾追加新步骤，不重排已有 order */
  appendPlanStep(description: string): number {
    if (!this.checkpoint) return 0;
    const newOrder = this.checkpoint.plan.length;
    const step: PlanStep = {
      id: crypto.randomUUID(),
      order: newOrder,
      description,
      status: 'pending',
    };
    this.checkpoint.plan.push(step);
    this.touchCheckpoint();
    return this.checkpoint.plan.length;
  }

  /**
   * 写入执行计划（计划写入口唯一分发点）。模式：'overwrite'|'append' 按追加逐条 appendPlanStep；
   * 'update' 全量替换现有 plan（保留已有 id/status 仅覆盖 description）；其它 mode 兜底 no-op。
   * 分发逻辑原嵌 Agent 闭包无法单测，归位本类后由 sessionCheckpointLifecycle.test.ts 覆盖。
   */
  writePlan(
    mode: 'overwrite' | 'append' | 'update',
    steps: Array<{ description: string }>,
  ): PlanStep[] {
    if (!this.checkpoint) return [];
    const existingPlan = this.checkpoint.plan;
    if (mode === 'overwrite' || mode === 'append') {
      for (const step of steps) {
        this.appendPlanStep(step.description);
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
            };
      });
      this.updatePlan(updatedPlan);
    }
    return this.checkpoint.plan;
  }

  /**
   * 更新计划步骤状态（plan 步骤状态的唯一写点）。必须经此写点置 checkpointDirty，
   * 否则状态变更可能永不落盘，计划变更与标脏在此原子完成。
   */
  updatePlanStepStatus(stepId: string, status: PlanStep['status']): boolean {
    const step = this.checkpoint?.plan.find((s) => s.id === stepId);
    if (!step) return false;
    step.status = status;
    this.touchCheckpoint();
    return true;
  }

  /** 完成一个回合（SSOT 唯一写点）：单函数内顺序写步骤状态 + roundLog + heartbeat 保证原子性 */
  completeRound(options: { stepId?: string; summary: string }): void {
    if (!this.checkpoint) return;

    // 标记步骤状态（经 updatePlanStepStatus 单一写点，避免旁路契约）
    const { stepId, summary } = options;
    if (stepId) {
      this.updatePlanStepStatus(stepId, 'done');
    }

    // 追加回合日志（FIFO 超 12 条移除最早）
    const outcome: RoundOutcome = {
      stepId,
      summary,
      completedAt: Date.now(),
    };
    if (!this.checkpoint.roundLog) {
      this.checkpoint.roundLog = [];
    }
    this.checkpoint.roundLog.push(outcome);
    if (this.checkpoint.roundLog.length > 12) {
      this.checkpoint.roundLog = this.checkpoint.roundLog.slice(-12);
    }

    // 心跳 + 落盘：回合边界即检查点语义边界，崩溃后可从该边界无损续跑
    this.touchCheckpoint();
    this.flushCheckpoint();
  }

  /** 卸载运行态挂载物：任务流结束/转 idle 时清空 plan/roundLog（SSOT 资源层 vs 状态层模型），回到"空闲=无挂载物"常态；与 updatePlan（运行态维护）正交 */
  clearPlan(): void {
    if (!this.checkpoint) return;
    this.checkpoint.plan = [];
    this.checkpoint.roundLog = undefined;
    this.touchCheckpoint();
    this.flushCheckpoint();
  }

  /** 设置暂停元数据；传 undefined 清除。写后必须落盘（清除也落盘，避免磁盘残留与内存分叉） */
  setPauseMeta(meta: PauseMeta | undefined): void {
    // 调用方保证检查点已存在：pauseMeta 总在 pause()（建检查点）之后写入（暂停收口统一写）
    if (!this.checkpoint) return;
    this.checkpoint.pauseMeta = meta;
    this.touchCheckpoint();
    this.flushCheckpoint();
  }

  /** 检查计划是否停滞：计划为空或全部步骤 done/blocked。停滞时增量默认分辨率降级为暂停澄清 */
  isPlanStalled(): boolean {
    if (!this.checkpoint) return true;
    const { plan } = this.checkpoint;
    if (plan.length === 0) return true;
    return plan.every((s) => s.status === 'done' || s.status === 'blocked');
  }

  /** 获取下一个 pending 步骤（只读不推进，供上下文注入） */
  getNextPendingStep(): PlanStep | null {
    if (!this.checkpoint) return null;
    return this.checkpoint.plan.find((s) => s.status === 'pending') ?? null;
  }

  /** 获取当前 active 步骤 */
  getActiveStep(): PlanStep | null {
    if (!this.checkpoint) return null;
    return this.checkpoint.plan.find((s) => s.status === 'active') ?? null;
  }

  // ── 工具执行日志（outbox 模式）；补偿管线已降级，以下仅保留日志 ──

  /**
   * 记录工具执行：追加到检查点日志（append-only）供恢复时 outbox 检查。
   * 落盘策略：仅标脏不即时落盘（completeRound 回合边界统一 flush、createCheckpoint 暂停/异常强制落盘）。
   * 回合中途崩溃最坏丢最近一条记录，outbox 视为"未执行"恢复后重跑，对幂等工具安全；IO 从每工具调用降为每回合。
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
    // 依赖 completeRound / createCheckpoint 在回合边界统一 flush
  }

  /** 检查工具是否已执行（outbox 模式）：以名称+参数签名作唯一标识，恢复时避免重复执行幂等工具 */
  hasToolExecuted(name: string, args: string): boolean {
    if (!this.checkpoint?.completedToolCalls) return false;
    return this.checkpoint.completedToolCalls.some(
      (r) => r.name === name && r.argsSignature === args,
    );
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
   * loadPersistedCheckpoint 与 checkPauseTimeout 共用。会话标识不符 YYYY-MM-DD-<会话名> 时 date/session 缺省但仍发射事件。
   */
  private markSessionTimedOut(sessionId: string, pauseDuration: number): void {
    const matched = SessionManager.SESSION_ID_PATTERN.exec(sessionId);
    const payload: Record<string, unknown> = { sessionId, pauseDuration };
    if (matched) {
      payload.date = matched[1]!;
      payload.session = matched[2]!;
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

    // 从存储层删除
    if (this.sessionStore?.deleteCheckpoint) {
      this.sessionStore.deleteCheckpoint(sessionId);
    }

    // 清除检查点 + 状态机回到 running；残留脏标记无对应内存态一并清除
    this.checkpoint = null;
    this.checkpointDirty = false;
    this.stateMachine.resetToRunning();

    // 暂停超时意味着会话断裂，重置连续暂停计数（递增→衰减→重置闭合）
    this.resetConsecutivePauseCount();

    // 记录超时会话 + 发射事件（唯一入口，与启动路径共用）
    this.markSessionTimedOut(sessionId, pauseDuration);

    // 超时后不再需要继续检测
    this.stopPauseTimeoutTimer();
  }

  /** 关闭时 flush 脏检查点落盘（Agent 关闭、destroy 前调用）：覆盖 logToolExecution 标脏后未到 completeRound 的关闭窗口，确保脏检查点不丢失 */
  flushOnShutdown(): void {
    this.flushCheckpoint(true);
  }

  /** 立即 flush 脏检查点落盘（D1-②，2026-08-26）：非只读工具完成后调用，持久化其 completedToolCalls
   *  幂等标记，使「工具重跑排重」在进程崩溃/重启后仍生效（逼近事件溯源），而非仅依赖闭环边界/关闭 */
  flushNow(): void {
    this.flushCheckpoint(true);
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

  /**
   * 从 AgentLoop 提取热记忆（按轮边界截断 + 内容截断），仅保留 user/assistant/tool 排除 system。
   * 关键设计：**按轮边界截断**，而非按消息条数截断——保证 assistant(tool_calls) 与后续 tool 消息同留，
   * 避免恢复上下文末尾出现孤立的 tool_calls 消息（OpenAI 协议下会导致 400 错误）。
   */
  private extractHotMemory(): { messages: ChatMessage[]; truncatedCount: number } {
    const loop = this.getLoop();
    const messages = loop.getMessages();

    // 排除 system prompt
    const hotMessages = messages.filter((m) => m.role !== 'system');
    const originalCount = hotMessages.length;

    // 按轮边界分组：每个 user 消息开启一个新轮次，直到下一个 user 消息或数组末尾
    // 每轮包含：user + assistant(+ tool_calls) + tool 结果 + assistant 回复
    const rounds: ChatMessage[][] = [];
    let currentRound: ChatMessage[] = [];
    for (const msg of hotMessages) {
      // user 消息开启新一轮（currentRound 非空时先保存当前轮）
      if (msg.role === 'user' && currentRound.length > 0) {
        rounds.push(currentRound);
        currentRound = [];
      }
      currentRound.push(msg);
    }
    // 保存最后一轮
    if (currentRound.length > 0) {
      rounds.push(currentRound);
    }

    // 保留最近 N 轮（HOT_MEMORY_MAX_ROUNDS），丢弃旧轮次
    const maxRounds = AGENT_CONSTANTS.HOT_MEMORY_MAX_ROUNDS;
    let keptRounds = rounds;
    if (rounds.length > maxRounds) {
      keptRounds = rounds.slice(-maxRounds);
    }

    // 展平为消息列表
    const truncatedMessages = keptRounds.flat();
    const truncatedCount = originalCount - truncatedMessages.length;

    // 内容截断：单条消息超阈值时截断并追加标记
    const contentSlice = AGENT_CONSTANTS.HOT_MEMORY_CONTENT_SLICE;
    const result = truncatedMessages.map((m) => ({
      role: m.role as ChatMessage['role'],
      content:
        m.content.length > contentSlice
          ? m.content.slice(0, contentSlice) + '\n\n[内容已截断]'
          : m.content,
      // 透传 name 字段（LLM Message 可能携带，如 function 调用结果标识）
      name: m.name,
      toolCalls: m.toolCalls?.map((tc) => ({
        id: tc.id,
        type: tc.type,
        function: { name: tc.function.name, arguments: tc.function.arguments },
      })),
      toolCallId: m.toolCallId,
    }));

    return { messages: result, truncatedCount };
  }
}
