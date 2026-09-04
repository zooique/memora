/**
 * 策略键名 SSOT：集中定义角色包策略键名，rolePackManager 与 validator 改一处即可（validator 依赖它校验未知键）。
 *
 * 区间纪律：所有"开放给角色包填写的数值键"都必须有上下限（防呆防滥用），由内核统一控制——
 * 下限防负值/零值语义错误，上限防资源失控（token/步数/轮数）或业务荒谬值。
 * 区间常量在此集中定义（SSOT），validator（校验报错）与 resolver（越界回退默认）共用同一来源。
 */

/**
 * 单策略键规则：枚举（enum）或断言（check）。角色包对策略维度只"选择"不"定义，
 * 故枚举外取值是 error（机器可判读）而非忽略。
 */
export type KeyRule =
  | { readonly kind: 'enum'; readonly values: readonly unknown[] }
  | {
      readonly kind: 'check';
      readonly check: (value: unknown) => boolean;
      /** 数值区间元数据（仅 check 且为数值键时存在）：供 validator 报错信息展示区间，与 check 同源派生不双写 */
      readonly range?: { readonly min: number; readonly max: number };
    };

// ════════════════════════════════════════════════════════════
// 数值键上下限常量（SSOT 单一来源：validator + resolver + 文档共用）
// 上界选值原则：宽松防呆而非限制能力——覆盖真实使用上限即可，杜绝无条件填写导致的资源失控
//
// stepBudget 三层设计：
//   DEFAULT_MAX_ITERATIONS=50 → 内核兜底（loop.maxIterations 默认值 + resolveStepBudget 缺省回退）
//   MIN_STEP_BUDGET=10 / MAX_STEP_BUDGET=500 → 角色包声明合法区间（validator 拦截越界）
//   角色包配 stepBudget → loop.runIterationLoop 动态计算 effectiveMax，配多少给多少
// ════════════════════════════════════════════════════════════

/**
 * 内核兜底迭代上限（SSOT 单一来源）。
 *
 * 定义位置：role-pack 策略边界层——agent/loop.ts 的 maxIterations 默认值引用这里，
 * resolveStepBudget 缺省回退也引用这里。agent→role-pack 单向依赖，方向正确。
 *
 * 业界参考：LangGraph=25, Claude Code=25-50, CrewAI=25。
 * 迭代 = 一次 LLM call + N 并行工具。50 足以覆盖复杂多步任务。
 */
export const DEFAULT_MAX_ITERATIONS = 50;

/** 召回保底下限条数上限：语义召回不足时补足至该条数，100 已远高于任何真实记忆补足需求 */
export const MAX_MIN_FALLBACK = 100;
/** 单轮回答长度上限（token）：65536 覆盖当前所有模型 max_tokens 能力上限 */
export const MAX_OUTPUT_LIMIT = 65536;
/** 单轮工具调用步数上限：100 步足够复杂任务单轮调用 */
export const MAX_TOOL_STEP_LIMIT = 100;
/** 自审查轮数上限：LLM 纯文本回复后自动审查，10 轮已是极端场景 */
export const MAX_SELF_REVIEW_ROUNDS = 10;
/** 主动提问次数上限：按一次用户输入（turn 粒度）计，10 次防打扰失控 */
export const MAX_ASK_LIMIT = 10;
/** 每轮总 token 预算上限：1_000_000 覆盖 1M 上下文窗口（mimo-v2.5-pro 等旗舰模型） */
export const MAX_TOKEN_BUDGET = 1_000_000;
/** 步数预算声明下限：角色包 stepBudget 不得低于 10，低于此视为越界回退默认值 */
export const MIN_STEP_BUDGET = 10;
/**
 * 步数预算声明上限：角色包可自由声明 0~500 之间的 stepBudget。
 * 角色作者想让这个角色跑得久就配大值，想保守就配小值。
 * 角色包不声明 stepBudget 时，resolveStepBudget 回退 DEFAULT_MAX_ITERATIONS。
 * loop 运行时由 opts.maxIterations 传入覆盖——角色包声明多少给多少，内核只兜底默认。
 */
export const MAX_STEP_BUDGET = 500;
/** 外部任务驱动循环步数上限：任务表每步一个闭环，100 步防死循环烧 token */
export const MAX_TASK_LOOP_LIMIT = 100;
/** 提炼视角（summaryFocus）字符串长度上限（字符）：防止巨型字符串注入 prompt */
export const MAX_SUMMARY_FOCUS_LENGTH = 500;

/**
 * 整数区间断言工厂：生成「整数且 ∈ [min, max]」的 check 规则。
 * 同时返回 range 元数据，validator 据此拼出可读的越界错误消息——区间单点定义，无第二处副本。
 */
function intRange(min: number, max: number): KeyRule & { readonly kind: 'check' } {
  return {
    kind: 'check',
    check: (value) =>
      typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max,
    range: { min, max },
  };
}

/** 百分比断言：0.0~1.0（memoryRecallPercent，cap 非 quota） */
export function isPercent(value: unknown): boolean {
  return typeof value === 'number' && value >= 0 && value <= 1;
}

/** 温度断言：0.0~2.0（act.temperature） */
export function isTemperature(value: unknown): boolean {
  return typeof value === 'number' && value >= 0 && value <= 2;
}

/** 召回置信度断言：0.0~1.0（recallConfidence） */
export function isRecallConfidence(value: unknown): boolean {
  return typeof value === 'number' && value >= 0 && value <= 1;
}

/** 提炼视角长度断言：非空字符串且 ≤ MAX_SUMMARY_FOCUS_LENGTH 字符（防巨型注入） */
export function isSummaryFocus(value: unknown): boolean {
  return (
    typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_SUMMARY_FOCUS_LENGTH
  );
}

/** askOn 断言：单枚举或元素∈四枚举的数组（可组合）；数组长度 ≤ 枚举数（防重复堆叠） */
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
    // 数量上限：可组合触发项最多 4 个（去重后），防重复堆叠膨胀 prompt 注入指令
    value.length <= ASK_TRIGGERS.size &&
    value.every((v) => typeof v === 'string' && ASK_TRIGGERS.has(v))
  );
}

/**
 * L2 策略键集：camelCase 统一命名。无标注 = 冻结（memora 真实消费）；
 * [草案] = 尚无消费，保留征集验证。只有被消费的键保留在校验器；未知键 validator 报 warning。
 * 数值键全部带上下限（intRange）：下限防语义错误，上限防资源失控（SSOT 区间常量见文件头）。
 */
export const STRATEGY_KEY_RULES: Readonly<Record<string, Readonly<Record<string, KeyRule>>>> = {
  prepare: {
    memoryRecall: { kind: 'enum', values: ['full', 'limited', 'none'] },
    // 理解确认模式（内核已消费：assembleRolePack 注入 persona prompt 行为指令）
    understandingConfirm: { kind: 'enum', values: ['off', 'echo', 'confirm'] },
    // 记忆召回百分比 cap（0.0~1.0，cap 非 quota；取代旧绝对 token 配额语义）
    memoryRecallPercent: { kind: 'check', check: isPercent, range: { min: 0, max: 1 } },
    // 召回保底下限（0~MAX_MIN_FALLBACK 条，0=关闭）
    minFallback: intRange(0, MAX_MIN_FALLBACK),
    // 领域无关机制，内容由角色包提供（≤ MAX_SUMMARY_FOCUS_LENGTH 字符）
    summaryFocus: { kind: 'check', check: isSummaryFocus, range: { min: 1, max: MAX_SUMMARY_FOCUS_LENGTH } },
    contextAssembly: { kind: 'enum', values: ['fixed', 'query', 'hybrid'] },
    recallConfidence: { kind: 'check', check: isRecallConfidence, range: { min: 0, max: 1 } },
    summaryRecall: { kind: 'enum', values: ['on', 'off'] },
  },
  act: {
    toolMode: { kind: 'enum', values: ['allow', 'block'] },
    // 角色包可控温度（0.0~2.0）/输出长度（1~MAX_OUTPUT_LIMIT token）/流式
    temperature: { kind: 'check', check: isTemperature, range: { min: 0, max: 2 } },
    outputLimit: intRange(1, MAX_OUTPUT_LIMIT),
    streaming: { kind: 'enum', values: ['streaming', 'non-streaming'] },
    // 工具步数上限（0~MAX_TOOL_STEP_LIMIT，0=无限制）
    toolStepLimit: intRange(0, MAX_TOOL_STEP_LIMIT),
    providerRouting: { kind: 'enum', values: ['auto', 'fixed'] },
    multiStepReasoning: { kind: 'enum', values: ['auto', 'manual'] },
    toolReadonly: { kind: 'enum', values: ['full', 'readonly'] },
    toolApproval: { kind: 'enum', values: ['auto', 'confirm'] },
  },
  reflect: {
    summary: { kind: 'enum', values: ['on', 'off'] },
    // 自审查轮数（0~MAX_SELF_REVIEW_ROUNDS，0=关闭）
    selfReview: intRange(0, MAX_SELF_REVIEW_ROUNDS),
    // 历史别名（v0.13- 命名残留）：新键 selfReview 优先，旧键回退——保留以兼容已落盘角色包
    loopContinue: intRange(0, MAX_SELF_REVIEW_ROUNDS),
    userFollowup: { kind: 'enum', values: ['ask', 'silent'] },
  },
  global: {
    askOn: { kind: 'check', check: isAskOn },
    // 每轮主动提问次数（1~MAX_ASK_LIMIT）
    askLimit: intRange(1, MAX_ASK_LIMIT),
    errorHandling: { kind: 'enum', values: ['retry', 'degrade', 'stop'] },
    // 每轮总 token 预算（0~MAX_TOKEN_BUDGET，0=不限制）
    tokenBudget: intRange(0, MAX_TOKEN_BUDGET),
    // 每轮工具步数预算：0=不限制，或 ∈ [MIN_STEP_BUDGET, MAX_STEP_BUDGET]（角色包声明区间）
    stepBudget: {
      kind: 'check',
      check: (value) =>
        typeof value === 'number' && Number.isInteger(value) &&
        (value === 0 || (value >= MIN_STEP_BUDGET && value <= MAX_STEP_BUDGET)),
      range: { min: MIN_STEP_BUDGET, max: MAX_STEP_BUDGET },
    },
    // 会议步骤截断上限（0~MAX_TASK_LOOP_LIMIT，0=关闭截断）；收敛后唯一消费方：prepare.ts 会议机制 tryBuildMeetingPlan
    taskLoopLimit: intRange(0, MAX_TASK_LOOP_LIMIT),
  },
};
