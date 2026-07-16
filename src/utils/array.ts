/**
 * 数组工具函数模块
 *
 * 职责：
 * - 提供通用的数组排序、去重、拷贝等纯函数工具
 *
 * 设计原则（ADR-017 枝叶层 2 次提取）：
 * - 同一模式在 2+ 文件出现时提取到此处
 * - 纯函数，零依赖，可被任何内核模块安全导入
 */

/**
 * 按 score 字段降序排序的比较函数
 *
 * 用于记忆/角色/技能等带 score 字段的排序场景。
 * 9 处 `.sort((a, b) => b.score - a.score)` 的统一提取（ADR-017 枝叶层 2 次提取）。
 *
 * @param a 前一个元素
 * @param b 后一个元素
 * @returns 负数表示 a 排前，正数表示 b 排前
 */
export function byScoreDesc<T extends { score: number }>(a: T, b: T): number {
  return b.score - a.score;
}
