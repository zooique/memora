/**
 * 消息历史：Agent 对话过程中的消息持久化
 *
 * 阶段一职责：
 *   - 封装"用户输入 → 话题文件"的追加操作
 *   - 封装"Agent 回复 → 话题文件"的追加操作
 *   - 维护当前话题上下文（date + topic）
 *
 * 阶段二扩展：
 *   - 支持回顾历史消息（按话题 / 按时间）
 *   - 支持上下文窗口滑动
 *
 * 详见 agent上下文组装协议.md §6 话题文件
 * 详见 T-101 修复：cli 越权调 memory 的下沉
 */
import type { TopicStore } from '../memory/topic-store.js';
import { todayDate, nowTimestamp } from '../memory/topic-store.js';
import type { TopicMessage } from '../memory/types.js';
import { logger } from '../logging/logger.js';

/**
 * 消息历史类
 * cli 只调本类，不直接操作 TopicStore
 */
export class MessageHistory {
  private currentDate: string;
  private currentTopic: string;

  constructor(
    private readonly topicStore: TopicStore,
    initialDate?: string,
    initialTopic = 'main',
  ) {
    this.currentDate = initialDate ?? todayDate();
    this.currentTopic = initialTopic;
  }

  /**
   * 获取当前话题名
   */
  get currentTopicName(): string {
    return `${this.currentDate}-${this.currentTopic}`;
  }

  /**
   * 获取当前话题
   */
  get topic(): string {
    return this.currentTopic;
  }

  /**
   * 切换话题
   * @returns 新话题的全名
   */
  switchTopic(newTopic: string): string {
    this.currentTopic = newTopic;
    return this.currentTopicName;
  }

  /**
   * 追加 user 消息到当前话题
   * 失败不抛出（消息持久化失败不应阻塞对话）
   */
  async appendUser(content: string): Promise<void> {
    const message: TopicMessage = {
      role: 'user',
      content,
      timestamp: nowTimestamp(),
    };
    await this.safeAppend(message);
  }

  /**
   * 追加 assistant 消息到当前话题
   * 失败不抛出
   */
  async appendAssistant(content: string): Promise<void> {
    if (!content.trim()) return;
    const message: TopicMessage = {
      role: 'assistant',
      content,
      timestamp: nowTimestamp(),
    };
    await this.safeAppend(message);
  }

  /**
   * 列出所有话题文件
   */
  async listAllTopics(): Promise<string[]> {
    return this.topicStore.list();
  }

  /**
   * 安全追加：失败仅记录日志，不抛出
   */
  private async safeAppend(message: TopicMessage): Promise<void> {
    try {
      await this.topicStore.append(this.currentDate, this.currentTopic, message);
    } catch (err) {
      logger.error(
        { err, topic: this.currentTopicName, role: message.role },
        '追加消息到话题文件失败',
      );
    }
  }
}
