/**
 * 网络搜索集成入口
 *
 * 提供带超时保护的错误处理包装，组合默认实现或宿主自定义实现。
 * 搜索失败时降级返回友好错误信息，不中断对话流程。
 *
 * 设计原则：
 * - 30s 超时保护：防止搜索请求卡死 Agent 主循环
 * - 降级优先：搜索失败返回友好提示，不抛出异常
 */

import type { IWebSearchProvider, SearchResult, WebSearchOptions } from '@/web-search/types.js';

/** 网络搜索超时时间（毫秒） */
const SEARCH_TIMEOUT_MS = 30_000;

/**
 * 带超时和错误处理的搜索包装
 *
 * 包装 IWebSearchProvider.search 调用，添加超时保护和错误降级。
 * 搜索失败时不抛出异常，返回降级提示信息。
 *
 * @param provider - 网络搜索提供者
 * @param query - 搜索关键词
 * @param options - 搜索选项
 * @returns 搜索结果，失败时返回降级提示
 */
export async function safeSearch(
  provider: IWebSearchProvider,
  query: string,
  options?: WebSearchOptions,
): Promise<SearchResult[]> {
  const timeoutPromise = new Promise<SearchResult[]>((_, reject) => {
    const id = setTimeout(() => {
      clearTimeout(id);
      reject(new Error('网络搜索超时（30s）'));
    }, SEARCH_TIMEOUT_MS);
  });

  try {
    const results = await Promise.race([
      provider.search(query, options),
      timeoutPromise,
    ]);
    return results;
  } catch (err) {
    // 搜索失败不抛异常，返回降级提示
    const message = err instanceof Error ? err.message : String(err);
    return [
      {
        title: '网络搜索暂不可用',
        url: '',
        snippet: `搜索失败：${message}。请稍后重试，或检查网络连接。`,
      },
    ];
  }
}