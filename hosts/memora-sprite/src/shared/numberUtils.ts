/**
 * 数值工具（跨层共享，纯函数）
 *
 * 职责：
 *   - 提供 0-1 浮点数的保留两位小数工具
 *
 * 设计原则（ADR-017 枝叶层 2 次提取）：
 *   - 从 affectController / rapportController / memoryController 三处散落的
 *     `Math.round(x * 100) / 100` 模式中提取（共出现 7+ 次）
 *   - 纯函数，零依赖，可被 sprite/storage/renderer 三层安全导入
 *
 * 架构位置：
 *   - 位于 shared/ 层（与 truncate / toError 同级），跨层共享
 */

/**
 * 将数值保留两位小数
 *
 * 用于精灵感知控制器（affect/rapport）和记忆控制器（score 格式化）的统一精度处理，
 * 避免 UI 渲染时出现 `0.333333333` 这类不规则小数。
 *
 * @param value 原始数值
 * @returns 保留两位小数后的数值
 */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
