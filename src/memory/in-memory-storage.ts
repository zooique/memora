/**
 * 内存存储实现 — IMemoryStorage 的纯 JS 内存实现
 *
 * 零依赖、零 IO，适用于：
 * - 单元测试（不需要 better-sqlite3，不需要文件系统）
 * - 宿主项目注入前的临时占位
 * - 沙箱/演示环境
 *
 * 注意：此实现不持久化，进程退出后数据丢失。
 * 不支持中文分词搜索（search() 使用简单的 includes 匹配）。
 */
import type { IMemoryStorage } from './storage-interface.js';
import type { Memory, MemoryTypeValue, PermanenceValue } from './types.js';

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
   */
  upsert(memory: Memory): void {
    this.memories.set(memory.id, { ...memory });
  }

  /**
   * 删除记忆
   */
  delete(id: string): void {
    this.memories.delete(id);
  }

  /**
   * 按永久性等级获取记忆
   */
  getByPermanence(permanence: PermanenceValue): Memory[] {
    return Array.from(this.memories.values())
      .filter((m) => m.permanence === permanence)
      .sort((a, b) => b.weight - a.weight);
  }

  /**
   * 按 ID 获取单条记忆
   */
  getById(id: string): Memory | null {
    return this.memories.get(id) ?? null;
  }

  /**
   * 按类型获取记忆
   */
  getByType(type: MemoryTypeValue): Memory[] {
    return Array.from(this.memories.values())
      .filter((m) => m.type === type)
      .sort((a, b) => b.weight - a.weight);
  }

  /**
   * 触摸记忆：重置 weight 为 1.0，更新 updatedAt
   */
  touch(ids: string[]): void {
    if (ids.length === 0) return;
    const now = new Date().toISOString();
    for (const id of ids) {
      const memory = this.memories.get(id);
      if (memory) {
        memory.weight = 1.0;
        memory.updatedAt = now;
      }
    }
  }

  /**
   * 应用记忆权重衰减
   *
   * 衰减公式与 SqliteStorage 一致：
   * newWeight = max(MIN_WEIGHT, weight × 0.5^(ageDays / halfLife))
   */
  applyDecay(halfLifeDays: Record<PermanenceValue, number>): Record<PermanenceValue, number> {
    const result: Record<PermanenceValue, number> = {
      always: 0,
      domain: 0,
      topic: 0,
      'on-demand': 0,
    };

    const MIN_WEIGHT = 0.05;
    const now = Date.now();

    for (const permanence of Object.keys(halfLifeDays) as PermanenceValue[]) {
      const halfLife = halfLifeDays[permanence];

      // always 永久性的记忆不衰减
      if (halfLife === Infinity || halfLife === 0) {
        result[permanence] = 0;
        continue;
      }

      let decayedCount = 0;

      for (const memory of this.memories.values()) {
        if (memory.permanence !== permanence) continue;
        if (memory.weight <= MIN_WEIGHT) continue;

        const ageMs = now - new Date(memory.updatedAt).getTime();
        const ageDays = ageMs / (24 * 60 * 60 * 1000);
        const decayFactor = Math.pow(0.5, ageDays / halfLife);
        const newWeight = Math.max(MIN_WEIGHT, memory.weight * decayFactor);

        if (Math.abs(newWeight - memory.weight) > 0.001) {
          memory.weight = newWeight;
          decayedCount++;
        }
      }

      result[permanence] = decayedCount;
    }

    return result;
  }

  /**
   * 简单文本搜索（内存版）
   *
   * 不使用 Intl.Segmenter 分词，直接用 includes 匹配。
   * match 模式：任一关键词命中即可
   * near 模式：所有关键词必须同时命中
   */
  search(query: string, limit = 10, mode: 'match' | 'near' = 'match'): Memory[] {
    // 空查询：按 weight 降序返回
    if (!query.trim()) {
      return Array.from(this.memories.values())
        .sort((a, b) => b.weight - a.weight)
        .slice(0, limit);
    }

    // 简单空格分词（不使用 Intl.Segmenter）
    const tokens = query.trim().split(/\s+/).filter(Boolean);

    // 若分词后无有效 token（纯标点/符号查询），降级为按 weight 返回
    // 与 SqliteStorage 的 Intl.Segmenter 行为对齐：标点不会产生有效 token
    if (tokens.every((t) => !/[\w\u4e00-\u9fff]/.test(t))) {
      return Array.from(this.memories.values())
        .sort((a, b) => b.weight - a.weight)
        .slice(0, limit);
    }

    const results = Array.from(this.memories.values()).filter((m) => {
      const text = `${m.content} ${m.name} ${m.tags.join(' ')}`.toLowerCase();

      if (mode === 'near') {
        // 所有 token 必须命中
        return tokens.every((t) => text.includes(t.toLowerCase()));
      } else {
        // 任一 token 命中即可
        return tokens.some((t) => text.includes(t.toLowerCase()));
      }
    });

    // 按 weight 降序排序
    results.sort((a, b) => b.weight - a.weight);

    // 搜索命中后 touch（与 SqliteStorage 行为一致）
    if (results.length > 0) {
      const ids = results.slice(0, limit).map((m) => m.id);
      this.touch(ids);
    }

    return results.slice(0, limit);
  }

  /**
   * 关闭（内存实现无需关闭）
   */
  close(): void {
    // 内存实现无需关闭，清空数据即可
    this.memories.clear();
  }
}
