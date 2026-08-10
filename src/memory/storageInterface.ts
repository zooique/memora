/**
 * 记忆存储接口 — Memora 内核与具体数据库实现的解耦边界
 *
 * 设计目标：
 *   - Memora 内核（agent/ + memory/ + persona/ + skill/）不依赖任何具体数据库
 *   - 宿主项目（如泊文 Electron 主进程）持有 better-sqlite3 实例，实现此接口后注入 Agent
 *   - 测试环境可使用 InMemoryStorage（零依赖、零 IO）
 *   - 不注入时 Agent 内部使用 InMemoryStorage 作为 fallback（数据重启后丢失）
 *
 * 分层约束（ADR-002 v0.7）：
 *   泊文宿主     → 持有 better-sqlite3，实现 IMemoryStorage，注入 Agent
 *   Memora 内核  → 纯业务逻辑，仅依赖此接口（零 native 依赖）
 *
 * 方法签名保持同步语义（与 better-sqlite3 一致），
 * 调用方已有的 `await` 调用仍然安全（await 同步值 = 立即返回）。
 *
 * 软删除语义：
 *   - delete(id) 为软删除，写入 deletedAt，不物理移除
 *   - 所有查询方法（getById/getBySource/search/count/countBySource/decayScores/getAllSources）
 *     自动过滤 deletedAt != undefined 的记忆
 *   - restore(id) 恢复软删除记忆，purge(id) 物理删除
 *   - listDeleted(limit) 列出回收站，purgeExpired(before) 清理过期回收站
 *   - 详见 ADR-004 v2.1 软删除扩展
 */
import type { Memory } from '@/memory/types.js';

/**
 * 记忆存储接口
 *
 * 所有方法均为同步（与 better-sqlite3 API 对齐），
 * 调用方已有的 `await` 调用仍然安全（await 同步值 = 立即返回）。
 * 未来如需支持异步存储后端（如 IndexedDB），可新增 IAsyncMemoryStorage 接口。
 */
export interface IMemoryStorage {
  /**
   * 插入或更新记忆
   *
   * source 字段为开放字符串，无校验限制
   */
  upsert(memory: Memory): void;

  /**
   * 删除记忆（软删除）
   *
   * 语义为"移入回收站"：写入 deletedAt 时间戳，不物理移除。
   * - 召回/搜索/列表/统计自动过滤已软删除的记忆
   * - 可通过 restore(id) 恢复
   * - 回收站保留期过后由 purgeExpired(before) 物理清理
   *
   * 对已软删除的记忆调用为 no-op。
   *
   * @param id - 记忆 ID
   */
  delete(id: string): void;

  /**
   * 恢复软删除的记忆
   *
   * 将 deletedAt 字段清除，使记忆重新出现在召回/搜索/列表中。
   * 对活跃记忆调用为 no-op。
   *
   * @param id - 记忆 ID
   */
  restore(id: string): void;

  /**
   * 物理删除记忆
   *
   * 从存储中彻底移除，不可恢复。
   * 用于回收站的"彻底删除"操作，或测试环境的强制清理。
   *
   * @param id - 记忆 ID
   */
  purge(id: string): void;

  /**
   * 列出回收站中的软删除记忆
   *
   * 按 deletedAt 降序（最近删除的在前），便于回收站 UI 展示。
   *
   * @param limit - 返回数量上限。`limit <= 0` 或 `undefined` 表示不设上限（返回全部）；
   *                正整数 N 表示返回最近 N 条。默认 undefined（全部）。
   * @returns 软删除记忆列表（浅拷贝）
   */
  listDeleted(limit?: number): Memory[];

  /**
   * 按 ID 获取单条软删除记忆
   *
   * 用于 restore/purge 操作前的存在性校验，避免 listDeleted() 默认 50 上限
   * 导致回收站超量时第 51 条之后的记忆无法 restore/purge。
   *
   * @param id - 记忆 ID
   * @returns 软删除记忆（浅拷贝），不存在或未软删除时返回 null
   */
  getDeletedById(id: string): Memory | null;

  /**
   * 清理过期的软删除记忆
   *
   * 物理删除所有 deletedAt 早于 before 的记忆。
   * 由宿主项目的定时器调用（默认 30 天保留期）。
   *
   * @param before - 时间阈值，deletedAt 早于此值的记忆将被物理删除
   * @returns 被清理的记忆数量
   */
  purgeExpired(before: Date): number;

  /**
   * 按 ID 获取单条活跃记忆
   *
   * 已软删除的记忆（deletedAt != undefined）返回 null。
   * 如需获取软删除记忆，请使用 listDeleted()。
   */
  getById(id: string): Memory | null;

  /**
   * 按来源标签获取活跃记忆（自动过滤已软删除的）
   *
   * @param source - 来源标签（如 'persona'、'rule'、'insight'）
   * @returns 该来源的所有活跃记忆
   */
  getBySource(source: string): Memory[];

  /**
   * 关键词搜索活跃记忆（自动过滤已软删除的）
   *
   * 搜索逻辑（宿主实现）：
   * 1. 从 query 中提取关键词（推荐使用 Intl.Segmenter 分词 + 停用词过滤）
   * 2. 用 LIKE 关键词匹配 content 和 name 字段
   * 3. 按 score 降序排列
   * 4. 返回 top N 结果
   *
   * InMemoryStorage 使用 segmentText() 规范分词 + includes 匹配（与 SqliteStorage 行为一致）。
   *
   * @param query - 搜索查询文本
   * @param limit - 返回数量上限（默认 10）
   * @returns 匹配的活跃记忆列表
   */
  search(query: string, limit?: number): Memory[];

  /**
   * 统计活跃记忆总数（不含已软删除的）
   *
   * 比 search('', largeLimit).length 更高效，避免全量加载数据。
   * 宿主实现应使用 COUNT(*) WHERE deleted_at IS NULL。
   */
  count(): number;

  /**
   * 按来源标签统计活跃记忆数量（不含已软删除的）
   *
   * 比 getBySource(source).length 更高效，避免全量加载对象。
   * 宿主实现应使用 COUNT(*) WHERE source = ? AND deleted_at IS NULL。
   */
  countBySource(source: string): number;

  /**
   * 衰减指定来源的活跃记忆 score（自然遗忘机制，跳过已软删除的）
   *
   * 长时间未访问的记忆 score 逐渐降低。
   * 宿主实现（SqliteStorage）可用一条 SQL UPDATE 批量完成，
   * 避免内核逐条全量加载。
   *
   * @param sources - 要衰减的来源标签列表（如 ['insight', 'profile']）
   * @param now - 当前时间
   * @returns 受影响的记忆数量
   */
  decayScores(sources: string[], now: Date): number;

  /**
   * 原子增加记忆 score（MIND2-L3：消除 boost 路径 read-modify-write 并发冲突）
   *
   * score = clamp(score + delta, DECAY_FLOOR, SCORE_CEILING)，同时更新 accessedAt 为 now。
   * 与 decayScores 同模式：宿主实现用一条 SQL UPDATE 完成原子操作，避免读回内存。
   *
   * @param id 记忆 ID
   * @param delta 增量（正数 boost，负数可降级）
   * @param now 当前时间（ISO 8601，用于更新 accessedAt）
   * @returns 记忆不存在/软删除时返回 false，成功返回 true
   */
  incrementScore(id: string, delta: number, now: string): boolean;

  /**
   * 原子设置记忆 score 绝对值（MIND2-L3：消除 demote 路径 spread 旧快照覆盖其他字段）
   *
   * 直接设置 score = newScore，不 clamp（调用方负责传合法值）。同时更新 accessedAt 为 now。
   * 用于 demoteMemory / demoteOutdatedMemory 等设绝对值场景，避免 spread 旧快照覆盖 content 等字段。
   *
   * @param id 记忆 ID
   * @param newScore 新 score 绝对值
   * @param now 当前时间（ISO 8601，用于更新 accessedAt）
   * @returns 记忆不存在/软删除时返回 false，成功返回 true
   */
  setScore(id: string, newScore: number, now: string): boolean;

  /**
   * 获取所有 source 标签及其活跃记忆数量（不含已软删除的）
   *
   * 优化：替代 stats()/sourceHealth() 中的全量 search + 逐条遍历，
   * 宿主实现应使用 SQL `SELECT source, COUNT(*) FROM memories WHERE deleted_at IS NULL GROUP BY source`，
   * InMemoryStorage 维护增量更新的 source→count 缓存。
   *
   * @returns source 标签到数量的映射（如 { persona: 3, insight: 12, ... }）
   */
  getAllSources(): Map<string, number>;

  /**
   * 关闭存储（可选）
   *
   * 宿主注入的实现可能不需要关闭（如共享数据库连接），
   * 所以此方法是可选的。
   *
   * **契约（SSOT-R4-T10 显式化，2026-08-10）**：close() 是终结操作，
   * 调用后本实例不得再被读写。各实现对「关闭」的物理含义不同——
   * 落盘实现断开连接、数据保留；`InMemoryStorage` 则丢弃全部记忆（内存即其存储介质，
   * 不释放就是泄漏）。因此**不要把 close() 当作可逆的「暂停」**：
   * 会话暂停 / 检查点恢复等状态层动作一律不得触碰本方法，
   * 否则会连带清空属于资源层的记忆。
   */
  close?(): void;
}
