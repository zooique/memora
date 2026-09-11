/**
 * 回答前（Prepare）— 种子闭环第一阶段
 *
 * 收敛原 Agent.prepareChatContext 的编排骨架：策略装配 → 角色 → 上下文装配 → roundId
 * → appendUser → 会话命名。会议机制（S5）：任务项表层装配视角经本模块读取并驱动前缀刷新。
 *
 * 设计原则：
 *   - 叶子逻辑（assembleContext → 上下文装配：预算派生 + 对话层注入 + 占用快照）在
 *     ContextPreparer 唯一实现，本模块只保留编排骨架（与 ContextPreparer 文档一致）。
 */

import type { AgentChunk } from '@/agent/types.js';
import { backgroundTask } from '@/utils/backgroundTask.js';
import {
  resolveL2Strategy,
  resolveActiveStrategy,
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
   * 执行回答前：策略装配 → 角色 → 上下文装配 → 技能注入 → roundId → 用户消息入史 → 会话命名。
   *
   * @param input 用户输入
   * @param signal 中止信号（回答前中断则在技能注入前返回 aborted）
   * @returns 回答前结果（input + aborted；round 归属见 SeedPrepareResult）
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
    const checkpoint = sessionManager?.getCheckpoint();
    const activeStep = checkpoint?.plan.find((s) => s.status === 'active');
    refreshAssemblyForRolePack(this.deps, activeStep?.rolePack);

    // 会议机制实施前提②：组/成员清单暴露给 LLM（防编造角色名）——仅当 activePack 是某组组长时注入
    const teamContext = rolePackManager?.buildTeamContextBlock() ?? '';
    if (teamContext) {
      loop.injectSystemMessage(teamContext);
    }

    // 会议机制骨架预置（2026-09-07 「最小受控起点」半反转回归，ADR-028 收敛补记 + ME-6 触发样本）。
    // 与 buildTeamContextBlock 文案互补：骨架补首轮确定性（顶部任务板可见 + PlanStep.rolePack 装配钩子），
    // 文案约束 LLM 后续推进走 task_table 单通道。守卫语义与 T2（2026-09-06）一致：
    //   已有未完成计划（pending/active 存在）→ 跳过骨架预置 = 续会语义：第二轮「继续小组会议」等输入
    //   交给 LLM 按既有任务表推进，不再重开/叠加会议步骤；无在途计划时的「小组会议」输入 = 新会议 → overwrite 预置。
    //   重开已推进会议需显式手段（宿主清空任务表 / LLM task_table_write），非自然语言自动触发。
    const hasInflightPlan = (checkpoint?.plan ?? []).some(
      (s) => s.status === 'pending' || s.status === 'active',
    );
    const meetingSteps = hasInflightPlan
      ? null
      : (rolePackManager?.tryBuildMeetingPlan?.(input) ?? null);
    if (meetingSteps && sessionManager) {
      // 骨架预置：overwrite 真清空（writePlan 语义修复后为真重写——新会议替换一切旧计划）
      sessionManager.writePlan('overwrite', meetingSteps);
    }

    const strategy = resolveActiveStrategy(rolePackManager, this.deps.strategyOverride);
    // 单一 setStrategy 聚合 L2 策略（工具权限/步数/错误处理/路由/预算/推理/只读/审批/自审查）
    loop.setStrategy(resolveL2Strategy(strategy));

    // 换角色 → 按激活角色包的 capabilities 应用工具暴露面（toolMode=block 全禁与此正交）
    // 会议机制：工具面恒为 activePack（组员只"说"不执行，需完整能力应手动切换）——此处不走 roundAssemblyRole
    this.deps.applyRolePackToolExposure();

    yield { type: 'thinking', phase: 'recalling' };
    // 上下文装配（自动记忆召回已退役，仅细则预算 + 对话层注入，见 memory-tool-recall-design §4）
    await contextPreparer.assembleContext(input);

    if (signal.aborted) {
      return { input, aborted: true } satisfies SeedPrepareResult;
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

    return { input, aborted: false } satisfies SeedPrepareResult;
  }
}

/**
 * 会议机制（S5）：按给定任务项 rolePack 刷新本轮表层装配视角。
 *
 * 装配逻辑单一真理源。两个调用入口共用本函数，避免双写：
 *   - prepare.run（turn 开头：按首个 active step 的 rolePack 设一次）
 *   - 任务表每轮注入（assembler.getTaskTable → hooks.applyActiveStepAssembly → agent.applyActiveStepAssemblyIfChanged，
 *     T1 收口，2026-09-06：随 active step 推进逐步换角色，防重见 agent 实现）
 * 内部动作：
 *   - resolveRoundAssemblyRole：范围校验（∈ 组长∪组员，越界/缺员→null+warning，防 LLM 幻觉角色名）
 *   - setRoundAssemblyRole：skills 加载跟随装配视角
 *   - refreshRolePackPrefixForRound：重建 loop 前缀（persona/rules/skills 换，键恒 activePack）
 * rolePack 未声明/越界/缺员 → null → 回落 activePack 前缀（组长视角，工具面不变）。
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
