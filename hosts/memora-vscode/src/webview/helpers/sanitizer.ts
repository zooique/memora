/**
 * sanitizer — HTML 消毒器工厂（单一真理源：DOMPurify 构造 + SanitizeFn 契约）
 *
 * 设计（环境边界清楚、单一真理源）：
 *   - dompurify 依赖浏览器 window 对象，构造逻辑只此一处下沉；
 *   - 本模块仅被 webview 脚本（chatView）import——浏览器环境才有 window，
 *     Node 端 import 链（renderMarkdown 用 import type 引用）永不加载本模块；
 *   - SanitizeFn 是消毒回调契约的单一真源，renderMarkdown 与调用方共用它。
 */
import DOMPurify from 'dompurify';

/** 消毒回调契约：接收原始 HTML，返回已过滤 XSS 的安全 HTML（renderMarkdown 注入位） */
export type SanitizeFn = (html: string) => string;

/**
 * 创建基于指定 window 的消毒器（每次会话初始化时调用一次）
 *
 * @param win 宿主 window——在 webview 浏览器环境传入全局 window（createChatView deps）。
 *   不裸用全局 window：若模块被 Node 环境加载，裸引用会抛 ReferenceError。
 * @returns 绑定实例的 sanitize 包装（缓存实例避免重复构造）
 */
export function createSanitizer(win: Window): SanitizeFn {
  // DOMPurify 工厂的 WindowLike 参数与 lib.dom Window 存在类型缺口，运行时等价，显式断言
  const purify = DOMPurify(win as unknown as Parameters<typeof DOMPurify>[0]);
  return (html: string): string => purify.sanitize(html);
}
