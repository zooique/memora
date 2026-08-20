/**
 * 回答中（Act）— 种子闭环第二阶段
 *
 * 收敛原 Agent.executeChatLoop / processEvent / resumeExecution 三处共用的「执行尾
 * 处理」：经统一流收口协议消费 loop 执行流 → 按结果追加助手消息（含中断标记）→
 * yield thinking/archiving → 返回流消费结果。
 *
 * 设计要点：
 *   - 三条路径（chat / processEvent / resume）的尾处理逻辑完全一致，唯一区别是
 *     「驱动哪个 loop 入口」，故本模块接收 produce 回调（生成 loop 执行流），
 *     尾处理收敛于此单一实现（杜绝此前三条路径各自的重复漂移）。
 *   - consumeExecutionStream 物理仍在门面，经 SeedDeps 注入（方案的"流收口协议归门面"）。
 *   - roundId 不做入参——统一读 loop.getCurrentRoundId()（appendAssistant 溯源用），
 *     与既有权责一致（round 归属以 loop 为单一真理源）。
 */

import type { AgentChunk } from '@/agent/types.js';
import { logger } from '@/logging/logger.js';
import type { StreamConsumeResult } from './types.js';
import type { SeedDeps } from './types.js';

/**
 * 回答中阶段执行器
 *
 * 消费一段 loop 执行流，统一处理中断/追加助手消息（tail），供三条路径复用。
 */
export class SeedAct {
  /** 依赖注入（门面稳定能力窄面） */
  private readonly deps: SeedDeps;

  constructor(deps: SeedDeps) {
    this.deps = deps;
  }

  /**
   * 执行回答中：消费 produce() 生成的 loop 执行流，统一尾处理。
   *
   * @param produce 生成待消费的 loop 执行流（chat 传 processUserInput / event 传
   *        processEvent / resume 传 continueAfterPause —— 由门面按路径注入）
   * @returns 流消费结果；aborted=true 表示已中断（含中断标记追加，调用方应跳过回答后），
   *          failed=true 表示执行出错（错误 chunk 已 yield，调用方应 return）
   */
  async *run(
    produce: () => AsyncGenerator<AgentChunk, void, unknown>,
  ): AsyncGenerator<AgentChunk, StreamConsumeResult, unknown> {
    // 流消费统一收口于门面的 consumeExecutionStream（对话/事件/续跑共用同构实现，
    // 避免此前各路径漏分支导致锁泄漏）
    const streamResult = yield* this.deps.consumeExecutionStream(produce());
    if (streamResult.failed) return streamResult;

    const assistantContent = streamResult.content;
    const history = this.deps.getParts().history;
    const loop = this.deps.getParts().loop;

    // 中断：保留已产出文本 + 中断标记，写入历史后返回（不再进回答后 / Handoff）
    if (streamResult.aborted) {
      if (assistantContent.trim()) {
        const interruptedMark = this.deps.messages?.interrupted ?? '\n\n[已中断]';
        try {
          await history.appendAssistant(assistantContent + interruptedMark, loop.getCurrentRoundId());
        } catch (err) {
          logger.warn({ err }, '中断消息历史写入失败');
        }
      }
      return { content: assistantContent, aborted: true, failed: false } satisfies StreamConsumeResult;
    }

    // 正常完成：助手消息写历史（失败仅记日志，不阻断后续回答后阶段）
    try {
      await history.appendAssistant(assistantContent, loop.getCurrentRoundId());
    } catch (err) {
      logger.warn({ err }, '助手消息历史写入失败');
    }

    // 进入回答后（archiving 阶段提示，供宿主 UI 结束生成态）
    yield { type: 'thinking', phase: 'archiving' };

    return streamResult satisfies StreamConsumeResult;
  }
}