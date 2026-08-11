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

// ─── Provider 配置类型（来自 config/loader.ts，归入 LLM 领域） ───

/**
 * 单个 Provider 配置（用于 providers 映射表的值）
 *
 * 宿主 UI 用 provider 字段存储模式标识（'cloud' / 'local' / 厂商名），
 * 内核仅作透传，不依据此字段做路由决策。
 */
export interface ProviderEntryConfig {
  /** Provider 标识（仅用于日志，不影响路由） */
  provider: string;
  /** 模型名称 */
  model: string;
  /** API 基础 URL（可选——内核不做预设回退，缺失时工厂会报错） */
  baseUrl?: string;
  /** API 密钥（可选，从环境变量读取。本地 LLM 如 Ollama 可为空字符串） */
  apiKey?: string;
  /** 该 Provider 的 temperature，未配置时回退到全局 llm.temperature */
  temperature?: number;
  /** 该 Provider 的上下文窗口大小（token 数），未配置时回退到 memory.maxContextTokens */
  contextWindow?: number;
}

/**
 * 后台通道配置（多 Provider 路由预留）
 *
 * 不配时所有消费者复用前台（llm）配置——零破坏性，完全向后兼容。
 * 配置后，归档/投影/画像等后台操作使用此通道，降低成本。
 * 详见接入指南 §九
 */
export interface BackgroundConfig {
  /** Provider 名称 */
  provider: string;
  /** 模型名称 */
  model: string;
  /** API 基础 URL（可选） */
  baseUrl?: string;
  /** API 密钥（可选，从环境变量读取） */
  apiKey?: string;
  /** 该通道的 temperature */
  temperature: number;
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
