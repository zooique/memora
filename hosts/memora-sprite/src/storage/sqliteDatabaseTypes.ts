/**
 * SQLite 数据库抽象接口 — 解耦存储实现与 better-sqlite3 具体类型
 *
 * 职责：
 * - 定义 SqliteStorage / SqliteSessionStore 依赖的最小 SQLite API 表面
 * - 生产环境注入 better-sqlite3 的 Database 实例（结构兼容）
 * - 测试环境注入 node:sqlite 的适配器实例（零 native 依赖）
 *
 * 设计原则：
 * - 依赖倒置：存储类依赖接口而非具体实现（ADR-002 零 native 依赖内核）
 * - 最小接口：仅包含存储类实际使用的方法，不暴露多余 API
 * - 结构兼容：better-sqlite3 的 Database 天然满足此接口，无需适配
 *
 * 背景：
 *   原 SqliteStorage / SqliteSessionStore 构造函数参数类型为 `Database.Database`
 *   （来自 @types/better-sqlite3），导致测试必须加载 better-sqlite3 native 模块。
 *   而 better-sqlite3 在 Electron 项目中需针对 Electron ABI 编译（electron-rebuild），
 *   与 Node.js 测试环境的 ABI 不匹配（NODE_MODULE_VERSION 137 vs 143）。
 *   提取此接口后，测试可用 node:sqlite（Node 22+ 内置）作为零 ABI 依赖的替身。
 */

/**
 * SQLite 预编译语句接口
 *
 * 方法签名与 better-sqlite3 的 Statement 兼容：
 *   - 位置参数：run('a', 'b') / get('a') / all('a')
 *   - 命名参数：run({ id: 'a' }) / get({ id: 'a' }) / all({ id: 'a' })
 *   - 命名参数占位符：@name（better-sqlite3 和 node:sqlite 均原生支持）
 */
export interface ISqliteStatement {
  /**
   * 执行 INSERT/UPDATE/DELETE 语句
   * @param params 位置参数（展开）或命名参数对象（单个对象参数）
   * @returns 受影响的行数信息
   */
  run(...params: unknown[]): { changes: number };

  /**
   * 查询单行
   * @param params 位置参数（展开）或命名参数对象（单个对象参数）
   * @returns 行对象，无匹配时返回 undefined
   */
  get(...params: unknown[]): unknown;

  /**
   * 查询多行
   * @param params 位置参数（展开）或命名参数对象（单个对象参数）
   * @returns 行对象数组
   */
  all(...params: unknown[]): unknown[];
}

/**
 * SQLite 数据库连接接口
 *
 * 方法签名与 better-sqlite3 的 Database 兼容。
 * node:sqlite 的 DatabaseSync 需通过适配器补齐 transaction() 方法。
 */
export interface ISqliteDatabase {
  /**
   * 执行多条 SQL 语句（建表、建索引、迁移等）
   * @param sql SQL 字符串，支持多条语句（分号分隔）
   */
  exec(sql: string): void;

  /**
   * 预编译 SQL 语句
   * @param sql SQL 字符串，支持 ? 位置占位符和 @name 命名占位符
   * @returns 可复用的预编译语句
   */
  prepare(sql: string): ISqliteStatement;

  /**
   * 创建事务包装器（better-sqlite3 原生支持，node:sqlite 需适配器实现）
   *
   * 返回一个函数，调用时在事务中执行 fn：
   *   - fn 正常返回：COMMIT
   *   - fn 抛出异常：ROLLBACK 并重新抛出
   *
   * @param fn 事务体函数
   * @returns 可调用的事务函数
   */
  transaction<T>(fn: () => T): () => T;

  /**
   * 关闭数据库连接
   */
  close(): void;
}
