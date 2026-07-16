/**
 * SqliteSessionStore — ISessionStore 的 better-sqlite3 实现
 *
 * 会话数据与记忆数据存储在同一 SQLite 数据库中（ADR-SP-002）。
 * 利用 SQLite 事务实现 copySession 的原子性要求。
 */
import type { ISessionStore, SessionMessage } from 'memora';
import type { ISqliteDatabase } from './sqliteDatabaseTypes.js';
// 文本截断工具（跨层共享，统一 ellipsis 为 '…'，ADR-017 枝叶层 2 次提取）
import { truncate } from '../shared/truncate.js';

/** 建表 SQL */
const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  date      TEXT NOT NULL,
  session   TEXT NOT NULL,
  role      TEXT NOT NULL,
  content   TEXT NOT NULL,
  timestamp TEXT NOT NULL
);
`;

/** 创建索引 */
const CREATE_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_sessions_date_session ON sessions(date, session);
`;

/**
 * better-sqlite3 实现的 ISessionStore
 */
export class SqliteSessionStore implements ISessionStore {
  private db: ISqliteDatabase;

  constructor(db: ISqliteDatabase) {
    this.db = db;
    this.db.exec(CREATE_TABLE_SQL);
    this.db.exec(CREATE_INDEX_SQL);
  }

  /**
   * 追加单条消息到会话（ISessionStore 接口实现）
   *
   * @param date 会话日期标识
   * @param session 会话名称
   * @param message 消息对象（role / content / timestamp）
   */
  appendMessage(date: string, session: string, message: SessionMessage): void {
    this.db.prepare(`
      INSERT INTO sessions (date, session, role, content, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `).run(date, session, message.role, message.content, message.timestamp);
  }

  /**
   * 加载会话消息（ISessionStore 接口实现）
   *
   * @param date 会话日期标识
   * @param session 会话名称
   * @returns 按时间升序排列的消息数组
   */
  loadMessages(date: string, session: string): SessionMessage[] {
    const rows = this.db.prepare(
      'SELECT role, content, timestamp FROM sessions WHERE date = ? AND session = ? ORDER BY id ASC'
    ).all(date, session) as SessionRow[];
    return rows.map(r => ({
      role: r.role as SessionMessage['role'],
      content: r.content,
      timestamp: r.timestamp,
    }));
  }

  /**
   * 分页加载会话消息（倒序查询，返回时反转）
   *
   * 使用 ORDER BY id DESC + LIMIT/OFFSET 实现高效分页。
   * 查询结果为倒序（最新在前），反转后按时间升序返回。
   *
   * @param date 会话日期标识
   * @param session 会话名称
   * @param limit 每页条数（默认 50）
   * @param offset 偏移量（默认 0）
   * @returns 按时间升序排列的消息数组
   */
  loadMessagesPaginated(
    date: string,
    session: string,
    limit: number = 50,
    offset: number = 0,
  ): SessionMessage[] {
    const rows = this.db.prepare(
      'SELECT role, content, timestamp FROM sessions WHERE date = ? AND session = ? ORDER BY id DESC LIMIT ? OFFSET ?'
    ).all(date, session, limit, offset) as SessionRow[];
    // 反转：查询结果为倒序（最新在前），需反转为升序（最旧在前）供 UI 渲染
    return rows.reverse().map(r => ({
      role: r.role as SessionMessage['role'],
      content: r.content,
      timestamp: r.timestamp,
    }));
  }

  /**
   * 统计会话消息总数
   *
   * @param date 会话日期标识
   * @param session 会话名称
   * @returns 消息总数
   */
  countMessages(date: string, session: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) AS count FROM sessions WHERE date = ? AND session = ?'
    ).get(date, session) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  /**
   * 列出所有会话（ISessionStore 接口实现）
   *
   * @returns 会话 ID 列表（格式：date-session）
   */
  listSessions(): string[] {
    const rows = this.db.prepare(
      "SELECT DISTINCT date || '-' || session AS sessionId FROM sessions ORDER BY sessionId"
    ).all() as { sessionId: string }[];
    return rows.map(r => r.sessionId);
  }

  /**
   * 删除会话
   *
   * 删除指定会话的所有消息记录。不可恢复，调用方需自行确认。
   *
   * @param sessionId 会话 ID（格式：YYYY-MM-DD-sessionName）
   * @returns 是否删除成功
   */
  deleteSession(sessionId: string): boolean {
    const parsed = this.parseSessionId(sessionId);
    if (!parsed) return false;

    const result = this.db.prepare(
      'DELETE FROM sessions WHERE date = ? AND session = ?'
    ).run(parsed.date, parsed.session);
    return result.changes > 0;
  }

  /**
   * 重命名会话
   *
   * 更新指定会话的会话名。仅在当前项目下有效。
   * 注意：会话 ID 包含日期前缀，重命名仅修改 session 字段。
   *
   * 重命名前检查目标会话名是否已存在（同日期下），
   * 避免重命名为已有名称导致两个会话消息合并、数据混乱。
   * 检查 + 更新使用事务保证原子性，防止 TOCTOU 竞态。
   *
   * @param sessionId 会话 ID（格式：YYYY-MM-DD-sessionName）
   * @param newName 新会话名
   * @returns 是否重命名成功（目标名冲突时返回 false）
   */
  renameSession(sessionId: string, newName: string): boolean {
    const parsed = this.parseSessionId(sessionId);
    if (!parsed) return false;

    // 事务包裹"冲突检查 + 更新"，防止检查与更新之间的竞态
    const transaction = this.db.transaction(() => {
      // 检查目标会话名是否已存在（同日期下）
      const conflict = this.db.prepare(
        'SELECT 1 FROM sessions WHERE date = ? AND session = ? LIMIT 1'
      ).get(parsed.date, newName);
      if (conflict) return false;

      const result = this.db.prepare(
        'UPDATE sessions SET session = ? WHERE date = ? AND session = ?'
      ).run(newName, parsed.date, parsed.session);
      return result.changes > 0;
    });

    return transaction();
  }

  /**
   * 复制会话（ISessionStore 接口实现）
   *
   * 使用 SQLite 事务保证原子性：先清除目标会话，再用 INSERT INTO ... SELECT
   * 数据库层直接拷贝源会话消息。幂等操作：目标会话已存在时覆盖而非追加。
   *
   * loadMessages 全量加载到内存再逐条 insert，
   * 大型会话（数千条消息）会导致内存峰值和性能下降。
   * 改用 INSERT INTO ... SELECT 在数据库层直接拷贝，零内存占用。
   *
   * @param sourceDate 源会话日期
   * @param sourceSession 源会话名称
   * @param targetDate 目标会话日期
   * @param targetSession 目标会话名称
   */
  copySession(
    sourceDate: string,
    sourceSession: string,
    targetDate: string,
    targetSession: string,
  ): void {
    const transaction = this.db.transaction(() => {
      // 先清除目标会话（幂等：覆盖而非追加）
      this.db.prepare(
        'DELETE FROM sessions WHERE date = ? AND session = ?'
      ).run(targetDate, targetSession);

      // INSERT INTO ... SELECT 数据库层直接拷贝
      // 避免全量加载到内存，源会话为空时插入 0 行（no-op），无需提前返回
      this.db.prepare(`
        INSERT INTO sessions (date, session, role, content, timestamp)
        SELECT ?, ?, role, content, timestamp
        FROM sessions
        WHERE date = ? AND session = ?
      `).run(targetDate, targetSession, sourceDate, sourceSession);
    });

    transaction();
  }

  /**
   * 获取会话首条用户消息用于列表预览
   *
   * 仅返回第一条 role='user' 的消息内容，截断到 50 字符。
   * 无用户消息时返回空字符串。
   *
   * @param sessionId 会话 ID（格式：YYYY-MM-DD-sessionName）
   */
  getFirstUserMessage(sessionId: string): string {
    const parsed = this.parseSessionId(sessionId);
    if (!parsed) return '';

    const row = this.db.prepare(
      "SELECT content FROM sessions WHERE date = ? AND session = ? AND role = 'user' ORDER BY id ASC LIMIT 1"
    ).get(parsed.date, parsed.session) as { content: string } | undefined;

    if (!row) return '';
    // 截断到 MAX_PREVIEW_LENGTH 字符，避免预览过长
    return truncate(row.content, MAX_PREVIEW_LENGTH);
  }

  /**
   * 搜索对话内容（跨所有会话）
   *
   * 使用 LIKE '%keyword%' 模糊匹配，返回匹配的消息片段。
   * 结果按时间倒序（最新在前），限制最多 limit 条。
   *
   * @param keyword 搜索关键词（已转义 % 和 _）
   * @param limit 返回上限，默认 50
   * @returns 匹配的消息列表（含日期、会话名、角色、内容片段、时间戳）
   */
  searchMessages(keyword: string, limit: number = 50): SessionSearchRow[] {
    // 转义 SQL LIKE 通配符，防止关键词中的 % _ 被解释为模式
    const escaped = keyword.replace(/[%_]/g, (m) => '\\' + m);
    const pattern = `%${escaped}%`;
    const rows = this.db.prepare(
      `SELECT date, session, role, content, timestamp FROM sessions WHERE content LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT ?`
    ).all(pattern, limit) as SessionSearchRow[];
    return rows;
  }

  /**
   * 按日期前缀批量删除会话
   *
   * 删除指定日期的所有子会话（含 main 和遗留的 session-xxx）。
   * 提取自 sessionHandlers 的 for 循环聚合逻辑。
   *
   * @param datePrefix 日期前缀（YYYY-MM-DD）
   * @returns 删除的会话数量
   */
  deleteSessionsByDatePrefix(datePrefix: string): number {
    const allSessions = this.listSessions();
    let deletedCount = 0;
    for (const s of allSessions) {
      if (s.slice(0, 10) === datePrefix) {
        if (this.deleteSession(s)) deletedCount++;
      }
    }
    return deletedCount;
  }

  /**
   * 列出按日期聚合的会话列表
   *
   * 聚合规则：同一天取字符串排序最后的会话作为代表（listSessions 按
   * sessionId 字符串排序，非创建顺序——后出现的覆盖先出现的）。
   * 始终包含当天 main 会话（即使 0 条消息），确保跨日启动时至少有
   * "昨天+今天"两个选项可切换。
   *
   * 返回数据含预览和消息数，供 UI 直接渲染。
   * 提取自 sessionHandlers 的 Map 聚合 + 解析 + preview 逻辑。
   *
   * @param today 当前日期（YYYY-MM-DD），由调用方传入避免存储层依赖时间工具
   * @returns 聚合后的会话列表
   */
  listSessionsGroupedByDate(today: string): SessionListItem[] {
    const sessions = this.listSessions();
    // 按日期聚合：同一天取字符串排序最后的会话（后出现覆盖先出现）
    const dateMap = new Map<string, string>();
    for (const s of sessions) {
      const date = s.slice(0, 10);
      dateMap.set(date, s);
    }
    // 始终包含当天 main 会话（即使 0 条消息）
    if (!dateMap.has(today)) {
      dateMap.set(today, `${today}-main`);
    }
    // 解析每个日期的代表会话
    return Array.from(dateMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([_date, s]) => {
        const parsed = this.parseSessionId(s);
        if (parsed) {
          return {
            id: s,
            date: parsed.date,
            name: parsed.session,
            preview: this.getFirstUserMessage(s),
            messageCount: this.countMessages(parsed.date, parsed.session),
          };
        }
        return { id: s, date: s, name: s, preview: '', messageCount: 0 };
      });
  }

  /**
   * 解析会话 ID 为日期和会话名
   *
   * 会话 ID 格式：YYYY-MM-DD-sessionName（至少 4 段，date 占 3 段）。
   * 提取自 deleteSession / renameSession / getFirstUserMessage 三处重复逻辑。
   *
   * 添加日期格式校验，拒绝非法日期（如 "abcd-efg-hijk-session"）
   * 写入数据库。校验规则：4 位数字 + 2 位数字 + 2 位数字，基本格式检查，
   * 不校验日期有效性（如 2026-02-30 仍通过），由调用方保证语义正确。
   *
   * @param sessionId 会话 ID
   * @returns 解析后的 { date, session }，格式无效时返回 null
   */
  private parseSessionId(sessionId: string): { date: string; session: string } | null {
    const parts = sessionId.split('-');
    // 会话 ID 格式：YYYY-MM-DD-sessionName（至少 4 段）
    if (parts.length < 4) return null;
    const date = parts.slice(0, 3).join('-'); // YYYY-MM-DD
    const session = parts.slice(3).join('-'); // sessionName（可能含连字符）
    // 校验日期格式（YYYY-MM-DD），拒绝非法日期写入数据库
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    return { date, session };
  }
}

/** 数据库行类型 */
interface SessionRow {
  role: string;
  content: string;
  timestamp: string;
}

/** 搜索结果行类型 */
export interface SessionSearchRow {
  date: string;
  session: string;
  role: string;
  content: string;
  timestamp: string;
}

/** 会话列表项（按日期聚合后，供 UI 渲染） */
export interface SessionListItem {
  /** 会话 ID（格式：YYYY-MM-DD-sessionName） */
  id: string;
  /** 日期（YYYY-MM-DD） */
  date: string;
  /** 会话名 */
  name: string;
  /** 首条用户消息预览（截断到 50 字符） */
  preview: string;
  /** 消息总数 */
  messageCount: number;
}

/** 会话预览截断长度上限（字符数），超出部分追加 "..." */
const MAX_PREVIEW_LENGTH = 50;
