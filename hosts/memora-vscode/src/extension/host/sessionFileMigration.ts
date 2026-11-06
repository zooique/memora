/**
 * 会话文件迁移与扫描（从 `sessionStore` 外置：单一职责 + 宿主行数闸门）
 *
 * 两条迁移（旧单文件 → 每会话文件、step 2 全局态 → 会话自身属性）都在 `load()` 期执行，
 * 且**先于跨进程锁启用**（`extension.ts` 在 `load()` 之后才 `enableCrossProcessLock()`）——
 * 因此这里直连底层 `atomicWriteFileSync`，不走 store 的持锁写。该豁免面与残留风险
 * （`_global` patch 的读改写整份）见台账 `ARCHIVER-META-LOCKLESS-1`「豁免面复核」。
 *
 * 迁移纪律（沿用 store 内原注释，勿简化）：
 *   - 可重入 / 可断点续摊：`sessions/` 已存在的会话文件**一律跳过**（以文件为准，不覆盖）
 *   - 全部补齐后才把迁移源改名 `.migrated`（回退副本，不自动删除）
 *   - 最坏结果是「暂时少看见」，不是「永久少看见」
 */
import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionMeta } from '@zooique/memora';
import { atomicWriteFileSync } from './atomicWriteSync.js';

/** step 2 过渡期的全局态文件名（迁移源；扫描时排除） */
export const LEGACY_GLOBAL_FILE_NAME = '_global.json';

/**
 * 单会话文件形态
 *
 * `meta` 可为 null（内核分叉先 setRoundIds 后 updateSessionMeta 的时序窗口内只有 roundIds）；
 * `sessionId` 写在内容里而**不是**从文件名反解——会话名可能含路径分隔符等不安全字符。
 *
 * `archived` / `lastActiveAt` 是**会话自身属性**（不是全局清单的两个条目）：
 *   - `archived`：留存区分组标签；缺省（不写 key）= 归属近期列表
 *   - `lastActiveAt`：该会话最后一次被浏览的时刻（ISO）；缺省 = 从未停留过
 * 两者都不参与任何数据判据，丢了只影响界面分组 / 默认落点。
 */
export interface SessionFileShape {
  sessionId: string;
  meta: SessionMeta | null;
  roundIds: string[];
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
      roundIds,
      ...(archivedIds.has(sessionId) ? { archived: true } : {}),
      ...(legacy.lastActiveSessionId === sessionId ? { lastActiveAt: migratedAt } : {}),
    };
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
        roundIds: Array.isArray(data.roundIds) ? data.roundIds : [],
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
 * `.migrated` 不以 `.json` 结尾，天然被排除。单文件坏只丢这一个会话，不连坐其他会话。
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
    try {
      const data = JSON.parse(
        readFileSync(join(sessionsDir, name), 'utf8'),
      ) as Partial<SessionFileShape>;
      // **以文件内 sessionId 为准，不靠文件名反解**（会话名可能含分隔符，文件名是编码形态）
      const sessionId = data.sessionId;
      if (typeof sessionId !== 'string' || sessionId.length === 0) continue;
      loaded.push({
        sessionId,
        meta: data.meta && typeof data.meta === 'object' ? (data.meta as SessionMeta) : null,
        roundIds: Array.isArray(data.roundIds)
          ? data.roundIds.filter((id): id is string => typeof id === 'string')
          : [],
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
 * 所有会话末尾轮的 Round ID 集合（**历史只读写入闸真源**）
 *
 * 判据 = 每个会话文件 `roundIds` 的**最后一个元素**（唯一可续跑目标）；
 * 不用 `updatedAt` 比大小、不另存「当前轮」字段。
 */
export function collectTailRoundIds(sessionsDir: string): string[] {
  const ids: string[] = [];
  for (const file of readSessionFiles(sessionsDir)) {
    const tail = file.roundIds[file.roundIds.length - 1];
    if (tail) ids.push(tail);
  }
  return ids;
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
