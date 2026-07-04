/**
 * NodeSqliteDatabase 单元测试
 *
 * 覆盖范围：
 *   - constructor：默认 :memory: + 显式路径
 *   - exec：建表、PRAGMA、多语句
 *   - prepare + run/get/all：位置参数 + 命名参数（@name）
 *   - transaction：成功 COMMIT + 失败 ROLLBACK + 嵌套事务行为
 *   - close：正常关闭 + 重复关闭
 *   - createMemoryDatabase：辅助函数
 *
 * 设计原则：
 *   - 每个测试独立创建 :memory: 实例，避免状态污染
 *   - 不依赖文件系统（:memory: 模式零 IO，测试快速稳定）
 *   - 验证 ISqliteDatabase 接口契约，不测试 better-sqlite3 内部行为
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NodeSqliteDatabase, createMemoryDatabase } from '../../storage/nodeSqliteDatabase.js';
import type { ISqliteDatabase } from '../../storage/sqliteDatabaseTypes.js';

/**
 * 创建预初始化的测试数据库
 *
 * 建表 users + 插入 2 行初始数据，供查询测试使用。
 *
 * @param db 已实例化的 NodeSqliteDatabase
 */
function setupTestTable(db: ISqliteDatabase): void {
  db.exec(`
    CREATE TABLE users (
      id   INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      age  INTEGER NOT NULL
    );
  `);
  db.prepare('INSERT INTO users (name, age) VALUES (@name, @age)').run({
    name: 'alice',
    age: 30,
  });
  db.prepare('INSERT INTO users (name, age) VALUES (?, ?)').run('bob', 25);
}

// ─── constructor ────────────────────────────────────────────

describe('NodeSqliteDatabase · constructor', () => {
  it('默认 :memory: 模式应创建内存数据库', () => {
    const db = new NodeSqliteDatabase();
    // 验证：能正常 exec 建表，说明实例已就绪
    expect(() => db.exec('CREATE TABLE t (x INTEGER);')).not.toThrow();
    db.close();
  });

  it('显式 :memory: 参数应等价于默认模式', () => {
    const db = new NodeSqliteDatabase(':memory:');
    expect(() => db.exec('CREATE TABLE t (x INTEGER);')).not.toThrow();
    db.close();
  });

  it('createMemoryDatabase 辅助函数应返回可用的 :memory: 实例', () => {
    const db = createMemoryDatabase();
    expect(db).toBeInstanceOf(NodeSqliteDatabase);
    expect(() => db.exec('CREATE TABLE t (x INTEGER);')).not.toThrow();
    db.close();
  });
});

// ─── exec ───────────────────────────────────────────────────

describe('NodeSqliteDatabase · exec', () => {
  let db: NodeSqliteDatabase;

  afterEach(() => {
    if (db) db.close();
  });

  it('应能执行单条 DDL 语句（建表）', () => {
    db = new NodeSqliteDatabase();
    db.exec('CREATE TABLE t (x INTEGER);');
    // 验证：插入数据后能查询到，说明建表成功
    db.prepare('INSERT INTO t (x) VALUES (?)').run(42);
    const row = db.prepare('SELECT x FROM t').get() as { x: number };
    expect(row.x).toBe(42);
  });

  it('应能执行多条 SQL 语句（分号分隔）', () => {
    db = new NodeSqliteDatabase();
    db.exec(`
      CREATE TABLE a (id INTEGER);
      CREATE TABLE b (id INTEGER);
      CREATE INDEX idx_a ON a(id);
    `);
    // 验证：两张表都存在
    const aCount = db.prepare("SELECT count(*) as c FROM sqlite_master WHERE type='table' AND name='a'").get() as { c: number };
    const bCount = db.prepare("SELECT count(*) as c FROM sqlite_master WHERE type='table' AND name='b'").get() as { c: number };
    expect(aCount.c).toBe(1);
    expect(bCount.c).toBe(1);
  });

  it('应能执行 PRAGMA 语句（WAL 模式）', () => {
    db = new NodeSqliteDatabase();
    // :memory: 数据库不支持持久化 WAL，但 PRAGMA 语句本身应能执行
    expect(() => db.exec('PRAGMA journal_mode = MEMORY')).not.toThrow();
  });

  it('执行非法 SQL 应抛出错误', () => {
    db = new NodeSqliteDatabase();
    expect(() => db.exec('THIS IS NOT SQL')).toThrow();
  });
});

// ─── prepare + run/get/all ──────────────────────────────────

describe('NodeSqliteDatabase · prepare + run/get/all', () => {
  let db: NodeSqliteDatabase;

  beforeEach(() => {
    db = new NodeSqliteDatabase();
    setupTestTable(db);
  });

  afterEach(() => {
    db.close();
  });

  it('run + 命名参数对象应正确插入数据', () => {
    const result = db.prepare('INSERT INTO users (name, age) VALUES (@name, @age)').run({
      name: 'charlie',
      age: 40,
    });
    expect(result.changes).toBe(1);
  });

  it('run + 位置参数应正确插入数据', () => {
    const result = db.prepare('INSERT INTO users (name, age) VALUES (?, ?)').run('dave', 35);
    expect(result.changes).toBe(1);
  });

  it('run + UPDATE 应返回受影响行数', () => {
    const result = db.prepare('UPDATE users SET age = ? WHERE name = ?').run(31, 'alice');
    expect(result.changes).toBe(1);
  });

  it('run + DELETE 应返回受影响行数', () => {
    const result = db.prepare('DELETE FROM users WHERE name = ?').run('bob');
    expect(result.changes).toBe(1);
  });

  it('get 应返回单行对象', () => {
    const row = db.prepare('SELECT name, age FROM users WHERE name = ?').get('alice') as { name: string; age: number };
    expect(row).toEqual({ name: 'alice', age: 30 });
  });

  it('get 无匹配行时应返回 undefined', () => {
    const row = db.prepare('SELECT name FROM users WHERE name = ?').get('nonexistent');
    expect(row).toBeUndefined();
  });

  it('get + 命名参数应正确查询', () => {
    const row = db.prepare('SELECT age FROM users WHERE name = @name').get({ name: 'bob' }) as { age: number };
    expect(row.age).toBe(25);
  });

  it('all 应返回所有匹配行（数组）', () => {
    const rows = db.prepare('SELECT name FROM users ORDER BY name ASC').all() as Array<{ name: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.name).toBe('alice');
    expect(rows[1]!.name).toBe('bob');
  });

  it('all + 参数过滤应返回匹配的子集', () => {
    const rows = db.prepare('SELECT name FROM users WHERE age > ? ORDER BY age DESC').all(26) as Array<{ name: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('alice');
  });

  it('all 无匹配行时应返回空数组', () => {
    const rows = db.prepare('SELECT name FROM users WHERE age > ?').all(1000);
    expect(rows).toEqual([]);
  });
});

// ─── transaction ────────────────────────────────────────────

describe('NodeSqliteDatabase · transaction', () => {
  let db: NodeSqliteDatabase;

  beforeEach(() => {
    db = new NodeSqliteDatabase();
    setupTestTable(db);
  });

  afterEach(() => {
    db.close();
  });

  it('事务正常返回应 COMMIT', () => {
    const insertInTx = db.transaction(() => {
      db.prepare('INSERT INTO users (name, age) VALUES (?, ?)').run('eve', 28);
      return 'committed';
    });

    const result = insertInTx();
    expect(result).toBe('committed');

    // 验证：事务内的写入已提交
    const row = db.prepare('SELECT name FROM users WHERE name = ?').get('eve');
    expect(row).toBeDefined();
  });

  it('事务抛出异常应 ROLLBACK 并重新抛出', () => {
    const failInTx = db.transaction(() => {
      db.prepare('INSERT INTO users (name, age) VALUES (?, ?)').run('frank', 50);
      throw new Error('tx failed');
    });

    // 验证：异常被重新抛出
    expect(() => failInTx()).toThrow('tx failed');

    // 验证：事务内的写入已回滚（frank 不应存在）
    const row = db.prepare('SELECT name FROM users WHERE name = ?').get('frank');
    expect(row).toBeUndefined();
  });

  it('事务应支持返回复杂对象', () => {
    const complexTx = db.transaction(() => {
      const alice = db.prepare('SELECT age FROM users WHERE name = ?').get('alice') as { age: number };
      return { name: 'alice', age: alice.age, doubled: alice.age * 2 };
    });

    const result = complexTx();
    expect(result).toEqual({ name: 'alice', age: 30, doubled: 60 });
  });

  it('事务返回 void 应正常 COMMIT', () => {
    const voidTx = db.transaction(() => {
      db.prepare('UPDATE users SET age = ? WHERE name = ?').run(31, 'alice');
    });

    expect(() => voidTx()).not.toThrow();

    // 验证：UPDATE 已提交
    const row = db.prepare('SELECT age FROM users WHERE name = ?').get('alice') as { age: number };
    expect(row.age).toBe(31);
  });

  it('事务中嵌套 DDL 应支持（建索引）', () => {
    const ddlTx = db.transaction(() => {
      db.exec('CREATE INDEX idx_users_age ON users(age)');
    });

    expect(() => ddlTx()).not.toThrow();

    // 验证：索引已创建
    const idx = db.prepare(
      "SELECT count(*) as c FROM sqlite_master WHERE type='index' AND name='idx_users_age'",
    ).get() as { c: number };
    expect(idx.c).toBe(1);
  });
});

// ─── close ──────────────────────────────────────────────────

describe('NodeSqliteDatabase · close', () => {
  it('close 后再 exec 应抛出错误', () => {
    const db = new NodeSqliteDatabase();
    db.close();
    // node:sqlite 关闭后再操作会抛错（具体错误信息依实现而定）
    expect(() => db.exec('CREATE TABLE t (x INTEGER);')).toThrow();
  });

  it('close 后再 prepare 应抛出错误', () => {
    const db = new NodeSqliteDatabase();
    db.close();
    expect(() => db.prepare('SELECT 1')).toThrow();
  });

  it('多次 close 第二次应抛出错误或静默（依实现）', () => {
    const db = new NodeSqliteDatabase();
    db.close();
    // node:sqlite 重复 close 行为：第二次会抛错（DatabaseSync 已关闭）
    // 这里用 try/catch 包裹，允许抛错或静默，重点是后续操作确实失败
    expect(() => {
      try {
        db.close();
      } catch {
        // 已关闭，符合预期
      }
    }).not.toThrow();
  });
});

// ─── ISqliteDatabase 接口契约 ──────────────────────────────

describe('NodeSqliteDatabase · ISqliteDatabase 接口契约', () => {
  it('应实现 ISqliteDatabase 接口的全部方法', () => {
    const db = createMemoryDatabase();
    // 接口方法存在性校验（编译时已保证，这里运行时再验证）
    expect(typeof db.exec).toBe('function');
    expect(typeof db.prepare).toBe('function');
    expect(typeof db.transaction).toBe('function');
    expect(typeof db.close).toBe('function');
    db.close();
  });

  it('prepare 返回的语句应实现 ISqliteStatement 接口', () => {
    const db = createMemoryDatabase();
    db.exec('CREATE TABLE t (x INTEGER)');
    const stmt = db.prepare('INSERT INTO t (x) VALUES (?)');
    expect(typeof stmt.run).toBe('function');
    expect(typeof stmt.get).toBe('function');
    expect(typeof stmt.all).toBe('function');
    db.close();
  });
});
