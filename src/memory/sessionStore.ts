import type { MessageRole } from '@/memory/types.js';

/**
 * 会话存储接口：宿主注入的会话消息持久化能力，内核不直接依赖文件 I/O。
 * IMemoryStorage 存记忆索引（round-summary），这里存原始对话消息。零依赖内核、接口最小化、不实现则走内存模式。
 */
export interface ISessionStore {
  /** 追加消息到指定会话 */
  appendMessage(date: string, session: string, message: SessionMessage): void;
  /** 加载指定会话消息列表，不存在返回空数组 */
  loadMessages(date: string, session: string): SessionMessage[];
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