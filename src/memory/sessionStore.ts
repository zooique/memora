import type { MessageRole } from '@/memory/types.js';

/**
 * 会话存储接口（ISessionStore）
 *
 * 宿主项目实现此接口，提供会话消息的持久化能力。
 * memora 内核通过此接口读写会话记录，不直接依赖文件 I/O。
 *
 * 与 IMemoryStorage 的关系：
 * - IMemoryStorage：记忆索引（SQLite），存储 round-summary 等记忆
 * - ISessionStore：会话记录，存储原始对话消息
 *
 * 设计原则：
 * - 零依赖内核：memora 不实现文件 I/O，由宿主注入
 * - 接口最小化：只暴露必要的读写操作
 * - 向后兼容：不强制要求实现，不传则使用内存模式
 *
 * @example
 * // 宿主实现（文件存储）
 * class FileSessionStore implements ISessionStore {
 *   appendMessage(date, session, message) { ... }
 *   loadMessages(date, session) { ... }
 *   listSessions() { ... }
 * }
 *
 * // 注入到 Agent
 * const agent = new Agent({
 *   sessionStore: new FileSessionStore('./sessions'),
 *   ...
 * });
 */
export interface ISessionStore {
  /**
   * 追加消息到指定会话
   *
   * @param date - 会话日期 YYYY-MM-DD
   * @param session - 会话标识
   * @param message - 消息对象
   */
  appendMessage(date: string, session: string, message: SessionMessage): void;

  /**
   * 加载指定会话的消息列表
   *
   * @param date - 会话日期 YYYY-MM-DD
   * @param session - 会话标识
   * @returns 消息列表，不存在则返回空数组
   */
  loadMessages(date: string, session: string): SessionMessage[];

  /**
   * 列出所有会话标识
   *
   * @returns 会话标识列表（格式：YYYY-MM-DD-session）
   */
  listSessions(): string[];

  /**
   * 复制会话：将源会话的全部消息复制到目标会话
   *
   * 实现要求：
   * - 原子操作：要么全部复制成功，要么不产生副作用
   * - 保留时间戳：消息的 timestamp 不修改
   * - 幂等：若目标会话已存在，覆盖（而非追加）
   * - 若源会话不存在，静默返回（不抛出）
   *
   * @param sourceDate - 源会话日期
   * @param sourceSession - 源会话标识
   * @param targetDate - 目标会话日期
   * @param targetSession - 目标会话标识
   */
  copySession?(
    sourceDate: string,
    sourceSession: string,
    targetDate: string,
    targetSession: string,
  ): void;

  /**
   * 保存会话检查点（可选，不实现则使用内存模式）
   *
   * 覆盖保存：同 sessionId 的检查点将被覆盖。
   * 存储层将 JSON 字符串序列化后持久化，不关心内部结构。
   *
   * @param sessionId - 会话标识（格式：YYYY-MM-DD-sessionName）
   * @param checkpoint - 检查点 JSON 字符串
   */
  saveCheckpoint?(sessionId: string, checkpoint: string): void;

  /**
   * 加载会话检查点（可选，不实现返回 null）
   *
   * @param sessionId - 会话标识
   * @returns 检查点 JSON 字符串，不存在时返回 null
   */
  loadCheckpoint?(sessionId: string): string | null;

  /**
   * 删除会话检查点（可选，不实现为 no-op）
   *
   * 会话完成或关闭时清理持久化的检查点。
   *
   * @param sessionId - 会话标识
   */
  deleteCheckpoint?(sessionId: string): void;

  /**
   * 读取会话标题元数据（可选，ADR-024 会话标题层）
   *
   * 会话标题是独立的展示元数据，与会话身份（date-session）解耦。
   * 不实现则返回 undefined，命名管线按"无标题"处理。
   *
   * @param sessionId - 会话标识（格式：YYYY-MM-DD-sessionName）
   * @returns 会话元数据，不存在则返回 undefined
   */
  getSessionMeta?(sessionId: string): SessionMeta | undefined;

  /**
   * 设置会话标题（可选，ADR-024 会话标题层）
   *
   * 首轮闭环自动命名 / 用户手动改名均通过此方法写入。
   * 不实现则标题层静默失效（不影响会话主流程）。
   *
   * @param sessionId - 会话标识（格式：YYYY-MM-DD-sessionName）
   * @param title - 用户可读标题
   */
  setSessionTitle?(sessionId: string, title: string): void;

  /**
   * 列出所有会话的标题元数据（可选，ADR-024 会话标题层）
   *
   * 供宿主历史列表按 updatedAt 排序展示。
   * 不实现则历史列表降级为 listSessions() 的原始会话标识。
   *
   * @returns 全部会话元数据列表
   */
  listSessionMetas?(): SessionMeta[];
}

/**
 * 会话标题元数据（ADR-024 会话标题层）
 *
 * 会话身份（date-session）与展示标题解耦：
 * - 身份：ISessionStore 以 date+session 为主键读写消息
 * - 标题：本元数据独立承载用户可读标题，不污染会话主键
 *
 * sessionId 即 `${date}-${session}`，与 listSessions() 返回格式一致。
 */
export interface SessionMeta {
  /** 会话标识（格式：YYYY-MM-DD-sessionName，与 listSessions 一致） */
  sessionId: string;
  /** 用户可读标题（首轮闭环自动命名或手动改名产生） */
  title: string;
  /** 最近活跃时间（ISO 8601，历史列表排序依据） */
  updatedAt: string;
  /** 会话消息条数（供命名信号与列表展示） */
  messageCount: number;
}

/**
 * 会话消息类型
 *
 * 与 LLM Message 的区别：
 * - SessionMessage 包含时间戳，用于持久化
 * - Message 不含时间戳，用于 LLM 通信
 */
export interface SessionMessage {
  /** 消息角色（从 memory/types.ts 导入，SSOT 单一真理源） */
  role: MessageRole;
  /** 消息内容 */
  content: string;
  /** 时间戳（ISO 8601） */
  timestamp: string;
  /**
   * 所属轮次 ID（可选）
   *
   * 用于 traceSummary 工具精确回溯到具体轮次。
   * 为空时 `traceSummary` 只能返回整个会话的消息摘要。
   * 向后兼容：现有宿主不传此字段不影响行为。
   */
  roundId?: string;
}
