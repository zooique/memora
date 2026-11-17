/**
 * 会话文件迁移与扫描（从 `sessionStore` 外置：单一职责 + 宿主行数闸门）
 *
 * 落盘形态（**两文件一会话**，roundIds 与属性分开写）：
 *   - `<encoded>.json`：会话属性（meta / archived / lastActiveAt），整写需持锁
 *   - `<encoded>.rounds`：roundIds，**每行一个、只追加**——追加不需要读旧内容，
 *     因此不需要跨进程互斥（O_APPEND 单行写入由文件系统串行化，多窗口并发追加零覆盖）
 *
 * 为什么拆：roundIds 的写入本是**单调追加**，整文件读改写把它变成了「谁后写谁赢」的
 * 竞争区，于是必须用锁把写者排成唯一，锁一释放合法写就被判成非法（真机：面板释放长锁
 * 后新轮全丢）。追加语义天生可并发 ⇒ 把互斥从「数据正确性的前提」降级为「仅整写需要」。
 *
 * 三条迁移都在 `load()` 期执行，且**先于跨进程锁启用**（`extension.ts` 在 `load()` 之后才
 * `enableCrossProcessLock()`）——因此这里直连底层 `atomicWriteFileSync`，不走 store 的持锁写。
 * 该豁免面与残留风险见台账 `ARCHIVER-META-LOCKLESS-1`「豁免面复核」。
 *
 * 迁移纪律（沿用 store 内原注释，勿简化）：
 *   - 可重入 / 可断点续摊：`sessions/` 已存在的会话文件**一律跳过**（以文件为准，不覆盖）
 *   - 全部补齐后才把迁移源改名 `.migrated`（回退副本，不自动删除）
 *   - 最坏结果是「暂时少看见」，不是「永久少看见」
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { SessionMeta } from '@zooique/memora';
import { atomicWriteFileSync } from './atomicWriteSync.js';

/** step 2 过渡期的全局态文件名（迁移源；扫描时排除） */
export const LEGACY_GLOBAL_FILE_NAME = '_global.json';

/**
 * 单会话文件形态（**只装会话属性**）
 *
 * `meta` 可为 null（内核分叉先 setRoundIds 后 updateSessionMeta 的时序窗口内只有 roundIds）；
 * `sessionId` 写在内容里而**不是**从文件名反解——会话名可能含路径分隔符等不安全字符。
 *
 * `roundIds` 是**遗留内联字段，只读兼容**：roundIds 的唯一真相已迁到同名 `.rounds` 文件。
 * 新代码**不得**再写该字段；`migrateInlineRoundIds` 在 load 期把它摊进 `.rounds` 后从 JSON 摘除。
 * 保留字段声明的唯一理由 = 旧档解析（含 `sessions.json.migrated` 回退副本）仍需识别它。
 *
 * `archived` / `lastActiveAt` 是**会话自身属性**（不是全局清单的两个条目）：
 *   - `archived`：留存区分组标签；缺省（不写 key）= 归属近期列表
 *   - `lastActiveAt`：该会话最后一次被浏览的时刻（ISO）；缺省 = 从未停留过
 * 两者都不参与任何数据判据，丢了只影响界面分组 / 默认落点。
 */
export interface SessionFileShape {
  sessionId: string;
  meta: SessionMeta | null;
  /** 遗留内联 roundIds（只读兼容；真相在同名 `.rounds` 文件，见模块头） */
  roundIds?: string[];
  /** 留存区标记（true = 留存区；省略 = 近期列表） */
  archived?: boolean;
  /** 上次停留时刻（ISO 8601；`getInitialSessionId` 取最大者） */
  lastActiveAt?: string;
}

/** 旧单文件形态（迁移源，字段名沿用旧版） */
interface LegacySessionFileShape {
  metas?: Record<string, SessionMeta>;
  roundIdsStore?: Record<string, string[]>;
  archivedIds?: string[];
  lastActiveSessionId?: string;
}

/** step 2 全局态形态（迁移源；`schemaVersion` 无消费者，迁移时直接丢弃） */
interface LegacyGlobalStateShape {
  lastActiveSessionId?: string;
  archivedIds?: string[];
}

/** 迁移所需路径（由 store 注入，避免在本模块重算目录布局） */
export interface SessionMigrationPaths {
  /** 旧单文件路径（迁移源） */
  legacyFilePath: string;
  /** 旧单文件迁移完成后的保留路径 */
  legacyMigratedPath: string;
  /** step 2 全局态文件路径（迁移源） */
  legacyGlobalPath: string;
  /** 全局态迁移完成后的保留路径 */
  legacyGlobalMigratedPath: string;
  /** 单会话文件路径（sessionId → 绝对路径） */
  sessionFilePath: (sessionId: string) => string;
}

/** 扫描会话目录得到的一份会话文件内容 */
export interface LoadedSessionFile {
  sessionId: string;
  meta: SessionMeta | null;
  roundIds: string[];
  archived: boolean;
  lastActiveAt: string | undefined;
}

/** roundIds 追加文件的后缀（与同名 `.json` 并列，一个会话两份文件） */
const ROUNDS_FILE_SUFFIX = '.rounds';

/** 半行裁断的最小静置时长（毫秒）：太新的文件可能是另一进程正在写，不能裁 */
const TORN_TAIL_MIN_AGE_MS = 2_000;

/**
 * 会话的 roundIds 追加文件路径
 *
 * 由 `.json` 路径换后缀得出（不重算编码）：两份文件名必须一一对应，任何一处自己拼
 * `encodeURIComponent(sessionId)` 都会在非常规字符上漂移（曾因此让读盘判据恒空）。
 *
 * @param sessionJsonPath 该会话的 JSON 绝对路径
 */
export function roundIdsPath(sessionJsonPath: string): string {
  return sessionJsonPath.replace(/\.json$/, ROUNDS_FILE_SUFFIX);
}

/**
 * 去重合并 + 求新增（**读写侧唯一去重判据**）
 *
 * 去重是必需而非优化：迁移断点续摊、截断后重写、重复 append 都可能让同一 id 出现两次；
 * 同一轮在 `indexOf` 取位 / 末位判定里出现两次会让截断锚点错位。
 * `fresh` 是 `incoming` 中此前未见过的部分（保序）——写侧据此只追加真正的新轮。
 */
export function appendFreshRoundIds(
  existing: readonly string[],
  incoming: readonly string[],
): { merged: string[]; fresh: string[] } {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const id of existing) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    merged.push(id);
  }
  const fresh: string[] = [];
  for (const id of incoming) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    merged.push(id);
    fresh.push(id);
  }
  return { merged, fresh };
}

/** 合并两组 roundId：前者在前，去重保序（唯一实现 = appendFreshRoundIds） */
export function mergeRoundIds(first: readonly string[], second: readonly string[]): string[] {
  return appendFreshRoundIds(first, second).merged;
}

/**
 * 读取 roundIds 追加文件（容错：半行 / 空行 / 重复一律就地消化）
 *
 * **半行判据**：末尾没有换行符的最后一段是崩溃时写了一半的行，丢弃——该 id 从未被完整登记，
 * 收下它会指向一个可能没写完的 Round。这是本形态唯一的崩溃恢复逻辑（无 WAL 扫描、无日志重放）。
 *
 * @param sessionJsonPath 该会话的 JSON 绝对路径（journal 取同名换后缀）
 * @returns 按追加序去重的 roundId 列表；文件不存在 / 读失败返回空数组
 */
export function readRoundIdsFile(sessionJsonPath: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(roundIdsPath(sessionJsonPath), 'utf8');
  } catch {
    return [];
  }
  const complete = raw.endsWith('\n') ? raw : raw.slice(0, raw.lastIndexOf('\n') + 1);
  return mergeRoundIds(
    complete.split('\n').map((line) => line.trim()),
    [],
  );
}

/**
 * 整写 roundIds 文件（截断 / 分叉 / setRoundIds 的**完整替换**）
 *
 * 与追加的唯一区别：它表达「删」，因此必须与另一窗口的追加互斥（调用方负责持锁）。
 * 用原子替换（tmp → rename）保证读侧永远看到完整列表。
 *
 * @param sessionJsonPath 该会话的 JSON 绝对路径
 * @param ids 目标完整列表（顺序即轮序）
 */
export function writeRoundIdsFile(sessionJsonPath: string, ids: readonly string[]): void {
  const body = ids.length > 0 ? `${ids.join('\n')}\n` : '';
  atomicWriteFileSync(roundIdsPath(sessionJsonPath), body);
}

/**
 * 追加 roundId 到 journal（**同步、无锁**——本形态的核心契约）
 *
 * 为什么无锁也安全：只写自己的行，不读旧内容 ⇒ 不存在「读旧写新覆盖对方」；
 * O_APPEND 下单行写入由文件系统串行化，多窗口并发追加互不覆盖。
 * 为什么同步：调用返回即盘面可见——进程被杀 / 视图销毁 / 重启都不会丢掉已产生的轮引用
 * （异步延后写的代价是「优雅退出才落盘」，而用户遇到的正是强制重启）。
 *
 * @param sessionJsonPath 该会话的 JSON 绝对路径
 * @param ids 待追加的 roundId（空数组直接返回，不建空文件）
 */
export function appendRoundIdsFile(sessionJsonPath: string, ids: readonly string[]): void {
  if (ids.length === 0) return;
  const path = roundIdsPath(sessionJsonPath);
  // 首次写入时会话目录可能尚不存在（新建会话的 setRoundIds 走 atomicWrite 会自建，
  // 但 append 是独立入口）：建目录的一次 stat 换「不因目录缺失丢轮」
  mkdirSync(dirname(path), { recursive: true });
  // 上次崩溃若留下半行，先裁掉再追加：否则新 id 会粘在半截 id 尾部，两个一起报废
  truncateTornTail(path);
  appendFileSync(path, ids.map((id) => `${id}\n`).join(''), 'utf8');
}

/**
 * 裁掉未封口的半行（崩溃撕裂残留），返回是否发生裁剪
 *
 * 只读尾部一个窗口（4KB，roundId 远短于此）找最后一个换行，然后 `ftruncate` 到该位置。
 * **裁断而非补换行**：补一个换行会把半截 id 变成合法行，永久污染引用集合
 * （多一个不存在的 roundId ⇒ 计数偏大、末位判定误判）；裁掉只丢那条本就没写完的登记。
 *
 * **静置判据**（`TORN_TAIL_MIN_AGE_MS`）：文件在最近 2 秒内被改过 ⇒ 不裁。
 * 另一进程可能正写到一半（同一毫秒窗口里它已把半行落盘），裁断会把**正在写的合法行**删掉
 * ——那是比「留一条半截 id」更坏的数据损失。一行 40 字节的写不可能耗时 2 秒，
 * 故「超龄未封口」只可能是崩溃残留。
 * 读/截失败一律不阻断追加（`appendFileSync` 自己会报错，此处不越权）。
 */
function truncateTornTail(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r+');
    const { size, mtimeMs } = fstatSync(fd);
    if (size === 0) return false;
    if (Date.now() - mtimeMs < TORN_TAIL_MIN_AGE_MS) return false; // 可能是别人正在写
    const window = Math.min(size, 4096);
    const buf = Buffer.alloc(window);
    readSync(fd, buf, 0, window, size - window);
    if (buf[window - 1] === 0x0a) return false; // 末字节已是换行：无半行
    let cut = 0;
    for (let i = window - 1; i >= 0; i -= 1) {
      if (buf[i] === 0x0a) {
        cut = size - window + i + 1;
        break;
      }
    }
    ftruncateSync(fd, cut);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * 内联 roundIds → journal（**一次性迁移，可断点续摊**）
 *
 * 旧档把 roundIds 写在 JSON 里；本形态下 JSON 只装属性。迁移幂等：JSON 已无内联数组即跳过，
 * 因此中途崩溃（journal 已写、JSON 未重写）下次启动只会把同一批 id 再合并一遍（读侧去重）。
 *
 * 顺序不可交换：**先写 journal 再摘 JSON 字段**——反过来会在崩溃窗口里永久丢掉内联的那批 id。
 *
 * @param sessionsDir 会话目录
 */
export function migrateInlineRoundIds(sessionsDir: string): void {
  let names: string[];
  try {
    names = readdirSync(sessionsDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith('.json') || name.endsWith('.tmp')) continue;
    if (name === LEGACY_GLOBAL_FILE_NAME) continue;
    const jsonPath = join(sessionsDir, name);
    let data: Partial<SessionFileShape>;
    try {
      data = JSON.parse(readFileSync(jsonPath, 'utf8')) as Partial<SessionFileShape>;
    } catch {
      continue; // 坏档跳过（readSessionFiles 同口径，不连坐其他会话）
    }
    const inline = Array.isArray(data.roundIds)
      ? data.roundIds.filter((id): id is string => typeof id === 'string')
      : [];
    if (inline.length === 0) continue;
    const merged = mergeRoundIds(inline, readRoundIdsFile(jsonPath));
    try {
      writeRoundIdsFile(jsonPath, merged);
      const next: SessionFileShape = {
        sessionId: typeof data.sessionId === 'string' ? data.sessionId : '',
        meta: (data.meta as SessionMeta | null) ?? null,
        ...(typeof data.archived === 'boolean' ? { archived: data.archived } : {}),
        ...(typeof data.lastActiveAt === 'string' ? { lastActiveAt: data.lastActiveAt } : {}),
      };
      atomicWriteFileSync(jsonPath, JSON.stringify(next, null, 2));
    } catch (err) {
      // 迁移失败不影响可读性：readSessionFiles 仍会把内联数组合并进来（本次启动照常可见）
      console.warn(`Memora 内联 roundIds 迁移失败，下次启动重试：${name}`, err);
    }
  }
}

/**
 * 旧单文件 → 每会话文件（可重入 / 可断点续摊）
 *
 * 触发判据 = **旧 `sessions.json` 仍存在**（未被改名为 `.migrated`），与会话目录空不空无关：
 * 摊到一半崩溃时，`sessions/` 已非空但旧文件仍在 ⇒ 下次启动继续补摊缺失的会话。
 * 旧档里的 `archivedIds` 是**最老形态**（归档标记还写在会话清单里）：摊平会话文件时
 * 顺带把标记写进对应会话文件的 `archived` 字段，不另起一套迁移。
 */
export function migrateLegacySessionFile(paths: SessionMigrationPaths): void {
  if (!existsSync(paths.legacyFilePath)) return;
  let legacy: LegacySessionFileShape;
  try {
    legacy = JSON.parse(readFileSync(paths.legacyFilePath, 'utf8')) as LegacySessionFileShape;
  } catch (err) {
    // 坏档不删（保留可人工修复），只告警；本次启动只见已有会话文件
    console.warn('Memora 旧会话单文件损坏，跳过迁移（文件保留）', err);
    return;
  }
  const archivedIds = new Set(
    Array.isArray(legacy.archivedIds)
      ? legacy.archivedIds.filter((id): id is string => typeof id === 'string')
      : [],
  );
  const ids = new Set<string>([
    ...Object.keys(legacy.metas ?? {}),
    ...Object.keys(legacy.roundIdsStore ?? {}),
  ]);
  // 旧档的导航指针（若有）落到目标会话文件：取迁移时刻，使其在这次迁移后仍胜出
  const migratedAt = new Date().toISOString();
  for (const sessionId of ids) {
    const target = paths.sessionFilePath(sessionId);
    // 已存在即视为「本次（或上次）已摊过」：以会话文件为准，不覆盖
    if (existsSync(target)) continue;
    const meta = legacy.metas?.[sessionId] ?? null;
    const roundIds = legacy.roundIdsStore?.[sessionId] ?? [];
    if (!meta && roundIds.length === 0) continue;
    const body: SessionFileShape = {
      sessionId,
      meta,
      ...(archivedIds.has(sessionId) ? { archived: true } : {}),
      ...(legacy.lastActiveSessionId === sessionId ? { lastActiveAt: migratedAt } : {}),
    };
    // 先 journal 后 JSON：判断「是否已摊过」只认 JSON 存在与否，先写 JSON 会让崩溃窗口里
    // 那批 roundIds 永久丢失（下次启动因「已存在跳过」不再补摊）。反序则幂等可重入。
    writeRoundIdsFile(target, roundIds);
    atomicWriteFileSync(target, JSON.stringify(body, null, 2));
  }
  // 全部补齐后才落幕：改名保留（回退副本）。Windows 下目标已存在 rename 会失败，先清旧副本
  try {
    if (existsSync(paths.legacyMigratedPath)) unlinkSync(paths.legacyMigratedPath);
    renameSync(paths.legacyFilePath, paths.legacyMigratedPath);
  } catch (err) {
    // 改名失败不影响可读性（下次启动重试；本轮已补齐全部会话）
    console.warn('Memora 旧会话单文件改名失败，下次启动重试', err);
  }
}

/**
 * step 2 全局态 → 会话自身属性（可重入 / 可断点续摊，复用同一套「已存在跳过」纪律）
 *
 * 触发判据 = **`_global.json` 仍存在**（未改名 `.migrated`），与文件内容无关：
 * 摊到一半崩溃时 `_global.json` 仍在 ⇒ 下次启动继续补摊；已打标字段的文件跳过
 * （`archived` 已存在 / `lastActiveAt` 已存在 = 上次已写过，以会话文件为准不覆盖）。
 *
 * 两个字段的去向：
 *   - `archivedIds` → 对应会话文件的 `archived: true`（归档是会话自身属性）
 *   - `lastActiveSessionId` → 对应会话文件的 `lastActiveAt`（取迁移时刻，使旧指针仍胜出）
 * 目标会话文件不存在 ⇒ 跳过（幽灵 id 不再落盘，界面对照会话列表自然看不见）。
 */
export function migrateLegacyGlobalState(paths: SessionMigrationPaths): void {
  if (!existsSync(paths.legacyGlobalPath)) return;
  let legacy: LegacyGlobalStateShape;
  try {
    legacy = JSON.parse(readFileSync(paths.legacyGlobalPath, 'utf8')) as LegacyGlobalStateShape;
  } catch (err) {
    console.warn('Memora 旧全局态文件损坏，跳过迁移（文件保留）', err);
    return;
  }
  const archivedIds = new Set(
    Array.isArray(legacy.archivedIds)
      ? legacy.archivedIds.filter((id): id is string => typeof id === 'string')
      : [],
  );
  const lastActive =
    typeof legacy.lastActiveSessionId === 'string' ? legacy.lastActiveSessionId : '';
  const patch = (sessionId: string, add: Partial<SessionFileShape>): void => {
    const path = paths.sessionFilePath(sessionId);
    if (!existsSync(path)) return;
    try {
      const data = JSON.parse(readFileSync(path, 'utf8')) as Partial<SessionFileShape>;
      // 已有字段 = 上次迁移已写过（会话文件是更新的事实），不覆盖
      const next: SessionFileShape = {
        sessionId: typeof data.sessionId === 'string' ? data.sessionId : sessionId,
        meta: (data.meta as SessionMeta | null) ?? null,
        ...(typeof data.archived === 'boolean' ? { archived: data.archived } : {}),
        ...(typeof data.lastActiveAt === 'string' ? { lastActiveAt: data.lastActiveAt } : {}),
      };
      if (typeof data.archived !== 'boolean' && add.archived) next.archived = true;
      if (typeof data.lastActiveAt !== 'string' && add.lastActiveAt) {
        next.lastActiveAt = add.lastActiveAt;
      }
      atomicWriteFileSync(path, JSON.stringify(next, null, 2));
    } catch (err) {
      console.warn(`Memora 全局态迁移失败，跳过：${sessionId}`, err);
    }
  };
  for (const sessionId of archivedIds) patch(sessionId, { archived: true });
  if (lastActive) patch(lastActive, { lastActiveAt: new Date().toISOString() });
  // 全部补齐后才落幕（回退副本；此后不再读取）
  try {
    if (existsSync(paths.legacyGlobalMigratedPath)) unlinkSync(paths.legacyGlobalMigratedPath);
    renameSync(paths.legacyGlobalPath, paths.legacyGlobalMigratedPath);
  } catch (err) {
    console.warn('Memora 旧全局态文件改名失败，下次启动重试', err);
  }
}

/**
 * 扫描会话目录并解析每份会话文件
 *
 * 白名单判据：只认 `*.json`，排除 `_global.json` 与 `*.tmp`（否则临时/全局文件会被当会话）；
 * `.rounds` 不以 `.json` 结尾，天然被排除；`.migrated` 同理。单文件坏只丢这一个会话，
 * 不连坐其他会话。
 *
 * roundIds = **journal（真相）+ JSON 内联遗留（迁移中/未迁移）合并去重**：合并而非二选一，
 * 是为了让「迁移写了一半」的档在本次启动照常可见（宁可多算，不可少算——少算会让轮被判成孤儿）。
 */
export function readSessionFiles(sessionsDir: string): LoadedSessionFile[] {
  let names: string[];
  try {
    names = readdirSync(sessionsDir);
  } catch (err) {
    console.warn('Memora 会话目录读取失败，降级为空', err);
    return [];
  }
  const loaded: LoadedSessionFile[] = [];
  for (const name of names) {
    if (!name.endsWith('.json') || name.endsWith('.tmp')) continue;
    if (name === LEGACY_GLOBAL_FILE_NAME) continue;
    const jsonPath = join(sessionsDir, name);
    try {
      const data = JSON.parse(readFileSync(jsonPath, 'utf8')) as Partial<SessionFileShape>;
      // **以文件内 sessionId 为准，不靠文件名反解**（会话名可能含分隔符，文件名是编码形态）
      const sessionId = data.sessionId;
      if (typeof sessionId !== 'string' || sessionId.length === 0) continue;
      const inline = Array.isArray(data.roundIds)
        ? data.roundIds.filter((id): id is string => typeof id === 'string')
        : [];
      loaded.push({
        sessionId,
        meta: data.meta && typeof data.meta === 'object' ? (data.meta as SessionMeta) : null,
        roundIds: mergeRoundIds(inline, readRoundIdsFile(jsonPath)),
        archived: data.archived === true,
        lastActiveAt:
          typeof data.lastActiveAt === 'string' && data.lastActiveAt.length > 0
            ? data.lastActiveAt
            : undefined,
      });
    } catch (err) {
      // 单文件坏只丢这一个会话，不连坐其他会话（旧实现是整份清空）
      console.warn(`Memora 会话文件损坏，跳过：${name}`, err);
    }
  }
  return loaded;
}

/**
 * 所有「可续跑轮」的 Round ID 集合（**历史只读写入闸真源**）
 *
 * 判据 = 该轮是**所有引用它的会话** `roundIds` 的最后一个元素（全局末位）。
 * 共享轮只要在任一会话里不是末位，就属于那个会话的历史 ⇒ 排除（禁止借道改写）。
 * 不用 `updatedAt` 比大小、不另存「当前轮」字段。
 */
export function collectContinuableRoundIds(sessionsDir: string): string[] {
  // 所有会话的末位元素（候选）
  const lastOfSession = new Set<string>();
  // 所有出现在任何会话「非末位」位置的元素（一票否决）
  const nonLast = new Set<string>();
  for (const file of readSessionFiles(sessionsDir)) {
    const ids = file.roundIds;
    if (ids.length === 0) continue;
    lastOfSession.add(ids[ids.length - 1]!);
    for (let i = 0; i < ids.length - 1; i += 1) nonLast.add(ids[i]!);
  }
  return Array.from(lastOfSession).filter((id) => !nonLast.has(id));
}

/**
 * 所有会话引用到的 Round ID 全集（**删除闸真源**）
 *
 * 每次调用都扫全部会话文件求并集——进程内 `roundIdsStore` 只是本进程快照，
 * 看不见别窗口新建 / 分叉的会话。
 */
export function collectReferencedIds(sessionsDir: string): string[] {
  const ids = new Set<string>();
  for (const file of readSessionFiles(sessionsDir)) {
    for (const id of file.roundIds) ids.add(id);
  }
  return Array.from(ids);
}
