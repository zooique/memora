/**
 * Node 内置 SQLite 存储实现 —— `IMemoryStorage` 的落盘版（`node:sqlite` 内建模块，零第三方运行时依赖）
 *
 * ## 边界（勿越）
 * - **只出工厂、不出实现类**：宿主经 `createNodeSqliteStorage()` 消费；实现类随签名结构可用，但不挂公共面
 *   （避免宿主绕过工厂校验自建实例——基址/只读/PRAGMA 全在工厂收口）。
 * - **文件路径语义留在宿主侧**：工厂收 `dbPath` 全长路径，内核不拼 `.memora/`、不定义记忆文件名常量
 *   （对齐 ADR-002 定位：内核不感知数据目录布局）。
 * - **不接管 IO 装载与迁移**：JSON 读取与一次性迁移是宿主的组合调用，内核不实现。
 *
 * ## 为什么用 `process.getBuiltinModule` 而非 `createRequire(import.meta.url)`
 * ① `import.meta.url` 在本仓宿主 esbuild bundle 场景**有事故史**（bundle 后路径漂移，见宿主 assemble.ts /
 *    extension.ts 相关注释）；
 * ② `process.getBuiltinModule('node:xxx')` 对**不存在的模块返回 `undefined` 而非抛异常**（Node 22.22.2 /
 *    24.12.0 实测）⇒「环境不支持」是显式判据；若改用 `createRequire` 的 catch-all，bundle 造成的
 *    `TypeError` 会被吞成「老 Node 环境」= 真故障伪装成环境问题（违背「不带伤」）；
 * ③ 版本代价 ≥22.3 被 `node:sqlite` 自身的 ≥22.13 门槛完全吸收，不额外抬门槛。
 *    Node ≤22.2 无 `getBuiltinModule` 方法 → 走同一条「不可用」判据。
 *
 * ## 可用性判据唯一来源（禁判据散点）
 * 「当前环境能否用 SQLite」的**唯一判据** = 调用本工厂的结果（成功 / 抛 `NOT_AVAILABLE` 专属错误）。
 * 宿主**禁止**自行解析 `process.versions.node` 推断——版本号与实际加载结果可能不一致。
 *
 * ## 只读视图
 * `{ readOnly: true }` 重载返回 `ReadOnlyMemoryStorage`（仅读方法）：连接以 SQLite 只读模式打开，且返回对象
 * **结构上不含写方法**（不是「约定不乱调」）。供只读宿主（如 memora-mcp）零并列复用本实现，避免各宿主自写
 * 第二份 SQLite 语义实现（三份并列 = 语义漂移）。**只读模式不建库**：库不存在时抛
 * `MemoraError{ errorCode: FILE_NOT_FOUND }`，宿主据此区分「未初始化」与「真故障」。
 *
 * ## API 子集约束（防「因错误的原因通过」）
 * 根 `@types/node` 版本高于运行时门槛（22.13）⇒ `tsc` 绿**不等于**运行时有该 API。本文件只使用 ≥22.13
 * 已存在的 API：`DatabaseSync` / `prepare` / `run` / `get` / `all` / `exec` / `close` + 选项 `readOnly`
 * （`@since v22.12.0`）。**刻意不使用** `timeout` 选项（`@since v24.0.0`，高于门槛）——忙等待改经
 * `PRAGMA busy_timeout` 设置（全版本可用）。
 *
 * ## 并发
 * 写锁为整库级，多进程（vscode / mcp / dsh）同写须排队（SQLite 默认 `busy_timeout = 0` = 立即报
 * `SQLITE_BUSY`）⇒ 构造时设忙等待；写模式另设 `journal_mode = WAL`（读写不互斥，多进程互见）。
 */
import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { IMemoryStorage, ReadOnlyMemoryStorage } from '@/memory/storageInterface.js';
import type { Memory } from '@/memory/types.js';
import { parseMemory } from '@/memory/types.js';
import { escapeLike, validateSource } from '@/memory/sourceValidation.js';
import { segmentLower } from '@/utils/segmenter.js';
import { logger } from '@/logging/logger.js';
import { MemoraError, ToolErrorCode, configError } from '@/utils/errors.js';
import { nowIso } from '@/utils/time.js';

/** DatabaseSync 实例类型（`import type` 编译后消失，不产生运行期对 node:sqlite 的静态依赖） */
type SqliteDatabase = DatabaseSync;
/** StatementSync 实例类型（该类构造器私有，不能走 InstanceType，改由 prepare 返回值派生） */
type SqliteStatement = ReturnType<SqliteDatabase['prepare']>;
/** 查询结果行：列名 → 值（列值为 SQLite 标量，读侧按 unknown 收，交 parseMemory 校验） */
type SqliteRow = Record<string, unknown>;

/**
 * 本实现允许使用的 `node:sqlite` 结构面**白名单**。
 *
 * 目的 = 防「因错误的原因通过」：根 `@types/node` 版本高于运行时门槛（22.13）⇒ `tsc` 绿**不能**证明
 * 运行时有该 API。此处显式列出工厂所需的唯一成员，且选项**只含 `readOnly`**（`@since v22.12.0`，低于门槛）；
 * 刻意**不含** `timeout`（`@since v24.0.0`，高于门槛——忙等待改经 `PRAGMA busy_timeout`）。
 */
interface SqliteModuleShape {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase;
}

/** 忙等待超时（毫秒）：写锁整库级，多进程同写须排队；0（SQLite 默认）会让并发写立即失败 */
const DEFAULT_BUSY_TIMEOUT_MS = 3000;

/** 建表语句：列名 snake_case 对齐 SQL 习惯，字段集与 `Memory` 白名单逐一对应 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memories (
  id                   TEXT PRIMARY KEY,
  content              TEXT NOT NULL,
  source               TEXT NOT NULL,
  name                 TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  accessed_at          TEXT NOT NULL,
  deleted_at           TEXT,
  metadata             TEXT,
  summary_type         TEXT,
  session_name         TEXT,
  round_id             TEXT,
  is_modified          INTEGER,
  superseded_by        TEXT,
  material_fingerprint TEXT
)`;

/** 列清单（显式列出而非 `SELECT *`：列序稳定且与 rowToMemory 对齐，加列时不静默错位） */
const COLUMNS = [
  'id',
  'content',
  'source',
  'name',
  'created_at',
  'accessed_at',
  'deleted_at',
  'metadata',
  'summary_type',
  'session_name',
  'round_id',
  'is_modified',
  'superseded_by',
  'material_fingerprint',
].join(', ');

/** upsert 语句：整对象覆盖（契约「无 CAS 乐观锁」；`ON CONFLICT DO UPDATE` 语义等价于 REPLACE） */
const UPSERT_SQL = `
INSERT INTO memories (${COLUMNS})
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  content              = excluded.content,
  source               = excluded.source,
  name                 = excluded.name,
  created_at           = excluded.created_at,
  accessed_at          = excluded.accessed_at,
  deleted_at           = excluded.deleted_at,
  metadata             = excluded.metadata,
  summary_type         = excluded.summary_type,
  session_name         = excluded.session_name,
  round_id             = excluded.round_id,
  is_modified          = excluded.is_modified,
  superseded_by        = excluded.superseded_by,
  material_fingerprint = excluded.material_fingerprint`;

/**
 * 取 Node 内建 sqlite 模块。
 * 判据显式：模块缺失 → 返回 `undefined`（**不是抛异常**）；Node ≤22.2 无 `getBuiltinModule` 方法，走同一判据。
 */
function loadSqliteModule(): SqliteModuleShape | undefined {
  if (typeof process.getBuiltinModule !== 'function') return undefined;
  return process.getBuiltinModule('node:sqlite') as SqliteModuleShape | undefined;
}

/**
 * 专属错误：「当前运行时无 node:sqlite 实现方」。
 * 复用 `NOT_AVAILABLE`（能力缺席、不可重试）——与「provider 未注入」同语义类，避免为存储另开枚举码
 * 造成单码单义分裂；宿主判据 = `err instanceof MemoraError && err.errorCode === ToolErrorCode.NOT_AVAILABLE`。
 */
function sqliteUnavailableError(): MemoraError {
  return new MemoraError({
    title: 'SQLite 存储不可用',
    detail: '当前 Node 运行时未提供 node:sqlite 内建模块（需 Node ≥22.13）',
    suggestions: [
      '升级 Node 至 ≥22.13 后重试',
      '或改用 JSON / 内存存储（宿主按本工厂的抛出结果降级）',
    ],
    category: 'config',
    errorCode: ToolErrorCode.NOT_AVAILABLE,
  });
}

/**
 * 专属错误：「只读打开时库文件不存在」。
 *
 * 为什么不把驱动的裸 `ERR_SQLITE_ERROR: unable to open database file` 抛出去：只读宿主
 * （memora-mcp / dsh 等）必须能用**错误码**区分「本工作区还没建库」与「真故障」，
 * 否则每个宿主都得自己 `existsSync`（判据散点），用户看到的也是不可操作的驱动原文。
 *
 * 复用 `FILE_NOT_FOUND`：语义就是「文件不存在」，不为存储另开枚举码。
 */
function memoryDbNotFoundError(dbPath: string): MemoraError {
  return new MemoraError({
    title: '记忆库文件不存在',
    detail: `${dbPath} 尚未创建（只读模式不建库）`,
    suggestions: [
      '先用写宿主（如 Memora VS Code 插件）打开该工作区一次，以创建并迁移记忆库',
      '确认传入的是工作区根目录，而不是它的子目录',
    ],
    category: 'config',
    errorCode: ToolErrorCode.FILE_NOT_FOUND,
  });
}

/**
 * 行 → Memory：字段白名单校验**单一来源** = `parseMemory`（禁在本文件复写字段类型/取值校验）。
 */
function rowToMemory(row: SqliteRow): Memory {
  return parseMemory({
    id: row.id,
    content: row.content,
    source: row.source,
    name: row.name,
    createdAt: row.created_at,
    accessedAt: row.accessed_at,
    // SQL NULL 交 parseMemory 归一（其已把 null 视为未软删除）——字符串则为其原始软删除时间
    deletedAt: row.deleted_at,
    metadata:
      row.metadata === null || row.metadata === undefined ? undefined : parseMetadata(row.metadata),
    // 以下可空列须显式把 null 归一为 undefined：parseMemory 对「非 undefined」做类型校验，null 会被判非法
    summaryType: row.summary_type ?? undefined,
    sessionName: row.session_name ?? undefined,
    roundId: row.round_id ?? undefined,
    isModified:
      row.is_modified === null || row.is_modified === undefined
        ? undefined
        : Number(row.is_modified) !== 0,
    supersededBy: row.superseded_by ?? undefined,
    materialFingerprint: row.material_fingerprint ?? undefined,
  });
}

/** 解析 metadata 列的 JSON 文本；非法 JSON 抛错（响亮失败，不静默丢字段） */
function parseMetadata(raw: unknown): Record<string, string> {
  try {
    return JSON.parse(String(raw)) as Record<string, string>;
  } catch (err) {
    throw configError(
      'SQLite 记忆行损坏',
      `metadata 列不是合法 JSON：${String(raw)}`,
      ['检查该行是否被外部工具写坏', '或用备份重新迁移'],
      err instanceof Error ? err : undefined,
    );
  }
}

/** Memory → 绑定参数（顺序严格对齐 COLUMNS） */
function memoryToParams(m: Memory): (string | number | null)[] {
  return [
    m.id,
    m.content,
    m.source,
    m.name,
    m.createdAt,
    m.accessedAt,
    m.deletedAt ?? null,
    m.metadata === undefined ? null : JSON.stringify(m.metadata),
    m.summaryType ?? null,
    m.sessionName ?? null,
    m.roundId ?? null,
    m.isModified === undefined ? null : m.isModified ? 1 : 0,
    m.supersededBy ?? null,
    m.materialFingerprint ?? null,
  ];
}

/** 从行里取计数值（`COUNT(*)` 结果列） */
function rowCount(row: SqliteRow | undefined): number {
  return row === undefined ? 0 : Number(row.c);
}

/**
 * 内部实现类（不挂公共面）。所有方法同步，语义逐位对齐 `InMemoryStorage`（契约对拍测试兜底）。
 */
class NodeSqliteStorage implements IMemoryStorage {
  private readonly db: SqliteDatabase;
  /** 写模式才建表 + 设 WAL；只读模式连表都不建（宿主只读打开既有库） */
  private readonly stmtUpsert: SqliteStatement;
  private readonly stmtSoftDelete: SqliteStatement;
  private readonly stmtRestore: SqliteStatement;
  private readonly stmtPurge: SqliteStatement;
  private readonly stmtListDeleted: SqliteStatement;
  private readonly stmtListDeletedLimit: SqliteStatement;
  private readonly stmtGetDeletedById: SqliteStatement;
  private readonly stmtPurgeExpired: SqliteStatement;
  private readonly stmtGetActiveById: SqliteStatement;
  private readonly stmtGetActiveBySource: SqliteStatement;
  private readonly stmtActiveByAccessedDesc: SqliteStatement;
  private readonly stmtGetDeletedAt: SqliteStatement;
  private readonly stmtCount: SqliteStatement;
  private readonly stmtCountBySource: SqliteStatement;
  private readonly stmtTouch: SqliteStatement;
  private readonly stmtAllSources: SqliteStatement;
  /** search 语句按 token 数缓存（每 token 两个 LIKE 占位），避免每次调用重新 prepare */
  private readonly searchStmtCache = new Map<number, SqliteStatement>();
  private closed = false;

  constructor(db: SqliteDatabase, writeMode: boolean) {
    this.db = db;
    // 忙等待：多进程同写排队，而非立即 SQLITE_BUSY（用 PRAGMA 而非 DatabaseSync 的 timeout 选项——
    // 后者 @since v24.0.0，高于本实现的 22.13 门槛）
    this.db.exec(`PRAGMA busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS}`);
    if (writeMode) {
      // WAL：读写不互斥，多进程互见（这是本次换 SQLite 的核心收益）
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec(SCHEMA_SQL);
    }
    this.stmtUpsert = this.prepare(UPSERT_SQL);
    this.stmtSoftDelete = this.prepare(
      'UPDATE memories SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL',
    );
    this.stmtRestore = this.prepare(
      'UPDATE memories SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL',
    );
    this.stmtPurge = this.prepare('DELETE FROM memories WHERE id = ?');
    this.stmtListDeleted = this.prepare(
      `SELECT ${COLUMNS} FROM memories WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC`,
    );
    this.stmtListDeletedLimit = this.prepare(
      `SELECT ${COLUMNS} FROM memories WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT ?`,
    );
    this.stmtGetDeletedById = this.prepare(
      `SELECT ${COLUMNS} FROM memories WHERE id = ? AND deleted_at IS NOT NULL`,
    );
    this.stmtPurgeExpired = this.prepare(
      'DELETE FROM memories WHERE deleted_at IS NOT NULL AND deleted_at < ?',
    );
    this.stmtGetActiveById = this.prepare(
      `SELECT ${COLUMNS} FROM memories WHERE id = ? AND deleted_at IS NULL`,
    );
    this.stmtGetActiveBySource = this.prepare(
      `SELECT ${COLUMNS} FROM memories WHERE source = ? AND deleted_at IS NULL ORDER BY accessed_at DESC`,
    );
    this.stmtActiveByAccessedDesc = this.prepare(
      `SELECT ${COLUMNS} FROM memories WHERE deleted_at IS NULL ORDER BY accessed_at DESC LIMIT ?`,
    );
    this.stmtGetDeletedAt = this.prepare('SELECT deleted_at FROM memories WHERE id = ?');
    this.stmtCount = this.prepare('SELECT COUNT(*) AS c FROM memories WHERE deleted_at IS NULL');
    this.stmtCountBySource = this.prepare(
      'SELECT COUNT(*) AS c FROM memories WHERE source = ? AND deleted_at IS NULL',
    );
    this.stmtTouch = this.prepare(
      'UPDATE memories SET accessed_at = ? WHERE id = ? AND deleted_at IS NULL',
    );
    this.stmtAllSources = this.prepare(
      'SELECT source AS s, COUNT(*) AS c FROM memories WHERE deleted_at IS NULL GROUP BY source',
    );
  }

  /** prepare 包装（集中类型收口点，免每处重复断言） */
  private prepare(sql: string): SqliteStatement {
    return this.db.prepare(sql);
  }

  upsert(memory: Memory): void {
    const result = validateSource(memory.source);
    if (result.severity === 'block') {
      throw configError('source 校验失败，拒绝写入', result.warning, [
        '请检查 source 字段是否拼写正确',
        '参考 source 开放字符串规范',
      ]);
    }
    if (result.severity === 'warn' && result.warning) {
      logger.warn(
        { id: memory.id, source: memory.source, warning: result.warning },
        'source 校验警告',
      );
    }
    // 软删除复活拦截：与 InMemoryStorage 同判据（须先显式 restore，或新对象自带 deletedAt）
    const existing = this.stmtGetDeletedAt.get(memory.id) as SqliteRow | undefined;
    if (existing && existing.deleted_at !== null && memory.deletedAt === undefined) {
      throw configError(
        '不允许通过 upsert 复活软删除记忆',
        `id=${memory.id} 已被软删除（deletedAt=${String(existing.deleted_at)}）`,
        [
          '若需恢复：先调用 restore(id)，再 upsert',
          '若需覆盖软删除态：在 newMemory 中显式传入 deletedAt 字段',
          '参考软删除机制设计',
        ],
      );
    }
    this.stmtUpsert.run(...memoryToParams(memory));
  }

  delete(id: string): void {
    this.stmtSoftDelete.run(nowIso(), id);
  }

  restore(id: string): void {
    this.stmtRestore.run(id);
  }

  purge(id: string): void {
    this.stmtPurge.run(id);
  }

  listDeleted(limit?: number): Memory[] {
    const rows =
      limit !== undefined && limit > 0
        ? (this.stmtListDeletedLimit.all(limit) as SqliteRow[])
        : (this.stmtListDeleted.all() as SqliteRow[]);
    return rows.map(rowToMemory);
  }

  getDeletedById(id: string): Memory | null {
    const row = this.stmtGetDeletedById.get(id) as SqliteRow | undefined;
    return row === undefined ? null : rowToMemory(row);
  }

  purgeExpired(before: Date): number {
    const result = this.stmtPurgeExpired.run(before.toISOString());
    return Number(result.changes);
  }

  getById(id: string): Memory | null {
    const row = this.stmtGetActiveById.get(id) as SqliteRow | undefined;
    return row === undefined ? null : rowToMemory(row);
  }

  getBySource(source: string): Memory[] {
    return (this.stmtGetActiveBySource.all(source) as SqliteRow[]).map(rowToMemory);
  }

  search(query: string, limit = 10): Memory[] {
    // 空查询 / 分词零 token：退化为「按 accessedAt 降序取前 N」（与 InMemoryStorage 同语义）
    const tokens = query.trim() ? segmentLower(query) : [];
    if (tokens.length === 0) {
      return (this.stmtActiveByAccessedDesc.all(limit) as SqliteRow[]).map(rowToMemory);
    }
    const stmt = this.searchStatement(tokens.length);
    // 每 token 两个 LIKE（content / name）；转义后必须配 ESCAPE '\'，否则含 % / _ 的字面值零召回
    const params: (string | number)[] = [];
    for (const token of tokens) {
      const pattern = `%${escapeLike(token)}%`;
      params.push(pattern, pattern);
    }
    params.push(limit);
    return (stmt.all(...params) as SqliteRow[]).map(rowToMemory);
  }

  /** 按 token 数取（必要时建）search 语句：任一 token 命中 content/name 即入选 */
  private searchStatement(tokenCount: number): SqliteStatement {
    const cached = this.searchStmtCache.get(tokenCount);
    if (cached) return cached;
    const clauses = Array.from(
      { length: tokenCount },
      () => `(content LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\')`,
    ).join(' OR ');
    const stmt = this.prepare(
      `SELECT ${COLUMNS} FROM memories WHERE deleted_at IS NULL AND (${clauses}) ORDER BY accessed_at DESC LIMIT ?`,
    );
    this.searchStmtCache.set(tokenCount, stmt);
    return stmt;
  }

  count(): number {
    return rowCount(this.stmtCount.get() as SqliteRow | undefined);
  }

  countBySource(source: string): number {
    return rowCount(this.stmtCountBySource.get(source) as SqliteRow | undefined);
  }

  touch(id: string, now: string): boolean {
    return Number(this.stmtTouch.run(now, id).changes) > 0;
  }

  getAllSources(): Map<string, number> {
    const out = new Map<string, number>();
    for (const row of this.stmtAllSources.all() as SqliteRow[]) {
      out.set(String(row.s), Number(row.c));
    }
    return out;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

/** 构建只读视图：仅含读方法 + close（结构上拿不到写方法），供只读宿主复用 */
function toReadOnlyView(impl: IMemoryStorage): ReadOnlyMemoryStorage {
  return Object.freeze({
    getById: (id: string) => impl.getById(id),
    getBySource: (source: string) => impl.getBySource(source),
    search: (query: string, limit?: number) => impl.search(query, limit),
    count: () => impl.count(),
    countBySource: (source: string) => impl.countBySource(source),
    getAllSources: () => impl.getAllSources(),
    listDeleted: (limit?: number) => impl.listDeleted(limit),
    getDeletedById: (id: string) => impl.getDeletedById(id),
    close: () => impl.close?.(),
  });
}

/**
 * 创建 SQLite 落盘存储（读写）。
 *
 * 不可用时抛专属错误（`errorCode = NOT_AVAILABLE`）——**宿主可用性判据的唯一来源**，禁自行解析版本号。
 *
 * @param dbPath 数据库文件全长路径（路径语义归宿主，内核不拼目录）
 */
export function createNodeSqliteStorage(dbPath: string): IMemoryStorage;
/**
 * 创建 SQLite 存储的**只读视图**（写方法结构上不存在），供只读宿主复用。
 * 连接以只读模式打开：文件不存在会抛错（只读宿主不做建库/迁移）。
 */
export function createNodeSqliteStorage(
  dbPath: string,
  options: { readOnly: true },
): ReadOnlyMemoryStorage;
export function createNodeSqliteStorage(
  dbPath: string,
  options?: { readOnly?: boolean },
): IMemoryStorage | ReadOnlyMemoryStorage {
  const mod = loadSqliteModule();
  if (!mod) throw sqliteUnavailableError();
  const readOnly = options?.readOnly === true;
  // 只读模式不建库：先判存在，把「未初始化」收成专属错误码（见 memoryDbNotFoundError）。
  // 判存在与打开之间存在 TOCTOU 窗口，但文件被删时 DatabaseSync 会抛裸错——真故障原样暴露，不吞。
  if (readOnly && !existsSync(dbPath)) throw memoryDbNotFoundError(dbPath);
  // 注意：不能写 `new DatabaseSync(path, undefined)`——第二个实参一旦出现，Node 参数校验即要求它是对象
  const db = readOnly
    ? new mod.DatabaseSync(dbPath, { readOnly: true })
    : new mod.DatabaseSync(dbPath);
  const impl = new NodeSqliteStorage(db, !readOnly);
  return readOnly ? toReadOnlyView(impl) : impl;
}
