/**
 * 策略键名 SSOT (Single Source of Truth)
 *
 * 集中管理角色包策略键名的定义、别名映射和校验规则。
 * 旨在解决 rolePackManager.ts 和 validator.ts 中策略键名定义分散的问题，
 * 确保新增或修改策略键时只需修改一处。
 */

// ══════════════════════════════════════════════════════════════
// 1. 策略键别名映射 (Legacy Aliases)
// ══════════════════════════════════════════════════════════════

/**
 * L2 策略键别名映射（旧实现键 → 标准键，role-pack-spec §六 命名归标准）
 *
 * 存量 manifest 若误写私有键名 act.toolCalls / reflect.endingHandoff，
 * 装载时自动映射到标准键 + warn 提示（平滑兼容，不阻塞装载）。
 */
export const STRATEGY_KEY_ALIASES: Readonly<Record<string, string>> = {
  'act.toolCalls': 'act.toolMode',
  'reflect.endingHandoff': 'reflect.handoff',
};

// ══════════════════════════════════════════════════════════════
// 2. 校验规则辅助类型与函数 (Validation Helpers)
// ══════════════════════════════════════════════════════════════

/**
 * 单策略键规则：枚举值集合（enum）或断言函数（check）
 *
 * 设计：角色包对策略维度只"选择"不"定义"（types.ts 设计纪律），
 * 因此枚举外取值是 error（机器可判读），而非忽略。
 */
export type KeyRule =
  | { readonly kind: 'enum'; readonly values: readonly unknown[] }
  | { readonly kind: 'check'; readonly check: (value: unknown) => boolean };

/** 正整数断言（recentRounds / askLimit） */
export function isPositiveInt(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/** 非负整数断言（loopContinue，0=关闭自审查） */
export function isNonNegativeInt(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** 温度断言：0.0~2.0 数字（act.temperature） */
export function isTemperature(value: unknown): boolean {
  return typeof value === 'number' && value >= 0 && value <= 2;
}

/** 召回置信度断言：0.0~1.0 浮点数（recallConfidence 语义召回相似度阈值） */
export function isRecallConfidence(value: unknown): boolean {
  return typeof value === 'number' && value >= 0 && value <= 1;
}

/** 非空字符串断言（summaryFocus 提炼视角，空白视为未声明） */
export function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/** askOn 断言：单枚举字符串 或 元素∈四枚举的数组（可组合，§六） */
export function isAskOn(value: unknown): boolean {
  const ASK_TRIGGERS: ReadonlySet<string> = new Set([
    'ambiguity', 'decision', 'missing_info', 'confirm',
  ]);
  if (typeof value === 'string') return ASK_TRIGGERS.has(value);
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((v) => typeof v === 'string' && ASK_TRIGGERS.has(v))
  );
}

// ══════════════════════════════════════════════════════════════
// 3. 策略键校验规则 (Strategy Key Validation Rules)
// ══════════════════════════════════════════════════════════════

/**
 * L2 策略键集（role-pack-spec §六 v1 最小集 + P0 提炼键，camelCase 统一命名）
 *
 * 状态标注（P0 键集对齐 2026-08-12）：无标注 = 冻结（memora 真实消费）；
 * `[草案]` = 尚无参考实现消费，保留以征集验证（spec §五 双闸门演进，仍校验语法但语义不承诺一致）
 * 注意：只有被消费的键才保留在校验器中；草案键由类型接口承载，validator 对未知键报 warning
 */
export const STRATEGY_KEY_RULES: Readonly<Record<string, Readonly<Record<string, KeyRule>>>> = {
  prepare: {
    recentRounds: { kind: 'check', check: isPositiveInt },
    memoryRecall: { kind: 'enum', values: ['full', 'limited', 'none'] },
    // P0 键集对齐（2026-08-12）：由实现提炼进标准的键（memora 真实消费，spec §六 提炼行）
    memoryRecallQuota: { kind: 'check', check: isPositiveInt },
    minFallback: { kind: 'check', check: isNonNegativeInt },
    // P1 提炼键（2026-08-16 结构化保真，structured-fidelity）：领域无关机制，内容由角色包提供
    summaryFocus: { kind: 'check', check: isNonEmptyString },
    // Tier 2 开启（2026-08-18）：上下文装配策略
    contextAssembly: { kind: 'enum', values: ['fixed', 'query', 'hybrid'] },
    // Tier 3 开启（2026-08-18）：角色自动匹配开关
    autoSwitch: { kind: 'enum', values: ['on', 'off'] },
    // Phase 2 开启（2026-08-18）：召回置信度阈值（0.0-1.0 浮点数）
    recallConfidence: { kind: 'check', check: isRecallConfidence },
    // Phase 2 开启（2026-08-18）：摘要召回开关
    summaryRecall: { kind: 'enum', values: ['on', 'off'] },
  },
  act: {
    toolMode: { kind: 'enum', values: ['allow', 'block'] },
    // Tier 1 开启（2026-08-18）：角色包可控温度、输出长度、流式模式
    temperature: { kind: 'check', check: isTemperature },
    outputLimit: { kind: 'check', check: isPositiveInt },
    streaming: { kind: 'enum', values: ['streaming', 'non-streaming'] },
    // Tier 2 开启（2026-08-18）：工具步数上限（0=无限制，N>0 限制单轮工具步数）
    toolStepLimit: { kind: 'check', check: isNonNegativeInt },
    // Tier 3 开启（2026-08-18）：Provider 路由策略
    providerRouting: { kind: 'enum', values: ['auto', 'fixed'] },
    // Tier 3 开启（2026-08-18）：输入中断策略
    inputInterrupt: { kind: 'enum', values: ['allow', 'block'] },
    // Phase 1 开启（2026-08-18）：多步推理模式
    multiStepReasoning: { kind: 'enum', values: ['auto', 'manual'] },
    // Phase 3 开启（2026-08-18）：工具只读模式
    toolReadonly: { kind: 'enum', values: ['full', 'readonly'] },
    // Phase 3 开启（2026-08-18）：工具审批模式
    toolApproval: { kind: 'enum', values: ['auto', 'confirm'] },
  },
  reflect: {
    // Tier 1 开启（2026-08-18）：角色包可控摘要开关
    summary: { kind: 'enum', values: ['on', 'off'] },
    handoff: { kind: 'enum', values: ['wait', 'loop', 'end'] },
    loopContinue: { kind: 'check', check: isNonNegativeInt },
    userFollowup: { kind: 'enum', values: ['ask', 'silent'] },
    // Phase 1 开启（2026-08-18）：记忆写入模式
    memoryWrite: { kind: 'enum', values: ['auto', 'confirm'] },
    // Phase 1 开启（2026-08-18）：会话归档模式
    sessionArchive: { kind: 'enum', values: ['auto', 'manual'] },
  },
  global: {
    askOn: { kind: 'check', check: isAskOn },
    askLimit: { kind: 'check', check: isPositiveInt },
    // Tier 2 开启（2026-08-18）：错误处理策略
    errorHandling: { kind: 'enum', values: ['retry', 'degrade', 'stop'] },
    // Tier 3 开启（2026-08-18）：Token 预算上限
    tokenBudget: { kind: 'check', check: isNonNegativeInt },
    // Tier 3 开启（2026-08-18）：步数预算上限
    stepBudget: { kind: 'check', check: isNonNegativeInt },
  },
};
