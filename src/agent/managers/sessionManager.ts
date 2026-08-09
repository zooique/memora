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
import { chatBusyError } from '@/utils/errors.js';
// 使用 todayDate() 替代 new Date().toISOString().slice(0,10)，修复 UTC 跨天 bug
import { todayDate } from '@/utils/time.js';
import type { AgentLoop } from '@/agent/loop.js';
import type { MessageHistory } from '@/agent/messageHistory.js';
import type { SessionMessage } from '@/memory/sessionStore.js';
import type { ISessionStore } from '@/memory/sessionStore.js';
import type { Message } from '@/llm/provider.js';
import { AGENT_CONSTANTS } from '@/agent/constants.js';
import type {
  SessionCheckpoint,
  ChatMessage,
  Role,
  Standard,
  ResourceState,
  PlanStep,
  ToolExecutionRecord,
  SideEffect,
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
  /** 会话状态机（三态流转） */
  readonly stateMachine: SessionStateMachine;
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
   * 连续暂停时间戳数组（P2-1：时间衰减机制）
   *
   * 每次高风险暂停时记录当前时间戳，超过衰减窗口（1 小时）的旧时间戳自动过期。
   * 代替旧的简单计数，防止早期暂停长时间锁死防滥用机制。
   * 连续 2 次（窗口内）后强制降级 P3，不再生成 P4 问题。
   * 低风险决策（lowRisk=true）不记录时间戳。
   */
  private consecutivePauseTimestamps: number[] = [];

  /** 连续暂停时间衰减窗口（毫秒）。1 小时前的暂停不计入连续计数。 */
  private static readonly CONSECUTIVE_PAUSE_DECAY_MS = 3_600_000;

  /**
   * 暂停超时会话信息（P0-3：暂停超时自动归档）
   *
   * 启动路径（loadPersistedCheckpoint）与运行时路径（checkPauseTimeout）
   * 均经 markSessionTimedOut() 填充此字段——该方法是唯一写点，
   * 保证「超时被发现」与「归档被触发」在两条路径上语义一致。
   * 外部通过 consumePauseTimedOutSession() 方法访问（一次性消费）。
   */
  private _pauseTimedOutSession: { sessionId: string; date: string; session: string } | null = null;

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

    return this.getHistory().switchSession(newSession);
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
   * 分叉当前会话：复制完整消息历史到新分支，切换到新分支继续对话
   *
   * 分叉后：
   * - 原会话完整保留，可随时通过 switchSession() 切回（用原会话简短名）
   * - 新分支拥有独立的消息历史，后续对话互不干扰
   * - 记忆索引（IMemoryStorage）全局共享，不受分叉影响
   *
   * **注意**：fork 不隔离记忆。分支 A 中提取的 insight 会在分支 B
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
  }

  // ─── 不中断工作模型 v2.0：检查点 + 状态机（P4） ──────────

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

    // 合并语义（T0-1）：以已有检查点为基底展开，仅覆写本次快照需要重算的字段。
    //
    // 【禁止改回对象字面量整体重建】
    // 整体重建等价于「隐式字段白名单」——任何未被显式列出的字段都会在每次
    // pause 时被静默丢弃。历史上 roundLog / completedToolCalls / pauseMeta
    // 三个侧车字段正是因此在每次暂停时归零，导致：
    //   1. hasToolExecuted() 恒 false → 非幂等工具在恢复后重复执行
    //   2. compensateAllNonIdempotent() 过滤空数组 → 补偿机制空转
    //   3. 宿主任务表回合历史归零
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
      mainGoal: mainGoal ?? prev?.mainGoal ?? '',
      // 不传 mainGoal 时保留已有 currentGoal（防止 pause() 内调用时覆盖 updateGoal 的更新）
      currentGoal: mainGoal ?? prev?.currentGoal ?? prev?.mainGoal ?? '',
      goalVersion: prev?.goalVersion ?? 0,
      plan: prev?.plan ?? [],
      role: role ?? prev?.role ?? { name: 'assistant' },
      standard: standard ?? prev?.standard ?? { quality: '', constraints: [] },
      resource: prev?.resource ?? { documents: [], memories: [], context: '' },
      // hotMemory 与 truncatedCount 必须配套重算，不可从基底继承
      hotMemory,
      truncatedCount: truncatedCount > 0 ? truncatedCount : undefined,
      lastHeartbeat: Date.now(),
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

      const checkpoint = JSON.parse(json) as SessionCheckpoint;
      this.checkpoint = checkpoint;
      // 刚从磁盘读入，内存态与磁盘态一致
      this.checkpointDirty = false;

      // P0-3：暂停超时检测——超时会话自动清理检查点，不恢复暂停状态
      if (this.isPauseTimedOut(checkpoint)) {
        const pauseDuration = Date.now() - checkpoint.lastHeartbeat;
        logger.warn(
          { sessionId, pauseDuration, status: checkpoint.status },
          '暂停超时，自动清理检查点（会话将继续，但不会恢复暂停状态）',
        );

        // 清理检查点：从存储层删除，防止下次 init 重复加载
        this.sessionStore.deleteCheckpoint?.(sessionId);

        // 重置运行时状态：不恢复暂停状态，状态机保持运行中
        this.checkpoint = null;
        this.checkpointDirty = false;

        // 记录超时会话 + 发射事件（唯一入口，与运行时路径共用）
        this.markSessionTimedOut(sessionId, pauseDuration);

        return null;
      }

      // 恢复状态机状态
      if (checkpoint.status === 'paused') {
        this.stateMachine.pause('从持久化检查点恢复', 'system');
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
   *
   * @param checkpoint - 要恢复的检查点
   * @returns 恢复的消息数量
   */
  restoreFromCheckpoint(checkpoint: SessionCheckpoint): number {
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

    // 注入截断一致性标记（P2.2：LLM 感知截断边界）
    // 当检查点记录的热记忆被截断时，注入系统消息告知 LLM 有早期消息被截断，
    // 避免 LLM 因上下文缺失而产生困惑，同时提示可触发温记忆召回获取更多上下文。
    if (checkpoint.truncatedCount && checkpoint.truncatedCount > 0) {
      this.getLoop().injectSystemMessage(
        `[热记忆截断提示] 本次恢复的会话有 ${checkpoint.truncatedCount} 条早期消息已被截断。这些消息已不在当前上下文中，但相关信息已归档到温记忆中，可通过温记忆召回获取。`,
      );
    }

    // 恢复状态机：根据检查点状态设置状态机
    if (checkpoint.status === 'error' && checkpoint.error) {
      this.stateMachine.triggerError(checkpoint.error.cause);
    } else if (checkpoint.status === 'paused') {
      this.stateMachine.pause('从检查点恢复', 'system');
    }
    // running 状态不需要额外操作（状态机默认 running）

    // 切换到检查点记录的会话
    const history = this.getHistory();
    const sessionParts = checkpoint.sessionId.split('-');
    if (sessionParts.length >= 4) {
      const date = sessionParts.slice(0, 3).join('-');
      const session = sessionParts.slice(3).join('-');
      history.loadSessionMessages(date, session);
    }

    // P3.4：恢复时补偿——对非幂等工具执行补偿操作
    // 在恢复热窗口和契约后，检查检查点中是否有非幂等工具执行记录
    // 若有，执行补偿并记录结果
    const compensationResults = this.compensateAllNonIdempotent();
    if (compensationResults.length > 0) {
      logger.warn(
        { sessionId: checkpoint.sessionId, compensationCount: compensationResults.length, compensations: compensationResults },
        '恢复时发现非幂等工具执行，已执行补偿操作',
      );

      // 注入补偿结果到上下文，让 LLM 感知到补偿操作
      const compensationSummary = compensationResults.join('\n');
      this.getLoop().injectSystemMessage(
        `[P3.4补偿通知] 本次恢复的会话包含 ${compensationResults.length} 个非幂等工具调用，已执行补偿操作。补偿详情：\n${compensationSummary}\n\n请根据补偿结果调整后续操作。`,
      );
    }

    logger.info(
      { sessionId: checkpoint.sessionId, messageCount: messages.length, truncatedCount: checkpoint.truncatedCount ?? 0, compensationCount: compensationResults.length },
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
      // 暂停前保存检查点
      this.createCheckpoint();
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
        this.checkpoint.status = 'running';
        this.touchCheckpoint();
        this.flushCheckpoint();
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
        this.checkpoint.status = 'running';
        this.touchCheckpoint();
      }
      // T0-3：恢复必须落盘。
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
   * 用户修正目标时调用，递增 goalVersion 触发漂移检测。
   * 更新前自动执行一致性校验（P3.1），若检测到漂移则发射 goalDriftDetected 事件。
   * 校验结果不影响 updateGoal 的执行——事件是通知性的，宿主 UI 决定是否暂停等待用户确认。
   *
   * @param newGoal - 新目标描述
   * @returns 一致性校验结果（调用方可据此判断是否需要处理漂移）
   */
  updateGoal(newGoal: string): GoalConsistencyResult | null {
    if (!this.checkpoint) {
      this.createCheckpoint(newGoal);
      return null;
    }

    // P3.1：执行一致性校验，与 mainGoal 对比
    const mainGoal = this.checkpoint.mainGoal;
    const consistencyResult = this.consistencyChecker.checkConsistency(mainGoal, newGoal);

    this.checkpoint.currentGoal = newGoal;
    this.checkpoint.goalVersion++;
    this.touchCheckpoint();
    // 目标变更是会话的语义骨架，立即落盘
    this.flushCheckpoint();

    this.emitEvent('goalUpdated', {
      newGoal,
      goalVersion: this.checkpoint.goalVersion,
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
        goalVersion: this.checkpoint.goalVersion,
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
   * @deprecated Phase 2 起由 completeRound / appendPlanStep 取代（SSOT 单一写点）。
   * 更新检查点计划步骤
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

  /**
   * @deprecated Phase 2 起由 completeRound / appendPlanStep 取代（SSOT 单一写点）。
   * 推进到下一个未完成步骤
   *
   * 根据增量默认分辨率：有未完成步骤 → 推进最近步骤。
   * 将最近一个 pending 步骤标记为 active，并返回该步骤。
   * 若所有步骤已完成或已阻塞，返回 null 表示计划停滞。
   *
   * @returns 推进后的步骤，或 null（计划停滞）
   */
  advancePlan(): PlanStep | null {
    if (!this.checkpoint) return null;
    const nextStep = this.checkpoint.plan.find((s) => s.status === 'pending');
    if (!nextStep) return null;
    nextStep.status = 'active';
    this.touchCheckpoint();
    return nextStep;
  }

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
   * 完成一个回合（P2-3: Phase 2 SSOT 唯一写点）
   *
   * 单函数内顺序写入 plan 步骤状态 + roundLog + heartbeat，
   * 保证原子性。替代旧的 completeStep + 单独 updatePlan 分散调用。
   *
   * @param options - 回合完成信息
   * @param options.stepId - 可选，本回合对应的计划步骤 ID
   * @param options.summary - 回合摘要
   * @param options.toolCallCount - 工具调用次数
   * @param options.assistantLength - 助手回复长度（字符数）
   */
  completeRound(options: {
    stepId?: string;
    summary: string;
    toolCallCount: number;
    assistantLength: number;
  }): void {
    if (!this.checkpoint) return;

    // 1. 标记步骤状态
    const { stepId, summary, toolCallCount, assistantLength } = options;
    if (stepId) {
      const step = this.checkpoint.plan.find((s) => s.id === stepId);
      if (step) {
        step.status = 'done';
      }
    }

    // 2. 追加回合日志（FIFO cap）
    const outcome: RoundOutcome = {
      stepId,
      summary,
      toolCallCount,
      assistantLength,
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
   * 设置暂停元数据（P2-3: Phase 2 暂停模型）
   *
   * @param meta - 暂停元数据
   */
  setPauseMeta(meta: PauseMeta): void {
    if (!this.checkpoint) return;
    this.checkpoint.pauseMeta = meta;
    this.touchCheckpoint();
    // 必须落盘：本方法由 loop.onPaused 在 pause() 之后回调，
    // 是 pauseMeta 进入检查点的唯一时机。若不落盘，磁盘快照将永远缺少暂停元数据，
    // 宿主重启后只能回落到兜底文案「已暂停（重启恢复）」。
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
  // ── P3.4：副作用日志 + 补偿机制 ─────────────────────────

  /**
   * 记录工具执行
   *
   * 将已执行的工具调用追加到检查点日志，用于恢复时 outbox 模式检查。
   * 日志为 append-only，不修改已有记录。
   * 扩展（P3.4）：支持记录幂等性级别和副作用，供补偿机制使用。
   *
   * @param record - 工具执行记录
   */
  logToolExecution(record: ToolExecutionRecord): void {
    if (!this.checkpoint) return;
    if (!this.checkpoint.completedToolCalls) {
      this.checkpoint.completedToolCalls = [];
    }
    this.checkpoint.completedToolCalls.push(record);
    this.touchCheckpoint();
    // 【必须立即落盘，不可延迟到回合边界】
    // outbox 模式的前提是「执行事实先于崩溃被持久化」。若执行记录只驻留内存，
    // 回合中途崩溃将使 hasToolExecuted() 在恢复后恒 false，非幂等工具被重复执行——
    // 这正是 outbox 要消除的风险。回合边界对此粒度太粗（单回合可含多次工具调用）。
    this.flushCheckpoint();
  }

  /**
   * 记录工具副作用（P3.4 补偿机制·副作用日志）
   *
   * 将副作用追加到指定工具执行记录中。
   * 副作用一旦记录不可修改（append-only），确保补偿时能看到完整的历史副作用。
   *
   * @param name - 工具名称
   * @param argsSignature - 参数签名（与 logToolExecution 的记录匹配）
   * @param sideEffect - 副作用描述
   */
  recordSideEffect(name: string, argsSignature: string, sideEffect: SideEffect): void {
    if (!this.checkpoint?.completedToolCalls) return;
    const record = this.checkpoint.completedToolCalls.find(
      (r) => r.name === name && r.argsSignature === argsSignature,
    );
    if (!record) return;
    if (!record.sideEffects) {
      record.sideEffects = [];
    }
    record.sideEffects.push(sideEffect);
    this.touchCheckpoint();
    // 与 logToolExecution 同理：补偿机制依赖副作用清单，丢失即无法回滚
    this.flushCheckpoint();
  }

  /**
   * 获取指定工具的副作用列表（P3.4 补偿机制）
   *
   * @param name - 工具名称
   * @param argsSignature - 参数签名
   * @returns 副作用列表，不存在时返回空数组
   */
  getSideEffectsForTool(name: string, argsSignature: string): SideEffect[] {
    if (!this.checkpoint?.completedToolCalls) return [];
    const record = this.checkpoint.completedToolCalls.find(
      (r) => r.name === name && r.argsSignature === argsSignature,
    );
    return record?.sideEffects ?? [];
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
   * 获取检查点中所有非幂等工具的执行记录列表（P3.4 补偿机制）
   *
   * 用于恢复时识别需要补偿的非幂等工具。
   * 非幂等条件：idempotent === 'non-idempotent' 或未标注幂等性但执行失败。
   *
   * @returns 非幂等工具执行记录列表
   */
  getNonIdempotentExecutions(): ToolExecutionRecord[] {
    if (!this.checkpoint?.completedToolCalls) return [];
    return this.checkpoint.completedToolCalls.filter(
      (r) => r.idempotent === 'non-idempotent',
    );
  }

  /**
   * 补偿单个工具执行（P3.4 补偿机制·恢复时补偿动作）
   *
   * 对非幂等工具的副作用执行补偿操作。
   * 补偿逻辑：
   *   - file_write（写入文件）：无法自动回滚，记录警告日志
   *   - file_create（创建文件）：记录警告日志
   *   - memory_write（写入记忆）：记录警告日志
   *   - custom（自定义）：仅记录日志，由宿主自行处理
   *
   * 当前实现：**日志告警 + 记录补偿标记**，不自动执行回滚操作。
   * 理由：自动回滚可能引入新的副作用（如回滚文件时覆盖其他修改），
   * 需要宿主根据业务场景决定是否执行补偿。
   * 标记补偿已执行（ok = false），避免重复补偿。
   *
   * @param record - 要补偿的工具执行记录
   * @returns 补偿操作描述（供宿主展示）
   */
  compensateTool(record: ToolExecutionRecord): string {
    if (!this.checkpoint) return '补偿失败：无检查点';

    const sideEffects = record.sideEffects ?? [];
    const compensations: string[] = [];

    for (const se of sideEffects) {
      switch (se.type) {
        case 'file_write':
        case 'file_create':
          compensations.push(
            `${se.type}(${se.target})：无法自动回滚，请手动检查文件内容`,
          );
          break;
        case 'file_delete':
          compensations.push(
            `file_delete(${se.target})：无法自动恢复，请手动检查文件系统`,
          );
          break;
        case 'memory_write':
          compensations.push(
            `memory_write(${se.target})：无法自动回滚记忆写入`,
          );
          break;
        case 'custom':
          compensations.push(
            `custom(${se.target})：${se.description}`,
          );
          break;
      }
    }

    // 如果工具没有副作用记录，标记为"需人工确认"
    if (compensations.length === 0) {
      compensations.push(
        `${record.name}(${record.argsSignature.slice(0, 50)})：无副作用记录，需人工确认是否需要补偿`,
      );
    }

    // 记录补偿标记到日志
    logger.warn(
      {
        tool: record.name,
        argsSignature: record.argsSignature.slice(0, 80),
        compensations,
      },
      '工具补偿已记录（需人工确认）',
    );

    // 标记原始执行记录为 ok=false，表明该工具的副作用已被补偿
    record.ok = false;

    return compensations.join('; ');
  }

  /**
   * 补偿所有非幂等工具执行（P3.4 补偿机制）
   *
   * 遍历检查点中所有非幂等工具记录，执行补偿操作。
   * 在恢复会话时调用，确保非幂等操作的副作用被正确处理。
   *
   * @returns 补偿操作描述列表
   */
  compensateAllNonIdempotent(): string[] {
    const nonIdempotent = this.getNonIdempotentExecutions();
    if (nonIdempotent.length === 0) return [];

    const results: string[] = [];
    for (const record of nonIdempotent) {
      const result = this.compensateTool(record);
      results.push(result);
    }
    return results;
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
   * 消费暂停超时会话信息（一次性读取 + 清空）
   *
   * 供 Agent.init() 在触发内容归档前读取超时会话信息。
   * 读取后清空内部字段，确保同一超时会话不会被重复消费。
   *
   * @returns 暂停超时会话信息，不存在时返回 null
   */
  consumePauseTimedOutSession(): { sessionId: string; date: string; session: string } | null {
    const info = this._pauseTimedOutSession;
    this._pauseTimedOutSession = null;
    return info;
  }

  /**
   * 标记会话暂停超时（超时事实的唯一写点）
   *
   * 启动路径（loadPersistedCheckpoint）与运行时定时器路径（checkPauseTimeout）
   * 共用本方法：先填充 `_pauseTimedOutSession` 供归档消费，再发射事件。
   * 顺序不可颠倒——事件监听器会同步调用 consumePauseTimedOutSession()，
   * 若先发射则消费到 null，运行时超时的内容将静默丢失。
   *
   * 会话标识不符合 `YYYY-MM-DD-<会话名>` 约定时（如宿主自定义 id），
   * 无法还原归档所需的二元组，跳过填充但仍发射事件通知宿主。
   *
   * @param sessionId - 超时的会话标识
   * @param pauseDuration - 暂停持续时间（毫秒）
   */
  private markSessionTimedOut(sessionId: string, pauseDuration: number): void {
    const matched = SessionManager.SESSION_ID_PATTERN.exec(sessionId);
    if (matched) {
      this._pauseTimedOutSession = { sessionId, date: matched[1]!, session: matched[2]! };
    } else {
      logger.warn(
        { sessionId },
        '暂停超时会话标识不符合 YYYY-MM-DD-<会话名> 约定，跳过自动归档',
      );
    }

    this.emitEvent('sessionPauseTimedOut', { sessionId, pauseDuration });
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
    const pauseDuration = Date.now() - checkpoint.lastHeartbeat;

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

    // 记录超时会话 + 发射事件（唯一入口，与启动路径共用）
    // 补齐前此处只发事件不填字段，运行时超时的会话内容永远不会被归档
    this.markSessionTimedOut(sessionId, pauseDuration);

    // 停止定时器（超时后不再需要继续检测）
    this.stopPauseTimeoutTimer();
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
   * 仅对 paused 状态检查：当前时间距 lastHeartbeat 超过 PAUSE_TIMEOUT_MS 视为超时。
   * 超时的暂停会话将被自动清理，不再恢复。
   *
   * @param checkpoint - 会话检查点
   * @returns 是否超时
   */
  private isPauseTimedOut(checkpoint: SessionCheckpoint): boolean {
    if (checkpoint.status !== 'paused') return false;
    return Date.now() - checkpoint.lastHeartbeat > AGENT_CONSTANTS.PAUSE_TIMEOUT_MS;
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