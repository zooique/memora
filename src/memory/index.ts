/**
 * SQLite 存储实现 — IMemoryStorage 的 better-sqlite3 具体实现
 *
 * 单一 memories 表 + memory_type 字段区分 5 种记忆
 * 详见 ADR-002（v0.3）· 存储层抽象：IMemoryStorage 接口 + 可插拔实现
 * 详见 ADR-004 · 记忆统一为"类型 + 永久性标记"模型
 *
 * better-sqlite3 优势（vs mapbox/sqlite3）：
 * - 同步 API：无回调/Promise 包装，代码更简洁
 * - 预编译语句缓存：prepare() 自动缓存，重复查询更快
 * - 原生性能：Node.js 社区公认最快的 SQLite 驱动
 *
 * 设计文档参考：
 * - 03-安全权限-v0.2.md（MemoraError 错误处理模式）
 * - 00-记忆归档原则-v1.0.md（记忆权重体系）
 * - 05-沉思-记忆衰减与炼化.md（衰减模型）
 *
 * 注意：此类仅用于 CLI 独立运行和测试环境。
 * 宿主项目（如泊文 Electron）应自行实现 IMemoryStorage 接口，
 * 持有自己的 better-sqlite3 实例，注入 Agent。
 */
import Database, { type Database as SqliteDatabase } from 'better-sqlite3';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { logger } from '@/logging/logger.js';
import type { Memory, MemoryTypeValue, PermanenceValue } from './types.js';
import { isValidMemoryType, isValidPermanence, MemoryType, Permanence } from './types.js';
import { segmentText } from './segmenter.js';
import type { IMemoryStorage } from './storage-interface.js';

/**
 * 行数据接口（SQLite 磁盘格式）
 */
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

/**
 * SQLite 存储实现
 *
 * 实现 IMemoryStorage 接口，使用 better-sqlite3 作为底层存储。
 * 仅在 CLI 独立运行和测试环境中使用。
 * 宿主项目应自行实现 IMemoryStorage 接口并注入 Agent。
 */
export class SqliteStorage implements IMemoryStorage {
  /** better-sqlite3 数据库实例（同步，构造即就绪） */
  private db: SqliteDatabase;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    // 同步打开（better-sqlite3 构造即就绪，无需 initPromise）
    this.db = new Database(dbPath);
    // WAL 模式 + 表结构初始化（同步）
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
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
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_permanence ON memories(permanence);`);
  }

  /**
   * 插入或更新记忆
   *
   * M-201：当前使用应用层 LIKE 搜索（详见 search() 方法）。
   * 阶段二可考虑 FTS5 + 自定义 tokenizer（better-sqlite3 支持注册自定义函数）。
   */
  upsert(memory: Memory): void {
    // 防御性校验 type 字段
    if (!isValidMemoryType(memory.type)) {
      throw new Error(
        `非法的 memory.type："${memory.type}"，合法值：${Object.values(MemoryType).join(', ')}`,
      );
    }
    // 防御性校验 permanence 字段
    if (!isValidPermanence(memory.permanence)) {
      throw new Error(
        `非法的 memory.permanence："${memory.permanence}"，合法值：${Object.values(Permanence).join(', ')}`,
      );
    }
    this.db
      .prepare(
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
      )
      .run(
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
      );
  }

  /**
   * 删除记忆
   */
  delete(id: string): void {
    this.db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);
  }

  /**
   * 按永久性等级获取所有必召记忆
   * 启动时加载 always + domain
   */
  getByPermanence(permanence: PermanenceValue): Memory[] {
    const rows = this.db
      .prepare(`SELECT * FROM memories WHERE permanence = ? ORDER BY weight DESC`)
      .all(permanence) as DbRow[];
    return rows.map(this.toMemory);
  }

  /**
   * 按 ID 获取单条记忆
   * M-206：向量搜索命中但关键词搜索未命中时，需要按 ID 加载
   */
  getById(id: string): Memory | null {
    const row = this.db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id) as DbRow | undefined;
    return row ? this.toMemory(row) : null;
  }

  /**
   * 按类型获取记忆
   */
  getByType(type: MemoryTypeValue): Memory[] {
    const rows = this.db
      .prepare(`SELECT * FROM memories WHERE type = ? ORDER BY weight DESC`)
      .all(type) as DbRow[];
    return rows.map(this.toMemory);
  }

  /**
   * 触摸记忆：被搜索命中时调用
   *
   * 哲学：「而生其心」——被当下需要时重新"活过来"。
   * 把 weight 重置为 1.0（满格），updated_at 更新为现在，
   * 衰减时钟重新开始。
   *
   * 设计文档：docs/基础设计文档/05-沉思-记忆衰减与炼化.md §设计二
   */
  touch(ids: string[]): void {
    if (ids.length === 0) return;
    const now = new Date().toISOString();
    // better-sqlite3 支持变长参数展开
    this.db
      .prepare(
        `UPDATE memories SET weight = 1.0, updated_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`,
      )
      .run(now, ...ids);
  }

  /**
   * 应用记忆权重自然衰减
   *
   * 哲学：「应无所住」——不用的记忆自然淡出。
   * weight 不降到 0（保留最小值 MIN_WEIGHT）。
   * always 永久性的记忆永不衰减。
   *
   * 衰减公式：newWeight = max(MIN_WEIGHT, weight × 0.5^(ageDays / halfLife))
   *
   * 设计文档：docs/基础设计文档/05-沉思-记忆衰减与炼化.md §设计二
   *
   * @param halfLifeDays 不同永久性等级的半衰期（天数）
   * @returns 各永久性等级衰减的记忆数量
   */
  applyDecay(halfLifeDays: Record<PermanenceValue, number>): Record<PermanenceValue, number> {
    const result: Record<PermanenceValue, number> = {
      always: 0,
      domain: 0,
      topic: 0,
      'on-demand': 0,
    };

    const MIN_WEIGHT = 0.05;
    const selectStmt = this.db.prepare(
      `SELECT id, weight, updated_at FROM memories WHERE permanence = ? AND weight > ?`,
    );
    const updateStmt = this.db.prepare(`UPDATE memories SET weight = ? WHERE id = ?`);

    for (const permanence of Object.keys(halfLifeDays) as PermanenceValue[]) {
      const halfLife = halfLifeDays[permanence];

      // always 永久性的记忆不衰减
      if (halfLife === Infinity || halfLife === 0) {
        result[permanence] = 0;
        continue;
      }

      const rows = selectStmt.all(permanence, MIN_WEIGHT) as Array<{
        id: string;
        weight: number;
        updated_at: string;
      }>;

      let decayedCount = 0;
      const now = Date.now();

      for (const row of rows) {
        const ageMs = now - new Date(row.updated_at).getTime();
        const ageDays = ageMs / (24 * 60 * 60 * 1000);
        const decayFactor = Math.pow(0.5, ageDays / halfLife);
        const newWeight = Math.max(MIN_WEIGHT, row.weight * decayFactor);

        if (Math.abs(newWeight - row.weight) > 0.001) {
          updateStmt.run(newWeight, row.id);
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
   * 1. Intl.Segmenter 切词
   * 2. 每个 token 构造 LIKE 模式（content / name / tags）
   * 3. match 模式 OR 连接，near 模式 AND 连接
   * 4. weight DESC 排序
   */
  search(query: string, limit = 10, mode: 'match' | 'near' = 'match'): Memory[] {
    const tokens = segmentText(query);
    if (tokens.length === 0) {
      return this.getByWeight(limit);
    }

    const tokenPatterns: string[] = tokens.map((t) => `%${t}%`);

    let sql: string;
    let params: unknown[];

    if (mode === 'near') {
      const andClauses = tokenPatterns
        .map(() => '(content LIKE ? OR name LIKE ? OR tags LIKE ?)')
        .join(' AND ');
      sql = `SELECT * FROM memories WHERE ${andClauses} ORDER BY weight DESC LIMIT ?`;
      params = tokenPatterns.flatMap((p) => [p, p, p]).concat(String(limit));
    } else {
      const orClauses = tokenPatterns
        .map(() => '(content LIKE ? OR name LIKE ? OR tags LIKE ?)')
        .join(' OR ');
      sql = `SELECT * FROM memories WHERE ${orClauses} ORDER BY weight DESC LIMIT ?`;
      params = tokenPatterns.flatMap((p) => [p, p, p]).concat(String(limit));
    }

    const rows = this.db.prepare(sql).all(...params) as DbRow[];
    const memories = rows.map(this.toMemory);

    // 被搜索命中的记忆 weight 重置为 1.0（而生其心 —— 重新"活过来"）
    // fire-and-forget：触觉重置不应阻塞搜索返回
    if (memories.length > 0) {
      const ids = memories.map((m) => m.id);
      // 使用 setImmediate 避免同步阻塞搜索返回
      setImmediate(() => {
        try {
          this.touch(ids);
        } catch (err) {
          logger.warn({ err, count: ids.length }, '记忆 touch 失败（衰减时钟未重置）');
        }
      });
    }

    return memories;
  }

  /**
   * 按 weight 降序获取（search() 空查询的兜底）
   */
  private getByWeight(limit: number): Memory[] {
    const rows = this.db
      .prepare(`SELECT * FROM memories ORDER BY weight DESC LIMIT ?`)
      .all(String(limit)) as DbRow[];
    return rows.map(this.toMemory);
  }

  /**
   * 关闭数据库连接
   */
  close(): void {
    this.db.close();
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
