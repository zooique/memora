/**
 * 内存存储实现 — IMemoryStorage 的纯 JS 内存版。
 * 零依赖零 IO，用于单元测试、宿主注入前的临时占位、沙箱。不持久化（进程退出即丢失），
 * 仅限测试/开发；生产请宿主注入 SqliteStorage。
 */
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import type { Memory } from '@/memory/types.js';
import { validateSource } from '@/memory/sourceValidation.js';
import { segmentLower } from '@/utils/segmenter.js';
import { byScoreDesc } from '@/utils/array.js';
import { configError } from '@/utils/errors.js';
import { logger } from '@/logging/logger.js';
import { applyDecayToMemory } from '@/memory/recall.js';
import { nowIso } from '@/utils/time.js';
import { DECAY_FLOOR, SCORE_CEILING } from '@/memory/governance.js';

/**
 * 内存存储：Map 存储，核心操作 O(1)~O(log n)。
 * 维护 source→count 增量缓存，stats()/sourceHealth() 无需全量遍历。
 */
export class InMemoryStorage implements IMemoryStorage {
  /** 记忆存储（id → Memory） */
  private memories: Map<string, Memory> = new Map();
  /** source→count 增量缓存（upsert/delete 时维护，getAllSources 直接读取） */
  private sourceCountCache: Map<string, number> = new Map();

  /**
   * upsert：校验 source + 软删除复活拦截 + delta 维护 sourceCountCache。
   * 增量按 source/软删态加减活跃计数；软删除记忆不能经 upsert 静默复活（须先 restore）。
   */
  upsert(memory: Memory): void {
    const result = validateSource(memory.source);
    if (result.severity === 'block') {
      throw configError('source 校验失败，拒绝写入', result.warning, [
        '请检查 source 字段是否拼写正确',
        '参考 source 开放字符串规范',
      ]);
    }
    if (result.severity === 'warn' && result.warning) {
      logger.warn(
        { id: memory.id, source: memory.source, warning: result.warning },
        'source 校验警告',
      );
    }
    // 软删除校验：阻止经 upsert 静默复活软删除记忆（须先显式 restore）
    const existing = this.memories.get(memory.id);
    if (existing && existing.deletedAt !== undefined && memory.deletedAt === undefined) {
      throw configError(
        '不允许通过 upsert 复活软删除记忆',
        `id=${memory.id} 已被软删除（deletedAt=${existing.deletedAt}）`,
        [
          '若需恢复：先调用 restore(id)，再 upsert',
          '若需覆盖软删除态：在 newMemory 中显式传入 deletedAt 字段',
          '参考软删除机制设计',
        ],
      );
    }
    // delta 维护 sourceCountCache：先扣 existing 活跃贡献，再加回 newMemory 活跃贡献
    if (existing && existing.deletedAt === undefined) {
      this.decrementSourceCount(existing.source);
    }
    this.memories.set(memory.id, { ...memory });
    if (memory.deletedAt === undefined) {
      this.incrementSourceCount(memory.source);
    }
  }

  /** 软删除：写 deletedAt 标记不物理移除；可 restore 恢复，过期由 purgeExpired 清理 */
  delete(id: string): void {
    const existing = this.memories.get(id);
    if (!existing || existing.deletedAt !== undefined) return;
    const softDeleted: Memory = { ...existing, deletedAt: nowIso() };
    this.memories.set(id, softDeleted);
    this.decrementSourceCount(existing.source);
  }

  /** 恢复软删除：清除 deletedAt 使记忆重回召回/搜索/列表；活跃态调用为 no-op */
  restore(id: string): void {
    const existing = this.memories.get(id);
    if (!existing || existing.deletedAt === undefined) return;
    const restored: Memory = { ...existing, deletedAt: undefined };
    this.memories.set(id, restored);
    this.incrementSourceCount(existing.source);
  }

  /** 物理删除：从 Map 彻底移除不可恢复；活跃态亦扣减计数（正常流程先 delete 已扣） */
  purge(id: string): void {
    const existing = this.memories.get(id);
    if (!existing) return;
    if (existing.deletedAt === undefined) {
      this.decrementSourceCount(existing.source);
    }
    this.memories.delete(id);
  }

  /** 列出软删除记忆，按 deletedAt 降序；limit<=0 或 undefined 表示不设上限（返回全部） */
  listDeleted(limit?: number): Memory[] {
    const all = Array.from(this.memories.values())
      .filter((m) => m.deletedAt !== undefined)
      .sort((a, b) => {
        return b.deletedAt! > a.deletedAt! ? 1 : b.deletedAt! < a.deletedAt! ? -1 : 0;
      })
      .map((m) => ({ ...m }));
    return limit !== undefined && limit > 0 ? all.slice(0, limit) : all;
  }

  /** 按 ID 取单条软删除记忆（浅拷贝）；不存在或未软删除返回 null */
  getDeletedById(id: string): Memory | null {
    const mem = this.memories.get(id);
    if (!mem || mem.deletedAt === undefined) return null;
    return { ...mem };
  }

  /** 物理删除 deletedAt 早于 before 的软删除记忆，返回清理数量（宿主定时器默认 30 天保留期调用） */
  purgeExpired(before: Date): number {
    const beforeIso = before.toISOString();
    let count = 0;
    for (const [id, m] of this.memories) {
      if (m.deletedAt !== undefined && m.deletedAt < beforeIso) {
        this.memories.delete(id);
        count++;
      }
    }
    return count;
  }

  /** 按 ID 取活跃记忆（浅拷贝，软删除返回 null，读取隔离契约） */
  getById(id: string): Memory | null {
    const m = this.memories.get(id);
    if (!m || m.deletedAt !== undefined) return null;
    return { ...m };
  }

  /** 按 source 取活跃记忆（浅拷贝，自动过滤软删除，score 降序） */
  getBySource(source: string): Memory[] {
    return Array.from(this.memories.values())
      .filter((m) => m.source === source && m.deletedAt === undefined)
      .sort(byScoreDesc)
      .map((m) => ({ ...m }));
  }

  /** 文本搜索活跃记忆（segmentLower 与 SqliteStorage/recall 一致），score 降序，limit 默认 10 */
  search(query: string, limit = 10): Memory[] {
    const activeMemories = Array.from(this.memories.values()).filter(
      (m) => m.deletedAt === undefined,
    );
    // 空查询或分词无有效 token：按 score 返回
    if (!query.trim()) {
      return this.sortCopyLimit(activeMemories, limit);
    }
    const tokens = segmentLower(query);
    if (tokens.length === 0) {
      return this.sortCopyLimit(activeMemories, limit);
    }
    const results = activeMemories.filter((m) => {
      const text = `${m.content} ${m.name}`.toLowerCase();
      // 任一 token 命中即可
      return tokens.some((t) => text.includes(t));
    });
    return this.sortCopyLimit(results, limit);
  }

  /** 排序 + 截断 + 浅拷贝，消除 search 内重复的 pattern */
  private sortCopyLimit(memories: Memory[], limit: number): Memory[] {
    return memories
      .sort(byScoreDesc)
      .slice(0, limit)
      .map((m) => ({ ...m }));
  }

  /** 活跃记忆总数：累加 sourceCountCache（仅维护活跃计数） */
  count(): number {
    let total = 0;
    for (const c of this.sourceCountCache.values()) total += c;
    return total;
  }

  /** 按 source 统计活跃数量，O(1) 读 sourceCountCache */
  countBySource(source: string): number {
    return this.sourceCountCache.get(source) ?? 0;
  }

  /** 衰减匹配 source 的活跃记忆 score（跳过软删除）；生产宿主应重写为 SQL UPDATE */
  decayScores(sources: string[], now: Date): number {
    let count = 0;
    for (const m of this.memories.values()) {
      if (m.deletedAt !== undefined) continue;
      if (!sources.includes(m.source)) continue;
      if (applyDecayToMemory(m, now)) {
        count++;
      }
    }
    return count;
  }

  /** 原子 score+=delta，clamp 到 [DECAY_FLOOR, SCORE_CEILING]，同步存储下天然原子；不存在/软删返回 false */
  incrementScore(id: string, delta: number, now: string): boolean {
    const memory = this.memories.get(id);
    if (!memory || memory.deletedAt !== undefined) return false;
    memory.score = Math.max(DECAY_FLOOR, Math.min(SCORE_CEILING, memory.score + delta));
    memory.accessedAt = now;
    return true;
  }

  /** 原子设置 score 绝对值（不 clamp，调用方负责传合法值），同时更新 accessedAt */
  setScore(id: string, newScore: number, now: string): boolean {
    const memory = this.memories.get(id);
    if (!memory || memory.deletedAt !== undefined) return false;
    memory.score = newScore;
    memory.accessedAt = now;
    return true;
  }

  /** 全部 source 及活跃计数（拷贝 Map，O(sources)） */
  getAllSources(): Map<string, number> {
    return new Map(this.sourceCountCache);
  }

  /** 关闭即丢弃全部记忆（终结操作不可逆）；勿在会话暂停/检查点恢复等状态层动作调用 */
  close(): void {
    this.memories.clear();
    this.sourceCountCache.clear();
  }

  /** source 计数 +1 */
  private incrementSourceCount(source: string): void {
    this.sourceCountCache.set(source, (this.sourceCountCache.get(source) ?? 0) + 1);
  }

  /** source 计数 -1（减至 0 移除键） */
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
