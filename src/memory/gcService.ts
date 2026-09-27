/**
 * 垃圾回收服务 —— 清理孤立的问答闭环和关联摘要
 *
 * 设计理念：
 * - 基于引用计数的自动清理机制
 * - 只清理 refCount === 0 且超龄的 Round（不分状态：pending/error 崩溃残留同样可回收）
 * - 同时清理关联的记忆摘要（round-summary）
 * - 支持定时执行和手动触发
 *
 * 触发时机：
 * 1. 会话删除时，减少引用计数后检查
 * 2. 定时任务（如每天一次）自动执行（启动时立即执行一次清存量孤儿）
 * 3. 宿主手动触发（run() 公开入口）
 */

import type { IRoundStore, Round } from '@/memory/roundStore.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import { logger } from '@/logging/logger.js';
import { SOURCE_LABELS } from '@/memory/types.js';

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
   * 是否清理关联的记忆摘要
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

  /**
   * 忙碌检查回调（可选）
   *
   * 定时 GC 在对话进行中（chatLock busy / 长任务执行中）延迟执行，
   * 避免进行中 pending Round 被误清（minAgeMs 判龄对长任务不可靠）。
   * 返回 true = 当前忙，跳过本次 GC。
   */
  shouldSkip?: () => boolean;
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
      shouldSkip: config?.shouldSkip,
    };
  }

  /**
   * 执行垃圾回收
   *
   * 流程：
   * 1. 忙碌检查（可选 shouldSkip）：对话进行中（长任务执行）跳过本次，
   *    minAgeMs 判龄对多轮长任务不可靠，防止进行中 pending Round 被误清
   * 2. 列出所有孤立的 Round（refCount === 0 且超龄，不分状态）
   * 3. 分批删除孤立 Round
   * 4. 同时清理关联的记忆摘要（purge 硬删除，不进回收站）
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

    // 忙碌检查：对话进行中跳过本次（定时/手动触发均生效）
    if (this.config.shouldSkip?.()) {
      logger.debug('GC: 对话进行中（shouldSkip），跳过本次执行');
      result.elapsedMs = Date.now() - startTime;
      return result;
    }

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
        logger.info({ total: result.scanned, orphaned: result.orphaned }, 'GC: 发现孤立问答闭环');
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
   * 摘要记忆的**规范 ID** 为 `round-summary:{sessionName}:{roundId}`（由
   * roundSummaryGenerator 构造，含会话段）——Round 侧**不持有反向指针**，
   * 故此处按 `roundId` 顶层字段反查，覆盖全部会话命名空间。
   *
   * 系统治理删除走 purge 物理删除（不进回收站——孤儿摘要是系统清理产物，
   * 非用户主动删除的数据）。
   *
   * @param round - 要清理的 Round
   */
  private cleanUpRoundSummary(round: Round): void {
    // 按 roundId 顶层字段反查全部会话命名空间的两段式摘要
    const roundSummaries = this.memoryStorage
      .getBySource(SOURCE_LABELS.ROUND_SUMMARY)
      .filter((m) => m.roundId === round.id);
    for (const summary of roundSummaries) {
      this.purgeSummary(summary.id);
    }
  }

  /**
   * 物理删除摘要（round-summary 随 Round 引用归零联动清理）
   *
   * @param summaryId - 摘要记忆 ID
   */
  private purgeSummary(summaryId: string): void {
    // purge = 物理删除（不可恢复），孤儿摘要是系统治理决定，不进用户回收站
    this.memoryStorage.purge(summaryId);
  }

  /**
   * 启动定时 GC
   *
   * VSCode 窗口生命周期通常远小于定时周期 → 启动时立即执行一次（run），
   * 先清存量孤儿，再按周期续跑。
   *
   * @param intervalMs - 执行间隔（毫秒）
   */
  startPeriodic(intervalMs: number): void {
    if (this.timer) {
      logger.warn('GC: 定时任务已启动，忽略重复调用');
      return;
    }

    // 启动即执行一次：窗口生命周期内可能等不到首个周期，先清存量孤儿
    this.run();

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
 * @param shouldSkip - 忙碌检查回调（可选：对话进行中跳过本次）
 * @returns GC 服务实例
 */
export function createDefaultGCService(
  roundStore: IRoundStore,
  memoryStorage: IMemoryStorage,
  shouldSkip?: () => boolean,
): GCService {
  return new GCService(roundStore, memoryStorage, {
    minAgeMs: 5 * 60 * 1000, // 5 分钟最小存活时间
    batchSize: 100,
    cleanUpMemory: true,
    verbose: false,
    shouldSkip,
  });
}
