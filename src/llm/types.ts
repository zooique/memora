/**
 * LLM 适配层抽象接口
 *
 * 详见 ADR-003 · LLM 适配层使用 OpenAI Chat Completions 兼容协议
 */
import type { LlmProvider, Message, ChatOptions } from './provider.js';

// 重导出，方便使用
export type { LlmProvider, Message, ChatOptions };

/**
 * 消息角色
 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * 工具调用描述
 */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON 字符串
  };
}

/**
 * LLM 响应块
 */
export interface LlmChunk {
  content?: string;
  toolCalls?: ToolCall[];
  finishReason?: 'stop' | 'tool_calls' | 'length' | 'error';
}
