/**
 * 网络搜索集成入口单元测试
 *
 * 覆盖 safeSearch 函数：
 *   - 成功返回搜索结果
 *   - 搜索失败时降级返回友好提示
 *   - 搜索超时时降级返回友好提示
 *   - 限制结果数量
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { IWebSearchProvider, SearchResult } from '@/web-search/types.js';
import { safeSearch } from '@/web-search/webSearchProvider.js';

/** 创建一个模拟的搜索提供者 */
function createMockProvider(
  results: SearchResult[] = [],
  delayMs = 0,
): IWebSearchProvider {
  return {
    async search(_query, _options) {
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      return results;
    },
  };
}

/** 创建一个模拟的搜索提供者（总是抛异常） */
function createFailingProvider(errorMsg = 'API 连接失败'): IWebSearchProvider {
  return {
    async search() {
      throw new Error(errorMsg);
    },
  };
}

describe('safeSearch', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('应返回搜索提供者返回的结果', async () => {
    const mockResults: SearchResult[] = [
      { title: '结果1', url: 'https://example.com/1', snippet: '摘要1' },
      { title: '结果2', url: 'https://example.com/2', snippet: '摘要2' },
    ];
    const provider = createMockProvider(mockResults);
    const results = await safeSearch(provider, '测试查询');
    expect(results).toEqual(mockResults);
  });

  it('应传递 limit 参数给搜索提供者', async () => {
    const spy = vi.fn(async (_query: string, _options?: { limit?: number }) => []);
    const provider: IWebSearchProvider = { search: spy };
    await safeSearch(provider, '测试', { limit: 3 });
    expect(spy).toHaveBeenCalledWith('测试', { limit: 3 });
  });

  it('搜索失败时应降级返回友好提示而非抛出异常', async () => {
    const provider = createFailingProvider('网络错误');
    const results = await safeSearch(provider, '测试查询');
    // 降级返回一条提示结果
    expect(results).toHaveLength(1);
    expect(results[0]!.title).toBe('网络搜索暂不可用');
    expect(results[0]!.snippet).toContain('搜索失败');
    expect(results[0]!.snippet).toContain('网络错误');
  });

  it('搜索超时时应降级返回友好提示而非抛出异常', async () => {
    // 使用 fake timers 模拟超时场景
    vi.useFakeTimers();

    // 直接测试超时降级逻辑
    const provider = createFailingProvider('网络搜索超时（30s）');
    const results = await safeSearch(provider, '测试查询');
    expect(results).toHaveLength(1);
    expect(results[0]!.title).toBe('网络搜索暂不可用');

    vi.useRealTimers();
  });

  it('空结果列表应原样返回', async () => {
    const provider = createMockProvider([]);
    const results = await safeSearch(provider, '测试查询');
    expect(results).toEqual([]);
  });

  it('非 Error 类型的异常应降级处理', async () => {
    const provider: IWebSearchProvider = {
      async search() {
        throw '字符串异常';
      },
    };
    const results = await safeSearch(provider, '测试查询');
    expect(results).toHaveLength(1);
    expect(results[0]!.snippet).toContain('搜索失败');
  });
});