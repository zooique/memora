/**
 * 内存存储实现 — IMemoryStorage 的纯 JS 内存实现
 *
 * 零依赖、零 IO，适用于：
 * - 单元测试（不需要 better-sqlite3，不需要文件系统）
 * - 宿主项目注入前的临时占位
 * - 沙箱/演示环境
 *
 * 注意：此实现不持久化，进程退出后数据丢失。
 */
import type { IMemoryStorage } from './storageInterface.js';
import type { Memory } from './types.js';
import { validateSource } from './types.js';
import { segmentText } from '@/utils/segmenter.js';
import { logger } from '@/logging/logger.js';

/**
 * 内存存储实现
 *
 * 使用 Map 存储记忆，所有操作均为 O(n) 级别（n = 记忆总数）。
 * 对于测试场景（通常 < 100 条记忆），性能完全足够。
 */
export class InMemoryStorage implements IMemoryStorage {
  /** 记忆存储（id → Memory） */
  private memories: Map<string, Memory> = new Map();

  /**
   * 插入或更新记忆
   *
   * 自动校验 source 字段，对疑似 typo 发出警告日志。
   */
  upsert(memory: Memory): void {
    const result = validateSource(memory.source);
    if (result.severity === 'block') {
      throw new Error(`source 校验失败（拒绝写入）：${result.warning}`);
    }
    if (result.severity === 'warn' && result.warning) {
      logger.warn({ id: memory.id, source: memory.source, warning: result.warning }, 'source 校验警告');
    }
    this.memories.set(memory.id, { ...memory });
  }

  /**
   * 删除记忆
   */
  delete(id: string): void {
    this.memories.delete(id);
  }

  /**
   * 按 ID 获取单条记忆
   */
  getById(id: string): Memory | null {
    return this.memories.get(id) ?? null;
  }

  /**
   * 按来源标签获取记忆
   *
   * @param source - 来源标签（如 'persona'、'rule'、'insight'）
   * @returns 该来源的所有记忆，按 score 降序排列
   */
  getBySource(source: string): Memory[] {
    return Array.from(this.memories.values())
      .filter((m) => m.source === source)
      .sort((a, b) => b.score - a.score);
  }

  /**
   * 文本搜索（内存版）
   *
   * 使用 segmentText() 规范分词，与 SqliteStorage 行为一致。
   * 搜索 content 和 name 字段，按 score 降序排列。
   *
   * @param query - 搜索查询文本
   * @param limit - 返回数量上限（默认 10）
   * @returns 匹配的记忆列表
   */
  search(query: string, limit = 10): Memory[] {
    // 空查询：按 score 降序返回
    if (!query.trim()) {
      return Array.from(this.memories.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    }

    // 规范分词（与 recall.ts extractKeywords 共用 segmentText）
    const tokens = segmentText(query).map(t => t.toLowerCase());

    // 若分词后无有效 token，降级为按 score 返回
    if (tokens.length === 0) {
      return Array.from(this.memories.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    }

    const results = Array.from(this.memories.values()).filter((m) => {
      const text = `${m.content} ${m.name}`.toLowerCase();
      // 任一 token 命中即可
      return tokens.some((t) => text.includes(t));
    });

    // 按 score 降序排序
    results.sort((a, b) => b.score - a.score);

    return results.slice(0, limit);
  }

  /**
   * 统计记忆总数
   */
  count(): number {
    return this.memories.size;
  }

  /**
   * 按来源标签统计记忆数量
   */
  countBySource(source: string): number {
    let count = 0;
    for (const m of this.memories.values()) {
      if (m.source === source) count++;
    }
    return count;
  }

  /**
   * 衰减指定来源的记忆 score
   *
   * 遍历所有匹配 source 的记忆，按时间衰减。
   * 生产环境宿主（SqliteStorage）应重写为 SQL UPDATE 批量操作。
   */
  decayScores(sources: string[], now: Date): number {
    const ONE_DAY = 24 * 60 * 60 * 1000;
    let count = 0;
    for (const m of this.memories.values()) {
      if (!sources.includes(m.source)) continue;
      const accessedAt = new Date(m.accessedAt);
      if (isNaN(accessedAt.getTime())) continue;
      const daysSinceAccess = (now.getTime() - accessedAt.getTime()) / ONE_DAY;
      if (daysSinceAccess > 7) {
        m.score = Math.max(0.1, m.score - 0.02 * Math.floor(daysSinceAccess / 7));
        count++;
      }
    }
    return count;
  }

  /**
   * 关闭（内存实现无需关闭）
   */
  close(): void {
    // 内存实现无需关闭，清空数据即可
    this.memories.clear();
  }
}
