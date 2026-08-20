/**
 * 难度分级 — 回答前判定一次问答为「简单/复杂」
 *
 * 对应任务驱动模型阶段 1「难度分级」。在回答前做一次轻量 LLM 判断：
 * 简单 → 直接一轮问答（不鼓励多步规划、不触发汇报）；复杂 → 复杂任务收敛后触发汇报闭环。
 *
 * 设计纪律：
 *   - 纯新增、可逆：判定结果只影响「是否进入汇报」这一条附加路径，不改动现有回答语义。
 *   - 用后台 Provider（backgroundProvider）：判定属「回答前视图」，与角色 LLM 兜底同源
 *     （非阻塞主线生成模型），backgroundProvider 为 null 时优雅跳过 → 返回 'unknown'。
 *   - 过度判断是浪费：single low-token 调用，仅区分 simple/complex 两态。
 */

import type { LlmProvider, Message } from '@/llm/provider.js';
import type { ITracer } from '@/agent/tracer.js';
import { TRACE_SPANS, NOOP_TRACER } from '@/agent/tracer.js';
import { logger } from '@/logging/logger.js';

/** 难度三态：simple=简单问答 / complex=复杂任务 / unknown=无法判定（跳过汇报） */
export type Difficulty = 'simple' | 'complex' | 'unknown';

/** 任务分类提示：让 LLM 只输出 simple/complex 二选一 */
const DIFFICULTY_SYSTEM_PROMPT =
  '判断下面用户的提问属于哪一类，只输出 simple 或 complex 其中一个词：\n' +
  '- simple：简单问答、闲聊、一句话能答清、无需读取文件或分步执行\n' +
  '- complex：需多步推理、读取/修改文件、调用工具、拆解任务、联网搜索、生成报告\n\n' +
  '只输出 simple 或 complex，不要输出其他内容。';

/**
 * 难度分级执行器
 *
 * 持有后台 Provider 的 getter（运行时 setBackgroundProvider 切换后仍取到最新），
 * 供种子编排器在回答前调用，产出 report-eligibility 信号。
 */
export class DifficultyJudge {
  /** 后台 Provider getter（判定用；返回 null 时判定 unknown） */
  private readonly getBackgroundProvider: () => LlmProvider | null;
  /** 可观测性 Tracer */
  private readonly tracer: ITracer;

  constructor(getBackgroundProvider: () => LlmProvider | null, tracer: ITracer | null) {
    this.getBackgroundProvider = getBackgroundProvider;
    this.tracer = tracer ?? NOOP_TRACER;
  }

  /**
   * 判定输入难度。
   *
   * @param input 用户输入
   * @returns simple | complex | unknown（后台不可用或解析失败时 unknown）
   *
   * 失败降级为 unknown，绝不因判定失败阻断主回答——难度分级是附加路径，不影响既有闭环。
   */
  async classify(input: string): Promise<Difficulty> {
    const provider = this.getBackgroundProvider();
    if (!provider) return 'unknown';

    const span = this.tracer.startSpan(TRACE_SPANS.DIFFICULTY, { inputLength: input.length });
    try {
      const messages: Message[] = [
        { role: 'system', content: DIFFICULTY_SYSTEM_PROMPT },
        { role: 'user', content: input },
      ];
      // 流式、低 token 上限：只需一个词的判词
      const stream = provider.chat(messages, { maxTokens: 8, temperature: 0 });
      let raw = '';
      for await (const chunk of stream) {
        if (chunk.content) raw += chunk.content;
      }
      const verdict = raw.trim().toLowerCase();
      if (verdict.includes('complex')) return 'complex';
      if (verdict.includes('simple')) return 'simple';
      // 解析不到明确判词 → 视复杂处理风险更低（复杂才可能触发汇报，误判简单会漏汇报）
      return verdict === '' ? 'unknown' : 'complex';
    } catch (err) {
      span.recordException?.(err instanceof Error ? err : new Error(String(err)));
      logger.warn({ err }, '难度判定失败（降级 unknown，不阻断回答）');
      return 'unknown';
    } finally {
      span.end();
    }
  }
}
