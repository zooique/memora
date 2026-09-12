import type { MessageRole } from '@/memory/types.js';

/**
 * 会话存储接口：宿主注入的会话消息持久化能力，内核不直接依赖文件 I/O。
 * IMemoryStorage 存记忆索引（round-summary），这里存原始对话消息。零依赖内核、接口最小化、不实现则走内存模式。
 *
 * 存储模型（round-based 单一模式，SSOT）：
 * - 会话仅以 Round ID 列表（roundIds）为内容来源
 * - 消息内容只存于 RoundStore（物理存储唯一真相源）
 */
export interface ISessionStore {
  // ── 会话消息读写（round-based 单一真相源） ───────────
  /** 加载指定会话的完整消息列表（从 roundIds → RoundStore 展开），不存在返回空数组 */
  loadMessages(date: string, session: string): SessionMessage[];

  // ── 通用方法 ─────────────────────────────────────────
  /** 列出所有会话标识（YYYY-MM-DD-session） */
  listSessions(): string[];
  /** 读取会话标题元数据，不存在返回 undefined */
  getSessionMeta(sessionId: string): SessionMeta | undefined;
  /** 设置用户可修改的显示名（displayName）；首轮自动命名走 updateSessionMeta 写 autoName */
  setSessionTitle?(sessionId: string, title: string): void;
  /** 更新元数据（autoName/keyTopics/summary/createdAt 等） */
  updateSessionMeta(sessionId: string, meta: Partial<SessionMeta>): void;
  /**
   * 列出全部会话标题元数据，**必须按 updatedAt 降序**（最近活跃在前）。
   *
   * 排序方向是本接口契约的一部分，不是各实现自由：`SessionManager.restoreMostRecentSession`
   * 视 `[0]` 为「最近活跃会话」的唯一真理源；升序实现会让「恢复最近会话」恢复成最旧会话。
   */
  listSessionMetas(): SessionMeta[];

  // ── Round-based 方法（问答闭环独立存储，唯一模式） ──────────
  /** 追加 Round ID 到会话 */
  appendRoundId(sessionId: string, roundId: string): void;
  /** 批量追加 Round ID 到会话（分叉操作用） */
  appendRoundIds(sessionId: string, roundIds: string[]): void;
  /** 获取会话的 Round ID 列表 */
  getRoundIds(sessionId: string): string[];
  /** 设置会话的 Round ID 列表（创建/完整替换，如分叉） */
  setRoundIds(sessionId: string, roundIds: string[]): void;
  /** 创建新会话元数据 */
  createSession(meta: SessionMeta): void;
  /** 删除会话（同时清理 Round ID 引用） */
  deleteSession(sessionId: string): void;
}

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
