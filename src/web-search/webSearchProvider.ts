/**
 * 网络搜索集成入口：提供带超时保护的加载包装，组合默认实现或宿主自定义实现。
 * 搜索失败时降级返回友好错误信息，不中断对话流程（30s 超时防卡死 Agent 主循环）。
 */
import type { IWebSearchProvider, SearchResult, WebSearchOptions } from '@/web-search/types.js';

/** 网络搜索超时时间（毫秒） */
const SEARCH_TIMEOUT_MS = 30_000;

/**
 * 带超时和错误处理的搜索包装：超时或失败时不抛异常，返回降级提示信息。
 */
export async function safeSearch(
  provider: IWebSearchProvider,
  query: string,
  options?: WebSearchOptions,
): Promise<SearchResult[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<SearchResult[]>((_, reject) => {
    timer = setTimeout(() => reject(new Error('网络搜索超时（30s）')), SEARCH_TIMEOUT_MS);
  });

  try {
    return await Promise.race([provider.search(query, options), timeoutPromise]);
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
  } finally {
    // 成功/失败均清理超时定时器，防残留定时器拖住进程
    clearTimeout(timer);
  }
}