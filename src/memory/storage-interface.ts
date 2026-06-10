/**
 * 记忆存储接口 — Memora 内核与具体数据库实现的解耦边界
 *
 * 设计目标：
 *   - Memora 内核（agent/ + memory/ + persona/ + skill/）不依赖任何具体数据库
 *   - 宿主项目（如泊文 Electron 主进程）持有 better-sqlite3 实例，实现此接口后注入 Agent
 *   - 测试环境可使用 InMemoryStorage（零依赖、零 IO）
 *   - CLI 独立运行时，内部自行创建 SqliteStorage（仍需 better-sqlite3）
 *
 * 分层约束（ADR-002 v0.3）：
 *   Electron 壳层 → 提供 Node 原生模块执行环境
 *   泊文宿主     → 持有 better-sqlite3，实现 IMemoryStorage，注入 Agent
 *   Memora 内核  → 纯业务逻辑，仅依赖此接口
 *
 * 方法签名保持同步语义（与 better-sqlite3 一致），
 * 调用方已有的 `await` 调用仍然安全（await 同步值 = 立即返回）。
 */
import type { Memory, MemoryTypeValue, PermanenceValue } from './types.js';

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
   * type 和 permanence 字段必须通过校验（见 MemoryIndex 的防御性校验逻辑）
   */
  upsert(memory: Memory): void;

  /**
   * 删除记忆
   */
  delete(id: string): void;

  /**
   * 按永久性等级获取记忆
   * 启动时加载 always + domain 必召记忆
   */
  getByPermanence(permanence: PermanenceValue): Memory[];

  /**
   * 按 ID 获取单条记忆
   * 向量搜索命中但关键词搜索未命中时，需要按 ID 加载
   */
  getById(id: string): Memory | null;

  /**
   * 按类型获取记忆
   */
  getByType(type: MemoryTypeValue): Memory[];

  /**
   * 触摸记忆：被搜索命中时调用
   *
   * 哲学：「而生其心」——被当下需要时重新"活过来"。
   * weight 重置为 1.0，updated_at 更新为现在，衰减时钟重新开始。
   */
  touch(ids: string[]): void;

  /**
   * 应用记忆权重自然衰减
   *
   * 哲学：「应无所住」——不用的记忆自然淡出。
   * 衰减公式：newWeight = max(MIN_WEIGHT, weight × 0.5^(ageDays / halfLife))
   *
   * @param halfLifeDays 不同永久性等级的半衰期（天数）
   * @returns 各永久性等级衰减的记忆数量
   */
  applyDecay(halfLifeDays: Record<PermanenceValue, number>): Record<PermanenceValue, number>;

  /**
   * 中文分词搜索
   *
   * @param query 搜索关键词
   * @param limit 返回数量上限（默认 10）
   * @param mode 'match' = OR 连接（任一 token 命中），'near' = AND 连接（所有 token 必须命中）
   */
  search(query: string, limit?: number, mode?: 'match' | 'near'): Memory[];

  /**
   * 关闭存储连接（可选）
   *
   * 宿主注入的实现可能不需要关闭（如共享数据库连接），
   * 所以此方法是可选的。CLI 自建的 SqliteStorage 需要关闭。
   */
  close?(): void;
}
