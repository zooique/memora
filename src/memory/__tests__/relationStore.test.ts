/**
 * InMemoryRelationStore 单元测试
 *
 * 覆盖 ADR-014 侧车模型的核心契约：
 * - addRelation 幂等性（三元组唯一约束）
 * - getRelations 方向过滤（outgoing/incoming/both）
 * - getRelationsByType 按类型查询
 * - getAllRelations 全量获取
 * - removeRelation 精确删除
 * - 返回值隔离（外部修改不影响内部状态）
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryRelationStore } from '@/memory/inMemoryRelationStore.js';
import { RELATION_TYPES, RELATION_WEIGHTS } from '@/memory/types.js';
import type { MemoryRelation } from '@/memory/types.js';

/** 构造测试用关系数据 */
function makeRelation(
  sourceId: string,
  targetId: string,
  type: string,
  weight: number = RELATION_WEIGHTS.STRONG,
): MemoryRelation {
  return {
    sourceId,
    targetId,
    type,
    weight,
    createdAt: '2026-06-25T10:00:00.000Z',
  };
}

describe('InMemoryRelationStore', () => {
  let store: InMemoryRelationStore;

  beforeEach(() => {
    store = new InMemoryRelationStore();
  });

  // ─── addRelation 幂等性 ───────────────────────────────────

  describe('addRelation', () => {
    it('应成功添加新关系', () => {
      const relation = makeRelation('m1', 'm2', RELATION_TYPES.CONTRADICTS);
      store.addRelation(relation);

      const all = store.getAllRelations();
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject(relation);
    });

    it('相同三元组重复添加应幂等更新（不新增）', () => {
      const r1 = makeRelation('m1', 'm2', RELATION_TYPES.CONTRADICTS, RELATION_WEIGHTS.WEAK);
      const r2 = makeRelation('m1', 'm2', RELATION_TYPES.CONTRADICTS, RELATION_WEIGHTS.CERTAIN);

      store.addRelation(r1);
      store.addRelation(r2);

      const all = store.getAllRelations();
      expect(all).toHaveLength(1);
      // 后添加的覆盖 weight
      expect(all[0]?.weight).toBe(RELATION_WEIGHTS.CERTAIN);
    });

    it('不同 type 的相同端点应作为独立关系存储', () => {
      store.addRelation(makeRelation('m1', 'm2', RELATION_TYPES.CONTRADICTS));
      store.addRelation(makeRelation('m1', 'm2', RELATION_TYPES.SUPPORTS));

      expect(store.getAllRelations()).toHaveLength(2);
    });

    it('反向端点应作为独立关系存储（有向存储）', () => {
      store.addRelation(makeRelation('m1', 'm2', RELATION_TYPES.FOLLOWS));
      store.addRelation(makeRelation('m2', 'm1', RELATION_TYPES.FOLLOWS));

      expect(store.getAllRelations()).toHaveLength(2);
    });
  });

  // ─── getRelations 方向过滤 ────────────────────────────────

  describe('getRelations', () => {
    beforeEach(() => {
      // 构造测试图谱：
      //   m1 --contradicts--> m2
      //   m3 --supports--> m1
      //   m1 --follows--> m4
      store.addRelation(makeRelation('m1', 'm2', RELATION_TYPES.CONTRADICTS));
      store.addRelation(makeRelation('m3', 'm1', RELATION_TYPES.SUPPORTS));
      store.addRelation(makeRelation('m1', 'm4', RELATION_TYPES.FOLLOWS));
    });

    it('direction=outgoing 只查 sourceId 匹配的关系', () => {
      const outgoing = store.getRelations('m1', 'outgoing');
      expect(outgoing).toHaveLength(2);
      expect(outgoing.every((r) => r.sourceId === 'm1')).toBe(true);
    });

    it('direction=incoming 只查 targetId 匹配的关系', () => {
      const incoming = store.getRelations('m1', 'incoming');
      expect(incoming).toHaveLength(1);
      expect(incoming[0]?.sourceId).toBe('m3');
      expect(incoming[0]?.targetId).toBe('m1');
    });

    it('direction=both 合并两个方向并去重（默认）', () => {
      const both = store.getRelations('m1');
      expect(both).toHaveLength(3);
      // m1 作为 source 的 2 条 + m1 作为 target 的 1 条
      const sources = both.map((r) => r.sourceId).sort();
      expect(sources).toEqual(['m1', 'm1', 'm3']);
    });

    it('无关系时返回空数组', () => {
      expect(store.getRelations('nonexistent')).toHaveLength(0);
    });
  });

  // ─── getRelationsByType ──────────────────────────────────

  describe('getRelationsByType', () => {
    it('应按类型精确过滤', () => {
      store.addRelation(makeRelation('m1', 'm2', RELATION_TYPES.CONTRADICTS));
      store.addRelation(makeRelation('m3', 'm4', RELATION_TYPES.CONTRADICTS));
      store.addRelation(makeRelation('m5', 'm6', RELATION_TYPES.SUPPORTS));

      const contradictions = store.getRelationsByType(RELATION_TYPES.CONTRADICTS);
      expect(contradictions).toHaveLength(2);
      expect(contradictions.every((r) => r.type === RELATION_TYPES.CONTRADICTS)).toBe(true);
    });

    it('未知类型返回空数组', () => {
      store.addRelation(makeRelation('m1', 'm2', RELATION_TYPES.CONTRADICTS));
      expect(store.getRelationsByType('nonexistent-type')).toHaveLength(0);
    });

    it('支持自定义关系类型（开放字符串）', () => {
      const customType = 'derived-from';
      store.addRelation(makeRelation('m1', 'm2', customType));

      const results = store.getRelationsByType(customType);
      expect(results).toHaveLength(1);
      expect(results[0]?.type).toBe(customType);
    });
  });

  // ─── getAllRelations ─────────────────────────────────────

  describe('getAllRelations', () => {
    it('应返回全部关系', () => {
      store.addRelation(makeRelation('m1', 'm2', RELATION_TYPES.CONTRADICTS));
      store.addRelation(makeRelation('m3', 'm4', RELATION_TYPES.SUPPORTS));
      store.addRelation(makeRelation('m5', 'm6', RELATION_TYPES.FOLLOWS));

      expect(store.getAllRelations()).toHaveLength(3);
    });

    it('空存储返回空数组', () => {
      expect(store.getAllRelations()).toHaveLength(0);
    });
  });

  // ─── removeRelation ──────────────────────────────────────

  describe('removeRelation', () => {
    it('应精确删除指定三元组的关系', () => {
      store.addRelation(makeRelation('m1', 'm2', RELATION_TYPES.CONTRADICTS));
      store.addRelation(makeRelation('m1', 'm2', RELATION_TYPES.SUPPORTS));

      store.removeRelation('m1', 'm2', RELATION_TYPES.CONTRADICTS);

      const remaining = store.getAllRelations();
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.type).toBe(RELATION_TYPES.SUPPORTS);
    });

    it('删除不存在的三元组应静默无操作', () => {
      store.addRelation(makeRelation('m1', 'm2', RELATION_TYPES.CONTRADICTS));

      // 不匹配的 type
      store.removeRelation('m1', 'm2', RELATION_TYPES.SUPPORTS);
      expect(store.getAllRelations()).toHaveLength(1);

      // 不匹配的 sourceId
      store.removeRelation('nonexistent', 'm2', RELATION_TYPES.CONTRADICTS);
      expect(store.getAllRelations()).toHaveLength(1);
    });
  });

  // ─── 返回值隔离（防御性拷贝） ─────────────────────────────

  describe('返回值隔离', () => {
    it('getRelations 返回值修改不影响内部状态', () => {
      store.addRelation(makeRelation('m1', 'm2', RELATION_TYPES.CONTRADICTS));

      const results = store.getRelations('m1');
      results[0]!.weight = 0.999; // 外部修改

      const all = store.getAllRelations();
      expect(all[0]?.weight).not.toBe(0.999);
      expect(all[0]?.weight).toBe(RELATION_WEIGHTS.STRONG);
    });

    it('getAllRelations 返回值修改不影响内部状态', () => {
      store.addRelation(makeRelation('m1', 'm2', RELATION_TYPES.CONTRADICTS));

      const all = store.getAllRelations();
      all[0]!.type = 'tampered';

      const again = store.getAllRelations();
      expect(again[0]?.type).toBe(RELATION_TYPES.CONTRADICTS);
    });
  });
});
