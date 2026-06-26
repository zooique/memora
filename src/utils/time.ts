/**
 * 时间工具函数
 *
 * 从 messageHistory.ts 提取的公共时间格式化函数，
 * 消除跨模块 `new Date().toISOString()` 内联重复。
 */

/**
 * 获取当前时间的 ISO 8601 时间戳
 *
 * @returns 如 "2026-06-21T12:34:56.789Z"
 */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * 获取当前日期字符串（YYYY-MM-DD，本地时区）
 *
 * 使用本地时区日期，避免 UTC 偏移导致跨天错位
 * （如 Asia/Shanghai 00:00-08:00 期间 UTC 仍是前一天，
 * 会话文件会写入"昨天"导致跨天 reset 与 UI 错乱）
 *
 * @returns 如 "2026-06-21"
 */
export function todayDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
