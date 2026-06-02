/**
 * 消息历史：Agent 对话过程中的消息持久化
 *
 * 阶段一职责：
 *   - 封装"用户输入 → 话题文件"的追加操作
 *   - 封装"Agent 回复 → 话题文件"的追加操作
 *   - 维护当前话题上下文（date + topic）
 *
 * 阶段二（M-203-改）：
 *   - 话题切换时自动生成旧话题摘要（事件驱动归档）
 *   - 0 新依赖，通过回调函数注入 LLM 能力
 *
 * 详见 agent上下文组装协议.md §6 话题文件
 * 详见 T-101 修复：cli 越权调 memory 的下沉
 */
import type { TopicStore } from '../memory/topic-store.js';
import { todayDate, nowTimestamp } from '../memory/topic-store.js';
import type { TopicMessage } from '../memory/types.js';
import { logger } from '../logging/logger.js';

/**
 * 话题摘要生成器
 * 接收话题消息列表，返回精炼后的核心记忆
 * 返回 null 表示对话价值过低，跳过归档（记忆归档原则 v0.2 · 三步判断）
 * 由 cli 层注入（持有 LLM provider 引用）
 */
export type TopicSummarizer = (messages: TopicMessage[]) => Promise<string | null>;

/**
 * 消息历史类
 * cli 只调本类，不直接操作 TopicStore
 */
export class MessageHistory {
  private currentDate: string;
  private currentTopic: string;

  constructor(
    private readonly topicStore: TopicStore,
    private readonly summarizer?: TopicSummarizer,
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
   * M-203-改：切换前自动为旧话题生成摘要（fire-and-forget，不阻塞切换）
   * @returns 新话题的全名
   */
  switchTopic(newTopic: string): string {
    // 触发旧话题摘要（异步 fire-and-forget，不阻塞切换）
    this.summarizeAndArchive();
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
   * 为当前话题生成摘要并归档
   * M-203-改：事件驱动，话题切换时触发
   *
   * 跳过条件：
   *   - 未注入 summarizer（无 LLM 能力）
   *   - 话题文件不存在（从未写入）
   *   - 消息数 < 2（单向话题，无对话价值）
   *   - 已有摘要（幂等）
   */
  private async summarizeAndArchive(): Promise<void> {
    if (!this.summarizer) return;

    // 闭包捕获当前话题，防止 await 后 this.currentTopic 被 switchTopic 覆盖
    const date = this.currentDate;
    const topic = this.currentTopic;

    const topicFile = await this.topicStore.read(date, topic);
    if (!topicFile) return;

    // 消息数 < 2 跳过（单向话题无总结价值，用户可能只敲了 1 句就切了）
    if (topicFile.messages.length < 2) return;

    // 已有摘要则幂等跳过
    if (topicFile.summary) return;

    try {
      const summary = await this.summarizer(topicFile.messages);
      // summarizer 返回 null 表示价值过低，跳过归档
      if (summary === null) {
        logger.debug({ topic: `${date}-${topic}` }, '话题价值过低，跳过归档');
        return;
      }
      await this.topicStore.appendSummary(date, topic, summary);
      logger.info(
        { topic: `${date}-${topic}`, messageCount: topicFile.messages.length },
        '话题归档完成',
      );
    } catch (err) {
      // 归档失败不阻塞对话（与 safeAppend 策略一致）
      logger.warn({ err, topic: `${date}-${topic}` }, '话题归档失败');
    }
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
