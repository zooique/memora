/**
 * Agent 输入增强管线 — 外部输入 → 角色/记忆/技能增强
 *
 * 职责：
 *   - tryAutoMatchRolePack / matchRolePackByLlm：角色包自动匹配（关键词粘性 + LLM 语义兜底）
 *   - recallAndInject：语义召回 + limited 配额裁剪 + 固定轮次注入
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
  DEFAULT_BEHAVIOR_STRATEGY,
  resolveMinFallback,
  resolveRecallConfidence,
  resolveMemoryRecallPercent,
  resolveSummaryRecall,
} from '@/role-pack/strategyResolver.js';
import type { BehaviorStrategy, MemoryRecallMode } from '@/role-pack/types.js';
import { computeContextBudget, isInputTooLarge } from '@/agent/budget.js';
import { recall, boostScores } from '@/memory/recall.js';
import type { Memory } from '@/memory/types.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import type { IVectorStore } from '@/memory/vectorStore.js';
import type { LlmProvider } from '@/llm/provider.js';
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
 * 边界：只传 Agent 的稳定能力（组件引用 / 配置 / 事件发射 / 角色切换回调），
 * 不传可变私有状态；backgroundProvider 采用可变字段 + setBackgroundProvider 同步
 * （与 roundSummaryGenerator / sessionArchiver 统一消费模式一致）。
 */
export interface ContextPreparerDeps {
  /** 消息历史（固定轮次注入 / 互斥 roundId 排除） */
  history: MessageHistory;
  /** AgentLoop（最近对话注入） */
  loop: AgentLoop;
  /** 角色包管理器（角色匹配 / LLM 兜底列表；可为空） */
  rolePackManager: RolePackManager | null;
  /** 懒取项目记忆索引（requirePctx.index 等价物，避免持有可变 ProjectContext 引用） */
  getIndex: () => IMemoryStorage;
  /** 后台 Provider（初始值；运行时经 setBackgroundProvider 切换） */
  backgroundProvider: LlmProvider | null;
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
  /** 角色切换回调（Agent 生命周期：激活 → 事件 → 刷新前缀 → 工具暴露） */
  switchRolePack: (name: string) => boolean;
}

/**
 * 输入增强管线协调器
 *
 * 承载 chat() 回答前的外部输入增强三件套：角色包自动匹配（粘性）、记忆召回 + 固定轮次注入、
 * 技能当轮注入。Agent.prepareChatContext 保留编排骨架，本类唯一实现叶子逻辑。
 */
export class ContextPreparer {
  /** 依赖注入集合（Agent 稳定能力窄面） */
  private readonly deps: ContextPreparerDeps;
  /** 后台 Provider（可变，setBackgroundProvider 运行时切换） */
  private backgroundProvider: LlmProvider | null;

  constructor(deps: ContextPreparerDeps) {
    this.deps = deps;
    this.backgroundProvider = deps.backgroundProvider;
  }

  /**
   * 同步后台 Provider（与 roundSummaryGenerator / sessionArchiver 统一消费模式）
   * @param provider 新后台 Provider（可 null 表示关闭）
   */
  setBackgroundProvider(provider: LlmProvider | null): void {
    this.backgroundProvider = provider;
  }

  /**
   * 当前激活的 L2 行为策略（SSOT：与 Agent.getActiveStrategy 同源推导）
   * @returns 激活角色包策略，未激活/无管理器时回退全局默认
   */
  private getActiveStrategy(): BehaviorStrategy {
    return this.deps.rolePackManager?.getActive()?.strategy ?? DEFAULT_BEHAVIOR_STRATEGY;
  }

  /**
   * 角色包自动匹配（粘性，角色包唯一入口）：在 chat() 回答前经 RolePackManager.autoMatch 粘性语义匹配——
   * 首次外部输入命中即锁定当前会话，后续仅互斥包命中才切换；命中后经 switchRolePack 激活并刷新前缀。
   * 关键词未命中时尝试 LLM 辅助语义匹配（低置信度兜底）。
   *
   * @param input 用户输入
   * @returns 是否发生角色切换
   */
  async tryAutoMatchRolePack(input: string): Promise<boolean> {
    const rpm = this.deps.rolePackManager;
    if (!rpm) return false;

    // 第一层：关键词高置信度匹配（含粘性锁定副作用）
    const matched = rpm.autoMatch(input);
    if (matched) {
      return this.deps.switchRolePack(matched);
    }

    // 第二层：LLM 辅助语义匹配（低置信度兜底，需 backgroundProvider）
    const bgProvider = this.backgroundProvider;
    if (bgProvider && rpm.activeName) {
      const llmMatched = await this.matchRolePackByLlm(input);
      if (llmMatched && llmMatched !== rpm.activeName) {
        return this.deps.switchRolePack(llmMatched);
      }
    }

    return false;
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
    const strategy = this.getActiveStrategy();
    let recalledMemories: Memory[] = [];

    // ── 上下文预算：动态预算装配（role-pack-spec §C） ──
    // 容量来源：maxContextTokens（优先 provider contextWindow，缺失降级）；固定开销取 system prompt；
    // 顶级锚点 = 触发输入 + 首个回答预留（独立划块，永不压缩）；完整对话层从最近往回塞到 ~90% 止
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

    return recalledMemories;
  }

  /**
   * LLM 辅助角色包语义匹配
   *
   * 构建角色清单提示，让 backgroundProvider 流式输出最匹配的角色包名；仅接受列表内确切名称。
   *
   * @param input 用户输入
   * @returns 匹配到的角色包名，无匹配返回 null
   */
  private async matchRolePackByLlm(input: string): Promise<string | null> {
    const rpm = this.deps.rolePackManager;
    if (!rpm) return null;
    const bgProvider = this.backgroundProvider;
    if (!bgProvider) return null;

    try {
      const metaList = rpm.listMeta();
      if (metaList.length === 0) return null;

      // 构建提示：让 LLM 选择最匹配的角色包
      const roleList = metaList
        .map((m) => `${m.name}：${m.description ?? m.displayName ?? ''}`)
        .join('\n');
      const messages = [
        {
          role: 'system' as const,
          content: `根据用户输入，从以下角色中选择最合适的角色（只输出角色名，不要其他内容）：\n\n${roleList}`,
        },
        { role: 'user' as const, content: input },
      ];

      // 流式获取 LLM 响应
      const stream = bgProvider.chat(messages, { maxTokens: 10, temperature: 0.1 });
      let response = '';
      for await (const chunk of stream) {
        if (chunk.content) response += chunk.content;
      }
      const matchedName = response.trim();
      if (matchedName && metaList.some((m) => m.name === matchedName)) {
        return matchedName;
      }
    } catch (err) {
      logger.warn({ err }, 'LLM 辅助角色包匹配失败');
    }
    return null;
  }
}
