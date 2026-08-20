/**
 * 网页抓取集成入口：提供带超时保护的加载包装，组合默认实现或宿主自定义实现。
 * 抓取失败时降级返回友好错误信息，不中断对话流程（30s 超时防卡死 Agent 主循环）。
 */
import type { FetchedPage, FetchOptions, IFetchProvider } from '@/web-fetch/types.js';

/** 网页抓取超时时间（毫秒） */
const FETCH_TIMEOUT_MS = 30_000;

/**
 * 带超时和错误处理的抓取包装：超时或失败时不抛异常，返回降级提示页。
 */
export async function safeFetch(
  provider: IFetchProvider,
  url: string,
  options?: FetchOptions,
): Promise<FetchedPage> {
  const timeoutPromise = new Promise<FetchedPage>((_, reject) => {
    const id = setTimeout(() => {
      clearTimeout(id);
      reject(new Error('网页抓取超时（30s）'));
    }, FETCH_TIMEOUT_MS);
  });

  try {
    const page = await Promise.race([provider.fetch(url, options), timeoutPromise]);
    return page;
  } catch (err) {
    // 抓取失败不抛异常，返回降级提示页
    const message = err instanceof Error ? err.message : String(err);
    return {
      url,
      title: '网页抓取暂不可用',
      content: `抓取失败：${message}。请稍后重试，或检查网络连接。`,
    };
  }
}
