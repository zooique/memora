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
 * 重建 memories 表以补齐所有缺失列
 *
 * 旧版 schema 可能只有 id/content 等少量列，逐个 ALTER TABLE ADD COLUMN
 * 需要多轮迭代。直接建新表、拷数据、删旧表、重命名，可一次性对齐 schema。
 * 默认值：source='unknown'（来源不可考），score=0.5，createdAt/accessedAt 为当前时间。
 */
const REBUILD_TABLE_SQL = `
BEGIN TRANSACTION;
CREATE TABLE memories_new (
  id        TEXT PRIMARY KEY,
  content   TEXT NOT NULL,
  source    TEXT NOT NULL DEFAULT 'unknown',
  name      TEXT NOT NULL DEFAULT '',
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  accessedAt TEXT NOT NULL DEFAULT (datetime('now')),
  score     REAL NOT NULL DEFAULT 0.5
);
INSERT INTO memories_new (id, content)
  SELECT id, content FROM memories;
DROP TABLE memories;
ALTER TABLE memories_new RENAME TO memories;
COMMIT;
`;

/**
 * better-sqlite3 实现的 IMemoryStorage
 */
export class SqliteStorage implements IMemoryStorage {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.db.exec(CREATE_TABLE_SQL);
    this.migrateColumns();
    this.db.exec(CREATE_INDEX_SQL);
  }

  /**
   * 迁移：为旧版 memories 表补齐缺失列
   *
   * 通过 PRAGMA table_info 检测列是否存在，若核心列缺失则重建表一次性对齐 schema。
   * 旧数据仅保留 id/content，其余字段使用默认值填充。
   *
   * @private
   */
  private migrateColumns(): void {
    const tableInfo = this.db.prepare("PRAGMA table_info(memories)").all() as Array<{
      name: string;
    }>;
    const requiredColumns = ['source', 'name', 'createdAt', 'accessedAt', 'score'];
    const existingColumns = new Set(tableInfo.map((column) => column.name));
    const missingColumns = requiredColumns.filter((column) => !existingColumns.has(column));

    if (missingColumns.length === 0) {
      return;
    }

    logger.warn(
      { missingColumns },
      '[SqliteStorage] memories 表 schema 过期，执行一次性迁移'
    );
    this.db.exec(REBUILD_TABLE_SQL);
  }

  /**
   * 插入或更新记忆（IMemoryStorage 接口实现）
   *
   * 写入前校验 source 合法性，被阻止的 source 抛出异常。
   *
   * @param memory 记忆对象（含 id/content/source/name/createdAt/accessedAt/score）
   */
  upsert(memory: Memory): void {
    const result = validateSource(memory.source);
    if (result.severity === 'block') {
      throw new Error(`source 校验失败（拒绝写入）：${result.warning}`);
    }
    if (result.severity === 'warn' && result.warning) {
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

  /**
   * 删除记忆（IMemoryStorage 接口实现）
   *
   * @param id 记忆唯一标识
   */
  delete(id: string): void {
    this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
  }

  /**
   * 按 ID 获取单条记忆（IMemoryStorage 接口实现）
   *
   * @param id 记忆唯一标识
   * @returns 记忆对象，不存在时返回 null
   */
  getById(id: string): Memory | null {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined;
    return row ? this.rowToMemory(row) : null;
  }

  /**
   * 按 source 获取记忆列表（IMemoryStorage 接口实现）
   *
   * @param source 记忆来源标识
   * @returns 按权重降序排列的记忆列表
   */
  getBySource(source: string): Memory[] {
    const rows = this.db.prepare(
      'SELECT * FROM memories WHERE source = ? ORDER BY score DESC'
    ).all(source) as MemoryRow[];
    return rows.map(r => this.rowToMemory(r));
  }

  /**
   * 关键词搜索记忆（IMemoryStorage 接口实现）
   *
   * 使用 LIKE 关键词匹配，与 InMemoryStorage 行为一致。
   * 空查询返回按权重降序的全部记忆。
   *
   * @param query 搜索关键词
   * @param limit 返回数量上限，默认 10
   * @returns 匹配的记忆列表
   */
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

  /**
   * 记忆总数（IMemoryStorage 接口实现）
   *
   * @returns 数据库中记忆总数
   */
  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM memories').get() as { cnt: number };
    return row.cnt;
  }

  /**
   * 按 source 统计记忆数（IMemoryStorage 接口实现）
   *
   * @param source 记忆来源标识
   * @returns 该 source 下的记忆总数
   */
  countBySource(source: string): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM memories WHERE source = ?').get(source) as { cnt: number };
    return row.cnt;
  }

  /**
   * 记忆衰减（IMemoryStorage 接口实现）
   *
   * 衰减公式与 InMemoryStorage 对齐：
   * daysSinceAccess > 7 时，score -= 0.02 * floor(daysSinceAccess / 7)，下限 0.1。
   *
   * @param sources 需要衰减的 source 列表
   * @param now 当前时间（用于计算 daysSinceAccess）
   * @returns 受影响的行数
   */
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

  /**
   * 关闭数据库连接（IMemoryStorage 接口实现）
   */
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
