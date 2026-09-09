/**
 * hybridMerge 单元测试
 *
 * 双通道融合排序纯函数的契约测试
 * 阶段3（2026-09-09）排序纯化：权重参数与 memory.score 退役，融合序 = 单语义分 vectorScore 降序。
 * 验证：
 *   - 按 vectorScore 单语义分降序
 *   - limit 截断
 *   - 空输入 / 单条 / vectorScore=0 边界
 *
 * 共享消费者：recall.ts recall() + memoryInspector.ts searchHybrid()
 * 本测试保证两者底层的排序行为一致
 */
import { describe, it, expect } from 'vitest';
import { hybridMerge, RECALL_LIMIT_MULTIPLIER, type HybridMergeEntry } from '@/memory/hybridMerge.js';
import type { Memory } from '@/memory/types.js';

/** 构造测试记忆对象（score 字段 3E 物理删除前需占位以满足类型，排序已不再消费） */
function makeMemory(id: string): Memory {
  return {
    id,
    content: `内容-${id}`,
    source: 'content',
    name: `名称-${id}`,
    createdAt: new Date().toISOString(),
    accessedAt: new Date().toISOString(),
  };
}

/** 构造 HybridMergeEntry */
function makeEntry(id: string, vectorScore: number): HybridMergeEntry {
  return { memory: makeMemory(id), vectorScore };
}

describe('hybridMerge · 常量导出', () => {
  it('应导出 RECALL_LIMIT_MULTIPLIER = 2', () => {
    expect(RECALL_LIMIT_MULTIPLIER).toBe(2);
  });
});

describe('hybridMerge · 融合排序（单语义分 vectorScore 降序）', () => {
  it('空输入应返回空数组', () => {
    const result = hybridMerge([], 5);
    expect(result).toHaveLength(0);
  });

  it('单条输入应原样返回', () => {
    const entry = makeEntry('m1', 0.5);
    const result = hybridMerge([entry], 5);
    expect(result).toHaveLength(1);
    expect(result[0]!.memory.id).toBe('m1');
  });

  it('应按 vectorScore 单语义分降序排列', () => {
    const entries = [
      makeEntry('m1', 0.3),
      makeEntry('m2', 0.9),
      makeEntry('m3', 0.1),
    ];
    const result = hybridMerge(entries, 3);
    expect(result.map((e) => e.memory.id)).toEqual(['m2', 'm1', 'm3']);
  });

  it('应支持 limit 截断', () => {
    const entries = [makeEntry('m1', 0.9), makeEntry('m2', 0.5), makeEntry('m3', 0.1)];
    const result = hybridMerge(entries, 2);
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.memory.id)).toEqual(['m1', 'm2']);
  });

  it('vectorScore=0（仅关键词命中）应排在向量命中之后，同分保输入序', () => {
    // m1 关键词命中（vectorScore=0），m2 向量命中 0.5 → m2 在前
    const entries = [makeEntry('m1', 0), makeEntry('m2', 0.5)];
    const result = hybridMerge(entries, 2);
    expect(result[0]!.memory.id).toBe('m2');
    expect(result[1]!.memory.id).toBe('m1');
  });

  it('同 vectorScore 应用 stable-sort 保留插入序（keyword-only 回退承载）', () => {
    const entries = [makeEntry('a', 0), makeEntry('b', 0), makeEntry('c', 0)];
    const result = hybridMerge(entries, 3);
    expect(result.map((e) => e.memory.id)).toEqual(['a', 'b', 'c']);
  });

  it('应支持 Map.values() 迭代器作为输入', () => {
    const merged = new Map<string, HybridMergeEntry>();
    merged.set('m1', makeEntry('m1', 0.9));
    merged.set('m2', makeEntry('m2', 0.5));
    const result = hybridMerge(merged.values(), 5);
    expect(result).toHaveLength(2);
    expect(result[0]!.memory.id).toBe('m1');
  });

  it('limit=0 应返回空数组', () => {
    const entries = [makeEntry('m1', 0.9)];
    const result = hybridMerge(entries, 0);
    expect(result).toHaveLength(0);
  });

  it('limit 超过输入长度时应返回全部', () => {
    const entries = [makeEntry('m1', 0.9), makeEntry('m2', 0.5)];
    const result = hybridMerge(entries, 100);
    expect(result).toHaveLength(2);
  });
});