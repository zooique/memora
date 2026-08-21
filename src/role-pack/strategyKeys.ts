/**
 * 策略键名 SSOT：集中定义角色包策略键名，rolePackManager 与 validator 改一处即可（validator 依赖它校验未知键）。
 */

/**
 * 单策略键规则：枚举（enum）或断言（check）。角色包对策略维度只"选择"不"定义，
 * 故枚举外取值是 error（机器可判读）而非忽略。
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

/** 温度断言：0.0~2.0（act.temperature） */
export function isTemperature(value: unknown): boolean {
  return typeof value === 'number' && value >= 0 && value <= 2;
}

/** 召回置信度断言：0.0~1.0（recallConfidence） */
export function isRecallConfidence(value: unknown): boolean {
  return typeof value === 'number' && value >= 0 && value <= 1;
}

/** 非空字符串断言（summaryFocus） */
export function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/** askOn 断言：单枚举或元素∈四枚举的数组（可组合） */
export function isAskOn(value: unknown): boolean {
  const ASK_TRIGGERS: ReadonlySet<string> = new Set([
    'ambiguity',
    'decision',
    'missing_info',
    'confirm',
  ]);
  if (typeof value === 'string') return ASK_TRIGGERS.has(value);
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((v) => typeof v === 'string' && ASK_TRIGGERS.has(v))
  );
}

/**
 * L2 策略键集：camelCase 统一命名。无标注 = 冻结（memora 真实消费）；
 * [草案] = 尚无消费，保留征集验证。只有被消费的键保留在校验器；未知键 validator 报 warning。
 */
export const STRATEGY_KEY_RULES: Readonly<Record<string, Readonly<Record<string, KeyRule>>>> = {
  prepare: {
    recentRounds: { kind: 'check', check: isPositiveInt },
    memoryRecall: { kind: 'enum', values: ['full', 'limited', 'none'] },
    // 由实现提炼进标准、memora 真实消费的键
    memoryRecallQuota: { kind: 'check', check: isPositiveInt },
    minFallback: { kind: 'check', check: isNonNegativeInt },
    // 领域无关机制，内容由角色包提供
    summaryFocus: { kind: 'check', check: isNonEmptyString },
    contextAssembly: { kind: 'enum', values: ['fixed', 'query', 'hybrid'] },
    autoSwitch: { kind: 'enum', values: ['on', 'off'] },
    recallConfidence: { kind: 'check', check: isRecallConfidence },
    summaryRecall: { kind: 'enum', values: ['on', 'off'] },
  },
  act: {
    toolMode: { kind: 'enum', values: ['allow', 'block'] },
    // 角色包可控温度/输出长度/流式
    temperature: { kind: 'check', check: isTemperature },
    outputLimit: { kind: 'check', check: isPositiveInt },
    streaming: { kind: 'enum', values: ['streaming', 'non-streaming'] },
    // 工具步数上限（0=无限制）
    toolStepLimit: { kind: 'check', check: isNonNegativeInt },
    providerRouting: { kind: 'enum', values: ['auto', 'fixed'] },
    inputInterrupt: { kind: 'enum', values: ['allow', 'block'] },
    multiStepReasoning: { kind: 'enum', values: ['auto', 'manual'] },
    toolReadonly: { kind: 'enum', values: ['full', 'readonly'] },
    toolApproval: { kind: 'enum', values: ['auto', 'confirm'] },
  },
  reflect: {
    summary: { kind: 'enum', values: ['on', 'off'] },
    handoff: { kind: 'enum', values: ['wait', 'loop', 'end'] },
    loopContinue: { kind: 'check', check: isNonNegativeInt },
    userFollowup: { kind: 'enum', values: ['ask', 'silent'] },
  },
  global: {
    askOn: { kind: 'check', check: isAskOn },
    askLimit: { kind: 'check', check: isPositiveInt },
    errorHandling: { kind: 'enum', values: ['retry', 'degrade', 'stop'] },
    tokenBudget: { kind: 'check', check: isNonNegativeInt },
    stepBudget: { kind: 'check', check: isNonNegativeInt },
    taskLoopLimit: { kind: 'check', check: isNonNegativeInt },
  },
};
