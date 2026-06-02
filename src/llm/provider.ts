/**
 * LLM Provider 抽象接口
 * 所有 LLM 实现（DeepSeek / 豆包 / OpenAI / Mock）必须实现此接口
 * 详见 ADR-003
 */
import type { LlmChunk } from './types.js';

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
  // 强制不使用流式
  stream?: boolean;
}

export interface Chunk {
  content: string;
  done: boolean;
}

/**
 * LLM Provider 抽象类
 * 实现类需实现 chat() 流式方法
 */
export abstract class LlmProvider {
  abstract readonly name: string;

  /**
   * 流式对话
   * 返回 AsyncIterable，每项是一个增量块
   */
  abstract chat(messages: Message[], opts?: ChatOptions): AsyncIterable<LlmChunk>;
}
