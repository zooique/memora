/**
 * 时间格式化 — 纯函数（webview 运行时脚本直接 import 使用）
 *
 * fmtTime 作为纯函数被 chatView import，可直接 vitest 测试。
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
