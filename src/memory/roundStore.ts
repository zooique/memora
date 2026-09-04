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
import type { AbortStopReason } from '@/agent/types.js';

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
 * 交互输入类型（TS-9 问答闭环内交互输入归属）
 *
 * 一次外部输入（Trigger）= 一个问答闭环。执行中的三类用户交互输入
 * （LLM 主动提问回答 / 流式中补充 / 暂停后续跑补充）均归属当前问答闭环，
 * 不分裂新轮——类型只影响 UI 折叠块文案，不参与 round 归属判定。
 *
 * - question-answer：LLM 主动提问（ask_user 工具）的用户回答（宿主 handleResume 路由）
 * - supplement：用户中途补充（插话 interject / 暂停后主输入框补充）
 */
export type InteractiveInputKind = 'question-answer' | 'supplement';

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
}

// ─── 问答闭环状态 ───────────────────────────────────────

/**
 * 问答闭环状态机
 *
 * 状态流转：
 * - pending → complete：AI 回复生成完成
 * - pending → error：AI 回复生成失败
 * - error → pending：重试（创建新 Round，而非修改原 Round）
 */
export type RoundStatus = 'pending' | 'complete' | 'error';

// ─── 过程事件（ProcessEvent）────────────────────────────
// 每轮「过程事件」= UI 状态重建的最小信息（运行时与重放共用同一份数据，
// 见 docs/architecture/process-event-log-replay-design.md §3.3）。
// 落位决策：ProcessEvent 是 Round 的组成部分（存储面），故定义于 memory/；
// thinking 阶段用本地字面量 ProcessThinkingPhase（与 agent/types.ts ThinkingPhase 同值），
// 避免 memory → agent 反向依赖（对齐 protocol.ts「宿主侧本地字面量避免跨包类型耦合」先例）。

/**
 * 思考阶段值（与 agent ThinkingPhase 同值的本地字面量，解耦依赖方向）
 *
 * 阶段与 Agent turn 对应：recalling=召回 / llm_calling=调用模型 / processing=处理 /
 * planning,step,reporting=多 turn 任务编排（档2 externalTaskLoop）/ archiving=归档。
 */
export type ProcessThinkingPhase =
  | 'recalling'
  | 'processing'
  | 'archiving'
  | 'llm_calling'
  | 'planning'
  | 'step'
  | 'reporting';

/** meta 事件载荷：该轮回答身份（角色/模型均为显示名，重放不依赖 ProviderStore/RolePackManager） */
export interface ProcessMetaPayload {
  /** 角色显示名（displayName ?? name） */
  role: string;
  /** 模型显示名（displayName ?? name） */
  llm: string;
}

/** recall 事件条目：召回记忆摘要（不含全文，指针不带内容，与作品投影同构） */
export interface ProcessRecallItem {
  /** 记忆唯一标识（source:name） */
  id: string;
  /** 记忆可读名称 */
  name: string;
  /** 来源标签（如 'round-summary'） */
  source: string;
  /** 相似度分数（0-1） */
  score: number;
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
  /** 召回记忆条数 */
  recallCount: number;
  /** 本轮是否成功完成（false = 中断/失败） */
  success: boolean;
}

/**
 * 过程事件（过程轨最小信息，Round 内顺序存储）
 *
 * 由宿主在 consumeFlow 旁路从 AgentChunk / 主机事件派生，流结束时附到 Round.processEvents
 * 一次性落盘；重放时按 seq 有序重建 UI（运行时与重放共用同一渲染数据源）。
 *
 * 事件类型全量：
 * - meta：每轮首条，该轮回答身份
 * - thinking / recall / memory_added / tool_start / tool_result：过程明细
 * - self_review / text_self_review：自审查过程与输出
 * - aborted：中断标记
 * - metrics：每轮末条，执行汇总
 */
export type ProcessEvent =
  | { type: 'meta'; seq: number; ts: string; payload: ProcessMetaPayload }
  | { type: 'thinking'; seq: number; ts: string; payload: { phase: ProcessThinkingPhase } }
  | { type: 'recall'; seq: number; ts: string; payload: { memories: ProcessRecallItem[] } }
  | {
      type: 'memory_added';
      seq: number;
      ts: string;
      payload: { id: string; name: string; source: string };
    }
  | {
      type: 'tool_start';
      seq: number;
      ts: string;
      payload: { toolCallId: string; name: string; args?: string };
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
        /** 策略拦截（2026-09-02）：ok=false + blocked=true = 被确定性拒绝未执行（如搜索达硬上限） */
        blocked?: boolean;
      };
    }
  | { type: 'self_review'; seq: number; ts: string; payload: { round: number } }
  | { type: 'text_self_review'; seq: number; ts: string; payload: { content: string } }
  | { type: 'narrate'; seq: number; ts: string; payload: { content: string } }
  | { type: 'aborted'; seq: number; ts: string; payload: { reason: string; stopReason?: AbortStopReason } }
  | { type: 'metrics'; seq: number; ts: string; payload: ProcessMetricsPayload };

// ─── 问答闭环 ───────────────────────────────────────────

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
   * 问答闭环内交互输入（TS-9，2026-09-02 新增）
   *
   * LLM 主动提问回答 / 用户中途补充（插话 / 暂停续跑输入）按时间序追加于此处，
   * 不因交互输入分裂出新问答闭环。assistantMessage 恒为闭环节点的最终回答；
   * 此数组仅承载用户侧交互输入，供重放渲染折叠的「用户提问 / 用户补充」块。
   */
  interactiveInputs?: RoundInteractiveInput[];

  /**
   * 问答闭环内多段 assistant（TS-9，2026-09-02 新增）
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
   * 关联的记忆摘要 ID
   *
   * 格式：round-summary:{roundId}
   * 指向 Memory 存储中的摘要记录
   */
  summaryId?: string;

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
 * 2. 宿主实现：生产环境用 SQLite，测试用内存实现
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
 * 生成摘要 ID（格式：round-summary:{roundId}）
 *
 * 与现有 Memory.id 格式对齐
 */
export function generateSummaryId(roundId: string): string {
  return `round-summary:${roundId}`;
}

/**
 * 解析摘要 ID 获取 roundId
 *
 * @param summaryId - 摘要 ID（格式：round-summary:{roundId}）
 * @returns roundId，格式错误返回 null
 */
export function parseRoundIdFromSummaryId(summaryId: string): string | null {
  const prefix = 'round-summary:';
  if (!summaryId.startsWith(prefix)) return null;
  const roundId = summaryId.slice(prefix.length);
  // 空字符串检查
  if (roundId.length === 0) return null;
  return roundId;
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
 * 完成 Round（设置 AI 消息和摘要 ID）
 *
 * 辅助函数：将 pending Round 转换为 complete 状态
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
  const summaryId = generateSummaryId(round.id);

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
    summaryId,
  };
}
