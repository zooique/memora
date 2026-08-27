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
