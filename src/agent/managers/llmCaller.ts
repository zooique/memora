/**
 * LLM 调用族（ARCH-3 P3-2 提取自 AgentLoop）
 *
 * 从 `loop.ts` 搬出的「③ 副作用与模型触碰面」：
 *
 *   - `LlmCaller.callWithRetry`  ← 原 `AgentLoop.callLlmWithRetry`（196 行）
 *   - `LlmCaller.resolveProvider` ← 原 `AgentLoop.resolveProvider`（19 行）
 *   - `LlmCaller.waitForRetryWithAbort` ← 原 `AgentLoop._waitForRetryWithAbort`（32 行）
 *   - `determineTaskType`         ← 原 `AgentLoop.determineTaskType`（自由函数，30 行）
 *
 * ## 为什么它们可搬（与 F2 编排族的分水岭）
 *
 * 原族的 loop 私有 state 触点**全是「可注入的协作者」**（metrics / strategy / contextManager /
 * tracer / opts），没有一个是「loop 自己的可变状态」。故可经构造注入取值器（getter）后整体搬走，
 * 属「换位置仍自治」；而 F2（`executeToolCalls` 16 触点含 7 处写）是编排本体，不可搬。
 *
 * ## 两条不可回退的纪律
 *
 * 1. **必须传 getter 而非快照**：`strategy` / `provider` 均为运行时可热切换
 *    （`setStrategy` 浅合并新对象、`setProvider` 改 `opts.provider`），且
 *    `strategy.errorHandling` 在**重试循环体内**被读 3 次——传快照会在重试中途读到旧值，
 *    与搬前行为不一致。
 * 2. **`routeCache` 仍是 loop 持有并跨族共享**：它在**每轮 turn 入口**（`processUserInput`）
 *    被 `clear()`，而 turn 内单轮问答查表即中——若把 Map 搬进本类，若调用方逐次新建实例则
 *    **每轮都重算路由**（跨轮缓存失效），而缓存的语义是「单轮内复用，跨轮重置」。故 Map 归
 *    loop，本类只经读写回调操作它。
 */

import type { LlmProvider, Message, ChatOptions } from '@/llm/provider.js';
import type { ProviderRouter, TaskType } from '@/llm/types.js';
import type { AgentChunk, TextChunkStage } from '@/agent/types.js';
import type { ITracer } from '@/agent/tracer.js';
import { NOOP_TRACER, TRACE_SPANS } from '@/agent/tracer.js';
import { LOOP_CONSTANTS } from '@/agent/constants.js';
import type { LoopMetrics } from '@/agent/managers/loopMetrics.js';
import { isAbortError } from '@/utils/errors.js';
import { toError } from '@/utils/toError.js';
import { sha256Fingerprint } from '@/utils/hash.js';
import { safeSetTimeout } from '@/utils/safeTimer.js';
import { logger } from '@/logging/logger.js';

/** 上下文估算能力窄面（`ContextManager.estimateTokens`） */
export interface TokenEstimator {
  estimateTokens(messages: readonly Message[]): number;
}

/**
 * 多模型路由所需的 loop 侧能力子集。
 * 全部为**取值器 / 回调**而非值快照——保证热切换（`setProvider` / `setStrategy`）即时生效。
 */
export interface LlmCallerDeps {
  /** 运行时指标容器（loop 持有，引用共享；搬走不影响计数正确性） */
  readonly metrics: LoopMetrics;
  /** 当前 L2 策略。**必须是 getter**：`errorHandling` 在重试循环内被读 3 次 */
  readonly getStrategy: () => LlmCallerStrategyView;
  /** 当前 Provider。**必须是 getter**：`setProvider` 为热切换 */
  readonly getProvider: () => LlmProvider;
  /** 任务类型路由回调；未注入时走固定 Provider */
  readonly getProviderRouter: () => ProviderRouter | undefined;
  /** 路由缓存读（Map 归 loop 持有，见文件头纪律 2） */
  readonly getCachedProvider: (taskType: TaskType) => LlmProvider | undefined;
  /** 路由缓存写 */
  readonly setCachedProvider: (taskType: TaskType, provider: LlmProvider) => void;
  /** 上下文管理器（token 估算） */
  readonly contextManager: TokenEstimator;
  /** 追踪器 */
  readonly tracer: ITracer;
  /** 本闭环是否已执行过工具。**必须是 getter**：同一 turn 内会被 set true */
  readonly hasToolExecutedThisTurn: () => boolean;
}

/** `LlmCaller` 实际读取的策略字段（避免整体依赖 `L2RuntimeStrategy` 造成接口面膨胀） */
export interface LlmCallerStrategyView {
  /** 出错处理：'stop' 立即抛出 / 'degrade' 降级为已生成文本 / 其余走重试 */
  readonly errorHandling: string;
  /** 'manual' → 强制低推理深度（provider 支持时） */
  readonly multiStepReasoning: string;
  /** 'fixed' → 跳过路由，固定用默认 Provider */
  readonly providerRouting: string;
}

/** LLM 调用结果（loop 侧消费者：`_callAndRoute` / `handleToolCalls` / `handleAskUser` /
 *  `handleTextResponse`，均在本族之外，故为导出类型） */
export interface LlmCallResult {
  fullContent: string;
  toolCalls: Message['toolCalls'];
  aborted: boolean;
  /**
   * P2 文本通道剥离缓冲：工具轮叙述文本（本闭环已执行过工具后的整条消息文本，
   * 或收到 toolCalls 信号后后续/同条的 content）累积于此。结果路由据此发射
   * narrate 事件，不进回答正文；纯文本闭环（无工具史）正文保持按流式实时 yield。
   */
  pendingNarrate: string;
  /**
   * 本轮正文是否曾逐字流式 yield（工具闭环内延迟分类的消息未 yield → false）。
   * 结果路由据此在纯文本/中断路径补发整段 text，避免缓冲文本对 UI 不可见。
   */
  textStreamed: boolean;
}

/**
 * 确定当前回合任务类型（多模型路由）：含代码块→code；长文本(>500字符)→reasoning；其余→simple
 *
 * 纯函数（零 state 触点），独立导出便于单测与复用。
 */
export function determineTaskType(messages: readonly Message[]): TaskType {
  // 从后向前取最近 N 条 user 消息作为检测窗口（多轮对话中真正含代码的请求可能不在最后一条）
  const recentUserContents: string[] = [];
  for (
    let i = messages.length - 1;
    i >= 0 && recentUserContents.length < LOOP_CONSTANTS.TASK_TYPE_WINDOW;
    i--
  ) {
    if (messages[i]?.role === 'user') {
      recentUserContents.push(messages[i]!.content ?? '');
    }
  }

  // 代码相关关键词检测：窗口内任一条含代码块标记 → code（避免含代码请求被后续追问稀释误判）
  if (recentUserContents.some((c) => /```(?:ts|js|py|go|rust|java|css|html|sql)\b/i.test(c))) {
    return 'code';
  }
  // 长文本复杂推理判定（以最近一条 user 消息反映当前轮意图；阈值归入 LOOP_CONSTANTS）
  const lastContent = recentUserContents[0] ?? '';
  if (lastContent.length > LOOP_CONSTANTS.REASONING_INPUT_CHARS) {
    return 'reasoning';
  }
  return 'simple';
}

/** LLM 调用执行器：多模型路由 + 指数退避重试 + 流式文本通道分类 */
export class LlmCaller {
  constructor(private readonly deps: LlmCallerDeps) {}

  /**
   * 多模型路由：按任务类型选 Provider；单轮内缓存同一 taskType 结果，避免重复路由计算。
   * 三分支收敛：strategy='fixed' → 默认 Provider；有 providerRouter → 路由 + 缓存；否则 fallback 默认。
   */
  resolveProvider(safeMessages: readonly Message[]): LlmProvider {
    if (this.deps.getStrategy().providerRouting === 'fixed') {
      return this.deps.getProvider();
    }
    const router = this.deps.getProviderRouter();
    if (router) {
      const taskType = determineTaskType(safeMessages);
      const cached = this.deps.getCachedProvider(taskType);
      if (cached) return cached;
      const routed = router(taskType);
      this.deps.setCachedProvider(taskType, routed);
      return routed;
    }
    return this.deps.getProvider();
  }

  /**
   * 调用 LLM（带指数退避重试，仅在流式输出前失败时重试；流式已开始则直接上抛，因用户已看到部分结果）。
   * 经 providerRouter 按任务类型路由到对应 Provider。
   */
  async *callWithRetry(
    safeMessages: readonly Message[],
    chatOpts: ChatOptions,
    signal: AbortSignal | undefined,
    iteration: number,
    /** 流式文本阶段标识（默认正常交付 'answer'；自审查应答由调用方传 'self_review'） */
    stage: TextChunkStage = 'answer',
  ): AsyncGenerator<AgentChunk, LlmCallResult, unknown> {
    const { metrics, contextManager, tracer } = this.deps;
    let fullContent = '';
    let toolCalls: Message['toolCalls'] = undefined;
    let streamStarted = false;
    let lastError: Error | null = null;
    let aborted = false;
    // P2 文本通道剥离：是否已进入「工具调用轮」（收到 toolCalls 信号后后续 text 均属叙述）
    let isToolCallTurn = false;
    // P2 叙述累积：工具轮 text（同条 content + 信号后的后续 content），route 时作为 narrate 发射
    let pendingNarrate = '';
    /** 本轮是否曾逐字流式 yield 过正文（纯文本闭环逐字；工具闭环延迟分类则全程 false） */
    let textStreamed = false;
    // 消息级延迟分类（K1 窄化，2026-09-02）：本闭环已执行过工具（toolExecutedThisTurn）后，
    // 后续 LLM 消息的文本整段缓冲到消息结束再分类——工具轮 → narrate（含信号前全文），
    // 纯文本 → 由路由补发 text。单轮问答/首轮（无工具史）保持逐字流式，不受影响。
    const deferTextToMessageEnd = this.deps.hasToolExecutedThisTurn();

    // 将 AbortSignal 与超时传入 provider，确保 fetch 与 SSE 流读取能被及时中断（用户取消/超时）
    const effectiveOpts: ChatOptions = {
      ...chatOpts,
      signal,
      timeoutMs: LOOP_CONSTANTS.LLM_TIMEOUT_MS,
    };

    // multiStepReasoning='manual' → 强制低推理深度（若 Provider 支持）
    if (this.deps.getStrategy().multiStepReasoning === 'manual') {
      effectiveOpts.reasoning_effort = 'low';
    }

    // 多模型路由：按任务类型选 Provider（resolveProvider，含缓存）
    const effectiveProvider = this.resolveProvider(safeMessages);

    // LLM 调用 Span（涵盖重试循环）
    const llmSpan = tracer.startSpan(TRACE_SPANS.LLM_CALL, {
      model: effectiveProvider.name,
      messageCount: safeMessages.length,
      iteration,
    });
    llmSpan.setAttribute('inputTokens', contextManager.estimateTokens(safeMessages));

    // 记录"模型看到了什么"的系统提示指纹（只记 hash 不记内容，可观测性职责；仅真实 Tracer 时计算避免热路径开销）
    if (tracer !== NOOP_TRACER) {
      const systemPrompt = safeMessages
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n');
      llmSpan.setAttribute('systemPromptHash', sha256Fingerprint(systemPrompt));
    }

    for (let attempt = 0; attempt <= LOOP_CONSTANTS.MAX_LLM_RETRIES; attempt++) {
      // 每次重试前检查是否已被取消（用户点击停止）
      if (signal?.aborted) {
        aborted = true;
        break;
      }

      if (attempt > 0) {
        yield* this.waitForRetryWithAbort(attempt, lastError, signal);
        // 重试后重置流式状态，避免沿用上次的累积输出
        fullContent = '';
        toolCalls = undefined;
        pendingNarrate = '';
        isToolCallTurn = false;
        if (signal?.aborted) {
          aborted = true;
          break;
        }
      }

      try {
        metrics.llmCallCount++;
        metrics.totalInputTokens += contextManager.estimateTokens(safeMessages);

        // [..safeMessages] 浅拷贝为可变数组，避免类型断言（readonly → 可变）
        for await (const chunk of effectiveProvider.chat([...safeMessages], effectiveOpts)) {
          streamStarted = true;
          if (signal?.aborted) {
            aborted = true;
            break;
          }
          // 捕获实际 API token 用量（Provider 支持 usage 时）
          if (chunk.usage) {
            metrics.actualInputTokens += chunk.usage.inputTokens;
            metrics.actualOutputTokens += chunk.usage.outputTokens;
            llmSpan.setAttribute('actualInputTokens', chunk.usage.inputTokens);
            llmSpan.setAttribute('actualOutputTokens', chunk.usage.outputTokens);
          }
          if (chunk.content) {
            fullContent += chunk.content;
            // P2 文本通道剥离：① 工具闭环内消息整段缓冲（deferTextToMessageEnd）；
            // ② 工具轮（已见 toolCalls 信号或同条携带）的文本归叙述缓冲，不进回答正文。
            // ③ 纯文本闭环保持流式实时 yield（stage 供宿主自审查分段）。
            if (deferTextToMessageEnd || isToolCallTurn || chunk.toolCalls?.length) {
              pendingNarrate += chunk.content;
            } else {
              textStreamed = true;
              yield { type: 'text', content: chunk.content, stage };
            }
          }
          if (chunk.toolCalls) {
            toolCalls = [...(toolCalls ?? []), ...chunk.toolCalls];
            isToolCallTurn = true;
          }
        }
        // 成功时累计输出 token
        metrics.totalOutputTokens += contextManager.estimateTokens([
          { role: 'assistant', content: fullContent },
        ]);
        break;
      } catch (err) {
        const e = toError(err);
        lastError = e;

        // AbortError 语义分裂（2026-09-02 假中断排雷）：
        //  - signal（宿主 / 插话控制器合并信号）已被 abort → 真实用户取消/插话，不重试直接退出
        //  - signal 未被 abort 却捕获 AbortError → provider/网络层内部中断（连接被抽断/代理异常），
        //    并非用户取消；抛出以示「连接中断」，避免内核谎报为「用户取消了对话」。
        if (isAbortError(err)) {
          if (signal?.aborted) {
            aborted = true;
            break;
          }
          logger.warn(
            { err: e },
            'LLM 请求被非用户消原因 AbortError 中断（host signal 未 abort），判为连接中断',
          );
          llmSpan.recordException(e);
          llmSpan.end();
          throw e;
        }

        // errorHandling='stop' → 立即抛出，不重试（热切换安全：每处重读 getter）
        if (this.deps.getStrategy().errorHandling === 'stop') {
          llmSpan.recordException(e);
          llmSpan.end();
          throw lastError;
        }

        if (streamStarted) {
          // 流式已开始输出，不能重试（用户已看到部分结果）；'degrade' 降级为已生成文本
          if (this.deps.getStrategy().errorHandling === 'degrade') {
            logger.warn({ err: e }, 'LLM 流式中途失败，降级为已生成的文本内容');
            llmSpan.end();
            return {
              fullContent,
              pendingNarrate,
              toolCalls: undefined,
              aborted: false,
              textStreamed,
            };
          }
          llmSpan.recordException(e);
          llmSpan.end();
          throw lastError;
        }
        if (attempt >= LOOP_CONSTANTS.MAX_LLM_RETRIES) {
          // 重试次数耗尽；'degrade' 降级为纯文本回复
          if (this.deps.getStrategy().errorHandling === 'degrade') {
            const degradedMsg = '抱歉，AI 服务暂时不可用，请稍后重试。';
            logger.warn({ err: e }, 'LLM 重试耗尽，降级回复');
            llmSpan.end();
            return {
              fullContent: degradedMsg,
              pendingNarrate,
              toolCalls: undefined,
              aborted: false,
              textStreamed,
            };
          }
          llmSpan.recordException(e);
          llmSpan.end();
          throw lastError;
        }
        // 流式开始前失败可继续重试（超时/网络错误）
      }
    }

    if (aborted) {
      llmSpan.end();
      return { fullContent, pendingNarrate, toolCalls, aborted: true, textStreamed };
    }

    llmSpan.end();
    return { fullContent, pendingNarrate, toolCalls, aborted: false, textStreamed };
  }

  /**
   * 重试延迟 + abort 支持：发射 retry chunk，等待指数退避延迟（支持中途 abort）；
   * 调用方在延迟后自行检查 signal.aborted 决定是否退出重试循环
   */
  async *waitForRetryWithAbort(
    attempt: number,
    lastError: Error | null,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<AgentChunk, void, unknown> {
    const delay = LOOP_CONSTANTS.RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
    logger.warn({ attempt, delay, error: lastError?.message }, 'LLM 调用失败，重试中');
    yield {
      type: 'retry',
      attempt,
      maxRetries: LOOP_CONSTANTS.MAX_LLM_RETRIES,
      delayMs: delay,
      error: lastError?.message ?? 'unknown error',
    };
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
  }
}
