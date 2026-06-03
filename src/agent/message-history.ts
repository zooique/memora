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
 * 新增功能（2026-06-03）：
 *   - 支持从话题文件恢复历史对话
 *   - 支持启动时加载最近话题
 *
 * 详见 agent上下文组装协议.md §6 话题文件
 * 详见 T-101 修复：cli 越权调 memory 的下沉
 */
import type { TopicStore } from '@/memory/topic-store.js';
import { todayDate, nowTimestamp } from '@/memory/topic-store.js';
import type { Memory, TopicMessage } from '@/memory/types.js';
import { MemoryType, Permanence } from '@/memory/types.js';
import type { MemoryIndex } from '@/memory/index.js';
import { logger } from '@/logging/logger.js';

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
  /**
   * 挂起的归档 Promise（fire-and-forget 也会被记录）
   * Agent.close() 时 await 这个，避免 SQLITE_MISUSE
   */
  private pendingArchives: Set<Promise<void>> = new Set();

  constructor(
    private readonly topicStore: TopicStore,
    private readonly summarizer?: TopicSummarizer,
    initialDate?: string,
    initialTopic = 'main',
    /**
     * 内存索引（可选）
     * 注入后，archiveCurrentTopic() 会把摘要同步写入 SQLite，
     * 让 TopicMount.focus() 能跨会话召回。
     * 不注入则只写 topic-*.md（保持向后兼容）。
     */
    private readonly index?: MemoryIndex,
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
   * 从话题文件恢复历史消息
   * 用于重启后恢复之前的对话
   *
   * @param date - 话题日期 YYYY-MM-DD
   * @param topic - 话题名
   * @returns 话题中的消息列表，话题不存在返回空数组
   */
  async loadTopicMessages(date: string, topic: string): Promise<TopicMessage[]> {
    logger.info({ date, topic }, '尝试加载话题文件');
    const topicFile = await this.topicStore.read(date, topic);
    if (!topicFile) {
      logger.debug({ date, topic }, '话题文件不存在，无法恢复');
      return [];
    }

    logger.info({ messageCount: topicFile.messages.length, date, topic }, '话题文件加载成功');

    // 更新当前话题为加载的话题
    this.currentDate = date;
    this.currentTopic = topic;

    logger.info({ date, topic, messageCount: topicFile.messages.length }, '从话题文件恢复历史对话');

    return topicFile.messages;
  }

  /**
   * 加载最近的话题
   * 用于启动时自动恢复上次对话
   * 策略：先找今天的话题，没有则找最近日期的话题
   *
   * @param preferredTopic - 优先加载的话题名（默认 'main'）
   * @returns 话题消息列表，没有找到返回空数组
   */
  async loadMostRecentTopic(preferredTopic = 'main'): Promise<TopicMessage[]> {
    const allTopics = await this.topicStore.list();
    logger.info({ allTopics }, '找到的话题文件列表');

    if (allTopics.length === 0) {
      logger.debug('没有找到任何话题文件');
      return [];
    }

    // 解析所有话题文件名为 { date, topic, fileName }
    const parsedTopics = allTopics
      .map((fileName) => {
        const parsed = this.parseTopicFileName(fileName);
        return parsed ? { ...parsed, fileName } : null;
      })
      .filter((x): x is { date: string; topic: string; fileName: string } => x !== null);

    logger.info({ parsedTopics }, '解析后的话题列表');

    if (parsedTopics.length === 0) {
      logger.debug('无法解析任何话题文件名');
      return [];
    }

    // 策略 1：优先找今天 + 首选话题
    const today = todayDate();
    const todayPreferred = parsedTopics.find((t) => t.date === today && t.topic === preferredTopic);
    if (todayPreferred) {
      logger.info({ date: today, topic: preferredTopic }, '找到今天的首选话题');
      return this.loadTopicMessages(todayPreferred.date, todayPreferred.topic);
    }

    // 策略 2：找今天的任意话题
    const todayAny = parsedTopics.find((t) => t.date === today);
    if (todayAny) {
      logger.info({ date: today, topic: todayAny.topic }, '找到今天的话题');
      return this.loadTopicMessages(todayAny.date, todayAny.topic);
    }

    // 策略 3：找最近日期的话题（按日期降序排序）
    parsedTopics.sort((a, b) => b.date.localeCompare(a.date));
    const mostRecent = parsedTopics[0]!;
    logger.info({ date: mostRecent.date, topic: mostRecent.topic }, '找到最近的话题');
    return this.loadTopicMessages(mostRecent.date, mostRecent.topic);
  }

  /**
   * 为当前话题生成摘要并归档
   * M-203-改：事件驱动，话题切换时触发
   * 2026-06-03 改：抽离为 archiveCurrentTopic() 公开方法，支持写入 SQLite 索引
   *
   * 跳过条件：
   *   - 未注入 summarizer（无 LLM 能力）
   *   - 话题文件不存在（从未写入）
   *   - 消息数 < 2（单向话题，无对话价值）
   *   - 已有摘要（幂等）
   */
  private async summarizeAndArchive(): Promise<void> {
    // fire-and-forget：记录到 pendingArchives，让 Agent.close() 能 await
    const p = this.archiveCurrentTopic('switch').finally(() => {
      this.pendingArchives.delete(p);
    });
    this.pendingArchives.add(p);
  }

  /**
   * 公开方法：为当前话题生成摘要，并同步写入 SQLite 索引
   *
   * 三种调用场景：
   * - 'switch'  : 话题切换时（旧话题的最终归档）
   * - 'signal'  : 检测到强信号（实时关键信息）→ 立即归档
   * - 'lazy'    : 启动时补归档（兜底历史话题）
   *
   * 写入位置：
   *   1. topic-*.md frontmatter `summary` 字段（已存在）
   *   2. MemoryIndex SQLite（`type: 'topic'`, `permanence: 'topic'`）
   *      → TopicMount.focus() 跨会话召回的入口
   *
   * 失败策略：fire-and-forget + log.warn，不阻塞对话
   * （详见 architecture_philosophy_rules.md §7 降级优先）
   */
  async archiveCurrentTopic(reason: 'switch' | 'signal' | 'lazy' = 'switch'): Promise<void> {
    if (!this.summarizer) return;

    // 闭包捕获当前话题，防止 await 后 this.currentTopic 被 switchTopic 覆盖
    const date = this.currentDate;
    const topic = this.currentTopic;

    const topicFile = await this.topicStore.read(date, topic);
    if (!topicFile) return;

    // 消息数 < 2 跳过（单向话题无总结价值，用户可能只敲了 1 句就切了）
    if (topicFile.messages.length < 2) return;

    // 已有摘要则幂等跳过（避免 LLM 重复调用）
    if (topicFile.summary) {
      // 但如果是 signal 触发的，强信号可能晚于初次归档才出现
      // → 重新触发一次 LLM（覆盖摘要）
      if (reason !== 'signal') return;
    }

    try {
      const summary = await this.summarizer(topicFile.messages);
      // summarizer 返回 null 表示价值过低，跳过归档
      if (summary === null) {
        logger.debug({ topic: `${date}-${topic}`, reason }, '话题价值过低，跳过归档');
        return;
      }

      // 1. 写 topic-*.md frontmatter（已有路径）
      await this.topicStore.appendSummary(date, topic, summary);

      // 2. 同步写入 SQLite 索引（让 TopicMount 能跨会话召回）
      if (this.index) {
        await this.writeTopicMemory(date, topic, summary, topicFile.messages.length);
      }

      logger.info(
        {
          topic: `${date}-${topic}`,
          reason,
          messageCount: topicFile.messages.length,
          hasIndex: !!this.index,
        },
        '话题归档完成',
      );
    } catch (err) {
      // 归档失败不阻塞对话（与 safeAppend 策略一致）
      logger.warn({ err, topic: `${date}-${topic}`, reason }, '话题归档失败');
    }
  }

  /**
   * 启动时补归档：扫描所有 topic-*.md，找出"还没在 SQLite 索引里"的，
   * 后台异步调用 summarizer 补齐。
   *
   * 解决"用户在 main 话题聊 50 轮不切换 → 永远不归档"的漏归档问题。
   *
   * 调用时机：Agent.init() 末尾，fire-and-forget，不阻塞初始化
   * 3 秒超时（每个 topic 独立超时，符合 architecture_philosophy_rules.md §7 P3）
   *
   * @param timeoutMs 单个 topic 补归档超时（默认 3000ms）
   * @returns 实际需要补归档的 topic 数（同步返回，异步执行）
   */
  async archiveMissingTopics(timeoutMs = 3000): Promise<number> {
    if (!this.summarizer || !this.index) return 0;

    // 列出所有 topic 文件
    const topicFiles = await this.topicStore.list();
    if (topicFiles.length === 0) return 0;

    // 解析文件名 → { date, topic }
    const parsed = topicFiles
      .map((name) => this.parseTopicFileName(name))
      .filter((x): x is { date: string; topic: string } => x !== null);

    // 过滤掉"已经在索引里"的
    const missing: { date: string; topic: string }[] = [];
    for (const { date, topic } of parsed) {
      const id = this.buildTopicMemoryId(date, topic);
      const existing = await this.index.getById(id);
      // 已存在说明已归档过；summary 也已写 → 跳过
      if (existing && existing.content) continue;
      // 读取 topic 文件检查消息数（< 2 无价值）
      const tf = await this.topicStore.read(date, topic);
      if (!tf || tf.messages.length < 2) continue;
      missing.push({ date, topic });
    }

    if (missing.length === 0) return 0;

    // 异步 fire-and-forget 补归档（每个 topic 独立超时）
    const work = (async () => {
      for (const { date, topic } of missing) {
        const inner = (async () => {
          try {
            const tf = await this.topicStore.read(date, topic);
            if (!tf) return;
            const summary = await this.summarizer!(tf.messages);
            if (summary === null) {
              logger.debug({ topic: `${date}-${topic}` }, 'lazy 补归档价值过低，跳过');
              return;
            }
            await this.topicStore.appendSummary(date, topic, summary);
            await this.writeTopicMemory(date, topic, summary, tf.messages.length);
            logger.info(
              { topic: `${date}-${topic}`, messageCount: tf.messages.length },
              'lazy 补归档完成',
            );
          } catch (err) {
            logger.warn({ err, topic: `${date}-${topic}` }, 'lazy 补归档失败');
          }
        })();
        // 单 topic 独立超时（不互相阻塞）
        const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
        await Promise.race([inner, timeout]);
      }
    })();
    // 记录到 pendingArchives，让 Agent.close() 能 await
    this.pendingArchives.add(work);
    work.finally(() => {
      this.pendingArchives.delete(work);
    });

    return missing.length;
  }

  /**
   * 把外部 fire-and-forget 归档注册到 pendingArchives
   * 供 Agent.chat() 触发 signal 归档时使用
   */
  registerPendingArchive(p: Promise<unknown>): void {
    const promise = p as Promise<void>;
    this.pendingArchives.add(promise);
    promise.finally(() => {
      this.pendingArchives.delete(promise);
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
        // （比如 init() 后的 archiveMissingTopics 还在异步启动）
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

  /**
   * 把 topic 摘要写入 SQLite 索引
   *
   * ID 规则：`topic-${date}-${topic}` → 同一 topic 多次归档天然幂等（upsert）
   * 永久性：topic（按需召回，符合 MemoryType 6 类 / Permanence 4 等级）
   * 权重：0.7（话题摘要比 bootstrap 的 always=1.0 略低，符合"派生记忆"定位）
   */
  private async writeTopicMemory(
    date: string,
    topic: string,
    summary: string,
    messageCount: number,
  ): Promise<void> {
    if (!this.index) return;
    const now = new Date().toISOString();
    const id = this.buildTopicMemoryId(date, topic);
    const memory: Memory = {
      id,
      type: MemoryType.TOPIC,
      permanence: Permanence.TOPIC,
      name: `${date} ${topic}`,
      content: summary,
      tags: ['auto-archive', `messages:${messageCount}`],
      weight: 0.7,
      createdAt: now,
      updatedAt: now,
    };
    await this.index.upsert(memory);
  }

  /**
   * 构造 topic memory 的稳定 ID
   * 同一 date+topic 多次 upsert 天然幂等
   */
  private buildTopicMemoryId(date: string, topic: string): string {
    return `topic-${date}-${topic}`;
  }

  /**
   * 解析 topic 文件名 → { date, topic }
   * 格式：`YYYY-MM-DD-<topic>.md`
   * 解析失败返回 null（防御性）
   */
  private parseTopicFileName(fileName: string): { date: string; topic: string } | null {
    // 去掉 .md 后缀
    const base = fileName.replace(/\.md$/, '');
    // 必须以 YYYY-MM-DD- 开头
    const m = base.match(/^(\d{4}-\d{2}-\d{2})-(.+)$/);
    if (!m) return null;
    return { date: m[1]!, topic: m[2]! };
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
