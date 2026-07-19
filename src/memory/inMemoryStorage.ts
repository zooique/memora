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
import { validateSource } from '@/memory/sourceValidation.js';
import { segmentLower } from '@/utils/segmenter.js';
import { byScoreDesc } from '@/utils/array.js';
import { configError } from '@/utils/errors.js';
import { logger } from '@/logging/logger.js';
import { applyDecayToMemory } from '@/memory/recall.js';
import { nowIso } from '@/utils/time.js';

/**
 * 内存存储实现
 *
 * 使用 Map 存储记忆，核心操作 O(1)~O(log n)。
 * 优化：维护 source→count 增量缓存，stats()/sourceHealth() 无需全量遍历。
 */
export class InMemoryStorage implements IMemoryStorage {
  /** 记忆存储（id → Memory） */
  private memories: Map<string, Memory> = new Map();

  /** source→count 增量缓存（upsert/delete 时维护，getAllSources 时直接读取） */
  private sourceCountCache: Map<string, number> = new Map();

  /**
   * 插入或更新记忆
   *
   * 自动校验 source 字段，对疑似 typo 发出警告日志。
   * 增量维护 sourceCountCache（仅统计活跃记忆）：
   *   - 新增活跃记忆：source 计数 +1
   *   - 更新同 source 同活跃态：计数不变
   *   - 更新换 source：旧 source -1、新 source +1
   * 软删除状态转换维护：
   *   - 活跃 → 软删除：source 计数 -1
   *   - 软删除 → 活跃：source 计数 +1
   *
   * 软删除校验：
   *   若 existing 已软删除（deletedAt !== undefined）且 newMemory 为活跃态
   *   （deletedAt === undefined），抛出错误阻止"通过 upsert 复活软删除记忆"。
   *   调用方必须先显式 restore(id) 恢复记忆后再 upsert。
   *   例外：newMemory 显式带 deletedAt（如测试场景篡改 deletedAt）允许通过，
   *   因为此时调用方明确意图是覆盖软删除状态而非"复活"。
   *
   * 采用 delta 方式：先扣除 existing 的活跃贡献，再加回 newMemory 的活跃贡献。
   * 该方式可统一处理 source 变更 + 软删除状态变更的所有组合，避免分支爆炸。
   */
  upsert(memory: Memory): void {
    const result = validateSource(memory.source);
    if (result.severity === 'block') {
      // 裸 throw 改用 configError 工厂（Iter-1：错误处理统一）
      throw configError(
        'source 校验失败，拒绝写入',
        result.warning,
        ['请检查 source 字段是否拼写正确', '参考 ADR-004 source 开放字符串规范'],
      );
    }
    if (result.severity === 'warn' && result.warning) {
      logger.warn(
        { id: memory.id, source: memory.source, warning: result.warning },
        'source 校验警告',
      );
    }
    // 软删除校验：阻止"通过 upsert 静默复活软删除记忆"
    const existing = this.memories.get(memory.id);
    if (existing && existing.deletedAt !== undefined && memory.deletedAt === undefined) {
      // existing 已软删除，但 newMemory 试图以活跃态覆盖 → 拒绝
      // 调用方应先 restore(id) 再 upsert，或显式在 newMemory 中带 deletedAt
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
    // delta 方式维护 sourceCountCache（仅统计活跃记忆）
    // 先扣除 existing 的活跃贡献（若 existing 存在且为活跃态）
    if (existing && existing.deletedAt === undefined) {
      this.decrementSourceCount(existing.source);
    }
    this.memories.set(memory.id, { ...memory });
    // 再加回 newMemory 的活跃贡献（若 newMemory 为活跃态）
    if (memory.deletedAt === undefined) {
      this.incrementSourceCount(memory.source);
    }
  }

  /**
   * 软删除记忆
   *
   * 写入 deletedAt 时间戳，不物理移除 Map 条目。
   * - 召回/搜索/列表/统计自动过滤已软删除的记忆
   * - 可通过 restore(id) 恢复
   * - 回收站保留期过后由 purgeExpired(before) 物理清理
   *
   * 对已软删除的记忆调用为 no-op。
   * 增量维护 sourceCountCache：软删除时对应 source 减 1。
   */
  delete(id: string): void {
    const existing = this.memories.get(id);
    // 不存在或已软删除：no-op
    if (!existing || existing.deletedAt !== undefined) return;
    // 写入 deletedAt，标记为软删除
    const softDeleted: Memory = { ...existing, deletedAt: nowIso() };
    this.memories.set(id, softDeleted);
    // 活跃 → 软删除：source 计数 -1
    this.decrementSourceCount(existing.source);
  }

  /**
   * 恢复软删除的记忆
   *
   * 清除 deletedAt 字段，使记忆重新出现在召回/搜索/列表中。
   * 对活跃记忆调用为 no-op。
   * 增量维护 sourceCountCache：恢复时对应 source 加 1。
   */
  restore(id: string): void {
    const existing = this.memories.get(id);
    // 不存在或已为活跃态：no-op
    if (!existing || existing.deletedAt === undefined) return;
    // 清除 deletedAt，恢复为活跃态
    const restored: Memory = { ...existing, deletedAt: undefined };
    this.memories.set(id, restored);
    // 软删除 → 活跃：source 计数 +1
    this.incrementSourceCount(existing.source);
  }

  /**
   * 物理删除记忆
   *
   * 从 Map 中彻底移除，不可恢复。
   * 用于回收站的"彻底删除"操作，或测试环境的强制清理。
   *
   * 注意：若记忆为活跃态（未软删除），purge 也会减 1 计数，
   * 但正常流程应先软删除再 purge，此时计数已在 delete() 中扣除。
   */
  purge(id: string): void {
    const existing = this.memories.get(id);
    if (!existing) return;
    // 若为活跃态，扣除计数（软删除态的计数已在 delete() 中扣除）
    if (existing.deletedAt === undefined) {
      this.decrementSourceCount(existing.source);
    }
    this.memories.delete(id);
  }

  /**
   * 列出回收站中的软删除记忆
   *
   * 按 deletedAt 降序（最近删除的在前），便于回收站 UI 展示。
   * 返回浅拷贝，避免调用方修改污染存储内部对象。
   *
   * @param limit - 返回数量上限（默认 50）
   * @returns 软删除记忆列表（副本）
   */
  listDeleted(limit = 50): Memory[] {
    return Array.from(this.memories.values())
      .filter((m) => m.deletedAt !== undefined)
      .sort((a, b) => {
        // deletedAt 非 undefined 已由 filter 保证，降序排列（最近在前）
        return b.deletedAt! > a.deletedAt! ? 1 : b.deletedAt! < a.deletedAt! ? -1 : 0;
      })
      .slice(0, limit)
      .map((m) => ({ ...m }));
  }

  /**
   * 按 ID 获取单条软删除记忆
   *
   * 用于 restore/purge 操作前的存在性校验，避免 listDeleted 默认 50 上限
   * 导致回收站超量时操作失效。
   *
   * @param id 记忆唯一标识
   * @returns 软删除记忆（浅拷贝），不存在或未软删除时返回 null
   */
  getDeletedById(id: string): Memory | null {
    const mem = this.memories.get(id);
    // 不存在或未软删除（deletedAt 为 undefined）均返回 null
    if (!mem || mem.deletedAt === undefined) return null;
    return { ...mem };
  }

  /**
   * 清理过期的软删除记忆
   *
   * 物理删除所有 deletedAt 早于 before 的记忆。
   * 由宿主项目的定时器调用（默认 30 天保留期）。
   *
   * @param before - 时间阈值，deletedAt 早于此值的记忆将被物理删除
   * @returns 被清理的记忆数量
   */
  purgeExpired(before: Date): number {
    const beforeIso = before.toISOString();
    let count = 0;
    for (const [id, m] of this.memories) {
      // 仅清理已软删除且早于阈值的记忆
      if (m.deletedAt !== undefined && m.deletedAt < beforeIso) {
        this.memories.delete(id);
        count++;
      }
    }
    return count;
  }

  /**
   * 按 ID 获取单条活跃记忆（已软删除的返回 null）
   *
   * 返回浅拷贝，避免调用方修改污染存储内部对象（接口契约：读取隔离）
   */
  getById(id: string): Memory | null {
    const m = this.memories.get(id);
    // 已软删除的记忆返回 null（活跃态过滤）
    if (!m || m.deletedAt !== undefined) return null;
    return { ...m };
  }

  /**
   * 按来源标签获取活跃记忆（自动过滤已软删除的）
   *
   * 返回浅拷贝数组，避免调用方修改污染存储内部对象。
   *
   * @param source - 来源标签（如 'persona'、'rule'、'insight'）
   * @returns 该来源的所有活跃记忆（副本），按 score 降序排列
   */
  getBySource(source: string): Memory[] {
    return Array.from(this.memories.values())
      .filter((m) => m.source === source && m.deletedAt === undefined)
      .sort(byScoreDesc)
      .map((m) => ({ ...m }));
  }

  /**
   * 文本搜索活跃记忆（自动过滤已软删除的，内存版）
   *
   * 使用 segmentText() 规范分词，与 SqliteStorage 行为一致。
   * 搜索 content 和 name 字段，按 score 降序排列。
   *
   * @param query - 搜索查询文本
   * @param limit - 返回数量上限（默认 10）
   * @returns 匹配的活跃记忆列表
   */
  search(query: string, limit = 10): Memory[] {
    // 仅搜索活跃记忆（deletedAt === undefined）
    const activeMemories = Array.from(this.memories.values()).filter((m) => m.deletedAt === undefined);

    // 空查询：按 score 降序返回（浅拷贝，读取隔离）
    if (!query.trim()) {
      return this.sortCopyLimit(activeMemories, limit);
    }

    // 规范分词（与 recall.ts extractKeywords 共用 segmentText）
    const tokens = segmentLower(query);

    // 若分词后无有效 token，降级为按 score 返回
    if (tokens.length === 0) {
      return this.sortCopyLimit(activeMemories, limit);
    }

    const results = activeMemories.filter((m) => {
      const text = `${m.content} ${m.name}`.toLowerCase();
      // 任一 token 命中即可
      return tokens.some((t) => text.includes(t));
    });

    // 按 score 降序排序，返回浅拷贝（避免调用方修改污染存储内部对象）
    return this.sortCopyLimit(results, limit);
  }

  /**
   * 排序 + 截断 + 浅拷贝三件套
   *
   * 消除 search() 内 3 次重复的 .sort(byScoreDesc).slice(0, limit).map((m) => ({ ...m })) 模式
   * （ADR-017 枝叶层 2 次提取原则，3 次重复已超阈值）。
   *
   * @param memories 待处理的记忆数组
   * @param limit 返回数量上限
   * @returns 排序截断后的浅拷贝记忆数组
   */
  private sortCopyLimit(memories: Memory[], limit: number): Memory[] {
    return memories
      .sort(byScoreDesc)
      .slice(0, limit)
      .map((m) => ({ ...m }));
  }

  /**
   * 统计活跃记忆总数（不含已软删除的）
   *
   * 优化：直接累加 sourceCountCache 的所有值，O(sources) 复杂度。
   * 因 sourceCountCache 仅维护活跃记忆计数，求和即为活跃总数。
   */
  count(): number {
    let total = 0;
    for (const c of this.sourceCountCache.values()) total += c;
    return total;
  }

  /**
   * 按来源标签统计记忆数量
   *
   * 优化：直接读取 sourceCountCache，O(1) 复杂度
   * （getAllSources 为 O(sources)，因需拷贝 Map，二者复杂度不同）
   * 原实现 O(n) 遍历所有记忆，与增量缓存设计不一致
   */
  countBySource(source: string): number {
    return this.sourceCountCache.get(source) ?? 0;
  }

  /**
   * 衰减指定来源的活跃记忆 score（跳过已软删除的）
   *
   * 遍历所有匹配 source 的活跃记忆，按时间衰减。
   * 生产环境宿主（SqliteStorage）应重写为 SQL UPDATE 批量操作。
   */
  decayScores(sources: string[], now: Date): number {
    let count = 0;
    for (const m of this.memories.values()) {
      // 跳过已软删除的记忆
      if (m.deletedAt !== undefined) continue;
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
   * 优化：直接读取增量维护的 sourceCountCache。
   * 复杂度为 O(sources)（拷贝 Map），相比全量遍历 O(n) 仍有显著优化。
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

  // ─── source 缓存辅助方法 ─────────────────────────────

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
