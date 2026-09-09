/**
 * 重排序接口（IReranker）单元测试
 *
 * 覆盖：
 *   - IReranker 接口契约（可自定义实现注入）
 */
import { describe, it, expect } from 'vitest';
import type { IReranker } from '@/memory/reranker.js';
import type { Memory } from '@/memory/types.js';

/** 构造测试记忆对象 */
function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'test:1',
    content: '测试内容',
    source: 'content',
    name: 'test-memory',
    createdAt: '2026-01-01T00:00:00.000Z',
    accessedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ─── IReranker 接口契约 ─────────────────────────────

describe('IReranker · 接口契约（可自定义实现）', () => {
  // 自定义最小实现，验证接口可由宿主/调用方注入自定义重排序策略
  const customReranker: IReranker = {
    async rerank(_query, results) {
      // 示例实现：按 accessedAt 降序返回（score 已物理退役，改用访问时间）
      return [...results].sort((a, b) => b.accessedAt.localeCompare(a.accessedAt));
    },
  };

  it('应接受自定义实现并按 accessedAt 降序返回', async () => {
    const m1 = makeMemory({ id: 'm1', accessedAt: '2026-01-02T00:00:00.000Z' });
    const m2 = makeMemory({ id: 'm2', accessedAt: '2026-01-01T00:00:00.000Z' });
    const result = await customReranker.rerank('query', [m2, m1]);
    expect(result[0]!.id).toBe('m1');
    expect(result[1]!.id).toBe('m2');
  });

  it('空数组应返回空数组', async () => {
    const result = await customReranker.rerank('query', []);
    expect(result).toHaveLength(0);
  });

  it('options 应透传给自定义实现', async () => {
    let receivedLimit: number | undefined;
    const spyReranker: IReranker = {
      async rerank(_query, results, options) {
        receivedLimit = options?.limit;
        return results;
      },
    };
    await spyReranker.rerank('query', [], { limit: 3 });
    expect(receivedLimit).toBe(3);
  });
});
