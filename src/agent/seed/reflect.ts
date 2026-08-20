/**
 * 回答后（Reflect）— 种子闭环第三阶段
 *
 * 收敛原 Agent.postProcess / doPostProcess：后台异步生成轮次摘要（round-summary，
 * 记忆即摘要单轨）。本阶段为薄壳——外层负责 span 生命周期，核心委托
 * roundSummaryGenerator.generate（fire-and-forget，失败仅记日志不阻塞主流程）。
 *
 * 设计纪律：
 *   - 非阻塞：返回 Promise，调用方以 `.catch` 包裹（与门面原有 postProcess 语义一致），
 *     摘要生成不阻塞用户已收到的回答。
 *   - 策略门控：reflect.summary='off' 时跳过（一次性对话不沉淀）。
 *   - 提炼视角注入：激活角色包 prepare.summaryFocus 透传给摘要生成（结构化角色包
 *     以其替换通用归纳框架，实验特性，非法值回退 undefined）。
 */

import { logger } from '@/logging/logger.js';
import { TRACE_SPANS, NOOP_TRACER } from '@/agent/tracer.js';
import { resolveSummary, resolveSummaryFocus } from '@/role-pack/types.js';
import { resolveActiveStrategy, type SeedDeps, type SeedParts } from './types.js';

/**
 * 回答后阶段执行器
 *
 * 收敛 postProcess 的 span 生命周期 + round-summary 生成委托（薄壳）。
 */
export class SeedReflect {
  /** 依赖注入（门面稳定能力窄面） */
  private readonly deps: SeedDeps;

  constructor(deps: SeedDeps) {
    this.deps = deps;
  }

  /**
   * 执行回答后：生成轮次摘要（记忆即摘要单轨），best-effort 不阻塞。
   *
   * @param input 用户输入（摘要生成的输入侧）
   * @param assistantContent 助手回答（摘要生成的输出侧）
   * @returns Promise<void>；调用方应以 .catch 包裹（与门面原有非阻塞后处理语义一致）
   */
  async run(input: string, assistantContent: string): Promise<void> {
    const tracer = this.deps.tracer ?? NOOP_TRACER;
    const span = tracer.startSpan(TRACE_SPANS.POST_PROCESS, {
      archiveMode: this.deps.archiveMode,
    });

    try {
      const { history, loop, roundSummaryGenerator, rolePackManager } =
        this.deps.getParts() as SeedParts;

      // 记忆为 round-summary 单轨，无独立画像/洞察归档路径。

      // 轮次摘要生成（记忆即摘要架构）：reflect.summary='off' 时跳过
      if (roundSummaryGenerator && resolveSummary(resolveActiveStrategy(rolePackManager)) === 'on') {
        try {
          const roundId = loop.getCurrentRoundId();
          const sessionName = history.currentSessionName;
          // 提炼视角：激活角色包 prepare.summaryFocus → 注入摘要生成（结构化角色包以此替换通用归纳框架）
          const summaryFocus = resolveSummaryFocus(resolveActiveStrategy(rolePackManager));
          // fire-and-forget：不阻塞主流程，失败仅记日志
          const summaryPromise = roundSummaryGenerator.generate(
            input,
            assistantContent,
            roundId,
            sessionName,
            summaryFocus,
          );
          history.registerPendingArchive(summaryPromise);
        } catch (err) {
          logger.warn({ err }, '轮次摘要生成初始化失败');
        }
      }
    } finally {
      span.end();
    }
  }
}