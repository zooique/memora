/**
 * 回答前（Prepare）— 种子闭环第一阶段
 *
 * 收敛原 Agent.prepareChatContext 的编排骨架：策略装配 → 角色 → 记忆召回 → roundId
 * → appendUser → 会话命名。会议机制（S5）：任务项表层装配视角经本模块读取并驱动前缀刷新。
 *
 * 设计原则：
 *   - 叶子逻辑（recallAndInject）在 ContextPreparer 唯一实现，本模块只保留编排骨架
 *     （与 ContextPreparer 文档一致）。
 */

import type { AgentChunk } from '@/agent/types.js';
import { backgroundTask } from '@/utils/backgroundTask.js';
import {
  resolveContextAssembly,
  resolveL2Strategy,
  resolveMemoryRecallMode,
  resolveActiveStrategy,
  resolveTaskLoopLimit,
} from '@/role-pack/strategyResolver.js';
import {
  type SeedDeps,
  type SeedParts,
  type SeedPrepareResult,
} from './types.js';

/**
 * 回答前阶段执行器
 *
 * 一次输入 → 装配上下文（角色 + 召回 + 技能 + 用户消息入史），供回答中消费。
 * @remarks 异步生成器：运行期 yield AgentChunk（thinking 各阶段），返回 SeedPrepareResult。
 */
export class SeedPrepare {
  /** 依赖注入（门面稳定能力窄面） */
  private readonly deps: SeedDeps;

  constructor(deps: SeedDeps) {
    this.deps = deps;
  }

  /**
   * 执行回答前：策略装配 → 角色 → 记忆召回 → 技能注入 → roundId → 用户消息入史 → 会话命名。
   *
   * @param input 用户输入
   * @param signal 中止信号（回答前中断则在技能注入前返回 aborted）
   * @returns 回答前结果（recalledMemories 供回答中注入 loop）
   */
  async *run(
    input: string,
    signal: AbortSignal,
  ): AsyncGenerator<AgentChunk, SeedPrepareResult, unknown> {
    const { loop, history, sessionManager, rolePackManager, contextPreparer, sessionNamer } =
      this.deps.getParts() as SeedParts;

    // 每次回答前先清临时 system 消息（技能/最近对话 prompt 是当轮注入，不跨轮累积）
    loop.cleanTemporarySystemMessages();

    // 会议机制（S5）：读取当前 active 步骤声明的 rolePack，按本轮表层装配刷新前缀（范围校验 + 回落）
    const activeStep = sessionManager?.getCheckpoint()?.plan.find((s) => s.status === 'active');
    refreshAssemblyForRolePack(this.deps, activeStep?.rolePack);

    // 会议机制实施前提②：组/成员清单暴露给 LLM（防编造角色名）——仅当 activePack 是某组组长时注入
    const teamContext = rolePackManager?.buildTeamContextBlock() ?? '';
    if (teamContext) {
      loop.injectSystemMessage(teamContext);
    }

    // 会议机制（S5）确定性触发：用户消息含「小组会议」且 activePack 是组长 →
    // 经既有 writePlan 泛型能力预置任务表（组员各一步 + 汇总一步，复用 PlanStep.rolePack 表层覆盖），
    // 并标记 meetingPreset 强制 orchestrator 进入外部任务闭环直跑步序列（不引入会议引擎，见 ADR-028 收敛补记）。
    const meetingSteps = rolePackManager?.tryBuildMeetingPlan?.(input) ?? null;
    let meetingPreset = false;
    if (meetingSteps && sessionManager) {
      // 步数截断保护：会议步骤总数（组员 + 汇总）不能超过 taskLoopLimit，
      // 否则 runStepSequence 会被步数上限截断，末尾组员/汇总步骤永远不执行（会议不完整）。
      // 自然生长：预置即截断——保证「预置什么就执行什么」，不产生必然被截断的步骤。
      const strategy = resolveActiveStrategy(rolePackManager, this.deps.strategyOverride);
      const taskLoopLimit = resolveTaskLoopLimit(strategy);
      const capped =
        taskLoopLimit > 0 && meetingSteps.length > taskLoopLimit
          ? meetingSteps.slice(0, taskLoopLimit)
          : meetingSteps;
      sessionManager.writePlan('overwrite', capped);
      meetingPreset = true;
    }

    const strategy = resolveActiveStrategy(rolePackManager, this.deps.strategyOverride);
    // 枚举键经集中解析（SSOT 兜底）：非法值归位内核默认，不透传
    const memoryRecallMode = resolveMemoryRecallMode(strategy);
    // 上下文装配策略：fixed=仅固定轮次 / query=仅语义召回 / hybrid=混合
    const contextAssembly = resolveContextAssembly(strategy);
    // 单一 setStrategy 聚合 L2 策略（工具权限/步数/错误处理/路由/预算/推理/只读/审批/自审查）
    loop.setStrategy(resolveL2Strategy(strategy));

    // 换角色 → 按激活角色包的 capabilities 应用工具暴露面（toolMode=block 全禁与此正交）
    // 会议机制：工具面恒为 activePack（组员只"说"不执行，需完整能力应手动切换）——此处不走 roundAssemblyRole
    this.deps.applyRolePackToolExposure();

    yield { type: 'thinking', phase: 'recalling' };
    // 记忆召回 + 固定轮次注入（输入增强管线叶子逻辑，内容唯一实现在 ContextPreparer）
    const recalledMemories = await contextPreparer.recallAndInject(
      input,
      memoryRecallMode,
      contextAssembly,
    );

    if (signal.aborted) {
      return { input, recalledMemories, aborted: true, meetingPreset: false } satisfies SeedPrepareResult;
    }

    // 技能按渐进披露 L1 清单常驻 system prompt，正文由模型按需 read_skill，回答前不预注入
    yield { type: 'thinking', phase: 'processing' };

    const roundId = loop.allocRoundId();
    loop.setCurrentRoundId(roundId);
    await history.appendUser(input, roundId);

    // 会话标题自动命名（fire-and-forget）：仅新建会话首次问答触发（以"会话无标题"判定，不覆盖手动改名）
    if (sessionNamer) {
      backgroundTask('session-title', () =>
        sessionNamer.ensureSessionTitle(
          history.currentDateValue,
          history.currentSessionValue,
          input,
        ),
      );
    }

    return { input, recalledMemories, aborted: false, meetingPreset } satisfies SeedPrepareResult;
  }
}

/**
 * 会议机制（S5）：按给定任务项 rolePack 刷新本轮表层装配视角。
 *
 * 闭包入口（prepare.run）与步序列（runStepSequence 每步入口）共用，保证装配逻辑单一真理源：
 *   - resolveRoundAssemblyRole：范围校验（∈ 组长∪组员，越界/缺员→null+warning，防 LLM 幻觉角色名）
 *   - setRoundAssemblyRole：skills 加载跟随装配视角
 *   - refreshRolePackPrefixForRound：重建 loop 前缀（persona/rules/skills 换，键恒 activePack）
 * rolePack 未声明/越界/缺员 → null → 回落 activePack 前缀（组长视角，工具面不变）。
 *
 * 函数声明提升：prepare.run（类方法）可在其上方调用本函数，无需额外 import 顺序处理。
 *
 * @param deps 种子依赖（取 rolePackManager + 刷新前缀能力）
 * @param rolePack 任务项声明的角色包（无声明 = 非会议，回落 activePack）
 */
export function refreshAssemblyForRolePack(deps: SeedDeps, rolePack: string | undefined): void {
  const rolePackManager = deps.getParts().rolePackManager;
  const assembly = rolePackManager?.resolveRoundAssemblyRole(rolePack) ?? null;
  rolePackManager?.setRoundAssemblyRole(assembly);
  deps.refreshRolePackPrefixForRound?.(assembly);
}
