/**
 * 文本截断工具（跨层共享，纯函数）
 *
 * 职责：
 *   - 将超长文本截断到指定长度，末尾追加省略号 '…'
 *   - 统一 ellipsis 为 Unicode '…'（1 字符），替代散落的 '...'（3 字符 ASCII）
 *
 * 设计原则（ADR-017 枝叶层 2 次提取）：
 *   - 从 8 处散落的 `slice + ellipsis` 模式中提取（renderer/sprite/storage 三层）
 *   - 语义：text.length > maxLen 时截断，省略号超出 maxLen（截断后总长度 = maxLen + 1）
 *   - 该语义与 7 处主流用法一致；quickInputCompletion 原用 `maxLen - 1` 语义，统一为不减 1
 *   - 纯函数，零依赖，可被 renderer/sprite/storage 三层安全导入
 *
 * 架构位置：
 *   - 位于 shared/ 层（与 toError 同级），跨层共享
 *   - 不与内核 memora 共享（ADR-002 内核零依赖约束，kernel/sprite 各自维护 truncate）
 */

/**
 * 截断文本到指定长度，超长时追加省略号
 *
 * @param text 原始文本
 * @param maxLen 最大保留长度（省略号不计入；截断后总长度 = maxLen + 1）
 * @returns 截断后的文本（含省略号 '…'），或原文本（未超长时原样返回）
 */
export function truncate(text: string, maxLen: number): string {
  // 未超长直接返回原文本（含 text.length === maxLen 的边界情况）
  if (text.length <= maxLen) return text;
  // 超长时截断到 maxLen 并追加 Unicode 省略号
  return text.slice(0, maxLen) + '…';
}
