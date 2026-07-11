/**
 * 记忆写入器 — 统一的记忆写操作代理
 *
 * 从 MemoryInspector 拆分出来，专职负责 IMemoryStorage + IMemoryRelationStore 的写操作。
 *
 * 设计原则：
 *   - 与 MemoryInspector 严格分工：本类只写不读，MemoryInspector 只读不写
 *   - 薄层代理——所有方法直接透传到 IMemoryStorage / IMemoryRelationStore，
 *     不增加业务逻辑，仅提供"宿主通过 agent.memoryMutator 访问写操作"的分层入口
 *   - 静默降级——relationStore 未注入时关系写方法静默 no-op（ADR-014 降级优先）
 *
 * 与 MemoryInspector 的分工（1.0 接口稳定化）：
 *   - agent.memory（MemoryInspector）：snapshot / search / stats / 关系查询 / getById / list 等
 *   - agent.memoryMutator（MemoryMutator）：upsert / delete / restore / purge / purgeExpired /
 *     addRelation / removeRelation
 *
 * 详见 ADR-010（Agent 门面）
 */
import type { Memory, MemoryRelation } from '@/memory/types.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import type { IMemoryRelationStore } from '@/memory/relationStore.js';

/**
 * 记忆写入器类
 *
 * 宿主项目通过 agent.memoryMutator 访问写操作，无需绕过 inspector 直接访问 agent.storage
 * （后者已废弃，详见 agent.ts）。
 */
export class MemoryMutator {
  /** 关系存储侧车（可选，ADR-014，未注入时关系写方法静默 no-op） */
  private readonly relationStore: IMemoryRelationStore | null;

  /**
   * @param index - 记忆存储（用于 upsert/delete/restore/purge/purgeExpired）
   * @param relationStore - 关系存储侧车（可选，用于 addRelation/removeRelation）
   */
  constructor(
    private readonly index: IMemoryStorage,
    relationStore: IMemoryRelationStore | null = null,
  ) {
    this.relationStore = relationStore;
  }

  // ─── 记忆写入（IMemoryStorage 代理） ───────────────────

  /**
   * 插入或更新记忆
   *
   * @param memory 完整记忆对象
   */
  upsert(memory: Memory): void {
    this.index.upsert(memory);
  }

  /**
   * 软删除记忆（写入 deletedAt）
   *
   * @param id 记忆唯一标识（${source}:${name} 格式）
   */
  delete(id: string): void {
    this.index.delete(id);
  }

  /**
   * 恢复软删除的记忆（清除 deletedAt）
   *
   * @param id 记忆唯一标识
   */
  restore(id: string): void {
    this.index.restore(id);
  }

  /**
   * 物理删除记忆（不可恢复，用于回收站彻底删除）
   *
   * @param id 记忆唯一标识
   */
  purge(id: string): void {
    this.index.purge(id);
  }

  /**
   * 清理过期的软删除记忆
   *
   * 物理删除所有 deletedAt 早于 before 的记忆。
   * 由宿主项目的定时器调用（默认 30 天保留期）。
   *
   * @param before 时间阈值，deletedAt 早于此值的记忆将被物理删除
   * @returns 被清理的记忆数量
   */
  purgeExpired(before: Date): number {
    return this.index.purgeExpired(before);
  }

  // ─── 关系写入（IMemoryRelationStore 代理，ADR-014 侧车） ───

  /**
   * 添加记忆关系（透传 relationStore）
   *
   * 用于宿主 UI 手动创建关系（关系图右键菜单 → 连线 → 创建关系）。
   * relationStore 未注入时静默降级（不阻塞）。
   *
   * @param relation 关系边数据
   */
  addRelation(relation: MemoryRelation): void {
    if (!this.relationStore) return;
    this.relationStore.addRelation(relation);
  }

  /**
   * 删除记忆关系（透传 relationStore）
   *
   * 用于宿主 UI 手动删除关系（关系图右键菜单 → 编辑关系 → 删除）。
   * relationStore 未注入时静默降级（不阻塞）。
   *
   * @param sourceId 关系起点
   * @param targetId 关系终点
   * @param type 关系类型
   */
  removeRelation(sourceId: string, targetId: string, type: string): void {
    if (!this.relationStore) return;
    this.relationStore.removeRelation(sourceId, targetId, type);
  }
}
