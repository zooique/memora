/**
 * Agent 输入增强管线 — 外部输入 → 记忆/技能增强
 *
 * 职责：
 *   - recallAndInject：语义召回 + limited 配额裁剪 + 固定轮次注入
 *   - （角色自动匹配已随 v0.13 移除：角色包只能手动切换，无 autoMatch / LLM 语义兜底）
 *
 * 设计原则：
 *   - 只依赖 Agent 注入的稳定能力（deps），不反向依赖 Agent 私有状态（与 AgentHooks 同构）
 *   - 管线逻辑单一真理源：策略解析（记忆百分比 / minFallback / 置信度）随管线走
 *   - Agent 门面保留编排骨架（thinking 阶段 yield 与调用点），叶子逻辑在此唯一实现
 *   - 事件发射（memoryRecalled / boostPersistFailed）经 emit 回调由 Agent 承接
 */

import type { AgentLoop } from '@/agent/loop.js';
import type { MessageHistory } from '@/agent/messageHistory.js';
import type { RolePackManager } from '@/role-pack/rolePackManager.js';
import {
  resolveMinFallback,
  resolveRecallConfidence,
  resolveMemoryRecallPercent,
  resolveSummaryRecall,
  resolveActiveStrategy,
} from '@/role-pack/strategyResolver.js';
import type { MemoryRecallMode, BehaviorStrategy } from '@/role-pack/types.js';
import { computeContextBudget, isInputTooLarge, DEFAULT_OUTPUT_RESERVE_RATIO } from '@/agent/budget.js';
import { recall, boostScores } from '@/memory/recall.js';
import type { Memory } from '@/memory/types.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import type { IVectorStore } from '@/memory/vectorStore.js';
import type { UIMessages } from '@/agent/types.js';
import { AGENT_CONSTANTS } from '@/agent/constants.js';
import { AGENT_EVENTS, type AgentEventName } from '@/utils/eventEmitter.js';
import { logger } from '@/logging/logger.js';
import type { ITracer } from '@/agent/tracer.js';
import { TRACE_SPANS, NOOP_TRACER } from '@/agent/tracer.js';
import { toError } from '@/utils/toError.js';
import { backgroundTask } from '@/utils/backgroundTask.js';

/**
 * 输入增强管线的依赖注入接口（Agent 稳定能力的窄面）
 *
 * 边界：只传 Agent 的稳定能力（组件引用 / 配置 / 事件发射），
 * 不传可变私有状态。
 */
export interface ContextPreparerDeps {
  /** 消息历史（固定轮次注入 / 互斥 roundId 排除） */
  history: MessageHistory;
  /** AgentLoop（最近对话注入） */
  loop: AgentLoop;
  /** 角色包管理器（策略来源；可为空） */
  rolePackManager: RolePackManager | null;
  /** 懒取项目记忆索引（requirePctx.index 等价物，避免持有可变 ProjectContext 引用） */
  getIndex: () => IMemoryStorage;
  /** 宿主可观测性 / 存储 / 文案配置 */
  config: {
    /** 可观测性 Tracer（可选，缺省 Noop） */
    tracer: ITracer | null;
    /** 向量存储（可选，提供时启用语义召回） */
    vectorStore: IVectorStore | null;
    /** 召回排除的 source 列表 */
    recallExcludeSources: string[] | undefined;
    /** 界面文案（最近对话 / 用户 / 助手标签） */
    messages: UIMessages | undefined;
    /** 上下文窗口容量（token）——动态预算装配的容量来源（优先 provider contextWindow，缺失降级 maxContextTokens） */
    maxContextTokens: number;
  };
  /** 事件发射（桥接到 Agent 强类型 emit） */
  emit: (event: AgentEventName, data: unknown) => void;
  /** 宿主装配级策略覆盖（可选）：压过角色包声明 */
  strategyOverride?: Partial<BehaviorStrategy>;
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
   * 记忆召回 + 固定轮次注入
   *
   * 策略控制：'none' 模式跳过实际召回；contextAssembly 决定语义召回（query/hybrid）与
   * 固定轮次注入（fixed/hybrid）的组合；limited 模式把记忆摘要层 token cap 传入 recall
   * 做 cap 内分配（分轨：preference 取余量、语义轨保底）。
   * 前置互斥排除当前会话最近 N 轮 round-summary，避免挤占 top-limit 预算。
   *
   * @param input 用户输入（作为召回 query）
   * @param memoryRecallMode 记忆召回模式（full / limited / none）
   * @param contextAssembly 上下文装配策略（fixed / query / hybrid）
   * @returns 召回的记忆列表（供 loop.processUserInput 注入为 system 消息）
   */
  async recallAndInject(
    input: string,
    memoryRecallMode: MemoryRecallMode,
    contextAssembly: 'fixed' | 'query' | 'hybrid',
  ): Promise<Memory[]> {
    const { deps } = this;
    // 策略控制：'none' 模式跳过实际召回，仅注入最近对话
    const strategy = resolveActiveStrategy(this.deps.rolePackManager, this.deps.strategyOverride);
    let recalledMemories: Memory[] = [];

    // ── 上下文预算：动态预算装配（role-pack-spec §C） ──
    // 容量来源：windowTokens = deps.config.maxContextTokens —— 单一数字，已由宿主在构造内核 Agent 前
    // 经内核 resolveContextWindow(window) 解析（per-LLM 窗口为唯一真理源，缺失回退默认 120K）后注入；内核预算路径只消费单一数字，不认 provider/用户双层来源。
    // 固定开销取 system prompt；顶级锚点 = 触发输入 + 首个回答预留（独立划块，永不压缩）；完整对话层从最近往回塞到 ~90% 止
    const loop = deps.loop;
    const loopMessages = loop.getMessages();
    const fixedOverheadTokens =
      loopMessages.length > 0 ? loop.estimateTokens([loopMessages[0]!]) : 0;
    const inputTokens = loop.estimateTokens([{ role: 'user', content: input }]);
    const budget = computeContextBudget({
      windowTokens: deps.config.maxContextTokens,
      fixedOverheadTokens,
      inputTokens,
      memoryRecallPercent: resolveMemoryRecallPercent(strategy),
    });
    // 预算透出（④ 预算可视化）：暂存最近一轮预算供指标快照展示"预算花到哪"
    deps.loop.recordBudget?.(budget);

    // ── 装配前判负（洞 3 独立路径） ──
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
        '装配前判负：输入过大，跳过召回与完整对话层注入',
      );
      return [];
    }

    // 派生完整对话层轮次集合（动态轮数 + 第一条必在场，次级锚点）
    const dialogue = loop.getRecentHistoryWithinBudget(budget.dialogueBudgetTokens);

    // 互斥 roundId 集合 = 完整对话层实际注入轮次集合（最近 dialogue.recentRoundCount 轮 +
    // 显式补的第一条 + 第一级替换产物 roundId）。前置传入 recall() 在取 limit 前过滤，
    // 避免正文/替换产物被二次召回（装配时间线互斥：exclude = 实际注入轮次，因果闭合）
    const recentRoundIds = new Set(deps.history.getRecentRoundIds(dialogue.recentRoundCount));
    if (dialogue.firstRoundIncluded) {
      const firstRoundId = deps.history.getFirstRoundId();
      if (firstRoundId) recentRoundIds.add(firstRoundId);
    }
    // 第一级替换产物：越界轮正文已替换成其记忆摘要并随上下文注入，其 roundId 须 exclude 防双写
    for (const replacedRoundId of loop.getReplacedRoundIds()) {
      recentRoundIds.add(replacedRoundId);
    }

    // ── 语义召回：contextAssembly !== 'fixed' 时执行（query / hybrid） ──
    if (contextAssembly !== 'fixed' && memoryRecallMode !== 'none') {
      const tracer = deps.config.tracer ?? NOOP_TRACER;
      const recallSpan = tracer.startSpan(TRACE_SPANS.RECALL_ACTUAL, {
        queryLength: input.length,
        hasVectorStore: !!deps.config.vectorStore,
        memoryRecallMode,
      });

      try {
        // 条数上限统一 DEFAULT_RECALL_LIMIT（full/limited 共用有界条数）；
        // limited 模式把记忆摘要层 cap（剩余预算 × memoryRecallPercent，token）传入 recall
        // 做 cap 内分配（§4.3.1：preference 取余量、语义轨保底），替代返回后的纯字符截断
        recalledMemories = await recall(deps.getIndex(), input, {
          limit: AGENT_CONSTANTS.DEFAULT_RECALL_LIMIT,
          // null（deps 关闭语义）收窄为 recall 的可选参数 undefined
          vectorStore: deps.config.vectorStore ?? undefined,
          excludeSources: deps.config.recallExcludeSources,
          // 会话窗口标识与写入侧 sessionName 同源同值，保证"同窗口优先"命中当前会话
          sessionId: deps.history.currentSessionName,
          // 召回保底下限：角色包 prepare.minFallback 控制，非法/缺失回退默认 2
          minFallback: resolveMinFallback(strategy),
          // 前置互斥排除：取 limit 前过滤完整对话层实际注入轮次的 round-summary
          excludeRoundIds: recentRoundIds,
          // 召回置信度阈值（0.0-1.0）
          minSimilarity: resolveRecallConfidence(strategy),
          // cap 内分配（C1）：limited 模式传记忆摘要层 token 上限，由 recall 分轨分配；
          // full 模式不传（退化为 limit 条数），minSemanticShare 走内核默认 0（C2 不进角色包）
          capTokens: memoryRecallMode === 'limited' ? budget.memoryLayerCapTokens : undefined,
        });
      } catch (err) {
        recallSpan.recordException(err instanceof Error ? err : new Error(String(err)));
        throw err;
      } finally {
        recallSpan.setAttribute('resultCount', recalledMemories.length);
        recallSpan.end();
      }

      // summaryRecall='off' → 过滤摘要类记忆（保留原始记忆）
      const summaryRecall = resolveSummaryRecall(strategy);
      if (summaryRecall === 'off') {
        recalledMemories = recalledMemories.filter((m) => m.source !== 'round-summary');
      }

      if (recalledMemories.length > 0) {
        deps.emit(AGENT_EVENTS.memoryRecalled, { count: recalledMemories.length, query: input });
        // boost 持久化为 fire-and-forget（软指标 +0.05/次 上限 1.0）；失败经 onFailure 通知宿主，不阻塞 chat 读路径
        const ids = recalledMemories.map((m) => m.id);
        backgroundTask(
          'boost-scores',
          () => boostScores(deps.getIndex(), ids),
          (err: unknown) => {
            deps.emit(AGENT_EVENTS.boostPersistFailed, {
              memoryId: ids.join(','),
              message: toError(err).message,
            });
          },
        );
      }
    }

    // ── 完整对话层注入：仅 hybrid 模式执行 ──
    // 关键修复：fixed 模式下 loop.messages 已保留全部对话历史（cleanTemporary 只清 system），
    // 再注入 conversation 摘要会造成双份出现、浪费 token。hybrid 模式下对话按预算截断，
    // 注入的最近轮次摘要提供结构化视图，避免 LLM 丢失上下文连续性。
    if (contextAssembly === 'hybrid') {
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
    }

  // 跨窗口召回摘要按 createdAt 升序排列，帮助 LLM 识别"最近偏好"（越早越靠前）
  recalledMemories = [...recalledMemories].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  // ── 上下文占用快照（④ 预算可视化）：记录各层真实用量，供输入区指示器展示 ──
  // 单一真理源 = 本 prepare 已算出的实际值；宿主/webview 只渲染、不重算。
  //   rolePackBase = fixedOverheadTokens（system prompt：persona+rules+技能L1+工具schema）
  //   dialogue     = 实际注入的最近轮次正文 token
  //   memory       = 注入的 recalled 记忆 token
  //   inputAnchor  = 顶级锚点（触发输入 + 首个回答预留，budget.anchorTokens）
  //   outputReserve= 窗口 × 输出预留比例（留给模型回答的容量，非已用）
  //   free         = 总容量 − 各段，≥ 0 收敛（窗口过小/输入过大时各段归零）
  const dialogueTokens = loop.estimateTokens(dialogue.history);
  const memoryTokens = recalledMemories.length
    ? loop.estimateTokens(recalledMemories.map((m) => ({ role: 'system', content: m.content })))
    : 0;
  const outputReserveTokens = Math.floor(deps.config.maxContextTokens * DEFAULT_OUTPUT_RESERVE_RATIO);
  const usedBeforeFree =
    fixedOverheadTokens + dialogueTokens + memoryTokens + budget.anchorTokens + outputReserveTokens;
  const freeTokens = Math.max(0, deps.config.maxContextTokens - usedBeforeFree);
  deps.loop.recordOccupancy({
    totalTokens: deps.config.maxContextTokens,
    rolePackBaseTokens: fixedOverheadTokens,
    dialogueTokens,
    memoryTokens,
    inputAnchorTokens: budget.anchorTokens,
    outputReserveTokens,
    freeTokens,
  });

  return recalledMemories;
  }
}
