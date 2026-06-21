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
}

/** 数据库行类型 */
interface SessionRow {
  role: string;
  content: string;
  timestamp: string;
}
