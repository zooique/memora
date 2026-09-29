/**
 * 问答闭环（Round）存储接口 —— Memora 会话管理的 SSOT
 *
 * 设计理念：
 * - 问答闭环（Round）是独立的、全局唯一的实体
 * - 会话（Session）只是问答闭环 ID 的有序列表
 * - 分叉只是复制 ID 列表（指针复制），不复制数据
 *
 * 核心优势：
 * 1. 保持记忆系统的真理源设定（每个 roundId 对应唯一摘要）
 * 2. 保持会话的独立性（所有会话在存储层平等）
 * 3. 简洁的分叉实现（只需操作 ID 列表）
 */

import type { MessageRole } from '@/memory/types.js';
import type { AbortStopReason, LlmErrorCategory } from '@/agent/types.js';

// ─── 问答闭环消息 ───────────────────────────────────────

/**
 * 问答闭环消息：与 LLM Message 兼容，包含持久化所需的时间戳信息
 *
 * 对齐现有结构：
 * - Message.role（'user' | 'assistant' | 'tool' | 'system'）
 * - Message.content（消息内容）
 * - Message.roundId（轮次标识，此处由 Round 本身承载）
 */
export interface RoundMessage {
  /** 消息唯一标识（格式：msg-{uuid}） */
  id: string;

  /** 消息角色 */
  role: MessageRole;

  /** 消息内容 */
  content: string;

  /** 时间戳（ISO 8601，持久化用） */
  timestamp: string;

  /** 消息来源名称（可选，对齐 LLM Message.name） */
  name?: string;

  /** Token 用量统计（可选） */
  tokenUsage?: {
    /** 输入 token 数 */
    input: number;
    /** 输出 token 数 */
    output: number;
  };
}

/**
 * 交互输入类型（问答闭环内交互输入归属）
 *
 * 一次外部输入（Trigger）= 一个问答闭环。执行中的三类用户交互输入
 * （LLM 主动提问回答 / 流式中补充 / 暂停后续跑补充）均归属当前问答闭环，
 * 不分裂新轮——类型只影响 UI 折叠块文案，不参与 round 归属判定。
 *
 * - question-answer：LLM 主动提问（ask_user 工具）的用户回答（宿主 handleResume 路由）
 * - supplement：用户中途补充（插话 interject / 暂停后主输入框补充）
 * - timeout：ask_user 提问超时未答（宿主计时超时 → cancelAsk 注入
 *   [ASK_ABORTED] 占位 + resumeExecution('timeout') 自动续跑，LLM 自决；记录带
 *   question/options 供重放渲染「问 + 未回答」行）
 */
export type InteractiveInputKind = 'question-answer' | 'supplement' | 'timeout';

/**
 * 问答闭环内交互输入（Round.interactiveInputs 元素）
 *
 * 附加在闭环节点轮上，按时间序追加；重放时宿主据此渲染折叠的「用户提问/用户补充」块。
 */
export interface RoundInteractiveInput extends RoundMessage {
  /** 唯一标识（格式：msg-{roundId}-input-{序号}） */
  id: string;
  /** 恒为 user（与 RoundMessage.role 对齐，供统一迭代） */
  role: 'user';
  /** 交互输入类型（UI 折叠块文案与路由语义，不参与归属判定） */
  kind: InteractiveInputKind;
  /**
   * LLM 提问原文（仅 question-answer 携带）
   *
   * 该回答所对的 ask_user 提问文本——回答落盘时随交互输入一并持久化，
   * 供回放还原「当时 LLM 问了什么 + 用户为什么这么选」上下文。
   * supplement / 旧数据（无此字段）为缺省，回放退化为现状（仅「你答」内联行）。
   */
  question?: string;
  /** LLM 提问候选选项（question-answer 且 LLM 提供时；静态文本，供回放展示） */
  options?: string[];
}

// ─── 问答闭环状态 ───────────────────────────────────────

/**
 * 问答闭环状态机
 *
 * 状态流转（**实测口径**）：
 * - pending → complete：AI 回复生成完成（真实路径）
 * - pending → interrupted：被用户中断/运行失败（appendInterrupted 收场，不伪 complete）
 * - error：**预留态，当前无写点**（明示收起）
 *
 * ⚠️ 关于 `interrupted`（防「假性 complete 吞现场」）：
 * - **中断/失败轮落盘为 `interrupted`，不标 `complete`**。中断轮若伪装成正常完成轮，
 *   重放时会因缺 assistant 正文块丢失过程（思考/工具/中断标记）。interrupted 轮保留
 *   `processEvents` 原始现场、状态诚实区分。
 * - **实现落点**：`seed/orchestrator.act()`（中断 aborted / 失败 failed 收口到同一尾处理）
 *   → `history.appendInterrupted` 写 `status:'interrupted'`。
 * - **打捞关系**：`listInterruptedRecent`（内核 + 宿主两端）打捞条件仍为 `pending || error`，
 *   **不含 interrupted**——因为运行期收场已即时标 interrupted 且 refCount 0→1，不再符合
 *   `refCount===0 && pending` 的崩溃孤儿条件；interrupted 轮是"已收场的停 turn"，不属崩溃残留。
 *
 * ⚠️ 关于 `error`（防未来误判）：
 * - **不存在** `pending → error` 的流转——全仓 grep 零写点（生产代码）；运行时失败走
 *   `yield { type:'error' }` 事件流上报，**不翻 Round 状态机**，并与中断并轨为 `interrupted`，
 *   因为「中断/停顿」对用户是可理解的、而「出错」目前无独立产品语义（并入 interrupted）。
 * - **它不是死代码**：`listInterruptedRecent` 打捞条件为 `pending || error`，error 是组成。
 * - **纪律**：勿因「grep 到零写点」而删此成员或改窄打捞条件；若未来出现「整轮失败且
 *   需与中断区分展示」的真实需求，再补写点，签名无需变更。
 */
export type RoundStatus = 'pending' | 'complete' | 'error' | 'interrupted';

/**
 * 轮是否「已收场」（终态）——**判据单一收口点（SSOT）**。
 *
 * - `complete`：正常问答闭环完成（appendAssistant 收场）。
 * - `interrupted`：中断/失败收场（appendInterrupted 收场）。语义定案见
 *   `docs/architecture/step-atomic-persistence.md §一·五`——中断轮 = 等同用户点「停止」的
 *   正常 turn：**可删、入会话 roundIds、作后续上下文**，不是半成品草稿/孤儿。
 *
 * **为什么必须收口**：v3.0.0 把中断轮从「伪 complete」改为 `interrupted` 后，凡以
 * `status === 'complete'` 判「该轮是否已闭合」的读取方都会被静默改行为——中断轮的
 * assistantMessage 会被排除出会话视图与 LLM 历史（`ISessionStore.loadMessages` 是
 * `restoreHistory` 的唯一上游），违背上述定案。故凡「是否计入会话视图 / LLM 历史」
 * 「是否已登记会话引用」的判据**一律调用本函数**，禁止各处自写 `status === 'complete'`。
 *
 * ⚠️ **勿与渲染分流混用**：`status === 'interrupted'` 只用于「中断轮独立平铺渲染 + 中断标记」，
 * 回答的是「怎么画」，不是「是否已收场」。两者常在同一函数相邻出现，勿互替。
 *
 * @param status - 轮状态
 * @returns 该轮是否已进入终态（可作后续上下文）
 */
export function isRoundSettled(status: RoundStatus): boolean {
  return status === 'complete' || status === 'interrupted';
}

// ─── 过程事件（ProcessEvent）────────────────────────────
// 每轮「过程事件」= UI 状态重建的最小信息（运行时与重放共用同一份数据，
// 见 docs/architecture/process-event-log-replay-design.md §3.3）。
// 落位决策：ProcessEvent 是 Round 的组成部分（存储面），故定义于 memory/；
// thinking 阶段用本地字面量 ProcessThinkingPhase（与 agent/types.ts ThinkingPhase 同值），
// 避免 memory → agent 反向依赖（对齐 protocol.ts「宿主侧本地字面量避免跨包类型耦合」先例）。

/**
 * 思考阶段值（与 agent ThinkingPhase 同值的本地字面量，解耦依赖方向）
 *
 * 阶段与 Agent turn 对应：assembling=上下文装配（对齐 assembleContext 命名）/
 * llm_calling=调用模型 / processing=处理 / archiving=归档。枚举只保留有生产发射点的活值。
 */
export type ProcessThinkingPhase = 'assembling' | 'processing' | 'archiving' | 'llm_calling';

/** meta 事件载荷：该轮回答身份（角色/模型均为显示名，重放不依赖 ProviderStore/RolePackManager） */
export interface ProcessMetaPayload {
  /** 角色显示名（displayName ?? name） */
  role: string;
  /** 模型显示名（displayName ?? name） */
  llm: string;
}

/** metrics 事件载荷：每轮执行汇总（流结束后写一条） */
export interface ProcessMetricsPayload {
  /** 本轮耗时（毫秒） */
  durationMs: number;
  /** 输入 token 用量 */
  tokenIn: number;
  /** 输出 token 用量 */
  tokenOut: number;
  /** 工具调用失败次数 */
  toolFailureCount: number;
  /**
   * 本轮是否正常收尾（false = 中断/暂停）。
   * 语义是「这段流程跑完了没有」，不是「任务达成了没有」——
   * 任务达成与否由 unparsedToolIntentCount / toolFailureCount 等信号承载，勿混淆。
   */
  success: boolean;
  /**
   * 本轮未解析文本工具意图数（选填，旧数据缺省）
   * 「想调用工具却未走原生协议」的诚实信号；>0 时宿主不应显示为成功收尾。
   */
  unparsedToolIntentCount?: number;
}

/**
 * 过程事件（过程轨最小信息，Round 内顺序存储）
 *
 * 由宿主在 consumeFlow 旁路从 AgentChunk / 主机事件派生，流结束时附到 Round.processEvents
 * 一次性落盘；重放时按 seq 有序重建 UI（运行时与重放共用同一渲染数据源）。
 *
 * 事件类型全量：
 * - meta：每轮首条，该轮回答身份
 * - thinking / memory_added / tool_start / tool_result：过程明细
 * - self_review / text_self_review：自审查过程与输出
 * - aborted：中断标记
 * - metrics：每轮末条，执行汇总
 */
export type ProcessEvent =
  | { type: 'meta'; seq: number; ts: string; payload: ProcessMetaPayload }
  | { type: 'thinking'; seq: number; ts: string; payload: { phase: ProcessThinkingPhase } }
  | {
      type: 'memory_added';
      seq: number;
      ts: string;
      payload: { id: string; name: string; source: string };
    }
  /**
   * 工具调用开始。payload.stepIndex = 所属 step 的轮内序号（内核 loop 单点打标、与 thought.stepIndex
   * 同构，缺省 = 无归属）；tool_result 不重复携带——经 payload.toolCallId 归属本条（事实单点）。
   */
  | {
      type: 'tool_start';
      seq: number;
      ts: string;
      payload: { toolCallId: string; name: string; args?: string; stepIndex?: number };
    }
  | {
      type: 'tool_result';
      seq: number;
      ts: string;
      payload: {
        toolCallId: string;
        name: string;
        ok: boolean;
        summary?: string;
        /** 策略拦截：ok=false + blocked=true = 被确定性拒绝未执行（如搜索达硬上限） */
        blocked?: boolean;
      };
    }
  /**
   * 自审查（单次终审）：无有效载荷。
   * 已落盘的历史数据可能仍带 `round`（该值恒为 1，从未承载过 >1），
   * 反序列化后作为多余键忽略，不影响读取，无需迁移。
   */
  | { type: 'self_review'; seq: number; ts: string; payload: Record<string, never> }
  | { type: 'text_self_review'; seq: number; ts: string; payload: { content: string } }
  | { type: 'narrate'; seq: number; ts: string; payload: { content: string } }
  /**
   * 模型思考内容流：reasoning_content 增量累积结果。
   * 仅供重放重建「思考」折叠块；展示轨承载，正文轨/记忆轨不消费（CoT 防护）。命名用 thought——
   * 区别于上方既有 `type:'thinking'`（phase 相位事件）与多模型路由任务 `TaskType='reasoning'`，
   * 三者语义分离，避免同 union 判别式重复与跨层双义。
   * payload.content 超长由宿主落盘前截断（MAX_THOUGHT_PAYLOAD_LENGTH，SSOT 常量单点定义于 chatPanel）。
   * payload.stepIndex = 本条思考所属 step（一次 LLM 调用 + 可选工具执行）的轮内序号
   * （内核 loop 打标、随内容同源落盘），「一个 step 一个思考折叠块」的归桶键；
   * 缺省（旧数据）由展示层回落整轮单桶。
   */
  | { type: 'thought'; seq: number; ts: string; payload: { content: string; stepIndex?: number } }
  /**
   * 任务项级折叠边界：active 任务项推进时由 loop 产，
   * 宿主落盘此事件把后续 narrate/tool/问答归到对应任务项分组。无任务表不产。
   */
  | {
      type: 'plan_item_boundary';
      seq: number;
      ts: string;
      payload: { planItemId?: string; title?: string };
    }
  | {
      type: 'aborted';
      seq: number;
      ts: string;
      payload: { reason: string; stopReason?: AbortStopReason };
    }
  /**
   * 流式错误（重放可见性）：失败轮在**实时流**里已有 `AgentChunk.error`（宿主据此即时弹
   * 提示条），但该 chunk **不落 processEvents** → 回看历史时原因丢失、只剩 generic「对话已中断」，
   * 用户无法回答「这轮为什么没答完」。本变体把 error 落进重放轨，宿主桥接点 =
   * `chatPanel.consumeFlow` 的 `error` 分支。
   *
   * 与 `aborted` 的分工（**禁互相承载**，见 `agent/types.ts` 的 `AbortStopReason` 注释）：`aborted`
   * 由 AbortSignal 触因产生（用户停止 / 锁超时），答「谁让它停的」；本变体答「出了什么错」。
   * 二者在 failed 路径互斥（`signal.aborted === false` 才抛错），故不构成同轮双写。
   * `category` 与 `AgentChunk.error.category` **同源**（`LlmErrorCategory`）——展示面文案映射共用一份。
   */
  | {
      type: 'error';
      seq: number;
      ts: string;
      payload: { message: string; category?: LlmErrorCategory };
    }
  | { type: 'metrics'; seq: number; ts: string; payload: ProcessMetricsPayload };

// ─── 问答闭环 ───────────────────────────────────────────

// ─── 裁决证据（⚠️ 落位约束：勿移入上方 ProcessEvent 切片区——V-3 守卫按
// 「export type ProcessEvent =」→「─── 问答闭环」切片枚举 UI 过程轨成员，
// 本轨刻意不进 processEvents（内核直写 Round.evidence 持久化），混入切片即误报）───

/**
 * 裁决证据事件（悬案取证轨，Round.evidence 元素）
 *
 * 定位：给「带伤悬案」提供跨会话可回溯的个案证据（回显命中 = 模型规避还是防重误拦、
 * 空响应是否偏爱会议轮），消费方是人工/抽样裁决，不是 UI 重放——
 * 故不进 processEvents（宿主 UI 过程轨），由内核单点追加到在途 Round，
 * 宿主整对象 JSON 持久化天然携带。
 *
 * 「会议轮」操作化判据（唯一实现在 loop 写点 isMeetingRound）：
 * 任务表 active 任务项声明 rolePack（= 会议逐项切换生效中）。
 */
export type RoundEvidenceEvent =
  | {
      /** LLM 空响应兜底命中（200 但无文本无工具调用） */
      type: 'empty_response';
      /** 事件时刻（ISO 8601） */
      ts: string;
      /** 事件时刻是否会议轮（判据见类型注释） */
      meetingRound: boolean;
      payload: {
        /** 轮内第几次 LLM 迭代（定位空响应发生在闭环什么位置） */
        iteration: number;
      };
    }
  | {
      /** read_file 台账替身回显命中（摘要顶替整读，防重拦截） */
      type: 'ledger_stub_echo';
      /** 事件时刻（ISO 8601） */
      ts: string;
      /** 事件时刻是否会议轮（判据见类型注释） */
      meetingRound: boolean;
      payload: {
        /** 被读文件路径（去重主体规范化前的原样路径） */
        path: string;
        /** 该文件已覆盖区间（裁决「误拦合法重读」vs「拦下规避性重读」的关键证据） */
        coverage: { coverStart: number; coverEnd: number; totalLines: number };
        /** 本次请求区间（offset/limit 缺省语义与 read_file handler 一致） */
        request: { offset?: number; limit?: number };
      };
    }
  | {
      /** read_dedup 护栏硬拦命中（同主体重复获取且结果仍在上下文；L2 精确判重兜底观测） */
      type: 'read_dedup_block';
      /** 事件时刻（ISO 8601） */
      ts: string;
      /** 事件时刻是否会议轮（判据见类型注释） */
      meetingRound: boolean;
      payload: {
        /** 被拦的工具名（read_file / list_dir / web_search / web_fetch / trace_summary / search_memories） */
        toolName: string;
        /**
         * 去重主体字段（存在才带）：定位 + read_file 区间，逐案裁决用。
         *
         * 字段形状真源 = **生产侧** `DedupSubject`（agent 层 toolResultCache）——本层**不镜像其清单**：
         * `memory → agent` 类型禁向（见 `backend_layers_rules.md`）使本层无法 import 该类型，故以开放式
         * 索引签名承载，由 loop 侧整体 spread 透传。`DedupSubject` 增字段随透传自动落盘，本层零同步。
         *
         * 零同步的两条代价（本层边界，改动上述透传写法时须一并考虑）：
         * - **键名拼写无编译保护**：索引签名接受任意 string 键，拼错（如 `toolname`）仍编译通过，
         *   落盘静默少一个字段；故消费侧按键名取值时须以生产侧 `DedupSubject` 为准。
         * - **透传 spread 顺序**：生产侧写法为 `{ toolName, ...subject }`，spread 在后——若 `DedupSubject`
         *   将来新增 `toolName` 字段，会**静默覆盖**这里的 `toolName`；增该字段时须同步调整透传顺序。
         */
        [dedupField: string]: string | number | undefined;
      };
    };

/**
 * 问答闭环（Round）
 *
 * 设计约束：
 * 1. 全局唯一 ID：一个 roundId 在物理存储中只对应一个问答闭环
 * 2. 包含一轮完整的 User + AI 对话
 * 3. 独立于会话存储，可被多个会话引用（分叉场景）
 * 4. Append-only 设计：完成后不可修改，如需"修改"则创建新 Round
 */
export interface Round {
  /**
   * 全局唯一 ID（格式：round-{uuid}）
   *
   * 唯一性保证：
   * - 物理存储层唯一标识
   * - 记忆溯源的唯一锚点（Memory.roundId 指向此字段）
   * - 分叉操作的唯一引用
   */
  id: string;

  /** 用户消息 */
  userMessage: RoundMessage;

  /** AI 消息（pending 状态时可能为空） */
  assistantMessage?: RoundMessage;

  /**
   * 问答闭环内交互输入
   *
   * LLM 主动提问回答 / 用户中途补充（插话 / 暂停续跑输入）按时间序追加于此处，
   * 不因交互输入分裂出新问答闭环。assistantMessage 恒为闭环节点的最终回答；
   * 此数组仅承载用户侧交互输入，供重放渲染折叠的「用户提问 / 用户补充」块。
   */
  interactiveInputs?: RoundInteractiveInput[];

  /**
   * 裁决证据（悬案取证轨）
   *
   * 空响应兜底 / 台账替身回显等「需事后裁决」的个案证据按时间序追加于此，
   * 供跨会话人工/抽样裁决（消费方非 UI 重放，不进 processEvents）。
   * 随 Round 整对象持久化；无证据的轮无此字段（零冗余）。
   */
  evidence?: RoundEvidenceEvent[];

  /**
   * 问答闭环内多段 assistant
   *
   * 闭环节点跨暂停-续跑时，前序 assistant 段（如主动提问、中断半截）
   * 入此数组，assistantMessage 恒为末段（最终回答）。普通单段问答轮无此字段
   * （零冗余：仅在 appendAssistant 重写已存在 assistantMessage 时产生）。
   */
  assistantLog?: RoundMessage[];

  /** 问答闭环状态 */
  status: RoundStatus;

  /** 创建时间（ISO 8601） */
  createdAt: string;

  /** 完成时间（ISO 8601，仅 complete 状态有值） */
  completedAt?: string;

  /**
   * 引用计数（被多少个会话引用）
   *
   * 用途：
   * - 分叉时增加引用（新会话引用同一个 Round）
   * - 删除会话时减少引用
   * - 引用计数为 0 时可被 GC 清理
   */
  refCount: number;

  /**
   * 过程事件（每轮 UI 状态重建真相源，可选）
   *
   * 与 assistantMessage 同在闭环完成时刻定型（Write-once），存储于同一 Round 文件——
   * 删 round 即删事件、分叉即共享、截断即覆盖（v1.5 单文件内聚，见
   * process-event-log-replay-design.md §3.4）。缺省仅因 pending/error 轮无过程数据。
   */
  processEvents?: ProcessEvent[];
}

// ─── 问答闭环存储接口 ───────────────────────────────────

/**
 * 问答闭环存储接口 —— 宿主注入的 Round 持久化能力
 *
 * 设计原则：
 * 1. 同步语义（对齐 IMemoryStorage）
 * 2. 宿主实现：生产由宿主注入持久化存储（当前 vscode 宿主为 JSON 文件落地），测试用内存实现
 * 3. 可选方法：部分方法可由宿主选择性实现
 */
export interface IRoundStore {
  /**
   * 存储问答闭环（新增或更新）
   *
   * 原子性保证：
   * - pending → complete 的状态转换必须是原子操作
   * - 写入失败时不部分更新
   */
  save(round: Round): void;

  /**
   * 按 ID 获取问答闭环
   *
   * @param roundId - 全局唯一 Round ID
   * @returns Round 对象，不存在返回 null
   */
  getById(roundId: string): Round | null;

  /**
   * 批量获取问答闭环（按 ID 列表）
   *
   * 用途：会话加载时批量获取 Round，避免 N+1 查询
   *
   * @param roundIds - Round ID 数组
   * @returns Round 对象数组（按输入顺序）
   */
  getByIds(roundIds: string[]): Round[];

  /**
   * 列出所有问答闭环（用于调试和 GC）
   *
   * ⚠️ 生产环境慎用：全量遍历可能性能开销大
   */
  listAll(): Round[];

  /**
   * 增加引用计数（分叉时调用）
   *
   * @param roundId - 需要增加引用的 Round ID
   */
  incrementRef(roundId: string): void;

  /**
   * 减少引用计数（删除会话时调用）
   *
   * @param roundId - 需要减少引用的 Round ID
   */
  decrementRef(roundId: string): void;

  /**
   * 删除问答闭环（物理删除，不可恢复）
   *
   * 前置条件：
   * - refCount === 0（无其他会话引用）
   * - 一般由 GC 服务调用
   *
   * @param roundId - 要删除的 Round ID
   * @returns 是否删除成功
   */
  delete(roundId: string): boolean;

  /**
   * 按状态列出问答闭环（用于 GC 和监控）
   *
   * @param status - Round 状态筛选
   * @returns 符合条件的 Round 数组
   */
  listByStatus?(status: RoundStatus): Round[];

  /**
   * 获取孤立的问答闭环列表（refCount === 0）
   *
   * 用于 GC 服务批量清理
   *
   * @param minAgeMs - 最小存活时间（毫秒），避免清理正在使用的 Round
   * @returns 孤立 Round 数组
   */
  listOrphaned?(minAgeMs?: number): Round[];

  /**
   * 列出指定日期最近未完成（pending/error）的崩溃残留轮（step 原子落盘）。
   *
   * 用途：崩溃残留轮升级前的**只读中转**——崩溃发生在 appendAssistant 完成前时，该轮
   * refCount=0、未登记进会话 roundIds，宿主无法从会话列表发现；但其过程已由 step 原子
   * 检查点落盘到 pending Round。宿主重启后经此口查回，「找到」后由宿主调用收场方法
   * （MessageHistory.appendInterrupted）**升级为正常 stop turn** 并登记入会话。
   *
   * 语义约束（SSOT）：
   * - **只读查询**，不登记会话、不改写 Round、不改变 appendAssistant 完成语义；
   *   升级登记是独立的「收场」动作（§一·五：中断轮 = 正常 stop turn，非半成品草稿）。
   * - **不污染正式会话 roundIds**——升级登记完成（complete + refCount>0）前，中断轮
   *   仍是无引用中间态，本接口只处理该短暂窗口的「找到」。
   * - 中断轮超龄后仍由 GC sweepOrphans 正常回收（refCount=0 孤儿），本接口不改变其生命周期；
   *   打捞窗口落在启动后的升级动作内（早于 24h 存活保护），不构成误回收。
   *
   * @param date - YYYY-MM-DD，按 createdAt 的前缀匹配（ISO 日期头 10 位）
   * @param limit - 最多返回条数，按 createdAt 降序（最新在前）；缺省不截断
   * @returns 中断残留 Round 数组（按 createdAt 倒序）
   */
  listInterruptedRecent?(date: string, limit?: number): Round[];
}

// ─── 辅助函数 ───────────────────────────────────────────

/**
 * 生成 Round ID（格式：round-{uuid}）
 *
 * 使用 crypto.randomUUID() 保证全局唯一性
 */
export function generateRoundId(): string {
  // 使用 crypto.randomUUID()（Node.js 19+ / 现代浏览器支持）
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return `round-${crypto.randomUUID()}`;
  }
  // 降级方案：时间戳 + 随机数
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 10);
  return `round-${timestamp}${random}`;
}

/**
 * 生成消息 ID（格式：msg-{uuid}）
 */
export function generateMessageId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return `msg-${crypto.randomUUID()}`;
  }
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 10);
  return `msg-${timestamp}${random}`;
}

/**
 * 创建 pending 状态的 Round
 *
 * 辅助函数：快速创建新问答闭环的骨架
 *
 * @param userMessage - 用户消息内容
 * @returns 新创建的 pending Round
 */
export function createPendingRound(userMessage: string): Round {
  const id = generateRoundId();
  const now = new Date().toISOString();

  return {
    id,
    userMessage: {
      id: generateMessageId(),
      role: 'user',
      content: userMessage,
      timestamp: now,
    },
    status: 'pending',
    createdAt: now,
    refCount: 1,
  };
}

/**
 * 完成 Round（设置 AI 消息）
 *
 * 辅助函数：将 pending Round 转换为 complete 状态
 *
 * ⚠️ 注意：本函数**不设置任何摘要关联字段**——摘要记忆的 ID 由 roundSummaryGenerator
 * 按 `round-summary:{sessionName}:{roundId}` 独立构造并按 roundId 溯源，
 * Round 侧不持有反向指针（GC 清理走 roundId 派生寻址，见 gcService）。
 *
 * @param round - 要完成的 Round（必须是 pending 状态）
 * @param assistantContent - AI 回复内容
 * @param tokenUsage - Token 用量统计
 * @returns 更新后的 complete Round
 */
export function completeRound(
  round: Round,
  assistantContent: string,
  tokenUsage?: { input: number; output: number },
): Round {
  const now = new Date().toISOString();

  return {
    ...round,
    assistantMessage: {
      id: generateMessageId(),
      role: 'assistant',
      content: assistantContent,
      timestamp: now,
      tokenUsage,
    },
    status: 'complete',
    completedAt: now,
  };
}
