/**
 * 工作区问答闭环存储 — IRoundStore 实现（JSON 文件落盘）
 *
 * 设计理念：
 * - 每个 Round 存为独立文件（rounds/{roundId}.json）
 * - 索引文件维护 Round ID → 状态的映射
 * - 支持批量读取，避免 N+1 查询
 * - 原子写入保证数据安全
 *
 * 存储结构：
 * ```
 * .memora/
 *   rounds/
 *     index.json          # Round 索引（id → status + refCount）
 *     {roundId}.json      # 单个 Round 的完整数据
 *     ...
 * ```
 */

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Round, RoundStatus, IRoundStore } from '@zooique/memora';
import { logger } from '@zooique/memora';
import { atomicWriteFileSync } from './atomicWriteSync.js';

/**
 * Round 索引条目：存储在 index.json 中
 *
 * 轻量级元数据，用于快速查询状态和引用计数
 */
interface RoundIndexEntry {
  /** Round ID */
  id: string;
  /** 状态 */
  status: RoundStatus;
  /** 引用计数 */
  refCount: number;
  /** 创建时间 */
  createdAt: string;
  /** 文件路径（相对于 rounds 目录） */
  file: string;
}

/**
 * 孤儿清扫的默认存活保护（24h）。
 *
 * 进行中轮（pending）的 refCount 恒为 0——MessageHistory.appendUser 写入时即 0，
 * complete 时才 incrementRef。因此清扫必须带存活保护，否则会删掉「用户已提问、
 * LLM 尚未作答」的轮（窗口重载 / 崩溃重启时静默丢失）。
 *
 * 24h 是保守取值：孤儿回收属后台维护，延迟一天无副作用；远大于任何正常对话的等待时长。
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

  constructor(workspacePath: string) {
    this.roundsDir = join(workspacePath, '.memora', 'rounds');
    this.indexPath = join(this.roundsDir, 'index.json');
  }

  /**
   * 启动时从文件加载索引和数据
   */
  load(): void {
    // 加载索引
    if (existsSync(this.indexPath)) {
      try {
        const raw = readFileSync(this.indexPath, 'utf8');
        const entries = JSON.parse(raw) as RoundIndexEntry[];
        for (const entry of entries) {
          this.index.set(entry.id, entry);
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
   * 保存索引到文件
   */
  private saveIndex(): void {
    const entries = Array.from(this.index.values());
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

    // 更新索引
    const entry: RoundIndexEntry = {
      id: round.id,
      status: round.status,
      refCount: round.refCount,
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
   * 增加引用计数
   */
  incrementRef(roundId: string): void {
    // 更新索引
    const entry = this.index.get(roundId);
    if (!entry) {
      logger.warn({ roundId }, 'incrementRef: Round 不存在');
      return;
    }
    entry.refCount++;
    this.index.set(roundId, entry);

    // 更新缓存中的 Round
    const cached = this.cache.get(roundId);
    if (cached) {
      cached.refCount = entry.refCount;
      this.cache.set(roundId, cached);
    }

    // 写入文件（如果在缓存中）
    if (cached) {
      const filePath = this.getRoundFilePath(roundId);
      atomicWriteFileSync(filePath, JSON.stringify(cached, null, 2));
    }

    // 保存索引
    this.saveIndex();
  }

  /**
   * 减少引用计数
   */
  decrementRef(roundId: string): void {
    // 更新索引
    const entry = this.index.get(roundId);
    if (!entry) {
      logger.warn({ roundId }, 'decrementRef: Round 不存在');
      return;
    }
    if (entry.refCount > 0) {
      entry.refCount--;
      this.index.set(roundId, entry);
    }

    // 更新缓存中的 Round
    const cached = this.cache.get(roundId);
    if (cached) {
      cached.refCount = entry.refCount;
      this.cache.set(roundId, cached);
    }

    // 写入文件（如果在缓存中）
    if (cached) {
      const filePath = this.getRoundFilePath(roundId);
      atomicWriteFileSync(filePath, JSON.stringify(cached, null, 2));
    }

    // 保存索引
    this.saveIndex();
  }

  /**
   * 删除问答闭环
   */
  delete(roundId: string): boolean {
    const entry = this.index.get(roundId);
    if (!entry) return false;

    // 检查引用计数
    if (entry.refCount > 0) {
      logger.warn({ roundId, refCount: entry.refCount }, 'delete: Round 仍被引用，无法删除');
      return false;
    }

    // 删除文件
    const filePath = this.getRoundFilePath(roundId);
    try {
      if (existsSync(filePath)) {
        unlinkSync(filePath);
      }
    } catch (err) {
      logger.error({ roundId, err }, '删除 Round 文件失败');
      return false;
    }

    // 移除索引
    this.index.delete(roundId);

    // 移除缓存
    this.cache.delete(roundId);

    // 保存索引
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
   * 获取孤立的问答闭环
   *
   * @param minAgeMs 仅回收存活超过该时长的孤儿，**默认 24h**（见 DEFAULT_SWEEP_MIN_AGE_MS）。
   *   传 0 = 关闭存活保护，会连带删除**进行中**轮（pending 的 refCount 恒为 0），属数据丢失风险。
   */
  listOrphaned(minAgeMs: number = DEFAULT_SWEEP_MIN_AGE_MS): Round[] {
    const now = Date.now();
    const minAgeMsSec = minAgeMs / 1000;
    const results: Round[] = [];

    for (const [id, entry] of this.index) {
      // 检查引用计数
      if (entry.refCount > 0) continue;

      // 检查存活时间
      const createdAtMs = new Date(entry.createdAt).getTime();
      const ageSec = (now - createdAtMs) / 1000;
      if (ageSec < minAgeMsSec) continue;

      // 孤儿 = 无引用且超龄：pending/error 崩溃残留同样回收，
      // 进行中轮由 minAgeMs 兜底保护（minAgeMsSec 判龄已在上方过滤）

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
   * 崩溃发生在 appendAssistant 完成前：该轮 refCount=0、未登记会话 roundIds，宿主从会话列表
   * 无法发现；但其过程可能已由 step 原子检查点落盘到 pending Round——重启后经此只读口
   * 「找到」，再由宿主收场方法（chatPanel.upgradeInterruptedRounds → 内核
   * MessageHistory.appendInterrupted）**升级为正常 stop turn**（非半成品草稿）。
   * 只读、不登记会话、不改写；升级完成（complete + refCount>0）前为打捞窗口内中间态，
   * 超龄未升级的中断轮仍由 sweepOrphans 回收（默认 24h 存活保护覆盖打捞窗口，不误回收）。
   *
   * @param date - YYYY-MM-DD，按 createdAt 前缀匹配（ISO 头 10 位）
   * @param limit - 最多条数，按 createdAt 降序（最新在前）；缺省不截断
   * @returns 中断残留 Round 数组（倒序）
   */
  listInterruptedRecent(date: string, limit?: number): Round[] {
    // 崩溃残留轮 = refCount 0 + 未完成（pending/error），按创建日期精确过滤；先索引判型避免全量读盘
    //
    // ⚠️ `'error'` 是**预留态**（明示收起，与内核
    // `inMemoryRoundStore.listInterruptedRecent` 同款语义）——全仓零写点，仅与 'pending'
    // 共用本打捞条件。⚠️ `interrupted` **不入本打捞口**：运行期收场已
    // 即时标 interrupted 且 refCount 0→1，不再符合 `refCount===0` 的崩溃孤儿条件，属"已收场的
    // 停 turn"。**勿因 grep 到零写点而删**（它是打捞条件的组成部分，非死代码）。
    const candidates = Array.from(this.index.values())
      .filter((e) => e.refCount === 0 && (e.status === 'pending' || e.status === 'error'))
      .filter((e) => e.createdAt.startsWith(date))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const slice = limit !== undefined ? candidates.slice(0, limit) : candidates;
    // 命中后才读完整 Round（多步查询只对命中的走盘，避免一次枚举全量物理读写）
    return slice.map((e) => this.getById(e.id)).filter((r): r is Round => r !== null);
  }

  /**
   * 清扫无引用孤儿 Round（refCount=0）：删除会话/截断后遗留的物理文件统一回收。
   *
   * SSOT：Round 物理生命周期归 RoundStore（引用归 SessionStore）——deleteSession/truncate
   * 只负责减引用，物理回收统一收敛到本方法与 deleteSession 内联删除，不做第二套清理逻辑。
   *
   * @param minAgeMs 存活保护（毫秒）：仅清理创建超过该时长的孤儿，防误删进行中/刚崩溃的轮。
   *   **默认 24h**（见 DEFAULT_SWEEP_MIN_AGE_MS）——默认值必须是安全值：进行中轮（pending）的
   *   refCount 恒为 0（MessageHistory.appendUser 写入时即 0，complete 才 incrementRef），
   *   若默认为 0 则启动清扫会删掉用户已提问、LLM 尚未作答的轮，属静默数据丢失。
   * @returns 本次清扫（物理删除）的 Round ID 列表——清扫产物交给调用方，
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
  // 全仓零调用、零测试，且它会破坏 `cache.refCount ≡ index.refCount ≡ 文件 refCount`
  // 不变量——incrementRef/decrementRef 只在 cached 命中时回写 Round 文件，清缓存会让
  // 文件里的 refCount 停在旧值（索引与文件分叉，重载后 round.refCount 读到脏值）。
  // 需要回收内存时应删「条目」而非「整体清空」（走 delete() 语义）。
}
