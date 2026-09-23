/** LLM Provider 抽象接口：所有 LLM 实现（DeepSeek/豆包/OpenAI/Mock）必须实现 */
import type { LlmChunk } from '@/llm/types.js';

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /**
   * 轮次 ID（可选）：标识该消息归属的「问答轮次」。
   * 由 loop 在写入 user/assistant/tool 消息时附上当前 currentRoundId，
   * 作为替换式压缩（第一级 LRU）取 round-summary 的单一真理源——
   * roundId 随消息携带，不依赖任何外部序列的尾部对齐，杜绝错位替换。
   */
  roundId?: string;
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
  /**
   * 结构化输出约束（OpenAI Function Calling 响应格式约束）。
   * 注意：response_format 不能与 tools 同时使用（OpenAI 协议限制），故 AgentLoop 默认不生成它
   * （见 loop.ts buildChatOptions 注释）——此处仅为调用方显式传入时的可选能力孔，不宣称任何
   * 「fallback 到纯文本 tool_call」的静默降级（文本出口不是可调用通道）。
   */
  response_format?: {
    type: 'json_schema';
    json_schema: {
      name: string;
      strict: boolean;
      schema: Record<string, unknown>;
    };
  };
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

  /**
   * 是否支持原生工具调用（OpenAI Function Calling 的 tools 协议）。
   *
   * 与 supportsStructuredOutput 互斥（response_format 不能与 tools 同时使用，OpenAI 协议限制）：
   * - 支持 tools → loop 走原生工具通道（列工具 + 传 tools 参数）。
   * - 支持 structured → loop 传 response_format（JSON mode 回落）。
   * - 两者皆 false → 无工具能力，loop 收起工具清单并显式告知（可观测，不静默）。
   *
   * 默认 **true**（存量行为）：云 LLM 绝大多数支持原生 FC（有工具集就传 tools，与历史一致）。
   * 本地运行时（Ollama/LM Studio 等）是否支持原生 FC 无法从 baseUrl 推断，须在宿主配置时
   * 显式置 false（互斥双能力位）。
   */
  readonly supportsToolCalling: boolean = true;

  /** 是否支持结构化输出（默认 false）。注意：response_format 不能与 tools 同时使用（OpenAI 协议限制） */
  readonly supportsStructuredOutput: boolean = false;

  /** 流式对话：返回 AsyncIterable，每项是一个增量块 */
  abstract chat(messages: Message[], opts?: ChatOptions): AsyncIterable<LlmChunk>;
}
