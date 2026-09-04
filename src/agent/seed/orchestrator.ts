/**
 * 种子 turn 编排器 — 单 turn 动态 step 循环承载所有复杂度（2026-09-04 收敛）。
 *
 * 「如何串联一个 turn」全部收在此处，门面只做一行委托 + 生命周期守卫。
 * 宿主是插座——只调 runChat / runResume，内核自主决定 step 循环长度与任务表策略。
 * 复杂任务（task_table_write + 动态规划）在一个 turn 的 step 循环里自然生长，
 * 不再强制拆成多 turn 编排（档2 已砍；见 tasks/收敛多turn编排到动态单turn.md）。
 *
 * 两个显式命名入口（turn 只认 Trigger、不认来源）：
 *   - runChat   （对话 Trigger）   完整 turn：prepare → act(processUserInput) → reflect → handoff
 *   - runResume （续跑 Trigger）   act(continueAfterPause) → reflect（无 prepare、无 Handoff）
 */

import type { AgentChunk } from '@/agent/types.js';
import type { InteractiveInputKind } from '@/memory/roundStore.js';
import { LOOP_CONSTANTS } from '@/agent/constants.js';
import { logger } from '@/logging/logger.js';
import { isTimeoutAbortSignal } from '@/utils/errors.js';
import { resolveActiveStrategy } from '@/role-pack/strategyResolver.js';
import {
  type StreamConsumeResult,
  type SeedDeps,
  type SeedParts,
} from './types.js';
import { SeedPrepare } from './prepare.js';
import { resolveHandoff, resolveSummary, resolveSummaryFocus } from '@/role-pack/strategyResolver.js';
import { TRACE_SPANS, NOOP_TRACER } from '@/agent/tracer.js';
import { backgroundTask } from '@/utils/backgroundTask.js';

/**
 * 种子 turn 编排器
 *
 * 聚合回答前/中/后与 Handoff 四阶段，提供 turn 编排的全部入口（runChat/runResume）。
 * prepare / act / reflect / handoff 各自可测；编排语义只在 orchestrator 唯一实现。
 */
export class SeedOrchestrator {
  /** 依赖注入（门面稳定能力窄面） */
  private readonly deps: SeedDeps;
  /** 回答前（装配上下文 + 召回 + 技能 + 用户消息入史） */
  private readonly prepare: SeedPrepare;

  constructor(deps: SeedDeps) {
    this.deps = deps;
    this.prepare = new SeedPrepare(deps);
  }

  /**
   * 对话路径完整 turn：回答前 → 回答中(processUserInput) → 回答后 → Handoff。
   * 所有复杂度（含 LLM 动态建任务表）在一个 turn 的 step 循环里承载。
   *
   * @param input 用户输入
   * @param signal 中止信号
   * @yields AgentChunk 事件流（thinking / handoff / 透传 loop 执行流 chunk）
   */
  async *runChat(input: string, signal: AbortSignal): AsyncGenerator<AgentChunk, void, unknown> {
    // 回答前：装配上下文 + 召回记忆
    const prepared = yield* this.prepare.run(input, signal);
    if (prepared.aborted) {
      yield {
        type: 'aborted',
        reason: isTimeoutAbortSignal(signal)
          ? 'LLM request timed out (no response)'
          : this.abortedReasonByUser(),
        stopReason: isTimeoutAbortSignal(signal) ? 'timeout' : 'user',
      };
      return;
    }

    // 回答中：消费 loop.processUserInput 执行流
    const produce = () =>
      this.deps
        .getParts()
        .loop.processUserInput(
          input,
          prepared.recalledMemories,
          signal,
          this.deps.getParts().loop.getCurrentRoundId(),
        );
    const acted = yield* this.act(produce, signal);
    if (acted.failed || acted.aborted || acted.paused) return;

    // 回答后：摘要
    this.backgroundReflect(input, acted.content);

    // Handoff：对外产出衔接决策
    yield* this.handoff(acted.iterationLimitReached);
  }

  /**
   * 续跑路径 turn：回答中(continueAfterPause) → 回答后。无回答前、无 Handoff。
   *
   * 续跑是已在暂停点保留上下文的继续执行，故不重新装配上下文、不在 turn 出口分岔
   * （handoff）——差异源于 Trigger 的续跑语义，收在编排器内。
   *
   * TS-9 问答闭环归属：交互输入不分配新 roundId——续跑延续 prepare 分配的 turn 节点
   * roundId（loop.currentRoundId），appendUser 以交互归属（interactive）追加到该轮
   * interactiveInputs，round 记录不因交互输入分裂。
   *
   * @param input 可选补充输入（空=续跑原路径；有=注入修正后续轮，同一 turn 节点内）
   * @param signal 中止信号
   * @param kind 交互输入类型（question-answer=主动提问回答；supplement=暂停后补充，默认）
   * @yields AgentChunk 事件流
   */
  async *runResume(
    input: string | undefined,
    signal: AbortSignal,
    kind: InteractiveInputKind = 'supplement',
  ): AsyncGenerator<AgentChunk, void, unknown> {
    const parts = this.deps.getParts();
    // 交互输入归属当前 turn 节点（SSOT：roundId 唯一锚点=prepare appendUser 的 head roundId，
    // 不重新 alloc——turn 分裂点已由 TS-9 收敛）。空 roundId 时 fallback alloc。
    if (input?.trim()) {
      const closureRoundId = parts.loop.getCurrentRoundId() || parts.loop.allocRoundId();
      parts.loop.setCurrentRoundId(closureRoundId);
      try {
        await parts.history.appendUser(input, closureRoundId, {
          interactive: true,
          kind,
        });
      } catch (err) {
        logger.warn({ err }, '续跑用户回答历史写入失败');
      }
    }
    // 回答中：消费 loop.continueAfterPause 执行流
    const produce = () => parts.loop.continueAfterPause(input, signal);
    const acted = yield* this.act(produce, signal);
    if (acted.failed || acted.aborted || acted.paused) return;

    // 续跑正常完成：摘要
    this.backgroundReflect(input ?? '', acted.content);
  }

  /**
   * 回答后统一 fire-and-forget 封装：非阻塞生成轮次摘要，失败仅记日志。
   * @param input 用户输入（摘要输入侧）
   * @param assistantContent 助手回答（摘要输出侧）
   */
  private backgroundReflect(input: string, assistantContent: string): void {
    backgroundTask('round-summary', () => this.reflect(input, assistantContent));
  }

  /** 回答中：消费 produce() 生成的 loop 执行流，统一尾处理。
   * chat/resume 路径共用（驱动不同 loop 入口），中断/追加助手消息尾处理收在此。
   * @param produce 生成 loop 执行流的闭包
   * @param signal 中止信号（透传 consumeExecutionStream 区分真取消 vs 连接中断）
   */
  private async *act(
    produce: () => AsyncGenerator<AgentChunk, void, unknown>,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentChunk, StreamConsumeResult, unknown> {
    // 流消费统一收口于门面的 consumeExecutionStream（对话/事件/续跑共用同构实现）
    const streamResult = yield* this.deps.consumeExecutionStream(produce(), signal);
    if (streamResult.failed) return streamResult;

    const assistantContent = streamResult.content;
    const history = this.deps.getParts().history;
    const loop = this.deps.getParts().loop;

    // 中断：保留已产出文本 + 中断标记写入历史后返回（不进回答后 / Handoff）
    if (streamResult.aborted) {
      if (assistantContent.trim()) {
        // 中断标记默认文案与 loop 统一走 LOOP_CONSTANTS（SSOT），避免宿主未注入 messages 时两处降级不一致
        const interruptedMark = this.deps.messages?.interrupted ?? LOOP_CONSTANTS.DEFAULT_INTERRUPTED_MARK;
        try {
          await history.appendAssistant(
            assistantContent + interruptedMark,
            loop.getCurrentRoundId(),
          );
        } catch (err) {
          logger.warn({ err }, '中断消息历史写入失败');
        }
      }
      return {
        content: assistantContent,
        aborted: true,
        paused: false,
        failed: false,
      } satisfies StreamConsumeResult;
    }

    // 正常完成：助手消息写历史（失败仅记日志，不阻断回答后）
    try {
      await history.appendAssistant(assistantContent, loop.getCurrentRoundId());
    } catch (err) {
      logger.warn({ err }, '助手消息历史写入失败');
    }

    // 暂停挂起轮：本轮无摘要/无归档动作，不产出归档指示（避免 UI 暂停态被 "archiving" 覆盖）
    if (streamResult.paused) {
      return streamResult satisfies StreamConsumeResult;
    }

    yield { type: 'thinking', phase: 'archiving' };
    return streamResult satisfies StreamConsumeResult;
  }

  /** 回答后普通摘要：round-summary fire-and-forget，进后台收口 */
  private async reflect(input: string, assistantContent: string): Promise<void> {
    await this.runSummary(input, assistantContent, TRACE_SPANS.POST_PROCESS);
  }

  /** 摘要生成统一委托：铺 span + 收敛 round-summary（记忆即摘要单轨），策略门控开才生成 */
  private async runSummary(
    input: string,
    assistantContent: string,
    spanName: string,
  ): Promise<void> {
    const tracer = this.deps.tracer ?? NOOP_TRACER;
    const span = tracer.startSpan(spanName, { archiveMode: this.deps.archiveMode });
    try {
      const { history, loop, roundSummaryGenerator, rolePackManager } =
        this.deps.getParts() as SeedParts;

      const roundId = loop.getCurrentRoundId();
      // reflect.summary='off' 或 generator 不存在 → 无摘要，直接 emit 让宿主解锁 UI
      const summaryOn =
        !!roundSummaryGenerator &&
        resolveSummary(resolveActiveStrategy(rolePackManager, this.deps.strategyOverride)) === 'on';

      if (summaryOn) {
        try {
          const sessionName = history.currentSessionName;
          // 提炼视角：激活角色包 prepare.summaryFocus → 注入摘要生成（无则通用归纳框架）
          const summaryFocus = resolveSummaryFocus(
            resolveActiveStrategy(rolePackManager, this.deps.strategyOverride),
          );
          const summaryPromise = roundSummaryGenerator.generate(
            input,
            assistantContent,
            roundId,
            sessionName,
            summaryFocus,
          );
          history.registerPendingArchive(summaryPromise);
          // 摘要完成后 emit roundSummaryGenerated → 宿主据此解锁 UI（删除/分叉按钮解禁）
          // 关键：不能等 await——runSummary 是后台 fire-and-forget，不能把 chat() generator
          // 的收尾阻塞在摘要 LLM 调用上。用 .then/.catch 非阻塞挂起回调。
          summaryPromise.then(
            () => this.deps.emit?.('roundSummaryGenerated', { roundId, success: true }),
            () => this.deps.emit?.('roundSummaryGenerated', { roundId, success: false }),
          );
        } catch (err) {
          logger.warn({ err }, '轮次摘要生成初始化失败');
          this.deps.emit?.('roundSummaryGenerated', { roundId, success: false });
        }
      } else {
        // 摘要关闭 → 无后台任务需等待，直接 emit 让宿主解锁
        this.deps.emit?.('roundSummaryGenerated', { roundId, success: true });
      }
    } finally {
      span.end();
    }
  }

  /** Handoff 衔接决策：产出 turn 出口 chunk。
   *  SSOT：角色包参数（reflect.handoff 等）仅由内核消费——'loop' 是内核内部的自主续跑许可信号，
   *  已由 loop 的 stepBudget/maxIterations 在单次 chat() 内消费完，绝不外泄给宿主（宿主只是插座）。
   *  故对外 handoff 恒为 'wait'（把控制权交还用户）或 'end'（任务完成）。
   *  @param forceWait 是否强制返回 wait（迭代上限时启用，防止误导宿主自动续跑） */
  private async *handoff(forceWait = false): AsyncGenerator<AgentChunk, void, unknown> {
    const strategy = resolveActiveStrategy(this.deps.getParts().rolePackManager, this.deps.strategyOverride);
    const mode = forceWait ? 'wait' : resolveHandoff(strategy);
    const decision = mode === 'end' ? 'end' : 'wait';
    yield {
      type: 'handoff',
      decision,
      reason: forceWait
        ? '迭代上限已达，等待用户介入'
        : mode === 'loop'
          ? '本轮自主执行已完成，等待你的指示'
          : undefined,
    };
  }

  /**
   * 用户中断原因文案（SSOT：优先宿主注入，回退内置默认）
   * @returns 中断原因文案
   */
  private abortedReasonByUser(): string {
    return this.deps.messages?.abortedByUser ?? 'User cancelled the conversation';
  }
}
