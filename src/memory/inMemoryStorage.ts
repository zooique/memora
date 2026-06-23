/**
 * 内存存储实现 — IMemoryStorage 的纯 JS 内存实现
 *
 * 零依赖、零 IO，适用于：
 * - 单元测试（不需要 better-sqlite3，不需要文件系统）
 * - 宿主项目注入前的临时占位
 * - 沙箱/演示环境
 *
 * 注意：此实现不持久化，进程退出后数据丢失。
 * ⚠️ 仅限测试/开发使用，生产环境请注入 SqliteStorage（宿主项目提供）。
 */
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import type { Memory } from '@/memory/types.js';
import { validateSource } from '@/memory/types.js';
import { segmentText } from '@/utils/segmenter.js';
import { logger } from '@/logging/logger.js';
import { applyDecayToMemory } from '@/memory/recall.js';

/**
 * 内存存储实现
 *
 * 使用 Map 存储记忆，核心操作 O(1)~O(log n)。
 * P2-2 优化：维护 source→count 增量缓存，stats()/sourceHealth() 无需全量遍历。
 */
export class InMemoryStorage implements IMemoryStorage {
  /** 记忆存储（id → Memory） */
  private memories: Map<string, Memory> = new Map();

  /** P2-2 source→count 增量缓存（upsert/delete 时维护，getAllSources 时直接读取） */
  private sourceCountCache: Map<string, number> = new Map();

  /**
   * 插入或更新记忆
   *
   * 自动校验 source 字段，对疑似 typo 发出警告日志。
   * P2-2 增量维护 sourceCountCache：更新时旧 source 减 1、新 source 加 1。
   */
  upsert(memory: Memory): void {
    const result = validateSource(memory.source);
    if (result.severity === 'block') {
      throw new Error(`source 校验失败（拒绝写入）：${result.warning}`);
    }
    if (result.severity === 'warn' && result.warning) {
      logger.warn(
        { id: memory.id, source: memory.source, warning: result.warning },
        'source 校验警告',
      );
    }
    // P2-2 增量维护 source 缓存：若为更新（id 已存在），先减旧 source 计数
    const existing = this.memories.get(memory.id);
    if (existing && existing.source !== memory.source) {
      this.decrementSourceCount(existing.source);
    }
    this.memories.set(memory.id, { ...memory });
    // P2-2 增量维护 source 缓存：新 source 加 1
    this.incrementSourceCount(memory.source);
  }

  /**
   * 删除记忆
   *
   * P2-2 增量维护 sourceCountCache：删除时对应 source 减 1。
   */
  delete(id: string): void {
    const existing = this.memories.get(id);
    if (existing) {
      this.decrementSourceCount(existing.source);
    }
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
    const tokens = segmentText(query).map((t) => t.toLowerCase());

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
    let count = 0;
    for (const m of this.memories.values()) {
      if (!sources.includes(m.source)) continue;
      if (applyDecayToMemory(m, now)) {
        count++;
      }
    }
    return count;
  }

  /**
   * 获取所有 source 标签及其记忆数量
   *
   * P2-2 优化：直接读取增量维护的 sourceCountCache，O(1) 复杂度。
   */
  getAllSources(): Map<string, number> {
    return new Map(this.sourceCountCache);
  }

  /**
   * 关闭（内存实现无需关闭）
   */
  close(): void {
    // 内存实现无需关闭，清空数据即可
    this.memories.clear();
    this.sourceCountCache.clear();
  }

  // ─── P2-2 source 缓存辅助方法 ─────────────────────────────

  /** source 计数 +1 */
  private incrementSourceCount(source: string): void {
    this.sourceCountCache.set(source, (this.sourceCountCache.get(source) ?? 0) + 1);
  }

  /** source 计数 -1（减至 0 时移除键） */
  private decrementSourceCount(source: string): void {
    const current = this.sourceCountCache.get(source);
    if (current === undefined) return;
    if (current <= 1) {
      this.sourceCountCache.delete(source);
    } else {
      this.sourceCountCache.set(source, current - 1);
    }
  }
}
