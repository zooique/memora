/**
 * SQLite 索引
 *
 * 单一 memories 表 + memory_type 字段区分 5 种记忆
 * 详见 ADR-002 (新版) · 选用 sqlite3 (mapbox) 作为存储层
 * 详见 ADR-004 · 记忆统一为"类型 + 永久性标记"模型
 *
 * 借鉴 meta-stock ADR-002 + src/server/models/db.js 的封装模式
 */
import sqlite3, { type Database as SqliteDatabase } from 'sqlite3';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { Memory, MemoryTypeValue, PermanenceValue } from './types.js';

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
  }

  /**
   * 插入或更新记忆
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
   * 简单文本搜索（阶段一）
   * 阶段二上 FTS5
   */
  async search(query: string, limit = 10): Promise<Memory[]> {
    await this.ready();
    const pattern = `%${query}%`;
    const rows = await allAsync<DbRow>(
      this.db,
      `SELECT * FROM memories
       WHERE content LIKE ? OR name LIKE ? OR tags LIKE ?
       ORDER BY weight DESC
       LIMIT ?`,
      [pattern, pattern, pattern, limit],
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
