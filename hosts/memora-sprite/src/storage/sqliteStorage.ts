/**
 * SqliteStorage — IMemoryStorage 的 better-sqlite3 实现
 *
 * 宿主项目（精灵）持有 better-sqlite3 实例，实现 IMemoryStorage 接口后注入 Agent。
 * 所有方法均为同步（与 better-sqlite3 API 对齐）。
 *
 * 阶段一：search() 使用 LIKE 关键词匹配（与 InMemoryStorage 行为一致）
 * 阶段二：可选升级 FTS5 全文搜索
 */
import type Database from 'better-sqlite3';
import type { IMemoryStorage } from 'memora';
import type { Memory } from 'memora';
import { segmentText, validateSource, logger } from 'memora';

/** 建表 SQL */
const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS memories (
  id        TEXT PRIMARY KEY,
  content   TEXT NOT NULL,
  source    TEXT NOT NULL,
  name      TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  accessedAt TEXT NOT NULL,
  score     REAL NOT NULL DEFAULT 0.5
);
`;

/** 创建索引 */
const CREATE_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source);
CREATE INDEX IF NOT EXISTS idx_memories_score ON memories(score DESC);
`;

/**
 * better-sqlite3 实现的 IMemoryStorage
 */
export class SqliteStorage implements IMemoryStorage {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.db.exec(CREATE_TABLE_SQL);
    this.db.exec(CREATE_INDEX_SQL);
  }

  upsert(memory: Memory): void {
    const result = validateSource(memory.source);
    if (result.warning) {
      logger.warn({ id: memory.id, source: memory.source, warning: result.warning }, 'source 校验警告');
    }

    this.db.prepare(`
      INSERT INTO memories (id, content, source, name, createdAt, accessedAt, score)
      VALUES (@id, @content, @source, @name, @createdAt, @accessedAt, @score)
      ON CONFLICT(id) DO UPDATE SET
        content = @content,
        source = @source,
        name = @name,
        createdAt = @createdAt,
        accessedAt = @accessedAt,
        score = @score
    `).run(memory);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
  }

  getById(id: string): Memory | null {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined;
    return row ? this.rowToMemory(row) : null;
  }

  getBySource(source: string): Memory[] {
    const rows = this.db.prepare(
      'SELECT * FROM memories WHERE source = ? ORDER BY score DESC'
    ).all(source) as MemoryRow[];
    return rows.map(r => this.rowToMemory(r));
  }

  search(query: string, limit = 10): Memory[] {
    // 空查询：按 score 降序返回
    if (!query.trim()) {
      const rows = this.db.prepare(
        'SELECT * FROM memories ORDER BY score DESC LIMIT ?'
      ).all(limit) as MemoryRow[];
      return rows.map(r => this.rowToMemory(r));
    }

    // 规范分词（与 InMemoryStorage 行为一致）
    const tokens = segmentText(query).map(t => t.toLowerCase());

    // 若分词后无有效 token，降级为按 score 返回
    if (tokens.length === 0) {
      const rows = this.db.prepare(
        'SELECT * FROM memories ORDER BY score DESC LIMIT ?'
      ).all(limit) as MemoryRow[];
      return rows.map(r => this.rowToMemory(r));
    }

    // LIKE 关键词匹配：任一 token 命中即可
    // 安全说明：conditions 数组只包含硬编码的 '(content LIKE ? OR name LIKE ?)' 模板，
    // 用户输入通过 ? 占位符参数化传入，不存在 SQL 注入风险。
    // 如需修改 conditions 模板，务必保持参数化查询，禁止拼接用户输入。
    const conditions: string[] = [];
    const params: string[] = [];
    for (const token of tokens) {
      const pattern = `%${token}%`;
      conditions.push('(content LIKE ? OR name LIKE ?)');
      params.push(pattern, pattern);
    }

    const whereClause = conditions.join(' OR ');
    const sql = `SELECT * FROM memories WHERE ${whereClause} ORDER BY score DESC LIMIT ?`;
    params.push(String(limit));

    const rows = this.db.prepare(sql).all(...params) as MemoryRow[];
    return rows.map(r => this.rowToMemory(r));
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM memories').get() as { cnt: number };
    return row.cnt;
  }

  countBySource(source: string): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM memories WHERE source = ?').get(source) as { cnt: number };
    return row.cnt;
  }

  decayScores(sources: string[], now: Date): number {
    if (sources.length === 0) return 0;

    const placeholders = sources.map(() => '?').join(',');
    // 衰减公式与 InMemoryStorage 对齐：
    //   daysSinceAccess > 7 时，score -= 0.02 * floor(daysSinceAccess / 7)
    //   score 下限 0.1
    // SQLite 中 CAST(x AS INTEGER) 对正数等价于 floor
    const sql = `
      UPDATE memories
      SET score = MAX(0.1, score - 0.02 * (CAST((julianday(?) - julianday(accessedAt)) AS INTEGER) / 7))
      WHERE source IN (${placeholders})
        AND (julianday(?) - julianday(accessedAt)) > 7
    `;
    const params = [now.toISOString(), ...sources, now.toISOString()];
    const result = this.db.prepare(sql).run(...params);
    return result.changes;
  }

  close(): void {
    this.db.close();
  }

  // ─── 内部工具 ──────────────────────────────────────────

  private rowToMemory(row: MemoryRow): Memory {
    return {
      id: row.id,
      content: row.content,
      source: row.source,
      name: row.name,
      createdAt: row.createdAt,
      accessedAt: row.accessedAt,
      score: row.score,
    };
  }
}

/** 数据库行类型 */
interface MemoryRow {
  id: string;
  content: string;
  source: string;
  name: string;
  createdAt: string;
  accessedAt: string;
  score: number;
}
