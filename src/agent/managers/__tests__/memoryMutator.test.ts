/**
 * 单元测试：MemoryMutator 记忆写入器
 *
 * P1-2 拆分：从 MemoryInspector 拆出写操作代理，专职负责
 * IMemoryStorage + IMemoryRelationStore 的写操作。
 *
 * 覆盖 MemoryMutator 全部 7 个公开方法：
 *   - 记忆写入：upsert / delete / restore / purge / purgeExpired
 *   - 关系写入：addRelation / removeRelation（relationStore 未注入时静默 no-op）
 *
 * Mock 策略：
 *   - InMemoryStorage / InMemoryRelationStore 用真实实现（测试夹具）
 *   - 通过 storage 直接读取验证 mutator 写入结果（读写隔离）
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { MemoryMutator } from '@/agent/managers/memoryMutator.js';
import { InMemoryStorage } from '@/memory/inMemoryStorage.js';
import { InMemoryRelationStore } from '@/memory/inMemoryRelationStore.js';
import type { Memory } from '@/memory/types.js';

/**
 * 创建测试用 Memory 对象
 *
 * @param overrides - 覆盖默认字段值
 * @returns 完整的 Memory 对象
 */
function createMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'test:default',
    content: '默认内容',
    source: 'insight',
    name: 'default',
    createdAt: '2026-06-27T10:00:00.000Z',
    accessedAt: '2026-06-27T10:00:00.000Z',
    score: 0.5,
    ...overrides,
  };
}

describe('MemoryMutator', () => {
  let storage: InMemoryStorage;
  let relationStore: InMemoryRelationStore;
  let mutator: MemoryMutator;

  beforeEach(() => {
    storage = new InMemoryStorage();
    relationStore = new InMemoryRelationStore();
    mutator = new MemoryMutator(storage, relationStore);
  });

  // ════════════════════════════════════════════════════════
  // 1. 记忆写入（IMemoryStorage 代理）
  // ════════════════════════════════════════════════════════

  describe('记忆写入', () => {
    it('upsert 应委托 index.upsert（写入后可读取）', () => {
      const mem = createMemory({ id: 'rule:1', source: 'rule', name: 'r1' });
      mutator.upsert(mem);
      // 通过 storage 直接读取验证（读写隔离）
      expect(storage.getById('rule:1')).toEqual(mem);
    });

    it('upsert 应支持更新已存在的记忆', () => {
      const mem = createMemory({ id: 'rule:1', source: 'rule', name: 'r1', score: 0.5 });
      mutator.upsert(mem);
      // 更新 score
      mutator.upsert({ ...mem, score: 0.9 });
      expect(storage.getById('rule:1')!.score).toBe(0.9);
    });

    it('delete 应软删除记忆（写入 deletedAt，getById 返回 null）', () => {
      const mem = createMemory({ id: 'rule:1', source: 'rule', name: 'r1' });
      mutator.upsert(mem);
      mutator.delete('rule:1');
      // 软删除后 getById 返回 null
      expect(storage.getById('rule:1')).toBeNull();
      // 但 getDeletedById 可读取
      const deleted = storage.getDeletedById('rule:1');
      expect(deleted).not.toBeNull();
      expect(deleted!.deletedAt).toBeTruthy();
    });

    it('delete 对不存在的 id 应为 no-op', () => {
      expect(() => mutator.delete('nonexistent')).not.toThrow();
    });

    it('delete 对已软删除的记忆应为 no-op', () => {
      const mem = createMemory({ id: 'rule:1', source: 'rule', name: 'r1' });
      mutator.upsert(mem);
      mutator.delete('rule:1');
      const firstDeletedAt = storage.getDeletedById('rule:1')!.deletedAt;
      // 再次 delete 不应更新 deletedAt
      mutator.delete('rule:1');
      expect(storage.getDeletedById('rule:1')!.deletedAt).toBe(firstDeletedAt);
    });

    it('restore 应恢复软删除的记忆（清除 deletedAt）', () => {
      const mem = createMemory({ id: 'rule:1', source: 'rule', name: 'r1' });
      mutator.upsert(mem);
      mutator.delete('rule:1');
      expect(storage.getById('rule:1')).toBeNull();
      // 恢复
      mutator.restore('rule:1');
      expect(storage.getById('rule:1')).not.toBeNull();
      expect(storage.getById('rule:1')!.deletedAt).toBeUndefined();
    });

    it('restore 对活跃记忆应为 no-op', () => {
      const mem = createMemory({ id: 'rule:1', source: 'rule', name: 'r1' });
      mutator.upsert(mem);
      expect(() => mutator.restore('rule:1')).not.toThrow();
      // 仍为活跃态
      expect(storage.getById('rule:1')).not.toBeNull();
    });

    it('purge 应物理删除记忆（不可恢复）', () => {
      const mem = createMemory({ id: 'rule:1', source: 'rule', name: 'r1' });
      mutator.upsert(mem);
      mutator.purge('rule:1');
      // 物理删除后 getById 和 getDeletedById 都返回 null
      expect(storage.getById('rule:1')).toBeNull();
      expect(storage.getDeletedById('rule:1')).toBeNull();
    });

    it('purge 对软删除记忆也应物理删除', () => {
      const mem = createMemory({ id: 'rule:1', source: 'rule', name: 'r1' });
      mutator.upsert(mem);
      mutator.delete('rule:1');
      // 软删除后 purge 彻底删除
      mutator.purge('rule:1');
      expect(storage.getDeletedById('rule:1')).toBeNull();
    });

    it('purge 对不存在的 id 应为 no-op', () => {
      expect(() => mutator.purge('nonexistent')).not.toThrow();
    });

    it('purgeExpired 应清理过期的软删除记忆', () => {
      const mem1 = createMemory({ id: 'rule:1', source: 'rule', name: 'r1' });
      const mem2 = createMemory({ id: 'rule:2', source: 'rule', name: 'r2' });
      mutator.upsert(mem1);
      mutator.upsert(mem2);
      mutator.delete('rule:1');
      mutator.delete('rule:2');

      // 阈值为当前时间：所有 deletedAt 早于此值的都被清理
      const before = new Date(Date.now() + 1000); // 稍晚于当前，确保覆盖已写入的 deletedAt
      const purgedCount = mutator.purgeExpired(before);
      expect(purgedCount).toBe(2);
      expect(storage.getDeletedById('rule:1')).toBeNull();
      expect(storage.getDeletedById('rule:2')).toBeNull();
    });

    it('purgeExpired 未过期的软删除记忆不应被清理', () => {
      const mem = createMemory({ id: 'rule:1', source: 'rule', name: 'r1' });
      mutator.upsert(mem);
      mutator.delete('rule:1');
      // 阈值为 1 小时前（deletedAt 晚于此值，未过期）
      const before = new Date(Date.now() - 60 * 60 * 1000);
      const purgedCount = mutator.purgeExpired(before);
      expect(purgedCount).toBe(0);
      expect(storage.getDeletedById('rule:1')).not.toBeNull();
    });
  });

  // ════════════════════════════════════════════════════════
  // 2. 关系写入（IMemoryRelationStore 代理）
  // ════════════════════════════════════════════════════════

  describe('关系写入', () => {
    it('addRelation 应透传 relationStore.addRelation', () => {
      const relation = {
        sourceId: 'insight:a',
        targetId: 'insight:b',
        type: 'supports',
        weight: 0.7,
        createdAt: '2026-06-27T10:00:00.000Z',
      };
      mutator.addRelation(relation);
      const all = relationStore.getAllRelations();
      expect(all).toHaveLength(1);
      expect(all[0]!.sourceId).toBe('insight:a');
      expect(all[0]!.type).toBe('supports');
    });

    it('removeRelation 应透传 relationStore.removeRelation', () => {
      const relation = {
        sourceId: 'insight:a',
        targetId: 'insight:b',
        type: 'supports',
        weight: 0.7,
        createdAt: '2026-06-27T10:00:00.000Z',
      };
      mutator.addRelation(relation);
      expect(relationStore.getAllRelations()).toHaveLength(1);
      mutator.removeRelation('insight:a', 'insight:b', 'supports');
      expect(relationStore.getAllRelations()).toHaveLength(0);
    });

    it('addRelation 在 relationStore 未注入时应静默 no-op', () => {
      const mutatorWithoutRelation = new MemoryMutator(storage, null);
      const relation = {
        sourceId: 'a',
        targetId: 'b',
        type: 'related',
        weight: 0.5,
        createdAt: '2026-06-27T10:00:00.000Z',
      };
      expect(() => mutatorWithoutRelation.addRelation(relation)).not.toThrow();
    });

    it('removeRelation 在 relationStore 未注入时应静默 no-op', () => {
      const mutatorWithoutRelation = new MemoryMutator(storage, null);
      expect(() => mutatorWithoutRelation.removeRelation('a', 'b', 'related')).not.toThrow();
    });
  });

  // ════════════════════════════════════════════════════════
  // 3. 与 MemoryInspector 协作验证（同一 storage + relationStore 实例）
  // ════════════════════════════════════════════════════════

  describe('与 MemoryInspector 协作', () => {
    it('mutator 写入的记忆可通过 storage 读取（读写隔离验证）', () => {
      const mem = createMemory({ id: 'rule:shared', source: 'rule', name: 'shared' });
      mutator.upsert(mem);
      // storage 是同一实例，inspector 也能读到
      expect(storage.getById('rule:shared')).toEqual(mem);
    });

    it('mutator 和 inspector 共享同一 relationStore 实例', () => {
      const relation = {
        sourceId: 'insight:a',
        targetId: 'insight:b',
        type: 'refines',
        weight: 0.7,
        createdAt: '2026-06-27T10:00:00.000Z',
      };
      // mutator 写入关系
      mutator.addRelation(relation);
      // relationStore 是同一实例，inspector 也能查到
      expect(relationStore.getAllRelations()).toHaveLength(1);
      expect(relationStore.getRelations('insight:a', 'outgoing')).toHaveLength(1);
    });
  });
});
