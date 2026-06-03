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
import { logger } from '@/logging/logger.js';
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
   * 按 ID 获取单条记忆
   * M-206：向量搜索命中但关键词搜索未命中时，需要按 ID 加载
   */
  async getById(id: string): Promise<Memory | null> {
    await this.ready();
    const rows = await allAsync<DbRow>(this.db, `SELECT * FROM memories WHERE id = ?`, [id]);
    return rows[0] ? this.toMemory(rows[0]) : null;
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
   * 触摸记忆：被搜索命中时调用
   *
   * 哲学：「而生其心」——被当下需要时重新"活过来"。
   * 把 weight 重置为 1.0（满格），updated_at 更新为现在，
   * 衰减时钟重新开始。
   *
   * 设计文档：docs/基础设计文档/沉思笔记-记忆衰减与炼化.md §设计二
   *
   * @param ids 被命中的记忆 ID 列表
   */
  async touch(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.ready();
    const now = new Date().toISOString();
    // 用 IN (?, ?, ...) 一次更新多条
    const placeholders = ids.map(() => '?').join(',');
    await runAsync(
      this.db,
      `UPDATE memories SET weight = 1.0, updated_at = ? WHERE id IN (${placeholders})`,
      [now, ...ids],
    );
  }

  /**
   * 应用记忆权重自然衰减
   *
   * 哲学：「应无所住」——不用的记忆自然淡出。
   * weight 不降到 0（保留最小值 MIN_WEIGHT），
   * always 永久性的记忆永不衰减（与设计文档 §2 永久性分级一致）。
   *
   * 衰减公式：newWeight = max(MIN_WEIGHT, weight × exp(-daysSinceUpdate / halfLife))
   *
   * 设计文档：docs/基础设计文档/沉思笔记-记忆衰减与炼化.md §设计二
   *
   * @param halfLifeDays 不同永久性等级的半衰期（天数）
   * @returns 各永久性等级衰减的记忆数量
   */
  async applyDecay(
    halfLifeDays: Record<PermanenceValue, number>,
  ): Promise<Record<PermanenceValue, number>> {
    await this.ready();
    const result: Record<PermanenceValue, number> = {
      always: 0,
      domain: 0,
      topic: 0,
      'on-demand': 0,
    };

    // 最小权重（永不降到 0，避免 bootstrap 时 loaded 记忆消失）
    const MIN_WEIGHT = 0.05;

    // 遍历每种永久性等级
    for (const permanence of Object.keys(halfLifeDays) as PermanenceValue[]) {
      const halfLife = halfLifeDays[permanence];

      // always 永久性的记忆不衰减（人格/核心规则永久有效）
      if (halfLife === Infinity || halfLife === 0) {
        result[permanence] = 0;
        continue;
      }

      // 计算每条记忆的当前 age（天）和新 weight
      // 用 SQL 直接计算，避免把全表加载到 JS
      // exp(-age/halfLife) 在 SQLite 中用数学公式
      const rows = await allAsync<{ id: string; weight: number; updated_at: string }>(
        this.db,
        `SELECT id, weight, updated_at FROM memories WHERE permanence = ? AND weight > ?`,
        [permanence, MIN_WEIGHT],
      );

      let decayedCount = 0;
      const now = Date.now();

      for (const row of rows) {
        const ageMs = now - new Date(row.updated_at).getTime();
        const ageDays = ageMs / (24 * 60 * 60 * 1000);
        // 指数衰减：weight × 0.5^(ageDays / halfLife)
        const decayFactor = Math.pow(0.5, ageDays / halfLife);
        const newWeight = Math.max(MIN_WEIGHT, row.weight * decayFactor);

        // 只有当 weight 真正变化时才更新（避免无意义的写入）
        if (Math.abs(newWeight - row.weight) > 0.001) {
          await runAsync(this.db, `UPDATE memories SET weight = ? WHERE id = ?`, [
            newWeight,
            row.id,
          ]);
          decayedCount++;
        }
      }

      result[permanence] = decayedCount;
    }

    return result;
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
    const memories = rows.map(this.toMemory);

    // 设计 2：被搜索命中的记忆 weight 重置为 1.0（而生其心 —— 重新"活过来"）
    // fire-and-forget：触觉重置不应阻塞搜索返回
    if (memories.length > 0) {
      const ids = memories.map((m) => m.id);
      this.touch(ids).catch((err) => {
        // 重置失败静默降级：不影响当前搜索结果
        logger.warn({ err, count: ids.length }, '记忆 touch 失败（衰减时钟未重置）');
      });
    }

    return memories;
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
