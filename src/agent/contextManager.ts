/**
 * 上下文窗口管理器（从 AgentLoop 提取的独立职责）
 *
 * 职责：
 *   1. token 估算（estimateTokens）
 *   2. 消息截断（truncateMessages）—— 保留下方、裁中间、提取关键消息
 *   3. 关键消息提取（extractKeyMessages）—— 按重要性权重贪心选取
 *   4. 上下文摘要生成（generateContextSummary）—— LLM 生成"遗忘补偿"
 *   5. 摘要缓存管理（getOrCreateSummary）—— 缓存 TTL + 过期重生成
 *
 * 设计理由（QC-R2-08）：AgentLoop 1151 行超阈值，上下文管理是独立职责，
 * 拆分后 AgentLoop 聚焦对话循环，ContextManager 聚焦上下文窗口管理。
 *
 * 自然生长原则：ContextManager 不持有 messages 引用（避免与 AgentLoop 状态耦合），
 * 所有方法接收 messages 作为参数，是无状态的纯计算 + 缓存。
 */

import type { LlmProvider, Message } from '@/llm/provider.js';
import { LOOP_CONSTANTS } from '@/agent/constants.js';
import { logger } from '@/logging/logger.js';

/** ContextManager 构造选项（P3-12：从 export 降为模块私有，0 外部 import） */
interface ContextManagerOptions {
  /** 上下文窗口 token 上限 */
  readonly maxContextTokens: number;
  /** LLM Provider（用于生成上下文摘要） */
  readonly provider: LlmProvider;
  /** 截断时生成占位消息的文案函数（来自 UIMessages.contextTruncated） */
  readonly contextTruncatedFn: (skipped: number, kept: number) => string;
}

/**
 * 上下文窗口管理器
 *
 * 管理 token 估算、消息截断、摘要生成与缓存。
 * 从 AgentLoop 提取，保持无状态设计（不持有 messages 引用）。
 */
export class ContextManager {
  /** 上下文窗口 token 上限（readonly，构造时传入） */
  private readonly maxContextTokens: number;
  /** LLM Provider（用于 generateContextSummary） */
  private readonly provider: LlmProvider;
  /** 截断占位消息文案函数 */
  private readonly contextTruncatedFn: (skipped: number, kept: number) => string;

  /** 上下文摘要缓存（首次截断后生成，后续截断复用） */
  private contextSummary: string | null = null;
  /** 摘要缓存生成时的消息数量，用于判断缓存是否过期 */
  private contextSummaryMsgCount: number = 0;
  /** 截断次数统计（truncateMessages 实际触发截断 +1，供 getMetrics 读取） */
  private _truncationCount: number = 0;

  constructor(opts: ContextManagerOptions) {
    this.maxContextTokens = opts.maxContextTokens;
    this.provider = opts.provider;
    this.contextTruncatedFn = opts.contextTruncatedFn;
  }

  /** 截断次数（供 AgentLoop.getMetrics 读取） */
  get truncationCount(): number {
    return this._truncationCount;
  }

  /**
   * 估算消息数组的 token 数
   *
   * 粗略估算：总字符数 / CHARS_PER_TOKEN（默认 3）。
   * toolCalls 的 JSON 序列化字符数也计入。
   *
   * @param messages 消息数组
   * @returns 估算的 token 数
   */
  estimateTokens(messages: readonly Message[]): number {
    let totalChars = 0;
    for (const m of messages) {
      // 消息本身的内容字符数
      totalChars += m.content.length;
      // toolCalls 的 JSON 序列化字符数
      if (m.toolCalls) {
        totalChars += JSON.stringify(m.toolCalls).length;
      }
    }
    return Math.ceil(totalChars / LOOP_CONSTANTS.CHARS_PER_TOKEN);
  }

  /**
   * 检查是否需要截断（token 超阈值 + 消息数 > 3）
   *
   * @param messages 消息数组
   * @returns 是否需要截断
   */
  shouldTruncate(messages: readonly Message[]): boolean {
    return this.estimateTokens(messages) > this.maxContextTokens && messages.length > 3;
  }

  /**
   * 截断消息数组以适配上下文窗口
   *
   * 策略：保留下方、裁中间、提取关键消息。
   * - messages[0]（system prompt）始终保留（这是 Agent 的"灵魂"）
   * - 从尾部向前取最近的消息对（user + assistant + tool），直到估算 token 接近上限
   * - 从被裁剪的消息中按重要性权重提取关键用户消息，插入到 placeholder 之前
   * - 头部被裁剪的消息替换为一条摘要占位消息
   *
   * 重要性权重：user 消息 > tool 结果 > assistant 回复
   * 被裁剪的用户消息中，内容较长的（信息量大）优先保留
   *
   * 如果 system prompt 本身就超过 maxContextTokens，不做截断（让 LLM API 报错，
   * 开发者需要缩减 bootstrapMemories 或 toolDefinitions）。
   *
   * @param messages 完整消息数组
   * @param summary 可选的上下文摘要（注入到 system prompt 和 placeholder 之间）
   * @returns 截断后的消息数组（可能是原数组引用，无修改时）
   */
  truncateMessages(messages: readonly Message[], summary?: string): readonly Message[] {
    const estimated = this.estimateTokens(messages);
    if (estimated <= this.maxContextTokens || messages.length <= 3) {
      return messages; // 未超阈值，无需截断
    }

    // system prompt 单独保留
    const systemMsg = messages[0];
    if (!systemMsg || systemMsg.role !== 'system') {
      return messages; // 异常：没有 system prompt，不截断
    }

    const systemTokens = this.estimateTokens([systemMsg]);
    if (systemTokens >= this.maxContextTokens) {
      // system prompt 本身就超了——这是配置问题，不应该截断
      logger.warn(
        { systemTokens, maxContextTokens: this.maxContextTokens },
        'system prompt 已超过上下文窗口上限，请缩减 bootstrapMemories 或 toolDefinitions',
      );
      return messages;
    }

    // 剩余可用 token 数（留 10% 缓冲给 LLM 响应）
    const availableTokens =
      Math.floor(this.maxContextTokens * LOOP_CONSTANTS.CONTEXT_TOKENS_BUFFER_RATIO) - systemTokens;

    // 从尾部向前收集消息（最近的最重要）
    const tail: Message[] = [];
    let tailTokens = 0;
    let cutIndex = messages.length; // 被裁剪区域的起始索引
    for (let i = messages.length - 1; i >= 1; i--) {
      // QC-17 移除非空断言：循环条件保证索引有效，null 检查兜底
      const msg = messages[i];
      if (!msg) break;
      const msgTokens = this.estimateTokens([msg]);
      if (tailTokens + msgTokens > availableTokens) {
        cutIndex = i + 1; // cutIndex 是第一条被保留的尾部消息
        break; // 再加这条就超了
      }
      tail.unshift(msg); // 保持顺序：从尾部取，但插入时保持时间顺序
      tailTokens += msgTokens;
      cutIndex = i;
    }

    // 计算被裁剪的消息
    const skipped = cutIndex - 1; // -1 是 system prompt
    if (skipped <= 0) {
      return messages; // 全部保留
    }

    // 截断次数统计：确实发生了截断（skipped > 0）
    this._truncationCount++;

    // 从被裁剪的消息中按重要性提取关键消息
    // 重要性权重：user > tool > assistant；内容较长的用户消息优先
    const cutMessages = messages.slice(1, cutIndex);
    const keyMessages = this.extractKeyMessages(cutMessages, availableTokens - tailTokens);

    // 构造一条占位消息，让 LLM 知道有历史被裁剪了
    const placeholder: Message = {
      role: 'system',
      content: this.contextTruncatedFn(skipped, tail.length),
    };

    const truncated: Message[] = [systemMsg];

    // 如果有摘要，插入到 system prompt 和 placeholder 之间
    if (summary) {
      truncated.push({ role: 'system', content: summary });
    }

    // 插入从被裁剪区域提取的关键消息
    truncated.push(...keyMessages);

    truncated.push(placeholder);
    truncated.push(...tail);

    const newEstimated = this.estimateTokens(truncated);

    logger.info(
      {
        originalCount: messages.length,
        truncatedCount: truncated.length,
        skipped,
        keyExtracted: keyMessages.length,
        originalTokens: estimated,
        newTokens: newEstimated,
      },
      '上下文窗口截断完成',
    );

    return truncated;
  }

  /**
   * 从被裁剪的消息中按重要性提取关键消息
   *
   * 重要性权重：
   * - user 消息：权重 3（用户输入信息量最高）
   * - tool 消息：权重 2（工具结果有参考价值）
   * - assistant 消息：权重 1（助手回复可从上下文推断）
   *
   * 贪心选取：按权重降序 + 内容长度降序排列，逐条选取直到 token 用完。
   * 最终按原始顺序返回（保持时间线一致性）。
   *
   * @param cutMessages 被裁剪的消息数组
   * @param availableTokens 可用 token 数
   * @returns 提取的关键消息数组（按原始顺序）
   */
  private extractKeyMessages(cutMessages: readonly Message[], availableTokens: number): Message[] {
    if (availableTokens <= 0 || cutMessages.length === 0) return [];

    // 计算每条消息的权重和 token 数
    const weighted = cutMessages.map((msg, index) => ({
      msg,
      index, // 原始顺序索引
      weight: this.messageImportance(msg),
      tokens: this.estimateTokens([msg]),
    }));

    // 按权重降序 + 内容长度降序排列
    weighted.sort((a, b) => {
      if (b.weight !== a.weight) return b.weight - a.weight;
      return b.msg.content.length - a.msg.content.length;
    });

    // 贪心选取，直到 token 用完
    const selected: typeof weighted = [];
    let usedTokens = 0;
    for (const item of weighted) {
      if (usedTokens + item.tokens > availableTokens) break;
      selected.push(item);
      usedTokens += item.tokens;
    }

    // 恢复原始顺序（保持时间线一致性）
    selected.sort((a, b) => a.index - b.index);
    return selected.map((item) => item.msg);
  }

  /**
   * 评估单条消息的重要性权重
   *
   * @param msg 消息
   * @returns 权重值（user=3, tool=2, assistant=1）
   */
  private messageImportance(msg: Message): number {
    if (msg.role === 'user') return 3;
    if (msg.role === 'tool') return 2;
    return 1;
  }

  /**
   * 获取或创建上下文摘要（带缓存管理）
   *
   * 缓存 TTL：消息数增长超过 SUMMARY_CACHE_TTL_MSGS 时缓存过期，需重新生成。
   * 首次调用时生成摘要并缓存，后续调用复用缓存直到过期。
   *
   * @param messages 当前消息数组（用于生成摘要和判断缓存过期）
   * @returns 摘要字符串（失败时返回空字符串，降级为无摘要）
   */
  async getOrCreateSummary(messages: readonly Message[]): Promise<string> {
    // 检查缓存是否有效
    const summaryExpired =
      this.contextSummary !== null &&
      messages.length - this.contextSummaryMsgCount > LOOP_CONSTANTS.SUMMARY_CACHE_TTL_MSGS;

    if (this.contextSummary && !summaryExpired) {
      return this.contextSummary;
    }

    // 生成新摘要
    const summary = await this.generateContextSummary(messages);
    this.contextSummary = summary;
    this.contextSummaryMsgCount = messages.length;
    return summary;
  }

  /**
   * 生成上下文摘要（enableContextSummary 时调用）
   *
   * 在首次截断时，提取即将被裁剪的消息中最近几条用户/助手对话，
   * 调用 provider 生成一句摘要，作为"遗忘补偿"注入到 system prompt 中。
   *
   * @param messages 当前消息数组
   * @returns 摘要字符串（失败时返回空字符串，降级为无摘要）
   */
  private async generateContextSummary(messages: readonly Message[]): Promise<string> {
    const messagesToSummarize = messages.slice(1);
    const recentMessages = messagesToSummarize
      .filter((m) => m.role === 'user' || (m.role === 'assistant' && typeof m.content === 'string'))
      .slice(-LOOP_CONSTANTS.SUMMARY_MSG_COUNT)
      .map(
        (m) =>
          `${m.role}: ${typeof m.content === 'string' ? m.content.substring(0, LOOP_CONSTANTS.SUMMARY_CONTENT_SLICE) : '[tool]'}`,
      )
      .join('\n');

    if (!recentMessages) return '';

    try {
      const stream = this.provider.chat(
        [
          {
            role: 'system',
            content:
              'Summarize the following conversation excerpt in 1-2 sentences. Focus on key facts, decisions, and user preferences. Be concise.',
          },
          { role: 'user', content: recentMessages },
        ],
        { maxTokens: LOOP_CONSTANTS.SUMMARY_MAX_TOKENS, temperature: 0 },
      );
      let summary = '';
      for await (const chunk of stream) {
        if (chunk.content) summary += chunk.content;
      }
      logger.info({ summaryLength: summary.length }, '上下文摘要已生成');
      return `[Context summary of earlier conversation]\n${summary}`;
    } catch (err) {
      logger.warn({ err }, '上下文摘要生成失败，降级为无摘要');
      return '';
    }
  }
}
