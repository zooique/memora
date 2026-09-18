/**
 * 基于 fetch 的默认网页抓取实现（FetchWebFetchProvider）
 * 使用 Node.js 18+ 内置 fetch，零依赖。仅用于"开箱即用"场景，
 * 生产环境建议宿主实现 IFetchProvider 用专用抓取服务（渲染 / 代理 / 限流）。
 */
import type { FetchedPage, FetchOptions, IFetchProvider } from '@/web-fetch/types.js';
import { BROWSER_UA, fetchWithTimeout } from '@/utils/http.js';

/** 单次请求超时（ms）：抓取通常 1-3s 返回，10s 覆盖慢网络且不至于拖死主循环 */
const REQUEST_TIMEOUT_MS = 10_000;

/** 默认正文截断上限（字符） */
const DEFAULT_MAX_CHARS = 8_000;

/** 原始 HTML 可接受上限（字符）：防超大页面占满内存，超限直接截断再清洗 */
const MAX_RAW_CHARS = 50_000;

/**
 * HTML → 正文纯文本：去 script/style/head + 去标签 + 解实体 + 去控制字符 + 压缩空白 + 截断。
 * 用正则而非 DOM 解析，避免引入 jsdom 依赖（对齐 fetchWebSearchProvider 的零依赖思路）。
 *
 * @param html 原始 HTML
 * @param maxChars 正文截断上限
 * @returns 清洗后的纯文本
 */
function stripHtmlToText(html: string, maxChars: number): string {
  const text = html
    // 先剔除脚本/样式/头部（正文无关且含特殊字符）
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    // 再剔除剩余标签
    .replace(/<[^>]+>/g, ' ')
    // 解码常见 HTML 实体
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    // 去控制字符（防转义/终端注入，对齐 toolExecutor.sanitizeExternalText 语义）
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    // 压缩空白：行内空格折叠 + 多空行归一
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/**
 * 从 <title> 提取页面标题（清洗后截断）
 */
function extractTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match ? stripHtmlToText(match[1]!, 200) : '';
}

/** 默认网页抓取实现：Node 内置 fetch + 正文清洗 + 截断 */
export class FetchWebFetchProvider implements IFetchProvider {
  /**
   * 抓取 URL：带超时控制（共享 fetchWithTimeout），返回清洗后的正文纯文本。
   */
  async fetch(url: string, options?: FetchOptions): Promise<FetchedPage> {
    const maxChars = options?.maxChars ?? DEFAULT_MAX_CHARS;
    const response = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS, BROWSER_UA);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const contentType = response.headers.get('content-type') ?? '';
    const raw = await response.text();
    // 超限原始响应直接截断再清洗，防超大页面拖慢/占满内存
    const content = stripHtmlToText(raw.slice(0, MAX_RAW_CHARS), maxChars);
    return {
      url: response.url || url,
      title: extractTitle(raw),
      content,
      contentType,
    };
  }
}
