/**
 * LLM 适配层类型定义
 *
 * 详见 ADR-003 · LLM 适配层使用 OpenAI Chat Completions 兼容协议
 */
import type { LlmProvider } from '@/llm/provider.js';

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

/**
 * LLM 任务类型（P1-2 多模型路由基础）
 *
 * 用于根据任务复杂度选择不同的 Provider/模型：
 * - simple：简单问答、角色匹配、时效性评估等低复杂度任务
 * - reasoning：复杂推理、代码生成、架构分析等高复杂度任务
 * - code：代码相关任务（代码补全、审查、重构等）
 * - summary：摘要生成（上下文截断、归档等）
 */
export type TaskType = 'simple' | 'reasoning' | 'code' | 'summary';

/**
 * Provider 路由选择器（P1-2 多模型路由基础）
 *
 * 根据任务类型返回对应的 Provider 实例。
 * 不配置路由时，所有任务类型使用同一个 Provider（完全向后兼容）。
 */
export type ProviderRouter = (taskType: TaskType) => LlmProvider;
