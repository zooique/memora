/** LLM Provider 抽象接口：所有 LLM 实现（DeepSeek/豆包/OpenAI/Mock）必须实现 */
import type { LlmChunk } from '@/llm/types.js';

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  // 消息来源名称（可选，用于 function 调用结果标识，与 OpenAI API 对齐）
  name?: string;
  toolCalls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  toolCallId?: string;
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  // 工具定义（OpenAI Function Calling 格式）
  tools?: Array<{
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>; // JSON Schema
    };
  }>;
  /** 结构化输出约束：Provider 不支持时静默跳过，fallback 到纯文本 tool_call */
  response_format?: {
    type: 'json_schema';
    json_schema: {
      name: string;
      strict: boolean;
      schema: Record<string, unknown>;
    };
  };
  /** 预留字段（当前无消费者）：openaiCompatible 始终以 stream:true 发起，chat() 返回 AsyncIterable */
  stream?: boolean;
  /** 推理深度控制：'low'|'medium'|'high'，Provider 不支持时静默忽略 */
  reasoning_effort?: 'low' | 'medium' | 'high';
  /** 中止信号：用户取消时传入，Provider 应传给底层 fetch/stream 以支持中断 */
  signal?: AbortSignal;
  /** 请求超时（毫秒，默认 120s）：超时抛 networkError，由 callLlmWithRetry 决定是否重试 */
  timeoutMs?: number;
}

/** LLM Provider 抽象类：实现类需实现 chat() 流式方法 */
export abstract class LlmProvider {
  abstract readonly name: string;

  /** 是否支持结构化输出（默认 false）。注意：response_format 不能与 tools 同时使用（OpenAI 协议限制） */
  readonly supportsStructuredOutput: boolean = false;

  /** 流式对话：返回 AsyncIterable，每项是一个增量块 */
  abstract chat(messages: Message[], opts?: ChatOptions): AsyncIterable<LlmChunk>;
}
