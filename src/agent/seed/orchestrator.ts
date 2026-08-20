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
import { logger } from '@/logging/logger.js';
import type { SeedDeps } from './types.js';
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
    this.difficulty = new DifficultyJudge(
      () => deps.getBackgroundProvider(),
      deps.tracer,
    );
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

    // 难度分级（回答前）：简单/复杂，决定收敛后是否触发汇报（复杂才可能汇报）
    const difficulty = await this.difficulty.classify(input);

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

    // 回答后：复杂且收敛 → 汇报闭环 + 汇报单源摘要；否则普通回答摘要
    yield* this.settle(difficulty, input, acted.content, signal);

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
   * 回答后统一收尾：普通回答摘要；或（复杂且收敛）先跑汇报闭环再以汇报文本单源沉淀摘要。
   *
   * 汇报闭环 = 再编排一次 `loop.runReport()`（单次生成，自追加汇报为 assistant），
   * 产出文本作为 round-summary 单源（反射经 reflect.runReported 走既有摘要管线）。
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
    if (difficulty === 'complex' && this.isConverged()) {
      // 汇报闭环：消费 loop.runReport 流（汇报文本自追加为 assistant；此处兜底持久化到会话历史）
      const parts = this.deps.getParts();
      let report = '';
      for await (const chunk of parts.loop.runReport(signal)) {
        if (chunk.type === 'text') report += chunk.content;
        yield chunk;
      }
      const trimmed = report.trim();
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
      }
      return;
    }
    // 普通回答后摘要（既有语义不变）
    this.backgroundReflect(input, assistantContent);
  }

  /**
   * 收敛判定（阶段 2：复杂任务收敛）：session 检查点存在至少一个 plan/task-table 步骤已完成。
   *
   * stage-2 无外部任务驱动 loop，故以「已产生并完成至少一个计划步骤」作为收敛信号
   * （象征一次真实的多步执行）。无计划/无完成步骤 → 未收敛 → 不触发汇报。
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