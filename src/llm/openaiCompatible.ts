/**
 * OpenAI Chat Completions 兼容实现
 *
 * 适用于：DeepSeek / 豆包 / 通义 / Ollama / 任何兼容 OpenAI 协议的 API
 */
import { LlmProvider } from '@/llm/provider.js';
import type { Message, ChatOptions } from '@/llm/provider.js';
import type { LlmChunk, ToolCall } from '@/llm/types.js';
import { llmError, networkError, configError } from '@/utils/errors.js';
import { toError } from '@/utils/toError.js';
import { logger } from '@/logging/logger.js';
import { mergeAbortSignals } from '@/llm/abortSignal.js';

export interface OpenAICompatibleConfig {
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  /** 是否支持原生工具调用（OpenAI Function Calling tools 协议）。三态透传：仅 undefined 回落默认 true，
   *  显式 false 保留关闭工具通道（本地 LLM 如 Ollama/LM Studio 无原生 FC 时由宿主配置 false）。 */
  supportsToolCalling?: boolean;
  /** 是否支持结构化输出（response_format / JSON mode），默认 false */
  supportsStructuredOutput?: boolean;
}

/** 错误响应体截断长度（字符数）：统一 4 处 errorText.slice(0,200) 的常量，避免魔法数字 */
const MAX_ERROR_BODY_LEN = 200;

// ─── LLM 请求参数边界（外部注入防失控） ─────────────────

/** maxTokens 上限：65536 覆盖当前所有模型 max_tokens 能力上限（独立于策略层
 *  MAX_OUTPUT_LIMIT——同值但约束不同语义，非共享常量，勿当「一致性」联动改） */
const MAX_MAX_TOKENS = 65536;
/** timeoutMs 上限：5 分钟，防配置超大值导致请求等待失控（下限不设，测试/调试用小值模拟超时） */
const MAX_TIMEOUT_MS = 300_000;

/**
 * 归一化 maxTokens：合法 1~MAX_MAX_TOKENS 返回原值，越界/非法返回 undefined（不传，让服务端默认）。
 * 防配置负值/零值（协议错误）或超大值（资源失控）。
 */
function normalizeMaxTokens(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (value < 1 || value > MAX_MAX_TOKENS) return undefined;
  return Math.floor(value);
}

/**
 * 归一化 timeoutMs：合法（≤MAX_TIMEOUT_MS 且 >0）返回原值，越界/非法回退默认。
 * 防超大值等待失控；不设下限以保留测试用小超时值。
 */
function normalizeTimeoutMs(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  if (value <= 0 || value > MAX_TIMEOUT_MS) return fallback;
  return value;
}

/**
 * chunk 级读超时区分首 chunk 与 chunk 间（reasoning 适配）：
 * 首 chunk 前可能思考 30-90s（DeepSeek-R1/o1/QwQ 等）→ 120s；连接正常后停顿 <10s → 60s
 */
const FIRST_CHUNK_TIMEOUT_MS = 120_000;
const INTER_CHUNK_TIMEOUT_MS = 60_000;
/** 有效 SSE 事件停滞超时：即便有字节持续到达（keep-alive/代理心跳），只要长时间无 `data:` 事件，
 *  也判超时——补 chunk 级超时（按 read 重置）对「有字节无进展」的真空区，防止连接半挂永久等待。 */
const EVENT_STALL_TIMEOUT_MS = 120_000;

/** 通用 OpenAI 兼容 Provider：通过 baseUrl 适配不同厂商 */
export class OpenAICompatibleProvider extends LlmProvider {
  readonly name: string;

  constructor(
    name: string,
    private readonly config: OpenAICompatibleConfig,
  ) {
    super();
    this.name = name;
    this._setCapabilities(config);
  }

  /**
   * 能力位赋值（内置为只读，外部不可改）：默认 true 保留存量云 LLM「有工具集即走原生 FC」行为，
   * 本地运行时（Ollama/LM Studio 等）无原生 FC 须在宿主配置时显式置 false（2026-09-14 阶段0）。
   * @param config 构造时的能力位声明（undefined → 回落默认）
   */
  private _setCapabilities(config: OpenAICompatibleConfig): void {
    (this as { supportsToolCalling: boolean }).supportsToolCalling = config.supportsToolCalling ?? true;
    (this as { supportsStructuredOutput: boolean }).supportsStructuredOutput =
      config.supportsStructuredOutput ?? false;
  }

  /** 默认请求超时：120 秒 */
  private static readonly DEFAULT_TIMEOUT_MS = 120_000;

  /** tool_call id 兜底的自增序列（G3，2026-09-15）：id 缺失时给出**跨批唯一**的占位，
   *  而非旧的本批内下标 `call_${idx}`——否则同一 turn 的两次迭代各产 `call_0`，
   *  服务端按 tool_call_id 配对时错位。实例级自增，杜绝模块级全局态（架构约束）。 */
  private toolCallIdSeq = 0;

  async *chat(messages: Message[], opts: ChatOptions = {}): AsyncIterable<LlmChunk> {
    const url = `${this.config.baseUrl}/chat/completions`;
    const model = opts.model ?? this.config.defaultModel;
    // 请求超时控制：默认 120s，可通过 opts.timeoutMs 覆盖（越界回退默认，防超大值等待失控）
    const timeoutMs = normalizeTimeoutMs(opts.timeoutMs, OpenAICompatibleProvider.DEFAULT_TIMEOUT_MS);
    // maxTokens 边界归一：合法 1~MAX_MAX_TOKENS 才透传，越界/非法忽略（让服务端默认）
    const maxTokens = normalizeMaxTokens(opts.maxTokens);

    const body: Record<string, unknown> = {
      model,
      messages: this.formatMessages(messages),
      // temperature 透传：未配置时省略该字段，由 LLM 服务端应用其默认值
      temperature: opts.temperature,
      stream: true,
    };

    if (opts.tools) body['tools'] = opts.tools;
    if (maxTokens !== undefined) body['max_tokens'] = maxTokens;
    // 透传 response_format；不能与 tools 同时使用（OpenAI 协议限制），调用方保证互斥
    if (opts.response_format) body['response_format'] = opts.response_format;
    // 透传推理深度（reasoning_effort）：loop 在 multiStepReasoning='manual' 时设置 'low'
    // 实现快速回答，必须转达给 provider 才生效（此前已声明+消费但未见转达，契约断裂）
    if (opts.reasoning_effort) body['reasoning_effort'] = opts.reasoning_effort;

    // 合并外部取消 + 超时信号，确保用户取消和请求超时都能中断 fetch 和流读取
    const abort = mergeAbortSignals(opts.signal, timeoutMs, 'LLM 请求超时');

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: abort.signal,
      });
    } catch (err) {
      abort.dispose();
      const e = toError(err);
      // 区分超时错误和网络错误
      if (e.name === 'AbortError' || e.name === 'TimeoutError') {
        throw networkError(
          'LLM 请求超时',
          `${this.config.baseUrl} 请求超过 ${timeoutMs / 1000}s 未响应`,
          [
            '检查网络连接稳定性',
            '如频繁超时，考虑切换 provider 或在 config.json 调整 timeoutMs',
            '稍后重试',
          ],
          e,
        );
      }
      throw networkError(
        'LLM 服务连接失败',
        `无法访问 ${this.config.baseUrl}：${e.message}`,
        [
          '检查网络连接（是否能访问 baseUrl）',
          '确认 baseUrl 配置正确',
          '如使用 VPN/代理，检查代理设置',
        ],
        e,
      );
    }

    // fetch 成功后保留 optsSignal 监听，使用户在 SSE 阶段取消也能中断 reader.read()；
    // 正常完成/异常路径须显式 dispose()，否则监听器常驻泄漏（外层 try-finally 统一调用）

    try {
      if (!response.ok) {
        await this.handleResponseError(response);
      }

      if (!response.body) {
        throw llmError('LLM API 返回空 body', `${this.config.baseUrl} 返回了 200 但无 body`, [
          '重试一次',
          '如持续出现，联系厂商',
        ]);
      }

      // fetch 成功后清除请求级总超时，SSE 阶段由 chunk 级超时独立保护，否则长文生成（>timeoutMs）会被错误中断
      abort.clearTimer();

      try {
        yield* this.parseSseStream(response.body, abort.signal);
      } catch (err) {
        // SSE 解析异常时也 cancel stream 释放底层连接
        await this.safeCancelBody(response);
        // DOMException（AbortError/TimeoutError）是 LLM 中断协议，按 err.name==='AbortError' 识别，须原样传播不能包装为 MemoraError
        if (err instanceof DOMException) throw err;
        // 其他未知流异常统一包装为 MemoraError，避免裸 throw 逃逸非 MemoraError
        throw networkError(
          'LLM 流读取异常',
          toError(err).message,
          ['稍后重试', '如持续出现，检查网络稳定性或切换 provider'],
          toError(err),
        );
      }
    } finally {
      // 统一清理：覆盖 HTTP 错误、空 body、SSE 异常、正常完成所有路径
      abort.dispose();
    }
  }

  /** 处理 HTTP 错误响应：消费并释放 body，按状态码抛相应错误类型 */
  private async handleResponseError(response: Response): Promise<never> {
    const errorText = await response.text().catch(() => '<无法读取响应体>');
    await this.safeCancelBody(response);
    const status = response.status;

    if (status === 401 || status === 403) {
      throw configError(
        'LLM API Key 无效',
        `HTTP ${status}：${errorText.slice(0, MAX_ERROR_BODY_LEN)}`,
        [
          '检查 API Key 是否正确（注意 ${MEMORA_API_KEY} 占位符是否已展开）',
          '确认 Key 未过期',
          '如使用 DeepSeek/豆包，确认 Key 来自对应平台',
        ],
      );
    }

    if (status === 429) {
      throw llmError('LLM 服务限流', `HTTP 429：${errorText.slice(0, MAX_ERROR_BODY_LEN)}`, [
        '稍后重试',
        '如频繁触发考虑升级套餐或换用其他 provider',
      ]);
    }

    if (status >= 400 && status < 500) {
      throw llmError(
        'LLM 请求格式错误',
        `HTTP ${status}：${errorText.slice(0, MAX_ERROR_BODY_LEN)}`,
        [
          '检查消息内容是否含特殊字符',
          '确认 model 名称正确',
          '如使用 tools，确认 tool schema 有效',
        ],
      );
    }

    throw llmError('LLM 服务端错误', `HTTP ${status}：${errorText.slice(0, MAX_ERROR_BODY_LEN)}`, [
      '稍后重试',
      '如持续失败，访问厂商状态页确认服务状态',
      '可在 config.json 切换 provider 兜底',
    ]);
  }

  /** 安全取消 response.body：cancel 失败不阻塞后续错误抛出，仅 debug 记录 */
  private async safeCancelBody(response: Response): Promise<void> {
    try {
      await response.body?.cancel();
    } catch (err) {
      logger.debug({ err: toError(err).message }, 'response.body.cancel 失败');
    }
  }

  /**
   * 格式化消息为 OpenAI 协议格式：assistant 带 tool_calls 时 content 空串转 null
   * （部分 provider 对空串 content 处理异常）；tool 消息须带 tool_call_id
   */
  private formatMessages(messages: Message[]): unknown[] {
    return messages.map((m) => {
      if (m.role === 'tool') {
        return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
      }
      if (m.role === 'assistant' && m.toolCalls) {
        return {
          role: 'assistant',
          // OpenAI 协议：有 tool_calls 时 content 应为 null（空串会致部分 provider 请求异常）
          content: m.content && m.content.length > 0 ? m.content : null,
          tool_calls: m.toolCalls,
        };
      }
      return { role: m.role, content: m.content };
    });
  }

  /**
   * 解析 SSE 流（data: {...}\n\n）。tool_calls 以 delta 分片传输，
   * 需跨 chunk 累积 name/arguments，在 finish_reason='tool_calls' 或流结束时输出完整 toolCalls
   */
  private async *parseSseStream(
    body: ReadableStream<Uint8Array>,
    signal?: AbortSignal,
  ): AsyncIterable<LlmChunk> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // 流式 tool_calls 累积器：同一 tool_call 的 name/arguments 可能跨多个 delta 分片到达
    const toolCallAccumulators = new Map<number, { id: string; name: string; arguments: string }>();
    // 已发射过「工具意图预告」的累积器 idx（2026-09-17）：同一工具只提前上报一次，防 delta 风暴。
    // 必须是本生成器局部变量——随流结束/中断自然回收，防跨请求泄漏。
    const emittedPendingIndexes = new Set<number>();

    // chunk 级读超时：无超时则连接半挂（NAT/代理不关 TCP）会永久等待；
    // 区分首 chunk（reasoning 思考数十秒，120s）与 chunk 间（连接已正常，60s）；
    // 另有有效事件停滞监视（收到任意 data: 行即重置），补 chunk 超时漏掉的
    // 「服务端持续发 keep-alive 字节但无进展」真空区。
    //
    // ⚠️ **超时必须经竞速闸 reject，不得用 `reader.cancel()` 表达——本看门狗成立的前提，勿回改**：
    // `reader.cancel(reason)` 的语义是「关闭流并让**挂起的 read() 以 `{done:true}` 收尾**」，
    // reason **不会**出现在任何抛出物上（WHATWG 规范行为；Node 22 / undici 实测：cancel 后
    // read 产 `{done:true}`；对照 `AbortController.abort(reason)` 才会让 read reject reason）。
    // 旧实现把 cancel 当作「让 read 抛错」→ 超时被读成「流正常结束且零产出」→ 落「空响应重试」
    // 通道 → **超时被静默吞成重试**。真机故障（2026-09-15 09:03:22→09:08:27，
    // `round-1789462982489`）：中断源在 reasoning 结束后停摆，60s（chunk 间）+120s+120s
    // （两次重试首 chunk）三段超时全被吞成静默重试，期间**零 UI 事件**（tokenOut 恒 0），
    // 用户干等 5 分 5 秒后手动取消。
    // 故看门狗只负责「以真超时驳回当前读」；底层连接的释放仍由 finally 的 reader.cancel() 负责。
    /** 看门狗已到期的超时（竞速闸未挂起时的落账处：下一轮读之前立即抛，账面不丢） */
    let overdueTimeout: DOMException | null = null;
    /** 竞速闸的驳回句柄（仅在一次读的存活期内非空） */
    let pendingReadReject: ((err: DOMException) => void) | null = null;
    /** 看门狗统一出口：以真超时驳回当前读；两读之间到期则记账，由循环顶部补抛 */
    const failCurrentRead = (reason: string): void => {
      overdueTimeout ??= new DOMException(reason, 'TimeoutError');
      pendingReadReject?.(overdueTimeout);
    };

    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    const stallReset = (): void => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        failCurrentRead('LLM 流长时间无有效事件（有字节但无 data 事件）');
      }, EVENT_STALL_TIMEOUT_MS);
    };
    // 进入流读取即启动停滞监视（首事件前的“有字节无事件”同样覆盖）
    stallReset();

    let firstChunkReceived = false;

    try {
      while (true) {
        // 检查中止信号：刻意抛 DOMException（AbortError）而非 MemoraError——它是 LLM 中断协议，上游按 err.name==='AbortError' 识别
        if (signal?.aborted) {
          throw new DOMException('LLM 流读取被中止', signal.reason?.name ?? 'AbortError');
        }
        // 两读之间到期的超时不丢账：读之前先补抛
        if (overdueTimeout) throw overdueTimeout;

        // 根据是否收到首 chunk 选不同超时阈值（到期经 failCurrentRead 驳回当前读，见上方注释）
        const chunkTimeoutMs = firstChunkReceived ? INTER_CHUNK_TIMEOUT_MS : FIRST_CHUNK_TIMEOUT_MS;
        const chunkTimer = setTimeout(() => {
          failCurrentRead(firstChunkReceived ? 'LLM chunk 间读取超时' : 'LLM 首 chunk 读取超时');
        }, chunkTimeoutMs);

        // 超时竞速闸：read 与超时赛跑。超时先到 → 本读以真超时 reject；被落空的 read 仍挂起，
        // 待 finally 释放连接时自然收尾，其无人观察的 resolve 无副作用。
        const timeoutGate = new Promise<never>((_, reject) => {
          pendingReadReject = reject;
        });
        // 兜底观察者：闸被「已被真实数据抢先的读」落空时，其拒绝不得变成无人处理的拒绝
        void timeoutGate.catch(() => undefined);

        let readResult;
        try {
          readResult = await Promise.race([reader.read(), timeoutGate]);
        } finally {
          // read 完成（无论成功/失败）都清理 chunk timer 与竞速闸句柄，避免泄漏
          clearTimeout(chunkTimer);
          pendingReadReject = null;
        }

        const { done, value } = readResult;
        if (done) break;

        // 成功读到数据后标记首 chunk 已到，后续 read() 用 chunk 间超时
        if (!firstChunkReceived) {
          firstChunkReceived = true;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          // 有效事件停滞重置：收到 data 行即代表服务端仍在推进（即便内容暂无可输出）
          stallReset();
          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') {
            // 流结束：输出累积的 tool_calls（如果有）
            if (toolCallAccumulators.size > 0) {
              yield this.buildToolCallsChunk(toolCallAccumulators);
            }
            return;
          }

          try {
            const json = JSON.parse(data) as {
              choices?: Array<{
                delta?: {
                  content?: string | null;
                  /** 模型思考增量（deepseek 等思考模型，OpenAI 兼容扩展字段） */
                  reasoning_content?: string | null;
                  tool_calls?: Array<{
                    index?: number;
                    id?: string;
                    type?: string;
                    function?: { name?: string; arguments?: string };
                  }>;
                };
                finish_reason?: string;
              }>;
              usage?: {
                prompt_tokens?: number;
                completion_tokens?: number;
                total_tokens?: number;
              };
            };

            // 提取 usage 数据（部分 Provider 在流式响应末尾携带 token 用量统计）
            const usage = json.usage
              ? {
                  inputTokens: json.usage.prompt_tokens ?? 0,
                  outputTokens: json.usage.completion_tokens ?? 0,
                  totalTokens: json.usage.total_tokens,
                }
              : undefined;

            const choice = json.choices?.[0];
            // 纯 usage 事件（末尾统计块，choices 为空数组）：单独 yield，跳过 choices 处理
            if (!choice) {
              if (usage) yield { usage };
              continue;
            }

            const chunk: LlmChunk = {};
            // usage 与 choices 并存时合并到同一 chunk（单出口，防同事件双 yield 致 content 重复）
            if (usage) chunk.usage = usage;
            // delta.content 可能为 null（tool_calls 场景），truthy 检查即可
            if (choice.delta?.content) chunk.content = choice.delta.content;
            // 模型思考（协议字段 reasoning_content → LlmChunk.thought）：增量透传，与 content 并列
            // （R3 增量语义，消费侧自行累积）。thought 命名避开路由 TaskType='reasoning' 与相位 'thinking'。
            if (choice.delta?.reasoning_content) chunk.thought = choice.delta.reasoning_content;

            // 累积 tool_calls delta
            if (choice.delta?.tool_calls) {
              for (const tc of choice.delta.tool_calls) {
                const idx = tc.index ?? 0;
                const acc = toolCallAccumulators.get(idx) ?? { id: '', name: '', arguments: '' };
                if (tc.id) acc.id = tc.id;
                if (tc.function?.name) acc.name += tc.function.name;
                if (tc.function?.arguments) acc.arguments += tc.function.arguments;
                toolCallAccumulators.set(idx, acc);
                // 工具意图预告（2026-09-17）：name 首次由空变非空即上报，不必等 finish_reason——
                // 写文件等大参数工具的参数生成段可能数十秒，UI 需提前显示「准备中」工具行。
                // 每 idx 只发一次（emittedPendingIndexes 去重防风暴）；id 缺失时按与最终构建
                // 同一规则合成并**写回 acc.id**（acc.id || `call_${seq}`），保证 finish_reason
                // 时 buildToolCallsFromAccumulators 复用同一 id，宿主侧可按 id 配对升级。
                if (acc.name && !emittedPendingIndexes.has(idx)) {
                  emittedPendingIndexes.add(idx);
                  if (!acc.id) acc.id = `call_${this.toolCallIdSeq++}`;
                  chunk.partialToolCall = { id: acc.id, name: acc.name };
                }
              }
            }

            // finish_reason='tool_calls' 时输出完整的 toolCalls
            if (choice.finish_reason === 'tool_calls') {
              chunk.toolCalls = this.buildToolCallsFromAccumulators(toolCallAccumulators);
              toolCallAccumulators.clear();
            } else if (choice.finish_reason && toolCallAccumulators.size > 0) {
              // 非 tool_calls 的 finish_reason（stop/length 等）时清空累积器，防残留碎片污染下一次调用
              toolCallAccumulators.clear();
            }

            if (choice.finish_reason) {
              chunk.finishReason = choice.finish_reason as LlmChunk['finishReason'];
            }
            yield chunk;
          } catch (err) {
            logger.debug({ line: line.slice(0, 80), err: toError(err).message }, 'SSE 行解析失败');
          }
        }
      }
    } finally {
      // 清理事件停滞监视（流已结束，不再需要 stall 兜底）
      if (stallTimer) clearTimeout(stallTimer);
      // reader.cancel() 彻底释放底层 TCP 连接（releaseLock 仅释放锁不取消流，防止 break 时连接悬挂）；已 done 的 cancel 是 no-op
      try {
        await reader.cancel();
      } catch (err) {
        // cancel 失败不阻塞，reader 会被 GC 回收；记日志排查偶发连接泄漏
        logger.debug({ err: toError(err).message }, 'reader.cancel 失败（finally 清理路径）');
      }
    }
  }

  /** 从累积器构建完整 toolCalls 数组（finish_reason='tool_calls' 场景）。
   *  id 缺失时兜底为 `call_<toolCallIdSeq++>`（跨批唯一），不因两次迭代都缺 id 而产出重复 id。 */
  private buildToolCallsFromAccumulators(
    accs: Map<number, { id: string; name: string; arguments: string }>,
  ): ToolCall[] {
    const calls: ToolCall[] = [];
    for (const [, acc] of accs) {
      calls.push({
        id: acc.id || `call_${this.toolCallIdSeq++}`,
        type: 'function',
        function: { name: acc.name, arguments: acc.arguments },
      });
    }
    return calls;
  }

  /** 从累积器构建 LlmChunk（流结束时的兜底输出） */
  private buildToolCallsChunk(
    accs: Map<number, { id: string; name: string; arguments: string }>,
  ): LlmChunk {
    return {
      toolCalls: this.buildToolCallsFromAccumulators(accs),
      finishReason: 'tool_calls',
    };
  }
}
