/**
 * 消息历史：Agent 对话过程中的消息持久化
 *
 * 基元驱动重构（2026-06-11）：
 *   - TopicStore 已移除，消息持久化逻辑待新方案重建
 *   - 保留公共方法签名以维持 API 兼容
 *   - 标记 TODO 的方法体等待基元驱动存储方案落地后重写
 *
 * 原阶段一职责：
 *   - 封装"用户输入 → 话题文件"的追加操作
 *   - 封装"Agent 回复 → 话题文件"的追加操作
 *   - 维护当前话题上下文（date + topic）
 *
 * 原阶段二（M-203-改）：
 *   - 话题切换时自动生成旧话题摘要（事件驱动归档）
 *
 * 详见 02-上下文组装-v4.0.md §6 话题文件
 */
import type { IMemoryStorage } from '@/memory/storage-interface.js';
import type { ISessionStore, SessionMessage } from '@/memory/session-store.js';
import { logger } from '@/logging/logger.js';

// ─── 内联工具函数（原 topic-store.ts 导出，topic-store 删除后内联） ──

/**
 * 获取当前日期字符串 YYYY-MM-DD
 * 原 topic-store.ts todayDate()
 */
function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * 获取当前时间戳 ISO 8601
 * 原 topic-store.ts nowTimestamp()
 */
function nowTimestamp(): string {
  return new Date().toISOString();
}

/**
 * 旧 TopicMessage 类型（原 TopicStore 使用的消息格式）
 *
 * TopicStore 删除后保留此类型，供 loadTopicMessages() 返回值兼容。
 * 后续基元驱动方案落地后，消息格式可能调整。
 */
export interface LegacyTopicMessage {
  /** 消息角色 */
  role: 'user' | 'assistant' | 'system';
  /** 消息内容 */
  content: string;
  /** 时间戳（ISO 8601） */
  timestamp: string;
}

/**
 * 消息历史类
 *
 * TopicStore 已删除（基元驱动重构），
 * 大部分方法保留签名但方法体标记 TODO，
 * 等待新存储方案落地后重写。
 */
export class MessageHistory {
  /** 当前日期 YYYY-MM-DD */
  private currentDate: string;
  /** 当前话题标识（不含日期前缀） */
  private currentTopic: string;

  /**
   * 挂起的归档企划集合，Agent.close() 等待它们完成
   * 容纳 Promise<void>（fire-and-forget 内部）
   */
  private pendingArchives: Set<Promise<unknown>> = new Set();

  constructor(
    /**
     * 内存索引（可选）
     * 注入后，archiveCurrentTopic() 会把摘要同步写入 SQLite，
     * 让召回层能跨会话召回。
     * 不注入则跳过索引写入（保持向后兼容）。
     */
    private readonly _index?: IMemoryStorage,
    /**
     * 会话存储（可选）
     * 注入后，消息会持久化到宿主提供的存储实现。
     * 不注入则仅在内存中保存（AgentLoop.messages[]）。
     */
    private readonly _sessionStore?: ISessionStore,
    /**
     * 临时记忆最小窗口轮次（记忆减法方案 v1.0 · 排雷修正 L2）
     *
     * 上下文压缩时，最少保留的对话轮次。即使上下文利用率 ≥ 85%，
     * 也不压缩到少于此轮次，保证基本上下文连贯性。
     * 默认 3 轮，不可在运行时突破。
     */
    private readonly minWindowRounds = 3,
    initialDate?: string,
    initialTopic = 'main',
  ) {
    this.currentDate = initialDate ?? todayDate();
    this.currentTopic = initialTopic;
    // _index 保留供未来话题记忆写入逻辑使用
    void this._index;
  }

  /**
   * 获取当前话题名（日期-话题组合名）
   */
  get currentTopicName(): string {
    return `${this.currentDate}-${this.currentTopic}`;
  }

  /** 获取当前日期 YYYY-MM-DD（只读，供 agent 层使用） */
  get currentDateValue(): string {
    return this.currentDate;
  }

  /** 获取当前话题名（只读，供 agent 层使用） */
  get currentTopicValue(): string {
    return this.currentTopic;
  }

  /**
   * 获取当前话题标识
   */
  get topic(): string {
    return this.currentTopic;
  }

  /**
   * 获取最小窗口轮次（记忆减法方案 v1.0）
   * 上下文压缩时的下限保护
   */
  get minWindowRoundsValue(): number {
    return this.minWindowRounds;
  }

  /**
   * 切换话题
   * M-203-改：切换前自动为旧话题生成摘要（fire-and-forget，不阻塞切换）
   * @param newTopic - 新话题标识
   * @returns 新话题的全名
   */
  switchTopic(newTopic: string): string {
    // TODO: TopicStore 已删除，旧话题归档逻辑待重建
    // 原逻辑：this.summarizeAndArchive() → 触发旧话题摘要
    logger.debug({ newTopic }, 'switchTopic: TopicStore 已移除，归档逻辑待重建');
    this.currentTopic = newTopic;
    return this.currentTopicName;
  }

  /**
   * 追加 user 消息到当前话题
   * 失败不抛出（消息持久化失败不应阻塞对话）
   */
  async appendUser(content: string): Promise<void> {
    const message: SessionMessage = {
      role: 'user',
      content,
      timestamp: nowTimestamp(),
    };
    // 使用 ISessionStore 持久化（如果已注入）
    if (this._sessionStore) {
      try {
        this._sessionStore.appendMessage(this.currentDate, this.currentTopic, message);
      } catch (err) {
        logger.warn({ err, topic: this.currentTopicName }, 'appendUser: 会话持久化失败');
      }
    }
    logger.debug({ role: message.role, topic: this.currentTopicName }, 'appendUser');
  }

  /**
   * 追加 assistant 消息到当前话题
   * 失败不抛出
   */
  async appendAssistant(content: string): Promise<void> {
    if (!content.trim()) return;
    const message: SessionMessage = {
      role: 'assistant',
      content,
      timestamp: nowTimestamp(),
    };
    // 使用 ISessionStore 持久化（如果已注入）
    if (this._sessionStore) {
      try {
        this._sessionStore.appendMessage(this.currentDate, this.currentTopic, message);
      } catch (err) {
        logger.warn({ err, topic: this.currentTopicName }, 'appendAssistant: 会话持久化失败');
      }
    }
    logger.debug({ role: message.role, topic: this.currentTopicName }, 'appendAssistant');
  }

  /**
   * 列出所有会话主题
   *
   * @returns 主题标识列表（格式：YYYY-MM-DD-topic），未注入 ISessionStore 则返回空
   */
  async listAllTopics(): Promise<string[]> {
    if (!this._sessionStore) {
      logger.debug('listAllTopics: ISessionStore 未注入，返回空数组');
      return [];
    }
    return this._sessionStore.listTopics();
  }

  /**
   * 从会话存储恢复历史消息
   * 用于重启后恢复之前的对话
   *
   * @param date - 会话日期 YYYY-MM-DD
   * @param topic - 会话主题标识
   * @returns 会话中的消息列表，未注入 ISessionStore 则返回空数组
   */
  async loadTopicMessages(date: string, topic: string): Promise<LegacyTopicMessage[]> {
    // 更新当前话题为请求的话题（保持状态一致）
    this.currentDate = date;
    this.currentTopic = topic;

    if (!this._sessionStore) {
      logger.debug({ date, topic }, 'loadTopicMessages: ISessionStore 未注入，返回空数组');
      return [];
    }

    const messages = this._sessionStore.loadMessages(date, topic);
    logger.info({ date, topic, count: messages.length }, 'loadTopicMessages');
    return messages;
  }

  /**
   * 加载最近的话题
   * 用于启动时自动恢复上次对话
   * 策略：先找今天的话题，没有则找最近日期的话题
   *
   * TODO: TopicStore 已删除，待新方案重建。
   *
   * @param preferredTopic - 优先加载的话题名（默认 'main'）
   * @returns 话题消息列表，TopicStore 删除后始终返回空数组
   */
  async loadMostRecentTopic(preferredTopic = 'main'): Promise<LegacyTopicMessage[]> {
    // TopicStore 已移除，原逻辑依赖 this.topicStore.list() + this.parseTopicFileName()
    logger.debug({ preferredTopic }, 'loadMostRecentTopic: TopicStore 已移除，返回空数组');
    return [];
  }

  // summarizeAndArchive() 已删除（TopicStore/TopicSummarizer 已移除，归档逻辑由 extractInsight() 替代）

  /**
   * 公开方法：为当前话题生成摘要，并同步写入索引
   *
   * 四种调用场景：
   * - 'switch'  : 话题切换时（旧话题的最终归档），已有摘要则幂等跳过
   * - 'signal'  : 检测到强信号（实时关键信息）→ 强制重新归档
   * - 'lazy'    : 启动时补归档（兜底历史话题），已有摘要跳过
   * - 'midway'  : 超长话题中途归档，已有摘要时仍重新调用（追加覆盖）
   *
   * TopicStore 和 TopicSummarizer 均已删除，归档逻辑由 Agent.extractInsight() 替代。
   * 此方法保留兼容性，返回 null。
   *
   * @param reason - 归档触发原因
   * @returns null（TopicStore 删除后无法生成归档结果）
   */
  async archiveCurrentTopic(
    reason: 'switch' | 'signal' | 'lazy' | 'midway' = 'switch',
  ): Promise<null> {
    // TopicStore 和 TopicSummarizer 均已移除，归档逻辑由 Agent.extractInsight() 替代
    logger.debug({ reason, topic: this.currentTopicName }, 'archiveCurrentTopic: TopicStore 已移除，跳过归档');
    return null;
  }

  /**
   * 启动时补归档：扫描所有 topic-*.md，找出"还没在索引里"的，
   * 后台异步补齐。
   *
   * TopicStore 已删除，此方法保留兼容性，返回 0。
   *
   * @param timeoutMs 单个 topic 补归档超时（默认 3000ms）
   * @returns 0（TopicStore 删除后无法扫描话题文件）
   */
  async archiveMissingTopics(_timeoutMs = 3000): Promise<number> {
    // TopicStore 已移除，原逻辑依赖 this.topicStore.list() + this.topicStore.read()
    logger.debug('archiveMissingTopics: TopicStore 已移除，跳过补归档');
    return 0;
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
   * 重要：会捕获**等待期间新加入**的归档（解决 init() → archiveMissingTopics() 的 race）
   * 实现：用 50ms 间隔轮询检查新加入的 promise，直到所有归档完成或超时
   *
   * @param timeoutMs 单次等待超时（默认 5000ms）
   * @returns 是否所有归档都完成（false 表示有超时）
   */
  async awaitPendingArchives(timeoutMs = 5000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const current = Array.from(this.pendingArchives);

      if (current.length === 0) {
        // 没有挂起任务，但需要让其他微任务有机会加入新的
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        continue;
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

  // writeTopicMemory() / buildTopicMemoryId() / parseTopicFileName() 已删除
  // TopicStore 已移除，话题记忆写入逻辑由 Agent.extractInsight() 替代

  /**
   * v4.0：获取当前话题的完整消息列表（话题归档用）
   *
   * TopicStore 已删除，返回空数组。
   *
   * @returns 当前话题的所有消息（TopicStore 删除后返回空）
   */
  async getCurrentTopicMessages(): Promise<LegacyTopicMessage[]> {
    // TopicStore 已移除，原逻辑 this.topicStore.read()
    return [];
  }

  /**
   * v4.0：写入种子快照到当前话题的 frontmatter
   *
   * TopicStore 已删除，快照未持久化。
   *
   * @param snapshots 种子句列表
   */
  async setCurrentTopicSeedSnapshots(snapshots: string[]): Promise<void> {
    if (snapshots.length === 0) return;
    // TopicStore 已移除，原逻辑 this.topicStore.appendSeedSnapshots()
    logger.debug(
      { topic: this.currentTopicName, snapshotCount: snapshots.length },
      'setCurrentTopicSeedSnapshots: TopicStore 已移除，快照未持久化',
    );
  }
}
