/**
 * 工作区问答闭环存储 — IRoundStore 实现（JSON 文件落盘）
 *
 * 设计理念：
 * - 每个 Round 存为独立文件（rounds/{roundId}.json）
 * - 索引文件是**派生缓存**（Round ID → 状态），不含引用信息
 * - 支持批量读取，避免 N+1 查询
 * - 原子写入保证数据安全
 *
 * 存储结构：
 * ```
 * .memora/
 *   rounds/
 *     index.json          # 派生索引（id → status + createdAt），可重建，非引用真源
 *     {roundId}.json      # 单个 Round 的完整数据（写完永不改写，引用变化不动它）
 *     .trash/             # 删除回收站（保留 7 天；**不属于活轮集合**，任何扫描必须跳过）
 *     ...
 * ```
 *
 * 🔴 引用真源 = `WorkspaceSessionStore` 的会话 roundIds（见 `setReferencedIdsProvider`）；
 * 轮对象上不持有任何引用状态，旧档 JSON 里的历史引用字段读入即忽略（不判、不改、不回写）。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Round, RoundStatus, IRoundStore } from '@zooique/memora';
import { logger, isRoundSettled, isWithinLocalDay } from '@zooique/memora';
import { atomicWriteFileSync } from './atomicWriteSync.js';
import { resolveProjectDataDir } from './projectDataDir.js';

/**
 * Round 索引条目：存储在 index.json 中
 *
 * 轻量级派生元数据，仅用于快速查询状态；**不写引用计数**（引用真源在会话 roundIds）。
 */
interface RoundIndexEntry {
  /** Round ID */
  id: string;
  /** 状态 */
  status: RoundStatus;
  /** 创建时间 */
  createdAt: string;
  /** 文件路径（相对于 rounds 目录） */
  file: string;
}

/** 回收站目录名（与 rounds/*.json 同层，明确不属于活轮集合） */
export const ROUND_TRASH_DIR_NAME = '.trash';

/**
 * 「盘上新鲜读」能力（`WorkspaceRoundStore.getByIdFresh` 提供，不在内核 IRoundStore 契约内）
 *
 * 已收场轮的事件落盘必须基于盘上现值；`getById` 可能返回本进程旧缓存快照，
 * 用它整轮 `save` 会把旧正文写回盘（等于改写历史）。消费方用结构化探测，缺失即 fail-closed。
 */
export interface FreshRoundReadable {
  getByIdFresh(roundId: string): Round | null;
}

/** 判断某 roundStore 是否具备「盘上新鲜读」能力 */
export function hasFreshRoundRead(store: IRoundStore): store is IRoundStore & FreshRoundReadable {
  return typeof (store as Partial<FreshRoundReadable>).getByIdFresh === 'function';
}

/** 回收站保留期（7 天）：到期由 load() 清理，删除后仍可人工找回 */
export const ROUND_TRASH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 孤儿清扫的默认存活保护（24h）。
 *
 * 判据 = 「不在任何会话 roundIds 中」（由 sessionStore 现场派生）。
 * 存活保护给「刚失去引用」的轮留后悔窗口：**刚删会话的轮 24h 内不动物理文件**
 * （`deleteSession` 复用本判据；截断 `truncateFrom` 是用户显式操作、调用方持有会话锁，
 * 不经本保护、即时回收）。
 * 本常量是 listOrphaned / sweepOrphans 的默认参数——危险 API 必须有安全默认值，
 * 调用方想关闭保护须显式传 0。
 */
export const DEFAULT_SWEEP_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Round 落盘字段白名单（穷尽 `keyof Round`，内核加字段即编译红）
 *
 * 为什么落盘要显式挑字段：`loadRoundFromFile` 是 `JSON.parse(raw) as Round`（不剥未知键），
 * `getByIdFresh` 又把对象浅拷贝原样交出 ⇒ 旧档里的历史键会顺着「读 → 改 → 写」被回写，
 * 文件头承诺的「旧档历史引用字段不回写」就落空（实证路径：`roundEventCheckpoint` 对已收场
 * 旧轮就是 fresh 读 → 改 → save）。本表让轮文件写侧与索引侧（只写 4 个派生字段）口径一致。
 *
 * 🔴 穷尽约束 = 消费者侧的漂移警报：内核给 `Round` 增删字段时这里必然编译红，
 * 补/删一行即可；**不要**改成 `Object.keys` 动态推断（那会把新字段静默漏写）。
 */
const ROUND_PERSISTED_KEYS: Record<keyof Round, true> = {
  id: true,
  userMessage: true,
  assistantMessage: true,
  interactiveInputs: true,
  pendingAsk: true,
  evidence: true,
  assistantLog: true,
  status: true,
  createdAt: true,
  completedAt: true,
  processEvents: true,
};

/**
 * 只挑已知字段（丢弃旧档残留键与任何非 Round 键）
 *
 * 值为 `undefined` 的键不落盘（与内核「可选字段缺省即不写」的零冗余口径一致）。
 */
function pickRoundFields(round: Round): Round {
  /** 待落盘对象（键集合 = ROUND_PERSISTED_KEYS） */
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(ROUND_PERSISTED_KEYS) as (keyof Round)[]) {
    if (round[key] !== undefined) out[key] = round[key];
  }
  return out as unknown as Round;
}

/**
 * 工作区问答闭环存储
 */
export class WorkspaceRoundStore implements IRoundStore {
  /** Round 数据缓存（id → Round） */
  private cache: Map<string, Round> = new Map();
  /** Round 索引缓存（id → RoundIndexEntry） */
  private index: Map<string, RoundIndexEntry> = new Map();
  /** rounds 目录绝对路径 */
  private readonly roundsDir: string;
  /** 索引文件路径 */
  private readonly indexPath: string;
  /** 回收站目录绝对路径（`.trash`，活轮扫描的显式排除面） */
  private readonly trashDir: string;
  /**
   * 引用真源提供者（由 `WorkspaceSessionStore` 注入）
   *
   * 本存储不持有会话，无法自行判定「是否仍被引用」；未注入时 `listOrphaned` 返回空
   * （宁可不回收，也不按过期引用信息误删用户数据）。
   */
  private referencedIdsProvider: (() => ReadonlySet<string>) | null = null;
  /**
   * 「可续跑轮」提供者（历史只读写入闸的真源，由 `WorkspaceSessionStore` 注入）
   *
   * 判据 = 该 Round 是**所有引用它的会话** `roundIds` 的最后一个元素（全局末位）。
   * 为什么不是「任一会话末位」：共享轮在 A 是中间轮、在 B 是末位时，从 A 的视角它仍是历史，
   * 允许 B 改写等于借道改写 A 的历史。真源现场扫会话文件，不用 `updatedAt` 比大小、
   * 不另存「当前轮」字段（见台账 `ROUND-HISTORY-READONLY-1`）。
   * 未注入时写入闸关闭（单进程 / 测试模式，与跨进程锁同款装配纪律）。
   */
  private continuableRoundIdsProvider: (() => ReadonlySet<string>) | null = null;

  constructor(workspacePath: string) {
    // 轮次目录经单点推导（唯一计算点 = projectDataDir.ts，禁就地拼字面量）
    this.roundsDir = join(resolveProjectDataDir(workspacePath), 'rounds');
    this.indexPath = join(this.roundsDir, 'index.json');
    this.trashDir = join(this.roundsDir, ROUND_TRASH_DIR_NAME);
  }

  /**
   * 注入引用真源（引用真源 = 会话 roundIds；单一来源，禁止第二份计数）
   *
   * @param provider - 返回当前被任意会话引用的 Round ID 集合
   */
  setReferencedIdsProvider(provider: () => ReadonlySet<string>): void {
    this.referencedIdsProvider = provider;
  }

  /**
   * 注入「可续跑轮」真源（唯一物理写通道 `save()` 的判据来源）
   *
   * @param provider - 返回「在所有引用会话中都处于末位」的 Round ID 集合
   */
  setContinuableRoundIdsProvider(provider: () => ReadonlySet<string>): void {
    this.continuableRoundIdsProvider = provider;
  }

  /**
   * 启动时从文件加载索引和数据
   *
   * 先读 `index.json`（派生缓存），再用盘上真实轮文件**补缺 / 摘除幽灵条目**：
   * 覆盖「`save()` 写完轮文件、还没写索引就崩溃」的窗口——轮文件在盘上而索引缺条目时，
   * `getById` 会因 `index.has` 为假而永久看不见该轮。
   *
   * 只补缺、不造轮：反向「索引有条目、文件不存在」绝不创建轮文件，只把幽灵条目从内存摘除。
   * 扫描只认 `rounds/*.json` 直系文件 ⇒ `.trash/`（目录）天然不在活轮集合中，已删轮不会复活。
   *
   * 加载前先清理回收站中超过保留期的文件（保留期内可人工找回）。
   */
  load(): void {
    this.cleanupTrash();
    // 加载索引（旧档条目可能带历史引用字段：只取派生字段，副本作废）
    if (existsSync(this.indexPath)) {
      try {
        const raw = readFileSync(this.indexPath, 'utf8');
        const entries = JSON.parse(raw) as Array<Partial<RoundIndexEntry> & { id: string }>;
        for (const entry of entries) {
          if (!entry.id) continue;
          this.index.set(entry.id, {
            id: entry.id,
            status: entry.status as RoundStatus,
            createdAt: entry.createdAt ?? '',
            file: entry.file ?? `${entry.id}.json`,
          });
        }
      } catch (err) {
        logger.warn({ err }, 'Round 索引文件读取失败');
        this.index.clear();
      }
    }

    // 用盘上真实轮文件校正派生索引（补缺 + 摘除幽灵条目）
    this.reconcileIndexWithRoundFiles();

    // 预热缓存：加载最近的 Round（可选，避免一次性加载全部）
    // 生产环境可以按需加载，这里保持简单
  }

  /**
   * 用盘上真实轮文件校正内存索引（**只补缺、不造轮**）
   *
   * - 轮文件在、索引缺条目 ⇒ 从文件读 `status` / `createdAt` 补入内存索引（补出的事实
   *   来自轮文件本身，不臆造）；
   * - 索引有条目、轮文件不在 ⇒ 从内存索引摘除（该文件已被删除 / 移入 `.trash`），
   *   **不创建任何轮文件**（这是防假数据，不是防漏）；
   * - 只认 `rounds/*.json` **直系文件**：`.trash/` 是目录、`index.json` 是索引自身、
   *   `*.tmp` 是原子写中间态，均不在活轮集合中 ⇒ 已删轮不会因重建而复活。
   *
   * 为什么补出的条目**不回写** `index.json`：索引是派生缓存，下一次 `save()` 的
   * `saveIndex()` 会自然带上；启动期额外写盘会与另一进程的 `save()` 争整份覆盖
   * （多实例下无数据目录级锁，见台账 `ROUNDSIDX-SHARED-1`），收益为零、风险为正。
   */
  private reconcileIndexWithRoundFiles(): void {
    // 首次启动尚无 rounds 目录：无可补，静默返回（不是异常）
    if (!existsSync(this.roundsDir)) return;
    let names: string[];
    try {
      names = readdirSync(this.roundsDir);
    } catch (err) {
      // 目录存在但不可读：保持索引原样（不能因此清空已有条目）
      logger.warn({ err }, 'rounds 目录扫描失败，跳过索引补缺');
      return;
    }
    /** 盘上真实存在的轮 ID 集合（反向摘除幽灵条目的判据） */
    const fileRoundIds = new Set<string>();
    for (const name of names) {
      // 只认 `{roundId}.json` 直系文件（目录名 / 中间态后缀在此自然被排除）
      if (!name.endsWith('.json')) continue;
      // 索引自身不是轮
      if (name === 'index.json') continue;
      const roundId = name.slice(0, -'.json'.length);
      if (!roundId) continue;
      fileRoundIds.add(roundId);
      // 条目已存在：不重复解析（存在性由上面的目录列表已经证实）
      if (this.index.has(roundId)) continue;
      const round = this.loadRoundFromFile(roundId);
      if (!round) {
        // 坏档 / 半截文件：跳过，不从坏数据臆造索引条目
        logger.warn({ roundId }, '轮文件无法解析，跳过索引补缺');
        continue;
      }
      // 索引条目是四字段结构（id / status / createdAt / file）：status 与 createdAt
      // 是下游 `listByStatus` / `listInterruptedRecent` / `listOrphaned` 的判据来源，
      // 缺失即写入 `undefined` ⇒ 这些查询会静默漏轮。缺字段的轮文件视为脏档，不补条目。
      if (typeof round.status !== 'string' || typeof round.createdAt !== 'string') {
        logger.warn({ roundId }, '轮文件缺 status/createdAt，跳过索引补缺（防下游读到 undefined）');
        continue;
      }
      this.index.set(roundId, {
        id: roundId,
        status: round.status,
        createdAt: round.createdAt,
        file: `${roundId}.json`,
      });
      logger.warn({ roundId }, '轮文件在盘上但索引缺条目，已补入派生索引（仅内存）');
    }
    // 反向：索引有条目但轮文件已不在 ⇒ 摘除幽灵条目（不创建轮文件）
    for (const roundId of Array.from(this.index.keys())) {
      if (fileRoundIds.has(roundId)) continue;
      this.index.delete(roundId);
      logger.warn({ roundId }, '索引条目对应轮文件不存在，已从派生索引摘除');
    }
  }

  /**
   * 清理回收站中超过保留期的文件（`.trash` 是唯一允许按目录扫描的入口）
   *
   * 文件名格式 `{roundId}.{trashAtMs}.json`：时间戳来自文件名而非 mtime
   * （rename 保留原文件 mtime，不能反映「何时被删」）。
   */
  private cleanupTrash(retentionMs: number = ROUND_TRASH_RETENTION_MS): void {
    if (!existsSync(this.trashDir)) return;
    const now = Date.now();
    let names: string[];
    try {
      names = readdirSync(this.trashDir);
    } catch (err) {
      logger.warn({ err }, '回收站目录读取失败，跳过清理');
      return;
    }
    for (const name of names) {
      const parts = name.split('.');
      if (parts.length !== 3 || parts[2] !== 'json') continue;
      const trashedAt = Number(parts[1]);
      if (!Number.isFinite(trashedAt)) continue;
      if (now - trashedAt < retentionMs) continue;
      try {
        unlinkSync(join(this.trashDir, name));
      } catch (err) {
        logger.warn({ err, name }, '回收站文件清理失败');
      }
    }
  }

  /**
   * 保存索引到文件（**副本作废**：只写派生字段，不写引用信息）
   */
  private saveIndex(): void {
    const entries: RoundIndexEntry[] = Array.from(this.index.values()).map((e) => ({
      id: e.id,
      status: e.status,
      createdAt: e.createdAt,
      file: e.file,
    }));
    atomicWriteFileSync(this.indexPath, JSON.stringify(entries, null, 2));
  }

  /**
   * 获取 Round 文件路径
   */
  private getRoundFilePath(roundId: string): string {
    return join(this.roundsDir, `${roundId}.json`);
  }

  /**
   * 从文件加载单个 Round
   */
  private loadRoundFromFile(roundId: string): Round | null {
    const filePath = this.getRoundFilePath(roundId);
    if (!existsSync(filePath)) return null;

    try {
      const raw = readFileSync(filePath, 'utf8');
      return JSON.parse(raw) as Round;
    } catch (err) {
      logger.error({ roundId, err }, 'Round 文件读取失败');
      return null;
    }
  }

  /**
   * 存储问答闭环（**唯一物理写通道**，历史只读闸也在这里）
   *
   * 🔴 历史只读判据（只此一道，不许各 append 各写一份）：
   *   已收场（complete / interrupted）的轮，**只有「所有引用会话的末位轮」**允许再次写入——
   *   这是唯一可续跑目标（暂停 / 中断后用户继续答，仍是同一个 roundId）；
   *   非末位轮的已收场内容一律拒绝落盘（任何 append / checkpoint 的整轮回写都到不了盘）。
   *
   * 判据真源 = 会话文件 `roundIds` 的**末位元素**（由 sessionStore 现场扫盘注入）；
   * 共享轮只要在**任一**引用会话里不是末位，即视为该会话的历史，禁止借道改写。
   * 不用 `updatedAt` 比大小、不另存「当前轮」字段。
   * 未注入 provider = 单进程 / 测试模式，闸关闭（生产装配点唯一：sessionStore 构造函数）。
   */
  save(round: Round): void {
    // 读盘上现值判「是否已收场」：不能读内存缓存（缓存可能是旧快照）
    const stored = this.loadRoundFromFile(round.id);
    if (stored && isRoundSettled(stored.status)) {
      const continuableRoundIds = this.continuableRoundIdsProvider?.();
      // provider 已注入（生产模式）但不含该轮 ⇒ 拒绝；未注入（测试模式）⇒ 放行
      if (continuableRoundIds && !continuableRoundIds.has(round.id)) {
        logger.warn(
          { roundId: round.id, storedStatus: stored.status },
          '拒绝写入：该轮已收场且不是所有引用会话的末位轮（历史只读）',
        );
        return;
      }
    }

    // 更新缓存
    this.cache.set(round.id, round);

    // 更新索引（派生副本：不写引用信息）
    const entry: RoundIndexEntry = {
      id: round.id,
      status: round.status,
      createdAt: round.createdAt,
      file: `${round.id}.json`,
    };
    this.index.set(round.id, entry);

    // 写入 Round 文件（只挑已知字段：旧档残留下来的历史键不会顺着「读 → 改 → 写」回写）
    const filePath = this.getRoundFilePath(round.id);
    atomicWriteFileSync(filePath, JSON.stringify(pickRoundFields(round), null, 2));

    // 保存索引
    this.saveIndex();
  }

  /**
   * 按 ID 从**盘上**读取新鲜内容（绕过内存缓存，读后以盘上值覆盖缓存）
   *
   * 用途：已收场轮的事件增量落盘（checkpoint）必须基于盘上现值，不能把调用方
   * 可能持有的旧快照正文写回去。返回浅拷贝，调用方改字段不会污染缓存。
   */
  getByIdFresh(roundId: string): Round | null {
    const round = this.loadRoundFromFile(roundId);
    if (!round) return null;
    this.cache.set(roundId, round);
    return { ...round };
  }

  /**
   * 按 ID 获取问答闭环
   */
  getById(roundId: string): Round | null {
    // 先查缓存
    const cached = this.cache.get(roundId);
    if (cached) return { ...cached };

    // 从索引判断是否存在
    if (!this.index.has(roundId)) return null;

    // 从文件加载
    const round = this.loadRoundFromFile(roundId);
    if (round) {
      this.cache.set(roundId, round);
      return { ...round };
    }

    return null;
  }

  /**
   * 批量获取问答闭环
   */
  getByIds(roundIds: string[]): Round[] {
    const results: Round[] = [];
    const missingIds: string[] = [];

    // 先查缓存
    for (const id of roundIds) {
      const cached = this.cache.get(id);
      if (cached) {
        results.push({ ...cached });
      } else {
        missingIds.push(id);
      }
    }

    // 从文件加载缺失的
    for (const id of missingIds) {
      if (!this.index.has(id)) continue;

      const round = this.loadRoundFromFile(id);
      if (round) {
        this.cache.set(id, round);
        results.push({ ...round });
      }
    }

    return results;
  }

  /**
   * 列出所有问答闭环
   */
  listAll(): Round[] {
    const results: Round[] = [];

    // 先收集缓存中的
    for (const [id, round] of this.cache) {
      // 检查索引是否存在（可能已被删除）
      if (this.index.has(id)) {
        results.push({ ...round });
      }
    }

    // 从索引加载未缓存的
    for (const [id] of this.index) {
      if (!this.cache.has(id)) {
        const round = this.loadRoundFromFile(id);
        if (round) {
          this.cache.set(id, round);
          results.push({ ...round });
        }
      }
    }

    return results;
  }

  /**
   * 删除问答闭环（物理层：移入 `.trash`，保留 7 天）
   *
   * 🔴 **引用即禁删**（机器判据，不靠调用方声明 origin）：仍被任意会话 `roundIds` 引用时
   * 直接返回 false。GC / 同步 / 分叉等后台动作因此删不掉历史轮。
   *
   * 用户显式删除的唯一链路 = `sessionStore.truncateFrom` / `deleteSession`：两者都**先收缩
   * 会话 roundIds 并落盘**，再当场重算引用集合，此处判据自然放行——没有「传 user 标记」的旁路。
   * 未注入 provider（单进程 / 测试模式）时闸关闭。
   *
   * 顺序：先 rename 到 `.trash`，再从 index/cache 摘除并保存索引。崩溃造成索引残留时，
   * 后续读取因文件不存在自然跳过；`.trash` 文件不属活轮集合。
   */
  delete(roundId: string): boolean {
    const entry = this.index.get(roundId);
    if (!entry) return false;

    // 引用真源现场派生（与 listOrphaned 同一 provider）
    const referenced = this.referencedIdsProvider?.();
    if (referenced?.has(roundId)) {
      logger.warn({ roundId }, '拒绝删除：该轮仍被会话引用（后台动作不得删历史）');
      return false;
    }

    const filePath = this.getRoundFilePath(roundId);
    if (existsSync(filePath)) {
      try {
        // 懒建回收站目录（.trash 与 *.json 同层，不属于活轮文件命名）
        mkdirSync(this.trashDir, { recursive: true });
        // 文件名带删除时刻，供 7 天保留期判定（rename 不改 mtime）
        renameSync(filePath, join(this.trashDir, `${roundId}.${Date.now()}.json`));
      } catch (err) {
        logger.error({ roundId, err }, 'Round 文件移入回收站失败');
        return false;
      }
    }

    // 从活轮集合摘除（索引 / 缓存）
    this.index.delete(roundId);
    this.cache.delete(roundId);
    this.saveIndex();
    return true;
  }

  /**
   * 按状态列出问答闭环
   */
  listByStatus(status: RoundStatus): Round[] {
    const results: Round[] = [];

    for (const [id, entry] of this.index) {
      if (entry.status === status) {
        // 尝试加载完整数据
        const round = this.getById(id);
        if (round) {
          results.push(round);
        }
      }
    }

    return results;
  }

  /**
   * 获取孤立的问答闭环（**不在任何会话 roundIds 中** 且超龄）
   *
   * 引用真源由 `sessionStore.referencedIds()` 现场注入；轮对象上不持引用状态。
   * 未注入真源时返回空数组——宁可不回收，也不按过期计数误删。
   *
   * 索引是派生缓存：只枚举索引条目（`.trash/` 不在索引中，天然排除）。
   *
   * @param minAgeMs 仅回收存活超过该时长的孤儿，**默认 24h**（见 DEFAULT_SWEEP_MIN_AGE_MS）。
   *   传 0 = 关闭存活保护：刚失去引用且超龄的轮会被立即移入回收站。
   */
  listOrphaned(minAgeMs: number = DEFAULT_SWEEP_MIN_AGE_MS): Round[] {
    const referenced = this.referencedIdsProvider?.();
    if (!referenced) return [];

    const now = Date.now();
    const results: Round[] = [];

    for (const [id, entry] of this.index) {
      // 检查引用集合（真源 = 会话 roundIds）
      if (referenced.has(id)) continue;

      // 检查存活时间
      const createdAtMs = new Date(entry.createdAt).getTime();
      // 无法解析的 createdAt 不参与回收（宁可不删，防止脏数据被瞬间清扫）
      if (!Number.isFinite(createdAtMs)) continue;
      if (now - createdAtMs < minAgeMs) continue;

      // 加载完整数据
      const round = this.getById(id);
      if (round) {
        results.push(round);
      }
    }

    return results;
  }

  /**
   * 列出指定日期最近未完成（pending/error）的崩溃残留轮（step 原子落盘）。
   *
   * 崩溃发生在 appendAssistant 完成前：该轮已建轮但尚未收场，会话列表按 roundIds
   * 仍能看到它；其过程可能已由 step 原子检查点落盘到 pending Round——重启后经此只读口
   * 「找到」，再由宿主收场方法（chatPanel.upgradeInterruptedRounds → 内核
   * MessageHistory.appendInterrupted）**升级为正常 stop turn**（非半成品草稿）。
   * 只读、不登记会话、不改写；超龄未升级的中断轮仍由 sweepOrphans 回收（默认 24h 存活保护）。
   *
   * @param date - YYYY-MM-DD **本地日期**（与会话 ID 日期同口径）：按本地日区间
   *   `[D 00:00, D+1 00:00)` 换算 UTC 后比较 createdAt——判据单点 = 内核 `isWithinLocalDay`
   *   （与内核 `InMemoryRoundStore` 同源，前缀匹配在凌晨窗口漏捞，E2E-TZ-SALVAGE-1）
   * @param limit - 最多条数，按 createdAt 降序（最新在前）；缺省不截断
   * @returns 中断残留 Round 数组（倒序）
   */
  listInterruptedRecent(date: string, limit?: number): Round[] {
    // 崩溃残留轮 = **未收场**（pending/error），按本地日区间过滤；先索引判型避免全量读盘
    //
    // ⚠️ `'error'` 是**预留态**（明示收起，与内核
    // `inMemoryRoundStore.listInterruptedRecent` 同款语义）——全仓零写点，仅与 'pending'
    // 共用本打捞条件。⚠️ `interrupted` **不入本打捞口**：它已是「已收场的停 turn」。
    // **勿因 grep 到零写点而删**（它是打捞条件的组成部分，非死代码）。
    //
    // 🔴 ADR-044：判据只看状态。打捞筛的是「收场与否」，与「有无会话引用」正交。
    const candidates = Array.from(this.index.values())
      .filter((e) => e.status === 'pending' || e.status === 'error')
      .filter((e) => isWithinLocalDay(e.createdAt, date))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const slice = limit !== undefined ? candidates.slice(0, limit) : candidates;
    // 命中后才读完整 Round（多步查询只对命中的走盘，避免一次枚举全量物理读写）
    return slice.map((e) => this.getById(e.id)).filter((r): r is Round => r !== null);
  }

  /**
   * 清扫无引用孤儿 Round（不在任何会话 roundIds 中）：删会话/截断后遗留的物理文件统一回收。
   *
   * SSOT：引用归 SessionStore（roundIds 真源），物理归 RoundStore；引用集合由
   * `sessionStore.referencedIds()` 注入（见 `setReferencedIdsProvider`）。
   *
   * @param minAgeMs 存活保护（毫秒）：仅清理创建超过该时长的孤儿，给「刚失去引用」的轮留后悔窗口。
   *   **默认 24h**（见 DEFAULT_SWEEP_MIN_AGE_MS）——默认值必须是安全值：调用方若默认传 0，
   *   用户刚删掉的会话/Round 会被立刻移入回收站。
   * @returns 本次清扫（移入回收站）的 Round ID 列表——清扫产物交给调用方，
   *   供延迟联动（如 Agent 装配后软删其 round-summary 摘要）；空数组 = 无孤儿
   */
  sweepOrphans(minAgeMs: number = DEFAULT_SWEEP_MIN_AGE_MS): string[] {
    const orphans = this.listOrphaned(minAgeMs);
    // 先收集后删：返回值即清扫产物（Round ID），调用方据此做「对称的另一半」联动——
    // 被清扫轮的 round-summary 需同步软删，否则成为可召回却溯源不到的悬空记忆。
    const sweptIds = orphans.map((round) => round.id);
    for (const round of orphans) {
      this.delete(round.id);
    }
    return sweptIds;
  }

  /**
   * 获取 Round 数量
   */
  size(): number {
    return this.index.size;
  }

  // ⚠️ 曾有 `clearCache()`（清空 cache、保留 index）已删除：
  // 全仓零调用、零测试，且它会破坏「cache / index / 文件」三者一致性——
  // 清缓存后重载可能读到陈旧内容。需要回收内存时应删「条目」而非「整体清空」（走 delete() 语义）。
}
