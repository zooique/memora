/**
 * LLM Judge 高阶辅助函数
 *
 * 抽象"流式累积 → parseLlmJson → 判 null → 抛 configError"三件套模式。
 * 用于 memoryInspector / memoryDecayScheduler / memoryAdvisor 三个 Manager 的 LLM 判断流程，
 * 消除 3 处重复模式（ADR-017 枝叶层 2 次提取原则）。
 *
 * 设计要点：
 *   - 流式累积：与 TextPolishManager / SessionArchiver 同模式
 *   - 统一异常：parseLlmJson 返回 null 时抛 configError（统一 MemoraError 体系，避免裸 throw Error）
 *   - 类型参数化：调用方传入期望的返回类型 T
 */

import type { LlmProvider, Message } from '@/llm/provider.js';
import { parseLlmJson } from '@/utils/json.js';
import { configError } from '@/utils/errors.js';

/** LLM Judge 调用选项（流式 + 超时 + 取消信号） */
export interface LlmJudgeOptions {
  /** 流式响应的最大 token 数（控制单次调用成本） */
  maxTokens: number;
  /** LLM 调用超时（ms），超时后中止请求 */
  timeoutMs: number;
  /** 可选的取消信号（与 timeoutMs 互相独立，任一触发即中止） */
  signal?: AbortSignal;
}

/**
 * 调用 LLM 流式累积响应并解析为 JSON 对象
 *
 * 三件套模式封装：
 *   1. 流式累积 LLM 响应（chunk.content 拼接）
 *   2. parseLlmJson 解析为对象 T（容错：剥离代码块、修复常见错误、正则兜底）
 *   3. 解析失败抛 configError（统一 MemoraError 体系，附带排查建议）
 *
 * @param provider LLM Provider 实例（通常为 backgroundProvider）
 * @param messages LLM 消息数组（system + user）
 * @param options 调用选项（maxTokens / timeoutMs / signal）
 * @param errorTitle 解析失败时抛出 configError 的标题（中文简短）
 * @returns 解析后的对象（类型由调用方指定）
 */
export async function judgeWithLlm<T extends object>(
  provider: LlmProvider,
  messages: Message[],
  options: LlmJudgeOptions,
  errorTitle: string,
): Promise<T> {
  let llmResponse = '';

  // 流式累积模式（与 TextPolishManager / SessionArchiver 一致）
  for await (const chunk of provider.chat(messages, {
    maxTokens: options.maxTokens,
    temperature: 0,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  })) {
    if (chunk.content) llmResponse += chunk.content;
  }

  // 解析 LLM 响应（JSON 格式），失败则抛 configError（统一 MemoraError 体系）
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
