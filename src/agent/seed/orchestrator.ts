/**
 * 种子闭环编排器 — 最小问答闭环的唯一编排真理源（prepare → act → reflect → handoff）
 *
 * 对应方案"[orchestrator.ts = 唯一编排真理源]"。「如何串联一个问答闭环」全部收在此处，
 * 门面只做一行委托 + 生命周期守卫，不再持有闭环编排逻辑。
 *
 * 三个显式命名入口（对应哲学：闭环只认 Trigger，不认 Trigger 来源）：
 *   - runChat   （对话 Trigger）   完整闭环：prepare → act(processUserInput) → reflect → handoff
 *   - runEvent  （SessionEvent）   prepare → 任务表预判注入 → act(processEvent) → reflect → handoff
 *   - runResume （续跑 Trigger）   act(continueAfterPause) → reflect（无回答前、无 Handoff）
 *
 * 刻意不做「单 run() + mode 标志」——三条路径的真实差异（runEvent 有任务表注入、runResume
 * 无 prepare/无 handoff）若硬塞进一个开关，会落入场景特化补丁反模式。
 *
 * 依赖方向：agent/seed/* → agent/loop（种子消费引擎），agent.ts → agent/seed（门面委托种子）。
 */

import type { AgentChunk, SessionEvent } from '@/agent/types.js';
import { LOOP_CONSTANTS } from '@/agent/constants.js';
import { logger } from '@/logging/logger.js';
import { resolveTaskLoopLimit } from '@/role-pack/strategyResolver.js';
import {
  resolveActiveStrategy,
  type StreamConsumeResult,
  type SeedDeps,
  type SeedParts,
  type SeedPrepareResult,
} from './types.js';
import { SeedPrepare } from './prepare.js';
import { DifficultyJudge, type Difficulty } from './difficulty.js';
import { resolveHandoff, resolveSummary, resolveSummaryFocus } from '@/role-pack/strategyResolver.js';
import { TRACE_SPANS, NOOP_TRACER } from '@/agent/tracer.js';
import { backgroundTask } from '@/utils/backgroundTask.js';

/**
 * event 路径任务表预判注入提示（仅 plan 为空且应生成任务表时注入，提示 LLM 分步）
 */
const TASK_TABLE_HINT =
  '如果需要分步完成任务，请使用 task_table_write 工具创建任务表，' +
  '包含各步骤的描述（description）。每完成一步使用 task_table_update 工具更新对应步骤状态。' +
  '任务表仅作参考，LLM 可自行决定执行顺序。';

/**
 * 外部任务规划闭环提示（阶段 3·完整外循环）：复杂任务第一步只调查 + 建任务表，不执行步骤。
 * 规划后由 orchestrator 外循环按 pending 步骤逐个拉起独立闭环，避免规划与执行在一次闭环内挤在一起。
 */
const PLAN_ONLY_HINT =
  '这是一个需要多步完成的复杂任务。请先充分调查并建立任务表（task_table_write），' +
  '明确列出待完成的步骤，但【暂时不要执行任何步骤】。本回合只做规划与建表。';

/**
 * 单任务步骤闭环的提示（阶段 3·完整外循环）：给定当前待执行步骤，让该闭环专注解这一步骤。
 * @param description 步骤描述（从任务表 pending 步骤读取）
 */
function stepPrompt(description: string): string {
  return `【执行任务步骤】${description}\n请完成此步骤；完成后用 task_table_update 将该步骤标记为 done 或 blocked。`;
}

/**
 * 种子闭环编排器
 *
 * 聚合回答前/中/后与 Handoff 四阶段，提供闭环编排的全部入口（runChat/runEvent/runResume）。
 * prepare / act / reflect / handoff 各自可测；编排语义只在 orchestrator 唯一实现。
 */
export class SeedOrchestrator {
  /** 依赖注入（门面稳定能力窄面） */
  private readonly deps: SeedDeps;
  /** 回答前（装配上下文 + 召回 + 技能 + 用户消息入史） */
  private readonly prepare: SeedPrepare;
  /** 难度分级（回答前判简单/复杂，决定是否触发汇报） */
  private readonly difficulty: DifficultyJudge;

  constructor(deps: SeedDeps) {
    this.deps = deps;
    this.prepare = new SeedPrepare(deps);
    this.difficulty = new DifficultyJudge(() => deps.getBackgroundProvider(), deps.tracer);
  }

  /**
   * 对话路径完整闭环：回答前 → 回答中(processUserInput) → 回答后 → Handoff。
   *
   * @param input 用户输入
   * @param signal 中止信号
   * @yields AgentChunk 事件流（thinking / handoff / 透传 loop 执行流 chunk）
   */
  async *runChat(input: string, signal: AbortSignal): AsyncGenerator<AgentChunk, void, unknown> {
    // 回答前：装配上下文 + 召回记忆
    const prepared = yield* this.prepare.run(input, signal);
    if (prepared.aborted) {
      yield { type: 'aborted', reason: this.abortedReasonByUser() };
      return;
    }

    // 难度分级（回答前）：复杂且启用外部任务循环 → 外循环（规划 + 每步一闭环 + 汇报）；否则单闭环直接答
    const difficulty = await this.difficulty.classify(input);
    const taskLoopLimit = resolveTaskLoopLimit(
      resolveActiveStrategy(this.deps.getParts().rolePackManager),
    );
    if (difficulty === 'complex' && taskLoopLimit > 0) {
      yield* this.externalTaskLoop(input, prepared, signal);
      yield* this.handoff(true);
      return;
    }

    // 回答中：消费 loop.processUserInput 执行流（roundId 以 loop 当前轮为真理源）
    const produce = () =>
      this.deps
        .getParts()
        .loop.processUserInput(
          input,
          prepared.recalledMemories,
          signal,
          this.deps.getParts().loop.getCurrentRoundId(),
        );
    const acted = yield* this.act(produce);
    if (acted.failed || acted.aborted || acted.paused) return;

    // 回答后：普通回答摘要
    this.backgroundReflect(input, acted.content);

    // Handoff：对外产出衔接决策
    yield* this.handoff();
  }

  /**
   * SessionEvent 路径闭环：回答前 → 任务表预判注入 → 回答中(processEvent) → 回答后 → Handoff。
   *
   * 与 runChat 的唯一差异是回答中驱动 loop.processEvent + 回答前多一步任务表预判提示——
   * 该差异是 event Trigger 的闭环内属性，故在编排器内处理而非泄漏到门面。
   *
   * @param event 增量事件（chat 语义；驱动 loop.processEvent）
   * @param input 用户输入内容（= event.content，回答前与回答后共用）
   * @param signal 中止信号
   * @yields AgentChunk 事件流
   */
  async *runEvent(
    event: SessionEvent,
    input: string,
    signal: AbortSignal,
  ): AsyncGenerator<AgentChunk, void, unknown> {
    // 回答前：装配上下文 + 召回记忆
    const prepared = yield* this.prepare.run(input, signal);
    if (prepared.aborted) {
      yield { type: 'aborted', reason: this.abortedReasonByUser() };
      return;
    }

    // 难度分级（回答前）：简单/复杂，决定收敛后是否触发汇报
    const difficulty = await this.difficulty.classify(input);

    // 任务表预判（仅 event 路径）：plan 为空且应生成时，提示 LLM 用任务表分步
    const parts = this.deps.getParts();
    const crc = parts.checkpointRestoreCoordinator;
    if (crc?.shouldGenerateTaskTable(event, parts.sessionManager?.getCheckpoint() ?? undefined)) {
      parts.loop.injectSystemMessage(TASK_TABLE_HINT);
    }

    // 回答中：消费 loop.processEvent 执行流 + 统一尾处理
    const produce = () => parts.loop.processEvent(event, prepared.recalledMemories, signal);
    const acted = yield* this.act(produce);
    if (acted.failed || acted.aborted || acted.paused) return;

    // 回答后：复杂且收敛 → 汇报闭环 + 汇报单源摘要；否则普通回答摘要
    yield* this.settle(difficulty, input, acted.content, signal);

    // Handoff：对外产出衔接决策
    yield* this.handoff();
  }

  /**
   * 续跑路径闭环：回答中(continueAfterPause) → 回答后。无回答前、无 Handoff。
   *
   * 续跑是已在暂停点保留上下文的继续执行，故不重新装配上下文（prepare）、不在闭环出口分岔
   * （handoff）——差异源于 Trigger 的续跑语义，收在编排器内。
   *
   * @param input 可选补充输入（空=续跑原路径；有=注入修正后续轮）
   * @param signal 中止信号
   * @yields AgentChunk 事件流
   */
  async *runResume(
    input: string | undefined,
    signal: AbortSignal,
  ): AsyncGenerator<AgentChunk, void, unknown> {
    const parts = this.deps.getParts();
    // 回答中：消费 loop.continueAfterPause 执行流 + 统一尾处理
    const produce = () => parts.loop.continueAfterPause(input, signal);
    const acted = yield* this.act(produce);
    if (acted.failed || acted.aborted || acted.paused) return;

    // 外部任务循环续跑整链：续完当前循环后，若仍处于外循环上下文 → 推进剩余步 + 收尾汇报
    // （摘要统一由 completeExternalTask 收尾产出，保持摘要↔外部输入恒 1:1，不在此重复产摘要）
    if (parts.loop.isWithinExternalTask) {
      yield* this.completeExternalTask(signal, input ?? '', acted.content);
      return;
    }
    // 普通续跑（非外循环）：答后摘要
    void this.backgroundReflect(input ?? '', acted.content);
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
   * chat/event/resume 三路径共用（驱动不同 loop 入口），中断/追加助手消息尾处理收在此。
   */
  private async *act(
    produce: () => AsyncGenerator<AgentChunk, void, unknown>,
  ): AsyncGenerator<AgentChunk, StreamConsumeResult, unknown> {
    // 流消费统一收口于门面的 consumeExecutionStream（对话/事件/续跑共用同构实现）
    const streamResult = yield* this.deps.consumeExecutionStream(produce());
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

  /** 回答后汇报摘要：以汇报文本为单源（输入侧空，仅由汇报驱动） */
  private async reflectReported(reportText: string): Promise<void> {
    await this.runSummary('', reportText, TRACE_SPANS.REPORT);
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

      // reflect.summary='off' 时跳过（一次性对话不沉淀）
      if (
        roundSummaryGenerator &&
        resolveSummary(resolveActiveStrategy(rolePackManager)) === 'on'
      ) {
        try {
          const roundId = loop.getCurrentRoundId();
          const sessionName = history.currentSessionName;
          // 提炼视角：激活角色包 prepare.summaryFocus → 注入摘要生成（无则通用归纳框架）
          const summaryFocus = resolveSummaryFocus(resolveActiveStrategy(rolePackManager));
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

  /** Handoff 衔接决策：产出闭环出口 chunk（对话等待 / 自动衔接）。
   *  @param externalTaskReported 本闭环是否为外部任务收尾（runChat 外循环路径传 true，
   *    供宿主区分"普通答完"与"外部任务收敛汇报完"，以对齐 poll-round-summary 时机） */
  private async *handoff(
    externalTaskReported = false,
  ): AsyncGenerator<AgentChunk, void, unknown> {
    const strategy = resolveActiveStrategy(this.deps.getParts().rolePackManager);
    const handoffStrategy = resolveHandoff(strategy);
    yield {
      type: 'handoff',
      decision: handoffStrategy,
      reason: externalTaskReported
        ? '外部任务收尾汇报'
        : handoffStrategy === 'wait'
          ? undefined
          : 'L2 策略自动衔接',
    };
  }

  /**
   * 外部任务驱动外循环（阶段 3·完整外循环）：单个复杂输入 → 多闭环组合。
   *
   * 序列：规划闭环（只建任务表）→ [completeExternalTask] 步序列 + 收尾汇报。
   *   - 规划闭环：注入 PLAN_ONLY，只调查 + 建任务表，不执行（避免与步闭环重复执行）；
   *     规划在迭代边界软暂停 → 现场保留，续跑完规划后继续整链。
   *   - 步序列 + 收尾由 [completeExternalTask] 承担（可重入，runChat 规划后与 runResume 续跑共用）。
   *   - 进入外循环上下文时持久 head roundId（loop），续跑收尾摘要回指——组合溯源跨暂停保留。
   *
   * @param input 用户输入
   * @param prepared 回答前结果（recalledMemories 供规划闭环注入）
   * @param signal 中止信号
   */
  private async *externalTaskLoop(
    input: string,
    prepared: SeedPrepareResult,
    signal: AbortSignal,
  ): AsyncGenerator<AgentChunk, void, unknown> {
    const parts = this.deps.getParts();

    // 组合 head id：捕获"这次外部输入"的 roundId（prepare 已分配并 appendUser）。
    // 步闭环会给 loop 分配独立 currentRoundId，故先把 head 持久到 loop，收尾摘要时回指——
    // 确保 round-summary 锚定"这次外部输入"而非"最后一步"（组合溯源，跨暂停-续跑保留）。
    const headRoundId = parts.loop.getCurrentRoundId();
    parts.loop.setExternalTaskHeadRoundId(headRoundId);
    // 进入外循环上下文（规划 + 步序列 + 收尾）——续跑入口据此决定是否继续推进任务链
    parts.loop.setWithinExternalTask(true);

    // 1) 规划闭环：只调查 + 建任务表，不执行
    yield { type: 'thinking', phase: 'planning' };
    parts.loop.injectSystemMessage(PLAN_ONLY_HINT);
    const planAct = yield* this.act(() =>
      parts.loop.processUserInput(
        input,
        prepared.recalledMemories,
        signal,
        headRoundId,
      ),
    );
    if (planAct.paused) {
      // 规划闭环在迭代边界软暂停：现场保留（含 PLAN_ONLY 约束），续跑完规划后继续整链，不产摘要
      return;
    }
    if (planAct.failed || planAct.aborted) {
      // 规划中断/失败：清 PLAN_ONLY 防残留跨下一次输入；残缺半成品不入记忆（同主路径 act 语义）
      parts.loop.cleanTemporarySystemMessages();
      parts.loop.setWithinExternalTask(false);
      return;
    }
    // 规划成功：清 PLAN_ONLY（装配控制提示，非执行期临时，需显式清理），进入步序列 + 收尾
    parts.loop.cleanTemporarySystemMessages();
    yield* this.completeExternalTask(signal, input, planAct.content);
  }

  /**
   * 可重入推进外部任务链（runChat 复杂路径规划后 / runResume 续跑共用）。
   *
   * 从下一个 pending 步执行步闭环序列直至收敛收尾汇报：
   *   - 每个步闭环独立 roundId（消息溯源/互斥排除隔离），不产摘要（摘要恒 1:1 只由收尾汇报产出）；
   *   - 步闭环 paused → return 保留现场（软暂停），续跑从下一 pending 步继续整链；
   *   - 收尾前把 roundId 回指 loop.externalTaskHeadId（组合溯源：摘要锚定"这次外部输入"）；
   *   - 收敛 → 汇报闭环 + 汇报单源摘要；未收敛 → 普通单条摘要（恒 1:1）。
   *
   * @param signal 中止信号
   * @param input 用户输入（未收敛兜底摘要的输入侧）
   * @param planFallback 未收敛兜底摘要的内容侧（首次=规划产出；续跑=最后闭环产出）
   */
  private async *completeExternalTask(
    signal: AbortSignal,
    input: string,
    planFallback: string,
  ): AsyncGenerator<AgentChunk, void, unknown> {
    const parts = this.deps.getParts();
    const limit = resolveTaskLoopLimit(resolveActiveStrategy(parts.rolePackManager));

    // 步闭环序列：每步独立 roundId（消息溯源用，不产摘要）
    let stepsRun = 0;
    while (stepsRun < limit) {
      const next = this.getNextPendingStep();
      if (!next) break;
      stepsRun++;
      // 步级进度标记（供宿主区分「正在执行第几步」）：index=当前步序号，limit=步数上限
      yield { type: 'thinking', phase: 'step', index: stepsRun, limit };
      // 步入 processUserInput 未传 roundId，由 loop 自生成独立 id（round 归属以 loop 为单一真理源）——
      // 消息溯源/互斥排除在不同步骤间天然隔离，无需此处显式 allocRoundId
      const stepAct = yield* this.act(() =>
        parts.loop.processUserInput(stepPrompt(next.description), [], signal),
      );
      if (stepAct.failed || stepAct.aborted) {
        // 中断/失败：残缺半成品不入记忆（哲学「硬中止不产摘要」），任务链终止
        parts.loop.setWithinExternalTask(false);
        return;
      }
      if (stepAct.paused) {
        // 本闭环自然结束后软暂停：保留现场，续跑从下一 pending 步继续整链
        return;
      }
      // 步闭环不产摘要（摘要 1:1 只由收尾汇报产出）
    }

    // 收尾：收敛 → 汇报闭环 + 汇报单源摘要；未收敛 → 以 planFallback 走普通单条摘要（保证恒 1:1）
    parts.loop.setCurrentRoundId(parts.loop.externalTaskHeadId);
    // 汇报入口（loop.runReport）已自动清理上一步执行期临时残留，无需此处手动再清
    if (this.isConverged()) {
      yield { type: 'thinking', phase: 'reporting' };
      yield* this.runReportAndReflect(signal, input, planFallback);
    } else {
      this.backgroundReflect(input, planFallback);
    }
    // 任务链已收尾：清除外循环上下文（供后续续跑不误入已结束链）
    parts.loop.setWithinExternalTask(false);
  }

  /**
   * 汇报闭环（可复用）：消费 loop.runReport 流 → 汇报文本入会话历史 → 汇报单源摘要。
   *
   * 无实质收尾兜底：若汇报为空、或仅为 token 预算占位（无真实收尾内容），
   * 则以 fallbackContent 走普通单条摘要——保证"收敛"路径恒产 1 条（摘要↔外部输入恒 1:1）。
   * @param signal 中止信号（汇报生成用）
   * @param fallbackInput 已落库的输入文本（无实质收尾回退时作摘要的输入源）
   * @param fallbackContent 回退摘要来源（externalTaskLoop 传规划产出；settle 传主回答）
   */
  private async *runReportAndReflect(
    signal: AbortSignal,
    fallbackInput: string,
    fallbackContent: string,
  ): AsyncGenerator<AgentChunk, void, unknown> {
    const parts = this.deps.getParts();
    let report = '';
    for await (const chunk of parts.loop.runReport(signal)) {
      if (chunk.type === 'text') report += chunk.content;
      yield chunk;
    }
    // 剥离 token 预算占位再判空：占位视作"未产出真实收尾"，一并走回退（token 预算耗尽不是收尾）
    const trimmed = report
      .trim()
      .replace(LOOP_CONSTANTS.TOKEN_BUDGET_REACHED_PLACEHOLDER, '')
      .trim();
    if (trimmed) {
      try {
        await parts.history.appendAssistant(trimmed, parts.loop.getCurrentRoundId());
      } catch (err) {
        logger.warn({ err }, '汇报消息历史写入失败');
      }
      // 汇报→摘要单源：以汇报文本为摘要来源（走既有 reflect 管线，记忆即摘要单轨）
      backgroundTask('report-summary', () => this.reflectReported(trimmed));
      return;
    }
    // 无实质收尾 → 回退普通单条摘要（与"未收敛"分支同一真理源，保证收敛恒 1:1）
    this.backgroundReflect(fallbackInput, fallbackContent);
  }

  /**
   * 读取任务表下一个 pending 步骤（外循环步闭环的驱动信号）。
   * @returns 下一个待执行步骤（description 供步闭环提示）；无则返回 null（收敛）
   */
  private getNextPendingStep(): { id: string; description: string } | null {
    const steps = this.deps.getParts().sessionManager?.getCheckpoint()?.plan ?? [];
    const next = steps.find((s) => s.status === 'pending');
    return next ? { id: next.id, description: next.description } : null;
  }

  /**
   * 回答后统一收尾（阶段 2 路径，event 入口用）：普通回答摘要；或（复杂且收敛）汇报闭环 + 汇报单源摘要。
   *
   * @param difficulty 回答前判定的难度
   * @param input 用户输入（普通摘要输入侧）
   * @param assistantContent 主回答文本（普通摘要输出侧）
   * @param signal 中止信号（汇报生成用）
   */
  private async *settle(
    difficulty: Difficulty,
    input: string,
    assistantContent: string,
    signal: AbortSignal,
  ): AsyncGenerator<AgentChunk, void, unknown> {
    // 复杂且收敛：汇报闭环 + 汇报单源摘要；汇报为空/占位 → 回退主回答普通摘要（阶段 2 同样恒 1:1）
    if (difficulty === 'complex' && this.isConverged()) {
      yield* this.runReportAndReflect(signal, input, assistantContent);
      return;
    }
    // 普通回答后摘要（既有语义不变）
    this.backgroundReflect(input, assistantContent);
  }

  /**
   * 收敛判定：session 检查点存在至少一个 plan/task-table 步骤已完成。
   * 无计划/无完成步骤 → 未收敛 → 不触发汇报。
   */
  private isConverged(): boolean {
    const plan = this.deps.getParts().sessionManager?.getCheckpoint()?.plan ?? [];
    return plan.some((s) => s.status === 'done');
  }

  /**
   * 用户中断原因文案（SSOT：优先宿主注入，回退内置默认）
   * @returns 中断原因文案
   */
  private abortedReasonByUser(): string {
    return this.deps.messages?.abortedByUser ?? 'User cancelled the conversation';
  }
}
