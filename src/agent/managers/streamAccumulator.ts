/**
 * 流式累积工具 — 纯函数，累积 LLM 流式响应的 chunk.content（消除各 Manager 重复的 for await 拼接）。
 * 纯工具不持业务逻辑：不解析 JSON、不处理 null、不捕获异常，均由调用方决定。
 * 与 judgeWithLlm 关系：本函数是容错累积；judgeWithLlm 是严格封装（累积+parseLlmJson+null 抛 configError），内部复用本函数。
 */

import type { LlmProvider, Message } from '@/llm/provider.js';

/** LLM 调用选项（与 provider.chat 对齐，可选传递） */
export interface AccumulateOptions {
  /** 流式响应最大 token 数（控单次成本） */
  maxTokens?: number;
  /** 温度参数（0=确定性，1=创造性） */
  temperature?: number;
  /** LLM 调用超时（ms），超时中止 */
  timeoutMs?: number;
  /** 可选取消信号（与 timeoutMs 独立，任一触发即中止） */
  signal?: AbortSignal;
}

/** 累积 LLM 流式响应的 chunk.content；返回完整字符串（可能为空，由调用方处理） */
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
