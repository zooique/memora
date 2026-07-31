/**
 * components/index.ts - UI 组件库统一导出入口（HEAL-17 Phase 0）
 *
 * 集中导出所有公共组件，便于页面统一导入。
 *
 * 依赖规则（对齐 ui-engineering-mindset-rules §四.3）：
 *   - 高层可依赖低层，低层不可依赖高层
 *   - 当前 sprite components/ 是平铺目录（directory-structure.md §1），
 *     未来达到 15+ 文件时再启动分层（base/feedback/form/navigation/data）
 *   - Phase 0 阶段：仅导出 Component 基类 + ToastComponent（待 Phase 1 完成）
 *
 * 使用方式：
 *   import { Component, ToastComponent } from '../components/index.js';
 *
 * @module components
 */

/* ========== 基础组件（Phase 0） ========== */
export { Component } from './Component.js';

/* ========== 反馈组件（Phase 1） ========== */
export { ToastComponent } from './toastComponent.js';
export type { ToastComponentOptions } from './toastComponent.js';

/* ========== 数据展示组件（Phase 2） ========== */
export { MessageBubbleComponent } from './messageBubbleComponent.js';
export type { MessageBubbleOptions } from './messageBubbleComponent.js';

/*
 * 面板子渲染器升级组件（HEAL-17 Phase B）
 * ────────────────────────────────────────────
 * 由 panels/*Renderer 升级而来的 Component 子类，统一经本入口导出以满足 §四.3「统一导出入口」。
 * 物理文件暂留在 panels/（与尚未迁移的 5 个 *Renderer 同位），待 Phase D 分层定稿时
 * 再整体迁至 components/ 并按 base←feedback←form←navigation←data 归类。
 */
export { CompletionStatsComponent } from '../panels/completionStatsRenderer.js';
export type { CompletionStatsOptions, CompletionStatsHost } from '../panels/completionStatsRenderer.js';
export { HealthDashboardComponent } from '../panels/healthDashboardRenderer.js';
export type { HealthDashboardOptions } from '../panels/healthDashboardRenderer.js';
export { InsightsComponent } from '../panels/insightsRenderer.js';
export type { InsightsOptions, InsightsDashboardData } from '../panels/insightsRenderer.js';
export { PartnerInsightsComponent } from '../panels/partnerInsightsRenderer.js';
export type { PartnerInsightsOptions } from '../panels/partnerInsightsRenderer.js';
export { LlmGovernanceResultComponent } from '../panels/llmGovernanceResultRenderer.js';
export type { LlmGovernanceOptions, LlmGovernanceReport } from '../panels/llmGovernanceResultRenderer.js';

/* ========== 声明式列表工厂（Phase C） ========== */
// FlatListPanel：扁平列表声明式工厂（§四.2），覆盖 audit/profile/work 三个结构相似面板。
// 物理文件位于 components/（本就是新建的通用组件，非 panel 重命名），经本入口统一导出。
export { FlatListPanel } from './flatListPanel.js';
export type { FlatListPanelOptions } from './flatListPanel.js';

/* ========== 表单组件 ========== */
// 待后续 Phase 填充

/* ========== 导航组件 ========== */
// 待后续 Phase 填充
