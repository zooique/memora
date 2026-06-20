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
   * 删除记忆
   */
  delete(id: string): void;

  /**
   * 按 ID 获取单条记忆
   */
  getById(id: string): Memory | null;

  /**
   * 按来源标签获取记忆
   *
   * @param source - 来源标签（如 'persona'、'rule'、'insight'）
   * @returns 该来源的所有记忆
   */
  getBySource(source: string): Memory[];

  /**
   * 关键词搜索记忆
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
   * @returns 匹配的记忆列表
   */
  search(query: string, limit?: number): Memory[];

  /**
   * 统计记忆总数
   *
   * 比 search('', largeLimit).length 更高效，避免全量加载数据。
   * 宿主实现应使用 COUNT(*) 等数据库原生计数。
   */
  count(): number;

  /**
   * 按来源标签统计记忆数量
   *
   * 比 getBySource(source).length 更高效，避免全量加载对象。
   * 宿主实现应使用 COUNT(*) WHERE source = ? 等数据库原生计数。
   */
  countBySource(source: string): number;

  /**
   * 衰减指定来源的记忆 score（自然遗忘机制）
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
   * 关闭存储连接（可选）
   *
   * 宿主注入的实现可能不需要关闭（如共享数据库连接），
   * 所以此方法是可选的。
   */
  close?(): void;
}
