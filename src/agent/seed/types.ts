/**
 * 种子闭环契约类型 — 最小执行闭环（回答前/中/后 + Handoff）的类型定义
 *
 * 种子哲学（单轮执行闭环 = 最小单元）：一次触发 → 回答前 → 回答中 → 回答后 →
 * Handoff。本文件定义这三阶段的输入/输出契约，以及 seed 模块所需的依赖接口。
 *
 * 设计纪律：
 *   - getParts() 以「快照 getter」形式提供当前组件引用——switchProject/rebuildComponents
 *     会更换 loop/history/sessionManager，seed 每次运行经 getParts() 取最新引用，
 *     否则 rebuild 后 seed 将残留陈旧组件引用（关键正确性约束）。
 *   - consumeExecutionStream 是「统一流收口协议」，物理实现仍在门面（Agent），
 *     本处仅声明类型，回答中阶段经依赖注入消费（方案的流收口协议归门面）。
 */

import type { AgentLoop } from '@/agent/loop.js';
import type { MessageHistory } from '@/agent/messageHistory.js';
import type { AgentChunk, ArchiveMode, UIMessages } from '@/agent/types.js';
import type { ContextPreparer } from '@/agent/contextPreparer.js';
import type { SessionManager } from '@/agent/managers/sessionManager.js';
import type { RoundSummaryGenerator } from '@/agent/managers/roundSummaryGenerator.js';
import type { SessionNamer } from '@/agent/managers/sessionNamer.js';
import type { RolePackManager } from '@/role-pack/rolePackManager.js';
import type { LlmProvider } from '@/llm/provider.js';
import type { Memory } from '@/memory/types.js';
import type { ITracer } from '@/agent/tracer.js';
import type { BehaviorStrategy } from '@/role-pack/types.js';

/**
 * 流消费结果（consumeExecutionStream 的返回约定）
 *
 * content = 累积的文本；aborted = 是否被中断（含 appendAssistant 中断标记前置）；
 * paused = 是否在迭代边界软暂停挂起（回合未完成，摘要应推迟到续跑最终轮，保摘要 1:1）；
 * failed = 是否执行出错（错误 chunk 已 yield 给调用方，本结果为提前返回信号）；
 * iterationLimitReached = 是否因 maxIterations/stepBudget 上限而终止（非正常完成，需强制 wait）。
 */
export interface StreamConsumeResult {
  content: string;
  aborted: boolean;
  paused: boolean;
  failed: boolean;
  /** 是否因迭代/步数上限而终止（非正常完成，handoff 应强制返回 wait） */
  iterationLimitReached?: boolean;
}

/**
 * 种子三阶段运行所需的组件快照（getParts 的返回值）
 *
 * 各 field 对应门面当前持有的组件实例；null 表示尚未创建（如 sessionNamer 在
 * createPostInitComponents 才创建）。seed 只读不持有，全部由门面提供。
 */
export interface SeedParts {
  loop: AgentLoop;
  history: MessageHistory;
  sessionManager: SessionManager | null;
  rolePackManager: RolePackManager | null;
  contextPreparer: ContextPreparer;
  sessionNamer: SessionNamer | null;
  roundSummaryGenerator: RoundSummaryGenerator | null;
}

/**
 * 种子模块的依赖注入接口（门面稳定能力的窄面）
 *
 * 与 ContextPreparerDeps / AgentHooks 同构：只传稳定能力，不传可变私有状态。
 * getParts() 惰性取当前组件（见文件头设计纪律）；applyRolePackToolExposure 与
 * consumeExecutionStream 是门面私有能力，经回调注入 seed（物理实现仍在门面）。
 */
export interface SeedDeps {
  /** 取当前组件快照（rebuild 后仍为最新引用） */
  getParts(): SeedParts;
  /** 可观测性 Tracer（缺省 Noop，reflect 阶段 span 用） */
  tracer: ITracer | null;
  /** 归档模式（reflect 阶段 span 标注用） */
  archiveMode: ArchiveMode;
  /** 界面文案（中断标记 / 用户中断提示，缺省用内置默认） */
  messages?: UIMessages;
  /** 门面能力：应用当前角色包的工具暴露面（回答前换角色后工具集切换） */
  applyRolePackToolExposure(): void;
  /**
   * 门面能力：按本轮表层装配视角刷新 loop 前缀（会议机制）。
   * roundRole=null（日常态）→ 回落 activePack 前缀；roundRole 为任务项角色 → 该角色 persona/rules/skills。
   * 键（strategy/ChatOptions）恒为 activePack，不随视角变。缺省 no-op（纯工厂单测）。
   */
  refreshRolePackPrefixForRound?(roundRole: string | null): void;
  /** 门面能力：统一流收口协议（消费 loop 执行流 → AgentChunk；物理实现在 Agent）。
   *  signal 透传：consumeExecutionStream 据此区分「宿主/插话真取消」（signal.aborted）
   *  与「provider/网络内部中断」（signal 未 abort 却抛 AbortError）——避免连接中断谎报为用户取消 */
  consumeExecutionStream(
    source: AsyncGenerator<AgentChunk, void, unknown>,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentChunk, StreamConsumeResult, unknown>;
  /**
   * 后台 Provider（难度分级等「回答前视图」轻量判定用；运行时可变，故取函数式）；
   * 为 null 表示后台不可用 → 判定降级为 unknown，不影响主回答。
   */
  getBackgroundProvider(): LlmProvider | null;
  /**
   * 宿主装配级策略覆盖（可选）：经 resolveActiveStrategy 压过角色包声明，表达宿主产品能力边界。
   *（v0.13 后无内置示例键；机制保留供宿主能力边界使用）
   */
  strategyOverride?: Partial<BehaviorStrategy>;
}

/**
 * 回答前（Prepare）运行结果
 *
 * input = 原始输入；recalledMemories = 召回记忆（注入 loop 为 system 消息）；
 * aborted = 回答前阶段已中断（调用方应 yield aborted chunk 并返回，不进回答中）；
 * meetingPreset = 本次会议触发已由系统确定性预置任务表（见 ADR-028 收敛补记），
 *   调用方（orchestrator）据此强制进入 Loop 编排（档2）直跑步序列，跳过规划闭环。
 * roundId 不在此结果中——round 归属以 loop 的 currentRoundId 为单一真理源。
 */
export interface SeedPrepareResult {
  input: string;
  recalledMemories: Memory[];
  aborted: boolean;
  meetingPreset: boolean;
}
