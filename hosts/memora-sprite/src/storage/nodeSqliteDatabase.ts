/**
 * node:sqlite 适配器 — 零 native 依赖的 SQLite 实现
 *
 * 职责：
 * - 包装 Node.js 22+ 内置的 node:sqlite DatabaseSync
 * - 补齐 better-sqlite3 的 transaction() 方法（node:sqlite 无此方法）
 * - 实现 ISqliteDatabase 接口，供 SqliteStorage / SqliteSessionStore / SqliteRelationStore 注入
 *
 * 设计原则：
 * - 零 native 依赖：node:sqlite 随 Node.js 发布，无 ABI 问题
 * - 最小适配：node:sqlite 的 exec/prepare/run/get/all 与 better-sqlite3 兼容
 *   仅 transaction() 需手动实现（BEGIN/COMMIT/ROLLBACK）
 * - 命名参数兼容：node:sqlite 原生支持 @name 占位符，无需转换
 * - PRAGMA 统一走 exec('PRAGMA ...')：不实现 better-sqlite3 的 pragma() 简便方法，
 *   调用方统一用 exec，保持 ISqliteDatabase 接口最小化
 *
 * 背景：
 *   better-sqlite3 在 Electron 项目中需 electron-rebuild 编译为 Electron ABI，
 *   与 Node.js 运行时 ABI 不匹配（NODE_MODULE_VERSION 137 vs 143）。
 *   此适配器让 Web/CLI 模式用 node:sqlite（Node 内置），Electron 模式用 better-sqlite3（Electron ABI），
 *   各运行时各走各的路，互不干扰。
 *
 * 使用场景：
 *   - 测试环境：createMemoryDatabase() 创建 :memory: 实例
 *   - Web 开发模式（dev:web）：Node.js 运行时，避免 better-sqlite3 ABI 冲突
 *   - CLI 模式：Node.js 运行时（如未来扩展）
 *   Electron 生产模式仍使用 better-sqlite3（见 index.ts createStorage 运行时分支）
 *
 * 实验性说明：
 *   node:sqlite 在 Node 22+ 中标记为实验性，但 API 已基本稳定。
 *   Web/CLI 模式使用实验性 API 是可接受的（Electron 生产环境仍用 better-sqlite3）。
 */
import { DatabaseSync } from 'node:sqlite';
import type { ISqliteDatabase, ISqliteStatement } from './sqliteDatabaseTypes.js';

/**
 * node:sqlite 适配器，实现 ISqliteDatabase 接口
 *
 * 包装 DatabaseSync，补齐 transaction() 方法。
 * prepare() 返回的 Statement 天然兼容 ISqliteStatement（run/get/all 签名一致）。
 */
export class NodeSqliteDatabase implements ISqliteDatabase {
  /** 内部 DatabaseSync 实例 */
  private db: DatabaseSync;
  /** 关闭标记（幂等保护） */
  private _closed = false;

  /**
   * @param path 数据库文件路径，默认 ':memory:'（内存数据库，测试用）
   */
  constructor(path: string = ':memory:') {
    this.db = new DatabaseSync(path);
  }

  /** 执行多条 SQL 语句（建表、建索引、迁移、PRAGMA 等） */
  exec(sql: string): void {
    this.db.exec(sql);
  }

  /**
   * 预编译 SQL 语句
   *
   * node:sqlite 的 Statement 与 better-sqlite3 的 Statement API 兼容：
   *   - run(...params) / run(namedParamsObject) 返回 { changes: number }
   *   - get(...params) / get(namedParamsObject) 返回行对象或 undefined
   *   - all(...params) / all(namedParamsObject) 返回行对象数组
   *   - 支持 @name 命名占位符
   *
   * @returns 可复用的预编译语句
   */
  prepare(sql: string): ISqliteStatement {
    // DatabaseSync.prepare() 返回的 Statement 结构兼容 ISqliteStatement
    // 使用类型断言将 node:sqlite 的 Statement 类型映射到 ISqliteStatement 接口
    return this.db.prepare(sql) as unknown as ISqliteStatement;
  }

  /**
   * 创建事务包装器（手动 BEGIN/COMMIT/ROLLBACK）
   *
   * better-sqlite3 原生提供 transaction() 方法，node:sqlite 没有。
   * 此方法返回一个函数，调用时在事务中执行 fn：
   *   - fn 正常返回：COMMIT
   *   - fn 抛出异常：ROLLBACK 并重新抛出
   *
   * @param fn 事务体函数
   * @returns 可调用的事务函数
   */
  transaction<T>(fn: () => T): () => T {
    return () => {
      this.db.exec('BEGIN');
      try {
        const result = fn();
        this.db.exec('COMMIT');
        return result;
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    };
  }

  /** 关闭数据库连接（幂等：重复调用安全） */
  close(): void {
    if (this._closed) return;
    this.db.close();
    this._closed = true;
  }
}

/**
 * 创建内存数据库实例（测试辅助函数）
 *
 * @returns NodeSqliteDatabase 实例（:memory: 模式）
 */
export function createMemoryDatabase(): NodeSqliteDatabase {
  return new NodeSqliteDatabase(':memory:');
}
