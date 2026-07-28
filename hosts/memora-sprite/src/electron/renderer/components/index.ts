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

/* ========== 表单组件 ========== */
// 待后续 Phase 填充

/* ========== 导航组件 ========== */
// 待后续 Phase 填充
