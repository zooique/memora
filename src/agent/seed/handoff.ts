/**
 * Handoff（衔接决策）— 种子闭环出口
 *
 * 收敛原 executeChatLoop / processEvent 的 handoff chunk 产出：经 resolveHandoff
 * 归位非法值后，yield { type: 'handoff', decision, reason } 给宿主。
 *
 * Handoff 是闭环唯一的"系统如何演化"分岔口（哲学 §8.2）——对话态 wait 等待用户，
 * 自动化态自动衔接。resumeExecution 路径不产出 handoff（续跑态不在此分岔）。
 */

import type { AgentChunk } from '@/agent/types.js';
import { resolveHandoff } from '@/role-pack/types.js';
import { resolveActiveStrategy, type SeedDeps } from './types.js';

/**
 * Handoff 决策执行器
 *
 * 从当前激活策略推导衔接决策，产出 handoff chunk（对话等待 / 自动衔接）。
 */
export class SeedHandoff {
  /** 依赖注入（门面稳定能力窄面） */
  private readonly deps: SeedDeps;

  constructor(deps: SeedDeps) {
    this.deps = deps;
  }

  /**
   * 产出 Handoff 衔接决策 chunk：经 resolveHandoff 归位非法值，
   * 避免透传无法识别的衔接决策给宿主。
   */
  async *run(): AsyncGenerator<AgentChunk, void, unknown> {
    const strategy = resolveActiveStrategy(this.deps.getParts().rolePackManager);
    const handoffStrategy = resolveHandoff(strategy);
    yield {
      type: 'handoff',
      decision: handoffStrategy,
      reason: handoffStrategy === 'wait' ? undefined : 'L2 策略自动衔接',
    };
  }
}