/**
 * 角色包行为策略解析器：集中管理行为策略的默认值、解析（resolve*）、合并与装配逻辑。
 */

// 召回保底下限默认值：跨层共享（role-pack 与 memory 均引用），SSOT 单一来源
import { DEFAULT_MIN_FALLBACK } from '@/utils/recallDefaults.js';
// 数值键上下限常量（SSOT）：validator 与 resolver 共用同一区间来源，越界值回退内核默认
import {
  MAX_ASK_LIMIT,
  MAX_LOOP_CONTINUE,
  MAX_MIN_FALLBACK,
  MAX_STEP_BUDGET,
  MAX_SUMMARY_FOCUS_LENGTH,
  MAX_TASK_LOOP_LIMIT,
  MAX_TOKEN_BUDGET,
  MAX_TOOL_STEP_LIMIT,
} from './strategyKeys.js';
import type {
  BehaviorStrategy,
  Handoff,
  MemoryRecallMode,
  ContextAssembly,
  ErrorHandling,
  InputInterrupt,
  ProviderRouting,
  MultiStepReasoning,
  SummaryRecall,
  ToolApproval,
  ToolReadonly,
  ToolMode,
  UnderstandingConfirm,
  RolePack,
  RolePackAssembly,
  RolePackCapability,
  Summary,
  L2RuntimeStrategy,
} from './types.js';
// 类型级引用（type-only，运行时无环）：resolveActiveStrategy 需读取激活角色包策略
import type { RolePackManager } from './rolePackManager.js';

// ════════════════════════════════════════════════════════════
// 默认值常量
// ════════════════════════════════════════════════════════════

/**
 * Token 预算内核默认值（SSOT 单一来源）。
 * 同时服务于三层：`DEFAULT_BEHAVIOR_STRATEGY.global.tokenBudget`（角色包声明层）、
 * `resolveTokenBudget` 的非法/缺失回退、`DEFAULT_L2_STRATEGY.tokenBudget`（loop 构造期惰性初始）。
 * 0 = 不限制。
 */
export const DEFAULT_TOKEN_BUDGET = 200_000;

/**
 * 步数预算内核默认值（SSOT 单一来源）。
 * 同时服务于三层：`DEFAULT_BEHAVIOR_STRATEGY.global.stepBudget`（角色包声明层）、
 * `resolveStepBudget` 的非法/缺失回退、`DEFAULT_L2_STRATEGY.stepBudget`（loop 构造期惰性初始）。
 * 软上限，配合 maxIterations 双重保护；0 = 不限制。
 */
export const DEFAULT_STEP_BUDGET = 50;

/**
 * 外部任务驱动循环步数上限内核默认值（SSOT 单一来源）。
 * 同时服务于三层：`DEFAULT_BEHAVIOR_STRATEGY.global.taskLoopLimit`（角色包声明层）、
 * `resolveTaskLoopLimit` 的非法/缺失回退。0 = 关闭外部任务驱动循环。
 */
export const DEFAULT_TASK_LOOP_LIMIT = 10;

/**
 * 记忆召回百分比 cap 内核默认值（SSOT 单一来源）。
 * 同时服务于 `DEFAULT_BEHAVIOR_STRATEGY.prepare.memoryRecallPercent`（角色包声明层）、
 * `resolveMemoryRecallPercent` 的非法/缺失回退。cap 非 quota：完整对话层无条件优先，
 * 记忆摘要层是剩余空间的拾遗填充，百分比只封顶防止记忆挤占对话。
 */
export const DEFAULT_MEMORY_RECALL_PERCENT = 0.4;

/**
 * 行为策略全局默认值——未配置的维度使用全局默认值，角色包只声明它想改变的部分。
 * const 断言确保类型推导为字面量值。
 */
export const DEFAULT_BEHAVIOR_STRATEGY: BehaviorStrategy = {
  prepare: {
    understandingConfirm: 'off',
    contextAssembly: 'hybrid',
    memoryRecall: 'full',
    memoryRecallPercent: DEFAULT_MEMORY_RECALL_PERCENT,
    summaryRecall: 'on',
    minFallback: DEFAULT_MIN_FALLBACK,
    summaryFocus: undefined, // undefined = 通用浓缩（角色包未声明时使用默认摘要策略）
    recallConfidence: 0.6,
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
    userFollowup: 'silent',
  },
  global: {
    tokenBudget: DEFAULT_TOKEN_BUDGET,
    stepBudget: DEFAULT_STEP_BUDGET,
    errorHandling: 'retry',
    askOn: ['ambiguity', 'decision', 'missing_info'],
    askLimit: 3,
    taskLoopLimit: DEFAULT_TASK_LOOP_LIMIT,
  },
} as const;

// ════════════════════════════════════════════════════════════
// 辅助函数
// ════════════════════════════════════════════════════════════

/**
 * 从角色包管理器推导当前激活的 L2 行为策略（SSOT 单一真理源）。
 *
 * 激活角色包策略优先，未激活/无管理器回退全局默认。本函数是「激活策略」推导的
 * 唯一实现，contextPreparer 与 seed 编排器经此统一取策略，杜绝跨模块镜像重复。
 *
 * @param rolePackManager 角色包管理器（可为 null）
 * @param override 宿主装配级策略覆盖（可选）：**压过角色包声明**，表达宿主产品能力边界。
 *  只影响 override 声明过的键（v0.13 后无内置示例键；自动匹配全链已移除，机制保留）。
 * @returns 当前激活行为策略（含装配级覆盖）
 */
export function resolveActiveStrategy(
  rolePackManager: RolePackManager | null,
  override?: Partial<BehaviorStrategy>,
): BehaviorStrategy {
  const base = rolePackManager?.getActive()?.strategy ?? DEFAULT_BEHAVIOR_STRATEGY;
  if (!override) return base;
  return {
    prepare: { ...base.prepare, ...override.prepare },
    act: { ...base.act, ...override.act },
    reflect: { ...base.reflect, ...override.reflect },
    global: { ...base.global, ...(override.global ?? {}) },
  };
}


/**
 * 枚举值合法性收窄（SSOT 兜底）：角色包 L2 键是枚举开关，非法拼写不应静默透传
 * （handoff 会直接 yield 给宿主，其他枚举会污染行为分支），统一归位到内核默认。
 */
function normalizeEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

// ════════════════════════════════════════════════════════════
// 策略解析函数 (resolve*)
// ════════════════════════════════════════════════════════════

/**
 * 解析衔接策略（SSOT）：非法值（非 wait/loop/end）归位 'wait'。
 * handoff 是唯一会作为 chunk 直接暴露给宿主的枚举，非法值必须归位，避免宿主收到无法识别的决策。
 */
export function resolveHandoff(strategy: BehaviorStrategy | undefined): Handoff {
  return normalizeEnum(strategy?.reflect?.handoff, ['wait', 'loop', 'end'], 'wait');
}

/** 解析记忆召回模式（SSOT）：非法值归位 'full' */
export function resolveMemoryRecallMode(strategy: BehaviorStrategy | undefined): MemoryRecallMode {
  return normalizeEnum(strategy?.prepare?.memoryRecall, ['full', 'limited', 'none'], 'full');
}

/** 解析召回保底下限（SSOT）：整数且 ∈ [0, MAX_MIN_FALLBACK] 才采用，缺失/越界回退以内置默认，置 0 彻底关闭保底 */
export function resolveMinFallback(strategy: BehaviorStrategy | undefined): number {
  const candidate = strategy?.prepare?.minFallback;
  const valid =
    typeof candidate === 'number' &&
    Number.isInteger(candidate) &&
    candidate >= 0 &&
    candidate <= MAX_MIN_FALLBACK;
  return valid ? candidate : DEFAULT_MIN_FALLBACK;
}

/**
 * 解析记忆召回百分比 cap（SSOT）：0.0~1.0 数值才采用，缺失/越界回退内核默认 0.4。
 * cap 非 quota：只封顶"记忆摘要层占剩余预算的上限百分比"，非法值不允许静默透传。
 */
export function resolveMemoryRecallPercent(strategy: BehaviorStrategy | undefined): number {
  const candidate = strategy?.prepare?.memoryRecallPercent;
  const valid = typeof candidate === 'number' && candidate >= 0 && candidate <= 1;
  return valid ? candidate : DEFAULT_MEMORY_RECALL_PERCENT;
}

/**
 * 解析角色包提炼视角（SSOT）：非空字符串且 ≤ MAX_SUMMARY_FOCUS_LENGTH 字符才采用，
 * 缺失/空白/超长回退 undefined（通用浓缩）。
 * 领域无关机制：内核只提供注入能力，视角全文由角色包提供；未声明时 round-summary 行为与现状一致（JSON 与 SummaryType 硬契约保留）。
 */
export function resolveSummaryFocus(strategy: BehaviorStrategy | undefined): string | undefined {
  const candidate = strategy?.prepare?.summaryFocus;
  return typeof candidate === 'string' &&
    candidate.trim().length > 0 &&
    candidate.length <= MAX_SUMMARY_FOCUS_LENGTH
    ? candidate.trim()
    : undefined;
}

/** 解析工具调用模式（SSOT）：非法值归位 'allow' */
export function resolveToolMode(strategy: BehaviorStrategy | undefined): ToolMode {
  return normalizeEnum(strategy?.act?.toolMode, ['allow', 'block'], 'allow');
}

/** 解析摘要生成开关（内核已消费）：非法值归位 'on' */
export function resolveSummary(strategy: BehaviorStrategy | undefined): Summary {
  return normalizeEnum(strategy?.reflect?.summary, ['on', 'off'], 'on');
}

/** 解析上下文装配策略（内核已消费）：非法值归位 'hybrid'——fixed=仅最近 N 轮 / query=仅语义召回 / hybrid=两者 */
export function resolveContextAssembly(strategy: BehaviorStrategy | undefined): ContextAssembly {
  return normalizeEnum(strategy?.prepare?.contextAssembly, ['fixed', 'query', 'hybrid'], 'hybrid');
}

/** 解析工具调用步数上限（内核已消费）：整数且 ∈ [0, MAX_TOOL_STEP_LIMIT] 才采用，非法/越界回退默认 0（不限制） */
export function resolveToolStepLimit(strategy: BehaviorStrategy | undefined): number {
  const candidate = strategy?.act?.toolStepLimit;
  // 合法值：0=无限制，1~MAX_TOOL_STEP_LIMIT=限制步数
  const valid =
    typeof candidate === 'number' &&
    Number.isInteger(candidate) &&
    candidate >= 0 &&
    candidate <= MAX_TOOL_STEP_LIMIT;
  return valid ? candidate : 0;
}

/** 解析错误处理策略（内核已消费）：非法值归位 'retry'——retry=自动重试 / degrade=降级文本 / stop=终止抛出错误 */
export function resolveErrorHandling(strategy: BehaviorStrategy | undefined): ErrorHandling {
  return normalizeEnum(strategy?.global?.errorHandling, ['retry', 'degrade', 'stop'], 'retry');
}

/**
 * 解析 Provider 路由策略（内核已消费）：非法值归位 'auto'——auto=按任务类型路由 / fixed=固定当前 Provider
 */
export function resolveProviderRouting(strategy: BehaviorStrategy | undefined): ProviderRouting {
  return normalizeEnum(strategy?.act?.providerRouting, ['auto', 'fixed'], 'auto');
}

/** 解析输入中断策略（内核已消费）：非法值归位 'allow'——allow=执行中可插话 / block=排队到下一轮 */
export function resolveInputInterrupt(strategy: BehaviorStrategy | undefined): InputInterrupt {
  return normalizeEnum(strategy?.act?.inputInterrupt, ['allow', 'block'], 'allow');
}

/** 解析 Token 预算上限（内核已消费）：整数且 ∈ [0, MAX_TOKEN_BUDGET] 才采用，非法/越界回退内核默认（DEFAULT_TOKEN_BUDGET，0=不限制） */
export function resolveTokenBudget(strategy: BehaviorStrategy | undefined): number {
  const candidate = strategy?.global?.tokenBudget;
  const valid =
    typeof candidate === 'number' &&
    Number.isInteger(candidate) &&
    candidate >= 0 &&
    candidate <= MAX_TOKEN_BUDGET;
  return valid ? candidate : DEFAULT_TOKEN_BUDGET;
}

/** 解析步数预算上限（内核已消费）：整数且 ∈ [0, MAX_STEP_BUDGET] 才采用，非法/越界回退内核默认（DEFAULT_STEP_BUDGET，软上限，配合 maxIterations 双重保护，0=不限制） */
export function resolveStepBudget(strategy: BehaviorStrategy | undefined): number {
  const candidate = strategy?.global?.stepBudget;
  const valid =
    typeof candidate === 'number' &&
    Number.isInteger(candidate) &&
    candidate >= 0 &&
    candidate <= MAX_STEP_BUDGET;
  return valid ? candidate : DEFAULT_STEP_BUDGET;
}

/** 解析外部任务驱动循环步数上限（外部任务循环已消费）：整数且 ∈ [0, MAX_TASK_LOOP_LIMIT] 才采用，非法/越界回退内核默认（DEFAULT_TASK_LOOP_LIMIT，0=关闭外部任务循环） */
export function resolveTaskLoopLimit(strategy: BehaviorStrategy | undefined): number {
  const candidate = strategy?.global?.taskLoopLimit;
  const valid =
    typeof candidate === 'number' &&
    Number.isInteger(candidate) &&
    candidate >= 0 &&
    candidate <= MAX_TASK_LOOP_LIMIT;
  return valid ? candidate : DEFAULT_TASK_LOOP_LIMIT;
}

/** 解析多步推理模式（内核已消费）：非法值归位 'auto'——auto=Provider 决定 / manual=强制快速回答 */
export function resolveMultiStepReasoning(
  strategy: BehaviorStrategy | undefined,
): MultiStepReasoning {
  return normalizeEnum(strategy?.act?.multiStepReasoning, ['auto', 'manual'], 'auto');
}

/**
 * 解析召回置信度阈值：非法值回退全局默认（DEFAULT_BEHAVIOR_STRATEGY.prepare.recallConfidence = 0.6）
 *
 * 控制语义召回的相似度过滤阈值：
 * - 0.0~1.0 浮点数，越大越严格
 * - 缺失/非法值回退全局默认，保证"非法即失效"归位一致（SSOT：与默认层引用同一常量）
 *
 * @param strategy 合并后的行为策略
 * @returns 合法的召回置信度阈值
 */
export function resolveRecallConfidence(strategy: BehaviorStrategy | undefined): number {
  const candidate = strategy?.prepare?.recallConfidence;
  const valid = typeof candidate === 'number' && candidate >= 0 && candidate <= 1;
  // 回退引用 DEFAULT 常量（而非独立字面量），避免默认值双写漂移
  return valid ? candidate : DEFAULT_BEHAVIOR_STRATEGY.prepare!.recallConfidence!;
}

/**
 * 解析摘要召回开关：非法值归位 'on'
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
 * 解析工具只读模式：非法值归位 'full'
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
 * 解析工具审批模式：非法值归位 'auto'
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

/**
 * 解析理解确认模式（内核已消费）：非法值归位 'off'
 * —— off=直接生成 / echo=复述用户意图但不等待 / confirm=预检复述并等待确认。
 * 消费点在 assembleRolePack，将模式转为 persona prompt 行为指令。
 */
export function resolveUnderstandingConfirm(strategy: BehaviorStrategy | undefined): UnderstandingConfirm {
  return normalizeEnum(strategy?.prepare?.understandingConfirm, ['off', 'echo', 'confirm'], 'off');
}

// ════════════════════════════════════════════════════════════
// L2 运行时策略（loop 运行态）装配
// ════════════════════════════════════════════════════════════

/**
 * L2 运行时策略默认值（loop 构造初始态）
 *
 * 与各 resolve* 的"非法/缺失回退"默认值保持一致——真正每轮生效值来自 resolveL2Strategy，
 * 本常量仅作 loop 构造期的惰性初始值（收敛，替代 loop 内 11 个字段初始化魔数）。
 */
export const DEFAULT_L2_STRATEGY: L2RuntimeStrategy = {
  toolCallsBlocked: false,
  maxSelfReviewRounds: 0,
  toolStepLimit: 0,
  errorHandling: 'retry',
  providerRouting: 'auto',
  inputInterrupt: 'allow',
  tokenBudget: DEFAULT_TOKEN_BUDGET,
  stepBudget: DEFAULT_STEP_BUDGET,
  multiStepReasoning: 'auto',
  toolReadonly: 'full',
  toolApproval: 'auto',
};

/**
 * 解析 L2 运行时策略（收敛：替代 Agent 层 11 处 setXxx 逐项装配）
 *
 * 聚合现有 10 个 resolveXxx（工具模式→toolCallsBlocked、工具步数、错误处理、Provider 路由、
 * 输入中断、Token/步数预算、多步推理、工具只读、工具审批）+ reflect.loopContinue；
 * 非法值经各 resolve* 归位内核默认；loopContinue 归一为「0=关闭 / 正整数=N 轮执行上限」。
 *
 * @param strategy 合并后的行为策略（角色包声明，可为空）
 * @returns 注入 AgentLoop 的单一运行时策略对象
 */
export function resolveL2Strategy(strategy: BehaviorStrategy | undefined): L2RuntimeStrategy {
  // loopContinue → 自审查轮数：整数且 ∈ [0, MAX_LOOP_CONTINUE] 才采用，否则关闭（0 轮）
  const loopContinue = strategy?.reflect?.loopContinue;
  const maxSelfReviewRounds =
    typeof loopContinue === 'number' &&
    Number.isInteger(loopContinue) &&
    loopContinue >= 0 &&
    loopContinue <= MAX_LOOP_CONTINUE
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
 * 同时根据策略中的 userFollowup/askOn/askLimit 注入主动提问指令到 persona prompt，
 * 并在指令中携带 [ASK] 输出格式契约（行首标记 + 行尾花括号选项，与 loop 解析器同源）。
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
    // askLimit 需 ∈ [1, MAX_ASK_LIMIT] 才注入 prompt，越界回退默认 3（防 LLM 指令注入失控次数）
    const rawAskLimit = strategy.global?.askLimit ?? 3;
    const askLimit =
      typeof rawAskLimit === 'number' &&
      Number.isInteger(rawAskLimit) &&
      rawAskLimit >= 1 &&
      rawAskLimit <= MAX_ASK_LIMIT
        ? rawAskLimit
        : 3;
    const triggerLabels: string[] = [];
    const triggers = Array.isArray(askOn) ? askOn : askOn ? [askOn] : [];
    for (const t of triggers) {
      switch (t) {
        case 'ambiguity':
          triggerLabels.push('遇到模糊不清的情况');
          break;
        case 'decision':
          triggerLabels.push('需要用户做决策');
          break;
        case 'missing_info':
          triggerLabels.push('缺少关键信息');
          break;
        case 'confirm':
          triggerLabels.push('需要用户确认');
          break;
      }
    }
    if (triggerLabels.length > 0) {
      promptParts.push(
        `## 主动提问规则\n${triggerLabels.map((l) => `- 当${l}时，主动向用户提问`).join('\n')}\n- 每轮最多提问 ${askLimit} 次\n- 提问用行首标记 \`[ASK]\` 开头（一题一行）；需给出可选项时，在问题行尾附花括号选项 \`{A|B|C}\`（全半角括号、竖线分隔均可）——系统据此暂停并等待你的回答`,
      );
    }
  }

  // 理解确认指令注入：understandingConfirm 非 off 时，将确认模式转为 LLM 行为指令
  const understandingConfirm = resolveUnderstandingConfirm(strategy);
  if (understandingConfirm !== 'off') {
    const confirmInstruction =
      understandingConfirm === 'echo'
        ? '回答前，先用一句话复述你对用户意图的理解（仅复述、不等待用户确认），再正式作答。'
        : '回答前，先用一句话复述你对用户意图的理解并向用户确认；待用户确认后再正式作答。';
    promptParts.push(`## 理解确认\n${confirmInstruction}`);
  }

  const personaPrompt = promptParts.join('\n\n');

  // 能力声明：manifest 顶层 capabilities 直接派生
  const capabilities: readonly RolePackCapability[] = pack.capabilities ?? [];

  return {
    meta: pack.meta,
    filePath: pack.filePath,
    personaPrompt,
    skills: pack.skills,
    capabilities,
    strategy,
    traits: pack.traits,
  };
}
