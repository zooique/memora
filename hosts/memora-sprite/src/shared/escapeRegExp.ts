/**
 * RegExp 特殊字符转义工具（跨层共享，纯函数）
 *
 * 职责：
 *   - 转义用户输入中的 RegExp 特殊字符，使其可安全嵌入 new RegExp()
 *
 * 设计原则（ADR-017 枝叶层 2 次提取）：
 *   - 从 3 处散落的 `.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')` 模式中提取
 *   - commandPaletteManager / memoryPanelManager / searchMessagesManager 共 3 处
 *   - 正则字面量易抄错（转义字符多），统一后可单点测试
 *
 * 架构位置：
 *   - 位于 shared/ 层（与 truncate/toError 同级），跨层共享
 *   - 纯字符串逻辑，无 DOM/Node 依赖
 */

/**
 * 转义 RegExp 特殊字符
 *
 * 将 `.*+?^${}()|[]\` 等 12 类特殊字符前加反斜杠，
 * 使转义后的字符串可安全嵌入 `new RegExp()` 构造器。
 *
 * @param input 原始用户输入
 * @returns 转义后的安全字符串（可直接用于 new RegExp(escaped)）
 */
export function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
