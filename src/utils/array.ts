/**
 * 数组工具函数模块
 *
 * 职责：
 * - 提供通用的数组排序、去重、拷贝等纯函数工具
 *
 * 设计原则：
 * - 同一模式在 2+ 文件出现时提取到此处
 * - 纯函数，零依赖，可被任何内核模块安全导入
 */

/**
 * 按 accessedAt 字段降序排序（最近使用优先）的比较函数
 *
 * 使用轨迹唯一事实源为 accessedAt；记忆的按来源列举与检索结果统一按 accessedAt 降序
 * （消费者：`memory/inMemoryStorage` 的 `getBySource` 与 `sortCopyLimit`）。
 */
export function byAccessedDesc<T extends { accessedAt: string }>(a: T, b: T): number {
  // ISO 8601 字符串可直接按字典序比较（时间正序 → 字符串升序）
  return a.accessedAt < b.accessedAt ? 1 : a.accessedAt > b.accessedAt ? -1 : 0;
}
