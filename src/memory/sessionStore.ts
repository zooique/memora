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
   * 设置用户可修改的显示名称（displayName）。
   * 首轮闭环自动命名使用 updateSessionMeta 写入 autoName；
   * 用户手动改名使用本方法写入 displayName。
   * 不实现则标题层静默失效（不影响会话主流程）。
   *
   * @param sessionId - 会话标识（格式：YYYY-MM-DD-sessionName）
   * @param title - 用户可读标题（写入 displayName）
   */
  setSessionTitle?(sessionId: string, title: string): void;

  /**
   * 更新会话元数据（可选，ADR-024 会话标题层 · 双层命名扩展）
   *
   * 用于写入 autoName / keyTopics / summary 等 LLM 生成的只读字段。
   * 与 setSessionTitle 分离：setSessionTitle 写 displayName（用户可修改），
   * 本方法写 autoName/keyTopics/summary（LLM 生成，只读）。
   *
   * 不实现则元数据层静默失效（不影响会话主流程）。
   *
   * @param sessionId - 会话标识（格式：YYYY-MM-DD-sessionName）
   * @param meta - 要更新的元数据字段（Partial<SessionMeta>）
   */
  updateSessionMeta?(sessionId: string, meta: Partial<SessionMeta>): void;

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
 * 会话元数据（ADR-024 会话标题层 · 双层命名扩展）
 *
 * 会话身份（date-session）与展示标题解耦：
 * - 身份：ISessionStore 以 date+session 为主键读写消息
 * - 元数据：本接口独立承载展示标题、搜索标签、会话摘要，不污染会话主键
 *
 * 双层命名设计：
 * - autoName: LLM 自动生成的名称（只读，首轮对话后生成）
 * - displayName: 用户可修改的显示名称（覆盖 autoName 显示）
 *
 * 向后兼容：
 * - autoName 为空时，回退到 title（旧字段）
 * - displayName 为空时，回退到 autoName（或 title）
 *
 * sessionId 即 `${date}-${session}`，与 listSessions() 返回格式一致。
 */
export interface SessionMeta {
  /** 会话标识（格式：YYYY-MM-DD-sessionName，与 listSessions 一致） */
  sessionId: string;

  // ── 双层命名（核心扩展） ──

  /**
   * 自动生成名称（只读，LLM 生成）
   * - 首轮对话后由 SessionNamer 生成（10 字以内简短标题）
   * - 会话归档时可由 SessionArchiver 更新为更完整的名称
   * - 用户不可修改
   * - 为空时回退到 title（向后兼容）
   */
  autoName?: string;

  /**
   * 显示名称（用户可修改）
   * - 初始值 = autoName（由 SessionNamer 同步写入）
   * - 用户修改后，显示层使用此值
   * - 用户清空时，回退到 autoName（或 title）
   */
  displayName?: string;

  /**
   * 用户可读标题（向后兼容字段）
   * - 旧版单标题模型的 title 字段
   * - 新版双层命名中，作为 autoName/displayName 的回退
   * - 宿主实现可继续使用此字段，内核按 displayName → autoName → title 优先级解析
   */
  title?: string;

  // ── 搜索/索引数据（只读，LLM 生成） ──

  /**
   * 关键主题标签（LLM 生成，用于搜索/索引）
   * - 由 SessionArchiver 归档时生成
   * - 格式：标签数组，如 ["React", "组件", "重构"]
   * - 用户不可修改
   */
  keyTopics?: string[];

  /**
   * 会话摘要（LLM 生成，用于搜索/预览）
   * - 由 SessionArchiver 归档时生成
   * - 格式：50-150 字高密度摘要
   * - 用户不可修改
   */
  summary?: string;

  // ── 元信息 ──

  /** 最近活跃时间（ISO 8601，历史列表排序依据） */
  updatedAt: string;
  /** 会话消息条数（供命名信号与列表展示） */
  messageCount: number;
}

/**
 * 获取会话显示名称（双层命名回退逻辑，SSOT 单一真理源）
 *
 * 优先级：displayName → autoName → title → 默认占位
 *
 * 规则：
 * 1. 用户有自定义名称（displayName 非空）→ 使用 displayName
 * 2. 用户无自定义名称，但有自动名称（autoName 非空）→ 使用 autoName
 * 3. 都为空，但有旧版标题（title 非空）→ 使用 title（向后兼容）
 * 4. 全部为空 → 返回空字符串（由调用方决定占位）
 *
 * @param meta - 会话元数据
 * @returns 显示名称
 */
export function getSessionDisplayName(meta: SessionMeta | undefined): string {
  if (!meta) return '';
  // displayName 优先（用户可修改）
  const displayName = meta.displayName?.trim();
  if (displayName) return displayName;
  // autoName 次之（LLM 自动生成）
  const autoName = meta.autoName?.trim();
  if (autoName) return autoName;
  // title 兜底（向后兼容旧版单标题模型）
  const title = meta.title?.trim();
  if (title) return title;
  return '';
}

/**
 * 获取会话自动名称（仅 autoName，用于搜索/索引）
 *
 * 规则：autoName → title → 空
 *
 * @param meta - 会话元数据
 * @returns 自动名称
 */
export function getSessionAutoName(meta: SessionMeta | undefined): string {
  if (!meta) return '';
  const autoName = meta.autoName?.trim();
  if (autoName) return autoName;
  const title = meta.title?.trim();
  if (title) return title;
  return '';
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
