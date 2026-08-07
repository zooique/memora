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
import type {
  SessionCheckpoint,
  ChatMessage,
  Role,
  Standard,
  ResourceState,
  PlanStep,
} from '@/agent/types.js';
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
   * 生成可序列化的 SessionCheckpoint。
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

    // 从 AgentLoop 获取热记忆（最近消息）
    const hotMemory: ChatMessage[] = this.extractHotMemory();

    // 复用已有检查点的目标信息（跨暂停保持）
    const existingGoal = this.checkpoint?.mainGoal;
    const existingGoalVersion = this.checkpoint?.goalVersion ?? 0;

    this.checkpoint = {
      sessionId: history.currentSessionName,
      status: this.stateMachine.status,
      error: this.stateMachine.errorInfo
        ? {
            cause: this.stateMachine.errorInfo,
            at: Date.now(),
            recovered: false,
          }
        : undefined,
      mainGoal: mainGoal ?? existingGoal ?? '',
      currentGoal: mainGoal ?? existingGoal ?? '',
      goalVersion: existingGoalVersion,
      plan: this.checkpoint?.plan ?? [],
      role: role ?? this.checkpoint?.role ?? { name: 'assistant' },
      standard: standard ?? this.checkpoint?.standard ?? { quality: '', constraints: [] },
      resource: this.checkpoint?.resource ?? { documents: [], memories: [], context: '' },
      hotMemory,
      lastHeartbeat: Date.now(),
    };

    return this.checkpoint;
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

    // 恢复热记忆到 AgentLoop
    const messages: Message[] = checkpoint.hotMemory.map((cm) => ({
      role: cm.role,
      content: cm.content,
      toolCalls: cm.toolCalls,
      toolCallId: cm.toolCallId,
    }));
    this.getLoop().restoreHistory(messages);

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

    logger.info(
      { sessionId: checkpoint.sessionId, messageCount: messages.length },
      '从检查点恢复会话',
    );

    return messages.length;
  }

  /**
   * 暂停会话
   *
   * 双向暂停：用户/Agent/系统均可触发。
   * 暂停前自动创建检查点保存当前状态。
   *
   * @param reason - 暂停原因
   * @param source - 暂停来源
   * @returns 是否暂停成功
   */
  pause(reason: string, source: PauseSource = 'user'): boolean {
    const result = this.stateMachine.pause(reason, source);
    if (result.allowed) {
      // 暂停前保存检查点
      this.createCheckpoint();
      this.emitEvent('sessionPaused', {
        reason,
        source,
        sessionId: this.checkpoint?.sessionId,
      });
      logger.info({ reason, source }, '会话已暂停');
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
    const result = this.stateMachine.resume();
    if (result.allowed) {
      // 更新检查点心跳
      if (this.checkpoint) {
        this.checkpoint.lastHeartbeat = Date.now();
        this.checkpoint.status = 'running';
      }
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
      // 异常前保存检查点
      this.createCheckpoint();
      if (this.checkpoint) {
        this.checkpoint.status = 'error';
        this.checkpoint.error = {
          cause,
          at: Date.now(),
          recovered: false,
        };
      }
      this.emitEvent('sessionError', {
        cause,
        sessionId: this.checkpoint?.sessionId,
      });
      logger.warn({ cause }, '会话异常');
    }
    return result.allowed;
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

    const result = this.stateMachine.recover(this.checkpoint);
    if (result.allowed) {
      if (this.checkpoint) {
        this.checkpoint.status = 'running';
        this.checkpoint.lastHeartbeat = Date.now();
      }
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
   *
   * @param newGoal - 新目标描述
   */
  updateGoal(newGoal: string): void {
    if (!this.checkpoint) {
      this.createCheckpoint(newGoal);
      return;
    }

    this.checkpoint.currentGoal = newGoal;
    this.checkpoint.goalVersion++;
    this.checkpoint.lastHeartbeat = Date.now();

    this.emitEvent('goalUpdated', {
      newGoal,
      goalVersion: this.checkpoint.goalVersion,
      sessionId: this.checkpoint.sessionId,
    });
  }

  /**
   * 更新检查点计划步骤
   *
   * @param plan - 新的计划步骤列表
   */
  updatePlan(plan: PlanStep[]): void {
    if (!this.checkpoint) return;
    this.checkpoint.plan = plan;
    this.checkpoint.lastHeartbeat = Date.now();
  }

  /**
   * 更新检查点资源状态
   *
   * @param resource - 新的资源状态
   */
  updateResource(resource: ResourceState): void {
    if (!this.checkpoint) return;
    this.checkpoint.resource = resource;
    this.checkpoint.lastHeartbeat = Date.now();
  }

  /**
   * 发送心跳，防僵尸会话
   */
  heartbeat(): void {
    if (this.checkpoint) {
      this.checkpoint.lastHeartbeat = Date.now();
    }
  }

  /**
   * 从 AgentLoop 当前消息中提取热记忆
   *
   * 热记忆 = 截断后的最近对话窗口，用于检查点序列化。
   * 仅保留 user/assistant/tool 消息，排除 system prompt。
   */
  private extractHotMemory(): ChatMessage[] {
    const loop = this.getLoop();
    const messages = loop.getMessages();

    // 过滤 system 消息，仅保留 user/assistant/tool
    return messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role as ChatMessage['role'],
        content: m.content,
        toolCalls: m.toolCalls?.map((tc) => ({
          id: tc.id,
          type: tc.type,
          function: { name: tc.function.name, arguments: tc.function.arguments },
        })),
        toolCallId: m.toolCallId,
      }));
  }
}