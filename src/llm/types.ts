/**
 * LLM 适配层类型定义
 *
 * 详见 ADR-003 · LLM 适配层使用 OpenAI Chat Completions 兼容协议
 */

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
