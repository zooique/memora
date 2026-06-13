/**
 * 会话存储接口（ISessionStore）
 *
 * 宿主项目实现此接口，提供会话消息的持久化能力。
 * memora 内核通过此接口读写会话记录，不直接依赖文件 I/O。
 *
 * 与 IMemoryStorage 的关系：
 * - IMemoryStorage：记忆索引（SQLite），存储提取后的 insight
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
}

/**
 * 会话消息类型
 *
 * 与 LLM Message 的区别：
 * - SessionMessage 包含时间戳，用于持久化
 * - Message 不含时间戳，用于 LLM 通信
 */
export interface SessionMessage {
  /** 消息角色 */
  role: 'user' | 'assistant' | 'system';
  /** 消息内容 */
  content: string;
  /** 时间戳（ISO 8601） */
  timestamp: string;
}
