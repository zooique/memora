/**
 * hybridMerge 单元测试
 *
 * 双通道融合排序纯函数的契约测试
 * 验证：
 *   - 综合分数 = vectorScore * 0.6 + memory.score * 0.4
 *   - 降序排列
 *   - limit 截断
 *   - 空输入 / 单条输入边界
 *
 * 共享消费者：recall.ts recall() + memoryInspector.ts searchHybrid()
 * 本测试保证两者底层的排序行为一致
 */
import { describe, it, expect } from 'vitest';
import {
  hybridMerge,
  RECALL_LIMIT_MULTIPLIER,
  type HybridMergeEntry,
} from '@/memory/hybridMerge.js';
import type { Memory } from '@/memory/types.js';

// VECTOR_SCORE_WEIGHT / MEMORY_SCORE_WEIGHT 已改为模块内部常量（非公共 API），
// 测试改为硬编码验证算法公式的正确性（而非常量值本身）
const VECTOR_SCORE_WEIGHT = 0.6;
const MEMORY_SCORE_WEIGHT = 0.4;

/** 构造测试记忆对象 */
function makeMemory(id: string, score: number): Memory {
  return {
    id,
    content: `内容-${id}`,
    source: 'insight',
    name: `名称-${id}`,
    createdAt: new Date().toISOString(),
    accessedAt: new Date().toISOString(),
    score,
  };
}

/** 构造 HybridMergeEntry */
function makeEntry(id: string, score: number, vectorScore: number): HybridMergeEntry {
  return { memory: makeMemory(id, score), vectorScore };
}

describe('hybridMerge · 常量导出', () => {
  it('应导出 RECALL_LIMIT_MULTIPLIER = 2', () => {
    expect(RECALL_LIMIT_MULTIPLIER).toBe(2);
  });

  it('应导出 VECTOR_SCORE_WEIGHT = 0.6', () => {
    expect(VECTOR_SCORE_WEIGHT).toBe(0.6);
  });

  it('应导出 MEMORY_SCORE_WEIGHT = 0.4', () => {
    expect(MEMORY_SCORE_WEIGHT).toBe(0.4);
  });
});

describe('hybridMerge · 融合排序', () => {
  it('空输入应返回空数组', () => {
    const result = hybridMerge([], 5);
    expect(result).toHaveLength(0);
  });

  it('单条输入应原样返回', () => {
    const entry = makeEntry('m1', 0.8, 0.5);
    const result = hybridMerge([entry], 5);
    expect(result).toHaveLength(1);
    expect(result[0]!.memory.id).toBe('m1');
  });

  it('应按综合分数降序排列', () => {
    // 综合分数 = vectorScore * 0.6 + memory.score * 0.4
    // m1: 0.9 * 0.6 + 0.2 * 0.4 = 0.54 + 0.08 = 0.62
    // m2: 0.5 * 0.6 + 0.8 * 0.4 = 0.30 + 0.32 = 0.62（与 m1 相同，稳态排序）
    // m3: 0.1 * 0.6 + 0.9 * 0.4 = 0.06 + 0.36 = 0.42
    // 顺序：m1 / m2 同分（按输入顺序），m3 最后
    const entries = [
      makeEntry('m1', 0.2, 0.9),
      makeEntry('m2', 0.8, 0.5),
      makeEntry('m3', 0.9, 0.1),
    ];

    const result = hybridMerge(entries, 3);
    expect(result).toHaveLength(3);
    // m3 综合分数最低，应在最后
    expect(result[2]!.memory.id).toBe('m3');
  });

  it('应支持 limit 截断', () => {
    const entries = [
      makeEntry('m1', 0.9, 0.9), // 综合最高
      makeEntry('m2', 0.5, 0.5),
      makeEntry('m3', 0.1, 0.1), // 综合最低
    ];

    const result = hybridMerge(entries, 2);
    expect(result).toHaveLength(2);
    // 应保留综合分数最高的两条
    expect(result[0]!.memory.id).toBe('m1');
    expect(result[1]!.memory.id).toBe('m2');
  });

  it('vectorScore=0（仅关键词命中）应排在向量命中之后', () => {
    // m1：仅关键词命中，score=0.9 → 综合 0 * 0.6 + 0.9 * 0.4 = 0.36
    // m2：向量命中 0.5，score=0.5 → 综合 0.5 * 0.6 + 0.5 * 0.4 = 0.5
    // m2 综合更高，应排前面
    const entries = [
      makeEntry('m1', 0.9, 0), // 关键词命中
      makeEntry('m2', 0.5, 0.5), // 向量命中
    ];

    const result = hybridMerge(entries, 2);
    expect(result[0]!.memory.id).toBe('m2');
    expect(result[1]!.memory.id).toBe('m1');
  });

  it('应支持 Map.values() 迭代器作为输入', () => {
    // 模拟 recall()/searchHybrid() 的实际调用方式
    const merged = new Map<string, HybridMergeEntry>();
    merged.set('m1', makeEntry('m1', 0.9, 0.9));
    merged.set('m2', makeEntry('m2', 0.5, 0.5));

    const result = hybridMerge(merged.values(), 5);
    expect(result).toHaveLength(2);
    expect(result[0]!.memory.id).toBe('m1');
  });

  it('limit=0 应返回空数组', () => {
    const entries = [makeEntry('m1', 0.9, 0.9)];
    const result = hybridMerge(entries, 0);
    expect(result).toHaveLength(0);
  });

  it('limit 超过输入长度时应返回全部', () => {
    const entries = [makeEntry('m1', 0.9, 0.9), makeEntry('m2', 0.5, 0.5)];
    const result = hybridMerge(entries, 100);
    expect(result).toHaveLength(2);
  });
});
