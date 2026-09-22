/**
 * 种子 turn 编排器 — 单 turn 动态 step 循环承载所有复杂度（2026-09-04 收敛）。
 *
 * 「如何串联一个 turn」全部收在此处，门面只做一行委托 + 生命周期守卫。
 * 宿主是插座——只调 runChat / runResume，内核自主决定 step 循环长度与任务表策略。
 * 复杂任务（task_table_write + 动态规划）在一个 turn 的 step 循环里自然生长，
 * 不再强制拆成多 turn 编排（档2 已砍；收敛依据见 docs/architecture/agent-design-philosophy.md 第一章 闭环）。
 *
 * 两个显式命名入口（turn 只认 Trigger、不认来源）：
 *   - runChat   （对话 Trigger）   完整 turn：prepare → act(processUserInput) → reflect
 *   - runResume （续跑 Trigger）   act(continueAfterPause) → reflect（无 prepare）
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
import { SeedPrepare, refreshAssemblyForRolePack } from './prepare.js';
import { resolveSummary, resolveSummaryFocus } from '@/role-pack/strategyResolver.js';
import { TRACE_SPANS, NOOP_TRACER } from '@/agent/tracer.js';
import { backgroundTask } from '@/utils/backgroundTask.js';

/**
 * ask_user 提问超时未答的交互记录正文（2026-09-08）：
 * 宿主计时超时 → cancelAsk（tool result 注入 [ASK_ABORTED]）+ resumeExecution('timeout')
 * → 本常量作为该交互输入的 content 落盘（重放渲染「问 + 未回答」行的正文）。
 * 宿主侧镜像同文案 post 给 webview 即时渲染（运行时 = 重放同构），改此须同步 chatPanel.ts。
 */
export const ASK_TIMEOUT_NOTICE = '用户未在时限内回答，已自动继续';

/**
 * 种子 turn 编排器
 *
 * 聚合回答前/中/后三阶段，提供 turn 编排的全部入口（runChat/runResume）。
 * prepare / act / reflect 各自可测；编排语义只在 orchestrator 唯一实现。
 * turn 结束即流结束 + done 消息——不再对外产出 handoff chunk（2026-09-05 收敛）。
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
   * 对话路径完整 turn：回答前 → 回答中(processUserInput) → 回答后。
   * 所有复杂度（含 LLM 动态建任务表）在一个 turn 的 step 循环里承载。
   * turn 结束即流结束 + done 消息，不再产出 handoff chunk。
   *
   * @param input 用户输入
   * @param signal 中止信号
   * @yields AgentChunk 事件流（thinking / 透传 loop 执行流 chunk）
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
          signal,
          this.deps.getParts().loop.getCurrentRoundId(),
        );
    const acted = yield* this.act(produce, signal);
    if (acted.failed || acted.aborted || acted.paused) return;

    // 回答后：摘要
    this.backgroundReflect(input, acted.content);
  }

  /**
   * 续跑路径 turn：回答中(continueAfterPause) → 回答后。无回答前。
   *
   * 续跑是已在暂停点保留上下文的继续执行，故不重新装配上下文——差异源于 Trigger 的续跑语义，收在编排器内。
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
    // 会议装配视角（T3，2026-09-06）：续跑路径与 prepare 开头对称——按 checkpoint active step 刷新表层装配视角。
    // 背景：prepare.run 每轮开头做同样刷新（prepare.ts），但 runResume 不走 prepare（续跑不重装配上下文）；
    // 跨重启续跑时 roundAssemblyRole 是进程内字段已复位为 null → 不刷新会以组长前缀回答组员步骤
    // （loop 迭代内经 getTaskTable→applyActiveStepAssembly 的刷新晚于 buildChatOptions，首迭代仍有一轮窗口）。
    // 复用 refreshAssemblyForRolePack 单一函数（非复制）：与 prepare 共用同一「装配逻辑唯一实现」。
    const resumeCheckpoint = parts.sessionManager?.getCheckpoint();
    const resumeActiveStep = resumeCheckpoint?.plan.find((s) => s.status === 'active');
    refreshAssemblyForRolePack(this.deps, resumeActiveStep?.rolePack);

    // 交互输入归属当前 turn 节点（SSOT：roundId 唯一锚点=prepare appendUser 的 head roundId，
    // 不重新 alloc——turn 分裂点已由 TS-9 收敛）。空 roundId 时 fallback alloc。
    // timeout（2026-09-08）：ask 超时未答无用户文本——仍落「未回答」交互记录（content =
    // ASK_TIMEOUT_NOTICE），宿主在 resume 前已 cancelAsk 转存提问快照，此处取走落盘 question。
    const isTimedOutAsk = kind === 'timeout';
    const content = isTimedOutAsk ? ASK_TIMEOUT_NOTICE : input?.trim();
    if (content) {
      const closureRoundId = parts.loop.getCurrentRoundId() || parts.loop.allocRoundId();
      parts.loop.setCurrentRoundId(closureRoundId);
      // G26：取走已作答提问快照（answerQuestion/cancelAsk 转存），随回答/超时记录一并落盘——
      // 回放还原「问了什么+选项」。多 ask_user 轮整组快照取首问（UI 单文本提交，与 questions[0]
      // 配对最稳；次态边界已标注）。supplement（无快照来源）不取。
      const answeredAsk =
        kind === 'question-answer' || isTimedOutAsk ? parts.loop.takeAnsweredAsk() : undefined;
      const answeredQ = answeredAsk?.[0];
      try {
        await parts.history.appendUser(content, closureRoundId, {
          interactive: true,
          kind,
          ...(answeredQ
            ? {
                question: answeredQ.question,
                ...(answeredQ.options && answeredQ.options.length > 0
                  ? { options: answeredQ.options }
                  : {}),
              }
            : {}),
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
   * chat/resume 路径共用（驱动不同 loop 入口），非正常收场/追加助手消息尾处理收在此。
   * @param produce 生成 loop 执行流的闭包
   * @param signal 中止信号（透传 consumeExecutionStream 区分真取消 vs 连接中断）
   */
  private async *act(
    produce: () => AsyncGenerator<AgentChunk, void, unknown>,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentChunk, StreamConsumeResult, unknown> {
    // 流消费统一收口于门面的 consumeExecutionStream（对话/事件/续跑共用同构实现）
    const streamResult = yield* this.deps.consumeExecutionStream(produce(), signal);

    // ── 非正常收场统一收口（SSOT，2026-09-15）────────────────────────────
    // 中断（用户取消/超时）与失败（LLM/网络错误）同属「本轮未正常完成」，共用同一收尾原语
    // appendInterrupted。既定裁决见 `memory/roundStore.ts` 的 RoundStatus 文档：运行时失败
    // **不翻 Round 状态机**，与中断并轨为「interrupted」收场（appendInterrupted →
    // status:'interrupted'，不再伪 complete），因为「中断」对用户可理解而「区分出错语义」
    // 当前无产品需求。中断轮保留 processEvents 原始现场、状态诚实区分（防「假性 complete 吞现场」）。
    //
    // 修复前：failed 分支直接 return、aborted 分支仅在「有产出文本」时才写史 → 两者都会在
    // 无产出时留下 refCount=0 的 pending 孤儿轮——运行期无人收尾，宿主须等下次重启才由
    // chatPanel.upgradeInterruptedRounds 打捞升级（真实故障：LLM 4xx 中断的长任务轮）。
    // appendInterrupted 同时覆盖两种形态：有产出 → 写 assistantMessage + 标记；无产出 →
    // 不写 assistantMessage，仍按 stop 语义收场（该原语的存在理由即此）。
    if (streamResult.aborted || streamResult.failed) {
      const parts = this.deps.getParts();
      // 中断标记默认文案与 loop 统一走 LOOP_CONSTANTS（SSOT），避免宿主未注入 messages 时两处降级不一致
      const interruptedMark =
        this.deps.messages?.interrupted ?? LOOP_CONSTANTS.DEFAULT_INTERRUPTED_MARK;
      try {
        await parts.history.appendInterrupted(parts.loop.getCurrentRoundId(), {
          content: streamResult.content,
          interruptedMark,
        });
      } catch (err) {
        logger.warn({ err }, '非正常收场轮历史写入失败');
      }
      return {
        content: streamResult.content,
        aborted: streamResult.aborted,
        paused: false,
        failed: streamResult.failed,
      } satisfies StreamConsumeResult;
    }

    const assistantContent = streamResult.content;
    const history = this.deps.getParts().history;
    const loop = this.deps.getParts().loop;

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

    // 形态② 兜底收尾（PLAN-SYNC-1 ①，2026-09-17）：「LLM 未显式 update 即收尾」——turn 正常
    // 完成（非暂停/中断/失败）且计划已「全部到达」（无 pending 步）时，闭合当前 active 步，
    // 使计划达到全 done（仍可能残留改为 blocked 的步，交由 turn 结束兜底清理）；真实多轮任务
    // （仍有 pending）不受影响。
    this.deps
      .getParts()
      .sessionManager?.concludeActiveStepIfPlanFullyReached(assistantContent.slice(0, 200));

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

  /**
   * 用户中断原因文案（SSOT：优先宿主注入，回退内置默认）
   * @returns 中断原因文案
   */
  private abortedReasonByUser(): string {
    return this.deps.messages?.abortedByUser ?? 'User cancelled the conversation';
  }
}
