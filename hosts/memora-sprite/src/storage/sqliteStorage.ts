/**
 * SqliteStorage — IMemoryStorage 的 better-sqlite3 实现
 *
 * 宿主项目（精灵）持有 better-sqlite3 实例，实现 IMemoryStorage 接口后注入 Agent。
 * 所有方法均为同步（与 better-sqlite3 API 对齐）。
 *
 * 阶段一：search() 使用 LIKE 关键词匹配（与 InMemoryStorage 行为一致）
 * 阶段二：可选升级 FTS5 全文搜索
 */
import type { IMemoryStorage } from 'memora';
import type { Memory } from 'memora';
import { segmentText, validateSource, logger } from 'memora';
import type { ISqliteDatabase } from './sqliteDatabaseTypes.js';
// P0-B：结构化错误抛出（替代裸 throw new Error，让 ErrorHandler 正确分类）
import { MemoraError, ErrorCode } from '../sprite/errors.js';

/** 建表 SQL（GAP-6：新增 deleted_at 列支持软删除） */
const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS memories (
  id         TEXT PRIMARY KEY,
  content    TEXT NOT NULL,
  source     TEXT NOT NULL,
  name       TEXT NOT NULL,
  createdAt  TEXT NOT NULL,
  accessedAt TEXT NOT NULL,
  score      REAL NOT NULL DEFAULT 0.5,
  deleted_at TEXT
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
 * GAP-6：新增 deleted_at 列（默认 NULL，表示活跃记忆）。
 */
const REBUILD_TABLE_SQL = `
BEGIN TRANSACTION;
CREATE TABLE memories_new (
  id         TEXT PRIMARY KEY,
  content    TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT 'unknown',
  name       TEXT NOT NULL DEFAULT '',
  -- P2-ISO-01 使用 strftime 产出 ISO 8601 格式，与 Memory schema 的 z.string().datetime() 对齐
  -- datetime('now') 产出 'YYYY-MM-DD HH:MM:SS'（非 ISO 8601），会导致时区解析偏差
  createdAt  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  accessedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  score      REAL NOT NULL DEFAULT 0.5,
  deleted_at TEXT
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
  private db: ISqliteDatabase;
  /** QC-STORE-01：close 幂等保护标志，避免重复关闭抛异常 */
  private closed = false;

  constructor(db: ISqliteDatabase) {
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
   * GAP-6：若仅缺失 deleted_at 列，使用轻量 ALTER TABLE ADD COLUMN 避免全表重建。
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

    if (missingColumns.length > 0) {
      logger.warn(
        { missingColumns },
        '[SqliteStorage] memories 表 schema 过期，执行一次性迁移'
      );
      this.db.exec(REBUILD_TABLE_SQL);
      return;
    }

    // GAP-6：若核心列齐全但缺失 deleted_at，轻量 ALTER TABLE 补齐
    if (!existingColumns.has('deleted_at')) {
      logger.warn('[SqliteStorage] 补齐 deleted_at 列（GAP-6 软删除支持）');
      this.db.exec('ALTER TABLE memories ADD COLUMN deleted_at TEXT');
    }
  }

  /**
   * 插入或更新记忆（IMemoryStorage 接口实现，GAP-6：含 deletedAt 字段）
   *
   * 写入前校验 source 合法性，被阻止的 source 抛出异常。
   * deletedAt 为 undefined 时写入 NULL（活跃态），为 ISO 8601 字符串时写入对应值（软删除态）。
   *
   * @param memory 记忆对象（含 id/content/source/name/createdAt/accessedAt/score/deletedAt?）
   */
  upsert(memory: Memory): void {
    const result = validateSource(memory.source);
    if (result.severity === 'block') {
      throw new MemoraError(ErrorCode.VALIDATION_ERROR, `source 校验失败（拒绝写入）：${result.warning}`);
    }
    if (result.severity === 'warn' && result.warning) {
      logger.warn({ id: memory.id, source: memory.source, warning: result.warning }, 'source 校验警告');
    }

    this.db.prepare(`
      INSERT INTO memories (id, content, source, name, createdAt, accessedAt, score, deleted_at)
      VALUES (@id, @content, @source, @name, @createdAt, @accessedAt, @score, @deletedAt)
      ON CONFLICT(id) DO UPDATE SET
        content = @content,
        source = @source,
        name = @name,
        createdAt = @createdAt,
        accessedAt = @accessedAt,
        score = @score,
        deleted_at = @deletedAt
    `).run({ ...memory, deletedAt: memory.deletedAt ?? null });
  }

  /**
   * 软删除记忆（GAP-6：UPDATE deleted_at，不物理删除）
   *
   * 对已软删除或不存在记忆为 no-op。
   *
   * @param id 记忆唯一标识
   */
  delete(id: string): void {
    // 仅对活跃记忆执行软删除（deleted_at IS NULL 才更新），避免重复写入
    this.db.prepare(
      `UPDATE memories SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`
    ).run(new Date().toISOString(), id);
  }

  /**
   * 恢复软删除的记忆（GAP-6：清除 deleted_at）
   *
   * 对活跃记忆或不存在记忆为 no-op。
   *
   * @param id 记忆唯一标识
   */
  restore(id: string): void {
    // 仅对软删除记忆执行恢复（deleted_at IS NOT NULL 才更新）
    this.db.prepare(
      `UPDATE memories SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL`
    ).run(id);
  }

  /**
   * 物理删除记忆（GAP-6：DELETE FROM，不可恢复）
   *
   * 用于回收站的"彻底删除"操作，或测试环境的强制清理。
   *
   * @param id 记忆唯一标识
   */
  purge(id: string): void {
    this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
  }

  /**
   * 列出回收站中的软删除记忆（GAP-6）
   *
   * 按 deleted_at 降序排列（最近删除的在前），便于回收站 UI 展示。
   *
   * @param limit 返回数量上限，默认 50
   * @returns 软删除记忆列表
   */
  listDeleted(limit = 50): Memory[] {
    const rows = this.db.prepare(
      'SELECT * FROM memories WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT ?'
    ).all(limit) as MemoryRow[];
    return rows.map(r => this.rowToMemory(r));
  }

  /**
   * 清理过期的软删除记忆（GAP-6）
   *
   * 物理删除所有 deleted_at 早于 before 的记忆。
   *
   * @param before 时间阈值，deleted_at 早于此值的记忆将被物理删除
   * @returns 被清理的记忆数量
   */
  purgeExpired(before: Date): number {
    const result = this.db.prepare(
      'DELETE FROM memories WHERE deleted_at IS NOT NULL AND deleted_at < ?'
    ).run(before.toISOString());
    return result.changes;
  }

  /**
   * 按 ID 获取单条活跃记忆（GAP-6：已软删除的返回 null）
   *
   * @param id 记忆唯一标识
   * @returns 记忆对象，不存在或已软删除时返回 null
   */
  getById(id: string): Memory | null {
    const row = this.db.prepare(
      'SELECT * FROM memories WHERE id = ? AND deleted_at IS NULL'
    ).get(id) as MemoryRow | undefined;
    return row ? this.rowToMemory(row) : null;
  }

  /**
   * 按 source 获取活跃记忆列表（GAP-6：过滤已软删除的）
   *
   * @param source 记忆来源标识
   * @returns 按权重降序排列的活跃记忆列表
   */
  getBySource(source: string): Memory[] {
    const rows = this.db.prepare(
      'SELECT * FROM memories WHERE source = ? AND deleted_at IS NULL ORDER BY score DESC'
    ).all(source) as MemoryRow[];
    return rows.map(r => this.rowToMemory(r));
  }

  /**
   * 关键词搜索活跃记忆（GAP-6：过滤已软删除的）
   *
   * 使用 LIKE 关键词匹配，与 InMemoryStorage 行为一致。
   * 空查询返回按权重降序的全部活跃记忆。
   *
   * @param query 搜索关键词
   * @param limit 返回数量上限，默认 10
   * @returns 匹配的活跃记忆列表
   */
  search(query: string, limit = 10): Memory[] {
    // 空查询：按 score 降序返回活跃记忆
    if (!query.trim()) {
      const rows = this.db.prepare(
        'SELECT * FROM memories WHERE deleted_at IS NULL ORDER BY score DESC LIMIT ?'
      ).all(limit) as MemoryRow[];
      return rows.map(r => this.rowToMemory(r));
    }

    // 规范分词（与 InMemoryStorage 行为一致）
    const tokens = segmentText(query).map((t: string) => t.toLowerCase());

    // 若分词后无有效 token，降级为按 score 返回
    if (tokens.length === 0) {
      const rows = this.db.prepare(
        'SELECT * FROM memories WHERE deleted_at IS NULL ORDER BY score DESC LIMIT ?'
      ).all(limit) as MemoryRow[];
      return rows.map(r => this.rowToMemory(r));
    }

    // LIKE 关键词匹配：任一 token 命中即可（GAP-6：附加 deleted_at IS NULL 过滤）
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
    const sql = `SELECT * FROM memories WHERE deleted_at IS NULL AND (${whereClause}) ORDER BY score DESC LIMIT ?`;
    params.push(String(limit));

    const rows = this.db.prepare(sql).all(...params) as MemoryRow[];
    return rows.map(r => this.rowToMemory(r));
  }

  /**
   * 活跃记忆总数（GAP-6：不含已软删除的）
   *
   * @returns 数据库中活跃记忆总数
   */
  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM memories WHERE deleted_at IS NULL').get() as { cnt: number };
    return row.cnt;
  }

  /**
   * 按 source 统计活跃记忆数（GAP-6：不含已软删除的）
   *
   * @param source 记忆来源标识
   * @returns 该 source 下的活跃记忆总数
   */
  countBySource(source: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM memories WHERE source = ? AND deleted_at IS NULL'
    ).get(source) as { cnt: number };
    return row.cnt;
  }

  /**
   * 衰减活跃记忆 score（GAP-6：跳过已软删除的）
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
    // GAP-6：附加 deleted_at IS NULL 过滤，跳过软删除记忆
    const sql = `
      UPDATE memories
      SET score = MAX(0.1, score - 0.02 * CAST((julianday(?) - julianday(accessedAt)) / 7 AS INTEGER))
      WHERE source IN (${placeholders})
        AND deleted_at IS NULL
        AND (julianday(?) - julianday(accessedAt)) > 7
    `;
    const params = [now.toISOString(), ...sources, now.toISOString()];
    const result = this.db.prepare(sql).run(...params);
    return result.changes;
  }

  /**
   * 获取所有 source 标签及其活跃记忆数量（GAP-6：不含已软删除的）
   *
   * P2-2 优化：使用 SQL GROUP BY 一次查询获取所有 source 分布，
   * 替代 stats()/sourceHealth() 中的多次 countBySource + 全量 search。
   *
   * @returns source 标签到数量的映射
   */
  getAllSources(): Map<string, number> {
    const rows = this.db.prepare(
      'SELECT source, COUNT(*) as cnt FROM memories WHERE deleted_at IS NULL GROUP BY source'
    ).all() as Array<{ source: string; cnt: number }>;
    const result = new Map<string, number>();
    for (const row of rows) {
      result.set(row.source, row.cnt);
    }
    return result;
  }

  /**
   * 关闭数据库连接（IMemoryStorage 接口实现）
   *
   * QC-STORE-01 修复：添加 closed 标志实现幂等保护。
   * 重复调用 close（如 agent.close() + app.before-quit 竞态）时跳过，
   * 避免 better-sqlite3 的 "database is not open" 异常。
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
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
      // GAP-6：deleted_at 为 NULL 时映射为 undefined（活跃态），非 NULL 时为 ISO 8601 字符串（软删除态）
      deletedAt: row.deleted_at ?? undefined,
    };
  }
}

/** 数据库行类型（GAP-6：含 deleted_at 列） */
interface MemoryRow {
  id: string;
  content: string;
  source: string;
  name: string;
  createdAt: string;
  accessedAt: string;
  score: number;
  /** 软删除时间戳（NULL=活跃，非 NULL=已软删除） */
  deleted_at: string | null;
}
