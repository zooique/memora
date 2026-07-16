/**
 * 会话管理器
 *
 * 从 Agent 类中提取会话管理职责（ADR-010 §Agent 类拆分）。
 * 负责会话切换、分叉、恢复和消息加载，通过回调函数访问 Agent 的当前组件状态，
 * 避免与 Agent 的 history/loop 引用生命周期耦合。
 *
 * Agent 通过组合方式持有 SessionManager 实例，将会话相关操作委托给它。
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
    } catch {
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
}