/**
 * 角色包行为策略解析器
 *
 * 集中管理行为策略的默认值、解析（resolve*）、合并与装配逻辑。
 * 从 types.ts 拆分而来，旨在降低 types.ts 的复杂度，实现类型定义与行为解析的分离。
 */

// 召回保底下限默认值：跨层共享（role-pack 与 memory 均引用），SSOT 单一来源
import { DEFAULT_MIN_FALLBACK } from '@/utils/recallDefaults.js';
import type {
  BehaviorStrategy,
  Handoff,
  MemoryRecallMode,
  MemoryWriteMode,
  SessionArchiveMode,
  AutoSwitch,
  ContextAssembly,
  ErrorHandling,
  InputInterrupt,
  ProviderRouting,
  MultiStepReasoning,
  SummaryRecall,
  ToolApproval,
  ToolReadonly,
  ToolMode,
  RolePack,
  RolePackAssembly,
  RolePackCapability,
  Summary,
  L2RuntimeStrategy,
} from './types.js';

// ════════════════════════════════════════════════════════════
// 默认值常量
// ════════════════════════════════════════════════════════════

/**
 * 上下文固定加载轮数 N 的内核默认值（SSOT 单一默认真理源）
 *
 * 语义（memory-as-summary §4.3）：N ≡ 上下文固定加载的完整对话轮数，
 * 互斥窗口（排除正文已加载轮次的摘要）与最近对话注入共享同一 N，
 * 保证"正文加载 N 轮 ⟺ 互斥排除 N 轮"严格一致。
 * 角色包可经 `prepare.recentRounds` 覆盖；仅在角色包未声明或声明非法时
 * 降级回本默认。agent 层 `AGENT_CONSTANTS.DEFAULT_RECENT_HISTORY_ROUNDS`
 * 引用本常量，避免同一维度出现两套平行默认值。
 */
export const DEFAULT_RECENT_HISTORY_ROUNDS = 3;

/**
 * 行为策略全局默认值
 *
 * 设计纪律第 2 条：未配置的行为维度使用全局默认值。
 * 角色包可以只声明它想改变的部分——最小角色包即一个含 frontmatter 的声明文件。
 * 作为 const 断言，确保类型推导为字面量值。
 */
export const DEFAULT_BEHAVIOR_STRATEGY: BehaviorStrategy = {
  prepare: {
    understandingConfirm: 'off',
    contextAssembly: 'hybrid',
    recentRounds: DEFAULT_RECENT_HISTORY_ROUNDS,
    memoryRecall: 'full',
    memoryRecallQuota: 2000,
    summaryRecall: 'on',
    minFallback: DEFAULT_MIN_FALLBACK,
    summaryFocus: undefined, // undefined = 通用浓缩（角色包未声明时使用默认摘要策略）
    recallConfidence: 0.6,
    taskClassification: 'keyword',
    autoSwitch: 'on',
  },
  act: {
    toolMode: 'allow',
    toolApproval: 'auto',
    toolReadonly: 'full',
    toolStepLimit: 20,
    streaming: 'streaming',
    temperature: 0.7,
    outputLimit: 4096,
    providerRouting: 'auto',
    multiStepReasoning: 'auto',
    inputInterrupt: 'allow',
  },
  reflect: {
    handoff: 'wait',
    loopContinue: 0,
    summary: 'on',
    memoryWrite: 'auto',
    sessionArchive: 'auto',
    userFollowup: 'silent',
  },
  global: {
    tokenBudget: 8000,
    stepBudget: 50,
    costBudget: 0,
    errorHandling: 'retry',
    safetyRule: 'inherit',
    askOn: ['ambiguity', 'decision', 'missing_info'],
    askLimit: 3,
  },
} as const;

// ════════════════════════════════════════════════════════════
// 辅助函数
// ════════════════════════════════════════════════════════════

/**
 * 枚举值合法性收窄（SSOT 兜底）
 *
 * 角色包 L2 键是枚举开关，非法拼写/错误取值不应静默透传（handoff 会直接
 * yield 给宿主，其他枚举会污染行为分支）。统一在此归位到内核默认。
 *
 * @param value 角色包声明的原始值
 * @param allowed 合法枚举值集合
 * @param fallback 非法/缺失时的内核默认
 * @returns 合法值或内核默认
 */
function normalizeEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

// ════════════════════════════════════════════════════════════
// 策略解析函数 (resolve*)
// ════════════════════════════════════════════════════════════

/**
 * 解析上下文固定加载轮数 N（SSOT 单一来源）
 *
 * 规则：角色包声明的 `prepare.recentRounds` 为合法的"0 以上正整数"时，
 * **一律采用角色包定义**；仅在缺失/不存在、非整数、<=0 等非法情形才降级
 * 为内核默认 `DEFAULT_RECENT_HISTORY_ROUNDS`。
 *
 * 互斥窗口（`getRecentRoundIds`）与最近对话注入（`getRecentHistory`）必须共用
 * 本函数返回值——二者任一单独取数都会造成"正文加载轮数与互斥排除轮数不一致"，
 * 导致第 N 轮内摘要与正文重复注入（memory-as-summary §4.3 的严格相等被破坏）。
 *
 * @param strategy 已合并默认值的完整行为策略（无激活角色包时传 undefined）
 * @returns 合法的固定加载轮数 N（>0 的整数）
 */
export function resolveRecentRounds(strategy: BehaviorStrategy | undefined): number {
  // 角色包定义优先：仅当声明的 recentRounds 是"0 以上正整数"才采用
  const candidate = strategy?.prepare?.recentRounds;
  const valid = typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0;
  return valid ? candidate : DEFAULT_RECENT_HISTORY_ROUNDS;
}

/**
 * 解析衔接策略（SSOT）：非法值（非 wait/loop/end）归位 'wait'
 *
 * handoff 是唯一会作为 chunk 直接暴露给宿主的枚举——非法值必须归位，
 * 避免宿主收到无法识别的衔接决策。
 *
 * @param strategy 合并后的行为策略
 * @returns 合法的 handoff 枚举值
 */
export function resolveHandoff(strategy: BehaviorStrategy | undefined): Handoff {
  return normalizeEnum(strategy?.reflect?.handoff, ['wait', 'loop', 'end'], 'wait');
}

/**
 * 解析记忆召回模式（SSOT）：非法值归位 'full'
 *
 * @param strategy 合并后的行为策略
 * @returns 合法的记忆召回模式
 */
export function resolveMemoryRecallMode(strategy: BehaviorStrategy | undefined): MemoryRecallMode {
  return normalizeEnum(strategy?.prepare?.memoryRecall, ['full', 'limited', 'none'], 'full');
}

/**
 * 解析召回保底下限（SSOT）：非负整数才采用，非法/缺失回退内核默认
 *
 * 角色包 `prepare.minFallback` 控制"语义召回不足时用最近记忆补足至该条数"的行为。
 * 归位规则：仅当声明值是"非负整数"才采用；缺失、非整数、负数均回退
 * `DEFAULT_MIN_FALLBACK`（默认 2）。置 0 表示彻底关闭保底。
 *
 * @param strategy 合并后的行为策略
 * @returns 合法召回保底下限（>=0 的整数）
 */
export function resolveMinFallback(strategy: BehaviorStrategy | undefined): number {
  const candidate = strategy?.prepare?.minFallback;
  const valid = typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 0;
  return valid ? candidate : DEFAULT_MIN_FALLBACK;
}

/**
 * 解析角色包提炼视角（SSOT）：合法非空字符串采用，缺失/空白归位 undefined（通用浓缩）
 *
 * 领域无关机制：内核只提供"摘要提炼视角可被角色包注入"的通用能力，视角全文由角色包
 * 提供（如编程卡声明代码/diff/表格 + 意图/决策等维度）。声明时替换通用"意图/回答/
 * 决策"归纳框架（JSON 硬契约保留）；未声明 → undefined，round-summary 摘要行为与现状一致。
 *
 * @param strategy 合并后的行为策略
 * @returns 角色包提炼视角（无则 undefined=通用浓缩）
 */
export function resolveSummaryFocus(strategy: BehaviorStrategy | undefined): string | undefined {
  const candidate = strategy?.prepare?.summaryFocus;
  return typeof candidate === 'string' && candidate.trim().length > 0 ? candidate.trim() : undefined;
}

/**
 * 解析工具调用模式（SSOT）：非法值归位 'allow'
 *
 * @param strategy 合并后的行为策略
 * @returns 合法的工具调用模式
 */
export function resolveToolMode(strategy: BehaviorStrategy | undefined): ToolMode {
  return normalizeEnum(strategy?.act?.toolMode, ['allow', 'block'], 'allow');
}

/**
 * 解析摘要生成开关（Tier 1 已消费）：非法值归位 'on'
 *
 * @param strategy 合并后的行为策略
 * @returns 合法的摘要生成开关（on=生成摘要 / off=不生成）
 */
export function resolveSummary(strategy: BehaviorStrategy | undefined): Summary {
  return normalizeEnum(strategy?.reflect?.summary, ['on', 'off'], 'on');
}

/**
 * 解析上下文装配策略（Tier 2 已消费）：非法值归位 'hybrid'
 *
 * 控制记忆召回与固定轮次注入的组合方式：
 * - 'fixed' → 仅加载最近 N 轮，不做语义召回
 * - 'query' → 仅做语义召回，不加载固定轮次
 * - 'hybrid' → 混合模式（默认），固定轮次 + 语义召回
 *
 * @param strategy 合并后的行为策略
 * @returns 合法的上下文装配策略
 */
export function resolveContextAssembly(strategy: BehaviorStrategy | undefined): ContextAssembly {
  return normalizeEnum(strategy?.prepare?.contextAssembly, ['fixed', 'query', 'hybrid'], 'hybrid');
}

/**
 * 解析工具调用步数上限（Tier 2 已消费）：合法正整数采用，非法/缺失回退默认 0（不限制）
 *
 * 控制单次 LLM 响应中允许的最大工具调用数量（所有并行工具调用合计）。
 * 超过上限时，多余的工具调用被忽略，仅保留文本内容。
 *
 * @param strategy 合并后的行为策略
 * @returns 合法的工具调用步数上限
 */
export function resolveToolStepLimit(strategy: BehaviorStrategy | undefined): number {
  const candidate = strategy?.act?.toolStepLimit;
  // 合法值：0=无限制，N>0=限制步数
  const valid = typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 0;
  return valid ? candidate : 0;
}

/**
 * 解析错误处理策略（Tier 2 已消费）：非法值归位 'retry'
 *
 * 控制 LLM 调用失败后的处理方式：
 * - 'retry' → 自动重试（默认，最多 MAX_LLM_RETRIES 次）
 * - 'degrade' → 降级为纯文本回复（跳过工具调用）
 * - 'stop' → 立即终止对话，抛出错误
 *
 * @param strategy 合并后的行为策略
 * @returns 合法的错误处理策略
 */
export function resolveErrorHandling(strategy: BehaviorStrategy | undefined): ErrorHandling {
  return normalizeEnum(strategy?.global?.errorHandling, ['retry', 'degrade', 'stop'], 'retry');
}

/**
 * 解析角色自动匹配开关（Tier 3 已消费）：非法值归位 'on'
 *
 * 控制角色包是否允许自动匹配切换：
 * - 'on' → 允许关键词/LLM 自动匹配切换（默认）
 * - 'off' → 锁定当前角色包，不自动切换
 *
 * @param strategy 合并后的行为策略
 * @returns 合法的自动匹配开关
 */
export function resolveAutoSwitch(strategy: BehaviorStrategy | undefined): AutoSwitch {
  return normalizeEnum(strategy?.prepare?.autoSwitch, ['on', 'off'], 'on');
}

/**
 * 解析 Provider 路由策略（Tier 3 已消费）：非法值归位 'auto'
 *
 * 控制 LLM 调用时的模型路由行为：
 * - 'auto' → 按任务类型自动路由到对应模型（默认）
 * - 'fixed' → 固定使用当前 Provider，不做路由
 *
 * @param strategy 合并后的行为策略
 * @returns 合法的 Provider 路由策略
 */
export function resolveProviderRouting(strategy: BehaviorStrategy | undefined): ProviderRouting {
  return normalizeEnum(strategy?.act?.providerRouting, ['auto', 'fixed'], 'auto');
}

/**
 * 解析输入中断策略（Tier 3 已消费）：非法值归位 'allow'
 *
 * 控制执行中插话行为：
 * - 'allow' → 允许用户在执行中插话（默认，中断当前操作注入新内容）
 * - 'block' → 阻止执行中插话，排队到下一轮
 *
 * @param strategy 合并后的行为策略
 * @returns 合法的输入中断策略
 */
export function resolveInputInterrupt(strategy: BehaviorStrategy | undefined): InputInterrupt {
  return normalizeEnum(strategy?.act?.inputInterrupt, ['allow', 'block'], 'allow');
}

/**
 * 解析 Token 预算上限（Tier 3 已消费）：合法正整数采用，非法/缺失回退默认 8000
 *
 * 控制单轮对话的总 token 消耗上限：
 * - 0 = 不限制
 * - N > 0 = 达到上限时提前结束迭代
 *
 * @param strategy 合并后的行为策略
 * @returns 合法的 token 预算上限
 */
export function resolveTokenBudget(strategy: BehaviorStrategy | undefined): number {
  const candidate = strategy?.global?.tokenBudget;
  const valid = typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 0;
  return valid ? candidate : 8000;
}

/**
 * 解析步数预算上限（Tier 3 已消费）：合法正整数采用，非法/缺失回退默认 50
 *
 * 控制单轮对话的最大迭代步数（软上限，配合 maxIterations 双重保护）：
 * - 0 = 不限制
 * - N > 0 = 达到上限时提前结束迭代
 *
 * @param strategy 合并后的行为策略
 * @returns 合法的步数预算上限
 */
export function resolveStepBudget(strategy: BehaviorStrategy | undefined): number {
  const candidate = strategy?.global?.stepBudget;
  const valid = typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 0;
  return valid ? candidate : 50;
}

/**
 * 解析记忆写入模式（Phase 1 已消费）：非法值归位 'auto'
 *
 * 控制记忆写入是否需要用户确认：
 * - 'auto' → 自动写入（默认）
 * - 'confirm' → 写入前等待宿主确认
 *
 * @param strategy 合并后的行为策略
 * @returns 合法的记忆写入模式
 */
export function resolveMemoryWrite(strategy: BehaviorStrategy | undefined): MemoryWriteMode {
  return normalizeEnum(strategy?.reflect?.memoryWrite, ['auto', 'confirm'], 'auto');
}

/**
 * 解析会话归档模式（Phase 1 已消费）：非法值归位 'auto'
 *
 * 控制会话内容自动归档行为：
 * - 'auto' → 自动归档（默认）
 * - 'manual' → 仅手动归档
 *
 * @param strategy 合并后的行为策略
 * @returns 合法的会话归档模式
 */
export function resolveSessionArchive(strategy: BehaviorStrategy | undefined): SessionArchiveMode {
  return normalizeEnum(strategy?.reflect?.sessionArchive, ['auto', 'manual'], 'auto');
}

/**
 * 解析多步推理模式（Phase 1 已消费）：非法值归位 'auto'
 *
 * 控制 LLM 是否启用深度思考：
 * - 'auto' → 由 Provider 自行决定（默认）
 * - 'manual' → 强制快速回答（跳过深度推理）
 *
 * @param strategy 合并后的行为策略
 * @returns 合法的多步推理模式
 */
export function resolveMultiStepReasoning(strategy: BehaviorStrategy | undefined): MultiStepReasoning {
  return normalizeEnum(strategy?.act?.multiStepReasoning, ['auto', 'manual'], 'auto');
}

/**
 * 解析召回置信度阈值（Phase 2 已消费）：非法值归位 0.3
 *
 * 控制语义召回的相似度过滤阈值：
 * - 0.0~1.0 浮点数，越大越严格
 * - 默认 0.3（语义召回保底下限）
 *
 * @param strategy 合并后的行为策略
 * @returns 合法的召回置信度阈值
 */
export function resolveRecallConfidence(strategy: BehaviorStrategy | undefined): number {
  const candidate = strategy?.prepare?.recallConfidence;
  const valid = typeof candidate === 'number' && candidate >= 0 && candidate <= 1;
  return valid ? candidate : 0.3;
}

/**
 * 解析摘要召回开关（Phase 2 已消费）：非法值归位 'on'
 *
 * 控制摘要记忆是否参与召回：
 * - 'on' → 摘要和原始记忆一起参与召回（默认）
 * - 'off' → 仅召回原始记忆，跳过摘要
 *
 * @param strategy 合并后的行为策略
 * @returns 合法的摘要召回开关
 */
export function resolveSummaryRecall(strategy: BehaviorStrategy | undefined): SummaryRecall {
  return normalizeEnum(strategy?.prepare?.summaryRecall, ['on', 'off'], 'on');
}

/**
 * 解析工具只读模式（Phase 3 已消费）：非法值归位 'full'
 *
 * 控制工具操作权限范围：
 * - 'full' → 完整权限（默认）
 * - 'readonly' → 仅允许只读工具
 *
 * @param strategy 合并后的行为策略
 * @returns 合法的工具模式
 */
export function resolveToolReadonly(strategy: BehaviorStrategy | undefined): ToolReadonly {
  return normalizeEnum(strategy?.act?.toolReadonly, ['full', 'readonly'], 'full');
}

/**
 * 解析工具审批模式（Phase 3 已消费）：非法值归位 'auto'
 *
 * 控制工具执行审批行为：
 * - 'auto' → 自动执行（默认）
 * - 'confirm' → 执行前等待宿主确认
 *
 * @param strategy 合并后的行为策略
 * @returns 合法的工具审批模式
 */
export function resolveToolApproval(strategy: BehaviorStrategy | undefined): ToolApproval {
  return normalizeEnum(strategy?.act?.toolApproval, ['auto', 'confirm'], 'auto');
}

// ════════════════════════════════════════════════════════════
// L2 运行时策略（loop 运行态）装配
// ════════════════════════════════════════════════════════════

/**
 * L2 运行时策略默认值（loop 构造初始态）
 *
 * 与各 resolve* 的"非法/缺失回退"默认值保持一致——真正每轮生效值来自 resolveL2Strategy，
 * 本常量仅作 loop 构造期的惰性初始值（T1 收敛，替代 loop 内 11 个字段初始化魔数）。
 */
export const DEFAULT_L2_STRATEGY: L2RuntimeStrategy = {
  toolCallsBlocked: false,
  maxSelfReviewRounds: 0,
  toolStepLimit: 0,
  errorHandling: 'retry',
  providerRouting: 'auto',
  inputInterrupt: 'allow',
  tokenBudget: 8000,
  stepBudget: 50,
  multiStepReasoning: 'auto',
  toolReadonly: 'full',
  toolApproval: 'auto',
};

/**
 * 解析 L2 运行时策略（T1 收敛：替代 Agent 层 11 处 setXxx 逐项装配）
 *
 * 聚合现有 10 个 resolveXxx（工具模式→toolCallsBlocked、工具步数、错误处理、Provider 路由、
 * 输入中断、Token/步数预算、多步推理、工具只读、工具审批）+ reflect.loopContinue；
 * 非法值经各 resolve* 归位内核默认；loopContinue 归一为「0=关闭 / 正整数=N 轮执行上限」。
 *
 * @param strategy 合并后的行为策略（角色包声明，可为空）
 * @returns 注入 AgentLoop 的单一运行时策略对象
 */
export function resolveL2Strategy(strategy: BehaviorStrategy | undefined): L2RuntimeStrategy {
  // loopContinue → 自审查轮数：合法非负整数采用，否则关闭（0 轮）
  const loopContinue = strategy?.reflect?.loopContinue;
  const maxSelfReviewRounds =
    typeof loopContinue === 'number' && Number.isInteger(loopContinue) && loopContinue >= 0
      ? loopContinue
      : 0;
  return {
    toolCallsBlocked: resolveToolMode(strategy) === 'block',
    maxSelfReviewRounds,
    toolStepLimit: resolveToolStepLimit(strategy),
    errorHandling: resolveErrorHandling(strategy),
    providerRouting: resolveProviderRouting(strategy),
    inputInterrupt: resolveInputInterrupt(strategy),
    tokenBudget: resolveTokenBudget(strategy),
    stepBudget: resolveStepBudget(strategy),
    multiStepReasoning: resolveMultiStepReasoning(strategy),
    toolReadonly: resolveToolReadonly(strategy),
    toolApproval: resolveToolApproval(strategy),
  };
}

// ════════════════════════════════════════════════════════════
// 策略合并与装配
// ════════════════════════════════════════════════════════════

/**
 * 合并行为策略：角色包声明值覆盖默认值
 *
 * @param base 基础策略（通常传入 DEFAULT_BEHAVIOR_STRATEGY）
 * @param override 角色包声明的覆盖值，未配置的维度保持默认值不变
 * @returns 合并后的完整策略
 */
export function mergeStrategy(
  base: BehaviorStrategy,
  override: BehaviorStrategy | undefined,
): BehaviorStrategy {
  if (!override) return base;

  return {
    prepare: { ...base.prepare, ...override.prepare },
    act: { ...base.act, ...override.act },
    reflect: { ...base.reflect, ...override.reflect },
    global: { ...base.global, ...override.global },
  };
}

/**
 * 将 RolePack 解析为 RolePackAssembly
 *
 * 将原始角色包解析为含完整策略的装载结果，供装配层直接使用。
 * 同时根据策略中的 userFollowup/askOn/askLimit 注入主动提问指令到 persona prompt。
 *
 * @param pack 原始角色包
 * @returns 含完整策略的装载结果
 */
export function assembleRolePack(pack: RolePack): RolePackAssembly {
  // 先合并策略，后续构建 persona prompt 时需读取策略值
  const strategy = mergeStrategy(DEFAULT_BEHAVIOR_STRATEGY, pack.strategy);

  // 构建 persona prompt：身份设定 + 规则注入
  const promptParts: string[] = [pack.personaContent];

  if (pack.rules.length > 0) {
    promptParts.push(`## 规则\n${pack.rules.map((r) => `- ${r}`).join('\n')}`);
  }

  // 主动提问指令注入：userFollowup=ask 时，将 askOn/askLimit 转为 LLM 指令
  if (strategy.reflect?.userFollowup === 'ask') {
    const askOn = strategy.global?.askOn;
    const askLimit = strategy.global?.askLimit ?? 3;
    const triggerLabels: string[] = [];
    const triggers = Array.isArray(askOn) ? askOn : (askOn ? [askOn] : []);
    for (const t of triggers) {
      switch (t) {
        case 'ambiguity': triggerLabels.push('遇到模糊不清的情况'); break;
        case 'decision': triggerLabels.push('需要用户做决策'); break;
        case 'missing_info': triggerLabels.push('缺少关键信息'); break;
        case 'confirm': triggerLabels.push('需要用户确认'); break;
      }
    }
    if (triggerLabels.length > 0) {
      promptParts.push(
        `## 主动提问规则\n${triggerLabels.map((l) => `- 当${l}时，主动向用户提问`).join('\n')}\n- 每轮最多提问 ${askLimit} 次`,
      );
    }
  }

  const personaPrompt = promptParts.join('\n\n');

  // 能力声明：manifest 顶层 capabilities 直接派生（C2 后独立字段，不再从 skills 过滤）
  const capabilities: readonly RolePackCapability[] = pack.capabilities ?? [];

  return {
    meta: pack.meta,
    personaPrompt,
    skills: pack.skills,
    capabilities,
    strategy,
  };
}
