/**
 * 工作区问答闭环存储 — IRoundStore 实现（JSON 文件落盘）
 *
 * 设计理念：
 * - 每个 Round 存为独立文件（rounds/{roundId}.json）
 * - 索引文件是**派生缓存**（Round ID → 状态），不含 refCount 等引用信息
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
 * `Round.refCount` 仅为旧档 schema 的存在性标记，任何判据与索引副本都不使用它。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Round, RoundStatus, IRoundStore } from '@zooique/memora';
import { logger, isWithinLocalDay } from '@zooique/memora';
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

/** 回收站保留期（7 天）：到期由 load() 清理，删除后仍可人工找回 */
export const ROUND_TRASH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 孤儿清扫的默认存活保护（24h）。
 *
 * 判据 = 「不在任何会话 roundIds 中」（由 sessionStore 现场派生，不读 refCount）。
 * 存活保护给「刚失去引用」的轮留后悔窗口：刚删会话/截断的轮 24h 内不动物理文件。
 * 本常量是 listOrphaned / sweepOrphans 的默认参数——危险 API 必须有安全默认值，
 * 调用方想关闭保护须显式传 0。
 */
export const DEFAULT_SWEEP_MIN_AGE_MS = 24 * 60 * 60 * 1000;

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
   * （宁可不回收，也不读过期 `refCount` 误删用户数据）。
   */
  private referencedIdsProvider: (() => ReadonlySet<string>) | null = null;

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
   * 启动时从文件加载索引和数据
   *
   * 只读 `index.json`，**不扫描 rounds 目录** ⇒ `.trash/` 天然不在活轮集合中。
   * 加载前先清理回收站中超过保留期的文件（保留期内可人工找回）。
   */
  load(): void {
    this.cleanupTrash();
    // 加载索引（旧档条目可能带 refCount：只取派生字段，副本作废）
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

    // 预热缓存：加载最近的 Round（可选，避免一次性加载全部）
    // 生产环境可以按需加载，这里保持简单
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
   * 保存索引到文件（**副本作废**：只写派生字段，不写 refCount）
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
   * 存储问答闭环
   */
  save(round: Round): void {
    // 更新缓存
    this.cache.set(round.id, round);

    // 更新索引（派生副本：不写 refCount）
    const entry: RoundIndexEntry = {
      id: round.id,
      status: round.status,
      createdAt: round.createdAt,
      file: `${round.id}.json`,
    };
    this.index.set(round.id, entry);

    // 写入 Round 文件
    const filePath = this.getRoundFilePath(round.id);
    atomicWriteFileSync(filePath, JSON.stringify(round, null, 2));

    // 保存索引
    this.saveIndex();
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
   * 增加引用计数（**no-op**：引用真源 = 会话 roundIds）
   *
   * 保留 API 仅供公开面兼容（7.0.0 移除）。**不得**产生任何持久化写入——
   * 分叉若在此改写轮次文件 / index.json，会破坏「分叉前后 rounds/*.json 字节不变」。
   */
  incrementRef(_roundId: string): void {
    // 有意为空：分叉只复制会话 roundIds 指针
  }

  /**
   * 减少引用计数（**no-op**：引用真源 = 会话 roundIds）
   *
   * 保留 API 仅供公开面兼容（7.0.0 移除）。删除会话 / 截断时先收缩会话 roundIds，
   * 再由 sessionStore 现场派生引用集合判 0。
   */
  decrementRef(_roundId: string): void {
    // 有意为空：引用变化只发生在 sessions.json
  }

  /**
   * 删除问答闭环（物理层：移入 `.trash`，保留 7 天）
   *
   * 🔴 **无 `refCount` 护栏**（该字段非引用真源）。调用方须先确认该轮已不在任何
   * 会话 roundIds 中；本方法负责「从活轮集合摘除 + 文件移入回收站」。
   *
   * 顺序：先 rename 到 `.trash`，再从 index/cache 摘除并保存索引。崩溃造成索引残留时，
   * 后续读取因文件不存在自然跳过；`.trash` 文件不属活轮集合。
   */
  delete(roundId: string): boolean {
    const entry = this.index.get(roundId);
    if (!entry) return false;

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
   * 引用真源由 `sessionStore.referencedIds()` 现场注入；本存储不读 `Round.refCount`。
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
    // 🔴 ADR-044：判据**不含 `refCount`**。打捞筛的是「收场与否」，与「有无会话引用」正交。
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
