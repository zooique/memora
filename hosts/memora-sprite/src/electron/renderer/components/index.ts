/**
 * components/index.ts - UI 组件库统一导出入口（HEAL-17）
 *
 * 集中导出所有公共组件，便于页面统一导入（对齐 ui-engineering-mindset-rules §四.3）。
 *
 * 目录分层约定（D-MIGRATE，2026-08-01 落地）：
 *   components/
 *   ├── index.ts          统一导出入口
 *   ├── base/             Component 根基：抽象基类 + 声明式工厂基类
 *   │   ├── Component.ts          抽象基类（mount/update/destroy 生命周期契约）
 *   │   └── flatListPanel.ts      FlatListPanel<T> 声明式列表工厂基类（§四.2）
 *   ├── feedback/         反馈 / 通知型 Component
 *   │   ├── messageBubbleComponent.ts
 *   │   └── toastComponent.ts
 *   ├── data/             数据展示型面板 Component（Phase B 由 panels/*Renderer 升级迁入）
 *   │   ├── completionStatsComponent.ts
 *   │   ├── healthDashboardComponent.ts
 *   │   ├── insightsComponent.ts
 *   │   ├── partnerInsightsComponent.ts
 *   │   └── llmGovernanceResultComponent.ts
 *   └── （根保留非 Component 构件：Manager / Renderer / 工具）
 *       toast.ts(ToastManager) themeManager.ts suggestionCard.ts proactiveBanner.ts
 *       onboarding.ts modal.ts relationGraph.ts markdown.ts milestoneBanner.ts
 *       startupSummaryBanner.ts —— 后续若增长再独立子目录
 *
 * 分层规则（后续迭代遵循）：
 *   - Component 子类按用途归入 base/feedback/data；基类与工厂入 base/。
 *   - Manager / Renderer / 纯函数工具等非 Component 构件暂留根，不强行分层（复杂度守恒）。
 *   - 新增面板 Component → data/；新增反馈型 Component → feedback/。
 *
 * 依赖规则（对齐 §四.3）：高层可依赖低层，低层不可依赖高层。
 */

/* ========== 基础（base/） ========== */
export { Component } from './base/component.js';
export { FlatListPanel } from './base/flatListPanel.js';
export type { FlatListPanelOptions } from './base/flatListPanel.js';

/* ========== 反馈组件（feedback/） ========== */
export { ToastComponent } from './feedback/toastComponent.js';
export type { ToastComponentOptions } from './feedback/toastComponent.js';
export { MessageBubbleComponent } from './feedback/messageBubbleComponent.js';
export type { MessageBubbleOptions } from './feedback/messageBubbleComponent.js';

/* ========== 数据展示组件（data/，Phase B 升级迁入） ========== */
export { CompletionStatsComponent } from './data/completionStatsComponent.js';
export type { CompletionStatsOptions, CompletionStatsHost } from './data/completionStatsComponent.js';
export { HealthDashboardComponent } from './data/healthDashboardComponent.js';
export type { HealthDashboardOptions } from './data/healthDashboardComponent.js';
export { InsightsComponent } from './data/insightsComponent.js';
export type { InsightsOptions, InsightsDashboardData } from './data/insightsComponent.js';
export { PartnerInsightsComponent } from './data/partnerInsightsComponent.js';
export type { PartnerInsightsOptions } from './data/partnerInsightsComponent.js';
export { LlmGovernanceResultComponent } from './data/llmGovernanceResultComponent.js';
export type { LlmGovernanceOptions, LlmGovernanceReport } from './data/llmGovernanceResultComponent.js';

/* ========== 表单组件 ========== */
export { EmbeddingConfigComponent } from './form/embeddingConfigComponent.js';
export type { EmbeddingConfigData } from './form/embeddingConfigComponent.js';
export { ShortcutConfigComponent } from './form/shortcutConfigComponent.js';
export type { ShortcutConfigHost } from './form/shortcutConfigComponent.js';
export { SpriteConfigComponent } from './form/spriteConfigComponent.js';

/* ========== 导航组件 ========== */
// 待后续 Phase 填充
