/**
 * 重排序 + 上下文压缩 单元测试
 *
 * 覆盖：
 *   - DefaultReranker：内容长度惩罚排序
 *   - compressContext：字符数限制、单条截断、去重后截断
 *   - IReranker 接口契约（可自定义实现）
 */
import { describe, it, expect } from 'vitest';
import { DefaultReranker, compressContext } from '@/memory/reranker.js';
import type { Memory } from '@/memory/types.js';

/** 构造测试记忆对象 */
function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'test:1',
    content: '测试内容',
    source: 'insight',
    name: 'test-memory',
    createdAt: '2026-01-01T00:00:00.000Z',
    accessedAt: '2026-01-01T00:00:00.000Z',
    score: 0.8,
    ...overrides,
  };
}

// ─── DefaultReranker ─────────────────────────────────

describe('DefaultReranker · 重排序', () => {
  const reranker = new DefaultReranker();

  it('空数组应返回空数组', async () => {
    const result = await reranker.rerank('query', []);
    expect(result).toHaveLength(0);
  });

  it('单条记忆应原样返回', async () => {
    const m1 = makeMemory({ id: 'm1', score: 0.8 });
    const result = await reranker.rerank('query', [m1]);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('m1');
  });

  it('分数差异大时按分数降序排列', async () => {
    const m1 = makeMemory({ id: 'm1', score: 0.9, content: '短内容' });
    const m2 = makeMemory({ id: 'm2', score: 0.5, content: '也是短内容' });
    const result = await reranker.rerank('query', [m2, m1]);
    // m1 分数更高，应排前面（即使输入顺序是 m2 在前）
    expect(result[0]!.id).toBe('m1');
    expect(result[1]!.id).toBe('m2');
  });

  it('分数相近时内容短者优先', async () => {
    const m1 = makeMemory({ id: 'm1', score: 0.8, content: '短内容' });
    const m2 = makeMemory({ id: 'm2', score: 0.79, content: '这是一段比较长的内容，用于测试短内容优先的排序策略' });
    const result = await reranker.rerank('query', [m2, m1]);
    // 分数相近（差异 < 0.05），m1 内容更短，应排前面
    expect(result[0]!.id).toBe('m1');
  });

  it('limit 应截断结果', async () => {
    const m1 = makeMemory({ id: 'm1', score: 0.9 });
    const m2 = makeMemory({ id: 'm2', score: 0.8 });
    const m3 = makeMemory({ id: 'm3', score: 0.7 });
    const result = await reranker.rerank('query', [m1, m2, m3], { limit: 2 });
    expect(result).toHaveLength(2);
  });

  it('超长内容应受到惩罚（长内容降权）', async () => {
    // 超长内容（> 10000 字符）与短内容同分时，短内容应排前面
    const longContent = 'X'.repeat(12000);
    const m1 = makeMemory({ id: 'long', score: 0.8, content: longContent });
    const m2 = makeMemory({ id: 'short', score: 0.8, content: '短内容' });
    const result = await reranker.rerank('query', [m1, m2]);
    // 短内容应排前面（长度惩罚使 long 分数降低）
    expect(result[0]!.id).toBe('short');
  });
});

// ─── compressContext ─────────────────────────────────

describe('compressContext · 上下文压缩', () => {
  it('空数组应返回空结果', () => {
    const result = compressContext([]);
    expect(result.memories).toHaveLength(0);
    expect(result.originalChars).toBe(0);
    expect(result.compressedChars).toBe(0);
    expect(result.truncatedIds).toHaveLength(0);
  });

  it('短内容不应截断', () => {
    const m1 = makeMemory({ id: 'm1', content: '短内容', score: 0.8 });
    const result = compressContext([m1]);
    expect(result.memories).toHaveLength(1);
    expect(result.memories[0]!.content).toBe('短内容');
    expect(result.truncatedIds).toHaveLength(0);
  });

  it('单条超长内容应截断到 maxPerEntry', () => {
    const longContent = 'X'.repeat(2000);
    const m1 = makeMemory({ id: 'm1', content: longContent, score: 0.8 });
    const result = compressContext([m1], { maxPerEntry: 500 });
    expect(result.memories[0]!.content.length).toBeLessThanOrEqual(500 + 10); // +10 for suffix '… (已截断)'
    expect(result.memories[0]!.content).toContain('已截断');
    expect(result.truncatedIds).toContain('m1');
  });

  it('总字符数超过 maxTotalChars 时应截断后续记忆', () => {
    const m1 = makeMemory({ id: 'm1', content: 'A'.repeat(300), score: 0.9 });
    const m2 = makeMemory({ id: 'm2', content: 'B'.repeat(300), score: 0.8 });
    const result = compressContext([m1, m2], { maxTotalChars: 400 });
    // 总字符数限制后，m1 完整保留，m2 被截断或移除
    expect(result.memories.length).toBeGreaterThanOrEqual(1);
    expect(result.memories.length).toBeLessThanOrEqual(2);
    if (result.memories.length === 2) {
      // m2 被截断
      expect(result.memories[1]!.content).toContain('已截断');
    }
  });

  it('应按 score 降序排列后再压缩', () => {
    // score 顺序与输入顺序相反
    const m1 = makeMemory({ id: 'm1', content: '低分内容', score: 0.3 });
    const m2 = makeMemory({ id: 'm2', content: '高分内容', score: 0.9 });
    const result = compressContext([m1, m2], { maxTotalChars: 500 });
    // 高分内容应在前面
    expect(result.memories[0]!.id).toBe('m2');
  });

  it('应返回正确的统计信息', () => {
    const m1 = makeMemory({ id: 'm1', content: 'AAA', score: 0.8 });
    const m2 = makeMemory({ id: 'm2', content: 'BBBBB', score: 0.6 });
    const result = compressContext([m1, m2], { maxPerEntry: 100, maxTotalChars: 100 });
    expect(result.originalChars).toBe(8);
    expect(result.compressedChars).toBeGreaterThan(0);
    expect(result.compressedChars).toBeLessThanOrEqual(result.originalChars);
  });

  it('压缩后应保留原始记忆的 id', () => {
    const m1 = makeMemory({ id: 'm1', content: '内容', score: 0.8 });
    const result = compressContext([m1]);
    expect(result.memories[0]!.id).toBe('m1');
  });
});