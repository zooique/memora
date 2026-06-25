/**
 * OpenAI Chat Completions 兼容实现
 *
 * 适用于：DeepSeek / 豆包 / 通义 / Ollama / 任何兼容 OpenAI 协议的 API
 * 详见 ADR-003
 */
import { LlmProvider } from '@/llm/provider.js';
import type { Message, ChatOptions } from '@/llm/provider.js';
import type { LlmChunk, ToolCall } from '@/llm/types.js';
import { llmError, networkError, configError, toError } from '@/utils/errors.js';
import { logger } from '@/logging/logger.js';

export interface OpenAICompatibleConfig {
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
}

/**
 * 通用 OpenAI 兼容 Provider
 * 通过 baseUrl 适配不同厂商
 */
export class OpenAICompatibleProvider extends LlmProvider {
  readonly name: string;

  constructor(
    name: string,
    private readonly config: OpenAICompatibleConfig,
  ) {
    super();
    this.name = name;
  }

  /** 默认请求超时：120 秒 */
  private static readonly DEFAULT_TIMEOUT_MS = 120_000;

  async *chat(messages: Message[], opts: ChatOptions = {}): AsyncIterable<LlmChunk> {
    const url = `${this.config.baseUrl}/chat/completions`;
    const model = opts.model ?? this.config.defaultModel;
    // 请求超时控制：默认 120s，可通过 opts.timeoutMs 覆盖
    const timeoutMs = opts.timeoutMs ?? OpenAICompatibleProvider.DEFAULT_TIMEOUT_MS;

    const body: Record<string, unknown> = {
      model,
      messages: this.formatMessages(messages),
      temperature: opts.temperature ?? 0.7,
      stream: true,
    };

    if (opts.tools) body['tools'] = opts.tools;
    if (opts.maxTokens) body['max_tokens'] = opts.maxTokens;

    // 校验 API Key（M-103：缺失时给友好提示，不暴露 undefined 报错）
    if (!this.config.apiKey) {
      throw configError(
        'API Key 未配置',
        `provider: ${this.name}，baseUrl: ${this.config.baseUrl}`,
        [
          '检查 ~/.memora/config.json 的 llm.apiKey 字段',
          '确认已设置环境变量 MEMORA_LLM_API_KEY',
          '查看文档：config.example.md',
        ],
      );
    }

    // 合并 AbortSignal：外部取消信号 + 超时信号
    // 确保用户取消和请求超时都能中断 fetch 和流读取
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(new DOMException('LLM 请求超时', 'TimeoutError')), timeoutMs);
    const { signal: optsSignal } = opts;
    const onOptsAbort = () => abortController.abort(optsSignal?.reason);
    if (optsSignal) {
      if (optsSignal.aborted) {
        abortController.abort(optsSignal.reason);
      } else {
        optsSignal.addEventListener('abort', onOptsAbort, { once: true });
      }
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: abortController.signal,
      });
    } catch (err) {
      clearTimeout(timeoutId);
      if (optsSignal) optsSignal.removeEventListener('abort', onOptsAbort);
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

    // fetch 成功，清理外部 signal 监听（超时继续生效，通过 abortController 管理）
    if (optsSignal) optsSignal.removeEventListener('abort', onOptsAbort);

    if (!response.ok) {
      clearTimeout(timeoutId);
      await this.handleResponseError(response);
    }

    if (!response.body) {
      clearTimeout(timeoutId);
      throw llmError('LLM API 返回空 body', `${this.config.baseUrl} 返回了 200 但无 body`, [
        '重试一次',
        '如持续出现，联系厂商',
      ]);
    }

    try {
      // 将 abortController.signal 传入 SSE 解析器，使超时/取消能中断流读取
      yield* this.parseSseStream(response.body, abortController.signal);
    } catch (err) {
      // SSE 解析异常时也要 cancel stream（Node 24 + undici 同上）
      try {
        await response.body?.cancel();
      } catch (err) {
        logger.debug({ err: toError(err).message }, 'response.body.cancel 失败');
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * 处理 HTTP 错误响应
   *
   * 消费并释放 body，根据状态码抛出相应的错误类型。
   */
  private async handleResponseError(response: Response): Promise<never> {
    const errorText = await response.text().catch(() => '<无法读取响应体>');
    try {
      await response.body?.cancel();
    } catch (err) {
      logger.debug({ err: toError(err).message }, 'response.body.cancel 失败');
    }
    const status = response.status;

    if (status === 401 || status === 403) {
      throw configError('LLM API Key 无效', `HTTP ${status}：${errorText.slice(0, 200)}`, [
        '检查 API Key 是否正确（注意 ${MEMORA_LLM_API_KEY} 占位符是否已展开）',
        '确认 Key 未过期',
        '如使用 DeepSeek/豆包，确认 Key 来自对应平台',
      ]);
    }

    if (status === 429) {
      throw llmError('LLM 服务限流', `HTTP 429：${errorText.slice(0, 200)}`, [
        '稍后重试',
        '如频繁触发考虑升级套餐或换用其他 provider',
      ]);
    }

    if (status >= 400 && status < 500) {
      throw llmError('LLM 请求格式错误', `HTTP ${status}：${errorText.slice(0, 200)}`, [
        '检查消息内容是否含特殊字符',
        '确认 model 名称正确',
        '如使用 tools，确认 tool schema 有效',
      ]);
    }

    throw llmError('LLM 服务端错误', `HTTP ${status}：${errorText.slice(0, 200)}`, [
      '稍后重试',
      '如持续失败，访问厂商状态页确认服务状态',
      '可在 config.json 切换 provider 兜底',
    ]);
  }

  /**
   * 格式化消息为 OpenAI 协议格式
   *
   * 关键兼容性处理：
   *   - assistant 消息带 tool_calls 时，若 content 为空字符串，转为 null
   *     （部分 LLM provider 对空字符串 content 处理异常，导致请求挂起或报错）
   *   - tool 消息必须包含 tool_call_id 关联对应的工具调用
   */
  private formatMessages(messages: Message[]): unknown[] {
    return messages.map((m) => {
      if (m.role === 'tool') {
        return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
      }
      if (m.role === 'assistant' && m.toolCalls) {
        return {
          role: 'assistant',
          // OpenAI 协议：有 tool_calls 时 content 应为 null（而非空字符串），
          // 空字符串会导致部分 provider 请求异常或无响应
          content: m.content && m.content.length > 0 ? m.content : null,
          tool_calls: m.toolCalls,
        };
      }
      return { role: m.role, content: m.content };
    });
  }

  /**
   * 解析 SSE 流
   * OpenAI 协议：data: {...}\n\n
   *
   * 支持解析 tool_calls delta（流式工具调用）：
   * OpenAI 协议中 tool_calls 以 delta 形式分片传输，
   * 需要跨 chunk 累积 function.name 和 function.arguments，
   * 在 finish_reason='tool_calls' 或流结束时输出完整的 toolCalls。
   *
   * @param body - SSE 响应流
   * @param signal - 中止信号（超时/用户取消），中断 reader.read() 等待
   */
  private async *parseSseStream(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncIterable<LlmChunk> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // 流式 tool_calls 累积器：按 index 分片累积 name + arguments
    // OpenAI 协议：同一个 tool_call 的 name/arguments 可能跨多个 delta 分片到达
    const toolCallAccumulators = new Map<number, { id: string; name: string; arguments: string }>();

    try {
      while (true) {
        // 检查中止信号：超时或用户取消时立即退出
        if (signal?.aborted) {
          throw new DOMException('LLM 流读取被中止', signal.reason?.name ?? 'AbortError');
        }

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
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
                  tool_calls?: Array<{
                    index?: number;
                    id?: string;
                    type?: string;
                    function?: { name?: string; arguments?: string };
                  }>;
                };
                finish_reason?: string;
              }>;
            };

            const choice = json.choices?.[0];
            if (!choice) continue;

            const chunk: LlmChunk = {};
            // delta.content 可能为 null（tool_calls 场景），!= null 排除 null/undefined
            // 空字符串在流式中极少出现，但不影响语义，保持原有 truthy 检查即可
            if (choice.delta?.content) chunk.content = choice.delta.content;

            // 累积 tool_calls delta
            if (choice.delta?.tool_calls) {
              for (const tc of choice.delta.tool_calls) {
                const idx = tc.index ?? 0;
                const acc = toolCallAccumulators.get(idx) ?? { id: '', name: '', arguments: '' };
                if (tc.id) acc.id = tc.id;
                if (tc.function?.name) acc.name += tc.function.name;
                if (tc.function?.arguments) acc.arguments += tc.function.arguments;
                toolCallAccumulators.set(idx, acc);
              }
            }

            // finish_reason='tool_calls' 时输出完整的 toolCalls
            if (choice.finish_reason === 'tool_calls') {
              chunk.toolCalls = this.buildToolCallsFromAccumulators(toolCallAccumulators);
              toolCallAccumulators.clear();
            } else if (choice.finish_reason && toolCallAccumulators.size > 0) {
              // finish_reason 为 stop/length 等非 tool_calls 值时，清空累积器防止污染下一次调用
              // （某些模型可能在 stop 时残留不完整的 tool_calls 碎片）
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
      reader.releaseLock();
    }
  }

  /**
   * 从累积器构建完整的 toolCalls 数组（用于 finish_reason='tool_calls' 场景）
   */
  private buildToolCallsFromAccumulators(
    accs: Map<number, { id: string; name: string; arguments: string }>,
  ): ToolCall[] {
    const calls: ToolCall[] = [];
    for (const [idx, acc] of accs) {
      calls.push({
        id: acc.id || `call_${idx}`,
        type: 'function',
        function: { name: acc.name, arguments: acc.arguments },
      });
    }
    return calls;
  }

  /**
   * 从累积器构建 LlmChunk（用于流结束时的兜底输出）
   */
  private buildToolCallsChunk(
    accs: Map<number, { id: string; name: string; arguments: string }>,
  ): LlmChunk {
    return {
      toolCalls: this.buildToolCallsFromAccumulators(accs),
      finishReason: 'tool_calls',
    };
  }
}
