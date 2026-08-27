import type { MessageRole } from '@/memory/types.js';

/**
 * 会话存储接口：宿主注入的会话消息持久化能力，内核不直接依赖文件 I/O。
 * IMemoryStorage 存记忆索引（round-summary），这里存原始对话消息。零依赖内核、接口最小化、不实现则走内存模式。
 *
 * 存储模式演进（2026-08-27）：
 * - legacy 模式：存储消息列表（SessionMessage[]），当前默认
 * - round-based 模式：存储 Round ID 列表（string[]），新设计
 *
 * 两种模式可共存：会话通过 SessionMeta.storageMode 字段标识使用哪种模式
 */
export interface ISessionStore {
  // ── Legacy 模式方法（消息列表存储） ──────────────────
  /** 追加消息到指定会话（legacy 模式） */
  appendMessage(date: string, session: string, message: SessionMessage): void;
  /** 加载指定会话消息列表（legacy 模式），不存在返回空数组 */
  loadMessages(date: string, session: string): SessionMessage[];

  // ── 通用方法 ─────────────────────────────────────────
  /** 列出所有会话标识（YYYY-MM-DD-session） */
  listSessions(): string[];
  /** 复制源会话消息到目标会话（原子、保留时间戳；目标已存在则覆盖，源不存在则静默） */
  copySession?(
    sourceDate: string,
    sourceSession: string,
    targetDate: string,
    targetSession: string,
  ): void;
  /** 覆盖保存会话检查点（存储层序列化 JSON，不关心内部结构） */
  saveCheckpoint?(sessionId: string, checkpoint: string): void;
  /** 加载会话检查点，不存在返回 null */
  loadCheckpoint?(sessionId: string): string | null;
  /** 删除会话检查点，不实现为 no-op */
  deleteCheckpoint?(sessionId: string): void;
  /** 读取会话标题元数据，不存在返回 undefined */
  getSessionMeta?(sessionId: string): SessionMeta | undefined;
  /** 设置用户可修改的显示名（displayName）；首轮自动命名走 updateSessionMeta 写 autoName */
  setSessionTitle?(sessionId: string, title: string): void;
  /** 更新 LLM 生成只读元数据（autoName/keyTopics/summary），与 setSessionTitle 分开 */
  updateSessionMeta?(sessionId: string, meta: Partial<SessionMeta>): void;
  /** 列出全部会话标题元数据，供历史列表按 updatedAt 排序；不实现则降级为 listSessions() */
  listSessionMetas?(): SessionMeta[];

  // ── Round-based 模式方法（问答闭环独立存储） ──────────
  /**
   * 追加 Round ID 到会话（round-based 模式）
   *
   * @param sessionId - 会话 ID
   * @param roundId - 要追加的 Round ID
   */
  appendRoundId?(sessionId: string, roundId: string): void;

  /**
   * 批量追加 Round ID 到会话（round-based 模式）
   *
   * 用于分叉操作：一次性复制多个 Round ID
   *
   * @param sessionId - 会话 ID
   * @param roundIds - 要追加的 Round ID 数组
   */
  appendRoundIds?(sessionId: string, roundIds: string[]): void;

  /**
   * 获取会话的 Round ID 列表（round-based 模式）
   *
   * @param sessionId - 会话 ID
   * @returns Round ID 数组（按顺序）
   */
  getRoundIds?(sessionId: string): string[];

  /**
   * 设置会话的 Round ID 列表（round-based 模式）
   *
   * 用于创建新会话或完整替换（如分叉操作）
   *
   * @param sessionId - 会话 ID
   * @param roundIds - 新的 Round ID 列表
   */
  setRoundIds?(sessionId: string, roundIds: string[]): void;

  /**
   * 创建新会话元数据（round-based 模式）
   *
   * @param meta - 会话元数据
   */
  createSession?(meta: SessionMeta): void;

  /**
   * 删除会话（round-based 模式）
   *
   * 同时减少引用计数（由上层调用 RoundStore.decrementRef）
   *
   * @param sessionId - 会话 ID
   */
  deleteSession?(sessionId: string): void;
}

/**
 * 会话存储模式：标识会话使用哪种存储方式
 *
 * - 'legacy'：存储消息列表（SessionMessage[]），当前默认
 * - 'round-based'：存储 Round ID 列表（string[]），新设计
 */
export type SessionStorageMode = 'legacy' | 'round-based';

/**
 * 会话元数据：会话身份（date-session）与展示标题解耦。
 * 双层命名——autoName（LLM 生成只读）+ displayName（用户可改，覆盖显示）。sessionId 即 `${date}-${session}`。
 */
export interface SessionMeta {
  /** 会话标识（YYYY-MM-DD-sessionName，与 listSessions 一致） */
  sessionId: string;

  // ── 双层命名 ──
  /** LLM 自动生成名称（只读；归档时 SessionArchiver 可更新为更完整名称） */
  autoName?: string;
  /** 用户可修改的显示名称（初始=autoName；清空回退 autoName） */
  displayName?: string;

  // ── 搜索/索引数据（LLM 生成只读） ──
  /** 关键主题标签（SessionArchiver 归档时生成，用于搜索/索引） */
  keyTopics?: string[];
  /** 会话摘要（SessionArchiver 归档时生成，用于搜索/预览） */
  summary?: string;

  // ── 存储模式 ──
  /** 存储模式（默认 'legacy'，新会话使用 'round-based'） */
  storageMode?: SessionStorageMode;
  /**
   * Round ID 列表（仅 round-based 模式使用）
   *
   * 问答闭环 ID 的有序列表，替代 legacy 模式的消息列表
   * 分叉操作时直接复制此列表（指针复制）
   */
  roundIds?: string[];

  // ── 元信息 ──
  /** 最近活跃时间（ISO 8601，历史列表排序依据） */
  updatedAt: string;
  /** 会话消息条数（命名信号与列表展示） */
  messageCount: number;
  /** 创建时间（ISO 8601） */
  createdAt?: string;
}

/**
 * 会话显示名称回退（SSOT 单一语义）：displayName → autoName → 空串。
 */
export function getSessionDisplayName(meta: SessionMeta | undefined): string {
  if (!meta) return '';
  // displayName 优先（用户可修改）
  const displayName = meta.displayName?.trim();
  if (displayName) return displayName;
  // autoName 次之（LLM 自动生成）
  const autoName = meta.autoName?.trim();
  if (autoName) return autoName;
  return '';
}

/** 仅取 autoName（用于搜索/索引），无则空串 */
export function getSessionAutoName(meta: SessionMeta | undefined): string {
  if (!meta) return '';
  const autoName = meta.autoName?.trim();
  return autoName ?? '';
}

/**
 * 会话消息类型：比 LLM Message 多 timestamp（持久化用）；roundId 供 traceSummary 精确回溯到轮次。
 */
export interface SessionMessage {
  /** 消息角色（从 memory/types.ts 导入，SSOT 单一真理源） */
  role: MessageRole;
  /** 消息内容 */
  content: string;
  /** 时间戳（ISO 8601） */
  timestamp: string;
  /** 所属轮次 ID（可选）：traceSummary 精确回溯用，空则退化为整会话摘要 */
  roundId?: string;
}

// ─── Round-based 模式辅助函数 ───────────────────────────

/**
 * 创建 round-based 模式的新会话元数据
 *
 * @param sessionId - 会话 ID（格式：${date}-${sessionName}）
 * @param initialRoundIds - 初始 Round ID 列表（可选，用于分叉操作）
 * @returns 新创建的 SessionMeta
 */
export function createRoundBasedSessionMeta(
  sessionId: string,
  initialRoundIds: string[] = [],
): SessionMeta {
  const now = new Date().toISOString();
  // 加入随机后缀确保唯一性（防止连续调用产生相同时间戳）
  const uniqueNow = `${now.slice(0, -1)}${Math.random().toString(36).slice(2, 5)}Z`;

  return {
    sessionId,
    storageMode: 'round-based',
    roundIds: [...initialRoundIds],
    createdAt: uniqueNow,
    updatedAt: uniqueNow,
    messageCount: initialRoundIds.length * 2, // 每个 Round 包含 User + AI 两条消息
  };
}

/**
 * 从 SessionMeta 判断是否为 round-based 模式
 *
 * @param meta - 会话元数据
 * @returns 是否为 round-based 模式
 */
export function isRoundBasedMode(meta: SessionMeta | undefined): boolean {
  if (!meta) return false;
  // 显式声明为 round-based，或有 roundIds 字段
  if (meta.storageMode === 'round-based') return true;
  if (meta.storageMode === undefined && meta.roundIds !== undefined) return true;
  return false;
}

/**
 * 计算 round-based 会话的消息数量
 *
 * @param roundIds - Round ID 列表
 * @param completedOnly - 是否只计算已完成的 Round（默认 true）
 * @returns 消息数量
 */
export function calculateMessageCount(
  roundIds: string[],
  completedOnly: boolean = true,
): number {
  if (!completedOnly) {
    // 简单估算：每个 Round 最多 2 条消息
    return roundIds.length * 2;
  }
  // 精确计算需要查询 Round 状态，这里提供估算值
  // 实际实现中应遍历 RoundStore 检查每个 Round 的 status
  return roundIds.length * 2;
}

