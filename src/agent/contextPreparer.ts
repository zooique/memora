/**
 * Agent 输入增强管线 — 外部输入 → 上下文装配
 *
 * 职责：
 *   - assembleContext：上下文装配（预算派生 + 对话层注入 + 占用快照）。
 *     每轮无自动记忆召回（memory-tool-recall-design §3/§4），检索由 LLM 经 search_memories 工具主动触发。
 *   - 角色包只能手动切换，无 autoMatch / LLM 语义兜底（无角色自动匹配）
 *
 * 设计原则：
 *   - 只依赖 Agent 注入的稳定能力（deps），不反向依赖 Agent 私有状态（与 AgentHooks 同构）
 *   - 管线逻辑单一真理源：对话层注入/占用快照随管线走
 *   - Agent 门面保留编排骨架（thinking 阶段 yield 与调用点），叶子逻辑在此唯一实现
 *   - 事件发射（inputTooLarge）经 emit 回调由 Agent 承接
 */

import type { AgentLoop } from '@/agent/loop.js';
import type { RolePackManager } from '@/role-pack/rolePackManager.js';
import { computeContextBudget, isInputTooLarge, estimateOccupancy } from '@/agent/budget.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import type { UIMessages } from '@/agent/types.js';
import { AGENT_EVENTS, type AgentEventName } from '@/utils/eventEmitter.js';
import { logger } from '@/logging/logger.js';
import type { ITracer } from '@/agent/tracer.js';

/**
 * 输入增强管线的依赖注入接口（Agent 稳定能力的窄面）
 *
 * 边界：只传 Agent 的稳定能力（组件引用 / 配置 / 事件发射），
 * 不传可变私有状态。
 */
export interface ContextPreparerDeps {
  /** AgentLoop（最近对话注入 + 召回互斥排除集派生） */
  loop: AgentLoop;
  /** 角色包管理器（策略来源；可为空） */
  rolePackManager: RolePackManager | null;
  /** 懒取项目记忆索引（requirePctx.index 等价物，避免持有可变 ProjectContext 引用） */
  getIndex: () => IMemoryStorage;
  /** 宿主可观测性 / 存储 / 文案配置 */
  config: {
    /** 可观测性 Tracer（可选，缺省 Noop） */
    tracer: ITracer | null;
    /** 界面文案（最近对话 / 用户 / 助手标签） */
    messages: UIMessages | undefined;
    /** 上下文窗口容量（token）：唯一真理源 = 宿主在构造内核前经 resolveContextWindow(window) 解析注入的单一数字（per-LLM 窗口，缺失回退默认 120K）。内核预算路径只消费单一数字，不认 provider/用户双层来源 */
    maxContextTokens: number;
  };
  /** 事件发射（桥接到 Agent 强类型 emit） */
  emit: (event: AgentEventName, data: unknown) => void;
}

/**
 * 输入增强管线协调器
 *
 * 承载 chat() 回答前的输入增强：记忆召回 + 固定轮次注入。Agent.prepareChatContext
 * 保留编排骨架，本类唯一实现叶子逻辑。
 */
export class ContextPreparer {
  /** 依赖注入集合（Agent 稳定能力窄面） */
  private readonly deps: ContextPreparerDeps;

  constructor(deps: ContextPreparerDeps) {
    this.deps = deps;
  }

  /**
   * 运行时更新上下文窗口上限（token）
   *
   * 模型热切换（Agent.setContextWindow）后调用：deps.config.maxContextTokens 为装配期
   * 值拷贝，须显式同步——否则每轮 prepare 的预算派生（computeContextBudget）与占用快照
   * （recordOccupancy 的 totalTokens / outputReserve / free）仍用旧窗口。
   *
   * @param tokens 新窗口 token 数
   */
  setMaxContextTokens(tokens: number): void {
    this.deps.config.maxContextTokens = tokens;
  }

  /**
   * 上下文装配（纯上下文装配，无自动召回）
   *
   * 记忆检索由 LLM 经 search_memories 工具主动触发（builtinToolHandlers.searchMemories），
   * 本方法不代模型猜测"此刻需要什么记忆"，只做纯**上下文装配**：预算派生 + roundId 互斥 +
   * 对话层注入 + 上下文占用快照，不返回任何自动召回的注入记忆。
   * 对话层注入恒走 hybrid（最近对话摘要注入），无 fixed/query 分支。
   *
   * @param input 用户输入（仅作顶级锚点预算估算，不再作为召回 query）
   */
  async assembleContext(input: string): Promise<void> {
    const { deps } = this;

    // ── 上下文预算：动态预算装配（role-pack-spec §C） ──
    // 容量来源：windowTokens = deps.config.maxContextTokens —— 单一数字，已由宿主在构造内核 Agent 前
    // 经内核 resolveContextWindow(window) 解析（per-LLM 窗口为唯一真理源，缺失回退默认 120K）后注入；内核预算路径只消费单一数字，不认 provider/用户双层来源。
    // 固定开销取 system prompt；顶级锚点 = 本轮用户输入（独立划块，永不压缩）；完整对话层从最近往回塞到 ~90% 止
    const loop = deps.loop;
    const loopMessages = loop.getMessages();
    const fixedOverheadTokens =
      loopMessages.length > 0 ? loop.estimateTokens([loopMessages[0]!]) : 0;
    const inputTokens = loop.estimateTokens([{ role: 'user', content: input }]);
    const budget = computeContextBudget({
      windowTokens: deps.config.maxContextTokens,
      fixedOverheadTokens,
      inputTokens,
    });
    // 预算透出（预算可视化）：暂存最近一轮预算供指标快照展示"预算花到哪"
    deps.loop.recordBudget?.(budget);

    // ── 装配前判负（独立路径） ──
    // 顶级锚点划走后剩余预算低于最小可运行阈值 → 该输入无法支撑至少一轮正文，
    // 装配前确定性降级（跳过召回与完整对话层注入），并通知宿主提示放文件用 read_file 读。
    // 与软上限（摘要饱和）是不同失败原因，不占用软上限统计。
    if (isInputTooLarge(budget)) {
      deps.emit(AGENT_EVENTS.inputTooLarge, {
        inputLength: input.length,
        remainingTokens: budget.remainingTokens,
        hint: '内容过大，建议放进文件用 read_file 读',
      });
      logger.warn(
        { inputLength: input.length, remainingTokens: budget.remainingTokens },
        '装配前判负：输入过大，跳过上下文装配与完整对话层注入',
      );
      return;
    }

    // 派生完整对话层轮次集合（动态轮数 + 第一条必在场，次级锚点）
    const dialogue = loop.getRecentHistoryWithinBudget(budget.dialogueBudgetTokens);

    // ── 完整对话层注入：恒 hybrid（无 fixed/query 分支） ──
    // 对话按预算截断，注入的最近轮次摘要提供结构化视图，避免 LLM 丢失上下文连续性。
    const recentHistory = dialogue.history;
    if (recentHistory.length > 0) {
      const msgs = deps.config.messages;
      const label = msgs?.recentConversationLabel ?? '[Recent conversation]';
      const userLabel = msgs?.userLabel ?? 'User';
      const assistantLabel = msgs?.assistantLabel ?? 'Assistant';
      const recentPrompt =
        `${label}\n` +
        recentHistory
          .map((m) => `${m.role === 'user' ? userLabel : assistantLabel}：${m.content}`)
          .join('\n');
      loop.injectSystemMessage(recentPrompt);
      logger.debug({ turns: recentHistory.length / 2 }, '最近对话已注入');
    }

    // ── 上下文占用快照（预算可视化）：记录各层真实用量，供输入区指示器展示 ──
    // 单一真理源 = 本 prepare 已算出的实际值；宿主/webview 只渲染、不重算。
    //   rolePackBase = fixedOverheadTokens（system prompt：persona+rules+技能L1+工具schema）
    //   dialogue     = 问答闭环完整对话 token（全量 user+assistant，与装配模式无关——容量诚实
    //                  统计问答闭环总和；loop.append 侧 refreshOccupancyDialogue 以
    //                  同一估算器重算覆盖，prepare 与实时刷新同源同数据，无口径漂移）
    //   inputAnchor  = 顶级锚点（本轮用户输入，budget.anchorTokens）
    //   outputReserve= 窗口 × 输出预留比例（留给模型回答的容量，非已用）
    //   free         = 总容量 − 各段，≥ 0 收敛（窗口过小/输入过大时各段归零）
    // 注：记忆不占用上下文，占用模型无记忆维度。
    const dialogueTokens = loop.estimateTokens(loop.getConversationMessages());
    // 条数语义：以「用户输入」为计数标准——一个问答闭环（user 消息）计 1 条，
    // 哪怕 assistant 回答残缺/被中止也如实记录（尊重用户保留意图）；assistant 不计入条数，但计入 dialogueTokens 容量。
    // 关键：dialogueCount 与 dialogueTokens 统一取 loop.messages 全量（user 计数 + 全量 token），
    // 与装配模式无关——否则 hybrid 模式下 getRecentHistoryWithinBudget 按预算截取「最近 N 轮」
    // 会把最新轮挤掉最旧轮、轮数守恒，导致「发一条消息后完整对话数不涨」（用户实测 bug），
    // 且进窗口径与 loop 侧实时刷新（refreshOccupancyDialogue 按全量重算）产生语义漂移。
    // 统一全量后 prepare 与刷新共用同一估算器、同一数据源（SSOT），杜绝口径分叉。
    const dialogueCount = loop.getConversationMessages().filter((m) => m.role === 'user').length;
    // 占用组装复用 estimateOccupancy（SSOT 单点：free 收敛 + 拼满 + 输出预留，宿主历史会话重算共用）
    deps.loop.recordOccupancy(
      estimateOccupancy({
        totalTokens: deps.config.maxContextTokens,
        rolePackBaseTokens: fixedOverheadTokens,
        dialogueTokens,
        dialogueCount,
        inputAnchorTokens: budget.anchorTokens,
      }),
    );
  }
}
