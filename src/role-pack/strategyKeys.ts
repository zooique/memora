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

/** 单轮回答长度上限（token）：65536 覆盖当前所有模型 max_tokens 能力上限 */
export const MAX_OUTPUT_LIMIT = 65536;
/** 单轮工具调用步数上限：100 步足够复杂任务单轮调用 */
export const MAX_TOOL_STEP_LIMIT = 100;
/**
 * selfReview 的**输入校验上界**，非运行时上限（勿据常量名推导运行时行为）。
 * 布尔数字语义下任意正整数都在解析层归一为 1=终审一次，故本值仅作 schema / validator 的防御上界，
 * 不代表「可自审查 10 轮」。
 */
export const MAX_SELF_REVIEW_ROUNDS = 10;
/** 主动提问次数上限：按一次用户输入（turn 粒度）计，10 次防打扰失控 */
export const MAX_ASK_LIMIT = 10;
/**
 * 角色包上下文上限的**声明上界**：2_000_000，与 provider 窗口上界对齐（`src/config/loader.ts`
 * 的 `MAX_CONTEXT_WINDOW`）—— 使角色包在任何 provider 窗口下都能表达「收紧」意图。
 * 因有效窗口**取小值**，本上界永不放大窗口（2M provider 下声明 2M 等价于不设上限）。
 * 语义 = 角色包自设的上下文规模上限，与 provider 窗口取小值后成为有效窗口（非独立资源池、非终止条件）。
 */
export const MAX_CONTEXT_LIMIT = 2_000_000;
/**
 * 上下文上限的**正数声明下限**：120_000。
 * ⚠️ **真源 = `src/agent/constants.ts` 的 `DEFAULT_MAX_CONTEXT_TOKENS`**，本键是其**镜像**（改真源须同步本值；
 * 依赖方向为 `agent → role-pack` 单向，本层不可 import agent，故按本仓既有做法「重复 + 注释对冲」）。
 * 语义与 `MIN_STEP_BUDGET` 同构：`0` = 不设额外上限（走 provider 窗口）；
 * 非 0 声明必须落在 [本值, MAX_CONTEXT_LIMIT]——低于内核默认窗口的「收紧」无实际意义。
 */
export const MIN_CONTEXT_LIMIT = 120_000;
/** 步数预算声明下限：角色包 stepBudget 声明区间下限（0=未声明走兜底，正数声明不得低于此），低于此视为越界回退默认值 */
export const MIN_STEP_BUDGET = 10;
/**
 * 步数预算声明上限：角色包声明区间为 {0} ∪ [MIN_STEP_BUDGET, MAX_STEP_BUDGET]（0=未声明 → 兜底，无「不限步数」路径）。
 * 角色作者想让这个角色跑得久就配大值，想保守就配小值。
 * 角色包不声明 stepBudget 时，resolveStepBudget 回退 DEFAULT_MAX_ITERATIONS。
 * loop 运行时由 opts.maxIterations 传入覆盖——角色包声明多少给多少，内核只兜底默认。
 */
export const MAX_STEP_BUDGET = 500;
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

/** 温度断言：0.0~2.0（act.temperature）。类型谓词，供装配端复用同一 SSOT 边界做窄化 */
export function isTemperature(value: unknown): value is number {
  return typeof value === 'number' && value >= 0 && value <= 2;
}

/** 提炼视角长度断言：非空字符串且 ≤ MAX_SUMMARY_FOCUS_LENGTH 字符（防巨型注入） */
export function isSummaryFocus(value: unknown): boolean {
  return (
    typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_SUMMARY_FOCUS_LENGTH
  );
}

/** askOn 触发枚举（SSOT 单一来源：类型推导与运行时校验共用，types.ts 的 AskOnTrigger 由本数组推导） */
export const ASK_TRIGGERS = ['ambiguity', 'decision', 'missing_info', 'confirm'] as const;

/** askOn 触发枚举运行时集合（由 ASK_TRIGGERS 派生，O(1) 判定） */
const ASK_TRIGGER_SET: ReadonlySet<string> = new Set(ASK_TRIGGERS);

/** askOn 断言：单枚举或元素∈四枚举的数组（可组合）；数组长度 ≤ 枚举数（防重复堆叠） */
export function isAskOn(value: unknown): boolean {
  if (typeof value === 'string') return ASK_TRIGGER_SET.has(value);
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    // 数量上限：可组合触发项最多 4 个（去重后），防重复堆叠膨胀 prompt 注入指令
    value.length <= ASK_TRIGGERS.length &&
    value.every((v) => typeof v === 'string' && ASK_TRIGGER_SET.has(v))
  );
}

// ════════════════════════════════════════════════════════════
// 策略枚举值常量（SSOT 单一来源：types.ts 类型推导 + validator 校验 + resolver 归位共用）
// 与 ASK_TRIGGERS 同构——枚举键值域单点定义，增删取值只改此处，类型/校验/归位自动跟随，
// 杜绝「类型字面量 / KeyRule.values / normalizeEnum 白名单」三副本漂移。
// ════════════════════════════════════════════════════════════

/** 工具调用模式枚举值（SSOT：types.ts ToolMode 推导 + act.toolMode 校验/归位） */
export const TOOL_MODES = ['allow', 'block'] as const;
/** 工具操作范围枚举值（SSOT：types.ts ToolReadonly 推导 + act.toolReadonly 校验/归位） */
export const TOOL_READONLY_MODES = ['full', 'readonly'] as const;
/** Provider 路由策略枚举值（SSOT：types.ts ProviderRouting 推导 + act.providerRouting 校验/归位） */
export const PROVIDER_ROUTINGS = ['auto', 'fixed'] as const;
/** 多步推理模式枚举值（SSOT：types.ts MultiStepReasoning 推导 + act.multiStepReasoning 校验/归位） */
export const MULTI_STEP_REASONINGS = ['auto', 'manual'] as const;
/** 摘要生成开关枚举值（SSOT：types.ts Summary 推导 + reflect.summary 校验/归位） */
export const SUMMARY_MODES = ['on', 'off'] as const;
/** 用户追问策略枚举值（SSOT：types.ts UserFollowup 推导 + reflect.userFollowup 校验） */
export const USER_FOLLOWUPS = ['ask', 'silent'] as const;
/** 错误处理策略枚举值（SSOT：types.ts ErrorHandling 推导 + global.errorHandling 校验/归位） */
export const ERROR_HANDLINGS = ['retry', 'degrade', 'stop'] as const;

/**
 * L2 策略键集：camelCase 统一命名。无标注 = 冻结（memora 真实消费）；
 * [草案] = 尚无消费，保留征集验证。只有被消费的键保留在校验器；未知键 validator 报 warning。
 * 数值键全部带上下限（intRange）：下限防语义错误，上限防资源失控（SSOT 区间常量见文件头）。
 */
export const STRATEGY_KEY_RULES: Readonly<Record<string, Readonly<Record<string, KeyRule>>>> = {
  prepare: {
    // 领域无关机制，内容由角色包提供（≤ MAX_SUMMARY_FOCUS_LENGTH 字符）
    summaryFocus: {
      kind: 'check',
      check: isSummaryFocus,
      range: { min: 1, max: MAX_SUMMARY_FOCUS_LENGTH },
    },
  },
  act: {
    toolMode: { kind: 'enum', values: TOOL_MODES },
    // 角色包可控温度（0.0~2.0）/输出长度（1~MAX_OUTPUT_LIMIT token）
    temperature: { kind: 'check', check: isTemperature, range: { min: 0, max: 2 } },
    outputLimit: intRange(1, MAX_OUTPUT_LIMIT),
    // 工具步数上限（0~MAX_TOOL_STEP_LIMIT，0=无限制）
    toolStepLimit: intRange(0, MAX_TOOL_STEP_LIMIT),
    providerRouting: { kind: 'enum', values: PROVIDER_ROUTINGS },
    multiStepReasoning: { kind: 'enum', values: MULTI_STEP_REASONINGS },
    toolReadonly: { kind: 'enum', values: TOOL_READONLY_MODES },
  },
  reflect: {
    summary: { kind: 'enum', values: SUMMARY_MODES },
    // 自审查（布尔数字：0=关闭；正整数>0 归一为 1=自审查一次，大于 1 算 1；校验区间 0~MAX_SELF_REVIEW_ROUNDS）
    selfReview: intRange(0, MAX_SELF_REVIEW_ROUNDS),
    userFollowup: { kind: 'enum', values: USER_FOLLOWUPS },
  },
  global: {
    askOn: { kind: 'check', check: isAskOn },
    // 每轮主动提问次数（1~MAX_ASK_LIMIT）
    askLimit: intRange(1, MAX_ASK_LIMIT),
    errorHandling: { kind: 'enum', values: ERROR_HANDLINGS },
    // 角色包上下文上限：0 = 不设额外上限（跟随 provider 窗口）∪ [MIN_CONTEXT_LIMIT, MAX_CONTEXT_LIMIT]。
    // 与 stepBudget 同构（0 承载"未声明"语义、正数走声明区间），故不用 intRange 而自定义 check；
    // range.min 是"正数声明下限"（schema 层 minimum=0 是 JSON-Schema 接受层，见守卫测试说明）。
    contextLimit: {
      kind: 'check',
      check: (value) =>
        typeof value === 'number' &&
        Number.isInteger(value) &&
        (value === 0 || (value >= MIN_CONTEXT_LIMIT && value <= MAX_CONTEXT_LIMIT)),
      range: { min: MIN_CONTEXT_LIMIT, max: MAX_CONTEXT_LIMIT },
    },
    // 每轮步数预算：0 或未声明 = 不声明（loop 侧落 maxIterations 兜底），或 ∈ [MIN_STEP_BUDGET, MAX_STEP_BUDGET]（角色包声明区间）
    // 注意：0 ≠「不限步数」——stepBudget 无不受限路径（防死循环设计），0 仅表示走内核兜底
    stepBudget: {
      kind: 'check',
      check: (value) =>
        typeof value === 'number' &&
        Number.isInteger(value) &&
        (value === 0 || (value >= MIN_STEP_BUDGET && value <= MAX_STEP_BUDGET)),
      range: { min: MIN_STEP_BUDGET, max: MAX_STEP_BUDGET },
    },
  },
};
