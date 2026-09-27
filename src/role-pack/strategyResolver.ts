/**
 * 角色包行为策略解析器：集中管理行为策略的默认值、解析（resolve*）、合并与装配逻辑。
 */

//  role-pack 与 memory 层均不持有召回保底（记忆纯工具化召回，无自动注入通道）。

// 数值键上下限常量（SSOT）：validator 与 resolver 共用同一区间来源，越界值回退内核默认
import {
  DEFAULT_MAX_ITERATIONS,
  ERROR_HANDLINGS,
  MAX_ASK_LIMIT,
  MAX_SELF_REVIEW_ROUNDS,
  MAX_STEP_BUDGET,
  MAX_SUMMARY_FOCUS_LENGTH,
  MAX_CONTEXT_LIMIT,
  MIN_CONTEXT_LIMIT,
  MIN_STEP_BUDGET,
  MAX_TOOL_STEP_LIMIT,
  MULTI_STEP_REASONINGS,
  PROVIDER_ROUTINGS,
  SUMMARY_MODES,
  TOOL_MODES,
  TOOL_READONLY_MODES,
} from './strategyKeys.js';
import type {
  BehaviorStrategy,
  ErrorHandling,
  ProviderRouting,
  MultiStepReasoning,
  ToolReadonly,
  ToolMode,
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

// ════════════════════════════════════════════════════════════
// 默认值常量（角色包层的兜底默认——角色包不声明时走这里，
// loop 构造时 opts.maxIterations 也用同一个 DEFAULT_MAX_ITERATIONS 源头对齐）
// ════════════════════════════════════════════════════════════

// 无记忆召回相关默认常量（memoryRecallPercent/recallConfidence 等）——记忆纯工具化召回，
// prepare 无自动注入消费端，策略层不解析召回参数。

/**
 * 行为策略全局默认值——未配置的维度使用全局默认值，角色包只声明它想改变的部分。
 * const 断言确保类型推导为字面量值。
 */
export const DEFAULT_BEHAVIOR_STRATEGY: BehaviorStrategy = {
  prepare: {
    summaryFocus: undefined, // undefined = 通用浓缩（角色包未声明时使用默认摘要策略）
  },
  act: {
    toolMode: 'allow',
    toolReadonly: 'full',
    toolStepLimit: 20,
    temperature: 0.7,
    outputLimit: 4096,
    providerRouting: 'auto',
    multiStepReasoning: 'auto',
  },
  reflect: {
    selfReview: 0,
    summary: 'on',
    userFollowup: 'silent',
  },
  global: {
    contextLimit: 0, // 0 = 不设额外上限（有效窗口 = provider 窗口）；非法/越界值同样回退 0
    // 0 或未声明 → 内核兜底 DEFAULT_MAX_ITERATIONS（无「不限步数」路径，符合防死循环设计）
    stepBudget: 0,
    errorHandling: 'retry',
    askOn: ['ambiguity', 'decision', 'missing_info'],
    askLimit: 10,
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
 *  只影响 override 声明过的键（无内置示例键；无自动匹配链，机制保留）。
 * @returns 当前激活行为策略（含装配级覆盖）
 */
export function resolveActiveStrategy(
  rolePackManager: RolePackManager | null,
  override?: Partial<BehaviorStrategy>,
): BehaviorStrategy {
  const base = rolePackManager?.getActive()?.strategy ?? DEFAULT_BEHAVIOR_STRATEGY;
  // 合并逻辑复用 mergeStrategy（单一 SSOT）——消解与通用合并的两处手写同形实现（双轨漂移隐患）
  return mergeStrategy(base, override);
}

/**
 * 枚举值合法性收窄（SSOT 兜底）：角色包 L2 键是枚举开关，非法拼写不应静默透传
 * （非法枚举会污染行为分支或注入 persona prompt），统一归位到内核默认。
 */
function normalizeEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

// ════════════════════════════════════════════════════════════
// 策略解析函数 (resolve*)
// ════════════════════════════════════════════════════════════

// 无自动注入召回解析函数（键族不存在，见 types.ts 文件头注）。

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

/** 解析工具调用模式（SSOT）：非法值归位 'allow'（白名单引用 strategyKeys.TOOL_MODES，防漂移） */
export function resolveToolMode(strategy: BehaviorStrategy | undefined): ToolMode {
  return normalizeEnum(strategy?.act?.toolMode, TOOL_MODES, 'allow');
}

/** 解析摘要生成开关（内核已消费）：非法值归位 'on'（白名单引用 strategyKeys.SUMMARY_MODES） */
export function resolveSummary(strategy: BehaviorStrategy | undefined): Summary {
  return normalizeEnum(strategy?.reflect?.summary, SUMMARY_MODES, 'on');
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

/** 解析错误处理策略（内核已消费）：非法值归位 'retry'（白名单引用 strategyKeys.ERROR_HANDLINGS）——retry=自动重试 / degrade=降级文本 / stop=终止抛出错误 */
export function resolveErrorHandling(strategy: BehaviorStrategy | undefined): ErrorHandling {
  return normalizeEnum(strategy?.global?.errorHandling, ERROR_HANDLINGS, 'retry');
}

/**
 * 解析 Provider 路由策略（内核已消费）：非法值归位 'auto'（白名单引用 strategyKeys.PROVIDER_ROUTINGS）——auto=按任务类型路由 / fixed=固定当前 Provider
 */
export function resolveProviderRouting(strategy: BehaviorStrategy | undefined): ProviderRouting {
  return normalizeEnum(strategy?.act?.providerRouting, PROVIDER_ROUTINGS, 'auto');
}

/**
 * 解析主动提问次数上限（内核已消费）：整数且 ∈ [1, MAX_ASK_LIMIT] 才采用，缺失/越界回退默认 10。
 * ask_user 工具的 turn 粒度硬护栏取值（SSOT：assembleRolePack 的 prompt 引导与 loop 拦截共用）。
 */
export function resolveAskLimit(strategy: BehaviorStrategy | undefined): number {
  const candidate = strategy?.global?.askLimit;
  const valid =
    typeof candidate === 'number' &&
    Number.isInteger(candidate) &&
    candidate >= 1 &&
    candidate <= MAX_ASK_LIMIT;
  // 非法/缺失回退到 DEFAULT_BEHAVIOR_STRATEGY 的 askLimit（SSOT 单点：不再硬编码 3）
  return valid ? candidate : DEFAULT_BEHAVIOR_STRATEGY.global!.askLimit!;
}

/**
 * 解析角色包上下文上限。合法 = `0`（不设额外上限）或整数 ∈ [MIN_CONTEXT_LIMIT, MAX_CONTEXT_LIMIT]；
 * 其余（未声明 / 越界 / 小数 / 非数）→ 0（不设额外上限，有效窗口 = provider 窗口）。
 */
export function resolveContextLimit(strategy: BehaviorStrategy | undefined): number {
  const candidate = strategy?.global?.contextLimit;
  const valid =
    typeof candidate === 'number' &&
    Number.isInteger(candidate) &&
    (candidate === 0 || (candidate >= MIN_CONTEXT_LIMIT && candidate <= MAX_CONTEXT_LIMIT));
  return valid ? candidate : 0;
}

/** 解析步数预算：0 或未声明 → DEFAULT_MAX_ITERATIONS 兜底；stepBudget ∈ {0} ∪ [MIN_STEP_BUDGET, MAX_STEP_BUDGET]
 * 按声明采用（与 validator 区间同一来源，防双轨镜像）。不存在「不限步数」路径——0 在 loop 侧等同未声明（effectiveMax 取 maxIterations 兜底）。 */
export function resolveStepBudget(strategy: BehaviorStrategy | undefined): number {
  const candidate = strategy?.global?.stepBudget;
  const valid =
    typeof candidate === 'number' &&
    Number.isInteger(candidate) &&
    (candidate === 0 || (candidate >= MIN_STEP_BUDGET && candidate <= MAX_STEP_BUDGET));
  return valid ? candidate : DEFAULT_MAX_ITERATIONS;
}

/** 解析多步推理模式（内核已消费）：非法值归位 'auto'（白名单引用 strategyKeys.MULTI_STEP_REASONINGS）——auto=Provider 决定 / manual=强制快速回答 */
export function resolveMultiStepReasoning(
  strategy: BehaviorStrategy | undefined,
): MultiStepReasoning {
  return normalizeEnum(strategy?.act?.multiStepReasoning, MULTI_STEP_REASONINGS, 'auto');
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
  return normalizeEnum(strategy?.act?.toolReadonly, TOOL_READONLY_MODES, 'full');
}

// ════════════════════════════════════════════════════════════
// L2 运行时策略（loop 运行态）装配
// ════════════════════════════════════════════════════════════

/**
 * L2 运行时策略默认值（loop 构造初始态）
 *
 * 由 `resolveL2Strategy(undefined)` 单一推导（SSOT）：不再手动复述各 resolve* 的回退默认值，
 * 避免"回退规则改了、此处疏漏不同步"的二次写入点。真正每轮生效值来自 resolveL2Strategy，
 * 本常量仅作 loop 构造期的惰性初始值（单一初值入口，免逐字段初始化魔数）。
 */
export const DEFAULT_L2_STRATEGY: L2RuntimeStrategy = resolveL2Strategy(undefined);

/**
 * 解析 L2 运行时策略（Agent 层单一装配入口，免逐项 setXxx）
 *
 * 聚合现有各 resolveXxx（工具模式→toolCallsBlocked、工具步数、错误处理、Provider 路由、
 * Token/步数预算、多步推理、主动提问上限、工具只读）+ reflect.selfReview；
 * 非法值经各 resolve* 归位内核默认；selfReview 归一为布尔数字「0=关闭 / 正整数 >0 归一为 1」。
 *
 * @param strategy 合并后的行为策略（角色包声明，可为空）
 * @returns 注入 AgentLoop 的单一运行时策略对象
 */
export function resolveL2Strategy(strategy: BehaviorStrategy | undefined): L2RuntimeStrategy {
  // selfReview → 布尔数字语义：0=关闭；正整数>0 一律归一为 1=自审查一次，
  // 大于 1 的数同样算作 1（类似布尔开关）。越界（负/小数/非 number/>MAX）归 0=关闭。
  const rawSelfReview = strategy?.reflect?.selfReview;
  const selfReviewEnabled =
    typeof rawSelfReview === 'number' &&
    Number.isInteger(rawSelfReview) &&
    rawSelfReview > 0 &&
    rawSelfReview <= MAX_SELF_REVIEW_ROUNDS;
  return {
    toolCallsBlocked: resolveToolMode(strategy) === 'block',
    selfReviewEnabled,
    toolStepLimit: resolveToolStepLimit(strategy),
    errorHandling: resolveErrorHandling(strategy),
    providerRouting: resolveProviderRouting(strategy),
    contextLimit: resolveContextLimit(strategy),
    stepBudget: resolveStepBudget(strategy),
    multiStepReasoning: resolveMultiStepReasoning(strategy),
    askLimit: resolveAskLimit(strategy),
    toolReadonly: resolveToolReadonly(strategy),
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
  override: Partial<BehaviorStrategy> | undefined,
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
 * 引导 LLM 使用 ask_user 内置工具提问（答案以 tool result 回填）。
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

  // 主动提问指令注入：userFollowup=ask 时，将 askOn/askLimit 转为 LLM 指令。
  // 提问通道 = ask_user 内置工具（对齐 Claude Code AskUserQuestion 机制）：
  // 提问 = 一次普通工具调用，用户答案以 tool result 回填。
  if (strategy.reflect?.userFollowup === 'ask') {
    const askOn = strategy.global?.askOn;
    // askLimit 取值收敛到 resolveAskLimit（SSOT：prompt 引导与 loop 拦截共用同一解析）
    const askLimit = resolveAskLimit(strategy);
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
        `## 主动提问规则\n${triggerLabels.map((l) => `- 当${l}时，主动向用户提问`).join('\n')}\n- 每次回答中最多提问 ${askLimit} 次（按一次用户输入计，turn 粒度防打扰）\n- 提问必须调用 ask_user 工具（参数：question 问题文本 + 可选 options 选项数组/allowCustom 是否允许自定义回答）——系统据此在 step 边界暂停等你的回答，用户答案会作为工具结果返回给你`,
      );
    }
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
