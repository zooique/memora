/**
 * 角色包行为策略解析器：集中管理行为策略的默认值、解析（resolve*）、合并与装配逻辑。
 */

//  召回保底下限默认值（原 DEFAULT_MIN_FALLBACK）随阶段2 策略键族退役，且该常量本身已随
//  `recall()` 召回编排于 2026-09-10 剪枝中删除——role-pack 与 memory 层现均不持有召回保底；

// 数值键上下限常量（SSOT）：validator 与 resolver 共用同一区间来源，越界值回退内核默认
import {
  DEFAULT_MAX_ITERATIONS,
  MAX_ASK_LIMIT,
  MAX_SELF_REVIEW_ROUNDS,
  MAX_STEP_BUDGET,
  MAX_SUMMARY_FOCUS_LENGTH,
  MAX_TOKEN_BUDGET,
  MAX_TOOL_STEP_LIMIT,
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

/**
 * Token 预算缺省回退值。角色包 tokenBudget 不合法/越界时使用。
 * 80_000 ≤ AGENT_CONSTANTS.DEFAULT_MAX_CONTEXT_TOKENS=120_000（Provider 硬墙），
 * 保证软预算检查能真的在硬墙之前触发——200K 方向错误（永远触不到）。
 */
const FALLBACK_TOKEN_BUDGET = 80_000;

// 记忆召回相关默认常量（DEFAULT_MEMORY_RECALL_PERCENT 等）随阶段2 召回策略键族退役：
// 记忆纯工具化召回后 prepare 无自动注入消费端，memoryRecallPercent/recallConfidence 等不再由策略层解析。

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
    tokenBudget: 0, // 0 = 不限制（软闸不触发）；FALLBACK_TOKEN_BUDGET 仅兜底非法/越界值
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

// 自动注入召回 6 键解析函数（resolveMemoryRecallMode/resolveMinFallback/resolveMemoryRecallPercent/
// resolveContextAssembly/resolveRecallConfidence/resolveSummaryRecall）随阶段2 键族退役——记忆纯工具化
// 召回后 prepare 无自动注入消费端，解析全链（types/strategyKeys/resolver/validator）同步移除。

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

/** 解析 Token 预算：角色包 tokenBudget 合法（整数 ∈ [0, MAX_TOKEN_BUDGET]）则采用，否则回退 FALLBACK_TOKEN_BUDGET。0=不限制。 */
export function resolveTokenBudget(strategy: BehaviorStrategy | undefined): number {
  const candidate = strategy?.global?.tokenBudget;
  const valid =
    typeof candidate === 'number' &&
    Number.isInteger(candidate) &&
    candidate >= 0 &&
    candidate <= MAX_TOKEN_BUDGET;
  return valid ? candidate : FALLBACK_TOKEN_BUDGET;
}

/** 解析步数预算：0 或未声明 → DEFAULT_MAX_ITERATIONS 兜底；stepBudget ∈ [MIN_STEP_BUDGET, MAX_STEP_BUDGET]
 * 按声明采用。不存在「不限步数」路径——0 在 loop 侧等同未声明（effectiveMax 取 maxIterations 兜底）。 */
export function resolveStepBudget(strategy: BehaviorStrategy | undefined): number {
  const candidate = strategy?.global?.stepBudget;
  const valid =
    typeof candidate === 'number' &&
    Number.isInteger(candidate) &&
    candidate >= 0 &&
    candidate <= MAX_STEP_BUDGET;
  return valid ? candidate : DEFAULT_MAX_ITERATIONS;
}

/** 解析多步推理模式（内核已消费）：非法值归位 'auto'——auto=Provider 决定 / manual=强制快速回答 */
export function resolveMultiStepReasoning(
  strategy: BehaviorStrategy | undefined,
): MultiStepReasoning {
  return normalizeEnum(strategy?.act?.multiStepReasoning, ['auto', 'manual'], 'auto');
}

/**
 * 解析召回置信度阈值（recallConfidence）与摘要召回开关（summaryRecall）随阶段2 键族退役——
 * 记忆纯工具化召回后由 memory_search 工具语义通道天然承载，prepare 无消费端，此处不再解析。
 *
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

// ════════════════════════════════════════════════════════════
// L2 运行时策略（loop 运行态）装配
// ════════════════════════════════════════════════════════════

/**
 * L2 运行时策略默认值（loop 构造初始态）
 *
 * 由 `resolveL2Strategy(undefined)` 单一推导（SSOT）：不再手动复述各 resolve* 的回退默认值，
 * 避免"回退规则改了、此处疏漏不同步"的二次写入点。真正每轮生效值来自 resolveL2Strategy，
 * 本常量仅作 loop 构造期的惰性初始值（收敛，替代 loop 内 11 个字段初始化魔数）。
 */
export const DEFAULT_L2_STRATEGY: L2RuntimeStrategy = resolveL2Strategy(undefined);

/**
 * 解析 L2 运行时策略（收敛：替代 Agent 层逐项 setXxx 装配）
 *
 * 聚合现有各 resolveXxx（工具模式→toolCallsBlocked、工具步数、错误处理、Provider 路由、
 * Token/步数预算、多步推理、主动提问上限、工具只读）+ reflect.selfReview；
 * 非法值经各 resolve* 归位内核默认；selfReview 归一为布尔数字「0=关闭 / 正整数 >0 收敛为 1」。
 *
 * @param strategy 合并后的行为策略（角色包声明，可为空）
 * @returns 注入 AgentLoop 的单一运行时策略对象
 */
export function resolveL2Strategy(strategy: BehaviorStrategy | undefined): L2RuntimeStrategy {
  // selfReview → 布尔数字语义（2026-09-12 定案）：0=关闭；正整数>0 一律收敛为 1=自审查一次，
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
    tokenBudget: resolveTokenBudget(strategy),
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
