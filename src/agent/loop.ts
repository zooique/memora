/**
 * turn（问答闭环）Act 引擎（AgentLoop）— turn 回答中阶段的 loop（对 step 的编排，官方 Agent Loop 本义）
 *
 * 概念定位（所有复杂度在单 turn step 循环里承载，无多 turn 任务编排）：
 *   - step = 一次 LLM 调用 + 可选工具执行（runIterationLoop 内每次循环体）；
 *   - loop = 对 step 的编排：turn 回答中阶段反复拉起 step 直到输出最终回答；
 *   - 本类承载 turn（问答闭环）的 Act 引擎（含 loop=step 编排），是 turn 的身体引擎；
 *   - 复杂任务（task_table_write + 动态规划）在一个 turn 的 step 循环里自然生长，
 *     不再强制拆成多 turn 编排；
 *   - 上下文 = 用户输入 + Agent 记忆召回结果 + 运行帧追加。
 */
import type { LlmProvider, Message, ChatOptions } from '@/llm/provider.js';
import type { ProviderRouter, TaskType } from '@/llm/types.js';
import type { Memory } from '@/memory/types.js';
import type { ToolDefinition } from '@/agent/toolExecutor.js';
import {
  ASK_USER_TOOL,
  COMPRESS_CONTEXT_TOOL,
  REMEMBER_INTEL_TOOL,
  OPAQUE_WRITE_TOOL_NAMES,
} from '@/agent/builtinTools.js';
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
import { ContextManager, SOFT_LIMIT_SUMMARY_MARKER_COMPRESS } from '@/agent/contextManager.js';
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
  WRITE_PATH_EXTRACTORS,
  normalizePathKey,
  type CacheEntry,
} from '@/agent/toolResultCache.js';
import { createDefaultGuards, GUARD_THRESHOLDS, type GuardThresholds } from '@/agent/guardRail.js';
import {
  FileExposureLedger,
  parseReadFileCoverage,
  formatLedgerStub,
  shouldEchoLedgerStub,
  READ_DIGEST_CHARS,
} from '@/agent/toolLedger.js';
import type { RoundEvidenceEvent } from '@/memory/roundStore.js';
import { nowIso } from '@/utils/time.js';
import type { L2RuntimeStrategy } from '@/role-pack/types.js';
import { DEFAULT_L2_STRATEGY } from '@/role-pack/strategyResolver.js';
import { DEFAULT_MAX_ITERATIONS } from '@/role-pack/strategyKeys.js';
import { ToolRunner } from '@/agent/toolRunner.js';
import { detectNeedsPlanning, PLAN_NUDGE_PROMPT } from '@/agent/needsPlanning.js';
import {
  formatBackgroundTaskNotice,
  type BackgroundTaskRegistry,
} from '@/agent/backgroundTasks.js';

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
  /** 任务表触发覆盖钩子：宿主可覆写 needsPlanning 判定。
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
    // 压缩目标枚举的**单一真源** = CompressTarget（新增 earliest_steps 随目标集同步，
    // 禁在此处另写一份字面量联合——那会让回调签名与 loop 内部判据漂移）
    target: CompressTarget,
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
  /** ChatOptions 覆盖项（角色包策略注入 temperature/outputLimit 等；与默认值的关系见 defaultMaxTokens） */
  chatOptions?: Partial<ChatOptions>;
  /**
   * per-LLM 输出预算默认值（token，宿主 per-LLM 配置透传）：buildChatOptions 填入底座，
   * 与角色包策略覆盖项（chatOptions，act.outputLimit）**取更小值**（两者都是「上限」性质，
   * 须同时满足——对齐上下文窗口 min(provider 窗口, 角色包 contextLimit) 的语义）。
   * undefined = 不传 max_tokens（回服务端默认）。请求层只做形态归一（非正整数不传），
   * 上限不裁决——本层与请求层均不设上限（真实上限由服务端裁决，见 normalizeMaxTokens）。
   */
  defaultMaxTokens?: number;
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
 * step 边界气口申请——统一三种用户申请的气口语义（SSOT，单一队列）：
 *  若分散为 pauseRequested flag + pendingInterjections[] 两处写位，易漂移不一致（坑）——统一进单一队列：
 *    - pause：宿主 requestPause → queueInterrupt({kind:'pause'})
 *    - interject：宿主 interject → queueInterrupt({kind:'interject', content})
 *    - ask_user 不走此队列（它是 LLM 工具触发的气口，在工具分支直接 yield paused，与用户申请气口不同源）
 *    - command-result：后台命令完成回流（**系统事件**，非用户申请）——同队列复用、异质处理，
 *      见下方「回流 kind 的隔离纪律」
 *
 * 消费方 = _handleInterrupt：step 边界统一 queue.splice(0) 取出全部申请，
 * 先注入型（interject → appendUser / command-result → appendSystem）后挂起型（pause → yield paused）。
 *
 * **回流 kind 的隔离纪律**（§12.5 第 8 条 / §14.2）：
 *   - 注入通道不同：interject → `appendUserMessage`（用户意图）；command-result → `appendSystemMessage`
 *     （系统事件，role 语义隔离，不伪装成用户发言）；
 *   - 满员判据不同：`interject()` 的容量裁决只看 kind==='interject'（`getPendingInterjections` 过滤），
 *     故回流条目天然不占插话满员计数，也永不因满员被拒；
 *   - 生命周期不同：插话随 turn 入口清理，回流随 turn 终态丢弃（不跨 turn，§14.5）。
 */
type InterruptRequest =
  | { readonly kind: 'pause' }
  | { readonly kind: 'interject'; readonly content: string }
  | { readonly kind: 'command-result'; readonly content: string };

/**
 * `compress_context` 的压缩目标枚举（第二级压缩，CTX-WIN-2）
 *
 * 三个目标**按上下文形态分工**，不是同一件事的三种叫法（合并即降级为「泛化遍历」）：
 * | target | 适用形态 | 锚点 |
 * | - | - | - |
 * | `earliest_round` | 多轮问答（≥2 个 user） | 第一个 user → 下一 user 之前 |
 * | `earliest_steps` | **单轮长任务**（仅 1 个 user、几十个 step） | 第一个 assistant → 下一 assistant 之前 |
 * | `largest_tool_result` | 单条超大工具结果 | 最大 tool 消息 + 其所属 assistant（整段） |
 *
 * 缺 `earliest_steps` 的后果（实锤）：单轮 turn 内 `earliest_round` 恒 null
 * （锚点 first-user == last-user），长单轮把窗口顶满却无任何可压目标。
 *
 * **导出理由**：`contextCompressed` 事件载荷（`utils/eventEmitter.ts`）也带 target，
 * 该处**必须引用本类型**而非另写一份字面量联合——两份字面量必然随枚举增补漂移
 * （`earliest_steps` 加入时，漂移形态 = 事件类型不认新值 + 宿主三元文案落到 else 显示错标签）。
 */
export type CompressTarget = 'earliest_round' | 'earliest_steps' | 'largest_tool_result';

/** 合法 target 清单（工具描述与错误提示共用此真源，避免文案列举与判据漂移） */
export const COMPRESS_TARGETS: readonly CompressTarget[] = [
  'earliest_round',
  'earliest_steps',
  'largest_tool_result',
];

/**
 * target → 中文标签（宿主 notice 文案的真源，**穷举映射不做 else 兜底**）
 *
 * 穷举而非三元/else：三元在枚举增补时把新值静默落到最后一个旧标签上（说谎），
 * TS 侧因 `Record<CompressTarget, string>` 穷尽键而在增补时**编译期报错**——
 * 让「加枚举忘了改文案」变成一道红闸，而不是运行时的一句假话。
 */
export const COMPRESS_TARGET_LABELS: Record<CompressTarget, string> = {
  earliest_round: '最早轮次摘要',
  earliest_steps: '最早执行步骤摘要',
  largest_tool_result: '最大工具结果摘要',
};

/**
 * 解析压缩目标（非法/缺失降级 `earliest_round`——保持既有行为，不扩大缺省面）
 *
 * 单点收口：判据只此一处，工具描述与回传提示的列举均引 `COMPRESS_TARGETS`。
 */
function parseCompressTarget(raw: string | undefined): CompressTarget {
  return COMPRESS_TARGETS.find((t) => t === raw) ?? 'earliest_round';
}

/*
 * 职责边界登记（暂不拆分）
 *
 * 「上下文准备」不下沉 contextPreparer.ts、「中断/暂停」不下沉 sessionStateMachine.ts，
 * 采取「职责登记而非代码拆分」（自然生长触发前不动契约）——两者与目标模块现有契约冲突：
 *   - _prepareContext（资源边界副操作：截断/压缩/预算/情报/任务表注入）深读深写 this.messages
 *     并依赖 ≥15 个私有状态/方法，本质是 step 编排的一部分——不并入 contextPreparer
 *     （其契约「只依赖 Agent 注入稳定能力、不反向依赖 Agent 私有状态」本就排除此形态）。
 *   - 中断/暂停（interruptQueue + _handleInterrupt + interject 追加用户消息、step 边界 yield paused）
 *     与 sessionStateMachine 的「纯三态 + pendingPause」语义不同源（后者不承载 interject 追加与
 *     step 边界产出）——不并入，维持 loop 自持。
 *   - 消息写入口（append* / clean* + 观测埋点 recordBudget/recordOccupancy/refreshOccupancyDialogue）同判
 *     不拆：写入口持有 messages / currentRoundId / executionTempSystem / offloadDir 四项 loop 私有状态，
 *     并回调 refreshOccupancyDialogue（**写消息→触发观测，跨域**），不满足 progressive-refactor-rules
 *     §2.2 模式 B「职责正交（不共享状态 / 不互相调用）」前提；模式 A（领域容器提取）只搬字段不搬逻辑，
 *     收益不足以覆盖改点面。保留监控，待自然生长触发。
 *   - 搜索生命周期：软上限/硬上限混沌形同构但为**同一意图的三级级联**——
 *     软提示 threshold=2「劝」（successfulWebSearchCount + searchConvergenceHintInjected）→
 *     硬拦截 MAX=6「挡」（searchCallCount + searchDisabledHintInjected）→ 工具集剔除「断」searchDisabled。
 *     阈值单源（constants.ts LOOP_CONSTANTS.SEARCH_*）。5 个运行时状态字段散在 loop（私有、
 *     经 counters 一致注入、随 resetTurnState 邻接重置，无平行数组错位风险）。
 *     声明：这是 loop 私有生命周期状态，非 guardRail 护栏注册表项，不做对象化提取（避免提前抽象、
 *     兜旁白），维持现状即为已声明设计。
 * 结论：loop 为「功能内聚门面」（职责虽多但共享同一可变 messages 工作记忆），按 progressive-refactor-rules
 * §1 软阈值保留监控，待真实场景触发「去重/拼接/总线慢」等修改成本证据再评估拆分。
 */

/** 情报区（LLM 私有工作笔记）system 消息前导：注入起点判定 + 私有/禁复述约束（与返回字段同源） */
const INTEL_INTRO =
  '[情报区 · 仅供你私有查看并作为后续作答的参考]。此区内容不要向用户复述或写进项目文档。' +
  '当你从大文本/工具结果获取到新的关键信息时，可用一句简短状态反馈用户进展（如：原来是这样… / 掌握了关键信息 / ' +
  '有一个问题… / 基本收集完毕），但不要在反馈中复述笔记/原文细节。';

export class AgentLoop {
  private messages: Message[] = [];
  private readonly maxIterations: number;
  /** provider 上下文窗口（原始声明值，默认 120_000）。模型热切换经 setContextWindow 写入。 */
  private providerContextWindow: number;
  /** **有效上下文窗口** = min(providerContextWindow, strategy.contextLimit>0 ? contextLimit : ∞)。
   *  派生值（非独立真源）：由 #recomputeEffectiveWindow 在「provider 窗口变更」与「角色策略变更」
   *  两个入口重算；是截断 / 软上限 / 占用快照统一消费的唯一窗口数字。 */
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
   * 不算临时，吃 cleanTemporarySystemMessages；执行期临时的清理由每轮闭环入口自动执行
   * （cleanExecutionTemporary），保证跨步残留不堆积。replaceContext 走浅拷贝，
   * 引用保持有效，按引用 filter 即可安全移除。
   */
  private readonly executionTempSystem = new Set<Message>();
  /** 上一轮工具调用的哈希（运行时状态，拦截器判定时使用） */
  private lastToolCallsHash: string = '';
  /** 连续重复次数（运行时状态，拦截器判定时使用） */
  private duplicateToolCallCount: number = 0;
  /** 当前迭代序号（processUserInput 循环内维护，供拦截器 context 与 toolResultCache 老化使用）。
   *  语义边界：本计数 = **循环内**迭代号（runIterationLoop 重启即从头）；轮粒度 step 序号
   *  （thought 归属打标）另见 roundStepIndex——两者重置域不同（循环 vs 轮），勿互替。 */
  private currentIteration: number = 0;
  /** 当前轮次已推送的 REFLECTION_HINT 次数。用显式计数器而非 filter 推断，
   *  避免上下文中段消息被裁剪后计数失真 */
  private reflectionCountThisTurn: number = 0;
  /** 搜索收敛护栏：本闭环内成功 web_search 次数（executeToolCalls 累计，_prepareContext 检查） */
  private successfulWebSearchCount = 0;
  /** 搜索收敛护栏：本轮是否已注入收敛提示（幂等，防迭代累积刷屏） */
  private searchConvergenceHintInjected = false;
  /** 搜索硬上限：本闭环内 web_search 调用次数（含被拒绝的，达到上限后后续搜索直接拒绝） */
  private searchCallCount = 0;
  /** 搜索硬上限命中后：从后续 LLM 调用的工具集确定性移除 web_search（双闸的第二闸，
   *  与 system 提示互补，彻底终结「拒绝风暴」耗尽迭代/上下文导致问答闭环中断） */
  private searchDisabled = false;
  /** 搜索硬上限提示注入标记（幂等，防迭代累积重复注入） */
  private searchDisabledHintInjected = false;
  /** 软上限收尾信号注入标记（幂等，防迭代累积刷屏）：摘要层饱和是跨迭代持续态，
   *  同一 turn 内经本 flag 最多注入一次收尾信号；随 resetTurnState 重置——
   *  每个新 turn（新用户输入）重新注入一次（每轮回答都需要收敛提醒），
   *  防的是「同 turn 多步迭代各注一条」的刷屏（口径与搜索收敛 flag 同构）。 */
  private softLimitWrapupInjected = false;
  /** 规划层：本 turn 是否判定为需任务表规划（processUserInput 入口由检测结果设值，
   *  continueAfterPause 续跑不重判——plan 已建则无需 nudge） */
  private planNeedsNudge = false;
  /** 规划层：本 turn 是否已注入命令式引导（幂等，仅首迭代一次，随 resetTurnState 重置） */
  private planNudgeInjected = false;
  /** 工具结果防重缓存（闭环内有效，每轮 resetTurnState 清空）。
   *  拦截 read_file/list_dir/web_search 的同 key 重复调用，返回 [ALREADY_READ] 拒绝文案，
   *  终结 LLM 在同一批文件上反复轮询导致的死循环（token 爆炸 + maxIterations 撞线） */
  private readonly toolResultCache = new ToolResultCache();
  /** 文件覆盖度台账（账本・解耦侧）：读到的行区间 + 轻量替身摘要。
   *  闭环内有效（resetTurnState 清），与 toolResultCache 同生命周期。
   *  替身回显分支据此在「原文已压缩」时回显摘要，而非放行重读（永动机）或空拦（死锁）。 */
  private readonly fileExposure = new FileExposureLedger();
  /** 运行时护栏注册表（SSOT）：判定序 / 文案 / 阈值单一真理源在 guardRail.ts；
   *  本字段只是 loop 的装载点（createDefaultGuards 出厂即覆盖 5 类前置拦截型护栏）。
   *  write_loop/read_failed 的计数状态内聚进其 guard 实例闭包，loop 仅负责
   *  装载 registry + 调 evaluateBlocked 判定 + 调 notifyExec 写侧喂数 + reset 归零。 */
  private readonly guardier = createDefaultGuards();
  // 软暂停申请操作（SSOT：pause 条目统一存 interruptQueue，读写统一经下面三个方法）
  /** 队列中是否有待消费的 pause 申请 */
  private hasPendingPause(): boolean {
    return this.interruptQueue.some((r) => r.kind === 'pause');
  }
  /** 幂等申请 pause 入队（已存在则不重复追加） */
  private requestPauseEntry(): void {
    if (!this.hasPendingPause()) {
      this.interruptQueue.push({ kind: 'pause' });
    }
  }
  /** 移除队列中的 pause 条目（保留 interject 条目） */
  private cancelPauseEntry(): void {
    const idx = this.interruptQueue.findIndex((r) => r.kind === 'pause');
    if (idx !== -1) {
      this.interruptQueue.splice(idx, 1);
    }
  }
  /** step 边界气口申请统一队列（pause/interject/command-result 统一入队，无独立 pauseRequested flag）。
   *  消费在 _handleInterrupt：先注入型（interject → appendUser，command-result → appendSystem），
   *  后挂起型（pause → yield paused）。 */
  private interruptQueue: InterruptRequest[] = [];
  /**
   * 后台任务注册表（可选，装配层注入）
   *
   * loop 侧只做两件事，**不碰进程治理**（spawn / 杀树 / 内存护栏全在 skillScriptRunner）：
   *   ① 注册完成监听 → 终局时把结果入队（`kind:'command-result'`），下个 step 边界注入 system 消息；
   *   ② turn 终态收割存活进程（§14.5，回流不跨 turn）。
   * 未注入时两个动作都是 no-op（无后台任务可管），不报错——纯 ToolExecutor 单测场景无注册表。
   */
  private backgroundTasks?: BackgroundTaskRegistry;
  /** 主动提问回调（LLM 调 ask_user 工具时调用，Agent 注入，loop 只回调不处理 UI） */
  onPendingQuestion?: (questions: AskQuestion[]) => void;
  /** 有效窗口变更回调（Agent 注入）：把 loop 算出的**有效窗口**分发给 loop 之外仍持有窗口拷贝的
   *  组件（ContextPreparer 等）。计算点唯一在 loop（#recomputeEffectiveWindow），本回调只做分发。 */
  onContextWindowChanged?: (effectiveTokens: number) => void;
  /** 单工具执行器（独立可测单元；strategy/回调经闭包读最新） */
  private readonly toolRunner: ToolRunner;
  /** L2 运行时策略（单一策略对象）。Agent 每轮经 setStrategy 注入，构造期默认 DEFAULT_L2_STRATEGY */
  private strategy: L2RuntimeStrategy = { ...DEFAULT_L2_STRATEGY };
  /** 本 turn 是否已执行过自审查（单次终审：布尔状态，不再需要轮次计数） */
  private selfReviewDone = false;
  /**
   * 本 turn 是否已在 step 边界挂起（paused）——**turn 终态收割的判据**（§14.5）。
   *
   * 置位点在 `_handleInterrupt` 的 pause 分支、**yield 之前**（宿主 break 会触发
   * generator finally，时序敏感）；复位点在 `resetTurnState`（两个 turn 入口都调）。
   * 语义：挂起 = 同 turn 续跑，后台进程继续跑；不挂起的收场（done / interrupted /
   * error）才是终态，收割存活后台进程。
   */
  private pauseBoundaryReached = false;
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
  /** step 边界回调——每次迭代（=step）完成时调用（传 assistant 摘要）。消费方（assembler 实现）
   *  经 logPlanItemBoundary 写 planItemLog 关联当前 active 任务项（时间轴投影）——
   *  不推进 plan：状态推进唯一写者 = LLM 的 task_table_update；LLM 未显式 update 的最后一个任务项
   *  由 turn 收尾兜底（orchestrator → concludeActivePlanItemIfPlanFullyReached）补上。
   *  planItemId 由消费方自查，loop 不传——签名不留空头支票。
   *  检出时机 = 本迭代 LLM 调用后、工具前（读「本迭代服务的那个任务项」）。 */
  onPlanItemBoundary?: (planItemInfo: { summary: string }) => void;
  /** 任务表获取回调——每次迭代 LLM 调用前调用，返回任务表文本（空字符串=无任务表） */
  getTaskTable?: () => string;
  /** active 任务项元信息回调（任务项级折叠）：供 _maybeEmitPlanItemBoundary
   *  在**迭代开始**（LLM 调用前）调用，返回当前 active 任务项 { planItemId, title, rolePack }；
   *  无任务表/无 active 任务项返回 null。与 onPlanItemBoundary **时序分叉**：后者读 LLM 调用后、
   *  工具前的 active（本迭代 LLM 实际服务的任务项），本回调经 _maybeEmitPlanItemBoundary 读迭代
   *  开始时的 active（以下内容将归属的那个任务项）——plan_item_boundary 事件据此判定
   *  「active 任务项是否已推进」并分组渲染。两者读的都是同一 checkpoint.plan 真源，仅读取时刻不同。
   *  rolePack 供裁决证据的会议轮判据（isMeetingRound）消费。 */
  getActivePlanItemMeta?: () => { planItemId?: string; title?: string; rolePack?: string } | null;
  /** 裁决证据落盘钩子（悬案取证轨）：空响应兜底 / 台账替身回显写点产个案证据时回调，
   *  由装配层接 history.appendEvidence 归属当前闭环轮随 Round 持久化。未注入静默忽略。 */
  appendRoundEvidence?: (ev: RoundEvidenceEvent) => void;
  /** 在途任务表判定回调：本 turn 是否已有未完成的计划任务项（会议骨架预置 / 续会）。
   *  装配来源 = SessionManager.hasInflightPlan（单一真理源）；用途 = needsPlanning nudge 注入前
   *  判断「是否已有在途表」，有则不重复灌「先拆解建表」。
   *  刻意**不复用** getActivePlanItemMeta 的存在性——后者原生职责是 plan_item_boundary 事件信号，
   *  借它回答本命题属语义借用（二者在 ensureActivePlanItem 不变量下当前等价，但职责须分离）。 */
  hasInflightPlan?: () => boolean;
  /** 上一任务项边界 ID（去噪）：记录最近一次已 emit plan_item_boundary 的 planItemId，
   *  仅当 getActivePlanItemMeta 返回的 planItemId 变化时才产新事件；null/undefined 不产（无任务表静默）。 */
  private lastBoundaryPlanItemId?: string;
  /** 轮内 step 序号（轮粒度单调）：「这条思考是第几步产生的」唯一真源计数，thought 归属由它打标。
   *  每次 LLM 调用（= 一个 step）前递增；随 currentRoundId 分配重置（processUserInput），
   *  continueAfterPause 续同一轮**不重置**——序号跨续跑段继续单调，同轮各 step 永不撞号。 */
  private roundStepIndex = 0;
  /** 主动提问计数（本 turn 粒度，resetTurnState 清零）：ask_user 工具触发次数（askLimit 硬护栏） */
  private askCountThisTurn = 0;
  /**
   * 在途提问登记（ask_user 工具轮挂起后、回答回填前）：记录各 ask_user 调用的 toolCallId
   * 与解析出的结构化问题。answerQuestion（正常作答）/ cancelAsk（跳过/兜底）二选一消费。
   */
  private pendingAsk: { toolCallIds: string[]; questions: AskQuestion[] } | undefined = undefined;
  /**
   * 已作答/已取消提问快照（answerQuestion 与 cancelAsk 消费提问后对称转存）：
   * 提问消费后把 pendingAsk.questions 转存于此，供 orchestrator.runResume
   * 落盘交互输入时随回答/超时记录一并持久化（回放还原「问了什么+选项」）。
   * pendingAsk 即清（runIterationLoop 兜底 cancelAsk 依赖其为「未消费」判据）；
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
  /** 最近一次输入装配的上下文预算（prepare 期写入，供指标快照透出做预算可视化） */
  private lastBudget: ContextBudget | undefined;
  /** 最近一次输入装配的上下文占用快照（预算可视化，真实用量） */
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
  /** 情报区（LLM 私有工作笔记）：LLM 经 remember_intel 自写累积，装配时作为尾部私有 system 消息注入 */
  private intelNote = '';
  /** Provider 路由缓存（单轮内缓存同一 taskType，避免每轮重复路由计算），跨轮清空不复用 */
  private providerRouteCache = new Map<TaskType, LlmProvider>();

  // ─── 运行时指标统计 ──────────────────────────────
  private metrics = new LoopMetrics();

  /** LLM 调用族执行器。**必须在构造函数尾部初始化**——依赖 `contextManager` /
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
    this.providerContextWindow =
      opts.maxContextTokens ?? AGENT_CONSTANTS.DEFAULT_MAX_CONTEXT_TOKENS;
    // 有效窗口初值 = provider 窗口（构造期 strategy 为默认策略，contextLimit=0 → 不设额外上限）；
    // 后续 setStrategy / setContextWindow 任一变更都会经 #recomputeEffectiveWindow 重算。
    this.maxContextTokens = this.providerContextWindow;
    this.tracer = opts.tracer ?? NOOP_TRACER;
    this.maxReflectionRetries = opts.maxReflectionRetries ?? 2;
    this.compactionStrategy =
      opts.compactionStrategy ??
      new ResultReplacementStrategy(
        // 摘要替代：默认压缩策略下，read_file 结果被压缩链清出时替换为它**自己的**台账摘要（非空占位）。
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
    // 阈值取拦截器自身（宿主注入自定义阈值时文案/硬闸/context.threshold 同步），未实现回落默认 3
    this.duplicateToolCallThreshold = this.duplicateCallInterceptor.getThreshold?.() ?? 3;
    this.onPendingQuestion = opts.onPendingQuestion;
    this.ui = {
      abortedByUser: opts.messages?.abortedByUser ?? 'User cancelled the conversation',
      abortedByTimeout: opts.messages?.abortedByTimeout ?? 'LLM request timed out (no response)',
      maxIterationsReached:
        opts.messages?.maxIterationsReached ?? LOOP_CONSTANTS.DEFAULT_MAX_ITERATIONS_REACHED_MARK,
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
      // 截断型空响应分型文案（finishReason='length'：思考/生成吃满输出预算）：带动作指引，
      // 与瞬态型文案分开展示——空响应不再一种面孔
      emptyResponseFallbackTruncated:
        opts.messages?.emptyResponseFallbackTruncated ??
        ((attempts: number) =>
          `The model's reasoning exhausted the output budget (empty after ${attempts} attempts). Consider increasing the model's max output tokens.`),
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
   * prepare/loop 不代模型猜测注入（无 recalledMemories 自动注入通道）。
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
    // 分配当前轮次 ID（优先采用调用方传入的 roundId，保证 appendUser/appendAssistant/摘要同源同值；未传自生成）
    this.currentRoundId = roundId ?? this.allocRoundId();
    // 新轮 = step 序号重新起数（轮归属随 roundId 分配重置；续跑入口 continueAfterPause 不动它）
    this.roundStepIndex = 0;

    // 清空 Provider 路由缓存（单轮内复用，跨轮重置）
    this.providerRouteCache.clear();

    // 闭环入口自动清理执行期临时残留（上轮 self-review/reflection/duplicate 等）
    // （装配注入「最近对话」不属于 executionTemp，不受影响）
    this.cleanExecutionTemporary();

    // 用户消息 push（用 <user_input> 标签包裹，增强 LLM 对注入攻击的免疫力，受控写入口统一包裹）
    this.appendUserMessage(userInput);

    // 重置本轮运行计数状态（反思/重复检测/软暂停/自审查/工具步，每轮独立）
    this.resetTurnState();
    // 新问题入口清理残留补充输入：
    // abort/host close 等异常路径可能让上一轮 interject 残留 interruptQueue，若不清，
    // 会被本 turn 首 step 边界 _handleInterrupt 误消费注入到新问题。
    // 不能在 resetTurnState 清——它也被 continueAfterPause 复用，会误杀「暂停后 interject → resume 注入」
    // 的合法语义（loop.test「暂停后 interject()」用例验证）；只在新问题入口清。
    this.clearPendingInterjections();
    // askLimit 计数按「一次用户输入」重置（turn 粒度：暂停-续跑跨续跑累计）——仅入口清，
    // continueAfterPause 不清（防续跑段被重复允许提问）
    this.resetAskBudget();
    // 规划层：任务表规划判定（在 resetTurnState 之后设值——续跑入口复用 resetTurnState 会清为 false，
    // 故此处重判为新 turn 的确定性结论；continueAfterPause 不复用，plan 已建无需 nudge）
    this.planNeedsNudge = this.opts.needsPlanningOverride
      ? this.opts.needsPlanningOverride(userInput)
      : detectNeedsPlanning(userInput);

    // 顶层 response span（任务级指标随流结束统一写属性）
    const responseSpan = this.tracer.startSpan(TRACE_SPANS.RESPONSE, {
      inputLength: userInput.length,
    });
    yield* this._runWithSlo(responseSpan, () => this.withRound(this.runIterationLoop(signal)));
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

    // 续跑路径无 span，SLO 包装传 null
    yield* this._runWithSlo(null, () => this.withRound(this.runIterationLoop(signal)));
  }

  /**
   * turn 入口通用 SLO 包装：统一任务计数 + 耗时累加 + 成功/失败判定 + 可选 tracer span 写属性。
   *
   * @param span 可选 tracer span（processUserInput 有 responseSpan；续跑路径无 span 传 null）
   * @param genFn 生成迭代器的工厂函数（惰性求值：在 try 块内调用，保证异常被 catch）
   */
  private async *_runWithSlo(
    span: ReturnType<ITracer['startSpan']> | null,
    genFn: () => AsyncGenerator<AgentChunk, void, unknown>,
  ): AsyncGenerator<AgentChunk, void, unknown> {
    const taskStartAt = Date.now();
    this.metrics.taskTotalCount++;
    let taskSucceeded = false;

    try {
      taskSucceeded = true;
      yield* genFn();
    } catch (err) {
      taskSucceeded = false;
      throw err;
    } finally {
      // turn 终态后台任务收尾（§14.5）：done / interrupted / error / 达到最大迭代
      // 四条收场路径都经过本 finally ⇒ 收割调用点唯一。
      // 判据 = pauseBoundaryReached：挂起是同 turn 续跑（后台继续跑、其回流照常注入），
      // 不算终态、不收割。error 路径也收割——异常收场同样不能留孤儿进程。
      if (!this.pauseBoundaryReached) {
        const bgReport = this.finalizeBackgroundTasksOnTurnEnd();
        if (bgReport) {
          // 收尾报告双通道：chunk 上屏（finally 中 yield 合法——推迟 generator 完成，
          // 宿主照常 for-await 消费）+ system 消息进 LLM 历史（真源不因上屏形态漂移）。
          // generator.return() 硬关闭路径下 yield 被丢弃不上屏（用户已主动停止），
          // system 消息仍写入——报告不因上屏通道状态丢失。
          yield { type: 'background_report', content: bgReport };
          this.appendSystemMessage(bgReport, { executionTemp: true });
        }
      }
      const durationMs = Date.now() - taskStartAt;
      this.metrics.taskTotalDurationMs += durationMs;
      if (taskSucceeded) {
        this.metrics.taskSuccessCount++;
      } else {
        this.metrics.taskFailureCount++;
      }
      // 可选 span 属性写入（续跑路径无 span）
      if (span) {
        span.setAttribute('taskDurationMs', durationMs);
        span.setAttribute('taskSucceeded', taskSucceeded);
        span.end();
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

  /**
   * step 归属打标：给子生成器的 thought chunk 附加所属 step 序号（SSOT：「这条思考是第几步产生的」
   * 由 loop 唯一提供，随 thought 本体落盘，消费方无需从工具序列推断迭代边界）。
   * 仅 thought 需要归属（按 step 分桶渲染），其余 chunk 原样透传。
   * 与 withRound 同构的边界打标模式；被包子生成器带返回值（LlmCallResult），
   * 故用手动迭代转发返回值（for-await 会丢弃 generator 返回值）。
   */
  private async *withStepIndex<R>(
    stepIndex: number,
    gen: AsyncGenerator<AgentChunk, R, unknown>,
  ): AsyncGenerator<AgentChunk, R, unknown> {
    const iter = gen[Symbol.asyncIterator]();
    while (true) {
      const r = await iter.next();
      if (r.done) return r.value;
      const chunk: AgentChunk = r.value;
      yield chunk.type === 'thought' ? { ...chunk, stepIndex } : chunk;
    }
  }

  /** 设置 L2 运行时策略（与现策略浅合并）。默认值仅在策略解析层 resolveL2Strategy 归一，loop 不再兜底。
   *  策略含 contextLimit → 变更后重算有效窗口（截断 / 软上限 / 占用快照随之生效）。 */
  setStrategy(partial: Partial<L2RuntimeStrategy>): void {
    this.strategy = { ...this.strategy, ...partial };
    this.#recomputeEffectiveWindow();
  }

  /**
   * 请求在下一 step 边界挂起（软暂停申请入队）。
   * 委托 requestPauseEntry（幂等入队），step 边界由 _handleInterrupt 消费。
   * 仅挂起不 abort，可经 continueAfterPause 续跑——与硬停止（signal.abort 无法续跑）严格区分；
   * 暂停语义与持久化由状态机持有，本方法只控制挂起时机。
   */
  requestPause(): void {
    this.requestPauseEntry();
  }

  /** 清除在途的软暂停申请（与 requestPause 对称：用户取消/流结束清理/暂停超时清扫共用）。
   *  委托 cancelPauseEntry 移除 pause 条目（保留 interject 条目） */
  clearPauseRequest(): void {
    this.cancelPauseEntry();
  }

  /**
   * 插话（申请入队）：把用户补充输入作为 InterruptRequest{kind:'interject'} 入 interruptQueue。
   * 与 requestPause（queueInterrupt pause）同为「申请 → 气口生效」——不中断当前 LLM/工具执行，
   * 只在 step 边界统一消费（先注入型 → appendUser，后挂起型 → yield paused）。
   *
   * 上限裁决（内核资源不变量，值真源 = LOOP_CONSTANTS.MAX_PENDING_INTERJECTIONS）：待注入插话达上限时
   * **整条拒收**返回 false（插话是原子思路，截半条 = 语义破坏）；宿主以此返回值做 UI
   * 提示（webview 预检与其 shared 镜像常量由守卫测试与本常量锁同值）。pause 条目不受
   * 本上限管辖（软暂停申请是内部控制语义，非用户输入洪流）。
   *
   * @returns true=已入队；false=待注入插话已满，本条未入队（调用方不应持久化/上屏）
   */
  interject(content: string): boolean {
    if (this.getPendingInterjections().length >= LOOP_CONSTANTS.MAX_PENDING_INTERJECTIONS) {
      return false;
    }
    this.interruptQueue.push({ kind: 'interject', content });
    return true;
  }

  /**
   * 后台命令完成回流入队（**生产者入口**，由装配层从注册表完成监听器调用）
   *
   * 走既有 `interruptQueue`（判别联合队列）新增一个 kind，零新基建：
   * 与插话同机制（iteration 间检查点消费、挂起/恢复全链路复用），但**异质**——
   *   - 消费时进 `appendSystemMessage`（系统事件），不进 `appendUserMessage`（不伪装用户发言）；
   *   - 不占插话满员计数（`interject()` 的容量裁决只数 kind==='interject'）；
   *   - 不跨 turn（turn 终态随收割一并丢弃，§14.5）。
   *
   * @param content 已格式化的完成通知（含来源标记「后台命令完成」+ 命令 + 输出）
   */
  enqueueCommandResult(content: string): void {
    this.interruptQueue.push({ kind: 'command-result', content });
  }

  /**
   * 装配后台任务注册表（assembler 调用，loop 创建之后）
   *
   * 两件职责一次接线，避免装配层散写两处：
   *   ① 完成监听 → `enqueueCommandResult`（回流通道生产者）；
   *   ② 持有引用供 turn 终态收割。
   */
  setBackgroundTasks(registry: BackgroundTaskRegistry): void {
    this.backgroundTasks = registry;
    registry.setCompletionListener((task) => {
      this.enqueueCommandResult(formatBackgroundTaskNotice(task));
    });
  }

  /**
   * turn 终态后台任务收尾（§14.5）：收割存活进程 + 丢弃本 turn 未消费的回流条目
   *
   * 判据 = 调用方传入的「本 turn 已收场」（挂起不算终态，见 `pauseBoundaryReached`）：
   * done / interrupted / error / 达到最大迭代 四条收场路径统一经此，调用点唯一
   * （`_runWithSlo` 的 finally）。
   *
   * 两件事，缺一不可：
   *   ① 收割存活进程（走注册表 → skillScriptRunner 杀树原语），并以 system 消息**如实报告**
   *      ——不静默丢弃被杀的进程，否则 LLM 会以为自己的后台命令还活着；
   *   ② 丢弃队列里未消费的 command-result 条目（回流不跨 turn，§14.5）——否则下一次
   *      提问的 step 边界会把上一个 turn 的陈旧结果注入新问题上下文。
   *      插话条目**不动**（它们由 processUserInput 入口的 clearPendingInterjections 负责，
   *      且暂停续跑链上的插话有独立语义）。
   *
   * @returns 收尾报告文本（null = 无后台任务，纯问答 turn 的常态——不产 chunk 不写 system 消息）
   */
  private finalizeBackgroundTasksOnTurnEnd(): string | null {
    this.interruptQueue = this.interruptQueue.filter((r) => r.kind !== 'command-result');
    const reaped = this.backgroundTasks?.reapAll() ?? [];
    if (reaped.length === 0) return null;
    const detail = reaped
      .map((t) => `- ${t.taskId}（status=${t.status}）：${t.command}`)
      .join('\n');
    return `[本轮结束 · 后台任务收割] 本轮仍有 ${reaped.length} 个后台命令在运行，已全部终止（其输出不再回流）：\n${detail}`;
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
   *  clear_pending_queue handler 若只清镜像不清内核会成单写缺口；
   *  agent.discardCurrentCheckpoint 若只清 checkpoint 不清队列会留孤儿数据。
   *  @returns 被清除的条目数（宿主可用于 notice 反馈） */
  clearPendingInterjections(): number {
    const cleared = this.interruptQueue.filter((r) => r.kind === 'interject').length;
    this.interruptQueue = this.interruptQueue.filter((r) => r.kind !== 'interject');
    return cleared;
  }

  /** 读取当前待注入插话队列快照（宿主渲染层只读镜像）。
   *  从 interruptQueue 中筛选 kind='interject' 并提取 content。
   *  返回副本而非原数组——宿主拿不到内核内部引用，防暗改。
   *  宿主侧收敛：不再自己维护 _pendingQueue 镜像，每次渲染从内核读。 */
  getPendingInterjections(): readonly string[] {
    return this.interruptQueue
      .filter((r): r is Extract<InterruptRequest, { kind: 'interject' }> => r.kind === 'interject')
      .map((r) => r.content);
  }

  /** 输出"达到最大迭代/步数预算"提示并结束（turn act 收尾兜底，多入口共享） */
  private async *emitMaxIterationsReached(): AsyncGenerator<AgentChunk, void, unknown> {
    // 撞线收尾前消费排队插话（与 done 分支同一语义）：
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
    this.cancelPauseEntry();
    this.selfReviewDone = false;
    // 每轮独立重置「工具步发生」标记（自审查触发门槛）：新问答闭环入口即续跑入口都复位，
    // 避免续跑段未执行工具却被上次的 true 触发自审查（重置唯一入口为本方法，processUserInput 不单独重置，防 SSOT 漂移）
    this.toolExecutedThisTurn = false;
    // 搜索护栏：本闭环内计数与注入标记随轮重置（下一闭环重新累计）
    this.successfulWebSearchCount = 0;
    this.searchConvergenceHintInjected = false;
    this.searchCallCount = 0;
    // 硬上限停搜标志随轮重置（下一闭环 web_search 重新可用）
    this.searchDisabled = false;
    this.searchDisabledHintInjected = false;
    // 软上限收尾信号注入标记随轮重置：跨 turn 重新注入（每轮回答都需收敛提醒），
    // 同 turn 内迭代仍由该 flag 防重（防迭代累积刷屏，不跨轮堆积）
    this.softLimitWrapupInjected = false;
    // 工具结果防重缓存：闭环内有效，新闭环开始即清空（跨闭环不复用，避免上一轮已读文件"误伤"本轮合法重读）
    this.toolResultCache.clear();
    // 文件覆盖度台账同步清空（与防重缓存同生命周期）
    this.fileExposure.clear();
    // 失败硬闸 + 写侧连写止损计数随轮清空（guard 内部闭包状态由 reset('perTurn') 归零；
    // 跨闭环复用时若残留，会误拒本轮合法的新失败重试 / 误判新写入路径）
    this.guardier.reset('perTurn');
    // 注：askCountThisTurn（askLimit 护栏）不在此重置——它按「一次用户输入（turn 粒度，
    // 含暂停-续跑链）」累计，跨续跑保留；清零只在 processUserInput 入口（见 resetAskBudget）。
    // 规划层：任务表 nudge 注入标记随轮重置（下一 turn 重新判定注入）；planNeedsNudge 也随轮清，
    // 但 processUserInput 在 resetTurnState 之后会重判设值（续跑入口不复用因此不重判）
    this.planNeedsNudge = false;
    this.planNudgeInjected = false;
    // 挂起标记复位：续跑入口（continueAfterPause）也走本方法，复位后本段跑到底即终态
    this.pauseBoundaryReached = false;
  }

  /** 重置 askLimit 计数（turn 入口）：仅 processUserInput 调用，continueAfterPause 不动，
   *  保证暂停-续跑同属一次用户输入、提问次数跨续跑累计（askLimit 语义：按输入打扰防刷）。 */
  private resetAskBudget(): void {
    this.askCountThisTurn = 0;
  }

  /**
   * 单轮 step 循环引擎（turn act 内 step 编排）：一次循环 = 一次 handleIteration（processUserInput/continueAfterPause 共享）。
   * stepBudget 软上限与 maxIterations 兜底在此统一收敛。
   * 注：所有复杂度（含 LLM 动态建任务表、会议机制角色切换）在单 turn 内承载（无多 turn 编排）。
   */
  private async *runIterationLoop(
    signal: AbortSignal | undefined,
  ): AsyncGenerator<AgentChunk, void, unknown> {
    // 角色包 stepBudget 覆盖 loop.maxIterations（角色包声明多少给多少）。
    // stepBudget > 0 → 角色包声明了明确的步数预算，用它；
    // stepBudget = 0 → 不声明，用 loop.maxIterations（内核兜底 DEFAULT_MAX_ITERATIONS）。
    // 这样角色包配 stepBudget=200 → 跑 200 轮，完全不被内核硬墙 clamp。
    const effectiveMax =
      this.strategy.stepBudget > 0 ? this.strategy.stepBudget : this.maxIterations;

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
  private handleIterationResult(result: 'aborted' | 'done' | 'continue' | 'paused'): boolean {
    // continue（工具结果已回填）无需特殊处理
    if (result === 'continue') return true;
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
    //
    // ⚠️ 后台回流（command-result）**同样**在此消费，理由与插话同源但多一层：
    // 收尾轮期间完成的后台命令若随 turn 结束被丢弃，agent 就永远拿不到自己起的任务的输出
    // （进程已被 reapAll 杀掉、结果被 finalize 丢弃）——LLM 会带着「任务大概在跑」的
    // 错误信念交付答案。故有后台结果就再跑一轮，让它看到。
    const consumedCount = this._consumeInterjects(this.interruptQueue);
    const consumedResults = this._consumeCommandResults(this.interruptQueue);
    // ⚠️ 只清 interject：**不清 command-result** —— 限量注入（MAX_PENDING_COMMAND_RESULTS）
    // 意味着本轮可能只投了前 N 条，剩下的必须**留队**等下个 step 边界续投；这里一并清掉
    // 就等于「限量」退化成「截半丢弃」。真正该丢的是 turn 终态（finalize 负责）。
    this.interruptQueue = this.interruptQueue.filter((r) => r.kind !== 'interject');
    return consumedCount > 0 || consumedResults > 0;
  }

  /**
   * 自审查注入判定（emit selfReview 通知与注入 SELF_REVIEW 提示共用单一真理源）。
   *
   * 需同时满足：
   * 1. 启用自审查（selfReviewEnabled）；
   * 2. 非工具屏蔽（toolCallsBlocked 时 'done' 来自系统占位文本而非 LLM 回复）；
   * 3. **单次终审语义**：
   *    - 多轮 turn 门槛：本 turn 内实际执行过工具步（一遍过的纯文本问答不审查）；
   *    - **终审即停：本 turn 已审过（selfReviewDone）则一律不再安排**。审查轮产出后
   *      done 立即真实生效——自审只对「工具循环后的最终交付」做一次把关，不因需修改
   *      而无限续跑空转（防 done 后反复审查拖长 turn）。深度"审查→
   *      修正"的迭代属目标模式阶段验收，非单次问答闭环职责。
   */
  private shouldInjectSelfReview(): boolean {
    if (!this.strategy.selfReviewEnabled) return false;
    if (this.strategy.toolCallsBlocked) return false;
    if (!this.toolExecutedThisTurn) return false;
    // 终审即停：本 turn 已审过 → 无论满意与否都不再注入（done 真实生效）。
    // 单次终审下「已审过」是布尔状态，无需轮次计数/上限判据（多轮轮次判据在此永不生效）。
    if (this.selfReviewDone) return false;
    return true;
  }

  /** 单次迭代编排：编排中断检查 → 上下文准备 → LLM 调用 → 结果路由。
   *  按抽象层拆分为 _handleInterrupt / _prepareContext / _callAndRoute，
   *  编排者只保留顺序，各阶段职责内聚在小方法（保持单轮 turn 结构完整）。 */
  private async *handleIteration(
    iteration: number,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<AgentChunk, 'aborted' | 'done' | 'continue' | 'paused', unknown> {
    logger.debug({ iteration, messageCount: this.messages.length }, 'Agent Loop 迭代');

    // 中断检查：软暂停（边界挂起可续跑）/ 硬中止（不可续跑）；
    // 返回合并后的 effectiveSignal（AbortSignal）表示继续执行
    const gate = yield* this._handleInterrupt(signal);
    if (gate === 'paused' || gate === 'aborted') return gate;

    // 任务项级折叠边界（唯一产出点）：产在本迭代的思考与工具**之前**——语义是
    // 「以下内容属于该任务项」，晚于内容则宿主「向前找边界」的判据对该迭代必然落空。
    // 必须在 _handleInterrupt 之后（挂起/中止的迭代不产），且在 _prepareContext 之前
    // （任务表注入不影响本判定：读的是会话级 checkpoint.plan，非注入消息）。
    yield* this._maybeEmitPlanItemBoundary();

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

  /**
   * 消费注入型**系统事件**条目（command-result → appendSystemMessage）
   *
   * 与 `_consumeInterjects` 严格分开而非合并成「消费所有注入型」：
   * 两者的注入通道（user / system）、role 语义、生命周期（跨 turn / 不跨 turn）都不同，
   * 合并成一个泛化遍历等于把这些判据摊平到 if 分支里——将来任一判据变化都要在同
   * 一段代码里翻找，正是「同一语义两套判定」的开始。故：两个方法，各守一条通道。
   *
   * **限量注入**（`MAX_PENDING_COMMAND_RESULTS`）：回流是已发生的事实、不可拒收，
   * 只能限量。每步只注入 N 条，其余留队列等下个 step 边界——避免 N 个后台任务同时完成时
   * 一次性灌爆上下文。
   *
   * `executionTemp: true` —— 回流是**本轮执行期事件**（进程已结束、结果已交付），
   * 下一轮闭环入口由 `cleanExecutionTemporary` 清掉，不进历史上下文。
   *
   * @param reqs 待消费的申请列表（只读遍历，不修改）
   * @returns 消费的条目数
   */
  private _consumeCommandResults(reqs: readonly InterruptRequest[]): number {
    const cap = LOOP_CONSTANTS.MAX_PENDING_COMMAND_RESULTS;
    let count = 0;
    for (const req of reqs) {
      if (req.kind !== 'command-result') continue;
      if (count >= cap) break; // 超量留队，下个 step 边界续投
      this.appendSystemMessage(req.content, { executionTemp: true });
      count++;
    }
    return count;
  }

  /** 中断检查：step 边界统一消费 interruptQueue（pause + interject + command-result）+ 硬中止检查。
   *
   *  单一气口出口——气口申请统一收在 interruptQueue（无独立 pause flag / 插话数组写位），
   *  此处统一 queue.splice(0) 取出全部申请，按 kind 分三类处理：
   *    - 注入型·用户意图（interject）：appendUserMessage，不暂停 loop，让补充输入立刻进入下一轮 step
   *    - 注入型·系统事件（command-result）：appendSystemMessage（executionTemp），
   *      不暂停 loop；与 interject 的差别只在注入通道与 role 语义（系统事件 ≠ 用户发言）
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

    // ① 先处理注入型气口（interject → appendUserMessage；command-result → appendSystemMessage）
    //    ——不暂停 loop，让补充输入 / 后台结果立刻进入下一轮 step
    this._consumeInterjects(reqs);
    this._consumeCommandResults(reqs);

    // ② 后处理挂起型气口（pause → yield paused）——如果队列里有 pause 申请，在 step 边界挂起
    // ⛔ 生命周期契约：yield paused 后本 generator 立即 return 结束，
    // **不再产出任何后续 chunk**（挂起即本流结束，续跑靠宿主另起 resumeExecution 新流）。
    // 宿主消费方（consumeFlow）据此在 paused chunk 处 break 收尾——切勿期待 pause 后
    // 还有剩余 chunk：那会让 for-await 挂在已结束的流上、_streaming 永不复位，
    // 导致"暂停态输入补充"被误路由进 interject 排队而无人消费（卡死坑）。
    if (reqs.some((r) => r.kind === 'pause')) {
      // pause 消费后 clearPauseRequest 已由 splice(0) 自动完成——无需额外清 flag
      // 挂起**不是** turn 终态（§14.5）：同 turn 续跑，后台进程应继续跑、其回流照常注入。
      // 标记必须在 yield 之前置位——宿主在 paused chunk 处 break 会让 generator 停在
      // 这个 yield 上并触发 finally（runIterationLoop 的收割判据），置位晚了就会
      // 把「续跑」误判成「终态」而错杀后台进程。
      this.pauseBoundaryReached = true;
      yield { type: 'paused' };
      return 'paused';
    }

    // ③ 硬中止检查：外部 signal（宿主取消/超时）。插话不经独立 controller（单一模式）
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
    // 突变验证靶标：删除 `&& this.hasPendingPause()` → 负例测试（超时无暂停应 aborted）转红
    if (isTimeoutAbortSignal(signal) && this.hasPendingPause()) {
      return { type: 'paused' };
    }
    return null;
  }

  /** LLM 调用 + 结果路由：上下文准备 → 调 LLM → 按 abort/工具/纯文本 分支路由。
   *  effectiveSignal 已由 _handleInterrupt 合并好，此处直接使用。 */
  private async *_callAndRoute(
    iteration: number,
    effectiveSignal: AbortSignal | undefined,
  ): AsyncGenerator<AgentChunk, 'aborted' | 'done' | 'continue' | 'paused', unknown> {
    // ─── 上下文准备：截断 + 微压缩（上下文规模上限由有效窗口在截断层生效）────
    const prep = await this._prepareContext(effectiveSignal);

    // LLM 调用前 emit thinking，让宿主 UI 在首 token 到达前展示"正在思考"反馈，消除空白等待
    yield { type: 'thinking', phase: 'llm_calling' };

    // 文本阶段标识：自审查应答（selfReviewDone）标注为 'self_review'，供宿主独立分段展示；
    // 正常回答/工具步文本为 'answer'。全流 text chunk 统一携带，保证审查输出与最终回答可区分。
    const textStage: TextChunkStage = this.selfReviewDone ? 'self_review' : 'answer';

    // step 序号：每次 LLM 调用 = 一个 step（重试仍属同一步），thought 随流经 withStepIndex 打标
    const stepIndex = ++this.roundStepIndex;
    const llmResult: LlmCallResult = yield* this.withStepIndex(
      stepIndex,
      this.callLlmWithRetry(
        prep.safeMessages,
        prep.chatOpts,
        effectiveSignal,
        iteration,
        textStage,
      ),
    );

    if (llmResult.aborted) {
      // 缓冲补发：工具闭环内延迟分类的消息被中断时，缓冲文本从未流式 yield →
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
      // timeout abort 且用户已申请暂停 → 路由 paused（续跑）而非 aborted（硬中止）。
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

    // 任务项日志回调（每次迭代完成后触发，用于 planItemLog 时间轴投影；触发点在 step 边界上，
    // 但落盘分组归属是任务项级，非 turn 边界）。
    // 挂起型迭代不写日志（与用户暂停对称）：含 ask_user 将挂起的迭代不记 planItemLog——
    // 问答对归当前任务项，回答续跑后由后续完整迭代在边界记录该任务项；判定经 willSuspendForAsk 单收口，
    // 与 handleToolCalls 挂起检出共用（防双判漂移）。
    // 检出时机 = 迭代的 LLM 调用后、工具前：此刻的 active 任务项是本迭代 LLM 实际服务的那个任务项，
    // 由 onPlanItemBoundary 写 planItemLog 关联（只写日志、不推进——推进唯一写者 = task_table_update）。
    if (this.onPlanItemBoundary && !this.willSuspendForAsk(llmResult.toolCalls)) {
      this.onPlanItemBoundary({
        summary: llmResult.fullContent.slice(0, 200),
      });
    }

    // 结果路由：工具分支 / 纯文本结束分支
    // 主动提问走 ask_user 内置工具（唯一通道）：提问 = 一次普通工具调用，在 handleToolCalls 检出
    // 挂起；用户答案以 tool result 回填，工具调用结构完整落地（不「撕掉」工具），
    // OpenAI 兼容端 assistant.tool_calls 恒有配对 tool 消息。
    if (llmResult.toolCalls && llmResult.toolCalls.length > 0) {
      // 过程叙述：工具轮文本（如「让我先读取所有文档」）作为 narrate 事件发射，
      // 供宿主渲染「过程叙述」折叠行——正文已在流式阶段剥离（未见工具轮文本）。
      // 回抽：首轮（无工具史）消息级分类前无法预判工具轮，文本已为保 TTFT
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
      const toolResult = yield* this.handleToolCalls(llmResult, effectiveSignal, stepIndex);
      // 任务项级折叠边界已前移到迭代开始（见 _maybeEmitPlanItemBoundary 的时机说明）——
      // 本处只剩落盘触发信号，两者不再挤在同一个产出点。
      yield* this._emitStepBoundary(toolResult);
      return toolResult;
    }
    // 无工具路径：边界同样已在迭代开始产出，此处不再重复检出。
    // 补发：工具闭环内延迟分类的纯文本消息（收尾交付）从未流式 yield → 先补发整段正文再收尾
    if (!llmResult.textStreamed && llmResult.fullContent.trim()) {
      yield { type: 'text', content: llmResult.fullContent, stage: textStage };
    }
    return yield* this.handleTextResponse(llmResult, iteration);
  }

  /** 任务项级折叠边界事件产出（产出的是 plan_item_boundary，**不是** step_boundary——
   *  方法名与产出事件名必须同阵营，勿据「step」误读为迭代边界）：
   *  比较 active 任务项是否已推进，推进才产 plan_item_boundary（宿主按任务项分组后续事件）。
   *  无任务表（null）或 planItemId 未变则不产（lastBoundaryPlanItemId 去噪，避免每迭代发一条空边界）。
   *
   *  **检出时机 = 迭代开始、LLM 调用之前（定案锚 ADR-034）**：边界的语义是「**以下内容**
   *  属于该任务项」，故必须产在它所罩住的思考与工具之前——放在工具落定之后，宿主
   *  「向前找最近边界」的判据对该迭代必然落空 → 每个任务项的首个迭代（思考 + 首批工具）恒掉出
   *  折叠块，且流式插入后不搬家。
   *
   *  语义后果（可接受，非缺陷）：任务表若由本轮某迭代的工具**新建**，该迭代仍留在组外——
   *  那个时刻任务表还不存在。本产出点修的是「任务表在本轮开始前已存在」（续会/预置/上一 turn
   *  遗留）的场景。
   *
   *  与 `onPlanItemBoundary`（写 planItemLog）的**时序分叉仍是设计语义**：后者在 LLM 调用后、
   *  工具前读 active（= 本迭代 LLM 实际服务的任务项），本处在迭代开始读（= 以下内容将归属的
   *  任务项）。两者读同一真相源 `sessionManager.getCheckpoint().plan`，只是读取时刻不同。
   *
   *  落点还必须在 `_handleInterrupt` 之后：挂起/中止的迭代不应先产一条边界再退出。
   *  roundId 由 withRound 统一附加（chunk 归属 SSOT），此处不再自带。 */
  private *_maybeEmitPlanItemBoundary(): Generator<AgentChunk, void, unknown> {
    const activePlanItemMeta = this.getActivePlanItemMeta?.();
    const activePlanItemId = activePlanItemMeta?.planItemId;
    if (
      activePlanItemMeta &&
      activePlanItemId &&
      activePlanItemId !== this.lastBoundaryPlanItemId
    ) {
      this.lastBoundaryPlanItemId = activePlanItemId;
      // 底层观测：plan_item_boundary 产出累计（实证布局骨血是否空转）
      this.metrics.planItemBoundaryCount++;
      yield {
        type: 'plan_item_boundary',
        planItemId: activePlanItemId,
        title: activePlanItemMeta.title,
      };
    }
  }

  /** 迭代边界产出（迭代原子落盘）：迭代**完成且将继续下一轮**时 emit
   *  `step_boundary`，宿主据此增量落盘（一次迭代一次落盘）。
   *
   *  **为什么单开一个 chunk 而不复用 plan_item_boundary**：plan_item_boundary 的语义是「任务项推进」
   *  （无任务表静默 + planItemId 未变去噪），把它当落盘时机 → 无任务表的长工具循环零增量落盘，
   *  崩溃即全丢。本 chunk 与它语义分离：只回答「本次迭代做完了」。
   *
   *  **条件 = result === 'continue'（硬）**：终态迭代（'done' 收尾 / 'paused' 挂起 / 'aborted'
   *  中断）之后流即结束或宿主 break → **流尾落盘**已兜底，此处不产——既避免与流尾重复写，
   *  也保住「终态 chunk 是末条」这一既有流契约（宿主 paused 分支据 break，其后不得再有 chunk）。
   *  无工具分支（handleTextResponse）恒终态，故本方法在该分支不产（恒非 'continue'）。
   *
   *  **顺序契约（硬，2026-09-26 更新）**：`plan_item_boundary` 已于**迭代开始**产出
   *  （见 _maybeEmitPlanItemBoundary），本 chunk 产在迭代尾 → 二者天然保持「折叠边界先于落盘
   *  触发」的先后序，宿主本次落盘快照必含该任务项折叠边界，崩溃重放不错位。
   *
   *  @param result 本次迭代的路由结果（handleToolCalls 返回值）
   */
  private *_emitStepBoundary(
    result: 'aborted' | 'done' | 'continue' | 'paused',
  ): Generator<AgentChunk, void, unknown> {
    if (result === 'continue') yield { type: 'step_boundary' };
  }

  /** 上下文准备：摘要截断 → 同步工作记忆 → 微压缩 → 任务表注入。
   *  返回 { chatOpts, safeMessages } 供调用方送 LLM。
   *  截断/压缩改造 this.messages 的工作记忆，是"资源边界"职责的收敛点。
   *  上下文规模上限由**有效窗口**（min(provider 窗口, 角色包 contextLimit)）在截断层生效；
   *  不再有「预算触顶即终止」路径 —— 终止职责归 stepBudget。 */
  private async _prepareContext(
    effectiveSignal: AbortSignal | undefined,
  ): Promise<{ chatOpts: ChatOptions; safeMessages: readonly Message[] }> {
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
    // 视图说明（截断轮一致性）：截断时 safeMessages 为截断后新数组（本次
    // 发往 LLM 的视图），this.messages 经 replaceContext 为同元素引用的浅拷贝。ResultReplacement
    // 原地改对象 content（引用共享 → 对发送视图同样生效）。
    for (const strategy of this.compactionStrategies) {
      if (strategy.shouldCompact(this.messages)) {
        await strategy.compact(this.messages);
      }
    }
    // ─── 压缩链结束 ─────────────────────────────────────────────

    // 情报区注入：LLM 私有工作笔记，作为单条尾部私有 system 消息（非 executionTemp → 跨 turn 自持）
    this.injectIntelNote();

    // 搜索收敛护栏：本闭环成功联网搜索达阈值后，注入收敛提示引导 LLM 停止搜索直接作答。
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
    // 不增摘要层 token）——无防重则同 turn 每步迭代各注入一条收尾信号刷屏
    // （与搜索收敛 flag / 压力提示 includes 断言的幂等口径对齐）。
    if (
      this.contextManager.shouldInjectSoftLimitWrapup(this.messages) &&
      !this.softLimitWrapupInjected
    ) {
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
      // 预算预警档：容量到线但摘要层未饱和（软上限的前一级）→ 注入温和压缩/收敛提示，
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

    // 每次迭代 LLM 调用前统一注入任务表 —— 替换式注入：
    // 注入前先移除已有的任务表消息（特征前缀 [任务进度:，renderTaskTable 输出首行），
    // 保证一个 turn 内经 N 次迭代上下文恒 1 份任务表，不重复灌指令浪费 token。
    // 同时标记 executionTemp——跨 turn 由 cleanExecutionTemporary 在下一闭环入口统一清冗
    const taskTable = this.getTaskTable?.();
    if (taskTable) {
      this.replaceContext(
        this.messages.filter((m) => !(m.role === 'system' && m.content.startsWith('[任务进度:'))),
      );
      this.appendSystemMessage(taskTable, { executionTemp: true });
    }

    // needsPlanning 命中时首迭代注入一过式命令式引导：executionTemp → 跨 turn 由
    // cleanExecutionTemporary 清冗；planNudgeInjected 保证本 turn 仅决策一次（非每迭代重复，
    // 与任务表"替换式"注入区分）。收口：已有在途任务表（会议骨架 / 续会）时不灌「先拆解建表」——骨架已预置 / 续会本有步进，nudge 冗余误导；无表才诱导建表。
    // 判定经 hasInflightPlan 回调（与 SessionManager 同源谓词），不复用 getActivePlanItemMeta 的存在性（职责分离）。
    if (this.planNeedsNudge && !this.planNudgeInjected) {
      this.planNudgeInjected = true;
      if (!this.hasInflightPlan?.()) {
        this.appendSystemMessage(PLAN_NUDGE_PROMPT, { executionTemp: true });
        logger.info({}, '任务表触发：needsPlanning 命中且无在途任务表，已注入命令式强引导');
      }
    }

    return { chatOpts, safeMessages };
  }

  /**
   * 本迭代将因 ask_user 挂起（决策关口，与用户暂停同属挂起型气口）？
   * 含 ask_user 且未超 askLimit、非工具屏蔽。SSOT：onPlanItemBoundary 的 planItemLog 排除判定
   * 与 handleToolCalls 挂起检出共用同一谓词（防两处判定漂移）——收口验收：
   * ask_user 挂起谓词字面全仓仅此一处。
   * 注：边界处传 llmResult.toolCalls（原始集）、挂起检出传 effectiveToolCalls（toolStepLimit
   * 截断后集）；截断把 ask_user 裁掉的窗口 → 边界多跳一轮不记日志，安全向（少记而非错记）。
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

  /** 工具调用分支 + Reflection（子方法 2/3）；ask_user 提问检出挂起（返回 'paused'）。
   *  stepIndex = 本迭代序号（调用方算号传入），tool_start 发射时盖章（与 thought 同构，事实单点）。 */
  private async *handleToolCalls(
    llmResult: LlmCallResult,
    signal: AbortSignal | undefined,
    stepIndex: number,
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
    // LLM 基于答案重新决策。挂起判定经 willSuspendForAsk 单收口（与 onPlanItemBoundary 排除共用）。
    if (this.willSuspendForAsk(effectiveToolCalls)) {
      return yield* this.handleAskUser(llmResult, effectiveToolCalls);
    }

    // ─── 重复工具调用检测（拦截器模式 · **前移到执行前** = 真 block）───
    // 重复检测委托给 DuplicateCallInterceptor（默认哈希机械检测，宿主可注入差异化策略）。
    // 判定在工具执行**前**：warn → 注入负反馈后继续执行；block → 注入阻断并跳过执行（真阻止，
    // 不再"事后宣告已自动阻止"的假 block）。
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
      logger.warn(
        {
          hash: currentHash,
          count: this.duplicateToolCallCount,
          interceptor: this.duplicateCallInterceptor.name ?? 'anonymous',
        },
        '重复工具调用拦截器触发 warning（执行前）',
      );
      this.duplicateToolCallCount = 0;
      this.lastToolCallsHash = '';
    } else if (dupVerdict === 'block') {
      // 硬拦截：真阻止——不执行任何工具，注入阻断并结束本轮（工具尚未执行，诚实）。
      // 注：默认 DefaultDuplicateCallInterceptor.check 只返 ok/warn，
      // **永不返回 block**——本分支仅宿主注入型拦截器可达，属批级软去重的扩展能力位而非默认路径。
      this.appendSystemMessage(
        `[DUPLICATE_TOOL_CALL_BLOCKED] 检测到重复工具调用，已阻止本次工具执行。` +
          `请改变策略：调整参数、换用其他工具，或直接给出文本回复。`,
        { executionTemp: true },
      );
      logger.warn(
        {
          hash: currentHash,
          count: this.duplicateToolCallCount,
          interceptor: this.duplicateCallInterceptor.name ?? 'anonymous',
        },
        '重复工具调用拦截器触发 block（执行前阻止）',
      );
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
      stepIndex,
    );
    if (execResult.aborted) {
      // 与 LLM 调用点同构：工具执行中途 timeout abort 且用户已申请暂停 → 路由 paused（续跑）。
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
    // slice 按实际执行的 effectiveToolCalls.length 取窗口——若按 LLM 原始请求条数
    // llmResult.toolCalls.length 切，toolStepLimit 截断时 slice 多看会把上一轮残留的
    // tool 错误吸进判定窗口，误注入反思提示（坑）
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
   * ask_user 提问挂起（step 边界气口）：把提问作为普通工具轮落地，挂起等用户作答。
   *
   * 与插话/暂停统一的「申请 → 气口生效」语义：
   * - assistant(toolCalls) 结构完整入史（含 ask_user），不「撕掉」工具——OpenAI 兼容端要求
   *   assistant.tool_calls **逐条**有配对 tool 消息：ask 的结果由用户答案回填，同批的**非 ask**
   *   调用补「未执行」占位（见方法内注释），整批闭合；
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
    // 同批被挂起的**非 ask** 调用：补说明性占位结果，闭合配对不变量。
    //
    // 为什么必须有：挂起意味着「本轮其余工具不执行」（提问是决策关口），但调用条目已随
    // assistant 消息入史——缺配对 tool 消息即被 OpenAI 兼容端以 400 拒绝（与「空 name 幻影」
    // 同一不变量的另一个入口）。此处与 `cancelAsk` 的 `[ASK_ABORTED]` 同源：**不执行 ≠ 不回答**，
    // 用占位把「未执行」这一事实显式告诉模型，避免它以为工具已跑过而产生幻觉。
    //
    // 文案纪律：只声明「未执行」，不得暗示任何执行结果；工具名用**原始调用名**（非 ask_user）。
    // 不 yield chunk：宿主 UI 不为占位渲染工具行（与 `[ASK_ABORTED]` 同构）。
    for (const tc of toolCalls) {
      if (tc.function.name === ASK_USER_TOOL.name) continue;
      this.appendToolMessage(
        wrapToolResult(
          tc.function.name,
          '[ASK_SUSPENDED] 该调用与用户提问同批：因等待回答，本轮未执行。如需其结果，请在恢复后重新发起。',
        ),
        tc.id,
      );
    }
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
    // 已作答提问转存快照（runResume 落盘交互输入时随回答持久化），pendingAsk 即清空
    this.lastAnsweredAsk = this.pendingAsk.questions;
    this.pendingAsk = undefined;
    this.inAutonomousStep = false;
    logger.info({ answers }, 'ask_user 已回填用户答案');
    return true;
  }

  /**
   * 取走最近一次已作答提问快照：runResume 落盘回答交互输入前调用，取走即清。
   * 返回 undefined = 本次续跑非提问回答路径（补充输入 / 无快照残留）。快照为
   * AskQuestion[]（多 ask_user 轮整组），调用方按需取用（当前落盘语义取 questions[0]）。
   */
  takeAnsweredAsk(): AskQuestion[] | undefined {
    const snapshot = this.lastAnsweredAsk;
    this.lastAnsweredAsk = undefined;
    return snapshot;
  }

  /**
   * 取消在途提问（宿主「跳过/取消提问」或提问超时时调用；
   * runIterationLoop 续跑兜底也调用）：
   * 以占位结果回填，防 assistant.tool_calls 无配对 tool 消息（OpenAI 兼容端 400）。
   * 与 answerQuestion 对称：同样转存提问快照到 lastAnsweredAsk——
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
   *  本方法只处理纯文本交付；提问暂停走 ask_user 工具通道。 */
  private async *handleTextResponse(
    llmResult: LlmCallResult,
    /** 轮内迭代序号（空响应裁决证据定位用） */
    iteration: number,
  ): AsyncGenerator<AgentChunk, 'done' | 'paused', unknown> {
    // 文本工具意图守卫：纯文本结束路径意味着本轮未产出原生 toolCalls，若 fullContent 仍带
    // <tool_call>/<function=> 骨架，说明「想调用工具却未走原生协议」——当普通文本交付会在
    // 宿主净化后显示空白且被静默盖「完成」。此处：告警 + 计数 + 剔除骨架出交付文本。
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
      // 观测：空响应兜底命中累计——为真即用户看到兜底文案、任务零产出（success 掩盖），可量化
      this.metrics.emptyResponseCount++;
      // 裁决证据落盘（悬案取证）：个案证据供跨会话裁决「会议空响应」——计数不落盘等于重启失忆。
      // 诊断分型三字段：finishReason='length' 判截断型（思考吃满输出预算），thinkingChars/attempts
      // 佐证定性（末次尝试口径，与收场同源）
      this.appendRoundEvidence?.({
        type: 'empty_response',
        ts: nowIso(),
        meetingRound: this.isMeetingRound(),
        payload: {
          iteration,
          finishReason: llmResult.finishReason,
          thinkingChars: llmResult.thinkingChars,
          attempts: llmResult.attempts,
        },
      });
      // 文案分型：截断型给动作指引（调大输出上限），瞬态型维持重试文案；
      // 中转不回传 finishReason → 按瞬态型降级（降级不劣化）。文案走 ui 通道
      // （默认英文，宿主可经 messages 覆盖，与其它 UI 文案一致）
      const fallbackText =
        llmResult.finishReason === 'length'
          ? this.ui.emptyResponseFallbackTruncated(llmResult.attempts)
          : this.ui.emptyResponseFallback;
      this.appendAssistantText(fallbackText);
      yield { type: 'text', content: fallbackText };
    }

    yield { type: 'done' };
    return 'done';
  }

  /**
   * 调用 LLM（带指数退避重试，仅在流式输出前失败时重试；流式已开始则直接上抛，因用户已看到部分结果）。
   *
   * 实现内聚于 `LlmCaller.callWithRetry`；此处保留委托壳。
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
   * 执行工具调用列表（并发执行，异常捕获后转为结构化错误串回传给 LLM，而非中断对话）。
   * stepIndex = 本迭代序号（调用链逐级传入），tool_start 发射时盖章（与 thought 同构，事实单点）。
   */
  private async *executeToolCalls(
    toolCalls: NonNullable<Message['toolCalls']>,
    fullContent: string,
    signal: AbortSignal | undefined,
    stepIndex: number,
  ): AsyncGenerator<AgentChunk, { aborted: boolean }, unknown> {
    this.appendAssistantToolCall(fullContent, toolCalls);

    // 工具并行执行（保持顺序的并发）：Promise.all 并发所有工具（总耗时≈最慢工具），
    // 但 tool_start/tool_result 与 messages 均按原始顺序 yield/push，保证 Reflection slice 正确
    if (signal?.aborted) {
      // 中止早退：assistant(toolCalls) 已在上一步入史，而工具一条都未执行 →
      // 必须为**每条**调用补「未执行」占位结果，否则即留下孤立 tool 消息（配对不变量破口）：
      // 下一次请求要么被 OpenAI 兼容端以 400 拒绝，要么被 llmCaller 发送边界守卫
      // `auditToolCallPairing` 拒发并抛**非临时**错误（llmPairingGuardFires++）
      // → 表现为「用户中止一次后，该会话后续每次发言都硬失败」。
      // 与 [ASK_SUSPENDED] / [ASK_ABORTED] 同源纪律：**不执行 ≠ 不回答**；
      // 文案只声明未执行、不暗示任何执行结果（防模型误以为工具已跑过而产生幻觉）。
      for (const tc of toolCalls) {
        this.appendToolMessage(
          wrapToolResult(
            tc.function.name,
            '[TOOL_ABORTED] 该调用因本轮被中止而未执行。如需其结果，请重新发起。',
          ),
          tc.id,
        );
      }
      return { aborted: true };
    }

    // 实际执行工具步：标记"本 turn 发生过工具调用"，作为自审查触发门槛（多轮 turn 才审查）
    this.toolExecutedThisTurn = true;

    // 标记进入自主工具步（供内核向宿主暴露"可续跑"信号）
    this.inAutonomousStep = true;

    // yield tool_start 并并发发起所有工具执行（不 await，由 Promise.all 统一等待）
    // blocked 与执行 promise 耦合为同一结构体，每个工具恰好一条。
    // 每个工具一次 push 一个 { blocked, promise }，结果按工具顺序对齐取出，
    // 保证护栏拦截标记永不与执行结果错位（避免平行数组各自 push 导致索引漂移）。
    const toolExecs: Array<{ blocked: boolean; promise: Promise<string> }> = [];
    // 同路径写串行闸：键 = 写工具的规范化目标路径（`WRITE_PATH_EXTRACTORS`），值 = 该路径的写链尾。
    // 为何需要——`write_file` 是「读盘 → 改 → 写盘」，同 step 内并行发起时两次都基于同一份旧快照，
    // 后落地者覆盖先落地者 ⇒ **静默丢内容**（真机实证：insert + append 同 step 并行，插入行被覆盖）。
    // 只对**同路径**串行：不同文件之间维持完全并发（总耗时仍≈最慢的那条路径）。
    const writeChains = new Map<string, Promise<string>>();
    // 不透明写链尾（目标不可静态定位：脚本执行类 / 内部索引落盘类 / 'path' 提取失败降级）——
    // 屏障语义：与**一切**写互斥（它可能写任何文件），后续任何写也须排在它之后。
    // 批内共享即完备（step 串行推进，无跨批并发）。判据真源 = 工具定义行 `diskWrite` 声明。
    let opaqueWriteTail: Promise<string> | undefined;
    // 运行时护栏阈值组装（真源分配见 guardRail.GuardThresholds）：
    //  写环=GUARD_THRESHOLDS.writeLoop，读闸=GUARD_THRESHOLDS.readFailed（独立静态真源，
    //  不再与 duplicateCallInterceptor 阈值复用——语义同宽，解开隐藏耦合）；
    //  提问=strategy.askLimit、搜索=LOOP_CONSTANTS.MAX_WEB_SEARCH_CALLS（动态真源，不入静态默认）。
    const guardThresholds: GuardThresholds = {
      writeLoop: GUARD_THRESHOLDS.writeLoop,
      readFailed: GUARD_THRESHOLDS.readFailed,
      askLimit: this.strategy.askLimit,
      maxWebSearch: LOOP_CONSTANTS.MAX_WEB_SEARCH_CALLS,
    };
    for (const tc of toolCalls) {
      this.metrics.toolCallCount++;
      // 底层观测：task_table_write 调用累计（实证任务表是否被触发）
      if (tc.function.name === 'task_table_write') this.metrics.planTaskTableWriteCount++;
      const isSearch = tc.function.name === 'web_search';
      if (isSearch) this.searchCallCount++;
      yield {
        type: 'tool_start',
        toolCallId: tc.id,
        name: tc.function.name,
        args: tc.function.arguments,
        stepIndex, // 所属 step 归属（单点打标，与 thought 同构）
      };

      // ===== 统一护栏判定（GuardRail SSOT）=====
      // 判定逻辑 / 命中文案（衔接提示词）/ 阈值收敛到 guardRail.ts（createDefaultGuards，见收敛方案）。
      // loop 仅保留最小职责：① 组 GuardContext（运行态计数 + 运行时阈值覆盖 + 防重依赖）；② 调 evaluateBlocked
      // 按注册序取首个硬拦命中；③ 处理 search_limit 专属副钩（停搜 + 重建 system prompt，需触达消息层所以留 loop）；
      // ④ 被拦则回填 guard 渲染的拒绝文案。
      // 台账替身回显的两条分支（摘要顶替 / 保守放行）形态不同、**不收口进 guardRail**（见 guardRail.ts 边界），仍在下方内联。
      const guardHit = this.guardier.evaluateBlocked({
        toolName: tc.function.name,
        argsJson: tc.function.arguments,
        toolCallId: tc.id,
        toolResultCache: this.toolResultCache,
        isCachedResultStillInContext: (hit) => this.isCachedResultStillInContext(hit),
        thresholds: guardThresholds,
        counters: {
          searchCallCount: this.searchCallCount,
          askCountThisTurn: this.askCountThisTurn,
        },
      });
      // search_limit 命中（双闸第二闸）：命中即停搜——置 searchDisabled，下一轮 LLM 调用的工具集剔除 web_search
      // （buildChatOptions 确定性过滤），并在本轮注入「视为未找到更多相关→继续下一步」提示，双管齐下终结
      // 「被拒→重搜→再被拒」拒绝风暴耗尽迭代/上下文导致问答闭环中断。首次置位重建 system prompt（幂等，
      // rebuildSystemMessage 只替换 messages[0]）。本分支在 push(false) 之前（与既有搜索闸节奏一致，维持逐 i 对齐）。
      if (guardHit?.guardId === 'search_limit') {
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
        toolExecs.push({ blocked: true, promise: Promise.resolve(guardHit.message) });
        continue;
      }
      // 其余护栏命中 → 硬拦回填拒绝文案（blocked 与拒绝 promise 一体推出）；未命中 → 下方正常执行。
      if (guardHit) {
        // read_dedup 兜底观测：指标计数 + 悬案取证（判「模型乒乓」vs「合理重读被误拦」）
        if (guardHit.guardId === 'read_dedup') {
          this.metrics.readDedupBlockCount++;
          const dedupSubject = DEDUP_SUBJECT_EXTRACTORS[tc.function.name]?.(tc.function.arguments);
          this.appendRoundEvidence?.({
            type: 'read_dedup_block',
            ts: nowIso(),
            meetingRound: this.isMeetingRound(),
            // 主体字段整体透传（不逐字段枚举）：形状真源 = DedupSubject（toolResultCache），
            // 增字段随透传自动落盘；可选值为 undefined 时由 JSON 序列化自然丢弃（与逐字段过滤等价）
            payload: { toolName: tc.function.name, ...dedupSubject },
          });
        }
        // 拦截归属回喂：read_dedup 的撞墙升级计数只认自己拦的（onExec 分不清拦截归属）
        this.guardier.notifyBlocked(guardHit.guardId, tc.function.name, tc.function.arguments);
        toolExecs.push({ blocked: true, promise: Promise.resolve(guardHit.message) });
        continue;
      }
      // 台账替身回显分支（摘要顶替，不收口进 guardRail）：原文已压缩/分段脚注时用摘要或引导 offset 续读替代重读。
      // 保守放行分支：无摘要 / 区间超出覆盖 → 放行（宁可多读一次，不可死锁）。
      // 文件被 write/delete 修改 → 结果处理循环 invalidate 台账，放行合法重读。
      const ledgerSubject = DEDUP_SUBJECT_EXTRACTORS[tc.function.name]?.(tc.function.arguments);
      if (ledgerSubject?.path) {
        const cov = this.fileExposure.get(ledgerSubject.path);
        if (cov && shouldEchoLedgerStub(ledgerSubject, cov)) {
          // 观测「补缝过度拦截」候选：台账替身回显命中累加。
          this.metrics.ledgerStubEchoCount++;
          // 裁决证据落盘（悬案取证）：计数判不了意图，「模型规避完整读取」vs「防重误拦合法
          // 重读」只能按 path/覆盖区间/请求参数逐案人工裁决——证据不落盘到期即无米下锅
          this.appendRoundEvidence?.({
            type: 'ledger_stub_echo',
            ts: nowIso(),
            meetingRound: this.isMeetingRound(),
            payload: {
              path: ledgerSubject.path,
              coverage: {
                coverStart: cov.coverStart,
                coverEnd: cov.coverEnd,
                totalLines: cov.totalLines,
              },
              request: { offset: ledgerSubject.offset, limit: ledgerSubject.limit },
            },
          });
          logger.debug(
            {
              path: ledgerSubject.path,
              cov: `${cov.coverStart}-${cov.coverEnd}/${cov.totalLines}`,
            },
            'read_file 台账替身回显：已用摘要顶替整读',
          );
          toolExecs.push({ blocked: true, promise: Promise.resolve(formatLedgerStub(cov)) });
          continue;
        }
      }
      // 写排序三分（判据真源 = 工具定义行 `diskWrite` 声明，派生索引见 builtinTools）：
      //  'path' → 按目标路径串行（同路径链）；'opaque' → 屏障，与一切写互斥；
      //  声明 'path' 但目标提取失败（参数缺 path 等）→「不确定即保守」降级为屏障，不静默跳过。
      const pathExtractor = WRITE_PATH_EXTRACTORS[tc.function.name];
      const writeKey = pathExtractor?.(tc.function.arguments);
      const useWriteBarrier =
        OPAQUE_WRITE_TOOL_NAMES.includes(tc.function.name) ||
        (pathExtractor !== undefined && writeKey === undefined);
      // 第二级压缩工具由 loop 拦截执行（现场压临时摘要替换，loop 收尾即弃），不落 ToolExecutor
      let promise: Promise<string>;
      if (tc.function.name === COMPRESS_CONTEXT_TOOL.name) {
        promise = this.compressContext(tc.function.arguments, signal);
      } else if (tc.function.name === REMEMBER_INTEL_TOOL.name) {
        promise = Promise.resolve(this.handleRememberIntel(tc.function.arguments));
      } else if (useWriteBarrier) {
        // 屏障：排在全部在途写链尾之后（同/异路径写与既有屏障都要等），执行后成为新屏障尾
        const prior = [...writeChains.values(), ...(opaqueWriteTail ? [opaqueWriteTail] : [])];
        promise = Promise.all(prior).then(() => this.toolRunner.runOne(tc, signal));
        // 链尾吞掉失败：一次写失败不得毒化后续写（本次真实结果仍由 promise 原样上抛）
        opaqueWriteTail = promise.catch(() => '');
      } else if (writeKey) {
        // 等同路径上一次写落地后再执行——这样本次「读盘」拿到的是上一次写后的最新内容，
        // 不再基于旧快照、也就不会把上一次的改动覆盖掉；屏障在途时同样等它（目标可能就是本文件）。
        const prior = [
          writeChains.get(writeKey) ?? Promise.resolve(''),
          ...(opaqueWriteTail ? [opaqueWriteTail] : []),
        ];
        promise = Promise.all(prior).then(() => this.toolRunner.runOne(tc, signal));
        // 链尾吞掉失败：一次写失败不得毒化同路径的后续写（本次真实结果仍由 promise 原样上抛）
        writeChains.set(
          writeKey,
          promise.catch(() => ''),
        );
      } else {
        promise = this.toolRunner.runOne(tc, signal);
      }
      toolExecs.push({ blocked: false, promise });
    }

    const results = await Promise.all(toolExecs.map((e) => e.promise));

    this._processToolResults(toolCalls, results);

    // 按原始顺序 yield tool_result
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i]!;
      const result = results[i]!;
      // 第三态：策略拦截 blocked=true 非成功亦非失败——ok=false 且不计成功搜索数；
      // 失败（[ERR 前缀）与拦截区分开，UI 显示「已拦截」，metrics 失败数不把拦截算作失败
      const blocked = toolExecs[i]!.blocked;
      const ok = !blocked && !result.startsWith('[ERR');
      // 搜索收敛护栏：累计本闭环成功 web_search 次数（LLM 反复搜索不收敛时据此注入收敛提示）
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
          // 文件覆盖度台账写侧：read_file 返回分段脚注（= 文件确实大/被截断，按需读取信号）
          // 时记录覆盖区间 + 轻量替身摘要——供替身回显分支在原文被压缩后回显（防重读永动机 / 空拦死锁）。
          if (tc.function.name === 'read_file' && subject.path) {
            const cov = parseReadFileCoverage(result);
            if (cov) {
              logger.debug(
                {
                  path: subject.path,
                  cov: `${cov.coverStart}-${cov.coverEnd}/${cov.totalLines}`,
                  src: 'footnote',
                  peek: result.slice(0, 80),
                },
                'read_file 台账写入（分段脚注）',
              );
              this.fileExposure.record(subject.path, {
                totalLines: cov.totalLines,
                coverStart: cov.coverStart,
                coverEnd: cov.coverEnd,
                // 替身 = 已读正文前 READ_DIGEST_CHARS 字符（轻量启发式，零 LLM 成本）
                digest: cov.content.slice(0, READ_DIGEST_CHARS),
                cachedAtIteration: this.currentIteration,
              });
            } else {
              // 整读无脚注（= 已读到文件末尾 / 文件未超单段预算，读到末尾零噪音）：
              // 同样记「全文件覆盖」——否则小文件整读后无台账 → 替身回显永不触发 → 压缩后重读狂飙
              // （真机 182 次 read_file 复发根因正是小文件不记——「补缝过度拦截」的反例）。
              const totalLines = result.split('\n').length;
              logger.debug(
                { path: subject.path, totalLines, src: 'whole-read', peek: result.slice(0, 80) },
                'read_file 台账写入（整读无脚注）',
              );
              this.fileExposure.record(subject.path, {
                totalLines,
                coverStart: 1,
                coverEnd: totalLines,
                digest: result.slice(0, READ_DIGEST_CHARS),
                cachedAtIteration: this.currentIteration,
              });
            }
          }
        }
      }
      // 写侧喂数（护栏内聚状态的下发点）：对每个 toolCall 调 notifyExec 分发 onExec，
      // 按三态喂入（blocked=被拦未执行 / ok=成功 / failed=失败）。write_loop/read_failed 据此自持更新计数。
      this.guardier.notifyExec({
        toolName: tc.function.name,
        argsJson: tc.function.arguments,
        toolCallId: tc.id,
        outcome: blocked ? 'blocked' : ok ? 'ok' : 'failed',
      });
      // 副作用型工具成功 → 主动失效关联的 read_file 缓存（放行后续合法重读）
      // 覆盖面派生自 `diskWrite:'path'` 声明（与串行闸同一真源），目标提取复用同一提取器——
      // 必须用**归一后**路径才对得上缓存/台账的键（raw 写法如 './a.md' 会失效不中）。
      // opaque 写（脚本类）目标不可知、无法按 path 失效：但宿主已通过执行前后 workspace 目录快照 diff 收口
      //（见 fileChangeTracker.noteExternalMutations），改动可视化盲区已闭环（台账 DIFF-4 可视化半已解除）。
      const invalidatedPath = WRITE_PATH_EXTRACTORS[tc.function.name]?.(tc.function.arguments);
      if (ok && invalidatedPath) {
        this.toolResultCache.invalidateFile(invalidatedPath);
        // 台账同步失效：文件内容变了，旧覆盖度替身作废（防替身回显陈旧摘要 → 放行合法重读）
        this.fileExposure.invalidate(invalidatedPath);
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
      let target: CompressTarget;
      try {
        target = parseCompressTarget((JSON.parse(args) as { target?: string }).target);
      } catch {
        target = 'earliest_round';
      }

      // 定位目标消息（各定位器只返回「可安全整段替换」的区间——配对完整性由定位器自身保证）
      const targetMsgs = this.findCompressTarget(target);
      if (!targetMsgs || targetMsgs.length === 0) {
        return `[compress_context] 无可压缩目标（上下文为空或目标不存在；可用 target=${COMPRESS_TARGETS.join(' | ')}）`;
      }

      // LLM 现场压成临时摘要
      const summary = await this.summarizeForCompression(targetMsgs, signal);
      if (!summary) {
        return '[compress_context] 摘要生成失败，已跳过（不破坏上下文）';
      }

      // 替换为目标内容为临时摘要 system 消息（executionTemp：loop 收尾即弃）
      const tempSummaryMsg: Message = {
        role: 'system',
        content: `[${SOFT_LIMIT_SUMMARY_MARKER_COMPRESS} · 临时压缩摘要（loop 收尾即弃，细节可能丢失）]\n${summary}`,
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
   *
   * ⚠️ **单轮 turn 内本定位器恒返回 null**（CTX-WIN-2 实锤）：锚点是
   * 「第一个 user vs 最后一个 user」，而单轮 turn 内**只有一个 user**（当前触发输入）
   * ⇒ `firstUserIdx >= lastUserIdx` 恒成立 ⇒ 无旧 turn 可压。
   * 这不是「长单轮不需要压缩」，而是**锚点粒度选错了**——单轮内的历史是 step 序列，
   * 由 `findEarliestSteps` 承接。两定位器互补，单轮长任务才有目标。
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

  /**
   * 定位最大的 tool 结果所在**整段 step**（超大 tool_result 的压缩目标）。
   *
   * 🔴 **配对完整性（CTX-WIN-2 实锤，原实现带伤）**：本定位器曾只返回
   * **单条 tool 消息**，而它所属的 `assistant.toolCalls` 留在上下文里
   * ⇒ 下一次请求命中发送边界守卫 `unpairedAssistantCall` **fail-fast 抛错，整个 turn 崩掉**
   * （实证：单轮 turn 内 `target=largest_tool_result` 必崩，非边缘情形）。
   * 故返回**整段**：该 tool 消息 + 所属 assistant 消息（toolCalls 全部摘除）
   * + 中间夹在两者之间的其他消息——保证替换后剩余上下文仍处处配对。
   */
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
    if (!largest) return null;

    const toolIdx = this.messages.indexOf(largest);
    // 向前找所属 assistant（最近的、带 toolCalls 且含该 toolCallId 者）
    let assistantIdx = -1;
    for (let i = toolIdx - 1; i >= 0; i--) {
      const m = this.messages[i]!;
      if (m.role === 'assistant' && m.toolCalls?.some((tc) => tc.id === largest!.toolCallId)) {
        assistantIdx = i;
        break;
      }
      // 撞上 user/system 边界 ⇒ 该 tool 无所属 assistant（异常态），只取自身
      if (m.role === 'user') break;
    }
    const start = assistantIdx === -1 ? toolIdx : assistantIdx;
    return this.messages.slice(start, toolIdx + 1);
  }

  /**
   * 定位**最早的若干个已完成 step**（单轮 turn 内的压缩目标，CTX-WIN-2 新增）。
   *
   * 为什么需要它（第一性原理）：单轮长任务（一个 user 输入跑几十个 step）的上下文增长
   * 全部来自 **step 序列**（assistant 思考 + tool 结果），而 `earliest_round` 的锚点是
   * 「user 消息」⇒ 单轮内只有一个 user ⇒ 恒无目标。上一轮三样本 38.5万 / 105.3万 / 72.0万
   * token 的长单轮就是这样把窗口顶满、却没有任何可压目标。
   *
   * **step 边界判据**（内核既有结构，零新概念）：一个 step = 一条 `assistant` 消息
   * （思考/工具调用意图）到**下一条 assistant 消息之前**的全部消息（含其 tool 结果与
   * 夹在中间的 system 注入）。故本定位器 = 「跳过当前触发输入，取第一个 assistant 起的
   * 一个完整 step」。
   *
   * 边界纪律（与既有两定位器同源）：
   * ① **当前触发输入（最后一个 user）永不压缩**——顶级锚点；
   * ② **只取「已完成」的 step**：末条 assistant 之后若还有 tool 结果，说明该 step 尚未走完
   *   （结果可能是 `[ASK_SUSPENDED]` 等），留待下轮；
   * ③ **整段替换**——step 内 assistant.toolCalls 与其 tool 结果同进同出，配对恒成立。
   */
  private findEarliestSteps(): Message[] | null {
    // 顶级锚点：当前触发输入位置（其后的消息才可压）
    let lastUserIdx = -1;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i]!.role === 'user') {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx === -1) return null;

    // 第一个 assistant = 最早 step 的起点（必须晚于顶级锚点：user 之前的 assistant 属上一轮，
    // 由 findEarliestRound 负责，不在此越界）
    let firstAssistantIdx = -1;
    for (let i = lastUserIdx + 1; i < this.messages.length; i++) {
      if (this.messages[i]!.role === 'assistant') {
        firstAssistantIdx = i;
        break;
      }
    }
    if (firstAssistantIdx === -1) return null;

    // 下一条 assistant 之前 = 本 step 的右边界
    let endIdx = this.messages.length;
    for (let i = firstAssistantIdx + 1; i < this.messages.length; i++) {
      if (this.messages[i]!.role === 'assistant') {
        endIdx = i;
        break;
      }
    }
    const step = this.messages.slice(firstAssistantIdx, endIdx);
    if (step.length === 0) return null;

    // 「已完成」判据 = 本 step 内每个 assistant.toolCalls 的 id 都有配对的 tool 消息回齐。
    // 逐 id 核验（而非「区间内有无 tool」）：后者被**后续** step 的 tool 结果误判为未完成
    // —— 那是拿「别的 step 的状态」当「本 step 的状态」，判据层级选错。
    const toolIdsInStep = new Set(
      step.filter((m) => m.role === 'tool' && m.toolCallId).map((m) => m.toolCallId as string),
    );
    const allAnswered = step
      .flatMap((m) => (m.toolCalls ?? []).map((tc) => tc.id))
      .every((id) => toolIdsInStep.has(id));
    if (!allAnswered) return null;

    return step;
  }

  /** 压缩目标分派（三个定位器互补，各守一条通道，不合并成泛化遍历） */
  private findCompressTarget(target: CompressTarget): Message[] | null {
    switch (target) {
      case 'largest_tool_result':
        return this.findLargestToolResult();
      case 'earliest_steps':
        return this.findEarliestSteps();
      case 'earliest_round':
        return this.findEarliestRound();
    }
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
    // 搜索硬上限命中后：同步剔除 web_search 描述，避免「描述存在但工具不可用」不一致
    const tools = this.resolveActiveTools();
    // 工具通道门控（互斥双能力位）：仅当 provider 声明支持原生工具调用时
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
      // 文本出口不是可调用通道，原生工具宣告唯一真源是 buildChatOptions 的 tools 参数；
      // 出现调用语法会诱导模型模仿文本标签产出 <tool_call> 骨架，被当普通文本交付后静默失败。
      prompt += `\n\n## 可用工具\n\n以下是当前可用工具及其参数说明：\n${toolDescs}`;

      // 工具导语纪律（分区式 UI 配套）：正文只承载最终交付；调用工具前意图说明压到一句话，
      // 抑制长导语混入正文（首轮工具步在消息级分类前仍逐字流式，纪律把残余降到可忽略）
      prompt += `\n\n${LOOP_CONSTANTS.TOOL_NARRATION_DISCIPLINE}`;

      // 工具选择规则：仅对工具清单中实际存在的 create_* 工具生成指引；
      // 无 create_* 工具时（编辑类宿主直接管理角色/技能/规则配置）整个规则节不输出，
      // 避免指引 LLM 调用不存在的工具。
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

      // 记忆回想导语句（软引导，不硬收窄）：工具描述块存在即注入，
      // 让 LLM 建立「涉及过往先回想」的通用良习（不依赖轮次状态/查询意图）。
      // toolCallsBlocked（确定性工具屏蔽，角色冻结态）时排除：引导调用被禁止的 search_memories
      // 属描述面不一致——其调用会被 handleToolCalls 确定性拒绝并直接 done，白费一轮 LLM 工具意图。
      if (!this.strategy.toolCallsBlocked) {
        prompt += `\n\n## 记忆回想\n回答涉及过往决定、历史、用户偏好、项目背景，或你不确定答案时，先调用 search_memories。`;
      }
    }

    // 工具能力缺失的显式告知（互斥双能力位回落，防静默）：系统配置了工具集、但当前 provider
    // 既无原生工具调用也无结构化输出时，显式告知 LLM「工具不可用」——让其直接给出文本作答，
    // **不诱导**其试图用文本骨架"调用"工具（避免复现文本 tool_call 旧伤）。logger.warn 留痕可观测。
    if (tools && tools.length > 0 && !supportsToolCalling && !this.structuredOutputEnabled()) {
      logger.warn(
        { provider: this.opts.provider?.name },
        '当前 provider 无工具通道（supportsToolCalling=false 且 supportsStructuredOutput=false），工具清单收起并显式告知 LLM',
      );
      prompt += `\n\n## 工具不可用\n当前模型不支持工具调用（无原生工具协议，也无可用的结构化输出回落）。请直接用文本回答，不要假装调用工具。`;
    }

    // 注：不追加 `## 行为护栏` 通用声明节（this.guardier.buildPromptSection()）——
    // 常量注入会改变每个 turn 的 system prompt token 预算，撞破「极小预算触发截断」类测试标定，
    // 且让 `[TAG]` 令牌在常驻 system prompt 出现而与运行时拒绝消息定位冲突（行为护栏的「衔接提示词」
    // 以运行时 GUARD_RAIL_PROMPTS 即时渲染为准，见 guardRail.ts）。buildPromptSection 保留为**内核内部**通用约束
    // 产出能力（单元测试覆盖其正确性），不入内核默认装配路径。注：它**未在 src/index.ts 出闸导出**，宿主当前
    // 访问不到——若宿主确需，须先出闸（按 legacy-contract-audit-rules §3，未出闸的能力不算"已声明可消费"）。

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
    return content
      .replace(SKELETON, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /**
   * 当前 provider 是否支持原生工具调用（OpenAI Function Calling tools 协议）。
   *
   * 读 provider 的互斥双能力位：
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
   * 属「同语义多实现」带伤。搜索硬上限命中后两处都要剔除 web_search，故把排除谓词收口到本方法。
   * 不修改 opts.toolDefinitions，仅按轮过滤，随 resetTurnState 自然恢复。
   */
  private resolveActiveTools(): readonly ToolDefinition[] {
    const all = this.opts.toolDefinitions ?? [];
    // 搜索硬上限命中后：从工具集剔除 web_search（确定性停搜，与 system 提示双闸）
    return this.searchDisabled ? all.filter((t) => t.name !== 'web_search') : all;
  }

  /**
   * 构建 LLM 调用选项（互斥双能力位的确定性通道选择）。
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

    // per-LLM 输出预算默认值（T1 / EMPTY-RESP-1 根因修复）：推理模型 thinking 与正文共享
    // 输出预算，无显式上限时 thinking 吃满服务端默认 → 正文被挤空。先填底座，随后与角色包
    // 策略（act.outputLimit）**取交集**——见下方 min 收敛，非单向覆盖。
    if (this.opts.defaultMaxTokens !== undefined) {
      baseOptions.maxTokens = this.opts.defaultMaxTokens;
    }

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

    // 输出上限**取交集**（定案锚 ADR-035）：per-LLM 配置与角色包策略都是「上限」性质，
    // 任何一侧声明「不能超过 X」都必须被满足 ⇒ 取更小值（对齐上下文窗口
    // `min(provider 窗口, 角色包 contextLimit)` 的同构语义）。直接覆盖（Object.assign 压过）
    // 与「上限」语义相反——它会让角色包把用户配的小值顶大，用户无从得知谁赢了。
    const perLlmLimit = this.opts.defaultMaxTokens;
    const strategyLimit = baseOptions.maxTokens;
    if (perLlmLimit !== undefined && strategyLimit !== undefined) {
      baseOptions.maxTokens = Math.min(perLlmLimit, strategyLimit);
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
   * 重算**有效上下文窗口** = min(providerContextWindow, strategy.contextLimit)。
   *
   * contextLimit = 0 / 未声明 → 不设额外上限（有效窗口 = provider 窗口）。
   * 两个触发入口：setContextWindow（provider 窗口变）与 setStrategy（角色策略变）；
   * 计算点**唯一**在此 —— 否则会出现「loop 用有效窗口截断、其他组件仍用 provider 窗口」的不一致。
   * 变更时同步 contextManager，并经 onContextWindowChanged 分发给 loop 之外持有窗口拷贝的组件。
   */
  #recomputeEffectiveWindow(): void {
    const limit = this.strategy.contextLimit;
    const effective =
      limit > 0 ? Math.min(this.providerContextWindow, limit) : this.providerContextWindow;
    if (effective === this.maxContextTokens) return;
    this.maxContextTokens = effective;
    this.contextManager.setMaxContextTokens(effective);
    this.onContextWindowChanged?.(effective);
  }

  /**
   * 运行时更新 **provider 上下文窗口**（token）
   *
   * 与 setProvider 配套：模型热切换时同步窗口。本方法只记录 provider 原始声明值，
   * 有效窗口由 #recomputeEffectiveWindow 按 min(provider 窗口, 角色包 contextLimit) 重算，
   * 令截断 / 软上限 / 占用快照随新模型与当前角色策略调整。只改窗口数字，不重建对话/不触碰消息。
   *
   * @param tokens provider 声明的窗口 token 数
   */
  setContextWindow(tokens: number): void {
    this.providerContextWindow = tokens;
    this.#recomputeEffectiveWindow();
  }

  /** 当前**有效上下文窗口** = min(provider 窗口, 角色包 contextLimit)（诊断 / 测试读取面）。 */
  getEffectiveContextWindow(): number {
    return this.maxContextTokens;
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

  /**
   * 运行时更新 per-LLM 输出预算默认值（Provider 热切换配套，与 setContextWindow 同链路）。
   * undefined = 清除（回服务端默认）。轮内下一迭代即用新值（请求参数非上下文结构，无一致性风险）。
   */
  setDefaultMaxTokens(tokens: number | undefined): void {
    this.opts.defaultMaxTokens = tokens;
  }

  /**
   * 读取本轮请求体**实际**携带的 max_tokens（生效值，供宿主取证 / 展示）。
   *
   * 为何不交给宿主自行推算：生效值由 `buildChatOptions()` 单点裁决——per-LLM 配置与角色包
   * act.outputLimit 取更小值、单侧缺位取另一侧；宿主侧重算等于复制规则、
   * 制造第二真理源（真机教训：meta 记了用户配的 64000，实际发出的是角色包的 4096，
   * 取证包把「配置意图」当成了「已生效事实」，由此得出过错误结论）。
   *
   * @returns 生效的输出上限（token）；undefined = 不传 max_tokens（回服务端默认）
   */
  getEffectiveMaxTokens(): number | undefined {
    return this.buildChatOptions().maxTokens;
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
   * 记录最近一次输入装配的上下文预算（prepare 期调用，预算可视化）。
   * 只存最新一轮预算供指标快照透出，不跨轮累积。
   */
  recordBudget(budget: ContextBudget): void {
    this.lastBudget = budget;
  }

  /**
   * 获取最近一轮输入装配的上下文预算（预算联动）
   *
   * 供工具执行器在工具执行期读取剩余预算（search_project 预算下探）。
   * 未 prepare 时返回 undefined（如纯工具单元测试场景）。
   */
  getLastBudget(): ContextBudget | undefined {
    return this.lastBudget;
  }

  /**
   * 记录最近一次输入装配的上下文占用快照（prepare 期调用，预算可视化）。
   * 存最新一轮真实用量供指标快照/输入区指示器透出，不跨轮累积。
   */
  recordOccupancy(occupancy: ContextOccupancy): void {
    this.lastOccupancy = occupancy;
  }

  /**
   * 对话占用实时刷新（预算可视化 · 输入区常驻指示器）。
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
        emptyResponseCount: this.metrics.emptyResponseCount,
        truncationRecoveryCount: this.metrics.truncationRecoveryCount,
        pairingGuardFires: this.metrics.llmPairingGuardFires,
      },
      tools: {
        callCount: this.metrics.toolCallCount,
        failureCount: this.metrics.toolFailureCount,
        unparsedToolIntentCount: this.metrics.unparsedToolIntentCount,
        ledgerStubEchoCount: this.metrics.ledgerStubEchoCount,
        readDedupBlockCount: this.metrics.readDedupBlockCount,
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
        planItemBoundaryCount: this.metrics.planItemBoundaryCount,
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

  /** 当前工作记忆中实际保留的轮次 roundId 集合（装配 exclude 用）。
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
    // 同步清集合消除引用滞后（双清一致）——否则集合保留旧引用至下次闭环入口
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

  /** 会议轮判据（裁决证据用，操作化单点）：任务表 active 任务项声明 rolePack = 会议逐项切换生效中 */
  private isMeetingRound(): boolean {
    return Boolean(this.getActivePlanItemMeta?.()?.rolePack);
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
   * 追加一条 tool 消息（loop **唯一** tool 写点：工具结果 / `[ASK_ANSWER]` / `[ASK_ABORTED]` /
   * `[ASK_SUSPENDED]` / `[TOOL_ABORTED]` 五处皆经此）。
   *
   * **入口关**（大文本统一通道 §6.2）：单条内容超 `SINGLE_TOOL_RESULT_MAX_TOKENS` → 原文落盘，
   * 上下文只留「路径 + 预览 + 续读提示」。收口在此而非 `_processToolResults`：后者只覆盖工具结果，
   * 会漏掉 `answerQuestion` 的 `[ASK_ANSWER]` —— 用户被问「请提供需求文档」后直接贴长文即可超阈。
   */
  private appendToolMessage(content: string, toolCallId: string): void {
    const finalContent = this.offloadDir
      ? offloadLargeToolResult(content, {
          offloadDir: this.offloadDir,
          // 尾部预览：长输出的关键信息常在尾部（缺口 D）；份额在既有预览预算内划分
          tailPreviewChars: LOOP_CONSTANTS.TOOL_RESULT_OFFLOAD_TAIL_PREVIEW_CHARS,
        }).content
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
      note =
        typeof parsed?.note === 'string' && parsed.note.trim() ? parsed.note.trim() : undefined;
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
   * 每轮装配把情报区注入为**单条尾部私有 system 消息**。
   *
   * - 复用 Message[] 视图：不新增对象，情报区 = 一条 system 消息正文；
   * - 已存在则更新原文（保持单条），被截断删除则重建 → 参与 `truncateMessages` 尾部淘汰（B 语义）；
   * - 非 executionTemp → 跨 turn 自持（每轮 `_prepareContext` 注入最新版）。
   *
   * **归属注**：对已存在消息的 `existing.content = ...` 属**单条尾部私有消息的幂等刷新**（同
   * `ResultReplacement` 只改 content），**不是装配重排**——不违背 loop「只追加、不重装配」的编排原则。
   *
   * **时序注（诚实声明）**：`_prepareContext` 先算 `safeMessages`、后注入本消息——
   * 在**截断轮**（截断重排后安全快照 ≠ this.messages）里，本轮被发送的 `safeMessages` 不含本情报区，
   * 下一轮 `_prepareContext` 重算后才可见（瞬时，非死锁）。此与 search 收敛提示 / taskTable 等所有
   * 既有动态注入提示的时序一致（库级既有行为），非本机制特例。
   */
  private injectIntelNote(): void {
    if (!this.intelNote) return;
    const content = `${INTEL_INTRO}\n\n${this.intelNote}`;
    const existing = this.messages.find(
      (m) =>
        m.role === 'system' && typeof m.content === 'string' && m.content.startsWith(INTEL_INTRO),
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
