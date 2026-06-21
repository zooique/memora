/**
 * SqliteSessionStore — ISessionStore 的 better-sqlite3 实现
 *
 * 会话数据与记忆数据存储在同一 SQLite 数据库中（ADR-SP-002）。
 * 利用 SQLite 事务实现 copySession 的原子性要求。
 */
import type Database from 'better-sqlite3';
import type { ISessionStore, SessionMessage } from 'memora';

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
  private db: Database.Database;

  constructor(db: Database.Database) {
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
   * UX-FD-07 分页加载会话消息（倒序查询，返回时反转）
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
   * UX-FD-07 统计会话消息总数
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
   * FD-09 删除会话
   *
   * 删除指定会话的所有消息记录。不可恢复，调用方需自行确认。
   *
   * @param sessionId 会话 ID（格式：YYYY-MM-DD-sessionName）
   * @returns 是否删除成功
   */
  deleteSession(sessionId: string): boolean {
    const parts = sessionId.split('-');
    // 会话 ID 格式：YYYY-MM-DD-sessionName（至少 4 段）
    if (parts.length < 4) return false;
    const date = parts.slice(0, 3).join('-'); // YYYY-MM-DD
    const session = parts.slice(3).join('-'); // sessionName

    const result = this.db.prepare(
      'DELETE FROM sessions WHERE date = ? AND session = ?'
    ).run(date, session);
    return result.changes > 0;
  }

  /**
   * FD-09 重命名会话
   *
   * 更新指定会话的会话名。仅在当前项目下有效。
   * 注意：会话 ID 包含日期前缀，重命名仅修改 session 字段。
   *
   * @param sessionId 会话 ID（格式：YYYY-MM-DD-sessionName）
   * @param newName 新会话名
   * @returns 是否重命名成功
   */
  renameSession(sessionId: string, newName: string): boolean {
    const parts = sessionId.split('-');
    if (parts.length < 4) return false;
    const date = parts.slice(0, 3).join('-');
    const session = parts.slice(3).join('-');

    const result = this.db.prepare(
      'UPDATE sessions SET session = ? WHERE date = ? AND session = ?'
    ).run(newName, date, session);
    return result.changes > 0;
  }

  /**
   * 复制会话（ISessionStore 接口实现）
   *
   * 使用 SQLite 事务保证原子性：先清除目标会话，再逐条复制源会话消息。
   * 幂等操作：目标会话已存在时覆盖而非追加。
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
    const sourceMessages = this.loadMessages(sourceDate, sourceSession);
    if (sourceMessages.length === 0) return;

    const transaction = this.db.transaction(() => {
      // 先清除目标会话（幂等：覆盖而非追加）
      this.db.prepare(
        'DELETE FROM sessions WHERE date = ? AND session = ?'
      ).run(targetDate, targetSession);

      // 复制源会话消息到目标
      const insert = this.db.prepare(`
        INSERT INTO sessions (date, session, role, content, timestamp)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const msg of sourceMessages) {
        insert.run(targetDate, targetSession, msg.role, msg.content, msg.timestamp);
      }
    });

    transaction();
  }

  /**
   * UX-PP-05 获取会话首条用户消息用于列表预览
   *
   * 仅返回第一条 role='user' 的消息内容，截断到 50 字符。
   * 无用户消息时返回空字符串。
   *
   * @param sessionId 会话 ID（格式：YYYY-MM-DD-sessionName）
   */
  getFirstUserMessage(sessionId: string): string {
    const parts = sessionId.split('-');
    if (parts.length < 4) return '';
    const date = parts.slice(0, 3).join('-');
    const session = parts.slice(3).join('-');

    const row = this.db.prepare(
      "SELECT content FROM sessions WHERE date = ? AND session = ? AND role = 'user' ORDER BY id ASC LIMIT 1"
    ).get(date, session) as { content: string } | undefined;

    if (!row) return '';
    // 截断到 50 字符，避免预览过长
    return row.content.length > 50 ? row.content.slice(0, 50) + '...' : row.content;
  }
}

/** 数据库行类型 */
interface SessionRow {
  role: string;
  content: string;
  timestamp: string;
}
