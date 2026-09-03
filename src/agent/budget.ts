/**
 * 上下文预算计算——动态预算装配（role-pack-spec §上下文预算装配 C）
 *
 * @module
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
import { AGENT_CONSTANTS } from '@/agent/constants.js';

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
  /** 上下文窗口容量（token）：唯一真理源 = 宿主在构造内核前经 resolveContextWindow(window) 解析注入的单一数字（per-LLM 窗口，缺失回退默认 120K）。内核预算路径只消费单一数字，不认 provider/用户双层来源 */
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

/**
 * 解析有效上下文窗口（SSOT 单源公式，宿主在构造内核 Agent 前调用）。
 *
 * 唯一真理源 = 用户 per-LLM 配置的上下文上限（宿主装配时传入）；未配置 → 回退内核默认
 * DEFAULT_MAX_CONTEXT_TOKENS（120_000）。内核预算路径只吃单一数字 maxContextTokens，
 * 不认 provider/用户双来源、不施加全局封顶——用户对自己填写的参数负责（见 ADR-029）。
 */
export function resolveContextWindow(window?: number): number {
  return window ?? AGENT_CONSTANTS.DEFAULT_MAX_CONTEXT_TOKENS;
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
 * 上下文占用快照（真实用量，供输入区指示器展示；与 `ContextBudget` 的「预算上限」互补）。
 *
 * 设计：各段为 prepare 期**实际占用** token，互斥分段拼满整个窗口容量 `totalTokens`：
 *   角色包基础设定(system) | 记忆摘要 | 完整对话 | 当前输入锚点 | 输出预留 | 剩余。
 * 单一真理源 = 内核 prepare 计算（contextPreparer 经 loop.recordOccupancy 写入），
 * 宿主/webview 只渲染、不重算。free 非负收敛（窗口过小/输入过大时各段归零，free 不出现负值）。
 */
export interface ContextOccupancy {
  /** 窗口总容量（token）= maxContextTokens（SSOT 容量来源，见 resolveContextWindow） */
  readonly totalTokens: number;
  /** 角色包/系统基础设定占用（system prompt：persona + rules + 技能 L1 + 工具 schema） */
  readonly rolePackBaseTokens: number;
  /** 完整对话层实际占用（最近轮次注入正文 token） */
  readonly dialogueTokens: number;
  /** 完整对话层注入的对话条数（user+assistant 消息总数；条数与 token 并存供宿主 hover 明细展示） */
  readonly dialogueCount: number;
  /** 记忆摘要层实际占用（注入的 recalled 记忆 token） */
  readonly memoryTokens: number;
  /** 记忆摘要层注入的记忆条数（recalled 记忆数；与 dialogueCount 同源，供宿主明细展示） */
  readonly memoryCount: number;
  /** 当前输入锚点（触发输入 + 首个回答预留估算，独立划块） */
  readonly inputAnchorTokens: number;
  /** 输出预留（窗口 × 输出预留比例，留给模型回答的容量，非已用） */
  readonly outputReserveTokens: number;
  /** 剩余可用（total − 各段，≥ 0 收敛） */
  readonly freeTokens: number;
}

/** 上下文占用估算入参（各层 token/条数为已算好的实际值，本函数只做收敛 + 组装） */
export interface EstimateOccupancyInput {
  /** 窗口总容量（token） */
  readonly totalTokens: number;
  /** 角色包/系统基础设定占用（system prompt 固定开销） */
  readonly rolePackBaseTokens: number;
  /** 完整对话层 token */
  readonly dialogueTokens: number;
  /** 完整对话层条数 */
  readonly dialogueCount: number;
  /** 记忆摘要层 token */
  readonly memoryTokens: number;
  /** 记忆摘要层条数 */
  readonly memoryCount: number;
  /** 当前输入锚点 token（运行时 = budget.anchorTokens；历史会话 = 0） */
  readonly inputAnchorTokens: number;
  /** 输出预留比例（默认 0.15） */
  readonly outputReserveRatio?: number;
}

/**
 * 组装上下文占用快照（SSOT 数值派生）。
 *
 * 纯函数：入参为各层已算好的 token/条数，本函数只做
 * 输出预留 + 各段互斥拼满 + free 非负收敛，再组装为 `ContextOccupancy`。
 * 运行时（contextPreparer）与宿主历史会话重算共用——占用组装逻辑单点定义，
 * 宿主不另写一份（避免 free 收敛口径漂移）。
 */
export function estimateOccupancy(input: EstimateOccupancyInput): ContextOccupancy {
  const outputReserveRatio = input.outputReserveRatio ?? DEFAULT_OUTPUT_RESERVE_RATIO;
  const outputReserveTokens = Math.floor(input.totalTokens * outputReserveRatio);
  const usedBeforeFree =
    input.rolePackBaseTokens +
    input.dialogueTokens +
    input.memoryTokens +
    input.inputAnchorTokens +
    outputReserveTokens;
  const freeTokens = Math.max(0, input.totalTokens - usedBeforeFree);
  return {
    totalTokens: input.totalTokens,
    rolePackBaseTokens: input.rolePackBaseTokens,
    dialogueTokens: input.dialogueTokens,
    dialogueCount: input.dialogueCount,
    memoryTokens: input.memoryTokens,
    memoryCount: input.memoryCount,
    inputAnchorTokens: input.inputAnchorTokens,
    outputReserveTokens,
    freeTokens,
  };
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
 *   - 其余轮（问答闭环）正文：按预算从最近往回塞到 ~90% 止；
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
