/**
 * 会话管理器
 *
 * 从 Agent 类中提取会话管理职责（ADR-010 §Agent 类拆分）。
 * 负责会话切换、分叉、恢复和消息加载，通过回调函数访问 Agent 的当前组件状态，
 * 避免与 Agent 的 history/loop 引用生命周期耦合。
 *
 * Agent 通过组合方式持有 SessionManager 实例，将会话相关操作委托给它。
 *
 * 不中断工作模型 v2.0（P4）：
 *   新增检查点模型——会话状态可序列化为 SessionCheckpoint，
 *   支持暂停后断点续跑。状态机（SessionStateMachine）管理三态流转。
 */

import { logger } from '@/logging/logger.js';
import { chatBusyError, configError } from '@/utils/errors.js';
// 使用 todayDate() 替代 new Date().toISOString().slice(0,10)，修复 UTC 跨天 bug
import { todayDate } from '@/utils/time.js';
import type { AgentLoop } from '@/agent/loop.js';
import type { MessageHistory } from '@/agent/messageHistory.js';
import type { SessionMessage } from '@/memory/sessionStore.js';
import type { ISessionStore, SessionMeta } from '@/memory/sessionStore.js';
import type { Message } from '@/llm/provider.js';
import { AGENT_CONSTANTS } from '@/agent/constants.js';
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
 * Agent.forkSession() 返回值类型
 *
 * 注意：与 MessageHistory.forkSession() 的内部返回类型 ForkResult 不同，
 * Agent 层做了简化封装，只暴露宿主需要的 newSession 和 messageCount。
 */
export interface AgentForkResult {
  /** 新分支会话名（不含日期前缀的简短名，可直接传给 switchSession()） */
  newSession: string;
  /** 分叉时复制的消息数量 */
  messageCount: number;
}

/**
 * 会话管理器
 *
 * 通过回调函数访问 Agent 的当前组件状态，支持 Agent 重建组件后自动获取最新引用。
 */
export class SessionManager {
  /** 获取当前 MessageHistory 实例的回调 */
  private getHistory: () => MessageHistory;
  /** 获取当前 AgentLoop 实例的回调 */
  private getLoop: () => AgentLoop;
  /** 会话存储（可选，由宿主注入） */
  private sessionStore: ISessionStore | undefined;
  /** 检查对话是否繁忙的回调 */
  private isChatBusy: () => boolean;
  /** 发射事件（委托给 Agent 的 TypedEventEmitter） */
  private emitEvent: (event: string, data: Record<string, unknown>) => void;

  // ─── 不中断工作模型 v2.0（P4） ──────────────────────────
  /** 会话状态机（三态流转，private 封装，通过有界代理方法访问） */
  private stateMachine: SessionStateMachine;
  /** 当前会话检查点（运行时状态快照） */
  private checkpoint: SessionCheckpoint | null = null;
  /**
   * 检查点脏标记（T0-2：落盘收口）
   *
   * 内存态与磁盘态存在差异时为 true。由 touchCheckpoint() 置位，
   * flushCheckpoint() 成功写盘后清除。
   */
  private checkpointDirty = false;
  /** 目标一致性校验器（P3.1 目标版本一致性校验） */
  private readonly consistencyChecker: GoalConsistencyChecker;
  /**
   * 连续暂停时间戳数组（P2-1：时间衰减机制）（T14 语义定案，2026-08-09）
   *
   * 每次高风险暂停时记录当前时间戳，超过衰减窗口（1 小时）的旧时间戳自动过期。
   * 代替旧的简单计数，防止早期暂停长时间锁死防滥用机制。
   * 连续 2 次（窗口内）后强制降级 P3，不再生成 P4 问题。
   * 低风险决策（lowRisk=true）不记录时间戳。
   *
   * ⚠ 进程内状态，**不入 SessionCheckpoint**——重启归零是设计而非缺陷：
   * 计数器是"反滥用卫生状态"，不是执行状态；威胁模型是本机用户自残，
   * 重启绕过无实际危害；1h 窗口衰减已是自愈式防线。勿为其引入持久化。
   */
  private consecutivePauseTimestamps: number[] = [];

  /** 连续暂停时间衰减窗口（毫秒）。1 小时前的暂停不计入连续计数。 */
  private static readonly CONSECUTIVE_PAUSE_DECAY_MS = 3_600_000;

  /**
   * 会话标识解析模式：`YYYY-MM-DD-<会话名>`
   *
   * 会话标识由 MessageHistory.currentSessionName 以 `${date}-${session}` 构造，
   * 日期段定长，故日期锚定的正则可无歧义还原二元组——
   * 即便会话名自身含连字符（如分叉分支 `main-fork-1`）也不会误切。
   */
  private static readonly SESSION_ID_PATTERN = /^(\d{4}-\d{2}-\d{2})-(.+)$/;

  // ── P0-2：运行时暂停超时检测 ──────────────────────────

  /** 暂停超时检测定时器（只在 paused 状态时运行） */
  private _pauseTimeoutTimer: ReturnType<typeof setInterval> | null = null;

  /** 暂停超时检测间隔（毫秒）。30 秒检查一次心跳。 */
  private static readonly PAUSE_TIMEOUT_CHECK_INTERVAL = 30_000;

  // ── schemaVersion 迁移分发表（骨架，当前为空表）──
  //
  // 注册迁移函数：key = 源版本号，value = 将 Partial<SessionCheckpoint> 从该版本迁移到下一版本。
  // 新增字段不升版本；重命名/删除/改类型必须升 CURRENT_SCHEMA_VERSION 并在此注册迁移。
  private static readonly checkpointMigrations = new Map<number, (cp: Partial<SessionCheckpoint>) => void>();

  constructor(
    getHistory: () => MessageHistory,
    getLoop: () => AgentLoop,
    sessionStore: ISessionStore | undefined,
    isChatBusy: () => boolean,
    emitEvent: (event: string, data: Record<string, unknown>) => void,
  ) {
    this.getHistory = getHistory;
    this.getLoop = getLoop;
    this.sessionStore = sessionStore;
    this.isChatBusy = isChatBusy;
    this.emitEvent = emitEvent;
    this.stateMachine = new SessionStateMachine('running');
    this.consistencyChecker = new GoalConsistencyChecker();
  }

  // ─── SSOT 状态机代理（P0-2：封装 stateMachine，暴露有界接口） ───

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
   *
   * 任何替换 loop 工作记忆（switch / fork / restore）的入口都必须经此，
   * 新增派生缓存只需在此注册一处，避免「对称的另一半没写完」
   * （SSOT-R4-T9 修了 restoreHistory 却漏了 switchSession，导致跨会话陈旧摘要）。
   * 当前唯一派生缓存是 ContextManager 的上下文摘要。
   */
  private invalidateSessionDerivedState(): void {
    // 可选调用：真实 loop 必有 resetContextSummary；测试 mock 可能未实现该协作方法，缺失时 no-op。
    this.getLoop()?.resetContextSummary?.();
  }

  /**
   * 切换当前会话
   *
   * 与 forkSession() 对齐：底层 MessageHistory.switchSession 是纯同步操作（字段赋值），
   * Agent 层不引入无意义的 async 包装。返回新会话名。
   */
  switchSession(newSession: string): string {
    // 对话进行中切换会话会导致消息持久化分散
    if (this.isChatBusy()) {
      throw chatBusyError('切换会话');
    }

    // 暂停/错误态切换会话语义未定义，保守拒绝（与 fork/restore 的繁忙守卫同构）
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
    // 会话已替换：作废上下文摘要等派生缓存，避免陈旧摘要注入新会话（SSOT-R4-T9 对称补全）
    this.invalidateSessionDerivedState();
    return result;
  }

  /**
   * 获取当前会话的日期和会话名
   *
   * 供宿主在 switchSession 前获取当前会话标识，用于触发 content 类归档。
   * 返回 null 表示 history 未初始化。
   */
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

  /**
   * 读取会话标题元数据（ADR-024 会话标题层）
   *
   * 供宿主历史列表展示会话标题。容器查询需按 updatedAt 排序可调用 listSessionMetas。
   * 宿主未注入 getSessionMeta 时返回 undefined，标题层静默失效。
   *
   * @param sessionId 会话标识（格式：YYYY-MM-DD-sessionName）
   */
  getSessionMeta(sessionId: string): SessionMeta | undefined {
    return this.sessionStore?.getSessionMeta?.(sessionId);
  }

  /**
   * 手动改名会话标题（ADR-024 会话标题层）
   *
   * 用户在历史列表的手动改名透传到存储层。标题是展示元数据，不参与会话身份。
   * 宿主未注入 setSessionTitle 时静默 no-op。
   *
   * @param sessionId 会话标识（格式：YYYY-MM-DD-sessionName）
   * @param title 用户输入的新标题
   */
  renameSession(sessionId: string, title: string): void {
    this.sessionStore?.setSessionTitle?.(sessionId, title);
  }

  /**
   * 分叉当前会话：复制完整消息历史到新分支，切换到新分支继续对话
   *
   * 分叉后：
   * - 原会话完整保留，可随时通过 switchSession() 切回（用原会话简短名）
   * - 新分支拥有独立的消息历史，后续对话互不干扰
   * - 记忆索引（IMemoryStorage）全局共享，不受分叉影响
   *
   * **注意**：fork 不隔离记忆。分支 A 中沉淀的 round-summary 会在分支 B
   * 的召回中出现，反之亦然。如需要完全独立的记忆空间（如多用户场景），
   * 应创建独立 Agent 实例 + 独立 dataDir，而非 fork。
   *
   * @param targetSession - 自定义新分支名（可选，不传则自动生成）
   * @returns { newSession, messageCount }
   */
  forkSession(targetSession?: string): AgentForkResult {
    if (this.isChatBusy()) {
      throw chatBusyError('分叉');
    }

    const history = this.getHistory();

    // 记录源会话名（用于事件，含日期前缀的完整名）
    const sourceSessionName = history.currentSessionName;

    // 委托 MessageHistory 完成分叉
    const result = history.forkSession(targetSession);

    // 将消息恢复到 AgentLoop 的工作记忆
    this.applySessionToLoop(result.messages);

    // 发射事件（供 UI 响应）
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

  /**
   * 恢复最近的会话对话
   *
   * 通过 ISessionStore 加载最近的会话消息，恢复到 AgentLoop 工作记忆。
   * 宿主项目需注入 ISessionStore 实现，否则返回 0。
   */
  async restoreMostRecentSession(preferredSession = 'main'): Promise<number> {
    // 对话进行中恢复会话会导致 loop 工作记忆被替换
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

    // 优先匹配 preferredSession，否则取最后一个
    // 使用 todayDate()（本地时区），避免 UTC 跨天将会话写入"昨天"
    const today = todayDate();
    const preferred =
      sessions.find((s) => s === `${today}-${preferredSession}`) ?? sessions[sessions.length - 1];

    // 解析 "YYYY-MM-DD-session" 格式
    const match = (preferred ?? '').match(/^(\d{4}-\d{2}-\d{2})-(.+)$/);
    if (!match) {
      logger.debug({ session: preferred }, '会话标识格式不匹配');
      return 0;
    }

    const [, date, session] = match;
    // match 已经保证 date 和 session 存在（正则匹配两个捕获组），但 TypeScript 类型收窄有限
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

  /**
   * 恢复指定会话的对话
   */
  async restoreSession(date: string, session: string): Promise<number> {
    // 对话进行中恢复会话会导致 loop 工作记忆被替换
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

  /**
   * 对外暴露的 loadSessionMessages 委托
   *
   * **注意：此方法会切换当前会话**（更新 currentDate/currentSession）。
   * 加载后，下一次 chat() 的消息会写入被加载的会话。
   */
  async loadSessionMessages(date: string, session: string): Promise<SessionMessage[]> {
    // 对话进行中加载会话会切换 currentDate/currentSession，导致消息持久化分散
    if (this.isChatBusy()) {
      throw chatBusyError('加载会话');
    }

    return this.getHistory().loadSessionMessages(date, session);
  }

  /**
   * 将会话消息恢复到 AgentLoop 工作记忆
   */
  private applySessionToLoop(
    sessionMessages: ReadonlyArray<{ role: string; content: string }>,
  ): void {
    const messages: Message[] = sessionMessages.map((tm) => ({
      role: tm.role as Message['role'],
      content: tm.content,
    }));
    this.getLoop().restoreHistory(messages);
    // 消息集合被整体替换：作废派生缓存（与 switchSession 共用同一 chokepoint）
    this.invalidateSessionDerivedState();
  }

  // ─── 不中断工作模型 v2.0：检查点 + 状态机（P4） ──────────

  /**
   * 检查点必需字段的默认值工厂（T0-1：默认值单一真理源）
   *
   * 检查点的必需字段有两条产生路径——`createCheckpoint()` 新建/合并，
   * `normalizeCheckpoint()` 反序列化补齐。二者若各写一套字面量默认值，
   * 就构成一对必然漂移的并列副本：给 `Role` 增加必需字段时只改一处，
   * 另一处会静默产出结构残缺的对象。此工厂是二者共同的真理源。
   *
   * **必须返回新实例**：数组与对象默认值若共享同一常量引用，
   * 不同检查点会互相污染（一个会话 push 计划步骤，另一个凭空多出步骤）。
   *
   * 新增检查点必需字段时，同步更新此处与 `validateCheckpointIntegrity`
   * 的 REQUIRED_FIELDS 列表。
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

  /**
   * 从当前运行时状态创建检查点
   *
   * 快照当前 AgentLoop 的消息历史、会话标识等运行时状态，
   * 生成可序列化的 SessionCheckpoint。同时持久化到存储层。
   *
   * @param mainGoal - 原始目标（首次创建时必填，后续调用可选）
   * @param role - 当前角色
   * @param standard - 当前执行标准
   * @returns 当前会话检查点
   */
  createCheckpoint(
    mainGoal?: string,
    role?: Role,
    standard?: Standard,
  ): SessionCheckpoint {
    const history = this.getHistory();

    // 从 AgentLoop 获取热记忆（最近消息，P2.2 支持 FIFO 截断 + 内容截断）
    const { messages: hotMemory, truncatedCount } = this.extractHotMemory();

    const prev = this.checkpoint;
    const defaults = SessionManager.checkpointDefaults();

    // 合并语义（T0-1）：以已有检查点为基底展开，仅覆写本次快照需要重算的字段。
    //
    // 【禁止改回对象字面量整体重建】
    // 整体重建等价于「隐式字段白名单」——任何未被显式列出的字段都会在每次
    // pause 时被静默丢弃。历史上 roundLog / completedToolCalls / pauseMeta
    // 三个侧车字段正是因此在每次暂停时归零，导致：
    //   1. hasToolExecuted() 恒 false → 非幂等工具在恢复后重复执行
    //   2. completedToolCalls 丢失 → 恢复时无法检测已执行工具
    //   3. 宿主任务表回合历史归零
    // P1-1（2026-08-11）补偿管线已降级，compensateAllNonIdempotent 降为纯日志。
    // 新增检查点字段时无需修改此处，合并语义会自动保留。
    this.checkpoint = {
      ...(prev ?? {}),

      // ── 以下字段由本次快照重算，覆写基底 ──
      sessionId: history.currentSessionName,
      // 状态真理源是状态机，检查点只是其投影
      status: this.stateMachine.status,
      // error 同样以状态机为准：状态机无异常即代表已脱离异常态，清除旧记录
      error: this.stateMachine.errorInfo
        ? {
            cause: this.stateMachine.errorInfo,
            at: Date.now(),
            recovered: false,
          }
        : undefined,
      mainGoal: mainGoal ?? prev?.mainGoal ?? defaults.mainGoal,
      // 不传 mainGoal 时保留已有 currentGoal（防止 pause() 内调用时覆盖 updateGoal 的更新）
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
      // schemaVersion 必需字段（T1-4）：每次写检查点都标当前内核版本，供未来升级迁移
      schemaVersion: AGENT_CONSTANTS.CURRENT_SCHEMA_VERSION,
    };

    // 检查点内容已整体重算，强制落盘（P0-2：会话状态持久化）
    this.flushCheckpoint(true);

    return this.checkpoint;
  }

  /**
   * 标记检查点已变更（内存写点统一入口，T0-2）
   *
   * 刷新心跳并置脏标记。**所有修改 this.checkpoint 内容的方法都必须调用本方法**，
   * 不得再直接赋值 `lastHeartbeat`——否则该次变更不会被后续 flush 感知，
   * 内存态与磁盘态将静默分叉。
   */
  private touchCheckpoint(): void {
    if (!this.checkpoint) return;
    this.checkpoint.lastHeartbeat = Date.now(); // 心跳唯一写点
    this.checkpointDirty = true;
  }

  /**
   * 冲洗检查点到存储层（落盘唯一入口，T0-2）
   *
   * 将检查点序列化为 JSON 字符串，写入 ISessionStore。
   * 存储层不存在时静默跳过（降级为内存模式）。
   *
   * 写盘失败时**保留脏标记**，使下一个语义边界自动重试——
   * 单次 IO 抖动不会导致该次变更被永久丢弃。
   *
   * @param force - 为 true 时忽略脏标记强制落盘，用于检查点被整体替换的场景
   */
  private flushCheckpoint(force = false): void {
    if (!this.checkpoint) return;
    if (!force && !this.checkpointDirty) return;
    if (!this.sessionStore?.saveCheckpoint) {
      // 无存储层：降级为纯内存模式，清脏避免标记无意义累积
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

  /**
   * 加载持久化的检查点
   *
   * 从 ISessionStore 中加载最近会话的检查点，恢复到运行时状态。
   * 用于 Agent 重启后恢复暂停/异常中的会话。
   *
   * @returns 加载的检查点，不存在时返回 null
   */
  loadPersistedCheckpoint(): SessionCheckpoint | null {
    if (!this.sessionStore?.loadCheckpoint) return null;

    try {
      const history = this.getHistory();
      const sessionId = history.currentSessionName;

      const json = this.sessionStore.loadCheckpoint(sessionId);
      if (!json) return null;

      // 反序列化收口——解析 + 字段补齐 + 完整性告警统一由 parseCheckpoint 承担。
      // 原实现 `JSON.parse(json) as SessionCheckpoint` 的类型断言无运行时效力，
      // 残缺检查点会在下游访问时抛错并被本函数外层 catch 吞掉（静默丢整个会话）。
      const checkpoint = SessionManager.parseCheckpoint(json, sessionId);
      if (!checkpoint) {
        logger.warn({ sessionId }, '持久化检查点无法解析或不可修复，降级为内存模式');
        return null;
      }

      this.checkpoint = checkpoint;
      // 刚从磁盘读入，内存态与磁盘态一致
      this.checkpointDirty = false;

      // P0-3：暂停超时检测——超时会话自动清理检查点，不恢复暂停状态
      if (this.isPauseTimedOut(checkpoint)) {
        const pauseDuration = Date.now() - (checkpoint.pausedAt ?? checkpoint.lastHeartbeat);
        logger.warn(
          { sessionId, pauseDuration, status: checkpoint.status },
          '暂停超时，自动清理检查点（会话将继续，但不会恢复暂停状态）',
        );

        // 清理检查点：从存储层删除，防止下次 init 重复加载
        this.sessionStore.deleteCheckpoint?.(sessionId);

        // 重置运行时状态：不恢复暂停状态，状态机保持运行中
        this.checkpoint = null;
        this.checkpointDirty = false;

        // 清理后重置连续暂停计数——与 checkPauseTimeout 对称
        this.resetConsecutivePauseCount();

        // 记录超时会话 + 发射事件（唯一入口，与运行时路径共用）
        this.markSessionTimedOut(sessionId, pauseDuration);

        return null;
      }

      // 恢复状态机状态
      if (checkpoint.status === 'paused') {
        this.stateMachine.pause('从持久化检查点恢复', 'system');
        // 恢复路径补启暂停超时定时器。startPauseTimeoutTimer 的唯一调用点原在
        // pause()（:620），此处直接调 stateMachine.pause 绕过 → 恢复的 paused 会话在
        // 本次运行期内无超时检测（只能等下次重启）。resetToRunning 后 canPause 必然通过。
        // 已超时会话由 checkPauseTimeout 首次触发即清理，行为正确（本就不该恢复）。
        this.startPauseTimeoutTimer();
      } else if (checkpoint.status === 'error' && checkpoint.error) {
        this.stateMachine.triggerError(checkpoint.error.cause);
      }
      // running 状态不需要额外操作

      logger.info(
        { sessionId, status: checkpoint.status },
        '已从持久化存储加载会话检查点',
      );
      return checkpoint;
    } catch (err) {
      logger.warn({ err }, '加载持久化检查点失败（降级为内存模式）');
      return null;
    }
  }

  /**
   * 检查点完整性校验（F2.2）
   *
   * 校验检查点必需字段是否完整，缺失字段记录告警但不阻塞执行。
   * 前向兼容：未知字段静默通过，仅新增必需字段时更新此列表。
   *
   * 持久化检查点缺失字段可能源自：
   * - 旧版本创建的检查点（新增字段不存）
   * - 存储层写盘截断（部分字段丢失）
   * - 跨版本反序列化（字段名变更）
   *
   * @param checkpoint - 待校验的检查点
   * @returns 是否通过完整性校验（true=完整，false=有字段缺失）
   */
  private static validateCheckpointIntegrity(checkpoint: SessionCheckpoint): boolean {
    // 检查点必需字段列表（F2.2 真理源）
    // 新增必需字段时同步更新此列表，确保旧检查点升级时能感知缺失
    const REQUIRED_FIELDS: Array<keyof SessionCheckpoint> = [
      'sessionId',
      'status',
      'mainGoal',
      'currentGoal',
      'goalChangeSeq',
      'plan',
      'role',
      'standard',
      'resource',
      'hotMemory',
      'lastHeartbeat',
    ];

    const missingFields: string[] = [];

    for (const field of REQUIRED_FIELDS) {
      const value = checkpoint[field];
      if (value === undefined || value === null) {
        missingFields.push(field);
      }
    }

    // 可选字段类型校验：error 存在时必须有 cause/at/recovered
    if (checkpoint.error) {
      if (typeof checkpoint.error.cause !== 'string' || !checkpoint.error.cause) {
        missingFields.push('error.cause');
      }
      if (typeof checkpoint.error.at !== 'number') {
        missingFields.push('error.at');
      }
      if (typeof checkpoint.error.recovered !== 'boolean') {
        missingFields.push('error.recovered');
      }
    }

    if (missingFields.length > 0) {
      logger.warn(
        { sessionId: checkpoint.sessionId, missingFields },
        '检查点完整性校验失败：缺失必需字段（来自旧版本或存储截断，以默认值填充后继续）',
      );
      return false;
    }

    return true;
  }

  /**
   * 检查点归一化（T0-1：反序列化唯一收口）
   *
   * 【为什么必须存在】
   * 反序列化此前各写各的，同一份残缺数据因此有两种崩法，无一是「降级但可用」：
   *   - `loadPersistedCheckpoint`：`JSON.parse(json) as SessionCheckpoint` —— 类型断言
   *     不提供任何运行时保证，后续访问被外层 catch 吞掉，**用户整个会话静默消失**；
   *   - `restoreFromCheckpoint`：直接信任外部对象，`checkpoint.hotMemory.map()` 抛
   *     TypeError 且本函数无 catch，**崩进程**。
   * 更早的 `validateCheckpointIntegrity` 注释声称「以默认值填充后继续」，而实现只 warn
   * 不填充——注释即契约，未兑现的契约比没有契约更危险。本方法兑现它。
   *
   * 【为什么原地改写入参而非返回副本】
   * `restoreFromCheckpoint` 本就持有并改写同一引用（`this.checkpoint = checkpoint`、
   * error 缺失时改写 `status`）。返回副本会让「调用方手里的对象」与「管理器持有的对象」
   * 成为两份并列副本——正是本方法要消灭的病灶。
   *
   * 【校验与填充的顺序】
   * 先 `validateCheckpointIntegrity` 再填充：校验反映磁盘上的真实缺失（日志才有诊断价值），
   * 填充保证下游可无条件假设必需字段可用。反过来则永远校验通过，等于自欺。
   *
   * @param raw - 反序列化产物或外部传入的检查点（类型不可信）
   * @param fallbackSessionId - sessionId 缺失时的回填值（调用方已知会话时提供）
   * @returns 归一化后的检查点；结构不可修复时返回 null
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

    // 先诚实校验（日志反映磁盘真实状态），再填充
    SessionManager.validateCheckpointIntegrity(cp as SessionCheckpoint);

    const defaults = SessionManager.checkpointDefaults();

    // 类型级校验而非仅 `??=`：存储截断/篡改会产生类型错误的值
    // （`hotMemory` 为字符串时 `.map` 不存在），只判 null/undefined 拦不住。
    if (cp.status !== 'running' && cp.status !== 'paused' && cp.status !== 'error') {
      cp.status = 'running';
    }

    // ── schemaVersion 补齐与跨版本迁移（T4）──
    // 旧内核产出的检查点无 schemaVersion 字段 → 视其为当前版本，不阻断恢复
    // （用户工作优先于严格版本校验）。来自更新版本客户端的检查点当前内核无法
    // 完整理解，首版仅记录警告、不阻断；真正的版本化迁移逻辑见 SessionManager.checkpointMigrations（当前为空表，迁移挂载点已就绪，注册即生效）。
    if (typeof cp.schemaVersion !== 'number' || !Number.isFinite(cp.schemaVersion)) {
      cp.schemaVersion = AGENT_CONSTANTS.CURRENT_SCHEMA_VERSION;
    } else if (cp.schemaVersion > AGENT_CONSTANTS.CURRENT_SCHEMA_VERSION) {
      logger.warn(
        { checkpointVersion: cp.schemaVersion, currentVersion: AGENT_CONSTANTS.CURRENT_SCHEMA_VERSION },
        '检查点 schemaVersion 高于当前内核版本，尝试按当前版本恢复（可能丢失新版字段语义）',
      );
    } else if (cp.schemaVersion < AGENT_CONSTANTS.CURRENT_SCHEMA_VERSION) {
      // 应用已注册的迁移（按版本号升序逐一执行）
      let v = cp.schemaVersion;
      while (v < AGENT_CONSTANTS.CURRENT_SCHEMA_VERSION) {
        const migrate = SessionManager.checkpointMigrations.get(v);
        if (migrate) {
          migrate(cp);
        }
        v++;
      }
      cp.schemaVersion = AGENT_CONSTANTS.CURRENT_SCHEMA_VERSION;
    }

    if (typeof cp.mainGoal !== 'string') cp.mainGoal = defaults.mainGoal;
    // currentGoal 缺失时继承 mainGoal，与 createCheckpoint 的 `?? prev?.mainGoal` 同语义
    if (typeof cp.currentGoal !== 'string') cp.currentGoal = cp.mainGoal;
    if (typeof cp.goalChangeSeq !== 'number' || !Number.isFinite(cp.goalChangeSeq)) {
      cp.goalChangeSeq = defaults.goalChangeSeq;
    }
    if (typeof cp.lastHeartbeat !== 'number' || !Number.isFinite(cp.lastHeartbeat)) {
      // 用当前时刻而非 0：0 会被 isPauseTimedOut 判为超时 55 年，恢复即被清理
      cp.lastHeartbeat = Date.now();
    }
    // 暂停起点损坏时丢弃，回退到 lastHeartbeat，避免 NaN 比较导致永不超时
    if (cp.pausedAt !== undefined && (typeof cp.pausedAt !== 'number' || !Number.isFinite(cp.pausedAt))) {
      delete cp.pausedAt;
    }
    if (!Array.isArray(cp.plan)) cp.plan = defaults.plan;
    if (!Array.isArray(cp.hotMemory)) cp.hotMemory = defaults.hotMemory;
    if (typeof cp.role !== 'object' || cp.role === null) cp.role = defaults.role;
    if (typeof cp.standard !== 'object' || cp.standard === null) cp.standard = defaults.standard;
    if (typeof cp.resource !== 'object' || cp.resource === null) cp.resource = defaults.resource;

    // error 侧车：结构不可用时整体清除，交由 restoreFromCheckpoint 的 T8 降级分支
    // 显式记录「error 态无法重建」；部分缺失则补齐，保住「曾出错」这一事实。
    if (cp.error !== undefined) {
      if (typeof cp.error !== 'object' || cp.error === null) {
        cp.error = undefined;
      } else {
        const err = cp.error as Partial<NonNullable<SessionCheckpoint['error']>>;
        if (typeof err.cause !== 'string' || !err.cause) {
          err.cause = '未知异常（检查点缺少 error.cause）';
        }
        if (typeof err.at !== 'number' || !Number.isFinite(err.at)) err.at = Date.now();
        if (typeof err.recovered !== 'boolean') err.recovered = false;
      }
    }

    return cp as SessionCheckpoint;
  }

  /**
   * 检查点反序列化（T0-1：JSON 入口唯一收口）
   *
   * `JSON.parse` 的失败与「内容残缺」是两类不同故障，此前都被同一个外层 catch
   * 吞成「加载失败」。此处显式区分：解析失败 → 内容损坏，按无检查点处理；
   * 解析成功 → 交 `normalizeCheckpoint` 补齐后可用。
   *
   * @param json - 存储层读出的原始字符串
   * @param fallbackSessionId - sessionId 缺失时的回填值
   * @returns 归一化后的检查点；损坏或不可修复时返回 null
   */
  private static parseCheckpoint(
    json: string,
    fallbackSessionId?: string,
  ): SessionCheckpoint | null {
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch (err) {
      logger.warn(
        { err, fallbackSessionId },
        '检查点 JSON 解析失败（内容损坏，按无检查点处理）',
      );
      return null;
    }
    return SessionManager.normalizeCheckpoint(raw, fallbackSessionId);
  }

  /**
   * 获取当前检查点
   *
   * 返回当前运行时检查点快照，若未创建则返回 null。
   */
  getCheckpoint(): SessionCheckpoint | null {
    return this.checkpoint;
  }

  /**
   * 从检查点恢复会话
   *
   * 将检查点中的热记忆恢复到 AgentLoop 工作记忆，
   * 并恢复状态机到检查点记录的状态。
   * 异步：内部 await loadSessionMessages 切换会话。
   *
   * F2.1 修复：消除 void 悬空。原实现同步返回，loadSessionMessages 异步调用
   * 悬空未 await，rejection 无人处理（unhandledRejection）。改为 async 后
   * 调用方 await 等待会话切换完成，消除竞态窗口。
   *
   * @param checkpoint - 要恢复的检查点
   * @returns 恢复的消息数量
   */
  async restoreFromCheckpoint(checkpoint: SessionCheckpoint): Promise<number> {
    // 与 loadPersistedCheckpoint 共用同一归一化入口。原实现只 warn 不填充，
    // 下方 `checkpoint.hotMemory.map()` 遇到缺字段的检查点会抛 TypeError；本函数无
    // catch → 崩进程。归一化原地补齐后，下游可无条件假设必需字段可用。
    if (!SessionManager.normalizeCheckpoint(checkpoint)) {
      // 可选链非冗余：类型标注为非空，但外部（宿主 IPC / 旧版持久化）可能传入 null
      logger.error(
        { sessionId: checkpoint?.sessionId },
        '检查点结构不可修复，恢复中止（会话保持当前状态，不做部分恢复）',
      );
      return 0;
    }

    this.checkpoint = checkpoint;
    // 检查点由外部整体注入，视为与来源一致；后续变更由 touchCheckpoint 标脏
    this.checkpointDirty = false;

    // 恢复热记忆到 AgentLoop
    const messages: Message[] = checkpoint.hotMemory.map((cm) => ({
      role: cm.role,
      content: cm.content,
      // P2-2：恢复 name 字段（LLM 上下文一致性）
      name: cm.name,
      toolCalls: cm.toolCalls,
      toolCallId: cm.toolCallId,
    }));
    this.getLoop().restoreHistory(messages);
    // 恢复路径同样替换了消息集合：作废派生缓存（与 switch/fork 共用同一 chokepoint）
    this.invalidateSessionDerivedState();

    // 注入截断一致性标记（P2.2：LLM 感知截断边界）
    // 当检查点记录的热记忆被截断时，注入系统消息告知 LLM 有早期消息被截断，
    // 避免 LLM 因上下文缺失而产生困惑，同时提示可触发温记忆召回获取更多上下文。
    if (checkpoint.truncatedCount && checkpoint.truncatedCount > 0) {
      this.getLoop().injectSystemMessage(
        `[热记忆截断提示] 本次恢复的会话有 ${checkpoint.truncatedCount} 条早期消息已被截断。这些消息已不在当前上下文中，但相关信息已归档到温记忆中，可通过温记忆召回获取。`,
      );
    }

    // 恢复状态机：先强制归零，再按检查点重建。
    // 原实现直接调 triggerError/pause，二者均仅允许从 running 出发
    // （SessionStateMachine.triggerError 校验 from==='running'、canPause 同理），
    // 跨会话恢复时若状态机残留 paused/error 将静默失败（返回值未被检查）
    // → 磁盘检查点 status 与内存状态机分叉。
    this.stateMachine.resetToRunning();
    if (checkpoint.status === 'error') {
      if (checkpoint.error) {
        const transition = this.stateMachine.triggerError(checkpoint.error.cause);
        if (!transition.allowed) {
          logger.error({ transition, sessionId: checkpoint.sessionId }, '检查点错误态恢复失败，状态机与检查点分叉');
        }
      } else {
        // error 字段缺失（旧版检查点 / 序列化丢字段）——无法重建 error 态。
        // 旧实现复合条件 `status==='error' && error` 两分支都不进 → resetToRunning 后
        // 状态机 running 而 checkpoint.status 保持 'error' → 永久分叉且无任何日志。
        // 此处强制检查点状态跟随实际归零结果，并把"降级"显式记入日志。
        checkpoint.status = this.stateMachine.status;
        logger.warn(
          { sessionId: checkpoint.sessionId },
          '检查点 error 态缺少 error 字段，无法重建异常状态，已降级为 running',
        );
      }
    } else if (checkpoint.status === 'paused') {
      const transition = this.stateMachine.pause('从检查点恢复', 'system');
      if (transition.allowed) {
        // 恢复路径补启暂停超时定时器（与 loadPersistedCheckpoint 对称）。
        // 原唯一调用点在 pause()（:620），此处直接调 stateMachine.pause 绕过 →
        // 恢复的 paused 会话本次运行期无超时检测。
        this.startPauseTimeoutTimer();
      } else {
        logger.error({ transition, sessionId: checkpoint.sessionId }, '检查点暂停态恢复失败，状态机与检查点分叉');
      }
    }
    // running 状态由 resetToRunning() 承担，无需额外操作

    // 切换到检查点记录的会话
    const history = this.getHistory();
    const sessionParts = checkpoint.sessionId.split('-');
    if (sessionParts.length >= 4) {
      const date = sessionParts.slice(0, 3).join('-');
      const session = sessionParts.slice(3).join('-');
      // F2.1 修复：await loadSessionMessages 完成，消除 void 悬空。
      // 原实现 sync 返回 → void 调用 → unhandledRejection 风险。
      // 竞态窗口分析：会话切换在微任务队列中异步完成，restore 后到下一次 append 之间
      // 无其他写入者（单 Agent 单线程），「最后写入者胜」语义下窗口极窄且无害。
      // 切换失败时记录日志并降级（热记忆已由 restoreHistory 恢复，继续运行）。
      try {
        await history.loadSessionMessages(date, session);
      } catch (err) {
        logger.warn({ err, sessionId: checkpoint.sessionId }, '恢复检查点时切换会话失败（热记忆已恢复，继续运行）');
      }
    }

    // P1-1：恢复时补偿降级（2026-08-11）
    // 补偿管线已降级为纯日志记录，不再逐副作用执行补偿操作。
    // 仅记录非幂等工具执行事实，供宿主或人工排查。
    const nonIdempotentCount = this.checkpoint.completedToolCalls?.filter(
      (r) => r.idempotent === 'non-idempotent',
    ).length ?? 0;
    if (nonIdempotentCount > 0) {
      logger.warn(
        { sessionId: checkpoint.sessionId, nonIdempotentCount },
        `恢复时发现 ${nonIdempotentCount} 个非幂等工具执行（补偿管线已降级，跳过自动补偿）`,
      );
    }

    logger.info(
      { sessionId: checkpoint.sessionId, messageCount: messages.length, truncatedCount: checkpoint.truncatedCount ?? 0 },
      '从检查点恢复会话',
    );

    return messages.length;
  }

  /**
   * 暂停会话
   *
   * 双向暂停：用户/Agent/系统均可触发。
   * 暂停前自动创建检查点保存当前状态。
   * 高风险暂停计入连续暂停计数（P4 防滥用），低风险不计数。
   *
   * @param reason - 暂停原因
   * @param source - 暂停来源
   * @param lowRisk - 是否低风险暂停（不计入连续暂停计数，默认 false）
   * @returns 是否暂停成功
   */
  pause(reason: string, source: PauseSource = 'user', lowRisk: boolean = false): boolean {
    const result = this.stateMachine.pause(reason, source);
    if (result.allowed) {
      // 记录暂停起点，与 lastHeartbeat 解耦。在 createCheckpoint 前写入，
      // 检查点通过 spread 继承 pausedAt，合并为单次落盘（P2-2）。
      if (this.checkpoint) {
        this.checkpoint.pausedAt = Date.now();
      }
      // 暂停前保存检查点（含 pausedAt，createCheckpoint 内部已落盘）
      this.createCheckpoint();
      // 首轮暂停时无现有检查点，pausedAt 未被 spread 继承，补设并标记脏
      if (this.checkpoint && !this.checkpoint.pausedAt) {
        this.checkpoint.pausedAt = Date.now();
        this.touchCheckpoint();
      }
      // 仅高风险暂停记录时间戳（低风险由 Agent 自动兜底，不累积）
      if (!lowRisk) {
        this.consecutivePauseTimestamps.push(Date.now());
        logger.debug(
          { consecutivePauseCount: this.consecutivePauseTimestamps.length, reason },
          '高风险暂停已记录时间戳',
        );
      } else {
        logger.debug({ reason }, '低风险暂停不记录时间戳（Agent 自动兜底）');
      }
      // P0-2：启动暂停超时检测定时器，防止暂停会话长时间占用资源
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

  /**
   * 恢复会话
   *
   * 从 PAUSED 状态恢复到 RUNNING。
   * 恢复前校验：无阻塞条件。
   *
   * @returns 是否恢复成功
   */
  resume(): boolean {
    // P0-3：暂停超时阻止恢复——超时会话需要重新开始，不能恢复
    if (this.checkpoint && this.isPauseTimedOut(this.checkpoint)) {
      logger.warn(
        { sessionId: this.checkpoint.sessionId },
        '暂停超时，无法恢复会话（请重新开始）',
      );
      this.emitEvent('sessionResumeBlocked', {
        sessionId: this.checkpoint.sessionId,
        reason: 'pause_timed_out',
      });
      return false;
    }

    const result = this.stateMachine.resume();
    if (result.allowed) {
      // P0-2：恢复时停止暂停超时检测定时器
      this.stopPauseTimeoutTimer();
      // 更新检查点心跳并持久化（P0-2：会话状态持久化）
      if (this.checkpoint) {
        // P2-1：从状态机投影 status，避免直接写死（SSOT 原则）
        this.checkpoint.status = this.stateMachine.status;
        // SSOT 挂载物卸载（用户设计定案 2026-08-10：资源层 vs 状态层）：
        // pauseMeta 属于状态层挂载物（仅含展示信息 reason/source），
        // 会话恢复（paused → running）即"回到运行"，挂载物应被卸载。
        // 若不清理，getWorkContext 会继续返回暂停态，任务面板残留「继续」按钮。
        // 超时检测依赖的是 checkpoint.pausedAt 独立字段，不受影响。
        //
        // SSOT-R1-T1（2026-08-10）：改走 setPauseMeta 唯一写入口，不再内联赋值。
        // 内联赋值会绕过 setPauseMeta 的首轮兜底与落盘链路，形成第二条卸载路径；
        // setPauseMeta 内部已含 touchCheckpoint + flushCheckpoint，故此处不再重复调用
        // （上方 checkpoint.status 的改动会随同一次 flush 落盘）。
        this.setPauseMeta(undefined);
      }
      // 注意：连续暂停计数不在 resume() 中重置，而是在 Agent.processEvent()
      // 的 clarify 事件处理完成后由 resetConsecutivePauseCount() 显式重置。
      // 避免用户回答前 resume() 过早清零导致防滥用机制无效（见 P4 防滥用死代码修复）。
      this.emitEvent('sessionResumed', {
        sessionId: this.checkpoint?.sessionId,
      });
      logger.info('会话已恢复');
    }
    return result.allowed;
  }

  /**
   * 触发异常
   *
   * 仅 RUNNING 状态可触发异常。
   * 异常时自动创建检查点保存当前状态。
   *
   * @param cause - 异常原因
   * @returns 是否触发成功
   */
  triggerError(cause: string): boolean {
    const result = this.stateMachine.triggerError(cause);
    if (result.allowed) {
      // 异常前保存检查点。
      // 状态机已在上一行置为 error 且记录 cause，createCheckpoint() 会从状态机
      // 投影出 status 与 error 字段并落盘——此处不再手工赋值，避免并列真理源。
      this.createCheckpoint();
      this.emitEvent('sessionError', {
        cause,
        sessionId: this.checkpoint?.sessionId,
      });
      logger.warn({ cause }, '会话异常');
    }
    return result.allowed;
  }

  // ── P4 防滥用：连续暂停计数 ─────────────────────────────

  /**
   * 清理过期暂停时间戳（P2-1：时间衰减）
   *
   * 移除超过衰减窗口（1 小时）的旧暂停时间戳，
   * 仅保留最近 CONSECUTIVE_PAUSE_DECAY_MS 内的暂停。
   * 在每次查询计数时自动调用，无需手动维护。
   */
  private pruneStalePauseTimestamps(): void {
    const cutoff = Date.now() - SessionManager.CONSECUTIVE_PAUSE_DECAY_MS;
    const before = this.consecutivePauseTimestamps.length;
    this.consecutivePauseTimestamps = this.consecutivePauseTimestamps.filter(
      (ts) => ts > cutoff,
    );
    const pruned = before - this.consecutivePauseTimestamps.length;
    if (pruned > 0) {
      logger.debug({ pruned, remaining: this.consecutivePauseTimestamps.length }, '过期暂停时间戳已衰减');
    }
  }

  /**
   * 检查连续暂停是否已达上限（P4 防滥用）
   *
   * 先衰减过期时间戳，再检查窗口内暂停是否 >= 2 次。
   * 连续 2 次高风险暂停后强制降级 P3，不再生成 P4 问题。
   * 低风险暂停（Agent 自动兜底）不计数。
   *
   * @returns 是否已达上限
   */
  isPauseLimitReached(): boolean {
    this.pruneStalePauseTimestamps();
    return this.consecutivePauseTimestamps.length >= 2;
  }

  /**
   * 获取当前连续暂停计数（P2-1：时间衰减）
   *
   * 先衰减过期时间戳，再返回窗口内有效暂停数。
   */
  getConsecutivePauseCount(): number {
    this.pruneStalePauseTimestamps();
    return this.consecutivePauseTimestamps.length;
  }

  /**
   * 重置连续暂停计数（P4 防滥用）
   *
   * 用户在 clarify 事件中回答澄清问题后调用，表明用户已配合完成澄清流程，
   * 连续暂停时间戳清空，下次 P4 暂停可正常触发。
   * 与 resume() 分离：不在 resume() 中自动重置，而是由 Agent.processEvent 的
   * clarify 处理路径显式调用，防止用户回答前过早清零导致防滥用机制无效。
   */
  resetConsecutivePauseCount(): void {
    this.consecutivePauseTimestamps = [];
    logger.debug('连续暂停时间戳已清空');
  }

  /**
   * 从异常恢复
   *
   * 校验恢复条件：error.recovered === true 且 cause 已解除。
   * 恢复前标记 checkpoint.error.recovered = true。
   *
   * @returns 是否恢复成功
   */
  recover(): boolean {
    if (!this.checkpoint || !this.checkpoint.error) {
      logger.warn('无法恢复：无检查点或异常信息');
      return false;
    }

    // 标记异常已恢复
    this.checkpoint.error.recovered = true;
    this.touchCheckpoint();

    const result = this.stateMachine.recover(this.checkpoint);
    if (result.allowed) {
      if (this.checkpoint) {
        // 从状态机投影 status，遵循 SSOT 原则
        this.checkpoint.status = this.stateMachine.status;
        this.touchCheckpoint();
      }
      // 恢复必须落盘。
      // stateMachine.recover() 的准入条件是 checkpoint.error.recovered === true，
      // 该标记若只活在内存，进程崩溃重启后磁盘仍是未恢复的 error 快照，
      // 恢复链将永久断裂——用户再也无法把会话救回 RUNNING。
      this.flushCheckpoint();
      this.emitEvent('sessionRecovered', {
        sessionId: this.checkpoint?.sessionId,
      });
      logger.info('会话已从异常恢复');
    }
    return result.allowed;
  }

  /**
   * 更新检查点目标版本
   *
   * 用户修正目标时调用，递增 goalChangeSeq 触发漂移检测。
   * 更新前自动执行一致性校验（P3.1），若检测到漂移则发射 goalDriftDetected 事件。
   *
   * 漂移处置由内核自兜底，不依赖宿主（SSOT 排雷：原注释承诺「宿主 UI 决定是否暂停」，
   * 但宿主生产代码对该事件零监听，属契约未兑现，故收窄为以下语义）：
   *   - drift 级：内核直接低风险暂停，强制用户确认
   *   - minor 级：仅发射事件 + 日志，不打断执行（轻微偏移不值得打扰用户）
   * goalDriftDetected 事件保留为可观测性出口，宿主可选订阅，不订阅不影响正确性。
   *
   * @param newGoal - 新目标描述
   * @returns 一致性校验结果（调用方可据此判断是否需要处理漂移）
   */
  updateGoal(newGoal: string): GoalConsistencyResult | null {
    if (!this.checkpoint) {
      this.createCheckpoint(newGoal);
      return null;
    }

    // 幂等短路（SSOT 排雷 T2-1）：目标值未变时直接返回，不递增 goalChangeSeq、不触发漂移检测。
    // P2 记忆延续（composer 对「继续」类事件直接引用 currentGoal）每轮都会把相同的
    // currentGoal 值喂入本方法——若无短路，goalChangeSeq 将退化为轮次计数器。
    // 返回值构造为 level='same'（值相同即无新漂移），调用方据此无需处理。
    if (newGoal === this.checkpoint.currentGoal) {
      return {
        level: 'same',
        similarity: 1,
        constraints: this.consistencyChecker.extractConstraints(this.checkpoint.mainGoal),
        constraintsConsistent: true,
      };
    }

    // P3.1：执行一致性校验，与 mainGoal 对比
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

    // P3.1：若检测到漂移，发射 goalDriftDetected 事件并自动暂停
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

      // P1-2：drift 级别自动暂停（强制用户确认），使用低风险暂停不计入连续计数
      if (consistencyResult.level === 'drift') {
        const pauseReason = `目标漂移：新目标与原始目标不一致（相似度 ${consistencyResult.similarity.toFixed(2)}）`;
        this.pause(pauseReason, 'system', true);
      }
    }

    return consistencyResult;
  }

  /**
   * 全量替换检查点计划步骤
   *
   * 与 appendPlanStep（仅追加）不同，updatePlan 做全量替换，保留已有步骤 ID 和状态。
   * 两者用途正交：appendPlanStep 用于追加新步骤，updatePlan 用于整体替换。
   * 唯一生产调用点：agent.ts task_table_update 工具 handler（mode === 'update'）。
   *
   * @param plan - 新的计划步骤列表
   */
  updatePlan(plan: PlanStep[]): void {
    if (!this.checkpoint) return;
    this.checkpoint.plan = plan;
    this.touchCheckpoint();
  }

  /**
   * 更新检查点资源状态
   *
   * @param resource - 新的资源状态
   */
  updateResource(resource: ResourceState): void {
    if (!this.checkpoint) return;
    this.checkpoint.resource = resource;
    this.touchCheckpoint();
  }

  /**
   * 更新检查点执行标准（P1 增量解析）
   *
   * 标准变更时更新检查点，并递增心跳标识状态活性。
   *
   * @param standard - 新的执行标准
   */
  updateStandard(standard: Standard): void {
    if (!this.checkpoint) return;
    this.checkpoint.standard = standard;
    this.touchCheckpoint();
  }

  /**
   * 更新检查点角色（P1 增量解析）
   *
   * 角色变更时更新检查点，并递增心跳标识状态活性。
   *
   * @param role - 新角色
   */
  updateRole(role: Role): void {
    if (!this.checkpoint) return;
    this.checkpoint.role = role;
    this.touchCheckpoint();
  }

  // ── P3.3：执行计划管理 ──────────────────────────────────

  // ── Phase 2: SSOT 写点 ──────────────────────────────────

  /**
   * 追加计划步骤（P2-3: Phase 2 唯一写点）
   *
   * 在 plan 末尾追加一个新步骤，不重排已有 order。
   * 替代旧的 updatePlan 直接赋值。
   *
   * @param description - 步骤描述
   * @returns 追加后的步骤总数
   */
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
   * 写入执行计划（P2-3: 计划写入口的唯一分发点）
   *
   * 模式语义（与 task_table_write / task_table_update 工具对齐）：
   * - 'overwrite' | 'append'：均按"追加"处理，逐条 appendPlanStep（不要求 plan 为空）
   * - 'update'：全量替换现有 plan，保留已有步骤 id / status，仅覆盖 description
   * - 其它 mode：无操作（调用方已约束为三选一，此处兜底 no-op 不抛错）
   *
   * 唯一生产调用点：agent.ts planManager.writePlan 闭包委托本方法。
   * 此前该分发逻辑嵌在 Agent 闭包内无法单测（历史审查 §9 盲区），
   * 归位到 SessionManager 后由 sessionCheckpointLifecycle.test.ts 直接覆盖。
   *
   * @param mode 写入模式
   * @param steps 待写入步骤（含 description）
   * @returns 写入后的完整计划数组
   */
  writePlan(mode: 'overwrite' | 'append' | 'update', steps: Array<{ description: string }>): PlanStep[] {
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
          : { id: crypto.randomUUID(), order: i, description: s.description, status: 'pending' as const };
      });
      this.updatePlan(updatedPlan);
    }
    return this.checkpoint.plan;
  }

  /**
   * 更新计划步骤状态（T3 SSOT 收口，2026-08-09）
   *
   * plan 步骤状态的**唯一写点**。此前由 Agent 工具 handler 直改
   * `step.status` + 手写 lastHeartbeat，绕过 touchCheckpoint → checkpointDirty
   * 未置位 → 计划状态变更可能永不落盘（flushCheckpoint 见脏才写）。
   * 收口到本方法：状态变更与标脏/心跳在 SessionManager 内原子完成。
   *
   * @param stepId 步骤 ID
   * @param status 新状态
   * @returns 是否更新成功（false = 步骤不存在）
   */
  updatePlanStepStatus(stepId: string, status: PlanStep['status']): boolean {
    const step = this.checkpoint?.plan.find((s) => s.id === stepId);
    if (!step) return false;
    step.status = status;
    this.touchCheckpoint();
    return true;
  }

  /**
   * 完成一个回合（P2-3: Phase 2 SSOT 唯一写点）
   *
   * 单函数内顺序写入 plan 步骤状态 + roundLog + heartbeat，
   * 保证原子性。替代旧的 completeStep + 单独 updatePlan 分散调用。
   *
   * @param options - 回合完成信息
   * @param options.stepId - 可选，本回合对应的计划步骤 ID
   * @param options.summary - 回合摘要
   */
  completeRound(options: {
    stepId?: string;
    summary: string;
  }): void {
    if (!this.checkpoint) return;

    // 1. 标记步骤状态（经 updatePlanStepStatus 单一写点，避免旁路契约；F2-3/T2-1）
    const { stepId, summary } = options;
    if (stepId) {
      this.updatePlanStepStatus(stepId, 'done');
    }

    // 2. 追加回合日志（FIFO cap）
    const outcome: RoundOutcome = {
      stepId,
      summary,
      completedAt: Date.now(),
    };
    if (!this.checkpoint.roundLog) {
      this.checkpoint.roundLog = [];
    }
    this.checkpoint.roundLog.push(outcome);
    // FIFO 截断：超过 12 条时移除最早的
    if (this.checkpoint.roundLog.length > 12) {
      this.checkpoint.roundLog = this.checkpoint.roundLog.slice(-12);
    }

    // 3. 心跳 + 落盘。回合边界是天然的检查点语义边界：
    // 此刻计划进度与回合日志均已定型，崩溃后可从此边界无损续跑。
    this.touchCheckpoint();
    this.flushCheckpoint();
  }

  /**
   * 卸载运行态挂载物：清空检查点计划与回合日志（SSOT 资源层 vs 状态层模型 2026-08-10）
   *
   * 任务流结束/停止/异常转入 idle 时调用，将运行期产生的 plan/roundLog 等
   * 状态层挂载物卸载，只沉淀会话历史与记忆等资源层内容，回到"空闲 = 无挂载物"常态。
   *
   * 与 updatePlan/appendPlanStep 正交：后者在运行态维护计划，本方法在
   * 运行→空闲切换时整体卸载。经 touchCheckpoint → flushCheckpoint 链路落盘，
   * 保证内存态与磁盘态一致（重启后不残留旧任务表）。
   */
  clearPlan(): void {
    if (!this.checkpoint) return;
    this.checkpoint.plan = [];
    this.checkpoint.roundLog = undefined;
    this.touchCheckpoint();
    this.flushCheckpoint();
  }

  /**
   * 设置暂停元数据（P2-3: Phase 2 暂停模型）
   *
   * @param meta - 暂停元数据，传 undefined 清除
   */
  setPauseMeta(meta: PauseMeta | undefined): void {
    // 首轮兜底（F4-3）：loop.onPaused 在 loop 迭代边界触发，早于 consumeExecutionStream
    // 内 this.pause() 翻状态机 + createCheckpoint。若此时尚无 checkpoint（首轮会话、宿主
    // 未预建），下方 `!this.checkpoint` 守卫会让 pauseMeta 静默丢弃 → 重启回落兜底文案。
    // 仅当「要写入 pauseMeta 且无 checkpoint」时补建，不破坏「清除时若无 checkpoint 直接 return」。
    if (!this.checkpoint && meta !== undefined) {
      this.createCheckpoint();
    }
    if (!this.checkpoint) return;
    this.checkpoint.pauseMeta = meta;
    this.touchCheckpoint();
    // 必须落盘：本方法由 loop.onPaused 在 pause() 之前触发（原注释称「之后」与真实时序相反，
    // 见 AgentLoop.handleIteration 的 pauseRequested 分支（onPaused 早于 yield paused chunk），
    // 而翻状态机在 consumeExecutionStream:1117），是 pauseMeta 进入检查点的唯一时机。
    // 若不落盘，磁盘快照将永远缺少暂停元数据，
    // 宿主重启后只能回落到兜底文案「已暂停（重启恢复）」。
    // P1-1: 传 undefined 时同样需要落盘，否则清除 pauseMeta 后
    // 磁盘检查点的 pauseMeta 字段残留，与内存态分叉。
    this.flushCheckpoint();
  }

  /**
   * 检查计划是否停滞
   *
   * 计划停滞条件：
   * - 计划为空
   * - 所有步骤已完成（done）或阻塞（blocked）
   *
   * 计划停滞时，增量默认分辨率降级为 P4 暂停澄清。
   *
   * @returns 是否停滞
   */
  isPlanStalled(): boolean {
    if (!this.checkpoint) return true;
    const { plan } = this.checkpoint;
    if (plan.length === 0) return true;
    return plan.every((s) => s.status === 'done' || s.status === 'blocked');
  }

  /**
   * 获取下一个未完成步骤（不推进）
   *
   * 只读查询，不修改状态。用于上下文注入时获取当前步骤描述。
   *
   * @returns 下一个 pending 步骤，或 null
   */
  getNextPendingStep(): PlanStep | null {
    if (!this.checkpoint) return null;
    return this.checkpoint.plan.find((s) => s.status === 'pending') ?? null;
  }

  /**
   * 获取当前活跃步骤
   *
   * @returns 当前 active 步骤，或 null
   */
  getActiveStep(): PlanStep | null {
    if (!this.checkpoint) return null;
    return this.checkpoint.plan.find((s) => s.status === 'active') ?? null;
  }

  // ── P3.3：工具执行日志（outbox 模式） ──────────────────
  // ── P1-1：补偿管线已降级（2026-08-11），以下仅保留日志 ──

  /**
   * 记录工具执行
   *
   * 将已执行的工具调用追加到检查点日志，用于恢复时 outbox 模式检查。
   * 日志为 append-only，不修改已有记录。
   *
   * 落盘策略（P3-1 批处理优化）：
   * 只标记脏标记，不再即时落盘。`completeRound()` 在回合边界统一 flush，
   * `createCheckpoint()` 在暂停/异常时强制落盘——两者构成了完整的持久化保障。
   * 回合中途崩溃的最坏情况是最近一次工具执行记录丢失，outbox 模式会将其视为
   * 「未执行」并在恢复后重新执行——对于幂等工具这是安全的。
   * 此权衡将 IO 次数从「每工具调用」降为「每回合」，大幅减少写盘频率。
   *
   * @param record - 工具执行记录
   */
  logToolExecution(record: ToolExecutionRecord): void {
    if (!this.checkpoint) return;
    if (!this.checkpoint.completedToolCalls) {
      this.checkpoint.completedToolCalls = [];
    }
    this.checkpoint.completedToolCalls.push(record);
    // FIFO 封顶——优先丢弃幂等工具的最早记录，非幂等永不丢弃（P1-1 补偿降级后不再检查 compensatedAt）
    // 注意：r.idempotent 是 IdempotencyLevel 字符串（'idempotent'/'idempotent-key'/'non-idempotent'），
    // 不能直接用 truthy 判断（'non-idempotent' 也是 truthy），必须显式排除 'non-idempotent'
    if (this.checkpoint.completedToolCalls.length > AGENT_CONSTANTS.COMPLETED_TOOL_CALLS_MAX) {
      const discardable = this.checkpoint.completedToolCalls.findIndex(
        (r) => r.idempotent !== 'non-idempotent',
      );
      if (discardable >= 0) {
        this.checkpoint.completedToolCalls.splice(discardable, 1);
      }
    }
    this.touchCheckpoint();
    // P3-1：不再即时落盘，依赖 completeRound / createCheckpoint 在回合边界统一 flush
  }

  /**
   * 检查工具是否已执行（outbox 模式）
   *
   * 以工具名称 + 参数签名作为唯一标识，检查是否已执行过。
   * 用于恢复时避免重复执行幂等工具。
   *
   * @param name - 工具名称
   * @param args - 工具参数 JSON 字符串
   * @returns 是否已执行
   */
  hasToolExecuted(name: string, args: string): boolean {
    if (!this.checkpoint?.completedToolCalls) return false;
    return this.checkpoint.completedToolCalls.some(
      (r) => r.name === name && r.argsSignature === args,
    );
  }

  /**
   * 记录非幂等工具执行（P1-1 补偿降级后仅日志）
   *
   * 补偿管线已降级：不再逐副作用遍历执行补偿操作。
   * 仅通过日志记录"非幂等工具执行"事实，供宿主或人工排查使用。
   *
   * @param record - 工具执行记录
   * @returns 日志描述信息
   */
  compensateTool(record: ToolExecutionRecord): string {
    const msg = `${record.name}(${record.argsSignature.slice(0, 50)})：非幂等工具，需人工确认是否需要补偿`;
    logger.warn({ tool: record.name, argsSignature: record.argsSignature.slice(0, 80) }, msg);
    return msg;
  }

  /**
   * 记录所有非幂等工具执行（P1-1 补偿降级后仅日志）
   *
   * 不再检查 compensatedAt——直接记录所有非幂等工具的执行。
   * 每条记录生成一条日志。
   *
   * @returns 日志描述信息列表
   */
  compensateAllNonIdempotent(): string[] {
    if (!this.checkpoint?.completedToolCalls) return [];
    return this.checkpoint.completedToolCalls
      .filter((r) => r.idempotent === 'non-idempotent')
      .map((r) => this.compensateTool(r));
  }

  /**
   * 发送心跳，防僵尸会话
   */
  heartbeat(): void {
    if (this.checkpoint) {
      this.touchCheckpoint();
    }
  }

  /**
   * 标记会话暂停超时（超时事实的唯一写点）
   *
   * F1.3 广播式改造：暂停超时信息通过事件载荷传递，支持多监听器同时消费。
   * 暂停超时信息通过事件载荷传递，支持多监听器并行消费（不再依赖一次性消费模式）。
   *
   * 启动路径（loadPersistedCheckpoint）与运行时定时器路径（checkPauseTimeout）
   * 共用本方法：发射事件（含 date/session 载荷），供多个监听器独立消费。
   *
   * 事件监听器读取 payload.date / payload.session，
   * 消除了单监听器依赖——同一事件可被多个监听器独立处理，互不干扰。
   *
   * 会话标识不符合 `YYYY-MM-DD-<会话名>` 约定时（如宿主自定义 id），
   * 无法还原归档所需的二元组，date/session 字段缺省，但事件仍发射通知宿主。
   *
   * @param sessionId - 超时的会话标识
   * @param pauseDuration - 暂停持续时间（毫秒）
   */
  private markSessionTimedOut(sessionId: string, pauseDuration: number): void {
    const matched = SessionManager.SESSION_ID_PATTERN.exec(sessionId);
    const payload: Record<string, unknown> = { sessionId, pauseDuration };
    if (matched) {
      payload.date = matched[1]!;
      payload.session = matched[2]!;
    } else {
      logger.warn(
        { sessionId },
        '暂停超时会话标识不符合 YYYY-MM-DD-<会话名> 约定，跳过自动归档',
      );
    }

    this.emitEvent('sessionPauseTimedOut', payload);
  }

  // ── P0-2：运行时暂停超时检测 ──────────────────────────

  /**
   * 启动暂停超时检测定时器
   *
   * 只在 paused 状态运行时生效，定期检查心跳是否超时。
   * 超时后自动清理检查点、重置状态机、发射事件，防止暂停会话长时间占用资源。
   * 调用前先 stop 确保不重复启动。
   */
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

  /**
   * 停止暂停超时检测定时器
   */
  private stopPauseTimeoutTimer(): void {
    if (this._pauseTimeoutTimer !== null) {
      clearInterval(this._pauseTimeoutTimer);
      this._pauseTimeoutTimer = null;
    }
  }

  /**
   * 检查暂停超时并在超时时自动清理
   *
   * 由定时器定期调用。检查当前检查点是否处于 paused 状态且已超时，
   * 超时则清理检查点、重置状态机、发射事件并停止定时器。
   */
  private checkPauseTimeout(): void {
    const checkpoint = this.checkpoint;
    if (!checkpoint || checkpoint.status !== 'paused') return;

    if (!this.isPauseTimedOut(checkpoint)) return;

    // 暂停超时，自动清理
    const sessionId = checkpoint.sessionId;
    const pauseDuration = Date.now() - (checkpoint.pausedAt ?? checkpoint.lastHeartbeat);

    logger.warn(
      { sessionId, pauseDuration },
      '运行时检测到暂停超时，自动清理检查点',
    );

    // 清理检查点：从存储层删除
    if (this.sessionStore?.deleteCheckpoint) {
      this.sessionStore.deleteCheckpoint(sessionId);
    }

    // 重置运行时状态：清除检查点 + 状态机回到 running
    this.checkpoint = null;
    // 检查点已从存储层删除，残留脏标记无对应内存态，一并清除
    this.checkpointDirty = false;
    this.stateMachine.resetToRunning();

    // 清理后重置连续暂停计数——暂停超时意味着会话断裂，递增→衰减→重置闭合
    this.resetConsecutivePauseCount();

    // 记录超时会话 + 发射事件（唯一入口，与启动路径共用）
    // 补齐前此处只发事件不填字段，运行时超时的会话内容永远不会被归档
    this.markSessionTimedOut(sessionId, pauseDuration);

    // 停止定时器（超时后不再需要继续检测）
    this.stopPauseTimeoutTimer();
  }

  /**
   * 关闭时 flush 脏检查点落盘
   *
   * 供 Agent 关闭时、destroy() 之前调用。覆盖 logToolExecution 标脏后、
   * completeRound 之前关闭的窗口，确保脏检查点不丢失。
   */
  flushOnShutdown(): void {
    this.flushCheckpoint(true);
  }

  /**
   * 销毁 SessionManager，清理所有定时器
   *
   * 供 Agent 关闭时调用，防止定时器阻止进程退出或导致悬空回调。
   */
  destroy(): void {
    this.stopPauseTimeoutTimer();
  }

  /**
   * 检查暂停是否超时（P0-3：暂停超时自动归档）
   *
   * 仅对 paused 状态检查：当前时间距 pausedAt（暂停起点）超过 PAUSE_TIMEOUT_MS 视为超时；
   * pausedAt 缺失时回退到 lastHeartbeat。pausedAt 与 lastHeartbeat 解耦（T2-2 / F1-1），
   * 避免暂停后 touchCheckpoint 刷新心跳导致超时判定被无限推迟。
   * 超时的暂停会话将被自动清理，不再恢复。
   *
   * @param checkpoint - 会话检查点
   * @returns 是否超时
   */
  private isPauseTimedOut(checkpoint: SessionCheckpoint): boolean {
    if (checkpoint.status !== 'paused') return false;
    const pauseStart = checkpoint.pausedAt ?? checkpoint.lastHeartbeat;
    return Date.now() - pauseStart > AGENT_CONSTANTS.PAUSE_TIMEOUT_MS;
  }

  /**
   * 从 AgentLoop 当前消息中提取热记忆（P2.2：支持 FIFO 截断 + 内容截断）
   *
   * 热记忆 = 截断后的最近对话窗口，用于检查点序列化。
   * 采用 FIFO 策略：超过 HOT_MEMORY_MAX_ROUNDS 轮时，保留最近 N 轮。
   * 单条消息内容超过 HOT_MEMORY_CONTENT_SLICE 时截断并追加标记。
   *
   * 仅保留 user/assistant/tool 消息，排除 system prompt。
   *
   * @returns 截断后的热记忆消息列表 + 截断计数
   */
  private extractHotMemory(): { messages: ChatMessage[]; truncatedCount: number } {
    const loop = this.getLoop();
    const messages = loop.getMessages();

    // 过滤 system 消息，仅保留 user/assistant/tool
    let hotMessages = messages.filter((m) => m.role !== 'system');

    // 记录截断前的原始消息数
    const originalCount = hotMessages.length;

    // ① FIFO 轮数截断：超过最大轮数时，丢弃早期消息，保留最近 N 轮
    // 每轮约 2 条消息（user + assistant），含 tool 消息时更多
    const maxMessages = AGENT_CONSTANTS.HOT_MEMORY_MAX_ROUNDS * 2;
    if (hotMessages.length > maxMessages) {
      hotMessages = hotMessages.slice(-maxMessages);
    }

    // 计算被截断的早期消息数
    const truncatedCount = originalCount - hotMessages.length;

    // ② 内容截断：单条消息内容超过阈值时截断
    const contentSlice = AGENT_CONSTANTS.HOT_MEMORY_CONTENT_SLICE;
    const result = hotMessages.map((m) => ({
      role: m.role as ChatMessage['role'],
      content:
        m.content.length > contentSlice
          ? m.content.slice(0, contentSlice) + '\n\n[内容已截断]'
          : m.content,
      // P2-2：透传 name 字段（LLM Message 可能携带 name，如 function 调用结果标识）
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