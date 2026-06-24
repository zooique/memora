/**
 * SqliteRelationStore — IMemoryRelationStore 的 better-sqlite3 实现
 *
 * 宿主项目（精灵）持有 better-sqlite3 实例，实现 IMemoryRelationStore 接口后注入 Agent。
 * 所有方法均为同步（与 better-sqlite3 API 对齐）。
 *
 * 设计原则（ADR-014）：
 * - 侧车模型：独立于 memories 表，不侵入 Memory 7 字段基元
 * - 接口注入：依赖 ISqliteDatabase 接口（与 SqliteStorage 对齐），测试可用 node:sqlite 替身
 * - 三元组唯一约束：sourceId+targetId+type，重复添加用 UPSERT 更新 weight/createdAt
 *
 * 表结构：
 *   memory_relations(sourceId, targetId, type, weight, createdAt)
 *   UNIQUE(sourceId, targetId, type)
 *   索引：sourceId、targetId、type 各建索引（查询性能）
 */
import type { IMemoryRelationStore } from 'memora';
import type { MemoryRelation, RelationDirection } from 'memora';
import type { ISqliteDatabase } from './sqliteDatabaseTypes.js';

/** 建表 SQL */
const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS memory_relations (
  sourceId   TEXT NOT NULL,
  targetId   TEXT NOT NULL,
  type       TEXT NOT NULL,
  weight     REAL NOT NULL DEFAULT 0.5,
  createdAt  TEXT NOT NULL,
  PRIMARY KEY (sourceId, targetId, type)
);
`;

/** 创建索引 SQL（sourceId/targetId/type 各建索引，支持方向过滤和类型查询） */
const CREATE_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_relations_source ON memory_relations(sourceId);
CREATE INDEX IF NOT EXISTS idx_relations_target ON memory_relations(targetId);
CREATE INDEX IF NOT EXISTS idx_relations_type ON memory_relations(type);
`;

/** 行类型（SQLite 查询结果） */
interface RelationRow {
  sourceId: string;
  targetId: string;
  type: string;
  weight: number;
  createdAt: string;
}

/**
 * better-sqlite3 实现的 IMemoryRelationStore
 *
 * 与 SqliteStorage 对齐：
 * - 构造函数接收 ISqliteDatabase，建表+建索引
 * - 使用 @name 命名参数
 * - UPSERT 处理三元组唯一约束
 */
export class SqliteRelationStore implements IMemoryRelationStore {
  private db: ISqliteDatabase;

  constructor(db: ISqliteDatabase) {
    this.db = db;
    this.db.exec(CREATE_TABLE_SQL);
    this.db.exec(CREATE_INDEX_SQL);
  }

  /**
   * 添加关系（UPSERT 语义）
   *
   * 三元组唯一约束：sourceId+targetId+type 已存在时更新 weight/createdAt（幂等）。
   */
  addRelation(relation: MemoryRelation): void {
    this.db.prepare(`
      INSERT INTO memory_relations (sourceId, targetId, type, weight, createdAt)
      VALUES (@sourceId, @targetId, @type, @weight, @createdAt)
      ON CONFLICT(sourceId, targetId, type) DO UPDATE SET
        weight = @weight,
        createdAt = @createdAt
    `).run(relation);
  }

  /**
   * 查询某记忆的关系
   *
   * direction 控制方向过滤：
   * - 'outgoing'：sourceId = memoryId
   * - 'incoming'：targetId = memoryId
   * - 'both'：UNION 合并两个方向（自动去重，因 PRIMARY KEY 保证唯一）
   */
  getRelations(memoryId: string, direction: RelationDirection = 'both'): MemoryRelation[] {
    if (direction === 'outgoing') {
      const rows = this.db.prepare(
        'SELECT * FROM memory_relations WHERE sourceId = ?'
      ).all(memoryId) as RelationRow[];
      return rows.map((r) => this.rowToRelation(r));
    }
    if (direction === 'incoming') {
      const rows = this.db.prepare(
        'SELECT * FROM memory_relations WHERE targetId = ?'
      ).all(memoryId) as RelationRow[];
      return rows.map((r) => this.rowToRelation(r));
    }
    // 'both'：UNION 合并两个方向（PRIMARY KEY 保证无重复）
    const rows = this.db.prepare(`
      SELECT * FROM memory_relations WHERE sourceId = ?
      UNION
      SELECT * FROM memory_relations WHERE targetId = ?
    `).all(memoryId, memoryId) as RelationRow[];
    return rows.map((r) => this.rowToRelation(r));
  }

  /**
   * 按关系类型查询
   */
  getRelationsByType(type: string): MemoryRelation[] {
    const rows = this.db.prepare(
      'SELECT * FROM memory_relations WHERE type = ?'
    ).all(type) as RelationRow[];
    return rows.map((r) => this.rowToRelation(r));
  }

  /**
   * 获取全部关系
   */
  getAllRelations(): MemoryRelation[] {
    const rows = this.db.prepare('SELECT * FROM memory_relations').all() as RelationRow[];
    return rows.map((r) => this.rowToRelation(r));
  }

  /**
   * 删除指定关系
   *
   * sourceId+targetId+type 唯一定位，删除单条关系。
   */
  removeRelation(sourceId: string, targetId: string, type: string): void {
    this.db.prepare(
      'DELETE FROM memory_relations WHERE sourceId = ? AND targetId = ? AND type = ?'
    ).run(sourceId, targetId, type);
  }

  /**
   * 行对象转 MemoryRelation 类型（防御性拷贝）
   */
  private rowToRelation(row: RelationRow): MemoryRelation {
    return {
      sourceId: row.sourceId,
      targetId: row.targetId,
      type: row.type,
      weight: row.weight,
      createdAt: row.createdAt,
    };
  }
}
