/**
 * OpenAI Chat Completions 兼容实现
 *
 * 适用于：DeepSeek / 豆包 / 通义 / Ollama / 任何兼容 OpenAI 协议的 API
 * 详见 ADR-003
 */
import { LlmProvider } from './provider.js';
import type { Message, ChatOptions } from './provider.js';
import type { LlmChunk } from './types.js';

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

  async *chat(messages: Message[], opts: ChatOptions = {}): AsyncIterable<LlmChunk> {
    const url = `${this.config.baseUrl}/chat/completions`;
    const model = opts.model ?? this.config.defaultModel;

    const body: Record<string, unknown> = {
      model,
      messages: this.formatMessages(messages),
      temperature: opts.temperature ?? 0.7,
      stream: true,
    };

    if (opts.tools) body['tools'] = opts.tools;
    if (opts.maxTokens) body['max_tokens'] = opts.maxTokens;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`LLM API error ${response.status}: ${errorText}`);
    }

    if (!response.body) {
      throw new Error('LLM API 返回空 body');
    }

    yield* this.parseSseStream(response.body);
  }

  /**
   * 格式化消息为 OpenAI 协议格式
   */
  private formatMessages(messages: Message[]): unknown[] {
    return messages.map((m) => {
      if (m.role === 'tool') {
        return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
      }
      if (m.role === 'assistant' && m.toolCalls) {
        return {
          role: 'assistant',
          content: m.content,
          tool_calls: m.toolCalls,
        };
      }
      return { role: m.role, content: m.content };
    });
  }

  /**
   * 解析 SSE 流
   * OpenAI 协议：data: {...}\n\n
   */
  private async *parseSseStream(body: ReadableStream<Uint8Array>): AsyncIterable<LlmChunk> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') return;

          try {
            const json = JSON.parse(data) as {
              choices?: Array<{
                delta?: { content?: string; tool_calls?: unknown };
                finish_reason?: string;
              }>;
            };

            const choice = json.choices?.[0];
            if (!choice) continue;

            const chunk: LlmChunk = {};
            if (choice.delta?.content) chunk.content = choice.delta.content;
            if (choice.finish_reason) {
              chunk.finishReason = choice.finish_reason as LlmChunk['finishReason'];
            }
            yield chunk;
          } catch {
            // 忽略无法解析的行
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
