/**
 * 时间工具函数
 *
 * 从 messageHistory.ts 提取的公共时间格式化函数，
 * 消除跨模块 `new Date().toISOString()` 内联重复。
 *
 * API 对齐：formatDateKey(date) 与精灵 shared/dateUtils.ts 语义一致，
 * 用于格式化任意 Date 为 YYYY-MM-DD（本地时区）。
 */

/** 一天对应的毫秒数（跨层共享，供衰减年龄/沉底天数换算） */
export const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 计算距目标时间的完整天数（向下取整，负数 = 未来）
 *
 * @param iso 目标时间的 ISO 8601 字符串
 * @param now 相对当前时刻（毫秒时间戳）
 * @returns 完整天数（非整输入非法时返回 NaN）
 */
export function daysBetween(iso: string, now?: number): number {
  const t = Date.parse(iso);
  if (isNaN(t)) return NaN;
  return Math.floor((t - (now ?? Date.now())) / ONE_DAY_MS);
}

/**
 * 获取当前时间的 ISO 8601 时间戳
 *
 * @returns 如 "2026-06-21T12:34:56.789Z"
 */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * 格式化 Date 为 YYYY-MM-DD 日期键（本地时区）
 *
 * 使用 getFullYear/getMonth/getDate（本地时区），替代 toISOString().slice(0,10)（UTC）。
 * 修复场景：Asia/Shanghai 凌晨 00:00-08:00 期间 UTC 仍是前一天，导致按日期分组的
 * 计数（chatTurns / dailyMessageCount）写入错误的日期 key。
 *
 * 与精灵 shared/dateUtils.ts:formatDateKey 行为完全对齐。
 *
 * @param date Date 对象
 * @returns YYYY-MM-DD 字符串（本地日期）
 */
export function formatDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 获取当前日期字符串（YYYY-MM-DD，本地时区）
 *
 * 委托 formatDateKey(new Date())，避免逻辑重复。
 * 保留无参形态是因为多数调用点只关心"今天"，无需先构造 new Date()。
 *
 * @returns 如 "2026-06-21"
 */
export function todayDate(): string {
  return formatDateKey(new Date());
}
