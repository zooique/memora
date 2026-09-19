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
 * 记忆存储接口 — 所有方法同步（对齐 better-sqlite3），可后续新增 IAsyncMemoryStorage 支持异步后端。
 *
 * ⚠️ 契约隐含假设（宿主实现须知）：同步语义要求单次调用低延迟。JSON 文件落地实现（如 vscode 宿主
 * workspaceStorage）在记忆量增长时，upsert 等写路径会触发全量 `JSON.stringify` 重写，
 * 1 万条规模即达 MB 级单次同步 I/O，会阻塞事件循环。因此：**生产由宿主注入持久化实现**——当前
 * vscode 宿主为 JSON 文件（WorkspaceStorage，小规模够用）；记忆量增长时建议宿主评估更优存储
 * （如 better-sqlite3，同步语义与本接口对齐）；InMemoryStorage 仅用于测试与未注入时 fallback。
 */
export interface IMemoryStorage {
  /**
   * 插入或更新记忆；source 为开放字符串可自定义，但写入须经 validateSource 统一校验
   *（内核 inMemoryStorage 与宿主 workspaceStorage 已接入 block/warn 分级拦截，2026-09-06 DC-1 注释对齐）。
   * 契约（2026-08-25）：整对象覆盖、无 CAS 乐观锁——单 Agent 设计假设；
   * 多 Agent 并发写同会话需扩展版本字段/条件更新，内核当前不承诺并发一致性。
   */
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
   * LIKE 匹配 content/name，按 accessedAt 降序（最近使用优先）返回 top N。
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
   * 刷新记忆 accessedAt（使用轨迹写位）。score 退役后（2026-09-09 阶段3）唯一写位，
   * 召回命中 / 工具命中经此「被想起即刷新」；toSetting 不 +score/delta，无 clamp 语义。
   * @returns 记忆不存在/软删除时返回 false，成功返回 true
   */
  touch(id: string, now: string): boolean;

  /**
   * 获取所有 source 标签及活跃记忆数量；替代 stats()/sourceHealth() 的全量遍历，
   * 宿主用 SQL GROUP BY source，InMemoryStorage 维护增量 source→count 缓存
   */
  getAllSources(): Map<string, number>;

  /**
   * 可选：终结操作，调用后本实例不得再读写。落盘实现断开连接但数据保留；
   * InMemoryStorage 则丢弃全部记忆（内存即存储介质，不释放就是泄漏）。
   * 不可当作可逆的「暂停」——会话暂停/检查点恢复不得触碰，否则连带清空资源层记忆
   */
  close?(): void;
}