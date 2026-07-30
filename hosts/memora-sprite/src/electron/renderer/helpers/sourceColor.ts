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
 *
 * 与 sourceLabel.ts 的关系：
 * - KNOWN_SOURCES 直接派生自 sourceLabel 的 SOURCE_DISPLAY_LABELS 映射表 keys，
 *   消除"两个真理源"漂移风险（新增 source 时无需同步两处）。
 * - SOURCE_DISPLAY_LABELS 包含 17 项映射，其中部分 source（如 'work-projection'、'quick-input'）
 *   当前未定义独立 CSS 颜色类，运行时 CSS 找不到对应 .memory-tag-{source} 规则时
 *   由 CSS 层兜底（默认 .memory-tag-default 样式），与原行为等价。
 */

import { SOURCE_DISPLAY_LABELS } from './sourceLabel.js';

/**
 * 派生自 SOURCE_DISPLAY_LABELS 的已知 source 列表（与 sourceLabel.ts 单一真理源对齐）
 *
 * 原硬编码 7 项（profile/insight/guardrail/skill/rule/persona/session）改为
 * 从 SOURCE_DISPLAY_LABELS 派生，新增 source 类型时只需在 sourceLabel.ts 加一项即可。
 */
const KNOWN_SOURCES: readonly string[] = Object.keys(SOURCE_DISPLAY_LABELS);

/**
 * 获取记忆来源对应的 CSS 颜色类名
 *
 * @param source 记忆来源字符串（开放字符串，如 'profile'、'insight'、'rule'）
 * @returns 对应的 CSS 颜色类名（如 'profile' / 'default'）
 */
export function getSourceColorClass(source: string): string {
  const normalized = source.toLowerCase().trim();
  return KNOWN_SOURCES.includes(normalized) ? normalized : 'default';
}
