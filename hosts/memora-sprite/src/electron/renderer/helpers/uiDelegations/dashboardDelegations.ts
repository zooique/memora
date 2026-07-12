/**
 * Dashboard + Perception 委托群
 *
 * 从 ui.ts 提取的薄委托方法群，通过 mixin 模式注入 UIManager.prototype。
 * 所有方法均为纯透传到 DashboardPanelManager / PerceptionPanelManager / MemoryPanelManager / SpriteStatusPopover，
 * 不夹带业务逻辑（ADR-SP-015 §4）。
 *
 * 设计原则：
 * - 每个方法的 this 类型声明为 UIManager，以访问组合持有的子模块实例
 * - 方法签名与 ui.ts 原始声明完全一致，保持外部契约不变
 */

import type { UIManager } from '../../ui.js';
import type {
  DashboardViewModel,
  AgentMetrics,
  SourceHealth,
} from '../../panels/dashboardPanelManager.js';
import type { RelationGraphData } from '../../components/relationGraph.js';
import type { HealthDashboardPayload, ReviewDataPayload } from '../../../preload.js';
import type {
  AffectPayload,
  RapportPayload,
  ContextPayload,
  PatternsPayload,
  PresencePayload,
} from '../../ipcListeners.js';
import type { ProactiveStats } from '../../../../sprite/controllers/index.js';

/** Dashboard + Perception 委托群方法签名（供 UIManager interface extends 类型合并） */
export interface DashboardDelegations {
  renderDashboardStats(data: DashboardViewModel): void;
  renderAgentMetrics(metrics: AgentMetrics | null): void;
  renderSourceHealth(sourceHealth: SourceHealth | null): void;
  renderReviewData(review: ReviewDataPayload): void;
  renderSkills(skills: Array<{ name: string; keywords: string[]; description: string; layer: string }>): void;
  showInsightsLoading(): void;
  renderInsights(dashboard: { total: number; bySource: Record<string, number>; conflictCount?: number }, graph: RelationGraphData): void;
  renderPartnerInsights(memories: Array<{ id: string; name: string; source: string; contentPreview: string; createdAt?: string }>): void;
  onPartnerMemoryClick(cb: (memoryId: string) => void): void;
  showInsightsError(): void;
  showHealthLoading(): void;
  renderHealthDashboard(data: HealthDashboardPayload): void;
  showHealthError(): void;
  showMemoryListError(listEl: HTMLElement): void;
  pulseCounter(id: string): void;
  updateAffectDisplay(affect: AffectPayload): void;
  updateRapportDisplay(rapport: RapportPayload): void;
  updateContextDisplay(context: ContextPayload): void;
  updatePatternsDisplay(payload: PatternsPayload): void;
  updatePresenceDisplay(payload: PresencePayload): void;
  updateNarrative(): void;
  onReloadInsights(cb: () => void): void;
  onReloadHealth(cb: () => void): void;
  onReloadMemoryList(cb: () => void): void;
  repaintCanvasOnThemeChange(): void;
}

/** Dashboard + Perception 委托群实现——纯透传到 dashboardPanel / perceptionPanel / memoryPanel / spriteStatusPopover / settingsPanelManager */
export const dashboardDelegations: DashboardDelegations = {
  renderDashboardStats(this: UIManager, data: DashboardViewModel): void {
    this.dashboardPanel.renderDashboardStats(data);
  },
  renderAgentMetrics(this: UIManager, metrics: AgentMetrics | null): void {
    this.dashboardPanel.renderAgentMetrics(metrics);
  },
  renderSourceHealth(this: UIManager, sourceHealth: SourceHealth | null): void {
    this.dashboardPanel.renderSourceHealth(sourceHealth);
  },
  renderReviewData(this: UIManager, review: ReviewDataPayload): void {
    this.dashboardPanel.renderReviewData(review);
  },
  renderSkills(this: UIManager, skills: Array<{ name: string; keywords: string[]; description: string; layer: string }>): void {
    this.settingsPanelManager.renderSkills(skills);
  },
  showInsightsLoading(this: UIManager): void {
    this.memoryPanel.showInsightsLoading();
  },
  renderInsights(this: UIManager, dashboard: { total: number; bySource: Record<string, number>; conflictCount?: number }, graph: RelationGraphData): void {
    this.memoryPanel.renderInsights(dashboard, graph);
  },
  renderPartnerInsights(this: UIManager, memories: Array<{ id: string; name: string; source: string; contentPreview: string; createdAt?: string }>): void {
    this.memoryPanel.renderPartnerInsights(memories);
  },
  onPartnerMemoryClick(this: UIManager, cb: (memoryId: string) => void): void {
    this.memoryPanel.onPartnerMemoryClick(cb);
    this.perceptionPanel.onMemoryClick(cb);
  },
  showInsightsError(this: UIManager): void {
    this.memoryPanel.showInsightsError();
  },
  showHealthLoading(this: UIManager): void {
    this.memoryPanel.showHealthLoading();
  },
  renderHealthDashboard(this: UIManager, data: HealthDashboardPayload): void {
    this.memoryPanel.renderHealthDashboard(data);
  },
  showHealthError(this: UIManager): void {
    this.memoryPanel.showHealthError();
  },
  showMemoryListError(this: UIManager, listEl: HTMLElement): void {
    this.dashboardPanel.showMemoryListError(listEl);
  },
  pulseCounter(this: UIManager, id: string): void {
    this.dashboardPanel.pulseCounter(id);
  },
  updateAffectDisplay(this: UIManager, affect: AffectPayload): void {
    this.perceptionPanel.updateAffectDisplay(affect);
    this.spriteStatusPopover.updateAffect(affect);
  },
  updateRapportDisplay(this: UIManager, rapport: RapportPayload): void {
    this.perceptionPanel.updateRapportDisplay(rapport);
    this.spriteStatusPopover.updateRapport(rapport);
  },
  updateContextDisplay(this: UIManager, context: ContextPayload): void {
    this.perceptionPanel.updateContextDisplay(context);
    this.spriteStatusPopover.updateContext(context);
  },
  updatePatternsDisplay(this: UIManager, payload: PatternsPayload): void {
    this.perceptionPanel.updatePatternsDisplay(payload);
  },
  updatePresenceDisplay(this: UIManager, payload: PresencePayload): void {
    this.perceptionPanel.updatePresenceDisplay(payload);
  },
  updateNarrative(this: UIManager): void {
    this.perceptionPanel.updateNarrative();
  },
  onReloadInsights(this: UIManager, cb: () => void): void {
    this.memoryPanel.onReloadInsights(cb);
  },
  onReloadHealth(this: UIManager, cb: () => void): void {
    this.memoryPanel.onReloadHealth(cb);
  },
  onReloadMemoryList(this: UIManager, cb: () => void): void {
    this.dashboardPanel.onReloadMemoryList(cb);
  },
  repaintCanvasOnThemeChange(this: UIManager): void {
    this.dashboardPanel.repaintOnThemeChange();
    this.memoryPanel.repaintOnThemeChange();
  },
};

// ProactiveStats 类型导入用于 updateProactiveStatsDisplay 的参数类型推断
// 该方法因含类型转换（非纯透传）保留在 ui.ts 中
export type { ProactiveStats };
