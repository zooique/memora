/**
 * 记忆关系存储接口 — 独立于 IMemoryStorage 的侧车接口
 *
 * 设计原则（ADR-014）：
 * - 侧车模型：不侵入 Memory 7 字段基元，与 IMemoryStorage 平行存在
 * - 接口注入：内核提供接口，宿主项目注入实现（如 SqliteRelationStore）
 * - 零 native 依赖：内核不依赖 better-sqlite3 等 native 模块
 *
 * 宿主项目实现示例：
 * - SqliteRelationStore：扩展 memory_relations 表，依赖 better-sqlite3
 * - InMemoryRelationStore：测试用实现，纯内存数组
 *
 * 关系构建时机与层属（ADR-014 §5）：
 * - 机制层（候选召回 + prompt 构建 + 关系写入 + 冲突检测）在内核
 *   src/agent/managers/relationBuilder.ts，LLM 调用合并到 InsightExtractor
 *   单次 extract() 中，不增加 LLM 调用次数
 * - 宿主项目（Sprite 层）仅需注入 IMemoryRelationStore 实现
 * - 遵循降级优先（ADR-006）：关系构建失败不阻塞对话，仅记录日志
 */
import type { MemoryRelation, RelationDirection } from '@/memory/types.js';

/**
 * 记忆关系存储接口（侧车）
 *
 * 独立于 IMemoryStorage，不依赖 Memory 7 字段。
 * 宿主项目实现此接口并注入 Agent，用于：
 * - 冲突检测：getRelationsByType('contradicts')
 * - 召回增强：getRelations(memoryId, 'both')
 * - 拓扑可视化：getAllRelations()
 */
export interface IMemoryRelationStore {
  /**
   * 添加关系
   *
   * sourceId+targetId+type 三元组唯一约束，重复添加应幂等（更新 weight/createdAt 或忽略）。
   *
   * @param relation 关系数据（sourceId/targetId/type/weight/createdAt）
   */
  addRelation(relation: MemoryRelation): void;

  /**
   * 查询某记忆的关系
   *
   * @param memoryId 记忆 ID
   * @param direction 方向过滤（默认 'both'）：
   *   - 'outgoing'：只查 sourceId = memoryId 的关系（冲突检测用）
   *   - 'incoming'：只查 targetId = memoryId 的关系
   *   - 'both'：合并两个方向并去重（可视化/召回增强用）
   * @returns 匹配的关系列表
   */
  getRelations(memoryId: string, direction?: RelationDirection): MemoryRelation[];

  /**
   * 按关系类型查询
   *
   * 用于冲突检测：getRelationsByType('contradicts') 获取所有矛盾关系。
   *
   * @param type 关系类型（开放字符串，如 'contradicts'/'supports'/'follows'）
   * @returns 匹配的关系列表
   */
  getRelationsByType(type: string): MemoryRelation[];

  /**
   * 获取全部关系
   *
   * 用于拓扑可视化构建节点+边图谱。
   * 数据量大时（>10000）可改为分页，但 Phase 1 不需要。
   *
   * @returns 全部关系列表
   */
  getAllRelations(): MemoryRelation[];

  /**
   * 删除指定关系
   *
   * sourceId+targetId+type 唯一定位，删除单条关系。
   * 用于关系修正（用户确认冲突后删除误判关系）。
   *
   * @param sourceId 关系起点
   * @param targetId 关系终点
   * @param type 关系类型
   */
  removeRelation(sourceId: string, targetId: string, type: string): void;

  /**
   * 删除某记忆的所有关系（不论方向）
   *
   * 删除 sourceId 或 targetId 等于 memoryId 的所有关系边。
   * 用于记忆删除/物理清除场景，防止 memory_relations 表残留孤儿边。
   *
   * 实现约束：
   * - 必须原子执行（单条 SQL DELETE WHERE sourceId=? OR targetId=?）
   * - 返回被删除的关系数量，便于审计
   * - 不存在的 memoryId 返回 0，不抛错
   *
   * @param memoryId 记忆 ID
   * @returns 被删除的关系数量
   */
  removeRelationsByMemoryId(memoryId: string): number;
}
