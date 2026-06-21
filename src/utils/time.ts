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
 * 获取当前日期字符串（YYYY-MM-DD）
 *
 * @returns 如 "2026-06-21"
 */
export function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}
