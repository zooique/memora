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
 *
 * 重构变更（2026-06-11）：
 * - 移除 getByPermanence() / getByType() / touch() / applyDecay()
 * - 新增 getBySource()：按来源标签获取记忆
 * - 简化 search()：移除 mode 参数，移除 touch 逻辑
 */
import type { IMemoryStorage } from './storage-interface.js';
import type { Memory } from './types.js';

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
   * 简单文本搜索（内存版）
   *
   * 不使用 Intl.Segmenter 分词，直接用 includes 匹配。
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

    // 简单空格分词（不使用 Intl.Segmenter）
    const tokens = query.trim().split(/\s+/).filter(Boolean);

    // 若分词后无有效 token（纯标点/符号查询），降级为按 score 返回
    if (tokens.every((t) => !/[\w\u4e00-\u9fff]/.test(t))) {
      return Array.from(this.memories.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    }

    const results = Array.from(this.memories.values()).filter((m) => {
      const text = `${m.content} ${m.name}`.toLowerCase();
      // 任一 token 命中即可
      return tokens.some((t) => text.includes(t.toLowerCase()));
    });

    // 按 score 降序排序
    results.sort((a, b) => b.score - a.score);

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
