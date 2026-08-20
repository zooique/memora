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
 * 无 prepare/无 handoff）若硬塞进一个开关，会落入哲学 §3.2 的场景特化补丁反模式。
 *
 * 依赖方向：agent/seed/* → agent/loop（种子消费引擎），agent.ts → agent/seed（门面委托种子）。
 */

import type { AgentChunk, SessionEvent } from '@/agent/types.js';
import { LOOP_CONSTANTS } from '@/agent/constants.js';
import { logger } from '@/logging/logger.js';
import { resolveTaskLoopLimit } from '@/role-pack/strategyResolver.js';
import { resolveActiveStrategy, type SeedDeps, type SeedPrepareResult } from './types.js';
import { SeedPrepare } from './prepare.js';
import { SeedAct } from './act.js';
import { SeedReflect } from './reflect.js';
import { SeedHandoff } from './handoff.js';
import { DifficultyJudge, type Difficulty } from './difficulty.js';

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
  /** 回答中（统一流消费 + 中断/追加助手消息尾处理） */
  private readonly act: SeedAct;
  /** 回答后（round-summary 摘要生成，记忆即摘要单轨） */
  private readonly reflect: SeedReflect;
  /** Handoff 衔接决策（闭环出口） */
  private readonly handoff: SeedHandoff;
  /** 难度分级（回答前判简单/复杂，决定是否触发汇报） */
  private readonly difficulty: DifficultyJudge;

  constructor(deps: SeedDeps) {
    this.deps = deps;
    this.prepare = new SeedPrepare(deps);
    this.act = new SeedAct(deps);
    this.reflect = new SeedReflect(deps);
    this.handoff = new SeedHandoff(deps);
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
      yield* this.handoff.run();
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
    const acted = yield* this.act.run(produce);
    if (acted.failed || acted.aborted) return;

    // 回答后：普通回答摘要
    this.backgroundReflect(input, acted.content);

    // Handoff：对外产出衔接决策
    yield* this.handoff.run();
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
    const acted = yield* this.act.run(produce);
    if (acted.failed || acted.aborted) return;

    // 回答后：复杂且收敛 → 汇报闭环 + 汇报单源摘要；否则普通回答摘要
    yield* this.settle(difficulty, input, acted.content, signal);

    // Handoff：对外产出衔接决策
    yield* this.handoff.run();
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
    // 回答中：消费 loop.continueAfterPause 执行流 + 统一尾处理
    const produce = () => this.deps.getParts().loop.continueAfterPause(input, signal);
    const acted = yield* this.act.run(produce);
    if (acted.failed || acted.aborted) return;

    // 回答后（无 Handoff：续跑态不在闭环出口分岔）
    void this.backgroundReflect(input ?? '', acted.content);
  }

  /**
   * 回答后统一 fire-and-forget 封装：非阻塞生成轮次摘要，失败仅记日志。
   * @param input 用户输入（摘要输入侧）
   * @param assistantContent 助手回答（摘要输出侧）
   */
  private backgroundReflect(input: string, assistantContent: string): void {
    void this.reflect
      .run(input, assistantContent)
      .catch((err: unknown) => logger.warn({ err }, '非阻塞后处理失败'));
  }

  /**
   * 外部任务驱动外循环（阶段 3·完整外循环）：单个复杂输入 → 多闭环组合。
   *
   * 序列：规划闭环（只建任务表）→ 每步一个独立闭环 → 收敛后汇报闭环。
   *   - 规划闭环：注入 PLAN_ONLY，只调查 + 建任务表，不执行（避免与步闭环重复执行）。
   *   - 步闭环：任务表 pending 步骤逐个拉起独立闭环（各自独立 roundId，供消息溯源/互斥排除），
   *     步内仍可工具多步（内循环保留）。
   *   - 摘要 1:1：一个外部输入只由收尾汇报产出唯一 round-summary（单源，见 memory-as-summary §2.5）；
   *     规划/中间步不单独摘要，避免一次复杂输入堆出多条 round-summary。
   *   - 闭环数受角色包 `global.taskLoopLimit` 约束（外部任务循环步数上限，防无限多步烧 token）。
   *   - 收敛（任务表存在已完成步骤）→ 汇报闭环 + 汇报单源摘要。
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
    const limit = resolveTaskLoopLimit(resolveActiveStrategy(parts.rolePackManager));

    // 组合 head id：捕获"这次外部输入"的 roundId（prepare 已分配并 appendUser）。
    // 步闭环会给 loop 分配独立 currentRoundId，故先存 head，收尾摘要时回指——确保
    // round-summary 锚定"这次外部输入"而非"最后一步"（组合溯源，见 memory-as-summary §2.5）。
    const headRoundId = parts.loop.getCurrentRoundId();

    // 1) 规划闭环：只调查 + 建任务表，不执行
    parts.loop.injectSystemMessage(PLAN_ONLY_HINT);
    const planAct = yield* this.act.run(() =>
      parts.loop.processUserInput(
        input,
        prepared.recalledMemories,
        signal,
        parts.loop.getCurrentRoundId(),
      ),
    );
    if (planAct.failed || planAct.aborted) return;
    // 清理规划期注入的临时 system 消息（PLAN_ONLY 等）——必须先于 abort return，避免残留跨到下一次输入
    parts.loop.cleanTemporarySystemMessages();

    // 2) 步闭环序列：每步独立 roundId（消息溯源用，不产摘要）
    let stepsRun = 0;
    while (stepsRun < limit) {
      const next = this.getNextPendingStep();
      if (!next) break;
      stepsRun++;
      // 步入 processUserInput 未传 roundId，由 loop 自生成独立 id（round 归属以 loop 为单一真理源）——
      // 消息溯源/互斥排除在不同步骤间天然隔离，无需此处显式 allocRoundId（见 Q4 评审）
      // 步闭环入口先清理上一步累积的临时 system 消息（self-review/reflection/duplicate-warning 等），
      // 履行"每轮 chat() 前清理"纪律——否则跨步堆积会膨胀 token、污染"模型看到了什么"指纹、混入收尾上下文（见 §2.5）
      parts.loop.cleanTemporarySystemMessages();
      const stepAct = yield* this.act.run(() =>
        parts.loop.processUserInput(stepPrompt(next.description), [], signal),
      );
      if (stepAct.failed || stepAct.aborted) return;
      // 步闭环不产摘要（摘要 1:1 只由收尾汇报产出，见 §2.5）
    }

    // 3) 收敛 → 汇报闭环 + 汇报单源摘要；未收敛 → 以规划闭环产出走普通单条摘要（保证摘要恒 1:1，不丢记忆）
    // 收尾前把 roundId 回指 head：汇报文本与 round-summary 挂"这次外部输入"，而非最后一步（组合溯源）
    parts.loop.setCurrentRoundId(headRoundId);
    // 收尾前再清一次：清掉最后一步闭环累积的临时 system 消息，确保汇报只看到规划产物 + 汇报指令，
    // 不把步内 self-review/reflection 等残留混入收尾上下文与摘要来源
    parts.loop.cleanTemporarySystemMessages();
    if (this.isConverged()) {
      // 收敛路径：汇报有实质内容产汇报单源摘要；汇报为空/token 预算占位 → 回退规划产出普通摘要（恒 1:1）
      yield* this.runReportAndReflect(signal, input, planAct.content);
    } else {
      this.backgroundReflect(input, planAct.content);
    }
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
      void this.reflect
        .runReported(trimmed)
        .catch((err: unknown) => logger.warn({ err }, '汇报摘要生成失败'));
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
