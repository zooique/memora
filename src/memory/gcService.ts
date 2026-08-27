/**
 * 垃圾回收服务 —— 清理孤立的问答闭环和关联摘要
 *
 * 设计理念：
 * - 基于引用计数的自动清理机制
 * - 只清理 refCount === 0 且已完成的 Round
 * - 同时清理关联的记忆摘要（round-summary）
 * - 支持定时执行和手动触发
 *
 * 触发时机：
 * 1. 会话删除时，减少引用计数后检查
 * 2. 定时任务（如每天一次）自动执行
 * 3. 系统空闲时执行
 */

import type { IRoundStore, Round } from '@/memory/roundStore.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import { logger } from '@/logging/logger.js';
import { generateSummaryId } from '@/memory/roundStore.js';

/**
 * GC 配置选项
 */
export interface GCConfig {
  /**
   * 最小存活时间（毫秒）
   *
   * 避免清理正在使用的 Round：
   * - Round 创建后短时间内可能还在被引用
   * - 默认 5 分钟
   */
  minAgeMs: number;

  /**
   * 批处理大小
   *
   * 避免单次清理过多导致性能问题
   * - 默认 100
   */
  batchSize: number;

  /**
   * 是否同时清理关联的记忆摘要
   *
   * - true：删除 Round 时同时删除 round-summary 记忆
   * - false：只删除 Round，保留摘要（可能导致孤立摘要）
   * - 默认 true（推荐）
   */
  cleanUpMemory: boolean;

  /**
   * 是否记录详细日志
   *
   * - 默认 false（生产环境避免日志爆炸）
   */
  verbose: boolean;
}

/**
 * GC 结果统计
 */
export interface GCResult {
  /** 扫描的 Round 总数 */
  scanned: number;
  /** 发现的孤立 Round 数 */
  orphaned: number;
  /** 成功删除的 Round 数 */
  deleted: number;
  /** 因引用计数导致删除失败的数量 */
  failedDueToRefCount: number;
  /** 清理的记忆摘要数量 */
  memoryCleaned: number;
  /** 实际执行的时间（毫秒） */
  elapsedMs: number;
}

/**
 * 垃圾回收服务
 *
 * 使用方式：
 * ```typescript
 * const gc = new GCService(roundStore, memoryStorage);
 *
 * // 手动触发
 * const result = gc.run();
 *
 * // 配置定时任务
 * gc.startPeriodic(60 * 60 * 1000); // 每小时执行一次
 * gc.stopPeriodic();
 * ```
 */
export class GCService {
  private readonly roundStore: IRoundStore;
  private readonly memoryStorage: IMemoryStorage;
  private readonly config: GCConfig;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(roundStore: IRoundStore, memoryStorage: IMemoryStorage, config?: Partial<GCConfig>) {
    this.roundStore = roundStore;
    this.memoryStorage = memoryStorage;
    this.config = {
      minAgeMs: config?.minAgeMs ?? 5 * 60 * 1000, // 5 分钟
      batchSize: config?.batchSize ?? 100,
      cleanUpMemory: config?.cleanUpMemory ?? true,
      verbose: config?.verbose ?? false,
    };
  }

  /**
   * 执行垃圾回收
   *
   * 流程：
   * 1. 列出所有孤立的 Round（refCount === 0 且已完成）
   * 2. 分批删除孤立 Round
   * 3. 同时清理关联的记忆摘要
   *
   * @returns GC 结果统计
   */
  run(): GCResult {
    const startTime = Date.now();
    const result: GCResult = {
      scanned: 0,
      orphaned: 0,
      deleted: 0,
      failedDueToRefCount: 0,
      memoryCleaned: 0,
      elapsedMs: 0,
    };

    try {
      // 1. 获取所有孤立的 Round
      // listOrphaned 可能是可选方法，需要检查
      const listOrphanedFn = this.roundStore.listOrphaned;
      const orphanedRounds = listOrphanedFn
        ? listOrphanedFn.call(this.roundStore, this.config.minAgeMs)
        : [];
      result.scanned = this.roundStore.listAll().length;
      result.orphaned = orphanedRounds.length;

      if (this.config.verbose) {
        logger.info(
          { total: result.scanned, orphaned: result.orphaned },
          'GC: 发现孤立问答闭环',
        );
      }

      if (orphanedRounds.length === 0) {
        result.elapsedMs = Date.now() - startTime;
        return result;
      }

      // 2. 分批删除
      for (let i = 0; i < orphanedRounds.length; i += this.config.batchSize) {
        const batch = orphanedRounds.slice(i, i + this.config.batchSize);

        for (const round of batch) {
          // 删除 Round
          const deleted = this.roundStore.delete(round.id);

          if (deleted) {
            result.deleted++;

            // 同时清理关联的记忆摘要
            if (this.config.cleanUpMemory) {
              this.cleanUpRoundSummary(round);
              result.memoryCleaned++;
            }
          } else {
            result.failedDueToRefCount++;
          }
        }

        // 可选：让出事件循环，避免长时间阻塞
        // await new Promise(resolve => setImmediate(resolve));
      }

      if (this.config.verbose) {
        logger.info({ result: { ...result } }, 'GC: 完成');
      }
    } catch (error) {
      logger.error({ error }, 'GC: 执行失败');
    }

    result.elapsedMs = Date.now() - startTime;
    return result;
  }

  /**
   * 清理 Round 关联的记忆摘要
   *
   * @param round - 要清理的 Round
   */
  private cleanUpRoundSummary(round: Round): void {
    // 如果 Round 有明确的 summaryId，直接删除
    if (round.summaryId) {
      this.memoryStorage.delete(round.summaryId);
      return;
    }

    // 否则尝试用默认格式查找
    const summaryId = generateSummaryId(round.id);
    const summary = this.memoryStorage.getById(summaryId);
    if (summary) {
      this.memoryStorage.delete(summaryId);
    }
  }

  /**
   * 启动定时 GC
   *
   * @param intervalMs - 执行间隔（毫秒）
   */
  startPeriodic(intervalMs: number): void {
    if (this.timer) {
      logger.warn('GC: 定时任务已启动，忽略重复调用');
      return;
    }

    this.timer = setInterval(() => {
      this.run();
    }, intervalMs);

    logger.info({ intervalMs }, 'GC: 定时任务已启动');
  }

  /**
   * 停止定时 GC
   */
  stopPeriodic(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('GC: 定时任务已停止');
    }
  }

  /**
   * 获取当前配置
   *
   * @returns GC 配置
   */
  getConfig(): Readonly<GCConfig> {
    return { ...this.config };
  }

  /**
   * 更新配置
   *
   * @param partial - 部分配置更新
   */
  updateConfig(partial: Partial<GCConfig>): void {
    Object.assign(this.config, partial);
  }
}

/**
 * 创建默认 GC 服务的工厂函数
 *
 * @param roundStore - 问答闭环存储
 * @param memoryStorage - 记忆存储
 * @returns GC 服务实例
 */
export function createDefaultGCService(
  roundStore: IRoundStore,
  memoryStorage: IMemoryStorage,
): GCService {
  return new GCService(roundStore, memoryStorage, {
    minAgeMs: 5 * 60 * 1000, // 5 分钟最小存活时间
    batchSize: 100,
    cleanUpMemory: true,
    verbose: false,
  });
}
