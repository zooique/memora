/**
 * LLM Provider 抽象接口
 * 所有 LLM 实现（DeepSeek / 豆包 / OpenAI / Mock）必须实现此接口
 * 详见 ADR-003
 */
import type { LlmChunk } from '@/llm/types.js';

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  // 工具调用（assistant 消息）
  toolCalls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  // 工具结果（tool 消息）
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
   * 结构化输出约束（OpenAI response_format 兼容协议）
   *
   * 当 Provider 支持 structured output 且工具定义标记 strict 时，
   * AgentLoop 自动生成 json_schema 约束，强制 LLM 输出合法 tool_call。
   * 不支持的 Provider 静默跳过，fallback 到纯文本 tool_call 模式。
   */
  response_format?: {
    type: 'json_schema';
    json_schema: {
      name: string;
      strict: boolean;
      schema: Record<string, unknown>;
    };
  };
  // 强制不使用流式
  stream?: boolean;
  /**
   * LLM 通道选择（多 Provider 路由预留）
   *
   * - 'chat'：前台通道，用于用户对话（高质量、低延迟）
   * - 'background'：后台通道，用于归档/投影/画像（中等质量、低成本）
   *
   * 不指定时使用默认 chat 通道。
   *
   * @experimental 多 Provider 路由功能处于设计阶段，当前所有消费者共用
   * 同一 Provider。该字段已声明但未被任何 LLM 调用路径读取（GAP-9 扫描确认），
   * 待多通道路由真正实现时激活。
   * 详见接入指南 §九
   */
  channel?: 'chat' | 'background';
  /**
   * 中止信号：用于取消正在进行的 LLM 请求
   *
   * AgentLoop 在用户取消对话时传入 AbortSignal，
   * Provider 应将 signal 传给底层 fetch/stream 读取，确保请求可被中断。
   */
  signal?: AbortSignal;
  /**
   * 请求超时（毫秒）。默认 120 秒。
   * 超时后抛出 networkError，由 callLlmWithRetry 决定是否重试。
   */
  timeoutMs?: number;
}

/**
 * LLM Provider 抽象类
 * 实现类需实现 chat() 流式方法
 */
export abstract class LlmProvider {
  abstract readonly name: string;

  /**
   * 是否支持结构化输出（response_format json_schema）
   *
   * 默认 false，子类可覆盖。用于非 tool_call 场景的结构化输出约束
   * （如归档摘要强制 JSON、配置建议提取等）。调用方在构造 ChatOptions
   * 时显式传入 response_format，Provider 应将其透传到请求 body。
   *
   * 注意：response_format 不能与 tools 同时使用（OpenAI 协议限制），
   * tool_calls 走独立的 SSE delta 流式协议，无需此约束。
   *
   * 历史背景（GAP-8 清理）：曾用于"约束 tool_call 输出格式"，但该
   * 设计与 OpenAI 协议不符，相关死代码已从 AgentLoop.buildChatOptions 移除。
   */
  readonly supportsStructuredOutput: boolean = false;

  /**
   * 流式对话
   * 返回 AsyncIterable，每项是一个增量块
   */
  abstract chat(messages: Message[], opts?: ChatOptions): AsyncIterable<LlmChunk>;
}
