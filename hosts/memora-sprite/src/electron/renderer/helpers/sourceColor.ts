/**
 * 记忆来源颜色映射 — 纯函数工具
 *
 * 职责：
 * - 将记忆 source 字符串映射为 CSS 颜色类名
 * - 已知来源返回原值，未知来源返回 'default'
 *
 * 设计原则：
 * - 纯函数，无副作用，无状态
 * - 从 memoryPanelManager.ts 提取，消除 helpers/ → panels/ 循环依赖
 * - 6 处调用点：memoryPanelManager / dashboardPanelManager / insightsRenderer / memoryDetailPanel / memoryTimelineView
 */

/**
 * 已知的记忆来源列表（与 source-tag CSS 类名一一对应）
 */
const KNOWN_SOURCES = ['profile', 'insight', 'guardrail', 'skill', 'rule', 'persona', 'session'] as const;

/**
 * 获取记忆来源对应的 CSS 颜色类名
 *
 * @param source 记忆来源字符串（开放字符串，如 'profile'、'insight'、'rule'）
 * @returns 对应的 CSS 颜色类名（如 'profile' / 'default'）
 */
export function getSourceColorClass(source: string): string {
  const normalized = source.toLowerCase().trim();
  return (KNOWN_SOURCES as readonly string[]).includes(normalized) ? normalized : 'default';
}
