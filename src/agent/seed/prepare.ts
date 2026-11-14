/**
 * 回答前（Prepare）— 种子闭环第一阶段
 *
 * 编排骨架：roundId → 策略装配 → 角色 → 上下文装配
 * → appendUser → 会话命名。会议机制：任务项表层装配视角经本模块读取并驱动前缀刷新。
 *
 * 设计原则：
 *   - 叶子逻辑（assembleContext → 上下文装配：预算派生 + 对话层注入 + 占用快照）在
 *     ContextPreparer 唯一实现，本模块只保留编排骨架（与 ContextPreparer 文档一致）。
 */

import type { AgentChunk } from '@/agent/types.js';
import type { ImageRef } from '@/llm/provider.js';
import type { Round } from '@/memory/roundStore.js';
import { logger } from '@/logging/logger.js';
import { resolveL2Strategy, resolveActiveStrategy } from '@/role-pack/strategyResolver.js';
import { buildMeetingPlanSkeleton } from '@/role-pack/rolePackManager.js';
import { type SeedDeps, type SeedParts, type SeedPrepareResult } from './types.js';

/**
 * 回答前阶段执行器
 *
 * 一次输入 → 装配上下文（角色 + 技能 + 用户消息入史），供回答中消费。
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
   * @param attachments 图片附件（可选，多模态输入）；透传到 `history.appendUser` 落盘（方案 §7 P0-12）
   * @param opts 输入来源标记（origin）与发送者名称（senderName）；不传 = 历史行为
   * @returns 回答前结果（input + aborted；round 归属见 SeedPrepareResult）
   */
  async *run(
    input: string,
    signal: AbortSignal,
    attachments?: readonly ImageRef[],
    opts?: { origin?: Round['origin']; senderName?: string },
  ): AsyncGenerator<AgentChunk, SeedPrepareResult, unknown> {
    const { loop, history, sessionManager, rolePackManager, contextPreparer, sessionNamer } =
      this.deps.getParts() as SeedParts;

    // 轮身份在回答前入口**即刻出生**（先于任何可能耗时 / 可能抛错的装配动作）：
    // 宿主拿到的首枚 thinking chunk 即带 roundId ⇒ 实时视图从 prepare 起点就归入该轮，
    // `meta` 随之提前到达 webview ⇒ 流式骨架在首个正文 chunk 之前建立
    // （根因与验收口径见台账 LIVE-ROUND-BLOCK-LOST-1）。
    // 残留边界：置位后若在 appendUser 之前中断，此 id 无对应轮文件——写路径对缺席轮
    // 一律 fail-closed（如 interject ⇒ round-missing），不会污染上一轮。
    const roundId = loop.allocRoundId();
    loop.setCurrentRoundId(roundId);

    // 每次回答前先清临时 system 消息（技能/最近对话 prompt 是当轮注入，不跨轮累积）
    loop.cleanTemporarySystemMessages();

    // turn 入口统一装配刷新：先 await 常驻规则读盘，再按 active 任务项同步刷新前缀
    // （唯一组合函数，与 runResume 共用；active 谓词只在组合函数里出现一次）
    await refreshTurnAssembly(this.deps);

    // 会议机制实施前提②：组/成员清单暴露给 LLM（防编造角色名）——仅当 activePack 是某组组长时注入
    const teamContext = rolePackManager?.buildTeamContextBlock() ?? '';
    if (teamContext) {
      loop.injectSystemMessage(teamContext);
    }

    // 会议机制骨架预置（「最小受控起点」）。
    // 与 buildTeamContextBlock 文案互补：骨架补首轮确定性（顶部任务板可见 + PlanItem.rolePack 装配钩子），
    // 文案约束 LLM 后续推进走 task_table 单通道。守卫语义：
    //   已有未完成计划（pending/active 存在）→ 跳过骨架预置 = 续会语义：第二轮「继续小组会议」等输入
    //   交给 LLM 按既有任务表推进，不再重开/叠加会议任务项；无在途计划时的「小组会议」输入 = 新会议 → overwrite 预置。
    //   重开已推进会议需显式手段（宿主清空任务表 / LLM task_table_write），非自然语言自动触发。
    // 在途判定经 SessionManager.hasInflightPlan 单点（SSOT）：与 loop 侧「已有在途任务表则跳过
    // nudge」共用同一命题口径，禁此处再内联谓词另起一份判定。
    const hasInflightPlan = sessionManager?.hasInflightPlan() ?? false;
    // 骨架数据经 getActiveTeam()（公开 SSOT 出口：组长 + 截断/缺员过滤后的有效组员）取，
    // 纯函数 buildMeetingPlanSkeleton 组装（PUB-API-PRUNE-2 从 RolePackManager 摘类）；
    // activePack 非组长/无队伍 → getActiveTeam() 返回 null ⇒ 不触发，同原方法内部守卫
    const activeTeam = rolePackManager?.getActiveTeam() ?? null;
    const meetingPlanItems =
      hasInflightPlan || !activeTeam
        ? null
        : buildMeetingPlanSkeleton(activeTeam.leader, activeTeam.members, input);
    if (meetingPlanItems && sessionManager) {
      // 骨架预置：overwrite = 真重写，新会议替换一切旧计划
      sessionManager.writePlan('overwrite', meetingPlanItems);
    }

    const strategy = resolveActiveStrategy(rolePackManager, this.deps.strategyOverride);
    // 单一 setStrategy 聚合 L2 策略（工具权限/步数/错误处理/路由/预算/推理/只读/审批/自审查）
    loop.setStrategy(resolveL2Strategy(strategy));

    // 换角色 → 按激活角色包的 capabilities 应用工具暴露面（toolMode=block 全禁与此正交）
    // 会议机制：工具面恒为 activePack（组员只"说"不执行，需完整能力应手动切换）——此处不走 roundAssemblyRole
    this.deps.applyRolePackToolExposure();

    // roundId 随首枚 prepare 阶段 chunk 一起下发：宿主的归轮判据在 chunk 循环顶部，
    // 无需另开通道即可在 prepare 期把实时事件归入本轮（`RoundTagged` 已含可选 roundId，零类型改动）
    yield { type: 'thinking', phase: 'assembling', roundId };
    // 上下文装配（无自动记忆召回，仅细则预算 + 对话层注入，见 memory-tool-recall-design §4）
    await contextPreparer.assembleContext(input);

    if (signal.aborted) {
      return { input, aborted: true } satisfies SeedPrepareResult;
    }

    // 技能按渐进披露 L1 清单常驻 system prompt，正文由模型按需 read_skill，回答前不预注入
    yield { type: 'thinking', phase: 'processing', roundId };

    // 无附件、无来源标记时调用形状与升级前**完全一致**（不传第 3 参）：prepare / orchestrator 的
    // `appendUser` 断言按双参验收，无条件多出一个 `{}` 属行为变更（务必带条件传参）。
    const userMessageOpts = {
      ...(attachments ? { attachments } : {}),
      ...(opts?.origin ? { origin: opts.origin } : {}),
      ...(opts?.senderName ? { senderName: opts.senderName } : {}),
    };
    if (Object.keys(userMessageOpts).length > 0) {
      await history.appendUser(input, roundId, userMessageOpts);
    } else {
      await history.appendUser(input, roundId);
    }

    // 会话标题自动命名（fire-and-forget）：仅新建会话首次问答触发（以"会话无标题"判定，不覆盖手动改名）
    if (sessionNamer) {
      // 写回目标 = **调度时刻**的会话名，必须先快照再进闭包：
      // 闭包可能在后台槽位排队后才执行，届时 `history.current*` 可能已被切会话改写
      // ⇒ 标题写到别的会话上，原会话永远停在占位名（真机实锤）。
      const sessionDate = history.currentDateValue;
      const sessionName = history.currentSessionValue;
      // 后台槽位调度器归属本 Agent 实例（SeedDeps 注入）——命名 fire-and-forget 不阻塞回答前
      this.deps.backgroundTasks.schedule('session-title', () =>
        sessionNamer.ensureSessionTitle(sessionDate, sessionName, input),
      );
    }

    return { input, aborted: false } satisfies SeedPrepareResult;
  }
}

/**
 * turn 入口统一装配刷新（`runChat` / `runResume` 的**唯一共用点**）：先异步读盘，再同步刷新表层装配。
 *
 * 为什么必须两段：`refreshAssemblyForRolePack` 所在的前缀重建链全程**同步 void**（不能在同步函数里做磁盘 IO），
 * 常驻规则正文只能异步读；顺序颠倒（先同步刷新、后异步读盘）⇒ 本轮注入的是上一轮缓存，规则晚一轮生效。
 *
 * 异常边界（两层兜底的分工，勿混为一体）：
 * - **内层**：`ResidentRulesManager.refresh()` 已把「清单读失败 / 条目失效」全部降级（清单读失败 ⇒ 空段 +
 *   内核日志；条目失效 ⇒ 剔该条 + 段首汇总；**不缓存、不沿用上次内容**），常规读盘异常**不抛**；
 * - **外层**（本函数 catch）：**防御位**——可达路径只有「注入依赖自身抛错」（今日 Agent 侧实现不抛，
 *   故正常路径不可达；包含未来 manager 新增第二种读盘源、或 `projectDir` 非法等编程错误类）。
 *   保留理由：不得让注入面的意外异常把 turn 拖死；契约由 prepare / orchestrator 单测的**抛错桩**钉住
 *   （stub 抛错 ⇒ turn 仍完整跑完）。未注入时可选链直接 no-op，不进 catch。
 *
 * @param deps 种子依赖（常驻规则刷新门面 + 刷新前缀能力）
 */
export async function refreshTurnAssembly(deps: SeedDeps): Promise<void> {
  try {
    await deps.refreshResidentRulesContext?.();
  } catch (err) {
    // 防御位：本轮不注入项目规则，继续本轮（不中断 turn；措辞与内层降级一致，便于排障时区分来源）
    logger.warn({ err }, '注入边界：项目规则刷新抛错，已忽略（本轮不注入，不中断 turn）');
  }

  // active 任务项谓词**唯一落点**：两个入口共用本函数，禁止在入口各抄一份
  // （双份谓词的漂移没有任何测试会红，见 resident-layer-design §12.3）
  const checkpoint = deps.getParts().sessionManager?.getCheckpoint();
  const activePlanItem = checkpoint?.plan.find((s) => s.status === 'active');
  refreshAssemblyForRolePack(deps, activePlanItem?.rolePack);
}

/**
 * 会议机制：按给定任务项 rolePack 刷新本轮表层装配视角。
 *
 * 装配逻辑单一真理源。两个调用入口共用本函数，避免双写：
 *   - refreshTurnAssembly（turn 开头：两个 turn 入口共用，按首个 active 任务项的 rolePack 设一次）
 *   - 任务表每轮注入（assembler.getTaskTable → hooks.applyActivePlanItemAssembly → agent.applyActivePlanItemAssemblyIfChanged，
 *     随 active 任务项推进逐项换角色，防重见 agent 实现）
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
