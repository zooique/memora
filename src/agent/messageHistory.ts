/**
 * 消息历史：Agent 对话过程中的消息持久化
 *
 * 职责：
 *   - 封装"用户输入 → 会话存储"的追加操作
 *   - 封装"Agent 回复 → 会话存储"的追加操作
 *   - 维护当前会话上下文（date + session）
 *   - 通过 ISessionStore 接口实现会话持久化
 */
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import type { ISessionStore, SessionMessage } from '@/memory/sessionStore.js';
import { logger } from '@/logging/logger.js';
import { configError } from '@/utils/errors.js';

// ─── 内联工具函数 ──

/** 获取当前日期字符串 YYYY-MM-DD */
function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 获取当前时间戳 ISO 8601 */
function nowTimestamp(): string {
  return new Date().toISOString();
}

/**
 * 分叉结果
 */
export interface ForkResult {
  /** 新会话标识（不含日期前缀，如 "main-b1"） */
  newSession: string;
  /** 会话日期 */
  date: string;
  /** 从源会话复制的消息列表 */
  messages: SessionMessage[];
}

/**
 * 消息历史类
 */
export class MessageHistory {
  /** 当前日期 YYYY-MM-DD */
  private currentDate: string;
  /** 当前会话标识（不含日期前缀） */
  private currentSession: string;

  /**
   * 挂起的归档企划集合，Agent.close() 等待它们完成
   * 容纳 Promise<void>（fire-and-forget 内部）
   */
  private pendingArchives: Set<Promise<unknown>> = new Set();

  constructor(
    /**
     * 内存索引（可选）
     * 注入后，会话记忆写入逻辑可同步写入索引，
     * 让召回层能跨会话召回。
     * 不注入则跳过索引写入（保持向后兼容）。
     */
    private readonly index?: IMemoryStorage,
    /**
     * 会话存储（可选）
     * 注入后，消息会持久化到宿主提供的存储实现。
     * 不注入则仅在内存中保存（AgentLoop.messages[]）。
     */
    private readonly sessionStore?: ISessionStore,
    /**
     * 临时记忆最小窗口轮次（记忆减法方案 v1.0 · 排雷修正 L2）
     *
     * 上下文压缩时，最少保留的对话轮次。即使上下文利用率 ≥ 85%，
     * 也不压缩到少于此轮次，保证基本上下文连贯性。
     * 默认 3 轮，不可在运行时突破。
     */
    private readonly minWindowRounds = 3,
    initialDate?: string,
    initialSession = 'main',
  ) {
    this.currentDate = initialDate ?? todayDate();
    this.currentSession = initialSession;
    // index 保留供未来会话记忆写入逻辑使用
    void this.index;
  }

  /**
   * 获取当前会话名（日期-会话组合名）
   */
  get currentSessionName(): string {
    return `${this.currentDate}-${this.currentSession}`;
  }

  /** 获取当前日期 YYYY-MM-DD（只读，供 agent 层使用） */
  get currentDateValue(): string {
    return this.currentDate;
  }

  /** 获取当前会话标识（只读，供 agent 层使用） */
  get currentSessionValue(): string {
    return this.currentSession;
  }

  /**
   * 获取当前会话标识
   */
  get session(): string {
    return this.currentSession;
  }

  /**
   * 获取最小窗口轮次（记忆减法方案 v1.0）
   * 上下文压缩时的下限保护
   */
  get minWindowRoundsValue(): number {
    return this.minWindowRounds;
  }

  /**
   * 切换会话
   * @param newSession - 新会话标识
   * @returns 新会话的全名
   */
  switchSession(newSession: string): string {
    this.currentSession = newSession;
    return this.currentSessionName;
  }

  /**
   * 自动生成分支名
   *
   * 算法：扫描已存在会话，找到以 sourceSession-b 为前缀的最大序号，+1
   *
   * @param sourceSession - 源会话标识
   * @returns 自动生成的分支名（如 "main-b1"）
   */
  private autoBranchName(sourceSession: string): string {
    if (!this.sessionStore) return `${sourceSession}-b1`;
    const allSessions = this.sessionStore.listSessions();
    const prefix = `${sourceSession}-b`;

    // 提取匹配前缀的序号
    const existingNumbers: number[] = [];
    for (const fullSession of allSessions) {
      // fullSession 格式：YYYY-MM-DD-session
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
   * 分叉当前会话
   *
   * 流程：
   * 1. 从 sessionStore 加载当前会话全部消息
   * 2. 生成唯一新会话名
   * 3. 通过 sessionStore.copySession() 复制到新会话
   * 4. switchSession() 切换当前会话标识到新会话
   *
   * @param targetSession - 自定义目标会话名（可选，不传则自动生成）
   * @returns 分叉结果
   * @throws 若 sessionStore 未注入、copySession 未实现或当前会话无消息
   */
  forkSession(targetSession?: string): ForkResult {
    if (!this.sessionStore) {
      throw configError('无法分叉会话', 'ISessionStore 未注入', [
        '在创建 Agent 时注入 sessionStore 参数',
      ]);
    }

    if (!this.sessionStore.copySession) {
      throw configError('无法分叉会话', 'ISessionStore.copySession 未实现', [
        '升级宿主项目的 ISessionStore 实现，添加 copySession() 方法',
      ]);
    }

    const sourceDate = this.currentDate;
    const sourceSession = this.currentSession;

    // 加载源会话消息
    const messages = this.sessionStore.loadMessages(sourceDate, sourceSession);
    if (messages.length === 0) {
      throw configError('无法分叉会话', '当前会话无消息', [
        '先进行一些对话后再尝试分叉',
      ]);
    }

    // 生成目标会话名
    let newSession: string;
    if (targetSession) {
      // 检查目标会话在当天是否已存在
      const targetFullName = `${todayDate()}-${targetSession}`;
      const existingSessions = this.sessionStore.listSessions();
      if (existingSessions.includes(targetFullName)) {
        throw configError('无法分叉会话', `当天会话 "${targetSession}" 已存在`, [
          '使用不同的名称，或不传参数自动生成',
        ]);
      }
      newSession = targetSession;
    } else {
      newSession = this.autoBranchName(sourceSession);
    }

    // 计算目标日期
    const targetDate = todayDate();

    // 原子复制消息
    this.sessionStore.copySession(sourceDate, sourceSession, targetDate, newSession);

    // 切换当前会话到新分支
    this.switchSession(newSession);

    logger.info(
      { from: sourceSession, to: newSession, messageCount: messages.length },
      '会话分叉完成',
    );

    return { newSession, date: targetDate, messages };
  }

  /**
   * 追加 user 消息到当前会话
   * 失败不抛出（消息持久化失败不应阻塞对话）
   *
   * 日期使用 todayDate() 动态获取，而非缓存的 this.currentDate，
   * 确保跨日后消息写入当天目录。
   */
  async appendUser(content: string): Promise<void> {
    const message: SessionMessage = {
      role: 'user',
      content,
      timestamp: nowTimestamp(),
    };
    // 使用 ISessionStore 持久化（如果已注入）
    if (this.sessionStore) {
      try {
        // 动态获取当天日期，避免跨日后写入旧日期目录
        this.sessionStore.appendMessage(todayDate(), this.currentSession, message);
      } catch (err) {
        logger.warn({ err, session: this.currentSessionName }, 'appendUser: 会话持久化失败');
      }
    }
    logger.debug({ role: message.role, session: this.currentSessionName }, 'appendUser');
  }

  /**
   * 追加 assistant 消息到当前会话
   * 失败不抛出
   *
   * 日期使用 todayDate() 动态获取，确保跨日后消息写入当天目录。
   */
  async appendAssistant(content: string): Promise<void> {
    if (!content.trim()) return;
    const message: SessionMessage = {
      role: 'assistant',
      content,
      timestamp: nowTimestamp(),
    };
    // 使用 ISessionStore 持久化（如果已注入）
    if (this.sessionStore) {
      try {
        // 动态获取当天日期，避免跨日后写入旧日期目录
        this.sessionStore.appendMessage(todayDate(), this.currentSession, message);
      } catch (err) {
        logger.warn({ err, session: this.currentSessionName }, 'appendAssistant: 会话持久化失败');
      }
    }
    logger.debug({ role: message.role, session: this.currentSessionName }, 'appendAssistant');
  }

  /**
   * 列出所有会话标识
   *
   * @returns 会话标识列表（格式：YYYY-MM-DD-session），未注入 ISessionStore 则返回空
   */
  async listAllSessions(): Promise<string[]> {
    if (!this.sessionStore) {
      logger.debug({ hasSessionStore: false }, 'listAllSessions: ISessionStore 未注入，返回空数组');
      return [];
    }
    return this.sessionStore.listSessions();
  }

  /**
   * 从会话存储恢复历史消息
   * 用于重启后恢复之前的对话
   *
   * @param date - 会话日期 YYYY-MM-DD
   * @param session - 会话标识
   * @returns 会话中的消息列表，未注入 ISessionStore 则返回空数组
   */
  async loadSessionMessages(date: string, session: string): Promise<SessionMessage[]> {
    // 更新当前会话为请求的会话（保持状态一致）
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
   * 把外部 fire-and-forget 归档注册到 pendingArchives
   * 供 Agent.chat() 触发 signal 归档时使用
   */
  registerPendingArchive(p: Promise<unknown>): void {
    this.pendingArchives.add(p);
    p.finally(() => {
      this.pendingArchives.delete(p);
    });
  }

  /**
   * 等待所有挂起的归档完成（Agent.close() 时调用）
   * 防止 fire-and-forget 还在写 SQLite 时 db 已被 close
   *
   * 重要：会捕获**等待期间新加入**的归档（解决 init() → archiveMissingSessions() 的 race）
   * 实现：用 50ms 间隔轮询检查新加入的 promise，直到所有归档完成或超时
   *
   * @param timeoutMs 单次等待超时（默认 5000ms）
   * @returns 是否所有归档都完成（false 表示有超时）
   */
  async awaitPendingArchives(timeoutMs = 5000): Promise<boolean> {
    // 快速路径：无挂起任务时立即返回（避免空轮询浪费 5s）
    if (this.pendingArchives.size === 0) return true;

    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const current = Array.from(this.pendingArchives);

      if (current.length === 0) {
        // 所有归档已完成
        return true;
      }

      // 有挂起任务 → 等所有 settle
      const timeout = new Promise<void>((resolve) =>
        setTimeout(resolve, Math.max(50, deadline - Date.now())),
      );
      await Promise.race([Promise.allSettled(current), timeout]);

      // 如果所有都清空了 → 完成
      if (this.pendingArchives.size === 0) return true;

      // 还有挂起的（可能在等待期间新加入）→ 下一轮继续等
    }

    return this.pendingArchives.size === 0;
  }
}
