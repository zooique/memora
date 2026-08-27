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
import type {
  Round,
  RoundStatus,
  IRoundStore,
} from '@zooique/memora';
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
      logger.warn(
        { roundId, refCount: entry.refCount },
        'delete: Round 仍被引用，无法删除',
      );
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
   */
  listOrphaned(minAgeMs: number = 0): Round[] {
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

      // 只清理 complete 状态的 Round
      if (entry.status !== 'complete') continue;

      // 加载完整数据
      const round = this.getById(id);
      if (round) {
        results.push(round);
      }
    }

    return results;
  }

  /**
   * 获取 Round 数量
   */
  size(): number {
    return this.index.size;
  }

  /**
   * 清除缓存（索引保留）
   *
   * 用于内存优化，不影响持久化数据
   */
  clearCache(): void {
    this.cache.clear();
  }
}
