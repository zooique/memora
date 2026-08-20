/**
 * 网页抓取集成入口单元测试
 *
 * 覆盖 safeFetch 函数：
 *   - 成功返回抓取页面
 *   - 抓取失败时降级返回友好提示（不抛异常）
 *   - 抓取超时时降级返回友好提示（不抛异常）
 *   - 非 Error 类型异常降级处理
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { FetchedPage, IFetchProvider } from '@/web-fetch/types.js';
import { safeFetch } from '@/web-fetch/webFetchProvider.js';

/** 创建一个模拟的抓取提供者（总是成功） */
function createMockProvider(page: FetchedPage = { url: 'https://example.com', title: '示例', content: '正文' }): IFetchProvider {
  return {
    async fetch(_url, _options) {
      return page;
    },
  };
}

/** 创建一个模拟的抓取提供者（总是抛异常） */
function createFailingProvider(errorMsg = '网络错误'): IFetchProvider {
  return {
    async fetch() {
      throw new Error(errorMsg);
    },
  };
}

describe('safeFetch', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('应返回抓取提供者返回的页面', async () => {
    const page: FetchedPage = { url: 'https://example.com/a', title: '标题A', content: '正文A' };
    const provider = createMockProvider(page);
    const result = await safeFetch(provider, 'https://example.com/a');
    expect(result).toEqual(page);
  });

  it('应传递 options（maxChars）给抓取提供者', async () => {
    const spy = vi.fn(async (_url: string, _options?: { maxChars?: number }) => ({
      url: 'https://example.com',
      title: '',
      content: '',
    }));
    const provider: IFetchProvider = { fetch: spy };
    await safeFetch(provider, 'https://example.com', { maxChars: 4000 });
    expect(spy).toHaveBeenCalledWith('https://example.com', { maxChars: 4000 });
  });

  it('抓取失败时应降级返回友好提示页而非抛出异常', async () => {
    const provider = createFailingProvider('DNS 解析失败');
    const result = await safeFetch(provider, 'https://example.com');
    expect(result.url).toBe('https://example.com');
    expect(result.title).toBe('网页抓取暂不可用');
    expect(result.content).toContain('抓取失败');
    expect(result.content).toContain('DNS 解析失败');
  });

  it('抓取超时时应降级返回友好提示页而非抛出异常', async () => {
    const provider = createFailingProvider('网页抓取超时（30s）');
    const result = await safeFetch(provider, 'https://example.com');
    expect(result.title).toBe('网页抓取暂不可用');
  });

  it('非 Error 类型的异常应降级处理', async () => {
    const provider: IFetchProvider = {
      async fetch() {
        throw '字符串异常';
      },
    };
    const result = await safeFetch(provider, 'https://example.com');
    expect(result.title).toBe('网页抓取暂不可用');
    expect(result.content).toContain('抓取失败');
  });
});
