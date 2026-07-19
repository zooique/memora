/**
 * 通用安全响应头常量（真理源）
 *
 * 消除 routes/types.ts 和 web/static.ts 中的 SECURITY_HEADERS 双副本重复：
 *   1. routes/types.ts 的 sendJson 中注入（覆盖所有 routes 层 JSON 响应）
 *   2. web/static.ts 的 serveStaticFile 中注入（静态文件响应）
 *   3. web/server.ts 的入口层 writeHead 中注入（CSP 收紧 default-src 'self'）
 *
 * 两个副本原为"避免 web 入口层反向依赖 routes 子层"而独立定义，
 * 现提取到 shared/ 层，所有模块统一引用，零反向依赖。
 *
 * 与 renderer/index.html 的 CSP meta 保持一致（详见 security_rules.md §7.1）。
 */

/**
 * 通用安全响应头
 *
 * 所有 HTTP 响应应携带这些头以降低 XSS/点击劫持/MIME 嗅探/Referer 泄露等常见 Web 风险：
 *   - X-Content-Type-Options: nosniff —— 禁止浏览器 MIME 嗅探
 *   - X-Frame-Options: DENY       —— 禁止页面被 iframe 嵌套
 *   - Referrer-Policy: no-referrer —— 不发送 Referer
 *   - Content-Security-Policy: default-src 'self' —— 默认只允许同源资源
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'",
};