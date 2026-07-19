/**
 * 等级标签工具（跨层共享，纯函数）
 *
 * 职责：
 *   - 将 0-1 数值映射为中文等级标签（低/中/高）
 *
 * 设计原则（ADR-017 枝叶层 2 次提取）：
 *   - 从 affectController.describeLevel / rapportController.describeLevel 两处
 *     完全相同的实现中提取（阈值 0.33 / 0.67 一致）
 *   - 纯函数，零依赖，可被 sprite 各控制器安全导入
 *
 * 架构位置：
 *   - 位于 shared/ 层（与 numberUtils / truncate 同级），跨层共享
 */

/** 低等级阈值：value < LOW_THRESHOLD → '低' */
const LOW_THRESHOLD = 0.33;

/** 高等级阈值：value < HIGH_THRESHOLD → '中'，否则 → '高' */
const HIGH_THRESHOLD = 0.67;

/**
 * 将 0-1 数值映射为中文等级描述
 *
 * 阈值约定：
 *   - value < 0.33 → '低'
 *   - value < 0.67 → '中'
 *   - 否则 → '高'
 *
 * 用于精灵感知面板的友好性展示（如"信任度：中"）。
 *
 * @param value 0-1 之间的数值（超出范围按边界处理：负数视为 0，>1 视为 1）
 * @returns 等级描述（低/中/高）
 */
export function describeLevel(value: number): string {
  if (value < LOW_THRESHOLD) return '低';
  if (value < HIGH_THRESHOLD) return '中';
  return '高';
}
