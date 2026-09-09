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
 * score 字段已物理删除（2026-09-09 阶段3 退役），使用轨迹唯一事实源为 accessedAt；
 * 采集/推荐等需要「采样 top-N」的场景统一按 accessedAt 降序（原 byScoreDesc）。
 *
 * @param a 前一个元素
 * @param b 后一个元素
 * @returns 负数表示 a 排前，正数表示 b 排前
 */
export function byAccessedDesc<T extends { accessedAt: string }>(a: T, b: T): number {
  // ISO 8601 字符串可直接按字典序比较（时间正序 → 字符串升序）
  return a.accessedAt < b.accessedAt ? 1 : a.accessedAt > b.accessedAt ? -1 : 0;
}