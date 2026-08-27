/**
 * 内存问答闭环存储实现 — IRoundStore 的纯 JS 内存版
 *
 * 设计理念：
 * - 零依赖零 IO，用于单元测试、临时占位
 * - 不持久化（进程退出即丢失），仅限测试/开发
 * - 生产请宿主注入 FileRoundStore 或 SqliteRoundStore
 */

import type {
  Round,
  RoundStatus,
  IRoundStore,
} from '@/memory/roundStore.js';
import { logger } from '@/logging/logger.js';

/**
 * 内存问答闭环存储
 *
 * 核心实现：
 * - Map 存储（id → Round）
 * - 引用计数内置于 Round.refCount
 * - 支持批量获取（getByIds）
 * - 支持按状态筛选（listByStatus）
 * - 支持孤立检查（listOrphaned）
 */
export class InMemoryRoundStore implements IRoundStore {
  /** Round 存储（id → Round） */
  private rounds: Map<string, Round> = new Map();

  /**
   * 存储问答闭环（新增或更新）
   *
   * @param round - 问答闭环对象
   */
  save(round: Round): void {
    // 浅拷贝，防止外部修改影响内部状态
    this.rounds.set(round.id, { ...round });
  }

  /**
   * 按 ID 获取问答闭环
   *
   * @param roundId - 全局唯一 Round ID
   * @returns Round 对象，不存在返回 null
   */
  getById(roundId: string): Round | null {
    const round = this.rounds.get(roundId);
    if (!round) return null;
    return { ...round };
  }

  /**
   * 批量获取问答闭环
   *
   * 不存在的 ID 会被跳过，不报错
   *
   * @param roundIds - Round ID 数组
   * @returns Round 对象数组（按输入顺序，跳过不存在的）
   */
  getByIds(roundIds: string[]): Round[] {
    const results: Round[] = [];
    for (const id of roundIds) {
      const round = this.rounds.get(id);
      if (round) {
        results.push({ ...round });
      }
    }
    return results;
  }

  /**
   * 列出所有问答闭环
   *
   * ⚠️ 生产环境慎用：全量遍历可能性能开销大
   *
   * @returns 所有 Round 数组（浅拷贝）
   */
  listAll(): Round[] {
    return Array.from(this.rounds.values()).map((r) => ({ ...r }));
  }

  /**
   * 增加引用计数
   *
   * 分叉时调用：新会话引用同一个 Round
   *
   * @param roundId - 需要增加引用的 Round ID
   */
  incrementRef(roundId: string): void {
    const round = this.rounds.get(roundId);
    if (!round) {
      logger.warn({ roundId }, 'incrementRef: Round 不存在');
      return;
    }
    round.refCount++;
    this.rounds.set(roundId, { ...round });
  }

  /**
   * 减少引用计数
   *
   * 删除会话时调用
   * 引用计数不会降到 0 以下
   *
   * @param roundId - 需要减少引用的 Round ID
   */
  decrementRef(roundId: string): void {
    const round = this.rounds.get(roundId);
    if (!round) {
      logger.warn({ roundId }, 'decrementRef: Round 不存在');
      return;
    }
    if (round.refCount > 0) {
      round.refCount--;
      this.rounds.set(roundId, { ...round });
    }
  }

  /**
   * 删除问答闭环（物理删除，不可恢复）
   *
   * 前置条件：refCount === 0
   *
   * @param roundId - 要删除的 Round ID
   * @returns 是否删除成功（refCount > 0 时返回 false）
   */
  delete(roundId: string): boolean {
    const round = this.rounds.get(roundId);
    if (!round) return false;

    // 检查引用计数
    if (round.refCount > 0) {
      logger.warn(
        { roundId, refCount: round.refCount },
        'delete: Round 仍被引用，无法删除',
      );
      return false;
    }

    this.rounds.delete(roundId);
    return true;
  }

  /**
   * 按状态列出问答闭环
   *
   * @param status - Round 状态筛选
   * @returns 符合条件的 Round 数组
   */
  listByStatus(status: RoundStatus): Round[] {
    return Array.from(this.rounds.values())
      .filter((r) => r.status === status)
      .map((r) => ({ ...r }));
  }

  /**
   * 获取孤立的问答闭环列表（refCount === 0）
   *
   * 用于 GC 服务批量清理
   *
   * @param minAgeMs - 最小存活时间（毫秒），避免清理正在使用的 Round
   * @returns 孤立 Round 数组
   */
  listOrphaned(minAgeMs: number = 0): Round[] {
    const now = Date.now();
    const minAgeMsSec = minAgeMs / 1000; // 转换为秒

    return Array.from(this.rounds.values())
      .filter((r) => {
        // 检查引用计数
        if (r.refCount > 0) return false;

        // 检查存活时间
        const createdAtMs = new Date(r.createdAt).getTime();
        const ageSec = (now - createdAtMs) / 1000;
        if (ageSec < minAgeMsSec) return false;

        // 只清理 complete 状态的 Round
        // pending/error 状态的 Round 可能还在处理中
        if (r.status !== 'complete') return false;

        return true;
      })
      .map((r) => ({ ...r }));
  }

  /**
   * 获取存储中的 Round 数量
   *
   * 用于监控和测试
   *
   * @returns Round 总数
   */
  size(): number {
    return this.rounds.size;
  }

  /**
   * 清空存储（测试用）
   *
   * ⚠️ 不可逆操作，仅用于测试
   */
  clear(): void {
    this.rounds.clear();
  }
}
