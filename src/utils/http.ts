/**
 * HTTP 网络工具：浏览器 User-Agent 常量 + 带超时控制的 fetch。
 * web-search / web-fetch 默认实现共享，避免同语义逻辑双处维护（SSOT 下沉）。
 */
/** 通用浏览器 User-Agent（避免被目标站当作爬虫拒绝） */
export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * 带超时控制的 fetch：手动 AbortController + setTimeout（兼容性优于 AbortSignal.timeout），
 * 防不可达端点挂起调用方；成功/失败均清理定时器。
 *
 * @param url 目标 URL
 * @param timeoutMs 超时毫秒
 * @param userAgent 可选 UA 头（缺省不发送）
 * @returns fetch Response（调用方负责检查 ok 与 body 读取）
 */
export async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  userAgent?: string,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      headers: userAgent ? { 'User-Agent': userAgent } : undefined,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}
