/**
 * LLM Judge 高阶辅助函数：封装"流式累积 → parseLlmJson → 判 null → 抛 configError"三件套。
 * 由 memoryInspector / memoryAdvisor 复用，消除重复。
 * 统一异常：解析失败抛 configError（MemoraError 体系）；类型参数化，调用方指定返回类型 T。
 */

import type { LlmProvider, Message } from '@/llm/provider.js';
import { parseLlmJson } from '@/utils/json.js';
import { configError } from '@/utils/errors.js';
import { accumulateStream } from '@/agent/managers/streamAccumulator.js';

/** LLM Judge 调用选项（流式 + 超时 + 取消信号） */
export interface LlmJudgeOptions {
  /** 流式响应最大 token 数（控制单次调用成本） */
  maxTokens: number;
  /** LLM 调用超时（ms），超时中止请求 */
  timeoutMs: number;
  /** 可选取消信号（与 timeoutMs 独立，任一触发即中止） */
  signal?: AbortSignal;
}

/**
 * 调用 LLM 流式累积响应并解析为 JSON 对象 T。
 * 流式累积 → parseLlmJson（容错剥离代码块/修复错误/正则兜底）→ 解析失败抛 configError。
 */
export async function judgeWithLlm<T extends object>(
  provider: LlmProvider,
  messages: Message[],
  options: LlmJudgeOptions,
  errorTitle: string,
): Promise<T> {
  // 流式累积 LLM 响应（复用 accumulateStream，消除重复）
  const llmResponse = await accumulateStream(provider, messages, {
    maxTokens: options.maxTokens,
    temperature: 0,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });

  // 解析 JSON，失败抛 configError（统一 MemoraError 体系）
  const parsed = parseLlmJson<T>(llmResponse.trim());
  if (!parsed) {
    throw configError(
      errorTitle,
      'LLM 返回内容不是有效的 JSON（parseLlmJson 解析失败）',
      [
        '检查 backgroundProvider 是否注入并可用',
        '检查 LLM 模型是否输出预期的 JSON 结构',
        '若问题持续，可降低候选数量或调整 prompt',
      ],
    );
  }

  return parsed;
}
