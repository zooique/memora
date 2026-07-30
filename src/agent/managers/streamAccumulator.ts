/**
 * 流式累积工具 — 纯函数，累积 LLM 流式响应的 chunk.content
 *
 * 消除多个 Manager 中重复的"for await + chunk.content 拼接"模式（ADR-017 枝叶层提取）。
 *
 * 设计原则：
 *   - 纯工具函数，不持有业务逻辑
 *   - 不解析 JSON（由调用方决定用 parseLlmJson 或其他方式）
 *   - 不处理 null（由调用方决定降级或抛错）
 *   - 不捕获 provider 异常（由调用方决定 try/catch 或向上抛）
 *
 * 使用示例：
 *   ```typescript
 *   const raw = await accumulateStream(provider, messages, { maxTokens: 400 });
 *   const parsed = parseLlmJson<MyType>(raw.trim());
 *   if (!parsed) return defaultValue; // 调用方决定降级策略
 *   ```
 *
 * 与 judgeWithLlm 的关系：
 *   - accumulateStream：纯流式累积（容错模式，调用方决定后续处理）
 *   - judgeWithLlm：严格模式封装（流式累积 + parseLlmJson + null 抛 configError）
 *   - judgeWithLlm 内部也调用 accumulateStream，避免自身重复
 */

import type { LlmProvider, Message } from '@/llm/provider.js';

/** LLM 调用选项（与 provider.chat 的 options 对齐，可选传递） */
export interface AccumulateOptions {
  /** 流式响应的最大 token 数（控制单次调用成本） */
  maxTokens?: number;
  /** 温度参数（0=确定性，1=创造性） */
  temperature?: number;
  /** LLM 调用超时（ms），超时后中止请求 */
  timeoutMs?: number;
  /** 可选的取消信号（与 timeoutMs 互相独立，任一触发即中止） */
  signal?: AbortSignal;
}

/**
 * 累积 LLM 流式响应的 chunk.content
 *
 * @param provider LLM Provider 实例
 * @param messages LLM 消息数组（system + user）
 * @param options 可选的调用参数（maxTokens/temperature/timeoutMs/signal）
 * @returns 累积后的完整字符串（可能为空字符串，调用方需自行处理）
 */
export async function accumulateStream(
  provider: LlmProvider,
  messages: Message[],
  options?: AccumulateOptions,
): Promise<string> {
  let result = '';
  for await (const chunk of provider.chat(messages, options)) {
    if (chunk.content) result += chunk.content;
  }
  return result;
}
