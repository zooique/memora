/**
 * 宿主记忆存储接线 —— 按「迁移状态 × 环境能力」分档选择落盘实现（vscode 宿主唯一装配点）
 *
 * ## 分档判据（禁判据散点）
 * - **环境能力**：唯一来源 = 内核工厂 `createNodeSqliteStorage` 的调用结果
 *   （成功 → 可用；抛 `errorCode === ToolErrorCode.NOT_AVAILABLE` → 不可用）。
 *   **禁止**宿主自行解析 `process.versions.node` 推断——版本号可能与真实加载结果不一致
 *   （纪律见内核 `nodeSqliteStorage.ts` 文件头「可用性判据唯一来源」）。
 * - **迁移状态**：唯一来源 = 库文件 `<工作区>/.memora/memories.db` 是否存在。
 *
 * | 环境能力 | 有无 .db | 处置 |
 * | --- | --- | --- |
 * | 可用 | 无 | 一次性迁移旧 JSON（若有）→ 用 SQLite 读写 |
 * | 可用 | 有 | 直接用 SQLite 读写（迁移幂等，无旧档零动作） |
 * | 不可用（老 Node） | 无 | 降级旧 JSON 读写（现状不变：老环境扩展不挂、JSON 照常） |
 * | 不可用（老 Node） | 有 | **响亮失败**（见下「禁数据分叉」） |
 *
 * ## 禁数据分叉（SSOT）
 * 一旦 `.db` 存在，它即记忆的**唯一真源**；**绝不允许**在它旁边旁路写 JSON
 * （= 两个活跃写端 = 真源分叉）。故「环境不可用 + 已迁移」**不降级为 JSON**，
 * 直接抛错求用户升级环境——而非静默返回空库（那是「谎称没有记忆」）或回落 JSON 写（那是分叉）。
 * 注：vscode 是写宿主，需注入 `IMemoryStorage` 全方法（含写）⇒ 结构只读存储无法注入；
 * 该缺口由「响亮失败」兜底，不是遗漏。
 *
 * ## 一次性迁移（幂等）
 * 读旧 `memories.json` → 逐条经内核 `parseMemory` 白名单校验（单条坏数据跳过 + 告警）→
 * upsert 进 SQLite → 原 JSON **改名保留**（`memories.json.migrated-<date>`，**不删除**，留人工兜底）。
 * 幂等：旧档改名后下次无档可迁（零动作）；中途失败可重跑（upsert 整对象覆盖，重跑收敛）。
 * 退役设定来源（persona/rule/skill）存量行随迁移一并软删（复用 `WorkspaceStorage` 的既有出口）。
 *
 * ## 路径语义（内核边界）
 * `.memora/` 目录名与库文件名**只在宿主侧**（内核工厂收全长 `dbPath`，不拼目录、不定义文件名）。
 */
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import {
  createNodeSqliteStorage,
  MemoraError,
  ToolErrorCode,
  type ILogger,
  type IMemoryStorage,
} from '@zooique/memora';
import { WorkspaceStorage } from './workspaceStorage.js';

/** 记忆数据目录名（与 assemble 的 dataDir / 各宿主存储同源） */
const DATA_DIR_NAME = '.memora';
/** SQLite 库文件名（宿主侧定义；内核不感知，见文件头「路径语义」） */
const MEMORY_DB_FILENAME = 'memories.db';

/**
 * 解析工作区记忆库绝对路径 —— **跨宿主路径契约的唯一计算点**。
 *
 * `hosts/memora-mcp` 用同一布局只读打开该文件（`readOnlyFileStore.ts` 自己 join 同两个常量）。
 * 两侧一致性由 `src/__tests__/crossHostLayout.test.ts` 守护：它加载 mcp 的构建产物，
 * 断言两侧对同一工作区算出**同一个绝对路径**。改这里的目录/文件名必须同时改 mcp，否则契约测试红。
 */
export function resolveHostMemoryDbPath(projectPath: string): string {
  return join(projectPath, DATA_DIR_NAME, MEMORY_DB_FILENAME);
}

/** 一次性迁移结果（内部结构，供日志上报用） */
interface MigrationResult {
  /** 是否真的发生迁移（旧档存在且已处理） */
  migrated: boolean;
  /** 迁入 SQLite 的条目数（含软删除；被跳过的坏数据不计入） */
  count: number;
  /** 旧档改名后的保存路径（未迁移时 undefined） */
  legacySnapshotPath?: string;
}

/**
 * 可注入依赖（测试替换「sqlite 能力探针」；生产用缺省 = 内核工厂）。
 * 注入点是**测试替身**，不是产品扩展位——生产只有一种取法。
 */
export interface MemoryStorageDeps {
  /** 打开 SQLite 存储；抛 `NOT_AVAILABLE` 即「环境不支持」 */
  openSqlite: (dbPath: string) => IMemoryStorage;
}

/**
 * 装配宿主记忆存储 —— 按文件头分档表选实现。
 *
 * @param projectPath 工作区根（`.memora/` 由此推导）
 * @param logger 可选：宿主日志（迁移摘要经此上报；缺省静默）
 * @param deps 可选：sqlite 探针注入（仅测试用）
 * @returns 记忆存储实例（SQLite 或降级 JSON）
 */
export function createHostMemoryStorage(
  projectPath: string,
  logger?: ILogger,
  deps: MemoryStorageDeps = { openSqlite: createNodeSqliteStorage },
): IMemoryStorage {
  const dbPath = resolveHostMemoryDbPath(projectPath);

  let sqlite: IMemoryStorage;
  try {
    // 建库需要父目录已存在（内核工厂不建目录）——.memora/ 通常已由会话/轮次存储建立
    mkdirSync(join(projectPath, DATA_DIR_NAME), { recursive: true });
    sqlite = deps.openSqlite(dbPath);
  } catch (err) {
    // 非「环境不支持」（真故障）：原样抛出——不伪装成降级（防「因错误的原因通过」）
    if (!isSqliteUnavailable(err)) throw err;
    // 已迁移但环境不支持：响亮失败（禁数据分叉 + 不静默丢记忆）
    if (existsSync(dbPath)) throw memoryDbUnavailableError(dbPath);
    // 未迁移：JSON 读写不变（现状）——老环境扩展不挂、JSON 照常
    const legacy = new WorkspaceStorage(projectPath);
    legacy.load();
    legacy.migrateRetiredSettingSources();
    return legacy;
  }

  // SQLite 可用：执行一次性迁移（幂等；无旧档零动作）
  const result = migrateLegacyJsonToSqlite(projectPath, sqlite);
  if (result.migrated) {
    logger?.info(
      `Memora 记忆库已迁移到 SQLite：${result.count} 条 → ${MEMORY_DB_FILENAME}` +
        `（旧档保留于 ${result.legacySnapshotPath}）`,
    );
  }
  return sqlite;
}

/**
 * 把工作区旧 `memories.json` 一次性迁入已打开的 SQLite 存储。
 *
 * 幂等：无旧档（或已改名）→ 零动作。容错：单条坏数据由 `WorkspaceStorage.load()`
 * 的 `parseMemory` 白名单逐条校验跳过（不因一条脏数据清空整库），此处不再重复校验。
 *
 * @param projectPath 工作区根（定位旧档）
 * @param sqlite 目标 SQLite 存储（读写模式）
 * @returns 迁移结果（是否迁移 + 条数 + 旧档保存路径）
 */
function migrateLegacyJsonToSqlite(projectPath: string, sqlite: IMemoryStorage): MigrationResult {
  // 复用 `WorkspaceStorage` 作「JSON 装载器」：load() 完成 parseMemory 清洗，
  // migrateRetiredSettingSources() 完成退役设定来源软删（两者皆既有出口，零复制）
  const legacy = new WorkspaceStorage(projectPath);
  if (!existsSync(legacy.path)) return { migrated: false, count: 0 };

  legacy.load();
  legacy.migrateRetiredSettingSources();
  const rows = legacy.all();
  // 逐条 upsert：整对象覆盖、重跑收敛（不需显式事务；中途失败留旧档，下次重跑补齐）
  for (const memory of rows) sqlite.upsert(memory);

  // 旧档改名保留（不删除）：memories.json → memories.json.migrated-<date>
  const snapshotPath = `${legacy.path}.migrated-${dateStamp()}`;
  renameSync(legacy.path, snapshotPath);
  return { migrated: true, count: rows.length, legacySnapshotPath: snapshotPath };
}

/** 判定「环境不支持 SQLite」：专属错误码的唯一判据（用导出常量，非字符串字面量） */
function isSqliteUnavailable(err: unknown): boolean {
  return err instanceof MemoraError && err.errorCode === ToolErrorCode.NOT_AVAILABLE;
}

/** 已迁移但环境不支持时的专属错误（响亮失败；指引用户升级环境，并警示勿造数据分叉） */
function memoryDbUnavailableError(dbPath: string): MemoraError {
  return new MemoraError({
    title: '记忆库已升级为 SQLite，但当前环境不支持',
    detail:
      `记忆真源 ${dbPath} 需要 Node ≥22.13（VS Code ≥1.101 内置 Node 满足）。` +
      '当前 VS Code 内置 Node 过旧：既读不了该库，也不能回退写 JSON（那会造成两份真源分叉）。',
    suggestions: [
      '升级 VS Code 至 ≥1.101 后重开本工作区',
      '切勿手动在该工作区新建 memories.json——数据分叉会覆盖真实记忆',
    ],
    category: 'config',
    errorCode: ToolErrorCode.NOT_AVAILABLE,
  });
}

/** 迁移日期戳（YYYY-MM-DD，本地时区无关——仅用于旧档命名，不参与任何判据） */
function dateStamp(): string {
  return new Date().toISOString().slice(0, 10);
}
