/**
 * InMemoryRelationStore — 内存关系存储测试用实现
 *
 * 职责：
 * - 实现 IMemoryRelationStore 接口，纯内存数组存储
 * - 用于单元测试和开发环境验证，不持久化
 * - 与 InMemoryStorage 对齐，提供零 IO 的测试基座
 *
 * 设计原则（ADR-014）：
 * - 零 native 依赖：纯 JS 数组操作
 * - 幂等添加：sourceId+targetId+type 三元组唯一，重复添加更新 weight/createdAt
 * - 方向过滤：getRelations 按 direction 参数过滤 sourceId/targetId
 *
 * 宿主项目应实现 SqliteRelationStore（依赖 better-sqlite3）用于生产环境。
 */
import type { MemoryRelation, RelationDirection } from './types.js';
import type { IMemoryRelationStore } from './relationStore.js';

export class InMemoryRelationStore implements IMemoryRelationStore {
  /** 关系列表（内存数组，不持久化） */
  private readonly relations: MemoryRelation[] = [];

  /**
   * 添加关系
   *
   * 三元组唯一约束：sourceId+targetId+type 已存在时更新 weight/createdAt（幂等）。
   */
  addRelation(relation: MemoryRelation): void {
    const existingIdx = this.relations.findIndex(
      (r) =>
        r.sourceId === relation.sourceId &&
        r.targetId === relation.targetId &&
        r.type === relation.type,
    );
    if (existingIdx >= 0) {
      // 幂等更新：保留原位置，覆盖 weight 和 createdAt
      this.relations[existingIdx] = { ...relation };
    } else {
      this.relations.push({ ...relation });
    }
  }

  /**
   * 查询某记忆的关系
   *
   * direction 控制方向过滤：
   * - 'outgoing'：sourceId = memoryId
   * - 'incoming'：targetId = memoryId
   * - 'both'：合并两个方向并去重（基于对象引用）
   */
  getRelations(memoryId: string, direction: RelationDirection = 'both'): MemoryRelation[] {
    if (direction === 'outgoing') {
      return this.relations.filter((r) => r.sourceId === memoryId).map((r) => ({ ...r }));
    }
    if (direction === 'incoming') {
      return this.relations.filter((r) => r.targetId === memoryId).map((r) => ({ ...r }));
    }
    // 'both'：合并两个方向并去重
    const seen = new Set<MemoryRelation>();
    for (const r of this.relations) {
      if (r.sourceId === memoryId || r.targetId === memoryId) {
        seen.add(r);
      }
    }
    return [...seen].map((r) => ({ ...r }));
  }

  /**
   * 按关系类型查询
   */
  getRelationsByType(type: string): MemoryRelation[] {
    return this.relations.filter((r) => r.type === type).map((r) => ({ ...r }));
  }

  /**
   * 获取全部关系
   */
  getAllRelations(): MemoryRelation[] {
    return this.relations.map((r) => ({ ...r }));
  }

  /**
   * 删除指定关系
   *
   * sourceId+targetId+type 唯一定位，删除单条关系。
   */
  removeRelation(sourceId: string, targetId: string, type: string): void {
    const idx = this.relations.findIndex(
      (r) => r.sourceId === sourceId && r.targetId === targetId && r.type === type,
    );
    if (idx >= 0) {
      this.relations.splice(idx, 1);
    }
  }
}
