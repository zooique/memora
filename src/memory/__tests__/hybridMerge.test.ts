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
  DEFAULT_VECTOR_SCORE_WEIGHT,
  DEFAULT_MEMORY_SCORE_WEIGHT,
  type HybridMergeEntry,
} from '@/memory/hybridMerge.js';
import type { Memory } from '@/memory/types.js';

// 算法公式使用 DEFAULT_VECTOR_SCORE_WEIGHT / DEFAULT_MEMORY_SCORE_WEIGHT 公共常量
// 测试中硬编码值（0.6 / 0.4）验证算法正确性

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

  it('应导出 DEFAULT_VECTOR_SCORE_WEIGHT = 0.6', () => {
    expect(DEFAULT_VECTOR_SCORE_WEIGHT).toBe(0.6);
  });

  it('应导出 DEFAULT_MEMORY_SCORE_WEIGHT = 0.4', () => {
    expect(DEFAULT_MEMORY_SCORE_WEIGHT).toBe(0.4);
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

describe('hybridMerge · 自定义权重', () => {
  it('不传 weights 时使用默认权重（0.6 / 0.4）', () => {
    // m1: 0.9*0.6 + 0.2*0.4 = 0.62
    // m2: 0.5*0.6 + 0.8*0.4 = 0.62
    const entries = [makeEntry('m1', 0.2, 0.9), makeEntry('m2', 0.8, 0.5)];
    const result = hybridMerge(entries, 2);
    // 默认权重下 m1 和 m2 同分，保留输入顺序
    expect(result).toHaveLength(2);
    expect(result[0]!.memory.id).toBe('m1');
  });

  it('提高 memoryScoreWeight 后记忆 score 更高的应排前面', () => {
    // m1: vectorScore=0.9, score=0.2 → 默认权重 0.62
    // m2: vectorScore=0.5, score=0.8 → 默认权重 0.62
    // 使用 weights={ vectorScoreWeight: 0.3, memoryScoreWeight: 0.7 }
    // m1: 0.9*0.3 + 0.2*0.7 = 0.27 + 0.14 = 0.41
    // m2: 0.5*0.3 + 0.8*0.7 = 0.15 + 0.56 = 0.71
    // m2 应排前面
    const entries = [makeEntry('m1', 0.2, 0.9), makeEntry('m2', 0.8, 0.5)];
    const result = hybridMerge(entries, 2, { vectorScoreWeight: 0.3, memoryScoreWeight: 0.7 });
    expect(result[0]!.memory.id).toBe('m2');
    expect(result[1]!.memory.id).toBe('m1');
  });

  it('提高 vectorScoreWeight 后语义相似度更高的应排前面', () => {
    // m1: vectorScore=0.9, score=0.2
    // m2: vectorScore=0.5, score=0.8
    // 使用 weights={ vectorScoreWeight: 0.9, memoryScoreWeight: 0.1 }
    // m1: 0.9*0.9 + 0.2*0.1 = 0.81 + 0.02 = 0.83
    // m2: 0.5*0.9 + 0.8*0.1 = 0.45 + 0.08 = 0.53
    // m1 应排前面
    const entries = [makeEntry('m1', 0.2, 0.9), makeEntry('m2', 0.8, 0.5)];
    const result = hybridMerge(entries, 2, { vectorScoreWeight: 0.9, memoryScoreWeight: 0.1 });
    expect(result[0]!.memory.id).toBe('m1');
    expect(result[1]!.memory.id).toBe('m2');
  });

  it('vectorScoreWeight=0 时仅按 memory.score 排序', () => {
    // m1: vectorScore=0.9, score=0.2 → 综合 0*0.9 + 0.2*1.0 = 0.20
    // m2: vectorScore=0.5, score=0.8 → 综合 0*0.5 + 0.8*1.0 = 0.80
    const entries = [makeEntry('m1', 0.2, 0.9), makeEntry('m2', 0.8, 0.5)];
    const result = hybridMerge(entries, 2, { vectorScoreWeight: 0, memoryScoreWeight: 1.0 });
    expect(result[0]!.memory.id).toBe('m2');
    expect(result[1]!.memory.id).toBe('m1');
  });

  it('memoryScoreWeight=0 时仅按 vectorScore 排序', () => {
    // m1: vectorScore=0.9, score=0.2 → 综合 0.9*1.0 + 0.2*0 = 0.90
    // m2: vectorScore=0.5, score=0.8 → 综合 0.5*1.0 + 0.8*0 = 0.50
    const entries = [makeEntry('m1', 0.2, 0.9), makeEntry('m2', 0.8, 0.5)];
    const result = hybridMerge(entries, 2, { vectorScoreWeight: 1.0, memoryScoreWeight: 0 });
    expect(result[0]!.memory.id).toBe('m1');
    expect(result[1]!.memory.id).toBe('m2');
  });
});
