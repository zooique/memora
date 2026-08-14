/**
 * 时间格式化 — 纯函数 + webview 注入脚本（单一真源）
 *
 * 阶段 A（对抗评估 P2-1）：逻辑以可测试的 TS 纯函数为单一真理源，注入脚本由
 * 函数源码序列化生成（toString）。webview 仍以内联字符串注入（CSP:
 * script-src 'unsafe-inline'），面板 buildHtml 拼进 <script> 后通过 fmtTime(ts)
 * 调用；纯函数可被 vitest 直接测试（此前是字符串，0 覆盖）。
 * 序列化依赖 esbuild minify:false + keepNames:true，保证 toString 返回可读函数源码。
 */

/**
 * 格式化 ISO 时间戳为 HH:MM（本地时区）；空/无效输入返回空串
 *
 * @param ts ISO 时间戳（如 "2026-06-21T12:34:56.789Z"）
 * @returns HH:MM（本地时区）或空串
 */
export function fmtTime(ts?: string): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** webview 注入脚本：由纯函数源码序列化，与 fmtTime 保持单一真源（P2-1 阶段 A） */
export const fmtTimeScript = `
${fmtTime}`;