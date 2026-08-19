/** LLM 适配层类型定义（OpenAI Chat Completions 兼容协议） */
import type { LlmProvider } from '@/llm/provider.js';

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON 字符串
  };
}

export interface LlmChunk {
  content?: string;
  toolCalls?: ToolCall[];
  finishReason?: 'stop' | 'tool_calls' | 'length' | 'error';
}

// ─── Provider 配置类型（来自 config/loader.ts，归入 LLM 领域） ───

/** 单个 Provider 配置（providers 映射表的值）；内核仅透传 provider 字段，不做路由决策 */
export interface ProviderEntryConfig {
  /** 标识（仅用于日志，不影响路由） */
  provider: string;
  model: string;
  /** API 基础 URL（可选——内核不做预设回退，缺失时工厂会报错） */
  baseUrl?: string;
  /** API 密钥（可选，从环境变量读取。本地 LLM 如 Ollama 可为空字符串） */
  apiKey?: string;
  /** temperature，未配置时回退到全局 llm.temperature */
  temperature?: number;
  /** 上下文窗口（token），未配置时回退到 memory.maxContextTokens */
  contextWindow?: number;
}

/** 后台通道配置（多 Provider 路由预留）：不配时后台操作复用前台 llm 配置，零破坏性 */
export interface BackgroundConfig {
  /** Provider 名称 */
  provider: string;
  model: string;
  /** API 基础 URL（可选） */
  baseUrl?: string;
  /** API 密钥（可选，从环境变量读取） */
  apiKey?: string;
  /** 该通道的 temperature */
  temperature: number;
}

/** LLM 任务类型：按任务复杂度路由到不同 Provider/模型（simple/reasoning/code/summary） */
export type TaskType = 'simple' | 'reasoning' | 'code' | 'summary';

/** Provider 路由选择器：按任务类型返回 Provider；不配置路由时所有任务类型复用同一 Provider */
export type ProviderRouter = (taskType: TaskType) => LlmProvider;
