/**
 * Agent Loop — Agent 的核心执行引擎
 *
 * 模型自主决定何时推理、何时调用工具，循环直到输出纯文本
 *
 * 上下文组装公式：
 *   上下文 = 用户主动输入 + Agent 记忆召回结果 + Agent Loop 工作记忆
 * 其中"Agent 记忆召回结果"由 Agent 层通过 processUserInput 的
 * recalledMemories 参数注入。
 */
import type { LlmProvider, Message, ChatOptions } from '@/llm/provider.js';
import type { Memory } from '@/memory/types.js';
import type { ToolDefinition } from '@/agent/toolExecutor.js';
import type { AgentChunk, UIMessages } from '@/agent/types.js';
import type { ITracer, AgentMetrics } from '@/agent/tracer.js';
import { AGENT_CONSTANTS, LOOP_CONSTANTS } from '@/agent/constants.js';
import { ContextManager } from '@/agent/contextManager.js';
import { runGuardrails } from '@/agent/guardrail.js';
import type { GuardrailUI } from '@/agent/guardrail.js';
import { NOOP_TRACER, TRACE_SPANS } from '@/agent/tracer.js';
import { MemoraError, isAbortError, isRetryableErrorCode, toError, type ToolErrorCodeValue } from '@/utils/errors.js';
import { safeSetTimeout } from '@/utils/safeTimer.js';
import { roundTo } from '@/utils/math.js';
import { logger } from '@/logging/logger.js';

export interface AgentLoopOptions {
  provider: LlmProvider;
  bootstrapMemories: Memory[]; // 永驻 + 领域记忆
  toolExecutor: (name: string, args: string) => Promise<string>;
  maxIterations?: number;
  /** 系统 prompt 前缀（角色 + 用户画像 + 技能），注入到 bootstrap 记忆之前 */
  systemPromptPrefix?: string;
  /**
   * 情感基调前缀（Phase 2.1：AffectController 注入）
   *
   * 在 systemPromptPrefix 和 bootstrapMemories 之间插入。
   * 由 Agent.injectAffect() 设置，角色切换时保留。
   */
  affectPrefix?: string;
  /** v4.0：工具定义列表（内置 + 自定义），用于 system prompt 追加工具描述 */
  toolDefinitions?: ToolDefinition[];
  /**
   * 上下文窗口 token 上限（默认 32000）
   *
   * 桌面精灵等长运行场景下，messages 数组随对话轮次无限增长会爆 LLM 上下文窗口。
   * 当估算 token 数超过此阈值时，保留 system prompt + 最近 N 条消息，
   * 裁剪中间段，确保 LLM 请求不因上下文溢出而失败。
   *
   * 保守默认值 32000 token 对多数模型安全（DeepSeek 128K / GPT-4o 128K / 豆包 8K），
   * 宿主可通过 AgentLoopOptions 覆盖。
   */
  maxContextTokens?: number;
  /** 可观测性 Tracer（宿主注入，默认 NOOP_TRACER 静默丢弃所有 span） */
  tracer?: ITracer;
  /**
   * 内容护栏规则（启动时从 configDir 加载的 guardrail 记忆）
   *
   * 每条规则包含 pattern（正则字符串）和 action（block/warn）。
   * 在对话输入和输出阶段分别检查，命中 block 时阻断对话。
   * 护栏自身异常时降级为"放行 + 记日志"，不阻断用户对话。
   */
  guardrailRules?: readonly Memory[];
  /**
   * Reflection（反思/自修正）最大重试次数（默认 2）
   *
   * 当工具执行失败且错误码标记为 retryable 时，
   * AgentLoop 会将错误上下文回传给 LLM 重新尝试，
   * 而非立即结束当前迭代。超过此上限后放弃反思。
   */
  maxReflectionRetries?: number;
  /** 宿主可覆盖的 UI 消息文本（默认英文） */
  messages?: UIMessages;
  /**
   * 上下文超限时是否自动生成摘要（默认 true）
   *
   * 开启后，当消息历史超过 maxContextTokens 时，
   * 会对被裁剪的消息调用 provider 生成一段摘要注入到系统提示中，
   * 避免关键信息永久丢失。（首次触发时增加 ~1-2s 延迟）
   */
  enableContextSummary?: boolean;
  /**
   * 上下文截断回调（宿主可据此发射 contextTruncated 事件通知用户）
   *
   * 每次 truncateMessages 触发截断时调用，传入被裁剪和保留的消息数量。
   * 未注入时静默忽略。
   */
  onContextTruncated?: (skippedCount: number, keptCount: number) => void;
  /**
   * 护栏规则正则编译失败回调（宿主可据此发射 guardrailError 事件通知用户）
   *
   * 每次 runGuardrails 遇到正则编译异常时调用。
   * 未注入时仅记日志（降级优先原则，不阻断对话）。
   */
  onGuardrailError?: (rule: string, message: string) => void;
}

/** callLlmWithRetry 的返回结果 */
interface LlmCallResult {
  fullContent: string;
  toolCalls: Message['toolCalls'];
  aborted: boolean;
}

export class AgentLoop {
  private messages: Message[] = [];
  private readonly maxIterations: number;
  /** 上下文窗口 token 上限（默认 32000，约 96K 中文字符） */
  private readonly maxContextTokens: number;
  /** 可观测性 Tracer（默认 NOOP_TRACER 零开销） */
  private readonly tracer: ITracer;
  /** 内容护栏规则（启动时加载，运行时不可变） */
  private readonly guardrailRules: readonly Memory[];
  /** Reflection 最大重试次数（默认 2） */
  private readonly maxReflectionRetries: number;
  /**
   * 当前轮次已推送的 REFLECTION_HINT 次数（显式计数器）
   *
   * 替代旧实现通过 messages.filter(startsWith('[REFLECTION_HINT]')).length 推断的方式——
   * 当 ContextManager 裁剪中间段消息时，REFLECTION_HINT 可能被裁掉导致计数失真。
   * 显式字段不受 messages 数组变动影响，状态机更健壮。
   */
  private reflectionCountThisTurn: number = 0;
  /** 宿主可覆盖的 UI 消息文本（已填充默认值） */
  private readonly ui: Required<UIMessages>;
  /** 护栏规则正则编译失败回调（从 opts.onGuardrailError 提取，用于 GuardrailUI） */
  private readonly guardrailUI: GuardrailUI;
  /** 上下文超限时是否自动生成摘要 */
  private readonly enableContextSummary: boolean;
  /** 上下文管理器（从 loop 提取的 token 估算 + 截断 + 摘要职责） */
  private readonly contextManager: ContextManager;

  // ─── 运行时指标统计字段 ──────────────────────────
  // 累计值，从 AgentLoop 构造起累加，供 getMetrics() 返回快照。
  // 设计为私有字段而非外部注入，保持 AgentLoop 自洽。

  /** LLM 调用总次数（含重试，每次 provider.chat 调用 +1） */
  private metricLlmCallCount: number = 0;
  /** 累计输入 token 数（基于 estimateTokens 粗略估算） */
  private metricTotalInputTokens: number = 0;
  /** 累计输出 token 数（基于 estimateTokens 粗略估算） */
  private metricTotalOutputTokens: number = 0;
  /** 记忆召回总次数（每轮 processUserInput +1） */
  private metricRecallTotalCount: number = 0;
  /** 记忆召回命中次数（召回结果非空 +1） */
  private metricRecallHitCount: number = 0;
  /** 工具调用总次数 */
  private metricToolCallCount: number = 0;
  /** 工具调用失败次数（结果以 [ERR 开头） */
  private metricToolFailureCount: number = 0;
  // metricTruncationCount 已移至 ContextManager.truncationCount

  constructor(private readonly opts: AgentLoopOptions) {
    this.maxIterations = opts.maxIterations ?? 20;
    this.maxContextTokens = opts.maxContextTokens ?? AGENT_CONSTANTS.DEFAULT_MAX_CONTEXT_TOKENS;
    this.tracer = opts.tracer ?? NOOP_TRACER;
    this.guardrailRules = opts.guardrailRules ?? [];
    this.maxReflectionRetries = opts.maxReflectionRetries ?? 2;
    this.ui = {
      abortedByUser: opts.messages?.abortedByUser ?? 'User cancelled the conversation',
      maxIterationsReached: opts.messages?.maxIterationsReached ?? '\n\n[Max iterations reached]',
      // 流式中断标记，追加到中断时已生成的部分文本末尾
      interrupted: opts.messages?.interrupted ?? '\n\n[已中断]',
      contextTruncated:
        opts.messages?.contextTruncated ??
        ((skipped, kept) =>
          `[Context window management] ${skipped} earlier messages have been trimmed to maintain conversation flow. ${kept} recent messages are preserved along with the full system prompt. Ask the user if you need to review earlier content.`),
      recentConversationLabel: opts.messages?.recentConversationLabel ?? '[Recent conversation]',
      userLabel: opts.messages?.userLabel ?? 'User',
      assistantLabel: opts.messages?.assistantLabel ?? 'Assistant',
      inputBlockedByGuard:
        opts.messages?.inputBlockedByGuard ??
        ((rule: string) => `Input blocked by guardrail rule "${rule}"`),
      guardrailWarningPrefix: opts.messages?.guardrailWarningPrefix ?? '[Guardrail Warning]',
      outputBlockedByGuard:
        opts.messages?.outputBlockedByGuard ??
        ((rule: string) => `Output blocked by guardrail rule "${rule}"`),
    };
    this.enableContextSummary = opts.enableContextSummary ?? true;

    // 护栏规则正则编译失败回调（从 opts 提取，供 GuardrailUI 使用）
    this.guardrailUI = {
      inputBlockedByGuard: this.ui.inputBlockedByGuard,
      onRegexError: opts.onGuardrailError,
    };

    // 上下文管理器（token 估算 + 截断 + 摘要）
    // 注入 tracer，让 generateContextSummary 有 span 埋点
    this.contextManager = new ContextManager({
      maxContextTokens: this.maxContextTokens,
      provider: opts.provider,
      contextTruncatedFn: this.ui.contextTruncated,
      tracer: this.tracer,
      onContextTruncated: opts.onContextTruncated,
    });

    // 初始化 system prompt（基于永驻记忆，加前缀）
    const prefix = opts.systemPromptPrefix ?? '';
    this.messages.push({
      role: 'system',
      content: prefix + this.buildSystemPrompt(opts.bootstrapMemories),
    });
  }

  /**
   * 处理一轮用户输入（编排方法）
   *
   * 拆分为 4 个子方法：
   *   - handleRecallAndInputGuard：召回注入 + 输入护栏
   *   - handleIteration：单次迭代编排（abort 检查 + LLM 调用 + 分支路由）
   *   - handleToolCalls：工具调用分支 + Reflection
   *   - handleTextResponse：纯文本结束 + 输出护栏
   *
   * @param userInput - 用户原始输入
   * @param recalledMemories - 记忆召回结果（Agent.memory.search() 产出），
   *   可选。传入时自动注入到上下文，实现"Agent 记忆召回结果"层
   * @param signal - 可选的 AbortSignal，用于取消正在进行的对话
   *   泊文等宿主 UI 传入 AbortController.signal，用户点击"取消"时触发 abort
   */
  async *processUserInput(
    userInput: string,
    recalledMemories?: readonly Memory[],
    signal?: AbortSignal,
  ): AsyncGenerator<AgentChunk, void, unknown> {
    // 创建顶层 response span，由 try/finally 统一管理生命周期
    const responseSpan = this.tracer.startSpan(TRACE_SPANS.RESPONSE, {
      inputLength: userInput.length,
    });

    try {
      // 1. 召回注入 + 输入护栏（返回 true 表示已 block 并 yield done，应 return）
      if (yield* this.handleRecallAndInputGuard(userInput, recalledMemories)) return;

      // 2. 用户消息 push（安全规范 §6：用 <user_input> 标签包裹，增强 LLM 对注入攻击的免疫力）
      this.messages.push({ role: 'user', content: `<user_input>${userInput}</user_input>` });

      // 重置当前轮次的反思计数器（每轮用户输入独立计算反思次数）
      this.reflectionCountThisTurn = 0;

      // 3. 迭代循环
      let iteration = 0;
      while (iteration < this.maxIterations) {
        iteration++;
        const result = yield* this.handleIteration(iteration, signal);
        if (result === 'aborted' || result === 'done') return;
      }

      // 4. 最大迭代兜底
      logger.warn({ iterations: iteration }, '达到最大迭代次数');
      yield { type: 'text', content: this.ui.maxIterationsReached };
      yield { type: 'done' };
    } finally {
      responseSpan.end();
    }
  }

  /**
   * 召回注入 + 输入护栏（processUserInput 子方法 1/4）
   *
   * 职责：
   *   - 注入记忆召回结果（system 消息，优先级高、不污染 user 输入）
   *   - 召回命中率统计（metricRecallTotalCount / metricRecallHitCount）
   *   - 通知上层 UI 召回透明度（yield recall chunk）
   *   - 输入护栏检查（block 时 yield text + done，warn 时 yield text）
   *
   * @yields recall / text（guardrail block/warn）/ done（block 时）
   * @returns true 表示输入被 block 已 yield done，调用方应 return；false 表示继续
   */
  private async *handleRecallAndInputGuard(
    userInput: string,
    recalledMemories: readonly Memory[] | undefined,
  ): AsyncGenerator<AgentChunk, boolean, unknown> {
    // 注入记忆召回结果（agent上下文组装协议 §1：Agent 记忆召回结果层）
    const recallSpan = this.tracer.startSpan(TRACE_SPANS.RECALL, {
      recallCount: recalledMemories?.length ?? 0,
    });
    // 将召回记忆以 system 消息注入（优先级高、不污染 user 输入）
    if (recalledMemories?.length) {
      this.injectRecallAsSystem(recalledMemories);
    }
    // 补充 span 属性：让宿主监控面板能按命中/未命中过滤
    recallSpan.setAttribute('hit', recalledMemories !== undefined && recalledMemories.length > 0);
    recallSpan.end();

    // 召回命中率统计：每轮对话算一次召回，结果非空算命中
    this.metricRecallTotalCount++;
    if (recalledMemories && recalledMemories.length > 0) {
      this.metricRecallHitCount++;
    }

    // 有记忆召回时，通知上层（用于 UI 展示"召回透明度"——记忆名称 + 相似度）
    // 暴露 id/name/score/source 摘要，不泄露完整 content
    if (recalledMemories?.length) {
      yield {
        type: 'recall',
        memories: recalledMemories.map((m) => ({
          id: m.id,
          name: m.name,
          score: m.score,
          source: m.source,
        })),
      };
    }

    // 输入护栏检查：在用户输入注入上下文之前，检查是否命中护栏规则
    // 护栏自身异常时降级为"放行 + 记日志"，不阻断用户对话
    const inputGuardSpan = this.tracer.startSpan(TRACE_SPANS.GUARDRAIL_INPUT, {
      ruleCount: this.guardrailRules.length,
    });
    const inputGuardResult = runGuardrails(this.guardrailRules, userInput, this.guardrailUI);
    inputGuardSpan.setAttribute('blocked', inputGuardResult.blocked);
    inputGuardSpan.setAttribute('warned', !!inputGuardResult.warning);
    inputGuardSpan.end();

    if (inputGuardResult.blocked) {
      // P3: try/finally 确保 done 一定送达，即使 text yield 异常
      // guardrailBlocked: true 让 eval 框架和宿主 UI 通过结构化字段判断护栏触发
      try {
        yield {
          type: 'text',
          content: inputGuardResult.message ?? 'Input blocked by guardrail',
          guardrailBlocked: true,
        };
      } finally {
        yield { type: 'done' };
      }
      return true;
    }
    if (inputGuardResult.warning) {
      // warn 级别只通知，不阻断
      yield {
        type: 'text',
        content: `${this.ui.guardrailWarningPrefix} ${inputGuardResult.warning}`,
      };
    }
    return false;
  }

  /**
   * 单次迭代编排（processUserInput 子方法 2/4）
   *
   * 职责：
   *   - abort 检查
   *   - 上下文摘要 + 截断
   *   - LLM 调用（callLlmWithRetry）
   *   - LLM 中断处理
   *   - 分支路由：工具调用 → handleToolCalls；纯文本 → handleTextResponse
   *
   * @yields text / aborted / done（由子方法委托）
   * @returns 'aborted' | 'done' | 'continue'（continue 表示继续下一轮迭代）
   */
  private async *handleIteration(
    iteration: number,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<AgentChunk, 'aborted' | 'done' | 'continue', unknown> {
    logger.debug({ iteration, messageCount: this.messages.length }, 'Agent Loop 迭代');

    // 每次迭代前检查是否已被取消
    if (signal?.aborted) {
      yield { type: 'aborted', reason: this.ui.abortedByUser };
      return 'aborted';
    }

    // 调用 LLM（带重试 + 截断保护）
    const chatOpts = this.buildChatOptions();

    // 上下文摘要：如果启用且首次截断，生成摘要
    let contextSummary: string | undefined;
    if (
      this.enableContextSummary &&
      this.contextManager.shouldTruncate(this.messages)
    ) {
      // 摘要缓存管理已移至 ContextManager.getOrCreateSummary
      // 传入 signal，让摘要生成可被用户取消中断（避免 generator 挂起）
      contextSummary = await this.contextManager.getOrCreateSummary(this.messages, signal);
    }
    const safeMessages = this.contextManager.truncateMessages(this.messages, contextSummary);
    // 截断后同步替换工作记忆，防止 messages 数组无限增长
    // 持久化由 MessageHistory 负责，工作记忆只需保留当前上下文窗口内的消息
    if (safeMessages !== this.messages) {
      this.messages = [...safeMessages];
    }

    const llmResult: LlmCallResult = yield* this.callLlmWithRetry(safeMessages, chatOpts, signal, iteration);

    if (llmResult.aborted) {
      // LLM 调用中断时仍保留已生成的部分文本到上下文消息列表
      // 让下一轮 LLM 能看到中断响应（追加 interrupted 标记让 LLM 识别非完整回复）
      // 注意：工具调用中断（execResult.aborted）不在此处理，因 executeToolCalls
      // 已 push assistant（含 toolCalls），追加文本标记会破坏工具调用结构
      if (llmResult.fullContent.trim()) {
        this.messages.push({
          role: 'assistant',
          content: llmResult.fullContent + this.ui.interrupted,
        });
      }
      yield { type: 'aborted', reason: this.ui.abortedByUser };
      return 'aborted';
    }

    // 工具调用分支
    if (llmResult.toolCalls && llmResult.toolCalls.length > 0) {
      return yield* this.handleToolCalls(llmResult, signal);
    }

    // 纯文本结束分支
    return yield* this.handleTextResponse(llmResult);
  }

  /**
   * 工具调用分支 + Reflection（processUserInput 子方法 3/4）
   *
   * 职责：
   *   - executeToolCalls 执行工具调用
   *   - abort 检查（工具执行中断）
   *   - Reflection：检查可重试错误，追加反思提示
   *
   * @yields aborted（工具执行中断时）
   * @returns 'aborted' | 'continue'（continue 表示工具结果已回填，继续下一轮 LLM 调用）
   */
  private async *handleToolCalls(
    llmResult: LlmCallResult,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<AgentChunk, 'aborted' | 'continue', unknown> {
    const execResult = yield* this.executeToolCalls(
      llmResult.toolCalls!,
      llmResult.fullContent,
      signal,
    );
    if (execResult.aborted) {
      yield { type: 'aborted', reason: this.ui.abortedByUser };
      return 'aborted';
    }

    // Reflection（反思/自修正）：检查是否有可重试的错误
    // 如果工具结果中有 retryable 错误，在 LLM 上下文中追加反思提示
    // 帮助 LLM 聚焦于修正而非放弃
    const hasRetryableError = this.messages
      .slice(-llmResult.toolCalls!.length) // 只看本轮工具结果
      .some((m) => m.role === 'tool' && this.isRetryableToolError(m.content));
    if (hasRetryableError) {
      // 反思次数限制：使用显式计数器，避免 messages 裁剪导致计数失真
      if (this.reflectionCountThisTurn < this.maxReflectionRetries) {
        this.reflectionCountThisTurn++;
        this.messages.push({
          role: 'system',
          content: `[REFLECTION_HINT] 上次工具调用失败，错误可重试。请分析错误原因，修正参数后重新调用工具。剩余反思次数：${this.maxReflectionRetries - this.reflectionCountThisTurn}`,
        });
      }
    }

    // 继续循环：把工具结果回填给 LLM
    return 'continue';
  }

  /**
   * 纯文本结束 + 输出护栏（processUserInput 子方法 4/4）
   *
   * 职责：
   *   - push assistant 消息（含空响应兜底）
   *   - 输出护栏检查（block 时 yield text + done，warn 时 yield text）
   *   - yield done 结束本轮对话
   *
   * @yields text（空响应兜底 / guardrail block/warn）/ done
   * @returns 'done'（调用方收到后 return）
   */
  private async *handleTextResponse(
    llmResult: LlmCallResult,
  ): AsyncGenerator<AgentChunk, 'done', unknown> {
    // 输出护栏检查：在响应返回给用户之前，检查是否命中护栏规则
    // 注意：护栏检查必须在 messages.push 之前执行，否则被 block 的内容仍会进入下一轮 LLM 上下文
    const outputGuardSpan = this.tracer.startSpan(TRACE_SPANS.GUARDRAIL_OUTPUT, {
      ruleCount: this.guardrailRules.length,
    });
    const outputGuardResult = runGuardrails(this.guardrailRules, llmResult.fullContent, this.guardrailUI);
    outputGuardSpan.setAttribute('blocked', outputGuardResult.blocked);
    outputGuardSpan.setAttribute('warned', !!outputGuardResult.warning);
    outputGuardSpan.end();

    if (outputGuardResult.blocked) {
      // P3: try/finally 确保 done 一定送达，即使 text yield 异常
      // guardrailBlocked: true 让 eval 框架和宿主 UI 通过结构化字段判断护栏触发
      // block 时不 push 到 messages——被 block 的内容不应进入下一轮 LLM 上下文
      try {
        yield {
          type: 'text',
          content: outputGuardResult.message ?? 'Output blocked by guardrail',
          guardrailBlocked: true,
        };
      } finally {
        yield { type: 'done' };
      }
      return 'done';
    }

    // 护栏通过后再 push 到对话历史——确保被 block/warn 的内容不污染 LLM 上下文
    if (llmResult.fullContent) {
      this.messages.push({ role: 'assistant', content: llmResult.fullContent });
    } else {
      // LLM 返回空响应（既无文本也无工具调用）的兜底处理
      // 正常 LLM 不会返回空响应，但某些 provider 异常/边界情况下可能发生
      logger.warn('LLM 返回空响应（无文本、无工具调用），使用兜底提示');
      const fallbackText = '（模型未返回有效内容，请重试或换一种方式提问）';
      this.messages.push({ role: 'assistant', content: fallbackText });
      yield { type: 'text', content: fallbackText };
    }

    if (outputGuardResult.warning) {
      yield {
        type: 'text',
        content: `${this.ui.guardrailWarningPrefix} ${outputGuardResult.warning}`,
      };
    }

    yield { type: 'done' };
    return 'done';
  }

  /**
   * 调用 LLM（带指数退避重试）
   *
   * 仅在流式输出前失败时重试（streamStarted = false），
   * 流式已开始则直接向上抛出（用户已看到部分结果）。
   *
   * @param safeMessages - 截断后的消息数组
   * @param chatOpts - LLM 调用选项
   * @param signal - 可选的 AbortSignal
   * @param iteration - 当前迭代次数（用于 tracing）
   * @yields AgentChunk 文本片段
   * @returns LLM 调用结果（fullContent + toolCalls + aborted 状态）
   */
  private async *callLlmWithRetry(
    safeMessages: readonly Message[],
    chatOpts: ChatOptions,
    signal: AbortSignal | undefined,
    iteration: number,
  ): AsyncGenerator<AgentChunk, LlmCallResult, unknown> {
    let fullContent = '';
    let toolCalls: Message['toolCalls'] = undefined;
    let streamStarted = false;
    let lastError: Error | null = null;
    let aborted = false;

    // 将 AbortSignal 和超时配置传入 provider，
    // 确保 fetch 请求和 SSE 流读取都能被及时中断（用户取消/超时）
    const effectiveOpts: ChatOptions = {
      ...chatOpts,
      signal,
      timeoutMs: LOOP_CONSTANTS.LLM_TIMEOUT_MS,
    };

    // LLM 调用 Span（涵盖重试循环）
    const llmSpan = this.tracer.startSpan(TRACE_SPANS.LLM_CALL, {
      model: this.opts.provider.name,
      messageCount: safeMessages.length,
      iteration,
    });
    // 补充 span 属性：让宿主监控面板能按 token 消耗过滤
    llmSpan.setAttribute('inputTokens', this.contextManager.estimateTokens(safeMessages));

    for (let attempt = 0; attempt <= LOOP_CONSTANTS.MAX_LLM_RETRIES; attempt++) {
      // 每次重试前检查是否已被取消（用户点击停止）
      if (signal?.aborted) {
        aborted = true;
        break;
      }

      if (attempt > 0) {
        // 仅在流式输出前失败时重试（streamStarted = false）
        const delay = LOOP_CONSTANTS.RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        logger.warn({ attempt, delay, error: lastError?.message }, 'LLM 调用失败，重试中');
        // 发射 retry chunk：让宿主 UI 显示"网络波动，重试中 N/M..."，消除 3 秒静默
        yield {
          type: 'retry',
          attempt,
          maxRetries: LOOP_CONSTANTS.MAX_LLM_RETRIES,
          delayMs: delay,
          error: lastError?.message ?? 'unknown error',
        };
        // 重试延迟期间支持 abort：用 Promise.race 替代单纯的 setTimeout
        await new Promise<void>((resolve) => {
          if (signal?.aborted) {
            resolve();
            return;
          }
          const timeoutId = safeSetTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
          }, delay);
          const onAbort = () => {
            clearTimeout(timeoutId);
            resolve();
          };
          signal?.addEventListener('abort', onAbort, { once: true });
        });
        fullContent = '';
        toolCalls = undefined;
        // 延迟后再次检查 abort
        if (signal?.aborted) {
          aborted = true;
          break;
        }
      }

      try {
        // LLM 指标统计：每次 provider.chat 调用 +1，输入 token 累计
        this.metricLlmCallCount++;
        this.metricTotalInputTokens += this.contextManager.estimateTokens(safeMessages);

        // safeMessages 为 readonly Message[]，provider.chat 期望 Message[]；
        // 通过浅拷贝转换为可变数组，避免类型断言。
        for await (const chunk of this.opts.provider.chat([...safeMessages], effectiveOpts)) {
          streamStarted = true;
          if (signal?.aborted) {
            aborted = true;
            break;
          }
          if (chunk.content) {
            fullContent += chunk.content;
            yield { type: 'text', content: chunk.content };
          }
          if (chunk.toolCalls) {
            toolCalls = [...(toolCalls ?? []), ...chunk.toolCalls];
          }
        }
        // 输出 token 统计：成功时累计输出 token
        this.metricTotalOutputTokens += this.contextManager.estimateTokens([
          { role: 'assistant', content: fullContent },
        ]);
        break; // 成功，退出重试循环
      } catch (err) {
        const e = toError(err);
        lastError = e;

        // AbortError 表示用户主动取消或超时中断，不重试，直接标记 aborted 退出
        // 避免用户点击停止后仍继续发起 LLM 请求，防止 UI 卡在"停止生成"状态
        if (isAbortError(err)) {
          aborted = true;
          break;
        }

        if (streamStarted) {
          // 流式已开始输出，不能重试（用户已看到部分结果），向上抛出
          llmSpan.recordException(e);
          llmSpan.end();
          throw lastError;
        }
        if (attempt >= LOOP_CONSTANTS.MAX_LLM_RETRIES) {
          // 重试次数耗尽
          llmSpan.recordException(e);
          llmSpan.end();
          throw lastError;
        }
        // 继续重试（超时/网络错误等在流式开始前均可重试）
      }
    }

    if (aborted) {
      llmSpan.end();
      return { fullContent, toolCalls, aborted: true };
    }

    // LLM 调用成功，结束 span
    llmSpan.end();
    return { fullContent, toolCalls, aborted: false };
  }

  /**
   * 执行工具调用列表
   *
   * 遍历 LLM 返回的 toolCalls，逐个执行并收集结果。
   * 工具执行异常会被捕获并转为结构化错误字符串回传给 LLM，
   * 而非直接中断对话。
   *
   * @param toolCalls - LLM 返回的工具调用列表
   * @param fullContent - LLM 返回的文本内容
   * @param signal - 可选的 AbortSignal
   * @yields AgentChunk 工具开始/结果片段
   * @returns 执行结果（aborted 状态）
   */
  private async *executeToolCalls(
    toolCalls: NonNullable<Message['toolCalls']>,
    fullContent: string,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<AgentChunk, { aborted: boolean }, unknown> {
    this.messages.push({
      role: 'assistant',
      content: fullContent,
      toolCalls,
    });

    // 执行工具（E-803 并行优化：独立 tool_call 并发执行，事件按原始顺序 yield）
    // 设计：方案 B（保持顺序的并发）
    //   - 并发发起所有工具执行（Promise.all，真并发，总耗时 ≈ 最慢的工具）
    //   - 批量 yield tool_start（UI 按 toolCallId 创建所有工具卡片）
    //   - 按原始顺序 push messages + yield tool_result（保证 Reflection slice(-N) 正确）
    //   - messages 顺序确定 → Reflection 的 slice(-toolCalls.length) 仍取到本轮完整结果
    //   - 宿主 UI 按 toolCallId 配对 tool_start/tool_result，不依赖严格交替顺序

    // 执行前检查取消（批量，避免 abort 后还发起工具）
    if (signal?.aborted) {
      return { aborted: true };
    }

    // 1. 批量 yield tool_start + 并发发起所有工具执行
    const toolPromises: Promise<string>[] = [];
    for (const tc of toolCalls) {
      // 工具调用统计：每次工具执行 +1
      this.metricToolCallCount++;
      yield { type: 'tool_start', toolCallId: tc.id, name: tc.function.name, args: tc.function.arguments };
      // 并发发起工具执行（不 await，收集 Promise 由 Promise.all 统一等待）
      toolPromises.push(this.executeOneTool(tc, signal));
    }

    // 2. 等待全部工具完成（真并发，总耗时 ≈ 最慢的工具而非所有工具之和）
    const results = await Promise.all(toolPromises);

    // 3. 按原始顺序 push messages + yield tool_result
    //    顺序确定保证：Reflection 的 slice(-toolCalls.length) 能取到本轮完整结果
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i]!;
      const result = results[i]!;
      this.messages.push({
        role: 'tool',
        content: result,
        toolCallId: tc.id,
      });
      // 工具失败统计：结果以 [ERR 开头算失败
      if (result.startsWith('[ERR')) {
        this.metricToolFailureCount++;
      }
      yield {
        type: 'tool_result',
        toolCallId: tc.id,
        name: tc.function.name,
        ok: !result.startsWith('[ERR'),
        summary: result.slice(0, 100),
      };
    }

    // 循环结束后再次检查 abort 状态
    // 场景：最后一个工具执行期间 signal 被 abort，raceToolWithSignal 返回 [ERR:TOOL:ABORTED]，
    // 循环自然结束，但若不检查则会返回 aborted:false，导致 processUserInput 进入下一轮 LLM 调用（浪费资源）
    if (signal?.aborted) {
      return { aborted: true };
    }
    return { aborted: false };
  }

  /**
   * 工具执行与 signal abort 的竞争包裹
   *
   * 背景：toolExecutor 签名 (name, args) => Promise<string> 不接受 signal 参数，
   *   无法真正中断正在执行的工具。原代码直接 await toolExecutor(...)，
   *   工具卡住时 generator 永久挂起，导致 _chatBusy 锁泄漏、UI 全阻塞。
   *
   * 方案：用 Promise.race 让 toolExecutor 与 signal abort 监听竞争
   *   - 工具先完成：返回工具结果字符串（原行为）
   *   - signal 先 abort：返回 [ERR:TOOL:ABORTED] 错误字符串，
   *     让 executeToolCalls 不再 await 工具（工具仍在后台运行，但 generator 解除阻塞）
   *
   * 设计权衡：
   *   - 不改 toolExecutor 签名（82 处测试用例依赖此签名，保持向后兼容）
   *   - 不抛 AbortError（避免破坏 executeToolCalls 的 try/catch 错误回传 LLM 契约）
   *   - 返回错误字符串符合现有"工具失败回传 LLM"契约（[ERR:TOOL:code] 前缀）
   *   - ABORTED 不进入 ToolErrorCode 体系（用户主动取消非工具失败，不触发 Reflection）
   *
   * @param name 工具名称
   * @param args 工具参数 JSON 字符串
   * @param signal 可选的 AbortSignal
   * @returns 工具结果字符串，或 [ERR:TOOL:ABORTED] 表示被中断
   */
  private async raceToolWithSignal(
    name: string,
    args: string,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    // 无 signal 时直接执行工具（保持原行为，测试场景常用）
    if (!signal) {
      return this.opts.toolExecutor(name, args);
    }

    // signal 已 abort：直接返回中断错误，不发起工具调用
    if (signal.aborted) {
      return '[ERR:TOOL:ABORTED] 错误：工具执行被中断';
    }

    // 创建 abort 监听 Promise（signal abort 时 resolve 错误字符串）
    // onAbort 提到外层，便于 race 结束后清理监听器
    let onAbort: (() => void) | null = null;
    const abortPromise = new Promise<string>((resolve) => {
      onAbort = () => resolve('[ERR:TOOL:ABORTED] 错误：工具执行被中断');
      signal.addEventListener('abort', onAbort, { once: true });
    });

    // Promise.race 竞争：工具先完成返回结果，signal 先 abort 返回错误字符串
    // race 结束后清理监听器，避免 N 次并发工具调用累积 N 个残留监听器
    // （{ once: true } 只保证触发一次，不保证未触发时被移除）
    return Promise.race([
      this.opts.toolExecutor(name, args),
      abortPromise,
    ]).finally(() => {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    });
  }

  /**
   * 执行单个工具（E-803 抽取：为并行化提供独立执行单元）
   *
   * 职责：
   *   - startSpan / endSpan（工具执行 Span，并发时 span 时间重叠，可观测性改进）
   *   - raceToolWithSignal 竞争包裹（兼容 signal 中断，每个工具独立 race）
   *   - 异常捕获并转为结构化错误字符串（[ERR:TOOL:code] 前缀，供 Reflection 解析）
   *
   * 不含职责（由 executeToolCalls 主循环控制，保证顺序确定）：
   *   - yield tool_start / tool_result（事件顺序由主循环批量 yield 保证）
   *   - messages.push（消息顺序由主循环按原始顺序 push，确保 Reflection slice 正确）
   *   - metricToolCallCount / metricToolFailureCount（统计由主循环控制）
   *
   * 并发安全：本方法无共享状态，多个 executeOneTool 可同时执行。
   * toolExecutor 内部无状态（纯分发 + 参数校验），天然支持并发调用。
   *
   * @param tc 单个工具调用描述（id + function.name + function.arguments）
   * @param signal 可选的 AbortSignal
   * @returns 工具结果字符串（成功）或 [ERR:TOOL:code] 错误字符串（失败）
   */
  private async executeOneTool(
    tc: { id: string; type: 'function'; function: { name: string; arguments: string } },
    signal: AbortSignal | undefined,
  ): Promise<string> {
    // 工具执行 Span（并发时多个 span 时间重叠，tracer 可观测并发度）
    const toolSpan = this.tracer.startSpan(TRACE_SPANS.TOOL_EXEC, {
      toolName: tc.function.name,
    });

    try {
      // 工具执行包裹 signal 中断，避免 abort 无法中断卡住的 generator
      // raceToolWithSignal 天然兼容并发：每个调用独立 race，{ once: true } 监听器无副作用
      return await this.raceToolWithSignal(tc.function.name, tc.function.arguments, signal);
    } catch (err) {
      // 工具执行可能因文件不存在、路径越界等原因失败
      // 捕获异常并转为结构化错误结果字符串，回传给 LLM 让其自行调整策略
      // 避免错误直接传播到 agent.chat() 导致整个对话中断
      const e = toError(err);
      toolSpan.recordException(e);
      if (err instanceof MemoraError) {
        const code = err.errorCode ?? 'UNKNOWN';
        const result = `[ERR:TOOL:${code}] 错误：${err.title}${err.detail ? ` — ${err.detail}` : ''}`;
        logger.warn(
          { tool: tc.function.name, errorCode: code, title: err.title },
          '工具执行失败，错误已回传给 LLM',
        );
        return result;
      } else {
        const result = `[ERR:TOOL:UNKNOWN] 错误：工具执行异常 — ${e.message}`;
        logger.error({ tool: tc.function.name, err }, '工具执行异常');
        return result;
      }
    } finally {
      toolSpan.end();
    }
  }

  /**
   * 构建 system prompt（注入人格 + 规则 + 领域 + 工具描述）
   */
  private buildSystemPrompt(memories: Memory[]): string {
    const sections = memories.map((m) => `## ${m.name}\n\n${m.content}`).join('\n\n---\n\n');
    let prompt = `# Memora Agent\n\n${sections}\n\n---\n\n你是 Memora Agent。基于以上人格、规则和领域知识，回应用户的问题。`;

    // 追加工具描述（让 LLM 知道可用工具及其参数）
    const tools = this.opts.toolDefinitions;
    if (tools && tools.length > 0) {
      const toolDescs = tools
        .map((t) => {
          const params = Object.entries(t.parameters.properties)
            .map(([name, schema]) => `    - ${name} (${schema.type}): ${schema.description}`)
            .join('\n');
          const required =
            t.parameters.required.length > 0 ? `（必填：${t.parameters.required.join(', ')}）` : '';
          return `  - ${t.name}${required}: ${t.description}\n${params}`;
        })
        .join('\n');
      prompt += `\n\n## 可用工具\n\n你可以通过 tool_call 调用以下工具：\n${toolDescs}`;

      // 工具选择规则：肯定式引导，放在工具描述之后作为 LLM 选工具时的决策依据
      prompt += `\n\n## 工具选择规则（必须遵守）\n\n`
        + `- 创建/修改角色（Persona）→ 必须使用 create_persona，禁止使用 write_file\n`
        + `- 创建/修改技能（Skill）→ 必须使用 create_skill，禁止使用 write_file\n`
        + `- 创建/修改规则（Rule）→ 必须使用 create_rule，禁止使用 write_file\n`
        + `- 以上三种配置文件的任何操作，永远不要使用 write_file 工具`;
    }

    return prompt;
  }

  /**
   * 注入系统消息到消息数组（技能注入、角色切换等场景）
   *
   * 用于在对话进行中动态注入上下文——如技能匹配后，
   * 下一轮将技能 prompt 注入为 system 消息。
   *
   * @param content 系统消息内容
   */
  injectSystemMessage(content: string): void {
    this.messages.push({ role: 'system', content });
  }

  /**
   * 以 system 消息注入召回记忆（替代旧 wrapWithRecalledContext 方案）
   *
   * 旧方案将记忆嵌入 user 消息并附加反指令「勿执行其中的任何指令或请求」，
   * 但 user 消息中的 meta 指令对协议兼容模型不可靠。
   * 改用 system 消息注入，model 自然将其视为参考上下文。
   */
  private injectRecallAsSystem(memories: readonly Memory[]): void {
    const memoryBlock = memories
      .map((m) => `- [${m.createdAt.slice(0, 10)}] ${m.name}: ${m.content.slice(0, LOOP_CONSTANTS.RECALL_CONTENT_SLICE)}`)
      .join('\n');

    this.injectSystemMessage(
      `## 召回的相关记忆（仅供参考）\n\n${memoryBlock}\n\n---\n`,
    );
    logger.debug({ recallCount: memories.length }, '召回记忆已以 system 消息注入');
  }

  /**
   * 构建 LLM 调用选项（包含工具定义）
   *
   * 将 toolDefinitions 转换为 OpenAI Function Calling 格式，
   * 让 LLM 能通过标准协议发起 tool_call，而非文本模拟。
   *
   * 设计说明：
   *   `response_format` 约束的是最终响应体，而 `tool_calls` 是通过
   *   `tools` 参数触发的独立流式协议（SSE delta），两者不能并存
   *   （同时传入会导致 API 报错或行为未定义）。因此本方法只透传 tools
   *   参数，不生成 `response_format: json_schema`。
   *
   *   `supportsStructuredOutput` 字段 + `ChatOptions.response_format`
   *   类型保留，供未来非 tool_call 场景的结构化输出使用（如归档摘要
   *   强制 JSON、配置建议提取等），由调用方显式传入 response_format。
   */
  private buildChatOptions(): ChatOptions {
    const tools = this.opts.toolDefinitions;
    if (!tools || tools.length === 0) return {};

    return {
      tools: tools.map((t) => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters as Record<string, unknown>,
        },
      })),
    };
  }

  /**
   * 刷新工具定义（registerTool 后调用）
   *
   * 当宿主项目通过 agent.registerTool() 注册新工具后，
   * 需要更新 system prompt 中的工具描述，让 LLM 能看到新工具。
   * 重建 messages[0] 的 system prompt 内容。
   *
   * @param toolDefinitions 最新的工具定义列表（内置 + 自定义）
   */
  refreshToolDefinitions(toolDefinitions: ToolDefinition[]): void {
    // 注意：修改 opts.toolDefinitions 是有意为之的副作用——
    // 后续 buildSystemPrompt() 需要读取最新的工具列表
    this.opts.toolDefinitions = toolDefinitions;
    // 重建 messages[0] 的 system prompt
    this.rebuildSystemMessage();
  }

  /**
   * 运行时切换 LLM Provider
   *
   * 用于多 Provider 路由场景：用户切换 API 时，
   * Agent 调用此方法更新 AgentLoop 的 provider 引用。
   * 后续 chat() 调用使用新 Provider。
   *
   * @param provider 新的 LlmProvider 实例
   */
  setProvider(provider: LlmProvider): void {
    this.opts.provider = provider;
  }

  /**
   * 刷新角色 prompt
   *
   * 当角色切换时，更新系统 prompt 前缀的角色部分。
   * 保留 bootstrapMemories 和 toolDefinitions 不变，只替换 prefix。
   *
   * @param newPrefix 新的系统 prompt 前缀（包含新角色 + 用户画像）
   */
  refreshPersonaPrefix(newPrefix: string): void {
    this.opts.systemPromptPrefix = newPrefix;
    this.rebuildSystemMessage();
  }

  /**
   * 刷新 bootstrap 记忆段（设定面板 CRUD 专用）
   *
   * 设定面板对 rule/skill 执行增删改后，调用此方法用最新的记忆数组
   * 重建 system prompt 中的 bootstrap 段，使变更立即对当前会话生效。
   *
   * 与 refreshPersonaPrefix 的区别：
   *   - refreshPersonaPrefix 替换 systemPromptPrefix（角色 + 画像）
   *   - refreshBootstrapMemories 替换 bootstrapMemories（rule + skill）
   *
   * 调用链：ConfigManager.deleteRule/updateRule/deleteSkill
   *   → refreshBootstrapMemories 回调（assembler 注入）
   *   → loop.refreshBootstrapMemories(memories)
   *   → rebuildSystemMessage()
   *
   * @param memories 最新的 rule + skill 活跃记忆数组（由 ConfigManager.getBootstrapMemories 提供）
   */
  refreshBootstrapMemories(memories: Memory[]): void {
    this.opts.bootstrapMemories = memories;
    this.rebuildSystemMessage();
  }

  /**
   * 注入情感基调到 system prompt（Phase 2.1：AffectController）
   *
   * 在角色前缀和 bootstrap 记忆之间插入情感描述文本。
   * 与 refreshPersonaPrefix 独立——角色切换不会清除情感注入。
   *
   * 注入位置：systemPromptPrefix + affectPrefix + bootstrapMemories + toolDefinitions
   *
   * @param affectString 情感描述文本（如"当前对话基调：温暖、直接"），传空字符串清除注入
   */
  injectAffect(affectString: string): void {
    this.opts.affectPrefix = affectString;
    this.rebuildSystemMessage();
  }

  /**
   * 重建 messages[0] 的 system prompt
   */
  private rebuildSystemMessage(): void {
    const sysMsg = this.messages[0];
    if (sysMsg && sysMsg.role === 'system') {
      const prefix = this.opts.systemPromptPrefix ?? '';
      const affect = this.opts.affectPrefix ? `\n${this.opts.affectPrefix}\n` : '';
      this.messages[0] = {
        role: 'system',
        content: prefix + affect + this.buildSystemPrompt(this.opts.bootstrapMemories),
      };
    }
  }

  /**
   * 获取消息历史（用于持久化）
   */
  getMessages(): readonly Message[] {
    return this.messages;
  }

  /**
   * 获取 AgentLoop 运行时指标快照（可观测性增强）
   *
   * 返回 LLM 调用、记忆召回、工具调用、上下文管理四个维度的累计指标。
   * 衰减指标（decay）由 Agent 层填充，此处返回 null。
   *
   * 纯只读、同步、零副作用——适合宿主项目定期轮询构建监控面板。
   *
   * @returns AgentMetrics 快照（decay 字段为 null，由 Agent 层填充）
   */
  getMetrics(): AgentMetrics {
    // 计算召回命中率：totalCount 为 0 时返回 0，避免除零
    const hitRate = this.metricRecallTotalCount > 0
      ? this.metricRecallHitCount / this.metricRecallTotalCount
      : 0;

    return {
      llm: {
        callCount: this.metricLlmCallCount,
        totalInputTokens: this.metricTotalInputTokens,
        totalOutputTokens: this.metricTotalOutputTokens,
      },
      recall: {
        totalCount: this.metricRecallTotalCount,
        hitCount: this.metricRecallHitCount,
        hitRate: roundTo(hitRate, 3), // 保留 3 位小数
      },
      tools: {
        callCount: this.metricToolCallCount,
        failureCount: this.metricToolFailureCount,
      },
      context: {
        truncationCount: this.contextManager.truncationCount,
        messageCount: this.messages.length,
        estimatedTokens: this.contextManager.estimateTokens(this.messages),
      },
      // 衰减指标由 Agent 层填充，AgentLoop 不持有衰减逻辑
      decay: null,
    };
  }

  /**
   * 获取最近 N 轮对话（Layer 5: 最近对话注入）
   *
   * 从 messages 数组中提取最近 N 轮 user + assistant 消息，
   * 用于注入 system prompt，让 LLM 在用户输入无信息量时仍能看到上下文。
   *
   * @param rounds - 要获取的轮次数（默认 3）
   * @returns 最近 N 轮的 user + assistant 消息数组
   */
  getRecentHistory(rounds = 3): Array<{ role: 'user' | 'assistant'; content: string }> {
    // 过滤出 user + assistant 消息（排除 system 和 tool）
    const conversationMessages = this.messages.filter(
      (m): m is { role: 'user' | 'assistant'; content: string } =>
        m.role === 'user' || m.role === 'assistant',
    );

    // 取最后 N 轮（每轮 = 1 user + 1 assistant，共 2 条消息）
    const recentMessages = conversationMessages.slice(-rounds * 2);

    return recentMessages.map((m) => ({
      role: m.role,
      content: m.content,
    }));
  }

  /**
   * 恢复历史消息（用于重启后恢复对话）
   * 会跳过 system 消息，只恢复 user/assistant/tool 消息
   *
   * @param historyMessages - 要恢复的历史消息列表
   */
  restoreHistory(historyMessages: readonly Message[]): void {
    // 过滤掉 system 消息（我们已经有初始化的 system prompt 了）
    const nonSystemMessages = historyMessages.filter((m) => m.role !== 'system');

    if (nonSystemMessages.length === 0) {
      logger.debug({ messageCount: 0 }, '没有需要恢复的历史消息');
      return;
    }

    // 保持第一条消息是 system prompt（构造函数保证 messages[0] 存在）
    const systemPrompt = this.messages[0];
    if (!systemPrompt) {
      logger.warn({ hasSystemPrompt: false }, 'restoreHistory: 没有 system prompt，跳过恢复');
      return;
    }
    this.messages = [systemPrompt, ...nonSystemMessages];

    logger.info({ messageCount: nonSystemMessages.length }, '恢复历史对话消息');
  }

  /**
   * 清理上一轮对话注入的临时 system 消息
   *
   * 每轮 chat() 前调用，仅保留 messages[0]（永久 system prompt）和
   * 所有 user/assistant/tool 消息（对话历史）。
   * 防止 recallAndInject() / injectActiveSkill() / truncateMessages()
   * 累积的临时 system 消息堆叠，避免 LLM 收到大量冗余指令。
   */
  cleanTemporarySystemMessages(): void {
    if (this.messages.length <= 1) return;
    const permanent = this.messages[0]!;
    const conversationHistory = this.messages.slice(1).filter((m) => m.role !== 'system');
    const removedCount = this.messages.length - 1 - conversationHistory.length;
    this.messages = [permanent, ...conversationHistory];
    if (removedCount > 0) {
      logger.debug({ removedCount, remainingMessages: this.messages.length }, '临时 system 消息已清理');
    }
  }

  // ─── Reflection 辅助方法 ────────────────────────────────

  /**
   * 判断工具错误结果是否可重试（Reflection 用）
   *
   * 解析工具结果中的 [ERR:TOOL:code] 前缀，
   * 调用 isRetryableErrorCode 判断。
   */
  private isRetryableToolError(result: string): boolean {
    const match = result.match(/^\[ERR:TOOL:(\w+)\]/);
    if (!match) return false;
    // regex 捕获组保证 match[1] 非空，但使用空值兜底避免非空断言
    const codeStr = match[1] ?? '';
    if (!codeStr) return false;
    const code = codeStr as ToolErrorCodeValue;
    return isRetryableErrorCode(code);
  }
}
