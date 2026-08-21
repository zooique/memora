/**
 * 记忆存储接口 — Memora 内核与具体数据库实现的解耦边界
 *
 * 内核（agent/ + memory/ + persona/ + skill/）不依赖具体数据库：宿主（如泊文 Electron
 * 主进程）持有 better-sqlite3 实例并实现此接口注入 Agent；测试用 InMemoryStorage；不注入时
 * Agent 内部用 InMemoryStorage 作 fallback（重启后数据丢失）。方法保持同步语义，调用方已有
 * await 调用仍安全。软删除语义：delete 写入 deletedAt，查询类方法自动过滤已删除记忆，
 * restore 恢复，purge 物理删，listDeleted/purgeExpired 管理回收站。
 */
import type { Memory } from '@/memory/types.js';

/**
 * 记忆存储接口 — 所有方法同步（对齐 better-sqlite3），可后续新增 IAsyncMemoryStorage 支持异步后端
 */
export interface IMemoryStorage {
  /** 插入或更新记忆；source 为开放字符串，无校验限制 */
  upsert(memory: Memory): void;

  /**
   * 软删除（移入回收站）：写入 deletedAt，不物理移除；对已软删除的记忆为 no-op。
   * 召回/搜索/列表/统计自动过滤，可 restore 恢复，回收站保留期满由 purgeExpired 物理清理
   */
  delete(id: string): void;

  /** 恢复软删除记忆（清除 deletedAt）；对活跃记忆为 no-op */
  restore(id: string): void;

  /** 物理删除，不可恢复；用于回收站彻底删除或测试强制清理 */
  purge(id: string): void;

  /**
   * 列出回收站软删除记忆，按 deletedAt 降序（最近删除在前）
   * @param limit - 上限；<=0 或 undefined 表示全部，正整数 N 表示最近 N 条
   * @returns 软删除记忆列表（浅拷贝）
   */
  listDeleted(limit?: number): Memory[];

  /**
   * 按 ID 获取单条软删除记忆；用于 restore/purge 前的存在性校验，
   * 规避 listDeleted 默认 50 上限导致第 51 条之后无法操作
   * @returns 软删除记忆（浅拷贝），不存在或未软删除时返回 null
   */
  getDeletedById(id: string): Memory | null;

  /**
   * 物理删除所有 deletedAt 早于 before 的记忆；由宿主定时器调用（默认 30 天保留期）
   * @returns 被清理的记忆数量
   */
  purgeExpired(before: Date): number;

  /** 按 ID 获取单条活跃记忆；已软删除的返回 null（软删除记忆用 listDeleted） */
  getById(id: string): Memory | null;

  /** 按来源标签获取活跃记忆（自动过滤已软删除的） */
  getBySource(source: string): Memory[];

  /**
   * 关键词搜索活跃记忆。宿主实现：Intl.Segmenter 分词 + 停用词过滤，
   * LIKE 匹配 content/name，按 score 降序返回 top N。
   * InMemoryStorage 用 segmentText() 分词 + includes 匹配（与 SqliteStorage 一致）
   * @param limit - 返回上限（默认 10）
   */
  search(query: string, limit?: number): Memory[];

  /**
   * 统计活跃记忆总数；比 search('', largeLimit).length 高效，宿主用 COUNT(*) WHERE deleted_at IS NULL
   */
  count(): number;

  /** 按来源统计活跃记忆数量（高效版，宿主用 COUNT(*) GROUP BY） */
  countBySource(source: string): number;

  /**
   * 衰减指定来源活跃记忆的 score（自然遗忘，跳过已软删除的）。
   * 宿主可用一条 SQL UPDATE 批量完成，避免内核逐条全量加载
   */
  decayScores(sources: string[], now: Date): number;

  /**
   * 原子增加记忆 score：score = clamp(score + delta, DECAY_FLOOR, SCORE_CEILING)，
   * 同时更新 accessedAt 为 now；消除 boost 路径 read-modify-write 并发冲突，
   * 宿主用一条 SQL UPDATE 完成
   * @returns 记忆不存在/软删除时返回 false，成功返回 true
   */
  incrementScore(id: string, delta: number, now: string): boolean;

  /**
   * 原子设置 score 绝对值：直接设 newScore（不 clamp，调用方负责传合法值），
   * 同时更新 accessedAt；用于 demote 场景避免 spread 旧快照覆盖 content 等字段
   * @returns 记忆不存在/软删除时返回 false，成功返回 true
   */
  setScore(id: string, newScore: number, now: string): boolean;

  /**
   * 获取所有 source 标签及活跃记忆数量；替代 stats()/sourceHealth() 的全量遍历，
   * 宿主用 SQL GROUP BY source，InMemoryStorage 维护增量 source→count 缓存
   */
  getAllSources(): Map<string, number>;

  /**
   * 可选：列出"即将自然沉底"的活跃记忆（accessedAt 早于 before），
   * 按沉底顺序（accessedAt 升序；相同时 score 升序）取前 limit 条。
   *
   * 纯只读健康观测，不触发衰减。作为可选方法（与 close? 同风格）——
   * 宿主可不实现；不实现时由上层（MemoryInspector）以 search+本地过滤回退。
   * 宿主实现时可用一条 SQL 高效完成（WHERE accessed_at < ? ORDER BY accessed_at, score LIMIT ?）。
   *
   * @param before - 访问截止时间（ISO 8601），早于该值视为"即将沉底"
   * @param limit - 返回上限（正整数）
   * @returns 符合条件的 Memory[]（无候选则空数组）
   */
  listFading?(before: string, limit?: number): Memory[];

  /**
   * 可选：终结操作，调用后本实例不得再读写。落盘实现断开连接但数据保留；
   * InMemoryStorage 则丢弃全部记忆（内存即存储介质，不释放就是泄漏）。
   * 不可当作可逆的「暂停」——会话暂停/检查点恢复不得触碰，否则连带清空资源层记忆
   */
  close?(): void;
}