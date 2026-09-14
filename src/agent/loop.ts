/**
 * turn（问答闭环）Act 引擎（AgentLoop）— turn 回答中阶段的 loop（对 step 的编排，官方 Agent Loop 本义）
 *
 * 概念定位（2026-09-04 收敛：档2 多 turn 任务编排已砍，所有复杂度在单 turn step 循环里承载）：
 *   - step = 一次 LLM 调用 + 可选工具执行（runIterationLoop 内每次循环体）；
 *   - loop = 对 step 的编排：turn 回答中阶段反复拉起 step 直到输出最终回答；
 *   - 本类承载 turn（问答闭环）的 Act 引擎（含 loop=step 编排），是 turn 的身体引擎；
 *   - 复杂任务（task_table_write + 动态规划）在一个 turn 的 step 循环里自然生长，
 *     不再强制拆成多 turn 编排（收敛依据见 docs/architecture/agent-design-philosophy.md 第一章 闭环）；
 *   - 上下文 = 用户输入 + Agent 记忆召回结果 + 运行帧追加。
 */
import type { LlmProvider, Message, ChatOptions } from '@/llm/provider.js';
import type { ProviderRouter, TaskType } from '@/llm/types.js';
import type { Memory } from '@/memory/types.js';
import type { ToolDefinition } from '@/agent/toolExecutor.js';
import { ASK_USER_TOOL, COMPRESS_CONTEXT_TOOL, REMEMBER_INTEL_TOOL } from '@/agent/builtinTools.js';
import type {
  AgentChunk,
  UIMessages,
  PreExecutionResult,
  TextChunkStage,
  AskQuestion,
} from '@/agent/types.js';
import type { ITracer, AgentMetrics } from '@/agent/tracer.js';
import type { ContextBudget, ContextOccupancy } from '@/agent/budget.js';
import { AGENT_CONSTANTS, LOOP_CONSTANTS } from '@/agent/constants.js';
import { ContextManager } from '@/agent/contextManager.js';
import { NOOP_TRACER, TRACE_SPANS } from '@/agent/tracer.js';
import { isTimeoutAbortSignal } from '@/utils/errors.js';
import { toError } from '@/utils/toError.js';
import { roundTo } from '@/utils/math.js';
import { sha256Fingerprint } from '@/utils/hash.js';
import { logger } from '@/logging/logger.js';
import type { ICompactionStrategy } from '@/agent/compaction.js';
import {
  ResultReplacementStrategy,
  ReplaceRoundsStrategy,
  DEFAULT_REPLACE_KEEP_RECENT_ROUNDS,
} from '@/agent/compaction.js';
import { offloadLargeToolResult } from '@/agent/toolResultOffload.js';
import { deriveDialogueRounds } from '@/agent/budget.js';
import {
  parseAskCalls,
  wrapToolResult,
  isRetryableToolError,
} from '@/agent/managers/toolCallHelpers.js';
import { LlmCaller } from '@/agent/managers/llmCaller.js';
import type { LlmCallResult } from '@/agent/managers/llmCaller.js';
import { LoopMetrics } from '@/agent/managers/loopMetrics.js';
import type { DuplicateCallInterceptor, DuplicateCheckContext } from '@/agent/types.js';
import { DefaultDuplicateCallInterceptor } from '@/agent/duplicateInterceptor.js';
import {
  ToolResultCache,
  DEDUP_SUBJECT_EXTRACTORS,
  formatDedupSubject,
  normalizePathKey,
  type CacheEntry,
} from '@/agent/toolResultCache.js';
import {
  FileExposureLedger,
  parseReadFileCoverage,
  formatLedgerStub,
  shouldEchoLedgerStub,
  READ_DIGEST_CHARS,
} from '@/agent/toolLedger.js';
import type { L2RuntimeStrategy } from '@/role-pack/types.js';
import { DEFAULT_L2_STRATEGY } from '@/role-pack/strategyResolver.js';
import { DEFAULT_MAX_ITERATIONS } from '@/role-pack/strategyKeys.js';
import { ToolRunner } from '@/agent/toolRunner.js';
import { detectNeedsPlanning, PLAN_NUDGE_PROMPT } from '@/agent/needsPlanning.js';

/** P0-2 失败硬闸的主体 key（工具名 + 规范化 path/query）：同主体连续失败计数用，粒度=同参（N2 修正） */
function failureSubjectKey(toolName: string, subject: CacheEntry['subject']): string {
  return `${toolName}\u0002${subject.path ?? ''}\u0002${subject.query ?? ''}`;
}

export interface AgentLoopOptions {
  provider: LlmProvider;
  /** Provider 路由选择器（多模型路由基础，可选） */
  providerRouter?: ProviderRouter;
  bootstrapMemories: Memory[]; // 永驻 + 领域记忆
  toolExecutor: (name: string, args: string) => Promise<string>;
  maxIterations?: number;
  /** 系统 prompt 前缀（角色包 prompt），注入到 bootstrap 记忆之前 */
  systemPromptPrefix?: string;
  /**
   * 当前激活角色包底盘占用（system prompt 总体 token），装配时即确定。
   * 早于 prepare 写入，使冷启动 / 重启首屏即可显示真实占比；prepare 期以其实际值覆盖，口径一致。
   */
  rolePackBaseTokens?: number;
  /** 情感基调前缀，插在 systemPromptPrefix 与 bootstrapMemories 之间（injectAffect 设置，角色切换时保留） */
  affectPrefix?: string;
  /** 任务表触发覆盖钩子（2026-09-14 层1）：宿主可覆写 needsPlanning 判定。
   *  缺省用内核内置 detectNeedsPlanning（确定性判定）。返回 true → 首迭代注入命令式强引导。 */
  needsPlanningOverride?: (text: string) => boolean;
  /** 工具定义列表（内置 + 自定义），用于 system prompt 追加工具描述 */
  toolDefinitions?: ToolDefinition[];
  /** 内置工具定义列表，仅含内置工具，供只读模式（toolReadonly）查询 readonly 标记 */
  builtinTools?: ToolDefinition[];
  /** 上下文窗口 token 上限（默认 120_000）。估算 token 超此阈值时裁剪中间段，
   *  仅保留 system prompt + 最近 N 条消息，防上下文溢出。 */
  maxContextTokens?: number;
  /** 可观测性 Tracer（宿主注入，默认 NOOP_TRACER 静默丢弃所有 span） */
  tracer?: ITracer;
  /** Reflection 最大重试次数（默认 2）。工具失败且错误码 retryable 时回传 LLM 重试，超限放弃 */
  maxReflectionRetries?: number;
  /** 宿主可覆盖的 UI 消息文本（默认英文） */
  messages?: UIMessages;
  /** 上下文超限时是否自动生成摘要（默认 true）。会调 provider 为被裁剪消息生成摘要注入
   *  系统提示，避免关键信息丢失（首次触发约 +1-2s 延迟） */
  enableContextSummary?: boolean;
  /** 上下文截断回调（传被裁剪/保留消息数），宿主可据此发 contextTruncated 事件；未注入静默忽略 */
  onContextTruncated?: (skippedCount: number, keptCount: number) => void;
  /** LLM 主动压缩完成回调（第二级压缩，传压缩目标/被替换消息数/摘要长度）；未注入静默忽略 */
  onContextCompressed?: (
    target: 'earliest_round' | 'largest_tool_result',
    replacedCount: number,
    summaryLength: number,
  ) => void;
  /** 工具执行完成回调（供 outbox 模式恢复时判断工具是否已执行过，避免重复执行）；未注入静默忽略 */
  onToolExecuted?: (name: string, args: string, result: string, ok: boolean) => void;
  /** 工具执行前检查回调（宿主闸门）。三态：放行（可携 overrideArgs 改写参数）/ 跳过
   * （返回 previousResult 幂等去重）/ 拒绝（阻止执行）；未注入时正常执行 */
  preExecutionCheck?: (name: string, args: string) => PreExecutionResult;
  /** 主动提问回调（回答中 LLM 调 ask_user 工具时调用，loop 只回调不处理 UI） */
  onPendingQuestion?: (questions: AskQuestion[]) => void;
  /** 已存轮次摘要加载器。截断生成摘要前优先取持久化 round-summary（零成本保真），仅无已存时才现调 LLM */
  roundSummaryLoader?: () => string;
  /** 截断时最少保留的最近原始对话轮数（默认 0），宿主可据 provider prompt caching 能力放宽 */
  minRecentRounds?: number;
  /** ChatOptions 覆盖项（角色包策略注入 temperature/outputLimit 等，优先于默认值） */
  chatOptions?: Partial<ChatOptions>;
  /** 上下文压缩策略（微压缩层，每轮把旧 tool_result 替换为占位符省空间）；
   *  默认 ResultReplacementStrategy（保留最近 3 次完整结果），宿主可注入自定义策略。
   *  作为两级空间管理的**第二级**（tool_result 占位）参与压缩链 */
  compactionStrategy?: ICompactionStrategy;
  /** 已存轮次摘要按 roundId 取（替换式压缩第一级用）；未注入时替换层降级为 no-op（返回 null） */
  getRoundSummary?: (roundId: string) => string | null;
  /** 替换式压缩保留最近正文轮数（默认 DEFAULT_REPLACE_KEEP_RECENT_ROUNDS=5，LRU 最早先换） */
  replaceRoundsKeepRecent?: number;
  /** 工具结果卸载（入口关）的落盘目录（装配注入项目 `memoraDir` 下的 outputs 子目录）。
   *  未注入则入口关不生效（超阈结果原样入上下文）——内核不派生此路径，防产出信任根外、
   *  `read_file` 读不回的假引用（OFFLOAD-1 教训） */
  offloadDir?: string;
  /** 重复工具调用拦截器。每轮工具执行后调用 check() 决定注入 warning 或 block；
   *  未注入时用 DefaultDuplicateCallInterceptor（哈希机械检测），宿主可注入差异化策略 */
  duplicateCallInterceptor?: DuplicateCallInterceptor;
}

/**
 * step 边界气口申请——统一三种用户申请的气口语义（SSOT 收敛）：
 *  旧设计分散为 pauseRequested flag + pendingInterjections[] 数组。2026-09-06 收敛为单一队列：
 *    - pause：宿主 requestPause → queueInterrupt({kind:'pause'})
 *    - interject：宿主 interject → queueInterrupt({kind:'interject', content})
 *    - ask_user 不走此队列（它是 LLM 工具触发的气口，在工具分支直接 yield paused，与用户申请气口不同源）
 *
 * 消费方 = _handleInterrupt：step 边界统一 queue.splice(0) 取出全部申请，
 * 先注入型（interject → appendUser）后挂起型（pause → yield paused）。
 */
type InterruptRequest =
  | { readonly kind: 'pause' }
  | { readonly kind: 'interject'; readonly content: string };

/** 情报区（LLM 私有工作笔记）system 消息前导：注入起点判定 + 私有/禁复述约束（与返回字段同源） */
const INTEL_INTRO =
  '[情报区 · 仅供你私有查看并作为后续作答的参考]。此区内容不要向用户复述或写进项目文档。' +
  '当你从大文本/工具结果获取到新的关键信息时，可用一句简短状态反馈用户进展（如：原来是这样… / 掌握了关键信息 / ' +
  '有一个问题… / 基本收集完毕），但不要在反馈中复述笔记/原文细节。';

export class AgentLoop {
  private messages: Message[] = [];
  private readonly maxIterations: number;
  /** 上下文窗口 token 上限（默认 120_000，对齐 AGENT_CONSTANTS.DEFAULT_MAX_CONTEXT_TOKENS）。
   *  非 readonly：模型热切换（Agent.setContextWindow）经 setContextWindow 同步。 */
  private maxContextTokens: number;
  /** 可观测性 Tracer（默认 NOOP_TRACER 零开销） */
  private readonly tracer: ITracer;
  /** Reflection 最大重试次数（默认 2） */
  private readonly maxReflectionRetries: number;
  /** 上下文压缩策略（微压缩层），默认 ResultReplacementStrategy，经 options 可注入自定义策略 */
  private readonly compactionStrategy: ICompactionStrategy;
  /** 重复工具调用拦截器实例，默认 DefaultDuplicateCallInterceptor（哈希机械检测） */
  private readonly duplicateCallInterceptor: DuplicateCallInterceptor;
  /** 重复工具调用检测阈值（默认 3 次，供拦截器 context 使用） */
  private readonly duplicateToolCallThreshold: number;
  /**
   * 执行期临时 system 消息引用集（self-review / reflection / duplicate-warning / metaNote）。
   * 与 prepare 阶段的「装配性注入」（召回、最近对话）区分：装配注入每轮由 prepare 重建、
   * 不算临时，吃 cleanTemporarySystemMessages；执行期临时的清理收敛为每轮闭环入口自动执行
   * （cleanExecutionTemporary），保证跨步残留不堆积。replaceContext 走浅拷贝，
   * 引用保持有效，按引用 filter 即可安全移除。
   */
  private readonly executionTempSystem = new Set<Message>();
  /** 上一轮工具调用的哈希（运行时状态，拦截器判定时使用） */
  private lastToolCallsHash: string = '';
  /** 连续重复次数（运行时状态，拦截器判定时使用） */
  private duplicateToolCallCount: number = 0;
  /** 当前迭代序号（processUserInput 循环内维护，供拦截器 context 使用） */
  private currentIteration: number = 0;
  /** 当前轮次已推送的 REFLECTION_HINT 次数。用显式计数器而非 filter 推断，
   *  避免上下文中段消息被裁剪后计数失真 */
  private reflectionCountThisTurn: number = 0;
  /** TS-7 搜索收敛护栏：本闭环内成功 web_search 次数（executeToolCalls 累计，_prepareContext 检查） */
  private successfulWebSearchCount = 0;
  /** TS-7 搜索收敛护栏：本轮是否已注入收敛提示（幂等，防迭代累积刷屏） */
  private searchConvergenceHintInjected = false;
  /** TS-7 搜索硬上限：本闭环内 web_search 调用次数（含被拒绝的，达到上限后后续搜索直接拒绝） */
  private searchCallCount = 0;
  /** TS-7 搜索硬上限命中后：从后续 LLM 调用的工具集确定性移除 web_search（双闸的第二闸，
   *  与 system 提示互补，彻底终结「拒绝风暴」耗尽迭代/上下文导致问答闭环中断） */
  private searchDisabled = false;
  /** TS-7 搜索硬上限提示注入标记（幂等，防迭代累积重复注入） */
  private searchDisabledHintInjected = false;
  /** 软上限收尾信号注入标记（幂等，防迭代累积刷屏）：摘要层饱和是跨迭代持续态，
   *  同一 turn 内经本 flag 最多注入一次收尾信号；随 resetTurnState 重置——
   *  每个新 turn（新用户输入）重新注入一次（每轮回答都需要收敛提醒），
   *  防的是「同 turn 多步迭代各注一条」的刷屏（V1 修复，口径与搜索收敛 flag 同构）。 */
  private softLimitWrapupInjected = false;
  /** 层1（2026-09-14）：本 turn 是否判定为需任务表规划（processUserInput 入口由检测结果设值，
   *  continueAfterPause 续跑不重判——plan 已建则无需 nudge） */
  private planNeedsNudge = false;
  /** 层1：本 turn 是否已注入命令式引导（幂等，仅首迭代一次，随 resetTurnState 重置） */
  private planNudgeInjected = false;
  /** 工具结果防重缓存（闭环内有效，每轮 resetTurnState 清空）。
   *  拦截 read_file/list_dir/web_search 的同 key 重复调用，返回 [ALREADY_READ] 拒绝文案，
   *  终结 LLM 在同一批文件上反复轮询导致的死循环（token 爆炸 + maxIterations 撞线） */
  private readonly toolResultCache = new ToolResultCache();
  /** 文件覆盖度台账（账本・解耦侧）：读到的行区间 + 轻量替身摘要。
   *  闭环内有效（resetTurnState 清），与 toolResultCache 同生命周期。
   *  分支②据此在「原文已压缩」时回显摘要，而非放行重读（永动机）或空拦（死锁）。 */
  private readonly fileExposure = new FileExposureLedger();
  /** P0-2 同主体连续失败硬闸（N1 真 block / N2 同主体粒度）：subject-key → 连续失败次数。
   *  失败记录于结果处理循环；达阈值后前置拦截（执行前）返回 [READ_FAILED_LIMIT]，治幻觉文件重读风暴。 */
  private readonly infoToolFailureBySubject = new Map<string, number>();
  /** 软暂停请求标志——已收敛为 interruptQueue（2026-09-06）。private 读写器，内部消费点：
   *  _routePausedIfTimeoutAndPause（读）/ resetTurnState（清）/ requestPause/clearPauseRequest（写） */
  private get pauseRequested(): boolean {
    return this.interruptQueue.some((r) => r.kind === 'pause');
  }
  private set pauseRequested(v: boolean) {
    if (v) {
      // 置位：确保队列有 pause 条目（幂等，不重复追加）
      if (!this.interruptQueue.some((r) => r.kind === 'pause')) {
        this.interruptQueue.push({ kind: 'pause' });
      }
    } else {
      // 清除：过滤掉 pause 条目（保留 interject 条目）
      this.interruptQueue = this.interruptQueue.filter((r) => r.kind !== 'pause');
    }
  }
  /** step 边界气口申请统一队列（2026-09-06 收敛：替代 pauseRequested flag + pendingInterjections[]）。
   *  用户申请的气口（pause/interject）统一入队，_handleInterrupt 在 step 边界消费：
   *  先注入型（interject → appendUser），后挂起型（pause → yield paused）。 */
  private interruptQueue: InterruptRequest[] = [];
  /** 主动提问回调（LLM 调 ask_user 工具时调用，Agent 注入，loop 只回调不处理 UI） */
  onPendingQuestion?: (questions: AskQuestion[]) => void;
  /** 单工具执行器（独立可测单元；strategy/回调经闭包读最新） */
  private readonly toolRunner: ToolRunner;
  /** L2 运行时策略（单一策略对象）。Agent 每轮经 setStrategy 注入，构造期默认 DEFAULT_L2_STRATEGY */
  private strategy: L2RuntimeStrategy = { ...DEFAULT_L2_STRATEGY };
  /** 本 turn 是否已执行过自审查（单次终审：布尔状态，不再需要轮次计数） */
  private selfReviewDone = false;
  /** 本 turn（processUserInput）内是否实际执行过工具步。
   *  自审查的唯一触发门槛：只有多轮 turn（发生过工具调用）才审查，
   *  一遍过的纯文本问答不触发。由 processUserInput 入口重置（续跑 continueAfterPause 保留）。
   */
  private toolExecutedThisTurn = false;
  /** 当前轮次 ID（processUserInput 入口分配一次，各 iteration 共享），用于溯源式摘要 */
  private currentRoundId = '';
  /** 是否正处于自主工具步执行中（内核自用：resumeExecution 预判短路 / canContinueWithoutInput；宿主零消费） */
  private inAutonomousStep = false;
  /* 策略类字段（toolCallsBlocked/toolStepLimit/errorHandling/providerRouting 等）定义在
   * 单一 L2RuntimeStrategy 对象（见上方 strategy），读取统一走 this.strategy.<field> */
  /** step 边界回调——每次迭代（=step）完成时调用（传 assistant 摘要，step 级推进记录；
   *  planStepId 由消费方自查 active step，loop 不传——签名不再留空头支票） */
  onStepBoundary?: (stepInfo: { summary: string }) => void;
  /** 任务表获取回调——每次迭代 LLM 调用前调用，返回任务表文本（空字符串=无任务表） */
  getTaskTable?: () => string;
  /** active step 元信息回调（阶段二，2026-09-08 步级折叠路 B′）：loop 每次迭代完成时调用，
   *  返回当前 active 任务表步骤 { stepId, title }；无任务表/无 active step 返回 null。
   *  与 onStepBoundary 搭配：onStepBoundary 只管写 stepLog（推进投影），本回调供 loop 判断
   *  「active step 是否已推进」，变化才产 step_boundary 事件（宿主据此按步分组渲染）。 */
  getActiveStepMeta?: () => { stepId?: string; title?: string } | null;
  /** 上一步级边界 ID（阶段二去噪）：记录最近一次已 emit step_boundary 的 stepId，
   *  仅当 getActiveStepMeta 返回的 stepId 变化时才产新事件；null/undefined 不产（无任务表静默）。 */
  private lastBoundaryStepId?: string;
  /** 主动提问计数（本 turn 粒度，resetTurnState 清零）：ask_user 工具触发次数（askLimit 硬护栏） */
  private askCountThisTurn = 0;
  /**
   * 在途提问登记（ask_user 工具轮挂起后、回答回填前）：记录各 ask_user 调用的 toolCallId
   * 与解析出的结构化问题。answerQuestion（正常作答）/ cancelAsk（跳过/兜底）二选一消费。
   */
  private pendingAsk: { toolCallIds: string[]; questions: AskQuestion[] } | undefined = undefined;
  /**
   * 已作答/已取消提问快照（G26，2026-09-07 answerQuestion 转存；2026-09-08 cancelAsk
   * 对称转存）：提问消费后把 pendingAsk.questions 转存于此，供 orchestrator.runResume
   * 落盘交互输入时随回答/超时记录一并持久化（回放还原「问了什么+选项」）。
   * pendingAsk 照旧即清（runIterationLoop:710 兜底 cancelAsk 依赖其为「未消费」判据）；
   * 快照由 runResume takeAnsweredAsk 取走，或下次消费覆盖（残留仅进程内、单 turn，无害）。
   */
  private lastAnsweredAsk: AskQuestion[] | undefined = undefined;
  /** 宿主可覆盖的 UI 消息文本（已填充默认值） */
  private readonly ui: Required<UIMessages>;
  /** 上下文超限时是否自动生成摘要 */
  private readonly enableContextSummary: boolean;
  /** LLM 主动压缩完成回调（第二级压缩，在 compressContext 成功后触发） */
  private readonly onContextCompressed: AgentLoopOptions['onContextCompressed'];
  /** 上下文管理器（从 loop 提取的 token 估算 + 截断 + 摘要职责） */
  private readonly contextManager: ContextManager;
  /** 被替换轮 roundId 集合（第一级替换把越界轮正文换成已存摘要；装配 exclude 据此防二次召回） */
  private readonly replacedRoundIds: Set<string> = new Set();
  /** 最近一次输入装配的上下文预算（prepare 期写入，供指标快照透出做预算可视化，④） */
  private lastBudget: ContextBudget | undefined;
  /** 最近一次输入装配的上下文占用快照（④ 预算可视化，真实用量） */
  private lastOccupancy: ContextOccupancy | undefined;
  /**
   * 当前激活角色包底盘占用（system prompt 总体 token）。
   * 装配 / 切换角色包时经 setRolePackBaseTokens 写入（早于 prepare，冷启动即可用），
   * prepare 期 recordOccupancy 也以其实际值覆盖，口径一致（同一 estimateTokensMessages 估算器）。
   */
  private rolePackBaseTokens: number | undefined;
  /** 最近一次 _prepareContext 是否发生截断重排（替换层据此跳过——截断提取 key messages 重插中间，roundId 尾部对齐失效） */
  private isLastContextTruncated = false;
  /** 两级空间管理压缩链（第一级替换 → 第二级 tool_result 占位）。超大结果卸载已在入口关处理，不在链上 */
  private readonly compactionStrategies: ICompactionStrategy[];
  /** 入口关落盘目录（装配注入；未注入则入口关不生效）。消费点：appendToolMessage */
  private readonly offloadDir?: string;
  /** 情报区（LLM 私有工作笔记，Step 2）：LLM 经 remember_intel 自写累积，装配时作为尾部私有 system 消息注入 */
  private intelNote = '';
  /** Provider 路由缓存（单轮内缓存同一 taskType，避免每轮重复路由计算），跨轮清空不复用 */
  private providerRouteCache = new Map<TaskType, LlmProvider>();

  // ─── 运行时指标统计 ──────────────────────────────
  private metrics = new LoopMetrics();

  /** LLM 调用族执行器（ARCH-3 P3-2）。**必须在构造函数尾部初始化**——依赖 `contextManager` /
   *  `tracer` 等构造期赋值的字段（类字段初始化器按声明顺序执行，此处读会得到 undefined）。
   *  其所有 loop 侧能力均为**取值器 / 回调**：`strategy`（setStrategy 换对象）、
   *  `opts.provider`（setProvider 热切换）、`toolExecutedThisTurn`（同 turn 内 set true）
   *  皆运行时可变量，且 `errorHandling` 在重试循环内被读 3 次。
   *  `providerRouteCache` 仍是 loop 字段（每轮 turn 入口清空），本类只经回调读写。 */
  private llmCaller!: LlmCaller;

  constructor(private readonly opts: AgentLoopOptions) {
    // 内核兜底迭代上限：默认值引用 role-pack/strategyKeys.DEFAULT_MAX_ITERATIONS。
    // 迭代 = 一次 LLM call + N 并行工具。50 足以覆盖复杂多步任务。
    // 真正的迭代上限由 runIterationLoop 入口动态计算 effectiveMax：
    //   strategy.stepBudget > 0 → 角色包声明的步数预算（配多少给多少）
    //   strategy.stepBudget = 0 → 这里的 maxIterations 兜底
    this.maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    this.maxContextTokens = opts.maxContextTokens ?? AGENT_CONSTANTS.DEFAULT_MAX_CONTEXT_TOKENS;
    this.tracer = opts.tracer ?? NOOP_TRACER;
    this.maxReflectionRetries = opts.maxReflectionRetries ?? 2;
    this.compactionStrategy =
      opts.compactionStrategy ??
      new ResultReplacementStrategy(
        // P1 摘要替代：默认压缩策略下，read_file 结果被压缩链清出时替换为它**自己的**台账摘要（非空占位）。
        // 无摘要（未触发脚注 / 小文件读到底）→ 回调返回 undefined → 回退空占位。
        undefined,
        (path) => {
          const cov = this.fileExposure.get(normalizePathKey(path));
          return cov ? formatLedgerStub(cov) : undefined;
        },
      );
    // 入口关落盘目录（大文本统一通道 §6.2）：消费点在 appendToolMessage，不挂压缩链
    this.offloadDir = opts.offloadDir;
    // 两级空间管理压缩链：第一级替换（LRU 内核自动，取已存摘要，无摘要 no-op）→
    // 第二级 tool_result 占位（宿主注入或默认 ResultReplacementStrategy）。
    // 注：超大工具结果卸载**已在入口关处理**（appendToolMessage，门前换鞋），
    // 故不再有第三级「卸载档」——上下文中 tool 消息只由该写点产生，事后扫描恒不触发
    // （⛔ 勿恢复为压缩链一级：那会与入口关构成同语义两处实现，见探索方案 §6.2 结论二）。
    this.compactionStrategies = [
      new ReplaceRoundsStrategy({
        keepRecentRounds: opts.replaceRoundsKeepRecent ?? DEFAULT_REPLACE_KEEP_RECENT_ROUNDS,
        // 未注入 getRoundSummary 时降级为 no-op（返回 null，替换层不生效）
        getSummary: opts.getRoundSummary ?? (() => null),
        // 被替换轮记账：装配 exclude 据此防二次召回（装配时间线互斥）
        onReplaced: (roundId) => {
          this.replacedRoundIds.add(roundId);
        },
        // 截断重排后上下文已被摘要/关键消息重组 → 替换层跳过（空间维护交回截断机制；
        // roundId 现已随消息携带，跳过仅为作用于裁剪视图时的安全冗余）
        isContextTruncated: () => this.isLastContextTruncated,
      }),
      this.compactionStrategy,
    ];
    this.duplicateCallInterceptor =
      opts.duplicateCallInterceptor ?? new DefaultDuplicateCallInterceptor(3);
    // N3 排雷修正：阈值取拦截器自身（宿主注入自定义阈值时文案/硬闸/context.threshold 同步），未实现回落默认 3
    this.duplicateToolCallThreshold = this.duplicateCallInterceptor.getThreshold?.() ?? 3;
    this.onPendingQuestion = opts.onPendingQuestion;
    this.ui = {
      abortedByUser: opts.messages?.abortedByUser ?? 'User cancelled the conversation',
      abortedByTimeout: opts.messages?.abortedByTimeout ?? 'LLM request timed out (no response)',
      maxIterationsReached: opts.messages?.maxIterationsReached ?? '\n\n[Max iterations reached]',
      // 流式中断标记：含断点摘要，让 LLM 明确"以上已输出，请继续不重复"（SSOT：默认文案下沉 LOOP_CONSTANTS）
      interrupted: opts.messages?.interrupted ?? LOOP_CONSTANTS.DEFAULT_INTERRUPTED_MARK,
      contextTruncated:
        opts.messages?.contextTruncated ??
        ((skipped, kept) =>
          `[Context window management] ${skipped} earlier messages have been trimmed to maintain conversation flow. ${kept} recent messages are preserved along with the full system prompt. Ask the user if you need to review earlier content.`),
      // 软上限收尾信号（摘要层达容量上限时注入）：LLM 收敛产出最终交付，不再调用工具
      softLimitWrapup:
        opts.messages?.softLimitWrapup ??
        '\n\n[SOFT_LIMIT] 上下文空间已接近容量上限，正文已被大量摘要化（摘要层已饱和）。' +
          '请立即收敛：基于现有内容产出最终交付与结论，不要再调用工具。' +
          '如需回溯细节，可先调用 trace_summary 再收敛。',
      recentConversationLabel: opts.messages?.recentConversationLabel ?? '[Recent conversation]',
      userLabel: opts.messages?.userLabel ?? 'User',
      assistantLabel: opts.messages?.assistantLabel ?? 'Assistant',
      reflectionHint:
        opts.messages?.reflectionHint ??
        ((remaining: number) =>
          `[REFLECTION_HINT] 上次工具调用失败，错误可重试。请分析错误原因，修正参数后重新调用工具。剩余反思次数：${remaining}`),
      selfReviewPrompt:
        opts.messages?.selfReviewPrompt ??
        (() => `[SELF_REVIEW] 请基于**可验证的确定性判据**核查你上一条回复（而非泛化的自我评价——防"自说自话"）。检查：
1. 本轮目标点是否全部覆盖（用户明确要求的内容是否都处理了）？
2. 是否遵守了 Rules 中的安全/边界约束（如"不写敏感信息"）？
3. 产出结构是否完整（正文/代码/文档是否齐全）？
4. 如有可运行项（格式/测试/语法），是否通过？

只有存在可验证判据时才审查；无明确判据时不强行修改。

输出格式（必须遵守）：
- 满意：只输出一句简短确认（如"无需修改"），**严禁重复输出完整回答**。
- 存在必须改进的判据：才输出改进后的**一版**完整回复，不要附加说明。`),
      duplicateToolCallWarning:
        opts.messages?.duplicateToolCallWarning ??
        ((threshold: number) =>
          `[DUPLICATE_TOOL_CALL_WARNING] 你已连续 ${threshold} 次调用相同工具 + 相同参数，可能陷入死循环。请分析工具结果，改变策略：调整参数、换用其他工具，或直接给出文本回复。`),
      // LLM 空响应兜底（无文本无工具调用时使用；与多数 ui 字段一致默认英文，宿主可经 messages 覆盖）
      emptyResponseFallback:
        opts.messages?.emptyResponseFallback ??
        'The model returned an empty response. Please try again or ask in a different way.',
    };
    this.enableContextSummary = opts.enableContextSummary ?? true;
    this.onContextCompressed = opts.onContextCompressed;

    // 上下文管理器（token 估算 + 截断 + 摘要，注入 tracer/providerRouter 供摘要走 summary 路由）
    this.contextManager = new ContextManager({
      maxContextTokens: this.maxContextTokens,
      provider: opts.provider,
      providerRouter: opts.providerRouter,
      contextTruncatedFn: this.ui.contextTruncated,
      tracer: this.tracer,
      onContextTruncated: opts.onContextTruncated,
      roundSummaryLoader: opts.roundSummaryLoader,
      minRecentRounds: opts.minRecentRounds,
    });

    // 初始化 system prompt（基于永驻记忆，加前缀）
    const prefix = opts.systemPromptPrefix ?? '';
    this.appendSystemMessage(prefix + this.buildSystemPrompt(opts.bootstrapMemories));
    // 角色包底盘占用（装配时即确定，早于 prepare）：取 opts 透传的装配真值
    if (opts.rolePackBaseTokens !== undefined) {
      this.rolePackBaseTokens = opts.rolePackBaseTokens;
    }

    // 单工具执行器：注入 loop 稳定能力窄面，strategy 经闭包读最新（setStrategy 动态生效）
    this.toolRunner = new ToolRunner({
      execute: (name, args) => this.opts.toolExecutor(name, args),
      builtinTools: opts.builtinTools,
      preExecutionCheck: opts.preExecutionCheck,
      onToolExecuted: opts.onToolExecuted,
      getStrategy: () => this.strategy,
      tracer: this.tracer,
    });

    // LLM 调用族执行器（构造期最后初始化，确保 contextManager / tracer 已就绪）
    this.llmCaller = new LlmCaller({
      metrics: this.metrics,
      getStrategy: () => this.strategy,
      getProvider: () => this.opts.provider,
      getProviderRouter: () => this.opts.providerRouter,
      getCachedProvider: (taskType) => this.providerRouteCache.get(taskType),
      setCachedProvider: (taskType, provider) => this.providerRouteCache.set(taskType, provider),
      contextManager: this.contextManager,
      tracer: this.tracer,
      hasToolExecutedThisTurn: () => this.toolExecutedThisTurn,
    });
  }

  /**
   * 处理一轮用户输入（编排方法：单次迭代/工具分支/纯文本结束）
   *
   * 记忆检索唯一入口 = LLM 经 `search_memories` 工具主动触发（builtinToolHandlers.searchMemories），
   * 非由 prepare/loop 代模型猜测注入——原 recalledMemories 参数已于 2026-09-11 物理删除。
   *
   * @param userInput - 用户输入
   * @param signal - 可选 AbortSignal，宿主导入 controller 触发取消
   * @param roundId - 外部已分配轮次 ID（保证 user/assistant/摘要同 roundId），未传自生成
   */
  async *processUserInput(
    userInput: string,
    signal?: AbortSignal,
    roundId?: string,
  ): AsyncGenerator<AgentChunk, void, unknown> {
    // 任务级 SLO 追踪：记录任务开始时间
    const taskStartAt = Date.now();
    // 标记任务进行中
    this.metrics.taskTotalCount++;
    // 任务是否成功（默认失败，runIterationLoop 正常完成后置为成功）
    let taskSucceeded = false;

    // 创建顶层 response span，由 try/finally 统一管理生命周期
    const responseSpan = this.tracer.startSpan(TRACE_SPANS.RESPONSE, {
      inputLength: userInput.length,
    });

    try {
      // 分配当前轮次 ID（优先采用调用方传入的 roundId，保证 appendUser/appendAssistant/摘要同源同值；未传自生成）
      this.currentRoundId = roundId ?? this.allocRoundId();

      // 清空 Provider 路由缓存（单轮内复用，跨轮重置）
      this.providerRouteCache.clear();

      // 闭环入口自动清理执行期临时残留（上轮 self-review/reflection/duplicate 等）
      // （装配注入「最近对话」不属于 executionTemp，不受影响）
      this.cleanExecutionTemporary();

      // 用户消息 push（用 <user_input> 标签包裹，增强 LLM 对注入攻击的免疫力，受控写入口统一包裹）
      this.appendUserMessage(userInput);

      // 重置本轮运行计数状态（反思/重复检测/软暂停/自审查/工具步，每轮独立）
      this.resetTurnState();
      // 新增问题入口清理残留补充输入（对称缺口修复，2026-09-06）：
      // abort/host close 等异常路径可能让上一轮 interject 残留 interruptQueue，若不清，
      // 会被本 turn 首 step 边界 _handleInterrupt 误消费注入到新问题。
      // 不能在 resetTurnState 清——它也被 continueAfterPause 复用，会误杀「暂停后 interject → resume 注入」
      // 的合法语义（loop.test「暂停后 interject()」用例验证）；只在新问题入口清。
      this.clearPendingInterjections();
      // askLimit 计数按「一次用户输入」重置（turn 粒度：暂停-续跑跨续跑累计）——仅入口清，
      // continueAfterPause 不清（防续跑段被重复允许提问）
      this.resetAskBudget();
      // 层1：任务表规划判定（在 resetTurnState 之后设值——续跑入口复用 resetTurnState 会清为 false，
      // 故此处重判为新 turn 的确定性结论；continueAfterPause 不复用，plan 已建无需 nudge）
      this.planNeedsNudge = this.opts.needsPlanningOverride
        ? this.opts.needsPlanningOverride(userInput)
        : detectNeedsPlanning(userInput);

      // 单轮 step 循环（runIterationLoop）：本 turn 的 step 编排执行引擎，stepBudget 软上限与 maxIterations 兜底在此收敛；
      // 所有复杂度（含 LLM 动态建任务表、会议机制角色切换）在一个 turn 内承载（2026-09-04 收敛：多 turn 编排已砍）。
      // 经 withRound 附加当前 turn roundId（SSOT：过程事件归属由内核唯一提供）
      taskSucceeded = true;
      yield* this.withRound(this.runIterationLoop(signal));
    } catch (err) {
      // 任务级 SLO：捕获未处理异常，标记任务失败
      taskSucceeded = false;
      throw err;
    } finally {
      // 任务级 SLO 度量：记录耗时与结果
      const durationMs = Date.now() - taskStartAt;
      this.metrics.taskTotalDurationMs += durationMs;
      if (taskSucceeded) {
        this.metrics.taskSuccessCount++;
      } else {
        this.metrics.taskFailureCount++;
      }
      // 记录任务耗时到 response span
      responseSpan.setAttribute('taskDurationMs', durationMs);
      responseSpan.setAttribute('taskSucceeded', taskSucceeded);
      responseSpan.end();
    }
  }

  /**
   * 软暂停后续跑（在暂停边界后从保留的 this.messages 重新进入 step 循环引擎）
   *
   * 有补充输入时先 push 为 user 消息再续跑
   */
  async *continueAfterPause(
    input?: string,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentChunk, void, unknown> {
    // 任务级 SLO 追踪：记录任务开始时间
    const taskStartAt = Date.now();
    this.metrics.taskTotalCount++;
    let taskSucceeded = false;

    // 补充输入作为新 user 消息进入上下文（仅当有文本）
    if (input && input.trim()) {
      // 先清执行期临时残留，再接续跑输入，保证续跑上下文干净（与 processUserInput 入口一致）
      this.cleanExecutionTemporary();
      // 直接 appendUserMessage——不走 interruptQueue。
      // 语义区分：interruptQueue 是 loop 正在跑时的"申请入队，step 边界消费"机制；
      // 续跑时 loop 还没开始跑（generator 还没进入 while 循环），不存在"step 边界"这个消费时机，
      // 所以补充输入直接 appendUserMessage 入史即可，runIterationLoop 启动后第一轮 LLM 必看到。
      this.appendUserMessage(input);
    }
    // 重置本轮运行计数状态（与 processUserInput 一致），确保续跑干净
    this.resetTurnState();

    try {
      // 重新进入 step 循环引擎，从保留的 this.messages 续跑（续跑延续同一 turn roundId，经 withRound 附加）
      taskSucceeded = true;
      yield* this.withRound(this.runIterationLoop(signal));
    } catch (err) {
      taskSucceeded = false;
      throw err;
    } finally {
      // 任务级 SLO 度量：记录耗时与结果
      const durationMs = Date.now() - taskStartAt;
      this.metrics.taskTotalDurationMs += durationMs;
      if (taskSucceeded) {
        this.metrics.taskSuccessCount++;
      } else {
        this.metrics.taskFailureCount++;
      }
    }
  }

  /** 是否正处于自主工具步执行中（消费者 = agent.ts 预判短路/canContinueWithoutInput，内核内部） */
  get isInAutonomousStep(): boolean {
    return this.inAutonomousStep;
  }

  /**
   * 给子生成器的每个 chunk 附加当前 turn roundId（SSOT：过程事件归属由内核唯一提供）。
   * 宿主据此把 ProcessEvent 落盘到正确的 Round。
   * 两个 turn 入口（processUserInput / continueAfterPause）统一经此包装。
   */
  private async *withRound<T extends AgentChunk>(
    gen: AsyncGenerator<T, void, unknown>,
  ): AsyncGenerator<T, void, unknown> {
    for await (const chunk of gen) {
      yield { ...chunk, roundId: this.currentRoundId } as T;
    }
  }

  /** 设置 L2 运行时策略（与现策略浅合并）。默认值仅在策略解析层 resolveL2Strategy 归一，loop 不再兜底 */
  setStrategy(partial: Partial<L2RuntimeStrategy>): void {
    this.strategy = { ...this.strategy, ...partial };
  }

  /**
   * 请求在下一 step 边界挂起（软暂停申请入队）。
   * 委托 interruptQueue（pauseRequested setter 已实现幂等），step 边界由 _handleInterrupt 消费。
   * 仅挂起不 abort，可经 continueAfterPause 续跑——与硬停止（signal.abort 无法续跑）严格区分；
   * 暂停语义与持久化由状态机持有，本方法只控制挂起时机。
   */
  requestPause(): void {
    this.pauseRequested = true; // setter → interruptQueue push {kind:'pause'}（幂等）
  }

  /** 清除在途的软暂停申请（与 requestPause 对称：用户取消/流结束清理/暂停超时清扫共用）
   *  委托 interruptQueue 过滤掉 pause 条目（保留 interject 条目） */
  clearPauseRequest(): void {
    this.pauseRequested = false; // setter → interruptQueue filter
  }

  /** 插话（申请入队）：把用户补充输入作为 InterruptRequest{kind:'interject'} 入 interruptQueue。
   *  与 requestPause（queueInterrupt pause）同为「申请 → 气口生效」——不中断当前 LLM/工具执行，
   *  只在 step 边界统一消费（先注入型 → appendUser，后挂起型 → yield paused）。 */
  interject(content: string): void {
    this.interruptQueue.push({ kind: 'interject', content });
  }

  /** 删除待注入的插话（宿主 UI 层用户后悔）。与 interject 对称，在 step 边界消费前可安全删除。
   *  委托 interruptQueue 中 interject 条目的索引。
   *  index 越界时静默 no-op（宿主镜像数组和内核队列始终同序同长度，理论上不会越界）。
   *  @returns true=成功删除；false=index 越界或队列为空 */
  removePendingInterject(index: number): boolean {
    // 计算所有 interject 条目的全局索引映射
    const interjectIndices: number[] = [];
    this.interruptQueue.forEach((req, i) => {
      if (req.kind === 'interject') interjectIndices.push(i);
    });
    if (index < 0 || index >= interjectIndices.length) return false;
    const globalIdx = interjectIndices[index]!; // 已由边界检查保证非 undefined
    this.interruptQueue.splice(globalIdx, 1);
    return true;
  }

  /** 清空全部待注入插话（宿主「全部清空」按钮或 stop→discard 协同清理）。
   *  与 removePendingInterject 单条删除对称，覆盖宿主镜像与内核队列不对称缺口——
   *  宿主 clear_pending_queue handler 之前只清镜像不清内核（单写 bug）；
   *  agent.discardCurrentCheckpoint 之前只清 checkpoint 不清队列（孤儿数据 bug）。
   *  @returns 被清除的条目数（宿主可用于 notice 反馈） */
  clearPendingInterjections(): number {
    const cleared = this.interruptQueue.filter((r) => r.kind === 'interject').length;
    this.interruptQueue = this.interruptQueue.filter((r) => r.kind !== 'interject');
    return cleared;
  }

  /** 读取当前待注入插话队列快照（宿主渲染层只读镜像）。
   *  从 interruptQueue 中筛选 kind='interject' 并提取 content。
   *  返回副本而非原数组——宿主拿不到内核内部引用，防暗改。
   *  宿主 Phase 5 收敛：不再自己维护 _pendingQueue 镜像，每次渲染从内核读。 */
  getPendingInterjections(): readonly string[] {
    return this.interruptQueue
      .filter((r): r is Extract<InterruptRequest, { kind: 'interject' }> => r.kind === 'interject')
      .map((r) => r.content);
  }

  /** 输出"达到最大迭代/步数预算"提示并结束（turn act 收敛兜底，多入口共享） */
  private async *emitMaxIterationsReached(): AsyncGenerator<AgentChunk, void, unknown> {
    // 撞线收尾前消费排队插话（与 done 分支同一语义，2026-09-11 打磨）：
    // 步数已到顶不会再产生下一轮迭代去消费 interruptQueue，插话若不在此入史将被静默丢弃；
    // 消费为 user 消息后下一 turn 装配（最近对话）仍可见。pause 条目保留（无迭代边界可挂起，随 resetTurnState 清）
    const consumed = this._consumeInterjects(this.interruptQueue);
    this.interruptQueue = this.interruptQueue.filter((r) => r.kind !== 'interject');
    if (consumed > 0) {
      logger.debug({ consumed }, '步数触顶收尾前消费排队插话');
    }
    yield { type: 'text', content: this.ui.maxIterationsReached };
    yield { type: 'done' };
  }

  /** 重置本轮运行计数状态（反思/重复检测/软暂停/自审查/工具步，每轮独立；续跑入口同样调用） */
  private resetTurnState(): void {
    this.reflectionCountThisTurn = 0;
    this.lastToolCallsHash = '';
    this.duplicateToolCallCount = 0;
    this.inAutonomousStep = false;
    this.pauseRequested = false;
    this.selfReviewDone = false;
    // TS-14 每轮独立重置「工具步发生」标记（自审查触发门槛）：新问答闭环入口即续跑入口都复位，
    // 避免续跑段未执行工具却被上次的 true 触发自审查（消除 processUserInput 单独重置的 SSOT 漂移）
    this.toolExecutedThisTurn = false;
    // TS-7 搜索收敛护栏：本闭环内计数与注入标记随轮重置（下一闭环重新累计）
    this.successfulWebSearchCount = 0;
    this.searchConvergenceHintInjected = false;
    this.searchCallCount = 0;
    // 硬上限停搜标志随轮重置（下一闭环 web_search 重新可用）
    this.searchDisabled = false;
    this.searchDisabledHintInjected = false;
    // 软上限收尾信号注入标记随轮重置：跨 turn 重新注入（每轮回答都需收敛提醒），
    // 同 turn 内迭代仍由该 flag 防重（V1 语义：防迭代累积刷屏，不跨轮堆积）
    this.softLimitWrapupInjected = false;
    // 工具结果防重缓存：闭环内有效，新闭环开始即清空（跨闭环不复用，避免上一轮已读文件"误伤"本轮合法重读）
    this.toolResultCache.clear();
    // 文件覆盖度台账同步清空（与防重缓存同生命周期）
    this.fileExposure.clear();
    // P0-2 失败硬闸计数随轮清空（跨闭环复用时若残留，会误拒本轮合法的新失败重试）
    this.infoToolFailureBySubject.clear();
    // 注：askCountThisTurn（askLimit 护栏）不在此重置——它按「一次用户输入（turn 粒度，
    // 含暂停-续跑链）」累计，跨续跑保留；清零只在 processUserInput 入口（见 resetAskBudget）。
    // 层1：任务表 nudge 注入标记随轮重置（下一 turn 重新判定注入）；planNeedsNudge 也随轮清，
    // 但 processUserInput 在 resetTurnState 之后会重判设值（续跑入口不复用因此不重判）
    this.planNeedsNudge = false;
    this.planNudgeInjected = false;
  }

  /** 重置 askLimit 计数（turn 入口，2026-09-04）：仅 processUserInput 调用，continueAfterPause 不动，
   *  保证暂停-续跑同属一次用户输入、提问次数跨续跑累计（askLimit 语义：按输入打扰防刷）。 */
  private resetAskBudget(): void {
    this.askCountThisTurn = 0;
  }

  /**
   * 单轮 step 循环引擎（turn act 内 step 编排）：一次循环 = 一次 handleIteration（processUserInput/continueAfterPause 共享）。
   * stepBudget 软上限与 maxIterations 兜底在此统一收敛。
   * 注：所有复杂度（含 LLM 动态建任务表、会议机制角色切换）在单 turn 内承载（2026-09-04 收敛：多 turn 编排已砍）。
   */
  private async *runIterationLoop(
    signal: AbortSignal | undefined,
  ): AsyncGenerator<AgentChunk, void, unknown> {
    // 角色包 stepBudget 覆盖 loop.maxIterations（角色包声明多少给多少）。
    // stepBudget > 0 → 角色包声明了明确的步数预算，用它；
    // stepBudget = 0 → 不声明，用 loop.maxIterations（内核兜底 DEFAULT_MAX_ITERATIONS）。
    // 这样角色包配 stepBudget=200 → 跑 200 轮，完全不被内核硬墙 clamp。
    const effectiveMax = this.strategy.stepBudget > 0
      ? this.strategy.stepBudget
      : this.maxIterations;

    let iteration = 0;
    while (iteration < effectiveMax) {
      iteration++;
      this.currentIteration = iteration;

      // 在途提问兜底：提问挂起后未作答就续跑（宿主漏调 answerQuestion/cancelAsk）→
      // 在此补占位 tool 结果，保证 assistant.tool_calls 恒有配对 tool 消息（OpenAI 兼容端结构合法）
      if (this.pendingAsk) {
        this.cancelAsk();
      }

      const result = yield* this.handleIteration(iteration, signal);
      // 自审查轮开始前 emit selfReview chunk，供宿主展示视觉反馈（与注入判定共用单一真理源，
      // 保证 UI 通知与实际注入一致：纯文本问答/满意确认终止时不发通知）
      if (result === 'done' && this.shouldInjectSelfReview()) {
        yield { type: 'selfReview' };
      }
      // 共享的迭代结果处理；返回 false 表示终止循环
      if (!this.handleIterationResult(result)) return;
    }

    // 最大迭代兜底
    logger.warn({ iterations: iteration }, '达到最大迭代次数');
    yield* this.emitMaxIterationsReached();
  }

  /** 处理一次迭代结果（processUserInput/continueAfterPause 共享）。
   *  continue→继续；paused→终止（step 边界挂起待续跑）；aborted→终止（硬中止，排队插话已留档）；
   *  done→有自审查/排队插话待注入则继续，否则终止。返回 false 表示调用方应终止循环 */
  private handleIterationResult(result: 'aborted' | 'budget' | 'done' | 'continue' | 'paused'): boolean {
    // continue（工具结果已回填）无需特殊处理
    if (result === 'continue') return true;
    // budget（tokenBudget 触顶，V3）：终止循环。预算已耗尽时自审查续跑纯烧 token，
    // 与 'done'（自然收尾，可能注入审查）区分——_callAndRoute prep==='done' 分支产出。
    if (result === 'budget') return false;
    // paused（软暂停/提问在 step 边界生效）：终止本轮循环，保留现场待续跑
    if (result === 'paused') return false;
    // aborted（用户取消/超时）：硬中止，终止循环；排队插话已由 _handleInterrupt 消费进上下文留档
    if (result === 'aborted') return false;
    // result === 'done'：仅当满足自审查注入条件时才注入提示继续 1 轮。
    // 注入判定收敛在 shouldInjectSelfReview（单一真理源，供 emit 通知与注入共用）：
    // 多轮 turn（本问答发生过工具步）+ 开关已开 + 非工具屏蔽 + 本 turn 尚未审过（单次终审）。
    if (this.shouldInjectSelfReview()) {
      this.selfReviewDone = true;
      this.appendSystemMessage(this.ui.selfReviewPrompt(), { executionTemp: true });
      return true;
    }
    // done 终止前消费排队插话（统一「申请 → 气口生效」语义）：
    // LLM 返回 done（纯文本完成）期间用户 interject() 入队的补充输入，若直接 return false 会被静默丢弃；
    // 消费并继续迭代，下一轮 LLM 必看到插话内容。委托 _consumeInterjects（SSOT）。
    // 主要消费发生在 _handleInterrupt（迭代开始前），此处覆盖「LLM 在收尾轮执行期间插话」的窗口。
    const consumedCount = this._consumeInterjects(this.interruptQueue);
    this.interruptQueue = this.interruptQueue.filter((r) => r.kind !== 'interject');
    return consumedCount > 0;
  }

  /**
   * 自审查注入判定（emit selfReview 通知与注入 SELF_REVIEW 提示共用单一真理源）。
   *
   * 需同时满足：
   * 1. 启用自审查（selfReviewEnabled）；
   * 2. 非工具屏蔽（toolCallsBlocked 时 'done' 来自系统占位文本而非 LLM 回复）；
   * 3. **单次终审语义（2026-09-12 边界归位）**：
   *    - 多轮 turn 门槛：本 turn 内实际执行过工具步（一遍过的纯文本问答不审查）；
   *    - **终审即停：本 turn 已审过（selfReviewDone）则一律不再安排**。审查轮产出后
   *      done 立即真实生效——自审只对「工具循环后的最终交付」做一次把关，不因需修改
   *      而无限续跑空转（防 done 后反复审查拖长 turn，SELF-1）。能力迁移：深度"审查→
   *      修正"的迭代属目标模式阶段验收，非单次问答闭环职责。
   */
  private shouldInjectSelfReview(): boolean {
    if (!this.strategy.selfReviewEnabled) return false;
    if (this.strategy.toolCallsBlocked) return false;
    if (!this.toolExecutedThisTurn) return false;
    // 终审即停：本 turn 已审过 → 无论满意与否都不再注入（done 真实生效）。
    // 2026-09-13 单轮化：原 selfReviewRound 计数与「未达轮数上限」判据一并移除——
    // 单次终审下「已审过」是布尔状态，轮次计数与上限判据均属永不生效的多轮残留。
    if (this.selfReviewDone) return false;
    return true;
  }

  /** 单次迭代编排：编排中断检查 → 上下文准备 → LLM 调用 → 结果路由。
   *  按抽象层拆分为 _handleInterrupt / _prepareContext / _callAndRoute，
   *  编排者只保留顺序，各阶段职责内聚在小方法（保持单轮 turn 结构完整）。 */
  private async *handleIteration(
    iteration: number,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<AgentChunk, 'aborted' | 'budget' | 'done' | 'continue' | 'paused', unknown> {
    logger.debug({ iteration, messageCount: this.messages.length }, 'Agent Loop 迭代');

    // 中断检查：软暂停（边界挂起可续跑）/ 硬中止（不可续跑）；
    // 返回合并后的 effectiveSignal（AbortSignal）表示继续执行
    const gate = yield* this._handleInterrupt(signal);
    if (gate === 'paused' || gate === 'aborted') return gate;

    // LLM 调用 + 结果路由
    return yield* this._callAndRoute(iteration, gate);
  }

  /** 消费申请列表中的注入型（interject → appendUserMessage）条目。
   *  单一真理源——_handleInterrupt（step 边界，splice 取出的局部列表）和 done 分支
   *  （LLM 收尾兜底，全局 queue）共用同一遍历 + append 实现，防两处独立实现导致
   *  消费逻辑漂移（如加去重/计数时改一处漏一处）。
   *  删除语义留在调用方：_handleInterrupt 的 reqs 已 splice 出队无需再删；
   *  done 分支消费后自行过滤全局 queue（pause 条目保留待下轮边界消费）。
   *  @param reqs 待消费的申请列表（只读遍历，不修改）
   *  @returns 消费的 interject 条目数（调用方可据此决定是否继续迭代） */
  private _consumeInterjects(reqs: readonly InterruptRequest[]): number {
    let count = 0;
    for (const req of reqs) {
      if (req.kind === 'interject') {
        this.appendUserMessage(req.content);
        count++;
      }
    }
    return count;
  }

  /** 中断检查：step 边界统一消费 interruptQueue（pause + interject）+ 硬中止检查。
   *
   *  收敛后的单一气口出口——pauseRequested flag 和 pendingInterjections[] 都已收敛为 interruptQueue，
   *  此处统一 queue.splice(0) 取出全部申请，按 kind 分两类处理：
   *    - 注入型（interject）：先 appendUserMessage，不暂停 loop，让补充输入立刻进入下一轮 step
   *    - 挂起型（pause）：yield {type:'paused'} + return 'paused'，generator 在 step 边界挂起
   *
   *  顺序：先消费注入型 → 再检查挂起型 → 最后硬中止。注入型优先是为了让补充输入在 pause 生效前
   *  就入史——如果用户同时发了 interject + pause，补充输入应该被看到，而不是被 pause 吞掉。
   *
   *  返回 'paused' | 'aborted' 表示本迭代终止；返回合并后的 AbortSignal 表示继续。 */
  private async *_handleInterrupt(
    signal: AbortSignal | undefined,
  ): AsyncGenerator<AgentChunk, 'paused' | 'aborted' | AbortSignal | undefined, unknown> {
    // 统一取出全部气口申请（queue.splice(0) 原子消费，消费后队列为空）
    const reqs = this.interruptQueue.splice(0);

    // ① 先处理注入型气口（interject → appendUserMessage）——不暂停 loop，让补充输入立刻生效
    this._consumeInterjects(reqs);

    // ② 后处理挂起型气口（pause → yield paused）——如果队列里有 pause 申请，在 step 边界挂起
    if (reqs.some((r) => r.kind === 'pause')) {
      // pause 消费后 clearPauseRequest 已由 splice(0) 自动完成——无需额外清 flag
      yield { type: 'paused' };
      return 'paused';
    }

    // ③ 硬中止检查：外部 signal（宿主取消/超时）。插话不再经独立 controller（单一模式，2026-09-04）
    if (signal?.aborted) {
      yield { type: 'aborted', reason: this.ui.abortedByUser, stopReason: 'user' };
      return 'aborted';
    }
    return signal;
  }

  /** 超时 + 用户已申请暂停 → 路由 paused（续跑）而非 aborted（硬中止）。
   *  SSOT：LLM 调用 abort 点（_callAndRoute）与工具执行 abort 点（handleToolCalls）统一过此判定，
   *  消除「pause 优先于 abort」在两处各复制 if 的漂移风险。
   *  注：step 边界（_handleInterrupt）的气口消费是另一机制——那里 pause 在 abort 之前被优先消费，
   *  不属 abort 路由，故不经本方法。返回 paused chunk 或 null。 */
  private _routePausedIfTimeoutAndPause(signal: AbortSignal | undefined): AgentChunk | null {
    // 突变验证靶标：删除 `&& this.pauseRequested` → 负例测试（超时无暂停应 aborted）转红
    if (isTimeoutAbortSignal(signal) && this.pauseRequested) {
      return { type: 'paused' };
    }
    return null;
  }

  /** LLM 调用 + 结果路由：上下文准备 → 调 LLM → 按 abort/工具/纯文本 分支路由。
   *  effectiveSignal 已由 _handleInterrupt 合并好，此处直接使用。 */
  private async *_callAndRoute(
    iteration: number,
    effectiveSignal: AbortSignal | undefined,
  ): AsyncGenerator<AgentChunk, 'aborted' | 'budget' | 'done' | 'continue' | 'paused', unknown> {
    // ─── 上下文准备：截断 + 微压缩 + tokenBudget 检查 ────────────
    const prep = await this._prepareContext(effectiveSignal);
    if (prep === 'done') {
      yield { type: 'text', content: `\n\n${LOOP_CONSTANTS.TOKEN_BUDGET_REACHED_PLACEHOLDER}` };
      // 预算触顶走独立终止信号 'budget'（V3 修复）而非 'done'：
      // 'done' 会经 handleIterationResult 触发自审查续跑，而预算已耗尽时续跑审查纯烧 token；
      // 'budget' 分支直接终止循环，不注入 SELF_REVIEW（可在职责上与「自然收尾」区分）。
      return 'budget';
    }

    // LLM 调用前 emit thinking，让宿主 UI 在首 token 到达前展示"正在思考"反馈，消除空白等待
    yield { type: 'thinking', phase: 'llm_calling' };

    // 文本阶段标识：自审查应答（selfReviewDone）标注为 'self_review'，供宿主独立分段展示；
    // 正常回答/工具步文本为 'answer'。全流 text chunk 统一携带，保证审查输出与最终回答可区分。
    const textStage: TextChunkStage = this.selfReviewDone ? 'self_review' : 'answer';

    const llmResult: LlmCallResult = yield* this.callLlmWithRetry(
      prep.safeMessages,
      prep.chatOpts,
      effectiveSignal,
      iteration,
      textStage,
    );

    if (llmResult.aborted) {
      // K1 缓冲补发：工具闭环内延迟分类的消息被中断时，缓冲文本从未流式 yield →
      // 先补发给 UI（不带中断标记——中断提示由宿主 interrupted 消息承载，与逐字流中断一致）
      if (!llmResult.textStreamed && llmResult.fullContent.trim()) {
        yield { type: 'text', content: llmResult.fullContent, stage: textStage };
      }
      // 保留已生成的部分文本（追加 interrupted 标记），让下一轮 LLM 识别非完整回复。
      // 注：工具调用中断在此不处理——executeToolCalls 已 push assistant（含 toolCalls），
      // 追加文本标记会破坏工具调用结构
      if (llmResult.fullContent.trim()) {
        this.appendAssistantText(llmResult.fullContent + this.ui.interrupted);
      }
      // P1-01：timeout abort 且用户已申请暂停 → 路由 paused（续跑）而非 aborted（硬中止）。
      // 经单一收口方法 _routePausedIfTimeoutAndPause，与工具执行 abort 点共用同一判定（SSOT）。
      const pausedChunk = this._routePausedIfTimeoutAndPause(effectiveSignal);
      if (pausedChunk) {
        yield pausedChunk;
        return 'paused';
      }
      yield {
        type: 'aborted',
        reason: isTimeoutAbortSignal(effectiveSignal)
          ? this.ui.abortedByTimeout
          : this.ui.abortedByUser,
        stopReason: isTimeoutAbortSignal(effectiveSignal) ? 'timeout' : 'user',
      };
      return 'aborted';
    }

    // step 边界回调（每次迭代完成后触发，用于 stepLog 记录；step 级推进事件，非 turn 边界）。
    // 挂起型迭代不消耗 step（与用户暂停对称，2026-09-07）：含 ask_user 将挂起的迭代不自动
    // done 当前 active step——问答对归当前步，回答续跑后由后续完整迭代在此边界完成该步；
    // 判定经 willSuspendForAsk 单收口，与 handleToolCalls 挂起检出共用（防双判漂移）。
    if (this.onStepBoundary && !this.willSuspendForAsk(llmResult.toolCalls)) {
      this.onStepBoundary({
        summary: llmResult.fullContent.slice(0, 200),
      });
    }
    // 步级折叠边界事件（阶段二，2026-09-08 路 B′）：迭代完成后比较 active step 是否已推进。
    // 推进才产 step_boundary（宿主按步分组后续事件），且比 narrate/tool yield 更早——保证
    // 该步的第一条过程事件从边界后开始（语义="推进到这一步时记录边界"）。无任务表（null）
    // 或 stepId 未变则不产（lastBoundaryStepId 去噪，避免每迭代发一条空边界）。
    const activeStepMeta = this.getActiveStepMeta?.();
    const activeStepId = activeStepMeta?.stepId;
    if (activeStepMeta && activeStepId && activeStepId !== this.lastBoundaryStepId) {
      this.lastBoundaryStepId = activeStepId;
      // 层0 观测：step_boundary 产出累计（实证布局骨血是否空转）
      this.metrics.stepBoundaryCount++;
      // roundId 由 withRound 统一附加（chunk 归属 SSOT），此处不再自带
      yield {
        type: 'step_boundary',
        stepId: activeStepId,
        title: activeStepMeta.title,
      };
    }

    // ④ 结果路由：工具分支 / 纯文本结束分支
    // 主动提问走 ask_user 内置工具（唯一通道）：提问 = 一次普通工具调用，在 handleToolCalls 检出
    // 挂起；用户答案以 tool result 回填，工具调用结构完整落地（不再「撕掉」工具），
    // OpenAI 兼容端 assistant.tool_calls 恒有配对 tool 消息。
    if (llmResult.toolCalls && llmResult.toolCalls.length > 0) {
      // P2 过程叙述：工具轮文本（如「让我先读取所有文档」）作为 narrate 事件发射，
      // 供宿主渲染「过程叙述」折叠行——正文已在流式阶段剥离（未见工具轮文本）。
      // A1 回抽（2026-09-12）：首轮（无工具史）消息级分类前无法预判工具轮，文本已为保 TTFT
      // 逐字流式进正文区（streamedText 非空）——该段实为叙述，须先撤回再并入叙述内容：
      // withdrawn 告知消费者从正文移除该段（内核扣持久化 / 宿主移渲染），content 含其全文。
      const narration = (llmResult.streamedText + llmResult.pendingNarrate).trim();
      if (narration) {
        yield {
          type: 'narrate',
          content: narration,
          ...(llmResult.streamedText ? { withdrawn: llmResult.streamedText } : {}),
        };
      }
      return yield* this.handleToolCalls(llmResult, effectiveSignal);
    }
    // K1 补发：工具闭环内延迟分类的纯文本消息（收尾交付）从未流式 yield → 先补发整段正文再收尾
    if (!llmResult.textStreamed && llmResult.fullContent.trim()) {
      yield { type: 'text', content: llmResult.fullContent, stage: textStage };
    }
    return yield* this.handleTextResponse(llmResult);
  }

  /** 上下文准备：摘要截断 → 同步工作记忆 → 微压缩 → tokenBudget 检查 → 任务表注入。
   *  返回 { chatOpts, safeMessages } 供调用方送 LLM；返回 'done' 表示达到预算上限终止本轮。
   *  截断/压缩/预算改造 this.messages 的工作记忆，是"资源边界"职责的收敛点。
   *  纯 async（非生成器）：达到预算上限时返回 'done'，由调用方负责 emit text + 终止。 */
  private async _prepareContext(
    effectiveSignal: AbortSignal | undefined,
  ): Promise<{ chatOpts: ChatOptions; safeMessages: readonly Message[] } | 'done'> {
    // 调用 LLM（带重试 + 截断保护）
    const chatOpts = this.buildChatOptions();

    // 上下文摘要：启用且需截断时生成（传入 effectiveSignal，让摘要可被取消或插话中断）
    let contextSummary: string | undefined;
    if (this.enableContextSummary && this.contextManager.shouldTruncate(this.messages)) {
      contextSummary = await this.contextManager.getOrCreateSummary(this.messages, effectiveSignal);
    }
    const safeMessages = this.contextManager.truncateMessages(this.messages, contextSummary);
    // 记录本次是否截断重排（替换层据此跳过——截断提取 key messages 重插中间，作用于裁剪视图风险较高）
    this.isLastContextTruncated = safeMessages !== this.messages;
    // 截断后同步替换工作记忆，防 messages 无限增长（持久化由 MessageHistory 负责）
    if (this.isLastContextTruncated) {
      this.replaceContext([...safeMessages]);
    }

    // ─── 两级空间管理压缩链 ─────────────────────────────────────
    // 第一级：替换（内核自动 LRU，取已存记忆摘要换越界轮次正文，无摘要 no-op）
    // 第二级：tool_result 占位（ResultReplacementStrategy）
    // 注：超大工具结果卸载**不在链上** —— 它是入口关（appendToolMessage），见 toolResultOffload.ts
    //
    // 视图说明（截断轮一致性，2026-09-11 打磨备注）：截断时 safeMessages 为截断后新数组（本次
    // 发往 LLM 的视图），this.messages 经 replaceContext 为同元素引用的浅拷贝。ResultReplacement
    // 原地改对象 content（引用共享 → 对发送视图同样生效）。
    for (const strategy of this.compactionStrategies) {
      if (strategy.shouldCompact(this.messages)) {
        await strategy.compact(this.messages);
      }
    }
    // ─── 压缩链结束 ─────────────────────────────────────────────

    // 情报区注入（Step 2）：LLM 私有工作笔记，作为单条尾部私有 system 消息（非 executionTemp → 跨 turn 自持）
    this.injectIntelNote();

    // TS-7 搜索收敛护栏：本闭环成功联网搜索达阈值后，注入收敛提示引导 LLM 停止搜索直接作答。
    // 幂等：一轮内仅注入一次（executionTemp 随下一闭环入口清冗；计数随 resetTurnState 清零）
    if (
      this.successfulWebSearchCount >= LOOP_CONSTANTS.SEARCH_CONVERGENCE_THRESHOLD &&
      !this.searchConvergenceHintInjected
    ) {
      this.searchConvergenceHintInjected = true;
      this.appendSystemMessage(LOOP_CONSTANTS.SEARCH_CONVERGENCE_HINT, { executionTemp: true });
      logger.info(
        { successfulWebSearchCount: this.successfulWebSearchCount },
        '搜索收敛护栏：已注入停止搜索提示',
      );
    }

    // 软上限（内核确定性检测）：上下文逼近容量上限且正文大量摘要化（摘要层达容量上限）
    // → 注入收尾信号，LLM 收敛产出最终交付（executionTemp，下一轮闭环入口即弃）。
    // 幂等防重：摘要层饱和是跨迭代持续态、判定不随注入自变（注入文本不含摘要 marker，
    // 不增摘要层 token）——无防重则同 turn 每步迭代各注入一条收尾信号刷屏（V1 修复：
    // 与搜索收敛 flag / 压力提示 includes 断言的幂等口径对齐）。
    if (this.contextManager.shouldInjectSoftLimitWrapup(this.messages) && !this.softLimitWrapupInjected) {
      this.softLimitWrapupInjected = true;
      this.appendSystemMessage(this.ui.softLimitWrapup, { executionTemp: true });
      logger.warn(
        {
          estimatedTokens: this.contextManager.estimateTokens(this.messages),
          max: this.maxContextTokens,
        },
        '软上限：摘要层达容量上限，注入收尾信号，LLM 收敛产出最终交付',
      );
    } else if (this.contextManager.shouldInjectContextPressureHint(this.messages)) {
      // T3（2026-09-01）预算预警档：容量到线但摘要层未饱和（软上限的前一级）→ 注入温和压缩/收敛提示，
      // 引导 LLM 主动压缩而非直接到收尾。内容幂等：仅一轮内注入一次，防迭代累积刷屏（executionTemp 入口即弃）
      if (!this.messages.some((m) => m.role === 'system' && m.content.includes('上下文空间提示'))) {
        this.appendSystemMessage(LOOP_CONSTANTS.CONTEXT_PRESSURE_HINT, { executionTemp: true });
      }
      logger.debug(
        {
          estimatedTokens: this.contextManager.estimateTokens(this.messages),
          max: this.maxContextTokens,
        },
        '上下文预算预警：容量到线未饱和，注入压缩/收敛提示',
      );
    }

    // tokenBudget 软上限检查（0=不限制）
    if (this.strategy.tokenBudget > 0) {
      const estimatedTokens = this.contextManager.estimateTokens(this.messages);
      if (estimatedTokens >= this.strategy.tokenBudget) {
        logger.info(
          { estimatedTokens, tokenBudget: this.strategy.tokenBudget },
          '达到 Token 预算上限',
        );
        return 'done';
      }
    }

    // 每次迭代 LLM 调用前统一注入任务表 —— 替换式注入（T9 2026-09-11）：
    // 注入前先移除已有的任务表消息（特征前缀 [任务进度:，renderTaskTable 输出首行），
    // 保证一个 turn 内经 N 次迭代上下文恒 1 份任务表，不重复灌指令浪费 token。
    // 同时标记 executionTemp——跨 turn 由 cleanExecutionTemporary 在下一闭环入口统一清冗
    // （旧实现不带标记，跨 turn 同样累积，本次一并收口）
    const taskTable = this.getTaskTable?.();
    if (taskTable) {
      this.replaceContext(
        this.messages.filter((m) => !(m.role === 'system' && m.content.startsWith('[任务进度:'))),
      );
      this.appendSystemMessage(taskTable, { executionTemp: true });
    }

    // needsPlanning 命中时首迭代注入一过式命令式引导：executionTemp → 跨 turn 由
    // cleanExecutionTemporary 清冗；planNudgeInjected 保证本 turn 仅决策一次（非每迭代重复，
    // 与任务表"替换式"注入区分）。P1 收口：已有在途任务表（会议骨架 / 续会，getActiveStepMeta
    // 非空）时不灌「先拆解建表」——骨架已预置 / 续会本有步进，nudge 反而冗余误导；无表才诱导建表。
    if (this.planNeedsNudge && !this.planNudgeInjected) {
      this.planNudgeInjected = true;
      if (!this.getActiveStepMeta?.()) {
        this.appendSystemMessage(PLAN_NUDGE_PROMPT, { executionTemp: true });
        logger.info({}, '任务表触发：needsPlanning 命中且无在途任务表，已注入命令式强引导');
      }
    }

    return { chatOpts, safeMessages };
  }

  /**
   * 本迭代将因 ask_user 挂起（决策关口，与用户暂停同属挂起型气口）？
   * 含 ask_user 且未超 askLimit、非工具屏蔽。SSOT：onStepBoundary 的 step 推进排除判定
   * 与 handleToolCalls 挂起检出共用同一谓词（防两处判定漂移）——收口验收：
   * ask_user 挂起谓词字面全仓仅此一处。
   * 注：边界处传 llmResult.toolCalls（原始集）、挂起检出传 effectiveToolCalls（toolStepLimit
   * 截断后集）；截断把 ask_user 裁掉的窗口 → 边界多跳一轮不推进，安全向（少推进而非错推进）。
   * askLimit 超限的 ask_user 走 executeToolCalls 拒绝（[ASK_LIMIT]），迭代照常执行 → 不判挂起。
   */
  private willSuspendForAsk(toolCalls: Message['toolCalls']): boolean {
    return (
      !this.strategy.toolCallsBlocked &&
      toolCalls !== undefined &&
      toolCalls.some((tc) => tc.function.name === ASK_USER_TOOL.name) &&
      this.askCountThisTurn < this.strategy.askLimit
    );
  }

  /** 工具调用分支 + Reflection（子方法 2/3）；ask_user 提问检出挂起（返回 'paused'） */
  private async *handleToolCalls(
    llmResult: LlmCallResult,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<AgentChunk, 'aborted' | 'continue' | 'done' | 'paused', unknown> {
    // L2 策略阻止工具调用：跳过执行，仅保留文本内容
    if (this.strategy.toolCallsBlocked) {
      const blockedMsg = llmResult.fullContent.trim() || '（当前角色不允许调用工具）';
      this.appendAssistantText(blockedMsg);
      yield { type: 'text', content: blockedMsg };
      yield { type: 'done' };
      return 'done';
    }

    // 工具步数软上限检查：超限时仅保留前 N 个，其余转为纯文本
    let effectiveToolCalls = llmResult.toolCalls!;
    if (
      this.strategy.toolStepLimit > 0 &&
      effectiveToolCalls.length > this.strategy.toolStepLimit
    ) {
      logger.debug(
        {
          requested: effectiveToolCalls.length,
          limit: this.strategy.toolStepLimit,
        },
        '工具步数超限，截断至上限',
      );
      effectiveToolCalls = effectiveToolCalls.slice(0, this.strategy.toolStepLimit);
    }

    // 主动提问检出（ask_user 内置工具）：提问 = 一次普通工具调用（对齐 Claude Code AskUserQuestion
    // 机制）。检出 ask_user 且未达 askLimit 上限 → 整轮挂起（其余工具不执行——提问是决策关口，
    // 答案未定前执行可能白跑），用户答案经 answerQuestion 回填为 tool 结果后由宿主续跑，
    // LLM 基于答案重新决策。挂起判定经 willSuspendForAsk 单收口（与 onStepBoundary 排除共用）。
    if (this.willSuspendForAsk(effectiveToolCalls)) {
      return yield* this.handleAskUser(llmResult, effectiveToolCalls);
    }

    // ─── 重复工具调用检测（拦截器模式 · **前移到执行前** = N1 真 block）───
    // 重复检测委托给 DuplicateCallInterceptor（默认哈希机械检测，宿主可注入差异化策略）。
    // 判定在工具执行**前**：warn → 注入负反馈后继续执行；block → 注入阻断并跳过执行（真阻止，
    // 不再"事后宣告已自动阻止"的假 block，N1 排雷修正）。
    const currentHash = DefaultDuplicateCallInterceptor.hash(effectiveToolCalls);
    if (currentHash !== '' && currentHash === this.lastToolCallsHash) {
      this.duplicateToolCallCount++;
    } else {
      this.duplicateToolCallCount = 0;
    }
    const checkContext: DuplicateCheckContext = {
      iteration: this.currentIteration,
      duplicateCount: this.duplicateToolCallCount,
      lastHash: this.lastToolCallsHash,
      currentHash,
      threshold: this.duplicateToolCallThreshold,
    };
    const dupVerdict = this.duplicateCallInterceptor.check(effectiveToolCalls, checkContext);
    if (dupVerdict === 'warn') {
      // 警告：注入负反馈强制 LLM 改策略，但**不跳过**本轮执行（软提醒）
      this.appendSystemMessage(this.ui.duplicateToolCallWarning(this.duplicateToolCallThreshold), {
        executionTemp: true,
      });
      logger.warn({ hash: currentHash, count: this.duplicateToolCallCount, interceptor: this.duplicateCallInterceptor.name ?? 'anonymous' }, '重复工具调用拦截器触发 warning（执行前）');
      this.duplicateToolCallCount = 0;
      this.lastToolCallsHash = '';
    } else if (dupVerdict === 'block') {
      // 硬拦截：真阻止——不执行任何工具，注入阻断并结束本轮（工具尚未执行，诚实）
      this.appendSystemMessage(
        `[DUPLICATE_TOOL_CALL_BLOCKED] 检测到重复工具调用，已阻止本次工具执行。` +
          `请改变策略：调整参数、换用其他工具，或直接给出文本回复。`,
        { executionTemp: true },
      );
      logger.warn({ hash: currentHash, count: this.duplicateToolCallCount, interceptor: this.duplicateCallInterceptor.name ?? 'anonymous' }, '重复工具调用拦截器触发 block（执行前阻止）');
      this.duplicateToolCallCount = 0;
      this.lastToolCallsHash = '';
      return 'done';
    } else {
      this.lastToolCallsHash = currentHash;
    }
    // ─── 拦截器检测结束 ──────────────────────────────────────

    const execResult = yield* this.executeToolCalls(
      effectiveToolCalls,
      llmResult.fullContent,
      signal,
    );
    if (execResult.aborted) {
      // P1-01 同构：工具执行中途 timeout abort 且用户已申请暂停 → 路由 paused（续跑）。
      // 经单一收口方法 _routePausedIfTimeoutAndPause，与 LLM abort 点共用同一判定（SSOT）。
      const pausedChunk = this._routePausedIfTimeoutAndPause(signal);
      if (pausedChunk) {
        yield pausedChunk;
        return 'paused';
      }
      yield {
        type: 'aborted',
        reason: isTimeoutAbortSignal(signal) ? this.ui.abortedByTimeout : this.ui.abortedByUser,
        stopReason: isTimeoutAbortSignal(signal) ? 'timeout' : 'user',
      };
      return 'aborted';
    }

    // Reflection：本轮工具结果含 retryable 错误时，追加反思提示帮 LLM 聚焦修正而非放弃
    // slice 按实际执行的 effectiveToolCalls.length 取窗口——旧实现按 LLM 原始请求条数
    // llmResult.toolCalls.length 切，toolStepLimit 截断时 slice 多看会把上一轮残留的
    // tool 错误吸进判定窗口，误注入反思提示（T10 2026-09-11 修正）
    const hasRetryableError = this.messages
      .slice(-effectiveToolCalls.length) // 只看本轮工具结果
      .some((m) => m.role === 'tool' && isRetryableToolError(m.content));
    if (hasRetryableError) {
      // 反思次数用显式计数器限制，避免 messages 裁剪导致计数失真
      if (this.reflectionCountThisTurn < this.maxReflectionRetries) {
        this.reflectionCountThisTurn++;
        this.appendSystemMessage(
          this.ui.reflectionHint(this.maxReflectionRetries - this.reflectionCountThisTurn),
          { executionTemp: true },
        );
      }
    }

    // 继续循环：把工具结果回填给 LLM
    return 'continue';
  }

  /**
   * ask_user 提问挂起（step 边界气口，2026-09-04）：把提问作为普通工具轮落地，挂起等用户作答。
   *
   * 与插话/暂停统一的「申请 → 气口生效」语义：
   * - assistant(toolCalls) 结构完整入史（含 ask_user），不再「撕掉」工具——OpenAI 兼容端
   *   assistant.tool_calls 后必有配对 tool 消息（用户答案），结构恒合法；
   * - 解析各 ask_user 参数为结构化 AskQuestion，yield question_pending 供宿主渲染提问 UI；
   * - yield paused 挂起（consumeExecutionStream 统一翻 PAUSED + 写 pauseMeta），
   *   用户作答后宿主调 answerQuestion() 回填 tool 结果，再 continueAfterPause() 续跑。
   */
  private async *handleAskUser(
    llmResult: LlmCallResult,
    toolCalls: NonNullable<Message['toolCalls']>,
  ): AsyncGenerator<AgentChunk, 'paused', unknown> {
    // 工具调用结构完整落地（提问就是工具轮，不撕毁任何调用）
    this.appendAssistantToolCall(llmResult.fullContent, toolCalls);
    const askCalls = toolCalls.filter((tc) => tc.function.name === ASK_USER_TOOL.name);
    const questions = parseAskCalls(askCalls);
    // turn 粒度计数：提问落地即累计（askLimit 硬护栏，防 LLM 反复提问刷打扰次数）
    this.askCountThisTurn += questions.length;
    this.pendingAsk = { toolCallIds: askCalls.map((tc) => tc.id), questions };
    // 挂起等待用户作答（非自主工具步执行中，复位可续跑信号）
    this.inAutonomousStep = false;
    // loop 只回调不处理 UI：宿主应答 questionPending 事件渲染提问
    this.onPendingQuestion?.(questions);
    for (const q of questions) {
      yield { type: 'question_pending', questions: [q] };
    }
    yield { type: 'paused' };
    return 'paused';
  }

  /**
   * 回答在途提问（宿主在用户作答后调用，随后 continueAfterPause() 续跑）：
   * 答案以 ask_user 工具的 tool result 回填（<tool_result> 包裹防注入，与 assistant.tool_calls 配对）。
   * answers 与提问按序一对一；不足时复用最后一条/空串兜底。返回 false 表示无在途提问。
   */
  answerQuestion(answers: readonly string[]): boolean {
    if (!this.pendingAsk) return false;
    const { toolCallIds } = this.pendingAsk;
    toolCallIds.forEach((id, i) => {
      const answer = answers[i] ?? answers[answers.length - 1] ?? '';
      this.appendToolMessage(
        wrapToolResult(ASK_USER_TOOL.name, `[ASK_ANSWER] 用户回答：${answer}`),
        id,
      );
    });
    // G26：已作答提问转存快照（runResume 落盘交互输入时随回答持久化），pendingAsk 照旧清空
    this.lastAnsweredAsk = this.pendingAsk.questions;
    this.pendingAsk = undefined;
    this.inAutonomousStep = false;
    logger.info({ answers }, 'ask_user 已回填用户答案');
    return true;
  }

  /**
   * 取走最近一次已作答提问快照（G26）：runResume 落盘回答交互输入前调用，取走即清。
   * 返回 undefined = 本次续跑非提问回答路径（补充输入 / 无快照残留）。快照为
   * AskQuestion[]（多 ask_user 轮整组），调用方按需取用（当前落盘语义取 questions[0]）。
   */
  takeAnsweredAsk(): AskQuestion[] | undefined {
    const snapshot = this.lastAnsweredAsk;
    this.lastAnsweredAsk = undefined;
    return snapshot;
  }

  /**
   * 取消在途提问（宿主「跳过/取消提问」或提问超时（2026-09-08）时调用；
   * runIterationLoop 续跑兜底也调用）：
   * 以占位结果回填，防 assistant.tool_calls 无配对 tool 消息（OpenAI 兼容端 400）。
   * G26 对称（2026-09-08）：与 answerQuestion 一致转存提问快照到 lastAnsweredAsk——
   * 超时路径（resumeExecution kind='timeout'）经 runResume takeAnsweredAsk 随「未回答」
   * 交互记录落盘 question/options，重放可渲染「问 + 未回答」行；跳过/兜底路径不消费
   * 快照时残留仅进程内单 turn，无害（下次 answerQuestion 覆盖）。
   */
  cancelAsk(): void {
    if (!this.pendingAsk) return;
    const { toolCallIds } = this.pendingAsk;
    for (const id of toolCallIds) {
      this.appendToolMessage(
        wrapToolResult(ASK_USER_TOOL.name, '[ASK_ABORTED] 用户未回答该提问'),
        id,
      );
    }
    this.lastAnsweredAsk = this.pendingAsk.questions;
    this.pendingAsk = undefined;
    this.inAutonomousStep = false;
    logger.info({ toolCallIds }, 'ask_user 提问已取消（占位结果回填）');
  }

  /** 纯文本结束（子方法 3/3）：push assistant 消息（含空响应兜底）并 yield done。
   *  注：主动提问已收敛为 ask_user 工具（2026-09-04），本方法只处理纯文本交付，
   *  不再承担提问暂停。 */
  private async *handleTextResponse(
    llmResult: LlmCallResult,
  ): AsyncGenerator<AgentChunk, 'done' | 'paused', unknown> {
    // 文本工具意图收敛（2026-09-14 静默失败修复）：纯文本结束路径意味着本轮未产出原生
    // toolCalls，若 fullContent 仍带 <tool_call>/<function=> 骨架（文本出口不再宣告可调用
    // 通道后模型偶发模仿残留），说明「想调用工具却未走原生协议」——既往被当普通文本交付，
    // 宿主净化后为空 → 显示空白且被静默盖「完成」。此处：告警 + 计数 + 剔除骨架出交付文本。
    const nonSkeletonText = llmResult.fullContent
      ? this.stripToolIntentSkeleton(llmResult.fullContent)
      : null;
    if (nonSkeletonText !== null) {
      logger.warn(
        `检测到未解析的文本工具意图（无原生 toolCalls），已从正文剔除并计数。原正文：${llmResult.fullContent}`,
      );
      this.metrics.unparsedToolIntentCount++;
      if (nonSkeletonText) {
        this.appendAssistantText(nonSkeletonText);
      }
      yield { type: 'done' };
      return 'done';
    }
    if (llmResult.fullContent) {
      this.appendAssistantText(llmResult.fullContent);
    } else {
      // LLM 返回空响应（无文本无工具调用）的兜底，正常不会发生但 provider 边界情况可能触发
      logger.warn('LLM 返回空响应（无文本、无工具调用），使用兜底提示');
      // 文案走 ui 通道（默认英文，宿主可经 messages.emptyResponseFallback 覆盖，与其它 UI 文案一致）
      this.appendAssistantText(this.ui.emptyResponseFallback);
      yield { type: 'text', content: this.ui.emptyResponseFallback };
    }

    yield { type: 'done' };
    return 'done';
  }

  /**
   * 调用 LLM（带指数退避重试，仅在流式输出前失败时重试；流式已开始则直接上抛，因用户已看到部分结果）。
   *
   * 实现已迁至 `LlmCaller.callWithRetry`（ARCH-3 P3-2，~277 行）；此处保留委托壳。
   */
  private callLlmWithRetry(
    safeMessages: readonly Message[],
    chatOpts: ChatOptions,
    signal: AbortSignal | undefined,
    iteration: number,
    /** 流式文本阶段标识（默认正常交付 'answer'；自审查应答由调用方传 'self_review'） */
    stage: TextChunkStage = 'answer',
  ): AsyncGenerator<AgentChunk, LlmCallResult, unknown> {
    return this.llmCaller.callWithRetry(safeMessages, chatOpts, signal, iteration, stage);
  }

  /**
   * 执行工具调用列表（并发执行，异常捕获后转为结构化错误串回传给 LLM，而非中断对话）
   */
  private async *executeToolCalls(
    toolCalls: NonNullable<Message['toolCalls']>,
    fullContent: string,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<AgentChunk, { aborted: boolean }, unknown> {
    this.appendAssistantToolCall(fullContent, toolCalls);

    // 工具并行执行（保持顺序的并发）：Promise.all 并发所有工具（总耗时≈最慢工具），
    // 但 tool_start/tool_result 与 messages 均按原始顺序 yield/push，保证 Reflection slice 正确
    if (signal?.aborted) {
      return { aborted: true };
    }

    // 实际执行工具步：标记"本 turn 发生过工具调用"，作为自审查触发门槛（多轮 turn 才审查）
    this.toolExecutedThisTurn = true;

    // 标记进入自主工具步（供内核向宿主暴露"可续跑"信号）
    this.inAutonomousStep = true;

    // yield tool_start 并并发发起所有工具执行（不 await，由 Promise.all 统一等待）
    const toolPromises: Promise<string>[] = [];
    /** 策略拦截标记（按 toolCalls 顺序平行记录）：确定性拒绝（如搜索硬上限）的工具 blocked=true */
    const blockedFlags: boolean[] = [];
    for (const tc of toolCalls) {
      this.metrics.toolCallCount++;
      // 层0 观测：task_table_write 调用累计（实证任务表是否被触发）
      if (tc.function.name === 'task_table_write') this.metrics.planTaskTableWriteCount++;
      const isSearch = tc.function.name === 'web_search';
      if (isSearch) this.searchCallCount++;
      yield {
        type: 'tool_start',
        toolCallId: tc.id,
        name: tc.function.name,
        args: tc.function.arguments,
      };
      // 搜索硬上限（TS-7 升级）：单闭环 web_search 超过上限后确定性拒绝——不执行、回填拒绝文案，
      // 不依赖 LLM 听从软收敛提示。LLM 看到的是一条「被拒绝」的 tool 消息，据此停止搜索直接作答。
      if (isSearch && this.searchCallCount > LOOP_CONSTANTS.MAX_WEB_SEARCH_CALLS) {
        // 双闸第二闸：命中即停搜——置 searchDisabled，下一轮 LLM 调用的工具集剔除 web_search
        // （buildChatOptions 确定性过滤），并在本轮注入「视为未找到更多相关→继续下一步」提示，
        // 双管齐下终结「被拒→重搜→再被拒」拒绝风暴耗尽迭代/上下文导致问答闭环中断。
        // 首次置位时同步重建 system prompt（V2 修复）：buildSystemPrompt 按 searchDisabled
        // 过滤 web_search 描述，剔除「描述存在但工具不可用」不一致——此前 messages[0] 只在
        // 构造 / refresh* 时机重建，描述残留到闭环结束。仅首次置位重建（幂等，同一闭环
        // 多次超限搜索不再重复拼装；rebuildSystemMessage 只替换 messages[0]，不动注入消息）。
        if (!this.searchDisabled) {
          this.searchDisabled = true;
          this.rebuildSystemMessage();
        }
        if (!this.searchDisabledHintInjected) {
          this.searchDisabledHintInjected = true;
          this.appendSystemMessage(
            `[SEARCH_LIMIT] 联网搜索已达 ${LOOP_CONSTANTS.MAX_WEB_SEARCH_CALLS} 次上限，视为未检索到更多相关内容。` +
              `请停止调用 web_search，直接基于已有信息继续下一步或作答。`,
            { executionTemp: true },
          );
        }
        blockedFlags.push(true);
        toolPromises.push(
          Promise.resolve(
            `[SEARCH_LIMIT_REACHED] 已执行 ${LOOP_CONSTANTS.MAX_WEB_SEARCH_CALLS} 次联网搜索，信息应已足够；` +
              `请停止调用 web_search，直接基于现有搜索结果作答。`,
          ),
        );
        continue;
      }
      blockedFlags.push(false);
      // ask_user 硬护栏（askLimit 超限，2026-09-04）：拒绝该提问并回填拒绝文案。
      // 走到这里说明未达上限的提问已在 handleToolCalls 检出挂起——此分支只兜「单轮内多次提问
      // 超限」或「检出后计数已满」（同轮多个 ask_user 跨上限），拒绝后其余工具照常执行。
      if (tc.function.name === ASK_USER_TOOL.name && this.askCountThisTurn >= this.strategy.askLimit) {
        blockedFlags.push(true);
        toolPromises.push(
          Promise.resolve(
            `[ASK_LIMIT] 本问答闭环已提问 ${this.strategy.askLimit} 次（上限），请基于现有信息继续，不要再调用 ask_user。`,
          ),
        );
        continue;
      }
      // 工具结果防重拦截（read_file/list_dir/web_search 等信息获取型工具）：
      // 闭环内同 toolName + 同请求主体（路径 + 读取区间 / query）的重复调用 → blocked=true + [ALREADY_READ]。
      // 与 web_search MAX_WEB_SEARCH_CALLS / ask_user askLimit 同级的确定性拦截，
      // 终结 LLM 在同一批文件/同一 query 上反复轮询导致的死循环（token 爆炸 + maxIterations 撞线）。
      //
      // 拦截前提（不可省）：**该结果确实仍在当前上下文中**。否则内容已被截断裁剪、或已被压缩链
      // 换成 `[Previous: used x]` 占位符，LLM 手边已无内容却被告知「基于已有信息继续」——
      // 指令性撒谎 + 重读被拦 = 死锁（CTX-1 根因②）。判定见 isCachedResultStillInContext。
      // 文件被 write_file/delete_file 修改 → 结果处理循环主动 invalidateFile 放行后续合法重读。
      const subjectExtractor = DEDUP_SUBJECT_EXTRACTORS[tc.function.name];
      if (subjectExtractor) {
        const subject = subjectExtractor(tc.function.arguments);
        if (subject) {
          // P0-2 失败硬闸（N1 真 block / N2 同主体粒度）：该同主体已连续失败达阈值 → 执行前硬拦，不再执行。
          // 治「幻觉文件重读风暴」（前一次结果已 [ERR 失败，此处按其主体累计拒绝后续同参重试）。
          const failCount = this.infoToolFailureBySubject.get(
            failureSubjectKey(tc.function.name, subject),
          );
          if (failCount !== undefined && failCount >= this.duplicateToolCallThreshold) {
            blockedFlags.push(true);
            toolPromises.push(
              Promise.resolve(
                `[READ_FAILED_LIMIT] 该目标已连续失败 ${failCount} 次（阈值 ${this.duplicateToolCallThreshold}），` +
                  `可能不存在。请先用 list_dir 确认路径，或改用其它目标。`,
              ),
            );
            continue;
          }
          const hit = this.toolResultCache.check(tc.function.name, subject);
          if (hit) {
            // 分支①：结果仍在上下文 → 拦（现状：同参重读 = 纯浪费）
            if (this.isCachedResultStillInContext(hit)) {
              blockedFlags.push(true);
              toolPromises.push(
                Promise.resolve(
                  `[ALREADY_READ] 该结果仍在你的当前上下文中（第 ${hit.cachedAtIteration} 步获取：` +
                    `${formatDedupSubject(tc.function.name, subject)}），无需重复获取。` +
                    `如需该文件的其它部分，请用 offset/limit 指定行区间。`,
                ),
              );
              continue;
            }
            // （原文已压缩 → 落入分支②递增判断，见下）
          }
          // 分支②（P0-1b + T1 收敛，2026-09-14）：已有覆盖度台账时，是否回显摘要的判定**唯一**收敛到
          //   `shouldEchoLedgerStub`（SSOT）——区分「无 limit 整读」（有覆盖即拦、回显引导 offset 续读）
          //   与「offset/limit 续读」（完全落覆盖内才拦）；触及覆盖之外放行分支③（G2 守卫）。
          const cov = subject.path ? this.fileExposure.get(subject.path) : undefined;
          if (cov && shouldEchoLedgerStub(subject, cov)) {
            blockedFlags.push(true);
            toolPromises.push(Promise.resolve(formatLedgerStub(cov)));
            continue;
          }
          // 分支③（保守）：无摘要 / 区间超出覆盖 → 放行（宁可多读一次，不可死锁，CTX-1 根因②）
        }
      }
      // 第二级压缩工具由 loop 拦截执行（现场压临时摘要替换，loop 收尾即弃），不落 ToolExecutor
      toolPromises.push(
        tc.function.name === COMPRESS_CONTEXT_TOOL.name
          ? this.compressContext(tc.function.arguments, signal)
          : tc.function.name === REMEMBER_INTEL_TOOL.name
            ? Promise.resolve(this.handleRememberIntel(tc.function.arguments))
            : this.toolRunner.runOne(tc, signal),
      );
    }

    const results = await Promise.all(toolPromises);

    this._processToolResults(toolCalls, results);

    // 按原始顺序 yield tool_result
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i]!;
      const result = results[i]!;
      // 第三态（2026-09-02）：策略拦截 blocked=true 非成功亦非失败——ok=false 且不计成功搜索数；
      // 失败（[ERR 前缀）与拦截区分开，UI 显示「已拦截」，metrics 失败数不把拦截算作失败
      const blocked = blockedFlags[i] === true;
      const ok = !blocked && !result.startsWith('[ERR');
      // TS-7 搜索收敛护栏：累计本闭环成功 web_search 次数（LLM 反复搜索不收敛时据此注入收敛提示）
      if (tc.function.name === 'web_search' && ok) {
        this.successfulWebSearchCount++;
      }
      // 工具结果防重缓存：仅成功且是 info-fetch 类型的工具才写入（失败/拦截不缓存——
      // 失败可能是临时问题，拦截是我们主动挡的）。
      // 一并记录 toolCallId + 内容指纹：拦截前据此判定「该结果是否仍在当前上下文中」。
      // 指纹按进入上下文的包裹口径计算（复用 wrapToolResult 同一函数 → 同源，不会因模板改动失配）。
      const resultExtractor = DEDUP_SUBJECT_EXTRACTORS[tc.function.name];
      if (ok && resultExtractor) {
        const subject = resultExtractor(tc.function.arguments);
        if (subject) {
          this.toolResultCache.set(tc.function.name, subject, this.currentIteration, {
            toolCallId: tc.id,
            fingerprint: sha256Fingerprint(wrapToolResult(tc.function.name, result)),
          });
          // 文件覆盖度台账写侧：read_file 返回分段脚注（= 文件确实大/被截断，R1 修正的"按需"信号）
          // 时记录覆盖区间 + 轻量替身摘要——供拦截分支②在原文被压缩后回显（防重读永动机 / 空拦死锁）。
          if (tc.function.name === 'read_file' && subject.path) {
            const cov = parseReadFileCoverage(result);
            if (cov) {
              this.fileExposure.record(subject.path, {
                totalLines: cov.totalLines,
                coverStart: cov.coverStart,
                coverEnd: cov.coverEnd,
                // 替身 = 已读正文前 READ_DIGEST_CHARS 字符（轻量启发式，零 LLM 成本）
                digest: cov.content.slice(0, READ_DIGEST_CHARS),
                cachedAtIteration: this.currentIteration,
              });
            }
          }
        }
      }
      // P0-2 失败硬闸计数：真实失败（执行了且返回 [ERR，非拦截）的 info 工具 → 同主体累加；
      // 成功 → 清除该主体失败计数（恢复）。治「幻觉文件重读风暴」。
      if (resultExtractor) {
        const fSubject = resultExtractor(tc.function.arguments);
        if (fSubject) {
          const key = failureSubjectKey(tc.function.name, fSubject);
          if (ok) {
            this.infoToolFailureBySubject.delete(key);
          } else if (!blocked) {
            this.infoToolFailureBySubject.set(key, (this.infoToolFailureBySubject.get(key) ?? 0) + 1);
          }
        }
      }
      // 副作用型工具成功 → 主动失效关联的 read_file 缓存（放行后续合法重读）
      // 覆盖 write_file/delete_file 两类会修改文件系统状态的工具
      if (ok && (tc.function.name === 'write_file' || tc.function.name === 'delete_file')) {
        try {
          const a = JSON.parse(tc.function.arguments) as { path?: string };
          if (a.path) {
            this.toolResultCache.invalidateFile(a.path);
            // 台账同步失效：文件内容变了，旧覆盖度替身作废（防分支②回显陈旧摘要 → 放行合法重读）
            this.fileExposure.invalidate(a.path);
          }
        } catch {
          /* 参数非 JSON → 忽略 */
        }
      }
      yield {
        type: 'tool_result',
        toolCallId: tc.id,
        name: tc.function.name,
        ok,
        summary: result.slice(0, 100),
        ...(blocked ? { blocked: true } : {}),
      };
    }

    // 循环结束后再查 abort：最后一个工具执行期间被 abort 时返回 aborted:true，
    // 否则 processUserInput 会进入下一轮 LLM 调用（浪费资源）
    if (signal?.aborted) {
      return { aborted: true };
    }
    this.inAutonomousStep = false;
    return { aborted: false };
  }

  /**
   * 第二级压缩（LLM 主动触发兜底）：把最早的 turn 或超大工具结果现场压成临时摘要替换。
   *
   * 作用对象是尚无记忆摘要的东西（第一级替换只对已沉淀摘要的 turn 可用）；压缩摘要是
   * loop 内临时态（标记 executionTemp，下一轮 turn 入口即弃），不进记忆库。
   *
   * @param args 工具参数 JSON（{ target: 'earliest_round' | 'largest_tool_result' }）
   * @param signal 中止信号
   * @returns 回传给 LLM 的确认串（失败/无目标时返回提示，不抛错阻断工具链）
   */
  private async compressContext(args: string, signal?: AbortSignal): Promise<string> {
    try {
      // 解析目标（非法/缺失降级 earliest_round）
      let target: 'earliest_round' | 'largest_tool_result';
      try {
        const parsed = (JSON.parse(args) as { target?: string }).target;
        target = parsed === 'largest_tool_result' ? 'largest_tool_result' : 'earliest_round';
      } catch {
        target = 'earliest_round';
      }

      // 定位目标消息
      const targetMsgs =
        target === 'largest_tool_result' ? this.findLargestToolResult() : this.findEarliestRound();
      if (!targetMsgs || targetMsgs.length === 0) {
        return '[compress_context] 无可压缩目标（上下文为空或目标不存在）';
      }

      // LLM 现场压成临时摘要
      const summary = await this.summarizeForCompression(targetMsgs, signal);
      if (!summary) {
        return '[compress_context] 摘要生成失败，已跳过（不破坏上下文）';
      }

      // 替换为目标内容为临时摘要 system 消息（executionTemp：loop 收尾即弃）
      const tempSummaryMsg: Message = {
        role: 'system',
        content: `[Compressed context · 临时压缩摘要（loop 收尾即弃，细节可能丢失）]\n${summary}`,
      };
      const first = targetMsgs[0]!;
      const last = targetMsgs[targetMsgs.length - 1]!;
      const startIdx = this.messages.indexOf(first);
      const endIdx = last === first ? startIdx : this.messages.indexOf(last);
      if (startIdx === -1 || endIdx === -1) {
        return '[compress_context] 目标已不在当前上下文，已跳过';
      }
      this.messages.splice(startIdx, endIdx - startIdx + 1, tempSummaryMsg);
      this.executionTempSystem.add(tempSummaryMsg);

      logger.info(
        { target, replacedCount: targetMsgs.length },
        'compress_context 已压缩为临时摘要（loop 收尾即弃）',
      );
      // 回调宿主：LLM 主动压缩完成（第二级压缩，与 contextTruncated 的内核自动截断区分）
      this.onContextCompressed?.(target, targetMsgs.length, summary.length);
      return `[compress_context] 已把目标压缩为临时摘要（${summary.length} 字，loop 收尾即弃）：${summary.slice(0, 80)}`;
    } catch (err) {
      logger.warn({ err: toError(err).message }, 'compress_context 压缩失败，已跳过');
      return '[compress_context] 压缩失败，已跳过（不阻断工具链）';
    }
  }

  /**
   * 定位当前触发输入（顶级锚点）之前最早的 turn；无旧轮次（新对话第一轮）返回 null
   * （当前输入永不压缩——交软上限收尾而非压掉触发输入继续硬跑）。
   */
  private findEarliestRound(): Message[] | null {
    // 最后一个 user = 当前触发输入（顶级锚点，永不压缩）
    let lastUserIdx = -1;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i]!.role === 'user') {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx === -1) return null;

    // 第一个 user = 会话最早的 turn；与当前输入重合（仅一轮）→ 无旧轮次可压
    const firstUserIdx = this.messages.findIndex((m) => m.role === 'user');
    if (firstUserIdx === -1 || firstUserIdx >= lastUserIdx) {
      return null;
    }

    // 收集最早 turn（第一个 user 到下一个 user 之前的所有消息）
    const out: Message[] = [];
    for (let i = firstUserIdx; i < this.messages.length; i++) {
      const m = this.messages[i]!;
      if (m.role === 'user' && out.length > 0) break; // 已到下一条 user，停止
      out.push(m);
    }
    return out;
  }

  /** 定位最大的 tool 结果（超大 tool_result 的压缩目标） */
  private findLargestToolResult(): Message[] | null {
    let largest: Message | null = null;
    for (const m of this.messages) {
      if (
        m.role === 'tool' &&
        m.toolCallId &&
        (!largest || m.content.length > largest.content.length)
      ) {
        largest = m;
      }
    }
    return largest ? [largest] : null;
  }

  /** 用 provider 把目标内容压成临时摘要（走 summary 路由，轻量模型优先；失败降级空串） */
  private async summarizeForCompression(
    targetMsgs: readonly Message[],
    signal?: AbortSignal,
  ): Promise<string> {
    try {
      const content = targetMsgs
        .map(
          (m) =>
            `${m.role}: ${typeof m.content === 'string' ? m.content.substring(0, LOOP_CONSTANTS.SUMMARY_CONTENT_SLICE) : '[tool]'}`,
        )
        .join('\n');
      if (!content) return '';

      const summaryProvider = this.opts.providerRouter
        ? this.opts.providerRouter('summary')
        : this.opts.provider;
      const stream = summaryProvider.chat(
        [
          {
            role: 'system',
            content:
              'Summarize the following conversation/execution excerpt into a concise temporary summary (1-3 sentences). ' +
              'Keep key facts, decisions, and tool purposes. This is temporary context compression.',
          },
          { role: 'user', content },
        ],
        { maxTokens: LOOP_CONSTANTS.SUMMARY_MAX_TOKENS, temperature: 0, signal },
      );
      let summary = '';
      for await (const chunk of stream) {
        if (signal?.aborted) break;
        if (chunk.content) summary += chunk.content;
      }
      return summary.trim();
    } catch {
      return '';
    }
  }

  /**
   * 构建 system prompt（装载 bootstrapMemories + 工具描述）
   *
   * 身份中性（architecture_philosophy §11「memora 不需要知道自己是谁」）：
   * 本函数**不注入任何引擎自称**——人格/身份由角色包 systemPromptPrefix 提供
   * （AgentLoop 构造时 `prefix + buildSystemPrompt(...)` 拼接），此处只做
   * 「设定装载 + 回应口径骨架 + 工具描述」，不出现 Memora 专名。
   */
  private buildSystemPrompt(memories: Memory[]): string {
    const sections = memories.map((m) => `## ${m.name}\n\n${m.content}`).join('\n\n---\n\n');
    let prompt = sections
      ? `${sections}\n\n---\n\n基于以上设定，回应用户的问题。`
      : `基于以上设定，回应用户的问题。`;

    // 追加工具描述（让 LLM 知道可用工具及其参数）
    // TS-7 搜索硬上限命中后：同步剔除 web_search 描述，避免「描述存在但工具不可用」不一致
    const tools = this.resolveActiveTools();
    // 工具通道门控（互斥双能力位，2026-09-14 阶段0）：仅当 provider 声明支持原生工具调用时
    // 才列出工具清单并引导调用——无工具能力时列清单会诱导模型吐文本工具骨架（复现旧伤）。
    const supportsToolCalling = this.toolCallingEnabled();
    if (tools && tools.length > 0 && supportsToolCalling) {
      const toolDescs = tools
        .map((t) => {
          const params = Object.entries(t.parameters.properties)
            .map(([name, schema]) => `    - ${name} (${schema.type}): ${schema.description}`)
            .join('\n');
          const required =
            t.parameters.required.length > 0 ? `（必填：${t.parameters.required.join(', ')}）` : '';
          return `  - ${t.name}${required}: ${t.description}\n${params}`;
        })
        .join('\n');
      // 工具清单导语（SSOT 纪律）：只描述工具存在及其参数，**不出现「tool_call」等调用语法字样**——
      // 文本出口不是可调用通道，原生工具宣告唯一真源是 buildChatOptions 的 tools 参数。
      // 曾写作「你可以通过 tool_call 调用以下工具」诱导模型模仿文本标签（mimo 即产出过
      // 未闭合的 <tool_call> 且被当普通文本交付 → 静默失败），故收敛为中性纯描述。
      prompt += `\n\n## 可用工具\n\n以下是当前可用工具及其参数说明：\n${toolDescs}`;

      // 工具导语纪律（分区式 UI 配套）：正文只承载最终交付；调用工具前意图说明压到一句话，
      // 抑制长导语混入正文（首轮工具步在消息级分类前仍逐字流式，纪律把残余降到可忽略）
      prompt += `\n\n${LOOP_CONSTANTS.TOOL_NARRATION_DISCIPLINE}`;

      // 工具选择规则：仅对工具清单中实际存在的 create_* 工具生成指引；
      // 无 create_* 工具时（编辑类宿主直接管理角色/技能/规则配置）整个规则节不输出，
      // 避免指引 LLM 调用不存在的工具（2026-08-28 健康度诊断 H-A）
      const createTools = tools.filter((t) => /^create_/.test(t.name));
      if (createTools.length > 0) {
        const CONFIG_LABELS: Readonly<Record<string, string>> = {
          persona: '角色（Persona）',
          skill: '技能（Skill）',
          rule: '规则（Rule）',
        };
        const createLines = createTools.map((t) => {
          const suffix = t.name.replace(/^create_/, '');
          const label = CONFIG_LABELS[suffix] ?? suffix;
          return `- 创建/修改${label} → 必须使用 ${t.name}，禁止使用 write_file`;
        });
        prompt += `\n\n## 工具选择规则（必须遵守）\n\n${createLines.join('\n')}\n- 以上配置文件的任何操作，永远不要使用 write_file 工具`;
      }

      // 记忆回想导语句（T12 2026-09-11，砍硬收窄后保留软引导）：工具描述块存在即注入，
      // 让 LLM 建立「涉及过往先回想」的通用良习（不依赖轮次状态/查询意图）。
      // toolCallsBlocked（确定性工具屏蔽，角色冻结态）时排除：引导调用被禁止的 search_memories
      // 属描述面不一致——其调用会被 handleToolCalls 确定性拒绝并直接 done，白费一轮 LLM 工具意图。
      if (!this.strategy.toolCallsBlocked) {
        prompt += `\n\n## 记忆回想\n回答涉及过往决定、历史、用户偏好、项目背景，或你不确定答案时，先调用 search_memories。`;
      }
    }

    // 工具能力缺失的显式告知（互斥双能力位回落，F4 防静默）：系统配置了工具集、但当前 provider
    // 既无原生工具调用也无结构化输出时，显式告知 LLM「工具不可用」——让其直接给出文本作答，
    // **不诱导**其试图用文本骨架"调用"工具（避免复现文本 tool_call 旧伤）。logger.warn 留痕可观测。
    if (tools && tools.length > 0 && !supportsToolCalling && !this.structuredOutputEnabled()) {
      logger.warn(
        { provider: this.opts.provider?.name },
        '当前 provider 无工具通道（supportsToolCalling=false 且 supportsStructuredOutput=false），工具清单收起并显式告知 LLM',
      );
      prompt += `\n\n## 工具不可用\n当前模型不支持工具调用（无原生工具协议，也无可用的结构化输出回落）。请直接用文本回答，不要假装调用工具。`;
    }

    return prompt;
  }

  /** 注入系统消息到消息数组（技能注入、角色切换等场景，动态注入上下文） */
  injectSystemMessage(content: string): void {
    this.appendSystemMessage(content);
  }

  /**
   * 剔除文本工具调用骨架（SSOT 纪律的收口）。
   *
   * 返回语义：
   * - 全文**不含**任何文本工具骨架标签 → `null`（正常路径，交付原文不动）；
   * - 含**任一**骨架标签（`<tool_call` / `<function=` / `<parameter` 及闭合）→ 剔除全部
   *   骨架后返回字符串（可能为空串，代表「纯工具意图、无正文交付」）。
   *
   * 宽匹配 + 不校验闭合：针对未闭合/残缺骨架（测试样本即 `<function=list_dir</parameter>`）也能命中。
   * 仅用于「文本出口已不宣告可调用通道」后的防御性收敛，正常模型不应触发。
   */
  private stripToolIntentSkeleton(content: string): string | null {
    // 宽松匹配「文本工具调用」骨架标签（含残缺/未闭合变体）。
    // 允许尾随 = / > / < / 空格 等，命中 `<function=` 这种「属性式起始标签」而不误伤正文英文。
    const SKELETON = /<\/?(?:tool_call|function|parameter)[<>=/\s]?/gi;
    if (!SKELETON.test(content)) return null;
    // 逐段剔除：把每个命中的片段替换为空（含标签本身及其紧随的属性片段）
    return content.replace(SKELETON, '').replace(/\n{3,}/g, '\n\n').trim();
  }

  /**
   * 当前 provider 是否支持原生工具调用（OpenAI Function Calling tools 协议）。
   *
   * 读 provider 的互斥双能力位（2026-09-14 阶段0）：
   * - true → loop 走原生工具通道（列工具 + 传 tools）。
   * - false → 工具通道不可用，须收起工具清单走显式回落（见 buildSystemPrompt / buildChatOptions）。
   * provider 未配置（undefined）时按支持处理（默认 true，与存量「有工具集即传 tools」一致）。
   */
  private toolCallingEnabled(): boolean {
    return this.opts.provider?.supportsToolCalling ?? true;
  }

  /**
   * 当前 provider 是否支持结构化输出（response_format / JSON mode）。
   *
   * 与 toolCallingEnabled 互斥：response_format 不能与 tools 同用（OpenAI 协议限制）。
   * 作为「无原生工具能力」时的显式回落通道（产出机器可读 JSON，而非静默丢弃工具）。
   */
  private structuredOutputEnabled(): boolean {
    return this.opts.provider?.supportsStructuredOutput ?? false;
  }

  /**
   * 解析「本轮可用工具集」——单一真源（SSOT）
   *
   * 工具可用性事实本来被写作两处（buildSystemPrompt 文本出口 + buildChatOptions 原生出口），
   * 属「同语义多实现」带伤。TS-7 搜索硬上限命中后两处都要剔除 web_search，故把排除谓词收敛到本方法。
   * 不修改 opts.toolDefinitions，仅按轮过滤，随 resetTurnState 自然恢复。
   */
  private resolveActiveTools(): readonly ToolDefinition[] {
    const all = this.opts.toolDefinitions ?? [];
    // TS-7 搜索硬上限命中后：从工具集剔除 web_search（确定性停搜，与 system 提示双闸）
    return this.searchDisabled ? all.filter((t) => t.name !== 'web_search') : all;
  }

  /**
   * 构建 LLM 调用选项（互斥双能力位的确定性通道选择，2026-09-14 阶段0）。
   *
   * 通道取当前 provider 的能力位：
   *   - 支持原生工具调用（supportsToolCalling）→ 走 tools 原生 FC 通道（唯一可调用通道）；
   *   - 否则若支持结构化输出（supportsStructuredOutput）→ 走 response_format（JSON mode 回落）；
   *   - 两者皆否 → 不传任何通道（工具不可用，见 buildSystemPrompt 展示的显式回落告知，不静默）。
   *
   * 不传 response_format 的原因（既有纪律保留）：它约束最终响应体，而 tool_calls 是通过
   * tools 参数触发的独立流式协议，两者不能并存；此处仅在「无 tools 能力」时作为落回通道拉通。
   */
  private buildChatOptions(): ChatOptions {
    const tools = this.resolveActiveTools();
    const baseOptions: ChatOptions = {};

    const supportsToolCalling = this.toolCallingEnabled();
    if (tools.length > 0 && supportsToolCalling) {
      baseOptions.tools = tools.map((t) => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters as Record<string, unknown>,
        },
      }));
    }

    // 无原生工具通道 → 显式回落 response_format（仅 provider 声明支持 JSON mode 时）
    if (tools.length > 0 && !supportsToolCalling && this.structuredOutputEnabled()) {
      // 回落 schema：把工具名 + 描述交给模型，让它以 JSON 结构返回「欲调用的工具」，由内核兜底处理。
      // 不为 persistence 承诺闭合——此处是「无原生 FC 时的可观测出口」，非被攻破可执行通道。
      baseOptions.response_format = {
        type: 'json_schema',
        json_schema: {
          name: 'tool_selection',
          strict: false,
          schema: {
            type: 'object',
            properties: {
              tools: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', description: '欲调用的工具名' },
                    arguments: { type: 'object', description: '工具参数' },
                  },
                  required: ['name', 'arguments'],
                },
              },
            },
          },
        },
      };
    }

    // 角色包策略覆盖项（temperature / outputLimit 等）
    if (this.opts.chatOptions) {
      Object.assign(baseOptions, this.opts.chatOptions);
    }

    return baseOptions;
  }

  /** 刷新工具定义（registerTool 后调用），重建 system prompt 让 LLM 看到新工具 */
  refreshToolDefinitions(toolDefinitions: ToolDefinition[]): void {
    // 修改 opts.toolDefinitions 是有意的副作用——后续 buildSystemPrompt() 需读最新工具列表
    this.opts.toolDefinitions = toolDefinitions;
    this.rebuildSystemMessage();
  }

  /** 运行时切换 LLM Provider（多 Provider 路由场景，后续调用使用新 Provider） */
  setProvider(provider: LlmProvider): void {
    this.opts.provider = provider;
  }

  /**
   * 运行时更新上下文窗口上限（token）
   *
   * 与 setProvider 配套：模型热切换时同步窗口，令截断 / 软上限 / 召回注入警戒线
   * （装配期值拷贝字段）随新模型窗口调整。只改窗口数字，不重建对话/不触碰消息。
   *
   * @param tokens 新窗口 token 数
   */
  setContextWindow(tokens: number): void {
    this.maxContextTokens = tokens;
    this.contextManager.setMaxContextTokens(tokens);
  }

  /** 刷新角色包 prompt（角色切换时只替换 prefix，保留 bootstrapMemories 与 toolDefinitions） */
  refreshRolePackPrefix(newPrefix: string): void {
    this.opts.systemPromptPrefix = newPrefix;
    this.rebuildSystemMessage();
  }

  /** 从角色包策略更新 ChatOptions 覆盖项（temperature/outputLimit 等立即生效） */
  setChatOptions(chatOptions: Partial<ChatOptions> | undefined): void {
    this.opts.chatOptions =
      chatOptions && Object.keys(chatOptions).length > 0 ? { ...chatOptions } : undefined;
  }

  /** 刷新 bootstrap 记忆段（设定面板对 rule/skill 增删改后用最新记忆重建 bootstrap 段）。
   *  与 refreshRolePackPrefix 区别：后者替换 prefix（角色包 prompt），本方法替换 bootstrapMemories */
  refreshBootstrapMemories(memories: Memory[]): void {
    this.opts.bootstrapMemories = memories;
    this.rebuildSystemMessage();
  }

  /** 注入情感基调到 system prompt（角色前缀与 bootstrap 记忆之间；与角色切换独立，切换不清除） */
  injectAffect(affectString: string): void {
    this.opts.affectPrefix = affectString;
    this.rebuildSystemMessage();
  }

  /** 重建 messages[0] 的 system prompt */
  private rebuildSystemMessage(): void {
    const sysMsg = this.messages[0];
    if (sysMsg && sysMsg.role === 'system') {
      const prefix = this.opts.systemPromptPrefix ?? '';
      const affect = this.opts.affectPrefix ? `\n${this.opts.affectPrefix}\n` : '';
      this.messages[0] = {
        role: 'system',
        content: prefix + affect + this.buildSystemPrompt(this.opts.bootstrapMemories),
      };
    }
  }

  /** 获取消息历史（用于持久化） */
  getMessages(): readonly Message[] {
    return this.messages;
  }

  /**
   * 记录最近一次输入装配的上下文预算（prepare 期调用，④ 预算可视化）。
   * 只存最新一轮预算供指标快照透出，不跨轮累积。
   */
  recordBudget(budget: ContextBudget): void {
    this.lastBudget = budget;
  }

  /**
   * 获取最近一轮输入装配的上下文预算（G4 预算联动，2026-08-31）
   *
   * 供工具执行器在工具执行期读取剩余预算（search_project 预算下探）。
   * 未 prepare 时返回 undefined（如纯工具单元测试场景）。
   */
  getLastBudget(): ContextBudget | undefined {
    return this.lastBudget;
  }

  /**
   * 记录最近一次输入装配的上下文占用快照（prepare 期调用，④ 预算可视化）。
   * 存最新一轮真实用量供指标快照/输入区指示器透出，不跨轮累积。
   */
  recordOccupancy(occupancy: ContextOccupancy): void {
    this.lastOccupancy = occupancy;
  }

  /**
   * 对话占用实时刷新（④ 预算可视化 · 输入区常驻指示器）。
   *
   * occupancy 主体在 prepare 期 record（见 contextPreparer），但 prepare 发生在 assistant
   * 生成前，故快照的 dialogue 段天然不含本轮 assistant、且单轮对话结束后不再刷新。
   * 本方法在 user 消息落库 / assistant 落盘后以最新 this.messages 重算 dialogue 段：
   *   dialogueCount  = user 消息数（计数标准：一个问答闭环=1，残缺回答如实记录）
   *   dialogueTokens = 全量 user+assistant 估算（容量诚实统计问答闭环总和）
   * 其余段（rolePackBase/memory/inputAnchor/outputReserve）沿用 prepare 快照，不重算
   * （守 SSOT：宿主只透传，内核单一真相源）。
   * 幂等：无快照时 no-op（如首轮 prepare 尚未发生）。
   */
  private refreshOccupancyDialogue(): void {
    if (!this.lastOccupancy) return;
    const conv = this.getConversationMessages();
    const dialogueCount = conv.filter((m) => m.role === 'user').length;
    const dialogueTokens = this.estimateTokens(conv);
    this.lastOccupancy = { ...this.lastOccupancy, dialogueCount, dialogueTokens };
  }

  /**
   * 写入当前激活角色包底盘占用（system prompt 总体 token）。
   * 装配 / 切换角色包时调用（早于 prepare），使冷启动 / 重启首屏即可显示真实占比；
   * prepare 期 recordOccupancy 也以其实际注入值覆盖，口径一致（同一估算器）。
   */
  setRolePackBaseTokens(tokens: number): void {
    this.rolePackBaseTokens = tokens;
  }

  /** 读取当前激活角色包底盘占用（未确定时为 undefined，调用方降级处理） */
  getRolePackBaseTokens(): number | undefined {
    return this.rolePackBaseTokens;
  }

  /**
   * 获取 AgentLoop 运行时指标快照（纯只读、零副作用，适合宿主轮询构建监控面板）。
   */
  getMetrics(): AgentMetrics {
    return {
      llm: {
        callCount: this.metrics.llmCallCount,
        totalInputTokens: this.metrics.totalInputTokens,
        totalOutputTokens: this.metrics.totalOutputTokens,
        actualInputTokens: this.metrics.actualInputTokens,
        actualOutputTokens: this.metrics.actualOutputTokens,
      },
      tools: {
        callCount: this.metrics.toolCallCount,
        failureCount: this.metrics.toolFailureCount,
        unparsedToolIntentCount: this.metrics.unparsedToolIntentCount,
      },
      context: {
        truncationCount: this.contextManager.truncationCount,
        messageCount: this.messages.length,
        estimatedTokens: this.contextManager.estimateTokens(this.messages),
        ...(this.lastBudget ? { budget: this.lastBudget } : {}),
        ...(this.lastOccupancy ? { occupancy: this.lastOccupancy } : {}),
        ...(this.rolePackBaseTokens !== undefined
          ? { rolePackBaseTokens: this.rolePackBaseTokens }
          : {}),
      },
      plan: {
        taskTableWriteCount: this.metrics.planTaskTableWriteCount,
        stepBoundaryCount: this.metrics.stepBoundaryCount,
      },
      tasks: {
        totalCount: this.metrics.taskTotalCount,
        successCount: this.metrics.taskSuccessCount,
        failureCount: this.metrics.taskFailureCount,
        successRate: roundTo(this.metrics.taskSuccessRate, 3),
        avgDurationMs: this.metrics.taskAvgDurationMs,
      },
    };
  }

  /** 估算消息 token 数（CJK 感知，委托 ContextManager）——装配层/预算派生复用同一估算真理源 */
  estimateTokens(messages: readonly Message[]): number {
    return this.contextManager.estimateTokens(messages);
  }

  /** 被替换轮 roundId 列表（第一级替换产物；装配层合并进 exclude 防其摘要被二次召回） */
  getReplacedRoundIds(): readonly string[] {
    return Array.from(this.replacedRoundIds);
  }

  /** 当前工作记忆中实际保留的轮次 roundId 集合（装配 exclude 用，T1 2026-09-01）。
   *  扫描视图内 user 消息自带 roundId（与 ReplaceRoundsStrategy.groupRounds 同源，
   *  无外部序列/尾部对齐依赖）。覆盖截断重排后按重要性提炼保留的中间轮——其正文已在
   *  视图，round-summary 须排除防与该正文双写；被完全裁掉的旧轮不在集合内，其摘要仍可召回。 */
  getVisibleRoundIds(): ReadonlySet<string> {
    const ids = new Set<string>();
    for (const msg of this.messages) {
      if (msg.role === 'user' && msg.roundId) {
        ids.add(msg.roundId);
      }
    }
    return ids;
  }

  /**
   * 召回互斥排除集（memory-tool-recall-design §5.1）：正文已不在眼前、但其摘要已在眼前的轮次。
   *
   * = 视图内轮次（`getVisibleRoundIds`，含截断后按重要性保留的中间轮）
   *   ∪ 已被第一级替换的轮次（`getReplacedRoundIds`，正文被换成了摘要，roundId 已不在 messages
   *     但摘要已在上下文，故须另计——否则其 round-summary 会被二次召回重复返回）
   *   ∪ 当前在途轮次（`currentRoundId`，当轮 user 已落 store 但尚未进 messages 的窗口期）。
   *
   * **唯一真理源**：从 loop 的工作记忆视图派生（精确集合），不再用「最近 N 轮」代理量近似。
   * 由装配期注入 `search_memories`（`toolExec.setExclusionRoundIdsProvider`）。
   * 首轮若仍在视图内则已被覆盖；长会话首轮被裁掉时可另行显式计入（当前无消费者，未接）。
   */
  getExclusionRoundIds(): ReadonlySet<string> {
    const ids = new Set<string>(this.getVisibleRoundIds());
    for (const rid of this.replacedRoundIds) {
      ids.add(rid);
    }
    if (this.currentRoundId) {
      ids.add(this.currentRoundId);
    }
    return ids;
  }

  /**
   * 获取当前窗口中的完整对话消息（仅 user + assistant，排除 system/tool）。
   * 供 contextPreparer 计量 fixed/query 模式下实际进窗的完整对话占用
   * （区别于 hybrid 模式注入的最近轮次摘要块，见 getRecentHistoryWithinBudget）。
   */
  getConversationMessages(): Array<{ role: 'user' | 'assistant'; content: string }> {
    // 过滤出 user + assistant 消息（排除 system 和 tool）
    return this.messages.filter(
      (m): m is { role: 'user' | 'assistant'; content: string } =>
        m.role === 'user' || m.role === 'assistant',
    );
  }

  /**
   * 按预算容量派生完整对话层轮次集合（动态轮数，role-pack-spec §C/§D）。
   * 从最近往回塞到预算止，会话第一条问答闭环必然在场（次级锚点：默认在场，压缩可让位）。
   *
   * @param maxTokens 完整对话层预算（token，由上下文预算计算派生）
   * @returns 注入的历史序列 + 最近轮数（供互斥 roundId 排除）+ 是否显式补了第一条
   */
  getRecentHistoryWithinBudget(maxTokens: number): {
    history: Array<{ role: 'user' | 'assistant'; content: string }>;
    recentRoundCount: number;
    firstRoundIncluded: boolean;
  } {
    // 复用 getConversationMessages 过滤逻辑（单一来源，避免双份过滤）
    const conversationMessages = this.getConversationMessages();

    // 按 user 消息切分为轮次（每轮 = 该 user 起至下一个 user 前的所有消息）
    const rounds: Array<{ role: 'user' | 'assistant'; content: string }[]> = [];
    for (const m of conversationMessages) {
      if (m.role === 'user') {
        rounds.push([m]);
      } else if (rounds.length > 0) {
        rounds[rounds.length - 1]!.push(m);
      }
    }

    // 每轮 token 成本（最旧在前），经纯函数派生最近轮数 + 第一条是否显式补入
    const roundCosts = rounds.map((r) => this.contextManager.estimateTokens(r));
    const { recentRoundCount, firstRoundIncluded } = deriveDialogueRounds(roundCosts, maxTokens);

    // 组装注入历史：显式补的第一条（若有）+ 最近 recentRoundCount 轮
    const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    if (firstRoundIncluded && rounds.length > 0) {
      history.push(...rounds[0]!);
    }
    const recentStart = Math.max(0, rounds.length - recentRoundCount);
    for (let i = recentStart; i < rounds.length; i++) {
      history.push(...rounds[i]!);
    }

    return { history, recentRoundCount, firstRoundIncluded };
  }

  /** 获取当前轮次 ID（processUserInput 入口分配，多 iteration 共享），空串表示无活动轮次 */
  getCurrentRoundId(): string {
    return this.currentRoundId;
  }

  /** 设置当前轮次 ID（appendUser 在 processUserInput 之前调用，故需提前生成供 RoundSummaryGenerator 使用） */
  setCurrentRoundId(roundId: string): void {
    this.currentRoundId = roundId;
  }

  /** 分配新轮次 ID（SSOT：prepare 提前生成与 processUserInput 回退生成共用唯一出处，避免 round-模板串重复漂移） */
  allocRoundId(): string {
    return `round-${Date.now()}`;
  }

  /**
   * 恢复历史消息（跳过 system，只恢复 user/assistant/tool；传空数组=清空工作记忆，保留 system prompt）
   *
   * 历史集合被整体替换是上下文摘要缓存的失效点（见 ContextManager.resetSummary 注释：
   * 若新历史更短，长度差反推会误判"未过期"，把上一段会话的陈旧摘要注入新上下文）。
   * 故整体替换（清空 / 恢复检查点）经此入口时统一作废摘要缓存——调用方无需各自记得调 reset，
   * 失效动作与替换动作同处（SSOT）。
   */
  restoreHistory(historyMessages: readonly Message[]): void {
    // 历史整体替换（跨日重置/切会话/恢复检查点）：旧的「已被第一级替换」记账归属上一会话，
    // 须一并清空，避免 stale roundId 污染新会话的召回互斥集（与 resetSummary 同属恢复 chokepoint）
    this.replacedRoundIds.clear();
    // 过滤掉 system 消息（已有初始化的 system prompt）
    const nonSystemMessages = historyMessages.filter((m) => m.role !== 'system');

    if (nonSystemMessages.length === 0) {
      // 空数组=意图清空工作记忆（跨日重置/切空会话），保留 system prompt，防旧上下文残留注入
      this.replaceContext(this.messages[0] ? [this.messages[0]] : []);
      // 历史整体清空：作废上下文摘要缓存，防上一段会话摘要残留注入
      this.contextManager.resetSummary();
      logger.debug({ messageCount: 0 }, '已清空工作记忆（保留 system prompt）');
      return;
    }

    const systemPrompt = this.messages[0];
    if (!systemPrompt) {
      logger.warn({ hasSystemPrompt: false }, 'restoreHistory: 没有 system prompt，跳过恢复');
      return;
    }
    this.replaceContext([systemPrompt, ...nonSystemMessages]);
    // 历史整体替换（恢复检查点/切换会话）：作废上下文摘要缓存，防陈旧摘要注入新上下文
    this.contextManager.resetSummary();

    logger.info({ messageCount: nonSystemMessages.length }, '恢复历史对话消息');
  }

  /** 作废 loop 级派生缓存（会话替换 chokepoint 调用）；只暴露行为不暴露 ContextManager，保持边界有界 */
  resetContextSummary(): void {
    this.contextManager.resetSummary();
  }

  /** 清理上一轮注入的临时 system 消息（每轮 chat() 前调用），防 recall/技能/截断注入堆积成冗余指令 */
  cleanTemporarySystemMessages(): void {
    if (this.messages.length <= 1) {
      // 无对话消息可清：仅同步清空 executionTempSystem 引用集（防与下方正常路径不一致的滞后残留）
      if (this.executionTempSystem.size > 0) {
        this.executionTempSystem.clear();
      }
      return;
    }
    const permanent = this.messages[0]!;
    const conversationHistory = this.messages.slice(1).filter((m) => m.role !== 'system');
    const removedCount = this.messages.length - 1 - conversationHistory.length;
    this.replaceContext([permanent, ...conversationHistory]);
    // 已移除全部非永驻 system 消息：executionTempSystem 引用的消息皆不在上下文，
    // 同步清集合消除引用滞后（双清机制一致化，2026-09-11）——否则集合保留旧引用至下次闭环入口
    if (this.executionTempSystem.size > 0) {
      this.executionTempSystem.clear();
    }
    if (removedCount > 0) {
      logger.debug(
        { removedCount, remainingMessages: this.messages.length },
        '临时 system 消息已清理',
      );
    }
  }

  /**
   * 清理执行期临时 system 消息（self-review / reflection / duplicate-warning / metaNote）。
   *
   * 每轮闭环入口执行一次（processUserInput / continueAfterPause），清掉上一轮
   * 执行中产生、下一轮不应再见的残留。与 prepare 阶段的装配性注入区分：装配注入（召回、
   * 最近对话）不在此集合，保留到 prepare 重建。replaceContext 走浅拷贝保留消息引用，
   * 故按引用过滤是安全且幂等的。
   */
  private cleanExecutionTemporary(): void {
    if (this.executionTempSystem.size === 0) return;
    const kept: Message[] = [];
    const permanent = this.messages[0];
    this.messages.forEach((m) => {
      // 保留永驻 system prompt 与所有非执行期临时消息
      if (m === permanent || !this.executionTempSystem.has(m)) {
        kept.push(m);
      }
    });
    this.executionTempSystem.clear();
    logger.debug(
      { removedCount: this.messages.length - kept.length },
      '执行期临时 system 消息已清理（闭环入口自动）',
    );
    this.replaceContext(kept);
  }

  // ─── 工作记忆受控写入口 ─────────────────────────────────────
  // 收敛全部裸 push/replace 写点：每类消息的固定约束（如 <user_input> 包裹）
  // 内聚在对应写方法内，禁止外部散落裸写 this.messages，杜绝"漏包裹/乱设 role"风险面。

  /** 追加一条 user 消息（统一 <user_input> 标签包裹，防注入攻击）；附当前轮次 roundId（替换式压缩单一真理源） */
  private appendUserMessage(content: string): void {
    this.messages.push({
      role: 'user',
      content: `<user_input>${content}</user_input>`,
      roundId: this.currentRoundId,
    });
    // 用户输入即刷新占用条数（问答闭环 +1，实时反映到输入区圆环）
    this.refreshOccupancyDialogue();
  }

  /** 追加一条 system 消息（技能注入、召回、任务表、自审查提示等通用注入通道） */
  private appendSystemMessage(content: string, opts: { executionTemp?: boolean } = {}): void {
    const msg: Message = { role: 'system', content };
    this.messages.push(msg);
    // 执行期临时标记：进入 executionTempSystem 引用集，供 cleanExecutionTemporary 在每轮闭环入口自动移除
    if (opts.executionTemp) {
      this.executionTempSystem.add(msg);
    }
  }

  /** 追加一条 assistant 纯文本消息（正常 LLM 回复或兜底文本）；附当前轮次 roundId */
  private appendAssistantText(content: string): void {
    this.messages.push({ role: 'assistant', content, roundId: this.currentRoundId });
    // assistant 落盘（含残缺/中止回复）后补算对话容量，使圆环即时含本轮回答
    this.refreshOccupancyDialogue();
  }

  /** 追加一条带 toolCalls 的 assistant 消息（executeToolCalls 前导）；附当前轮次 roundId */
  private appendAssistantToolCall(
    fullContent: string,
    toolCalls: NonNullable<Message['toolCalls']>,
  ): void {
    this.messages.push({
      role: 'assistant',
      content: fullContent,
      toolCalls,
      roundId: this.currentRoundId,
    });
  }

  /**
   * 追加一条 tool 消息（loop **唯一** tool 写点：工具结果 / `[ASK_ANSWER]` / `[ASK_ABORTED]` 三处皆经此）。
   *
   * **入口关**（大文本统一通道 §6.2）：单条内容超 `SINGLE_TOOL_RESULT_MAX_TOKENS` → 原文落盘，
   * 上下文只留「路径 + 预览 + 续读提示」。收口在此而非 `_processToolResults`：后者只覆盖工具结果，
   * 会漏掉 `answerQuestion` 的 `[ASK_ANSWER]` —— 用户被问「请提供需求文档」后直接贴长文即可超阈。
   */
  private appendToolMessage(content: string, toolCallId: string): void {
    const finalContent = this.offloadDir
      ? offloadLargeToolResult(content, { offloadDir: this.offloadDir }).content
      : content;
    this.messages.push({
      role: 'tool',
      content: finalContent,
      toolCallId,
      roundId: this.currentRoundId,
    });
  }

  /**
   * 情报区写回（remember_intel 工具实现，CLoop 拦截执行）：把 LLM 私有笔记追加到情报区。
   *
   * 累积为 `intelNote`（跨 turn 自持）；超 `MAX_INTEL_PREFIX_LEN` 裁最旧（保留最新）。返回给 LLM 的
   * ack **不回填 note 原文**（工具结果只回「已记录」），note 原文只进情报区 system 消息 → 不在用户流。
   *
   * @param args remember_intel 的 JSON arguments
   * @returns 简短 ack（作为该工具调用的 tool 结果）
   */
  private handleRememberIntel(args: string): string {
    let note: string | undefined;
    try {
      const parsed = JSON.parse(args) as { note?: unknown };
      note = typeof parsed?.note === 'string' && parsed.note.trim() ? parsed.note.trim() : undefined;
    } catch {
      note = undefined;
    }
    if (!note) {
      return '[情报区] 未写入：note 为空或缺少该参数。';
    }
    const prev = this.intelNote;
    this.intelNote = prev ? `${prev}\n${note}` : note;
    // 数据上限：超限裁最旧（保留最新），防单 turn 内多次写入把笔记撑爆
    if (this.intelNote.length > LOOP_CONSTANTS.MAX_INTEL_PREFIX_LEN) {
      this.intelNote = this.intelNote.slice(-LOOP_CONSTANTS.MAX_INTEL_PREFIX_LEN);
    }
    return '[情报区] 已记录（对你私有，不会展示给用户）。';
  }

  /**
   * 每轮装配把情报区注入为**单条尾部私有 system 消息**（Step 2）。
   *
   * - 复用 Message[] 视图：不新增对象，情报区 = 一条 system 消息正文；
   * - 已存在则更新原文（保持单条），被截断删除则重建 → 参与 `truncateMessages` 尾部淘汰（B 语义）；
   * - 非 executionTemp → 跨 turn 自持（每轮 `_prepareContext` 注入最新版）。
   *
   * **归属注**：对已存在消息的 `existing.content = ...` 属**单条尾部私有消息的幂等刷新**（同
   * `ResultReplacement` 只改 content），**不是装配重排**——不违背 loop「只追加、不重装配」的编排原则。
   *
   * **时序注（2026-09-13，诚实声明）**：`_prepareContext` 先算 `safeMessages`、后注入本消息——
   * 在**截断轮**（截断重排后安全快照 ≠ this.messages）里，本轮被发送的 `safeMessages` 不含本情报区，
   * 下一轮 `_prepareContext` 重算后才可见（瞬时，非死锁）。此与 search 收敛提示 / taskTable 等所有
   * 既有动态注入提示的时序一致（库级既有行为），非本机制特例。
   */
  private injectIntelNote(): void {
    if (!this.intelNote) return;
    const content = `${INTEL_INTRO}\n\n${this.intelNote}`;
    const existing = this.messages.find(
      (m) => m.role === 'system' && typeof m.content === 'string' && m.content.startsWith(INTEL_INTRO),
    );
    if (existing) {
      existing.content = content;
    } else {
      this.messages.push({ role: 'system', content });
    }
  }

  /**
   * 缓存条目对应的工具结果是否**仍在当前上下文中** —— 防重拦截的前提（调用点见 handleToolCalls）。
   *
   * 三道判据全过才算「在」：① 条目带 toolCallId 与指纹；② `this.messages` 中仍有该 toolCallId 的
   * tool 消息；③ 其内容指纹与记录一致（内容未被压缩链替换成 `[Previous: used x]` 占位符）。
   *
   * **保守方向：宁可放行，不可误拦。** 找不到消息 / 指纹不符 / 条目缺元信息 → 一律 false（放行）。
   * 误放行的代价是「多读一次」；误拦的代价是「内容已不在手上却读不回来 = 死锁」——两者不对称。
   *
   * 注：超阈结果经入口关落盘后，上下文里留的是「路径 + 预览」，与记录指纹（包裹后的原文）不符
   * → 判为「不在」，重读放行。这是正确语义：原文确实已不在上下文中。
   */
  private isCachedResultStillInContext(entry: CacheEntry): boolean {
    if (entry.toolCallId === undefined || entry.fingerprint === undefined) return false;
    const msg = this.messages.find((m) => m.role === 'tool' && m.toolCallId === entry.toolCallId);
    if (!msg) return false;
    return sha256Fingerprint(msg.content) === entry.fingerprint;
  }

  /** 整体替换执行上下文（截断落盘 / 恢复历史 / 装配重排：传入的数组已是完整上下文） */
  private replaceContext(next: Message[]): void {
    this.messages = next;
  }

  // ─── Reflection 辅助方法 ────────────────────────────────

  /** 处理工具执行结果：push tool 消息 + 统计失败数 */
  private _processToolResults(
    toolCalls: NonNullable<Message['toolCalls']>,
    results: string[],
  ): void {
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i]!;
      const result = results[i]!;
      // 工具结果隔离：用 <tool_result> 包裹 + 指令前缀，防外部工具返回承载间接注入；
      // ERR 前缀保留在包裹内，供 isRetryableToolError 识别（该正则不锚定行首）
      const wrapped = wrapToolResult(tc.function.name, result);
      this.appendToolMessage(wrapped, tc.id);
      if (result.startsWith('[ERR')) {
        this.metrics.toolFailureCount++;
      }
    }
  }
}
