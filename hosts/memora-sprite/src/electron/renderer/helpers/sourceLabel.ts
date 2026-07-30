/**
 * 记忆来源中文标签映射 — re-export shared 层真理源
 *
 * MIND-D6 嫁接：原映射表已下沉到 shared/sourceLabels.ts，
 * 消除 sprite 侧 patternDetector 私有 sourceLabel（11 项）与 renderer 侧
 * SOURCE_LABELS（17 项）的双真理源问题。
 *
 * 本文件保持 re-export 向后兼容，消费点（8 处）零改动：
 * - memoryPanelManager.ts（记忆列表 + 回收站列表）
 * - memoryDetailPanel.ts（详情弹窗 + 演化脉络 2 处）
 * - memoryTimelineView.ts（时间线列表）
 * - insightsRenderer.ts（source 分布条）
 * - profilePanelManager.ts（画像条目）
 * - dashboardPanelManager.ts（sourceHealth 区域）
 *
 * 与 quickInputCompletion.ts 的 SOURCE_LABEL_MAP 关系：
 * - 该文件保留独立的 4 项精简映射（insight/profile/work-projection + 默认'记忆'），
 *   因为补全候选场景需要更短的标签（'作品' vs '作品投影'），不强制统一。
 */

export { SOURCE_LABELS, getSourceLabel } from '../../../shared/sourceLabels.js';
