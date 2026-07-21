/**
 * 数值工具（跨层共享，纯函数）
 *
 * 职责：
 *   - 提供 0-1 浮点数的保留两位小数工具
 *   - 提供 LLM Token 数量格式化工具（统一小写 k 后缀）
 *
 * 设计原则（ADR-017 枝叶层 2 次提取）：
 *   - round2 从 affectController / rapportController / memoryController 三处散落的
 *     `Math.round(x * 100) / 100` 模式中提取（共出现 7+ 次）
 *   - formatTokenCount 从 dashboardPanelManager 导出函数 + inputAreaManager 内部闭包
 *     两处完全等价但大小写不一致（k vs K）的实现中提取（UX-12 术语统一）
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

/**
 * 格式化 LLM Token 数量为紧凑显示
 *
 * 统一规则：小于 1000 直接显示数字，大于等于 1000 显示为 "1.2k"（小写 k，
 * 与 SI 词头一致，对齐 GitHub stars / npm downloads 业界主流）。
 *
 * 提取自 dashboardPanelManager.formatTokenCount + inputAreaManager 内部闭包
 * formatTokens 两处等价实现，消除 K/k 大小写不一致（UX-12）。
 *
 * @param tokens token 数量
 * @returns 格式化后的字符串（如 "999" / "1.2k" / "12.3k"）
 *
 * @example
 * formatTokenCount(0)      // '0'
 * formatTokenCount(999)    // '999'
 * formatTokenCount(1000)   // '1.0k'
 * formatTokenCount(1234)   // '1.2k'
 * formatTokenCount(12345)  // '12.3k'
 */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}k`;
  }
  return String(tokens);
}
