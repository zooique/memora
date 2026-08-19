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
 * 设计理由：AgentLoop 1151 行超阈值，上下文管理是独立职责，
 * 拆分后 AgentLoop 聚焦对话循环，ContextManager 聚焦上下文窗口管理。
 *
 * 自然生长原则：ContextManager 不持有 messages 引用（避免与 AgentLoop 状态耦合），
 * 所有方法接收 messages 作为参数，是无状态的纯计算 + 缓存。
 */

import type { LlmProvider, Message } from '@/llm/provider.js';
import type { ProviderRouter } from '@/llm/types.js';
import { LOOP_CONSTANTS } from '@/agent/constants.js';
import { logger } from '@/logging/logger.js';
import { NOOP_TRACER, TRACE_SPANS, type ITracer } from '@/agent/tracer.js';
import { isAbortError } from '@/utils/errors.js';

/** ContextManager 构造选项（模块私有，0 外部 import） */
interface ContextManagerOptions {
  /** 上下文窗口 token 上限 */
  readonly maxContextTokens: number;
  /** LLM Provider（用于生成上下文摘要） */
  readonly provider: LlmProvider;
  /**
   * Provider 路由选择器（P1-2 多模型路由基础，可选）
   *
   * 有配置时，摘要生成走 'summary' 路由，使用轻量模型。
   * 不配置时回退到主 Provider（完全向后兼容）。
   */
  readonly providerRouter?: ProviderRouter;
  /** 截断时生成占位消息的文案函数（来自 UIMessages.contextTruncated） */
  readonly contextTruncatedFn: (skipped: number, kept: number) => string;
  /**
   * 可观测性 Tracer（用于 generateContextSummary span 埋点）
   *
   * 未注入时降级为 NOOP_TRACER（静默丢弃所有 span，零开销）。
   */
  readonly tracer?: ITracer;
  /**
   * 截断事件回调（每次 truncateMessages 触发截断时调用）
   *
   * 未注入时静默忽略。宿主可通过此回调向用户通知上下文被截断。
   */
  readonly onContextTruncated?: (skippedCount: number, keptCount: number) => void;
  /**
   * 已存轮次摘要加载器（ADR-023 C1，可选）
   *
   * 截断生成上下文摘要前，先尝试取已持久化的 round-summary（零成本、保真），
   * 仅当没有已存摘要时才现调 LLM——让摘要生成退出截断关键路径。
   * 返回空字符串/undefined 表示无已存摘要，回退 LLM 生成。
   */
  readonly roundSummaryLoader?: () => string;
  /**
   * 最少保留的最近原始对话轮数（ADR-023 C2，可选，默认 0）
   *
   * 截断时强制保留最近 N 轮完整原始对话（不被摘要替代），在此基础上再按 token 上限收集。
   * 宿主可据 provider 的 prompt caching（KV cache 复用）能力放宽此值——多塞原始对话几乎
   * 零成本且保真。0 表示不强制（保持纯 token 驱动截断）。
   */
  readonly minRecentRounds?: number;
}

/**
 * 判断字符是否为 CJK 字符（中文适配）
 *
 * CJK 字符在 LLM tokenizer 中 token 密度更高（约 1-2 token/字符），
 * 需要与英文/数字/符号分开估算。
 *
 * 覆盖范围：
 *   - U+3400-U+4DBF：CJK 统一表意文字扩展A
 *   - U+4E00-U+9FFF：CJK 统一表意文字（常用中文）
 *   - U+3040-U+30FF：日文平假名 + 片假名
 *   - U+AC00-U+D7AF：韩文音节
 *
 * @param code 字符的 Unicode code point
 * @returns 是否为 CJK 字符
 */
function isCjkChar(code: number): boolean {
  return (
    (code >= 0x4e00 && code <= 0x9fff) || // CJK 统一表意文字
    (code >= 0x3400 && code <= 0x4dbf) || // CJK 扩展A
    (code >= 0x3040 && code <= 0x30ff) || // 日文平假名 + 片假名
    (code >= 0xac00 && code <= 0xd7af)    // 韩文音节
  );
}

/**
 * 统计字符串中 CJK 与非 CJK 字符数（中文适配）
 *
 * 用 for...of 遍历字符串以正确处理代理对（emoji 等），
 * codePointAt(0) 获取首个 code point。
 *
 * @param str 待统计的字符串
 * @returns { cjkChars, otherChars } CJK 字符数与非 CJK 字符数
 */
function countCjkAndOther(str: string): { cjkChars: number; otherChars: number } {
  let cjkChars = 0;
  let otherChars = 0;
  for (const ch of str) {
    const code = ch.codePointAt(0);
    if (code !== undefined && isCjkChar(code)) {
      cjkChars++;
    } else {
      otherChars++;
    }
  }
  return { cjkChars, otherChars };
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
  /**
   * Provider 路由选择器（P1-2 多模型路由基础，可选）
   *
   * 有配置时，摘要生成走 'summary' 路由，使用轻量模型。
   * 不配置时回退到主 Provider（完全向后兼容）。
   */
  private readonly providerRouter: ProviderRouter | undefined;
  /** 截断占位消息文案函数 */
  private readonly contextTruncatedFn: (skipped: number, kept: number) => string;
  /** 可观测性 Tracer（用于 generateContextSummary span 埋点，默认 NOOP） */
  private readonly tracer: ITracer;

  /** 上下文摘要缓存（首次截断后生成，后续截断复用） */
  private contextSummary: string | null = null;
  /** 摘要缓存生成时的消息数量，用于判断缓存是否过期 */
  private contextSummaryMsgCount: number = 0;
  /** 截断次数统计（truncateMessages 实际触发截断 +1，供 getMetrics 读取） */
  private _truncationCount: number = 0;
  /** 截断事件回调（宿主可注入以通知用户） */
  private readonly onContextTruncated: ((skipped: number, kept: number) => void) | undefined;
  /** 已存轮次摘要加载器（ADR-023 C1，可选；截断时优先复用已存 round-summary） */
  private readonly roundSummaryLoader: (() => string) | undefined;
  /** 最少保留的最近原始对话轮数（ADR-023 C2，默认 0=不强制） */
  private readonly minRecentRounds: number;

  constructor(opts: ContextManagerOptions) {
    this.maxContextTokens = opts.maxContextTokens;
    this.provider = opts.provider;
    this.providerRouter = opts.providerRouter;
    this.contextTruncatedFn = opts.contextTruncatedFn;
    this.onContextTruncated = opts.onContextTruncated;
    this.roundSummaryLoader = opts.roundSummaryLoader;
    this.minRecentRounds = Math.max(0, Math.floor(opts.minRecentRounds ?? 0));
    // 未注入 tracer 时降级为 NOOP_TRACER（零开销）
    this.tracer = opts.tracer ?? NOOP_TRACER;
  }

  /** 截断次数（供 AgentLoop.getMetrics 读取） */
  get truncationCount(): number {
    return this._truncationCount;
  }

  /**
   * 估算消息数组的 token 数（CJK 中文适配）
   *
   * 区分 CJK 与非 CJK 字符分别估算：
   *   - CJK 字符（中文/日文/韩文）：cjkChars / CJK_CHARS_PER_TOKEN（1.5）
   *   - 非 CJK 字符（英文/数字/符号）：otherChars / CHARS_PER_TOKEN（3）
   * 统一字符估算会严重低估中文（4 字符 ≈ 1.3 token，实际约 4-8 token）。
   *
   * toolCalls 的 JSON 序列化字符数也计入（同样区分 CJK/非 CJK）。
   *
   * @param messages 消息数组
   * @returns 估算的 token 数
   */
  estimateTokens(messages: readonly Message[]): number {
    let cjkChars = 0;
    let otherChars = 0;
    for (const m of messages) {
      // 消息内容：区分 CJK 与非 CJK 字符
      const contentCounts = countCjkAndOther(m.content);
      cjkChars += contentCounts.cjkChars;
      otherChars += contentCounts.otherChars;
      // toolCalls 的 JSON 序列化字符数（同样区分 CJK/非 CJK）
      if (m.toolCalls) {
        const toolCallsCounts = countCjkAndOther(JSON.stringify(m.toolCalls));
        cjkChars += toolCallsCounts.cjkChars;
        otherChars += toolCallsCounts.otherChars;
      }
    }
    // CJK 与非 CJK 分别按各自密度估算后求和
    return Math.ceil(
      cjkChars / LOOP_CONSTANTS.CJK_CHARS_PER_TOKEN +
      otherChars / LOOP_CONSTANTS.CHARS_PER_TOKEN,
    );
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
    // C2（ADR-023）：强制保留最近 minRecentRounds 轮完整原始对话（不被摘要替代）
    // 从尾部数 user 消息，每个 user 消息算一轮，其配套消息一并保留。
    let forcedTailCount = 0;
    if (this.minRecentRounds > 0) {
      let userSeen = 0;
      for (let i = messages.length - 1; i >= 1; i--) {
        const msg = messages[i];
        if (!msg) break;
        if (msg.role === 'user') userSeen++;
        if (userSeen > this.minRecentRounds) break;
        forcedTailCount++;
      }
    }
    for (let i = messages.length - 1; i >= 1; i--) {
      // 移除非空断言：循环条件保证索引有效，null 检查兜底
      const msg = messages[i];
      if (!msg) break;
      const msgTokens = this.estimateTokens([msg]);
      // 强制保留区内的消息不计入 token 上限（C2）；超出强制区才按 token 限制
      const inForced = tail.length < forcedTailCount;
      if (!inForced && tailTokens + msgTokens > availableTokens) {
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
    // 通知宿主上下文被截断（如��回调）
    this.onContextTruncated?.(skipped, tail.length);

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
   * 作废摘要缓存
   *
   * 缓存过期靠 `messages.length - contextSummaryMsgCount > TTL` 这个**单向**数值判断，
   * 只覆盖「消息增长」。当消息集合被整体替换（`AgentLoop.restoreHistory` 恢复检查点）
   * 且新历史更短时，差值为负 → 陈旧摘要永不过期，会把上一段会话的摘要注入新上下文。
   *
   * 修法不是把条件改成 `Math.abs`：truncateMessages 的正常裁剪同样让消息变少，
   * 而那时摘要恰恰更该保留（它描述的就是被裁掉的历史）。真理源是「消息集合是否被替换」
   * 这一事实，故由替换方显式作废，而非从长度差反推。
   */
  resetSummary(): void {
    this.contextSummary = null;
    this.contextSummaryMsgCount = 0;
  }

  /**
   * 获取或创建上下文摘要（带缓存管理）
   *
   * 缓存 TTL：消息数增长超过 SUMMARY_CACHE_TTL_MSGS 时缓存过期，需重新生成。
   * 首次调用时生成摘要并缓存，后续调用复用缓存直到过期。
   *
   * signal 参数让摘要生成可被用户取消中断，
   * 避免摘要 LLM 调用卡住时 generator 永久挂起（与 executeToolCalls 同源问题）。
   *
   * @param messages 当前消息数组（用于生成摘要和判断缓存过期）
   * @param signal 可选的 AbortSignal，中断摘要生成
   * @returns 摘要字符串（失败/中断时返回空字符串，降级为无摘要）
   */
  async getOrCreateSummary(messages: readonly Message[], signal?: AbortSignal): Promise<string> {
    // 检查缓存是否有效
    const summaryExpired =
      this.contextSummary !== null &&
      messages.length - this.contextSummaryMsgCount > LOOP_CONSTANTS.SUMMARY_CACHE_TTL_MSGS;

    if (this.contextSummary && !summaryExpired) {
      return this.contextSummary;
    }

    // 生成新摘要（传入 signal 支持中断）
    const summary = await this.generateContextSummary(messages, signal);
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
   * 通过 tracer span 埋点（TRACE_SPANS.CONTEXT_SUMMARY），
   * 让宿主监控面板能观察截断频率、摘要生成耗时与失败率。
   *
   * signal 参数传入 provider.chat 的 ChatOptions，
   * 让 fetch 请求和 SSE 流读取都能被 abort 中断；
   * for await 循环中也检查 signal.aborted 提前退出。
   *
   * @param messages 当前消息数组
   * @param signal 可选的 AbortSignal
   * @returns 摘要字符串（失败/中断时返回空字符串，降级为无摘要）
   */
  private async generateContextSummary(
    messages: readonly Message[],
    signal?: AbortSignal,
  ): Promise<string> {
    // 启动 CONTEXT_SUMMARY span，记录摘要生成的耗时与异常
    const summarySpan = this.tracer.startSpan(TRACE_SPANS.CONTEXT_SUMMARY, {
      messageCount: messages.length,
      summarizingMessages: Math.min(messages.length - 1, LOOP_CONSTANTS.SUMMARY_MSG_COUNT),
    });

    try {
      // signal 已 abort 时直接返回空，不发起 LLM 调用
      if (signal?.aborted) {
        summarySpan.setAttribute('aborted', true);
        return '';
      }

      // C1（ADR-023）：截断时优先复用已存 round-summary，避免现调 LLM 生成上下文摘要
      // 已存摘要是"每轮后台异步生成"的结构化产物，取用零成本、保真；仅无已存摘要才走 LLM。
      if (this.roundSummaryLoader) {
        const existing = this.roundSummaryLoader();
        if (existing) {
          summarySpan.setAttribute('source', 'round-summary');
          logger.debug('上下文截断复用已存 round-summary，跳过 LLM 摘要生成');
          return existing;
        }
      }

      const messagesToSummarize = messages.slice(1);
      const recentMessages = messagesToSummarize
        .filter((m) => m.role === 'user' || (m.role === 'assistant' && typeof m.content === 'string'))
        .slice(-LOOP_CONSTANTS.SUMMARY_MSG_COUNT)
        .map(
          (m) =>
            `${m.role}: ${typeof m.content === 'string' ? m.content.substring(0, LOOP_CONSTANTS.SUMMARY_CONTENT_SLICE) : '[tool]'}`,
        )
        .join('\n');

      if (!recentMessages) {
        summarySpan.setAttribute('skipped', true);
        return '';
      }

      // 选择摘要 Provider（P1-2 多模型路由：有 providerRouter 时走 'summary' 路由）
      const summaryProvider = this.providerRouter
        ? this.providerRouter('summary')
        : this.provider;

      // 将 signal 注入 ChatOptions，让 provider 的 fetch/SSE 能被 abort 中断
      const stream = summaryProvider.chat(
        [
          {
            role: 'system',
            content:
              'Summarize the following conversation excerpt in 1-2 sentences. Focus on key facts, decisions, and user preferences. Be concise.',
          },
          { role: 'user', content: recentMessages },
        ],
        {
          maxTokens: LOOP_CONSTANTS.SUMMARY_MAX_TOKENS,
          temperature: 0,
          signal,
        },
      );
      let summary = '';
      for await (const chunk of stream) {
        // 流读取过程中检查 abort，提前退出（provider 收到 abort 会抛 AbortError 进入 catch）
        if (signal?.aborted) {
          summarySpan.setAttribute('aborted', true);
          break;
        }
        if (chunk.content) summary += chunk.content;
      }
      // 被中断时返回空字符串（降级为无摘要），不缓存
      if (signal?.aborted) {
        return '';
      }
      summarySpan.setAttribute('summaryLength', summary.length);
      logger.info({ summaryLength: summary.length }, '上下文摘要已生成');
      return `[Context summary of earlier conversation]\n${summary}`;
    } catch (err) {
      // AbortError 是用户主动取消，降级为无摘要，不当作错误
      if (isAbortError(err)) {
        summarySpan.setAttribute('aborted', true);
        logger.debug('上下文摘要生成被中断，降级为无摘要');
        return '';
      }
      // 记录异常到 span（不中断 span，标记错误状态）
      summarySpan.recordException(err instanceof Error ? err : new Error(String(err)));
      logger.warn({ err }, '上下文摘要生成失败，降级为无摘要');
      return '';
    } finally {
      // 无论成功/失败都结束 span
      summarySpan.end();
    }
  }
}
