/**
 * 回答前（Prepare）— 种子闭环第一阶段
 *
 * 收敛原 Agent.prepareChatContext 的编排骨架：会话粘性复位 → 策略装配 → 角色
 * 匹配 → 记忆召回 → roundId → appendUser → 会话命名。
 *
 * 设计原则：
 *   - 叶子逻辑（tryAutoMatchRolePack / recallAndInject）在
 *     ContextPreparer 唯一实现，本模块只保留编排骨架（与 ContextPreparer 文档一致）。
 *   - lastStickySessionId（会话切换时复位角色包粘性）随本模块收进——它是"回答前"
 *     职责（注释原文：由 prepareChatContext 驱动），不是门面归属。
 */

import type { AgentChunk } from '@/agent/types.js';
import { backgroundTask } from '@/utils/backgroundTask.js';
import {
  resolveAutoSwitch,
  resolveContextAssembly,
  resolveL2Strategy,
  resolveMemoryRecallMode,
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
  /** 最近一次角色包粘性匹配的会话 ID（粘性不跨会话，会话切换时复位） */
  private lastStickySessionId: string | null = null;

  /** 依赖注入（门面稳定能力窄面） */
  private readonly deps: SeedDeps;

  constructor(deps: SeedDeps) {
    this.deps = deps;
  }

  /**
   * 执行回答前：会话粘性复位 → 策略装配 → 角色自动匹配 → 记忆召回 → 技能注入 →
   * roundId → 用户消息入史 → 会话命名。
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

    // 会话切换时复位角色包粘性（粘性不跨会话）
    const sessionId = sessionManager?.getCheckpoint()?.sessionId ?? '';
    if (sessionId !== this.lastStickySessionId) {
      rolePackManager?.resetSticky();
      this.lastStickySessionId = sessionId;
    }

    // autoSwitch 决定是否允许角色自动匹配（'off' 时锁定当前角色包）
    const preMatchStrategy = resolveActiveStrategy(rolePackManager);
    const autoSwitch = resolveAutoSwitch(preMatchStrategy);
    if (autoSwitch === 'on') {
      await contextPreparer.tryAutoMatchRolePack(input);
    }

    const strategy = resolveActiveStrategy(rolePackManager);
    // 枚举键经集中解析（SSOT 兜底）：非法值归位内核默认，不透传
    const memoryRecallMode = resolveMemoryRecallMode(strategy);
    // 上下文装配策略：fixed=仅固定轮次 / query=仅语义召回 / hybrid=混合
    const contextAssembly = resolveContextAssembly(strategy);
    // 单一 setStrategy 聚合 L2 策略（工具权限/步数/错误处理/路由/预算/推理/只读/审批/自审查）
    loop.setStrategy(resolveL2Strategy(strategy));

    // 换角色 → 按激活角色包的 capabilities 应用工具暴露面（toolMode=block 全禁与此正交）
    this.deps.applyRolePackToolExposure();

    yield { type: 'thinking', phase: 'recalling' };
    // 记忆召回 + 固定轮次注入（输入增强管线叶子逻辑，内容唯一实现在 ContextPreparer）
    const recalledMemories = await contextPreparer.recallAndInject(
      input,
      memoryRecallMode,
      contextAssembly,
    );

    if (signal.aborted) {
      return { input, recalledMemories, aborted: true } satisfies SeedPrepareResult;
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

    return { input, recalledMemories, aborted: false } satisfies SeedPrepareResult;
  }
}
