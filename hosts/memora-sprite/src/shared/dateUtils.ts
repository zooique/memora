/**
 * 日期工具函数模块（跨层共享，纯函数无运行时依赖）
 *
 * 职责：
 *   - 格式化 Date 为 YYYY-MM-DD 日期键（本地时区，修复 UTC 跨日 bug）
 *
 * 设计原则（ADR-017 枝叶层 2 次提取）：
 *   - 从 domHelpers.ts 迁移到 shared/ 层，供 renderer + sprite 共用
 *   - 原 domHelpers.ts 位置导致 sprite 层（usageStatsCollector / reviewManager）无法导入
 *     不得不继续使用 toISOString().slice(0,10)（UTC，凌晨跨日 bug）
 *   - 迁移后 sprite 层可统一使用本地日期，消除 UTC 跨日数据错位
 *
 * 架构位置：
 *   - 位于 shared/ 层（与 toError / truncate / escapeRegExp / safeWriteJson 同级）
 *   - 不与内核 memora 共享（ADR-002 内核零依赖约束）
 *   - renderer/helpers/domHelpers.ts 从本模块 re-export，保持调用方导入路径不变
 */

/**
 * 格式化日期为 YYYY-MM-DD 键（本地日期）
 *
 * 使用 getFullYear/getMonth/getDate（本地时区），替代 toISOString().slice(0,10)（UTC）。
 * 修复场景：Asia/Shanghai 凌晨 00:00-08:00 期间 UTC 仍是前一天，导致按日期分组的
 * 计数（chatTurns / dailyMessageCount）写入错误的日期 key。
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
