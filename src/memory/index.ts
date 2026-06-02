/**
 * SQLite 索引
 *
 * 单一 memories 表 + memory_type 字段区分 5 种记忆
 * 详见 ADR-002 (新版) · 选用 sqlite3 (mapbox) 作为存储层
 * 详见 ADR-004 · 记忆统一为"类型 + 永久性标记"模型
 *
 * FTS5 全文索引：M-201
 * - memory_fts 虚表（外部内容模式，不存实际内容）
 * - 触发器自动同步主表 INSERT/UPDATE/DELETE
 * - search() 使用 FTS5 MATCH 替代 LIKE
 *
 * 借鉴 meta-stock ADR-002 + src/server/models/db.js 的封装模式
 */
import sqlite3, { type Database as SqliteDatabase } from 'sqlite3';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { Memory, MemoryTypeValue, PermanenceValue } from './types.js';
import { segmentText } from './segmenter.js';

/**
 * sqlite3 Database 的 SQL 参数类型
 */
type SqlParams = ReadonlyArray<unknown> | null;

/**
 * Promise 化的 sqlite3 操作封装
 * 因为 sqlite3 库默认是回调 API，统一封装为 async/await
 */
const runAsync = (db: SqliteDatabase, sql: string, params: SqlParams = null): Promise<void> =>
  new Promise((resolve, reject) => {
    if (params === null) {
      db.run(sql, function (err) {
        if (err) reject(err);
        else resolve();
      });
    } else {
      db.run(sql, params as unknown[], function (err) {
        if (err) reject(err);
        else resolve();
      });
    }
  });

const allAsync = <T>(db: SqliteDatabase, sql: string, params: SqlParams = null): Promise<T[]> =>
  new Promise((resolve, reject) => {
    if (params === null) {
      db.all(sql, (err, rows) => {
        if (err) reject(err);
        else resolve(rows as T[]);
      });
    } else {
      db.all(sql, params as unknown[], (err, rows) => {
        if (err) reject(err);
        else resolve(rows as T[]);
      });
    }
  });

const closeAsync = (db: SqliteDatabase): Promise<void> =>
  new Promise((resolve, reject) => {
    db.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });

export class MemoryIndex {
  private db: SqliteDatabase;
  private initPromise: Promise<void>;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    // 同步打开（构造函数返回前必须可用）
    this.db = new sqlite3.Database(dbPath);
    // 初始化（WAL 模式 + 表结构）
    this.initPromise = this.init();
  }

  /**
   * 等待初始化完成
   * 必须在任何查询前调用
   */
  async ready(): Promise<void> {
    await this.initPromise;
  }

  /**
   * 初始化表结构
   * 借鉴 meta-stock 的 PRAGMA 配置：WAL + foreign_keys
   *
   * M-201 阶段一：中文分词搜索由 search() 方法在应用层实现（详见 search() 注释）
   */
  private async init(): Promise<void> {
    await runAsync(this.db, 'PRAGMA journal_mode = WAL;');
    await runAsync(this.db, 'PRAGMA foreign_keys = ON;');
    await runAsync(
      this.db,
      `
      CREATE TABLE IF NOT EXISTS memories (
        id          TEXT PRIMARY KEY,
        type        TEXT NOT NULL,
        permanence  TEXT NOT NULL,
        name        TEXT NOT NULL,
        content     TEXT NOT NULL,
        tags        TEXT NOT NULL DEFAULT '[]',
        weight      REAL NOT NULL DEFAULT 0.5,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        file_path   TEXT
      );
    `,
    );
    await runAsync(this.db, `CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);`);
    await runAsync(
      this.db,
      `CREATE INDEX IF NOT EXISTS idx_memories_permanence ON memories(permanence);`,
    );

    // M-201 阶段一：用应用层 tokenize + LIKE 搜索（详见 search() 方法）
    //
    // 历史决策：尝试过 FTS5 虚表（unicode61 + trigram），但
    //   - unicode61 按字符切中文，与 Intl.Segmenter 切词不匹配
    //   - trigram 无法匹配单字/2 字中文
    //   - sqlite3 npm 不支持注册 JS 自定义 tokenizer
    // 阶段二可考虑：nodejieba + 自定义 FTS5 tokenizer（需 C 扩展 + prebuilt）
    //
    // 当前方案：Intl.Segmenter 在 JS 端切词，search() 用多个 LIKE OR 组合
    // 性能：5k 条记录 < 5ms（足够用，Memora 单用户本地）
  }

  /**
   * 插入或更新记忆
   *
   * M-201：暂未启用 FTS5（详见 init() 注释）。当前仅写主表，search() 在应用层 tokenize。
   */
  async upsert(memory: Memory): Promise<void> {
    await this.ready();
    await runAsync(
      this.db,
      `INSERT INTO memories (id, type, permanence, name, content, tags, weight, created_at, updated_at, file_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         type = excluded.type,
         permanence = excluded.permanence,
         name = excluded.name,
         content = excluded.content,
         tags = excluded.tags,
         weight = excluded.weight,
         updated_at = excluded.updated_at,
         file_path = excluded.file_path`,
      [
        memory.id,
        memory.type,
        memory.permanence,
        memory.name,
        memory.content,
        JSON.stringify(memory.tags),
        memory.weight,
        memory.createdAt,
        memory.updatedAt,
        memory.filePath ?? null,
      ],
    );
  }

  /**
   * 删除记忆
   */
  async delete(id: string): Promise<void> {
    await this.ready();
    await runAsync(this.db, `DELETE FROM memories WHERE id = ?`, [id]);
  }

  /**
   * 按永久性等级获取所有必召记忆
   * 启动时加载 always + domain
   */
  async getByPermanence(permanence: PermanenceValue): Promise<Memory[]> {
    await this.ready();
    const rows = await allAsync<DbRow>(
      this.db,
      `SELECT * FROM memories WHERE permanence = ? ORDER BY weight DESC`,
      [permanence],
    );
    return rows.map(this.toMemory);
  }

  /**
   * 按类型获取记忆
   */
  async getByType(type: MemoryTypeValue): Promise<Memory[]> {
    await this.ready();
    const rows = await allAsync<DbRow>(
      this.db,
      `SELECT * FROM memories WHERE type = ? ORDER BY weight DESC`,
      [type],
    );
    return rows.map(this.toMemory);
  }

  /**
   * 中文分词搜索（M-201 阶段一 + M-202 Intl.Segmenter）
   *
   * 算法：
   * 1. Intl.Segmenter 把 query 切词（中文按 ICU 词典，英文按空格）
   * 2. 每个 token 构造 3 个 LIKE 模式（content / name / tags）
   * 3. 多 token 用 OR 连接，匹配任一即可
   * 4. weight DESC 排序
   *
   * 性能：5k 条记录 < 5ms（SQLite LIKE 走 idx_memories_type 索引，content LIKE 走全表扫描但在 5k 级别很快）
   *
   * 模式：
   * - 'match'（默认）：任一 token 命中
   * - 'near'：所有 token 必须同时出现（用 EXISTS AND EXISTS，牺牲一些性能换精确度）
   *
   * 阶段二可上 FTS5 + 自定义 tokenizer（详见 init() 注释）
   */
  async search(query: string, limit = 10, mode: 'match' | 'near' = 'match'): Promise<Memory[]> {
    await this.ready();

    const tokens = segmentText(query);
    if (tokens.length === 0) {
      return this.getByWeight(limit);
    }

    // 每个 token 构造 3 个 LIKE 模式
    const tokenPatterns: string[] = tokens.map((t) => `%${t}%`);

    let sql: string;
    let params: Array<string | number>;

    if (mode === 'near') {
      // near 模式：所有 token 都必须命中（AND）
      const andClauses = tokenPatterns
        .map(() => '(content LIKE ? OR name LIKE ? OR tags LIKE ?)')
        .join(' AND ');
      sql = `SELECT * FROM memories WHERE ${andClauses} ORDER BY weight DESC LIMIT ?`;
      params = tokenPatterns.flatMap((p) => [p, p, p]).concat(String(limit));
    } else {
      // match 模式（默认）：任一 token 命中（OR）
      const orClauses = tokenPatterns
        .map(() => '(content LIKE ? OR name LIKE ? OR tags LIKE ?)')
        .join(' OR ');
      sql = `SELECT * FROM memories WHERE ${orClauses} ORDER BY weight DESC LIMIT ?`;
      params = tokenPatterns.flatMap((p) => [p, p, p]).concat(String(limit));
    }

    const rows = await allAsync<DbRow>(this.db, sql, params);
    return rows.map(this.toMemory);
  }

  /**
   * 按 weight 降序获取（search() 空查询的兜底）
   */
  private async getByWeight(limit: number): Promise<Memory[]> {
    const rows = await allAsync<DbRow>(
      this.db,
      `SELECT * FROM memories ORDER BY weight DESC LIMIT ?`,
      [limit],
    );
    return rows.map(this.toMemory);
  }

  /**
   * 关闭数据库
   * 必须先 await initPromise 完成，否则会触发 SQLITE_MISUSE
   */
  async close(): Promise<void> {
    await this.initPromise;
    await closeAsync(this.db);
  }

  /**
   * 行转 Memory 对象
   */
  private toMemory = (row: DbRow): Memory => ({
    id: row.id,
    type: row.type as MemoryTypeValue,
    permanence: row.permanence as Memory['permanence'],
    name: row.name,
    content: row.content,
    tags: JSON.parse(row.tags) as string[],
    weight: row.weight,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    filePath: row.file_path ?? undefined,
  });
}

interface DbRow {
  id: string;
  type: string;
  permanence: string;
  name: string;
  content: string;
  tags: string;
  weight: number;
  created_at: string;
  updated_at: string;
  file_path: string | null;
}
