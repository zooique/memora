/**
 * 种子闭环编排器 — 最小问答闭环的唯一编排真理源（prepare → act → reflect → handoff）
 *
 * 对应方案"[orchestrator.ts = 唯一编排真理源]"。orchestrator.run() 显式表达
 * "一次触发 → 一次性完整闭环"，是种子"自足可重复可观察"三个性质的代码落地。
 *
 * 语义对应：
 *   - chat 路径（门面对话）经 run() 走完整种子闭环（prepare → act → reflect → handoff）。
 *   - processEvent / resumeExecution 因 flow 差异（前者有任务表预判注入、后者无 prepare
 *     与 handoff），由门面复用本编排器的 prepare / act / reflect / handoff 单阶段能力
 *     自编排——种子模块是"细胞"，或言编排器提供默认组装，门面保留路径级 flow。
 *
 * 依赖方向：agent/seed/* → agent/loop（种子消费引擎），agent.ts → agent/seed（门面委托种子）。
 */

import type { AgentChunk } from '@/agent/types.js';
import { logger } from '@/logging/logger.js';
import type { SeedDeps } from './types.js';
import { SeedPrepare } from './prepare.js';
import { SeedAct } from './act.js';
import { SeedReflect } from './reflect.js';
import { SeedHandoff } from './handoff.js';

/**
 * 种子闭环编排器
 *
 * 聚合回答前/中/后与 Handoff 四阶段，提供最小问答闭环的默认组装（run()）。
 * prepare / act / reflect / handoff 各自可被门面按路径单独复用。
 */
export class SeedOrchestrator {
  /** 依赖注入（门面稳定能力窄面） */
  private readonly deps: SeedDeps;
  /** 回答前（装配上下文 + 召回 + 技能 + 用户消息入史） */
  readonly prepare: SeedPrepare;
  /** 回答中（统一流消费 + 中断/追加助手消息尾处理） */
  readonly act: SeedAct;
  /** 回答后（round-summary 摘要生成，记忆即摘要单轨） */
  readonly reflect: SeedReflect;
  /** Handoff 衔接决策（闭环出口） */
  readonly handoff: SeedHandoff;

  constructor(deps: SeedDeps) {
    this.deps = deps;
    this.prepare = new SeedPrepare(deps);
    this.act = new SeedAct(deps);
    this.reflect = new SeedReflect(deps);
    this.handoff = new SeedHandoff(deps);
  }

  /**
   * 运行一次完整的最小问答闭环（chat 路径默认组装）：
   * 回答前 → 回答中 → 回答后 → Handoff。
   *
   * @param input 用户输入
   * @param signal 中止信号
   * @yields AgentChunk 事件流（thinking / handoff / 透传 loop 执行流 chunk）
   */
  async *run(input: string, signal: AbortSignal): AsyncGenerator<AgentChunk, void, unknown> {
    // 回答前：装配上下文 + 召回记忆
    const prepared = yield* this.prepare.run(input, signal);
    if (prepared.aborted) {
      yield {
        type: 'aborted',
        reason: this.deps.messages?.abortedByUser ?? 'User cancelled the conversation',
      };
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

    // 回答后：非阻塞生成轮次摘要（fire-and-forget，失败仅记日志）
    void this.reflect
      .run(input, acted.content)
      .catch((err: unknown) => logger.warn({ err }, '非阻塞后处理失败'));

    // Handoff：对外产出衔接决策
    yield* this.handoff.run();
  }
}