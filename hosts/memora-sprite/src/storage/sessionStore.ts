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

  appendMessage(date: string, session: string, message: SessionMessage): void {
    this.db.prepare(`
      INSERT INTO sessions (date, session, role, content, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `).run(date, session, message.role, message.content, message.timestamp);
  }

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

  listSessions(): string[] {
    const rows = this.db.prepare(
      "SELECT DISTINCT date || '-' || session AS session_id FROM sessions ORDER BY session_id"
    ).all() as { session_id: string }[];
    return rows.map(r => r.session_id);
  }

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
