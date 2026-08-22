/**
 * 上下文预算计算——动态预算装配（role-pack-spec §上下文预算装配 C）
 *
 * 预算公式（容量来源 × 分配偏好 → 派生轮数）：
 *   可用预算 = Provider窗口 − 固定开销(system+persona+rules+技能L1+工具schema) − 输出预留(15~20%)
 *   顶级锚点空间 = 本轮用户输入 + 首个回答预留（独立划块，暂以输入长度估算，永不压缩）
 *   剩余预算 = 可用预算 − 顶级锚点空间
 *   完整对话层 = 剩余预算，从最近往回塞到 ~90% 止（先装，锚点不动；留 buffer 防抖）
 *   记忆摘要层 = 剩余预算 − 完整对话层实际占用（拾遗填充，≤ 剩余预算 × memoryRecallPercent 上限）
 *   动态轮数 = 完整对话层能装几轮（派生值，不显式声明）
 *
 * 纯函数、零依赖：token 估算由调用方（AgentLoop/ContextManager）提供，本模块只做数值派生。
 * 装配前判负（洞 3）亦基于本模块的剩余预算阈值判定。
 */

/** 输出预留比例默认值（可用预算 = 窗口 × (1 − 该值) − 固定开销） */
export const DEFAULT_OUTPUT_RESERVE_RATIO = 0.15;

/** 完整对话层填充比例默认值（~90% 止，留 10% buffer 防抖 + 记忆摘要层拾遗空间） */
export const DEFAULT_DIALOGUE_FILL_RATIO = 0.9;

/** 顶级锚点倍数：触发输入 + 首个回答（首个回答暂以输入长度估算，双倍输入） */
export const DEFAULT_ANCHOR_ANSWER_FACTOR = 2;

/** 最小可运行对话层余量（token）：剩余预算低于此值判定「输入过大」装配前判负。
 *  洞 3：触发输入本身过大是与软上限不同的失败原因，走独立装配前判负路径，不污染软上限统计。 */
export const MIN_RUNNABLE_DIALOGUE_TOKENS = 128;

/** 预算计算入参 */
export interface ContextBudgetInput {
  /** Provider 窗口容量（token）——优先 provider contextWindow，缺失降级 maxContextTokens */
  readonly windowTokens: number;
  /** 固定开销（system+persona+rules+技能L1+工具schema，token） */
  readonly fixedOverheadTokens: number;
  /** 本轮用户输入 token 数（顶级锚点估算基准） */
  readonly inputTokens: number;
  /** 输出预留比例（默认 0.15 = 15%） */
  readonly outputReserveRatio?: number;
  /** 完整对话层填充比例（默认 0.9 = 90%，留 buffer 防抖） */
  readonly dialogueFillRatio?: number;
  /** 记忆召回百分比 cap（默认 0.4；cap 非 quota） */
  readonly memoryRecallPercent?: number;
}

/** 预算计算结果 */
export interface ContextBudget {
  /** 可用预算 = 窗口 × (1 − 输出预留) − 固定开销 */
  readonly availableTokens: number;
  /** 顶级锚点空间 = 输入 + 首个回答预留（独立划块，永不压缩） */
  readonly anchorTokens: number;
  /** 剩余预算 = 可用预算 − 顶级锚点空间 */
  readonly remainingTokens: number;
  /** 完整对话层预算 = 剩余预算 × 填充比例（从最近往回塞到 ~90% 止） */
  readonly dialogueBudgetTokens: number;
  /** 记忆摘要层 cap = 剩余预算 × memoryRecallPercent（拾遗填充上限，cap 非 quota） */
  readonly memoryLayerCapTokens: number;
}

/**
 * 计算上下文预算（SSOT 数值派生）。
 *
 * 百分比是 cap 不是 quota：完整对话层无条件优先，记忆摘要层是剩余空间的拾遗填充，
 * 百分比只封顶防止记忆挤占对话。各级非负收敛（窗口过小/输入过大时归零，供装配前判负判定）。
 */
export function computeContextBudget(input: ContextBudgetInput): ContextBudget {
  const outputReserveRatio = input.outputReserveRatio ?? DEFAULT_OUTPUT_RESERVE_RATIO;
  const dialogueFillRatio = input.dialogueFillRatio ?? DEFAULT_DIALOGUE_FILL_RATIO;
  const memoryRecallPercent = input.memoryRecallPercent ?? 0.4;

  // 可用预算 = 窗口 × (1 − 输出预留) − 固定开销（固定开销不参与百分比分配）
  const availableTokens = Math.max(
    0,
    Math.floor(input.windowTokens * (1 - outputReserveRatio)) - input.fixedOverheadTokens,
  );

  // 顶级锚点空间 = 触发输入 + 首个回答预留（独立划块，暂以输入长度估算）
  const anchorTokens = input.inputTokens * DEFAULT_ANCHOR_ANSWER_FACTOR;

  // 剩余预算 = 可用预算 − 顶级锚点空间（< 0 归零，供装配前判负判定「剩余不足」）
  const remainingTokens = Math.max(0, availableTokens - anchorTokens);

  // 完整对话层 = 剩余预算 × 填充比例（留 buffer 防抖）
  const dialogueBudgetTokens = Math.floor(remainingTokens * dialogueFillRatio);

  // 记忆摘要层 cap = 剩余预算 × memoryRecallPercent（拾遗填充上限）
  const memoryLayerCapTokens = Math.floor(remainingTokens * memoryRecallPercent);

  return {
    availableTokens,
    anchorTokens,
    remainingTokens,
    dialogueBudgetTokens,
    memoryLayerCapTokens,
  };
}

/**
 * 装配前判负（洞 3 独立路径）：顶级锚点（触发输入 + 首个回答）划走后剩余预算低于
 * 最小可运行阈值 → 该输入无法支撑至少一轮正文，装配前确定性拒绝/降级。
 * 与软上限（摘要饱和）是不同失败原因：走独立路径，不占用软上限统计。
 */
export function isInputTooLarge(budget: ContextBudget): boolean {
  return budget.remainingTokens < MIN_RUNNABLE_DIALOGUE_TOKENS;
}

/** 完整对话层轮次派生结果 */
export interface DerivedDialogue {
  /** 最近从后往前能塞进预算的轮数（不含显式补的第一条；动态轮数 = 该派生值） */
  readonly recentRoundCount: number;
  /** 是否显式补了第一条（第一条不在最近轮内时，次级锚点必然在场） */
  readonly firstRoundIncluded: boolean;
  /** 已占用 token（用于日志/诊断，不参与后续分配） */
  readonly usedTokens: number;
}

/**
 * 从最近往回塞到预算止，派生完整对话层的轮次集合（纯函数）。
 *
 * 规则（role-pack-spec §D）：
 *   - 其余执行闭环正文：按预算从最近往回塞到 ~90% 止；
 *   - 会话第一条问答闭环：必然加载（默认在场）——若第一条不在最近轮内，显式补入（次级锚点，压缩可让位）。
 *
 * @param roundCosts 每轮 token 成本（原始轮序，最旧在前）；由调用方估算
 * @param budgetTokens 完整对话层预算（token）
 */
export function deriveDialogueRounds(
  roundCosts: readonly number[],
  budgetTokens: number,
): DerivedDialogue {
  // 从最近往回塞到预算止（首轮未被排除时允许单轮超预算，保证至少有正文可注入）
  let recentRoundCount = 0;
  let usedTokens = 0;
  for (let i = roundCosts.length - 1; i >= 0; i--) {
    const cost = roundCosts[i] ?? 0;
    if (recentRoundCount > 0 && usedTokens + cost > budgetTokens) break;
    recentRoundCount++;
    usedTokens += cost;
  }

  // 第一条必在场：最近轮未覆盖第一条（存在轮次且 recentRoundCount < 总轮数）时显式补入
  const firstRoundIncluded = roundCosts.length > 0 && recentRoundCount < roundCosts.length;

  return { recentRoundCount, firstRoundIncluded, usedTokens };
}
