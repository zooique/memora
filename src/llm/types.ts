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
  /**
   * 模型思考内容增量片段（对应协议 `delta.reasoning_content`，deepseek 等思考模型）。
   * 与 content 同为增量语义（消费侧自行累积）；仅供 UI 折叠展示，**不进正文/记忆**（CoT 防护）。
   * 非思考模型恒 undefined，自然降级。命名用 thought 而非 reasoning/thinking：与多模型路由任务
   * 类型 `TaskType='reasoning'` 语义分离，也避开 ProcessEvent 既有 `type:'thinking'` 相位事件。
   */
  thought?: string;
  /**
   * 流式工具意图预告（2026-09-17）：tool_call 的 name 在流式 delta 中**成形即上报**，
   * 无需等到 finish_reason='tool_calls'。写文件等大参数工具的参数生成段可能长达数十秒，
   * 此字段让 UI 提前渲染「准备中」工具行，消除事件真空期。瞬态展示轨，不落盘。
   * 非 tool_calls 流 / 非 OpenAI 兼容 provider 恒 undefined，自然降级。
   */
  partialToolCall?: { id: string; name: string };
  /** 实际 API 用量统计（仅在流结束时的最终 chunk 携带，部分 Provider 不支持） */
  usage?: {
    /** 输入 token 数（prompt_tokens） */
    inputTokens: number;
    /** 输出 token 数（completion_tokens） */
    outputTokens: number;
    /** 总 token 数（total_tokens） */
    totalTokens?: number;
  };
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
  /**
   * 是否支持原生工具调用（OpenAI Function Calling tools 协议）。
   * 本地运行时（Ollama/LM Studio 等）是否支持原生 FC 无法从 baseUrl 推断，搬到配置显式声明。
   * 与 supportsStructuredOutput 互斥（response_format 不能与 tools 同用），2026-09-14 阶段0。
   */
  supportsToolCalling?: boolean;
  /** 是否支持结构化输出（response_format / JSON mode） */
  supportsStructuredOutput?: boolean;
}

/** LLM 任务类型：按任务复杂度路由到不同 Provider/模型（simple/reasoning/code/summary） */
export type TaskType = 'simple' | 'reasoning' | 'code' | 'summary';

/** Provider 路由选择器：按任务类型返回 Provider；不配置路由时所有任务类型复用同一 Provider */
export type ProviderRouter = (taskType: TaskType) => LlmProvider;
