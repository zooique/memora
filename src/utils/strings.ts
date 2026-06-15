/**
 * 字符串工具函数
 *
 * 从各模块提取的公共字符串处理函数，消除跨模块重复代码。
 */

/**
 * 将字符串转换为 URL 友好的 slug 格式
 *
 * 规则：
 *   - 冒号和空白替换为连字符
 *   - 只保留字母、数字、中文、连字符、下划线
 *   - 截断到 40 字符
 *
 * @param value 输入字符串
 * @returns slug 格式的字符串
 */
export function slugify(value: string): string {
  return value
    .replace(/[:\s]+/g, '-')
    .replace(/[^a-zA-Z0-9\u4e00-\u9fff\-_]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}
