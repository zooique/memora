/**
 * 感知/仪表盘域二级协调器
 *
 * 封装感知可视化相关的 3 个子模块：
 * - dashboardPanel（仪表盘：概览 + 运行指标 + 记忆源健康 + 增长趋势）
 * - perceptionPanel（完整版感知数据展示：情感/默契/上下文/模式/在场/叙事）
 * - spriteStatusPopover（hover 弹出轻量感知摘要，与 perceptionPanel 共享数据源）
 *
 * 设计原则：
 * - 纯状态容器 + cleanup 集中清理（不持有业务逻辑，业务逻辑仍在 UIManager + mixin）
 * - 字段公开暴露，dashboardDelegations / ui.ts 直接读写
 * - 初始化仍在 UIManager 构造函数中（perceptionPanel 依赖 PerceptionPanelHost 反向注入）
 *
 * 集成点：
 * - UIManager 持有 perceptionCoordinator 实例并挂载到 this.perceptionCoordinator
 * - dashboardDelegations.ts 通过 this.perceptionCoordinator.dashboardPanel 等访问
 * - UIManager.cleanup() 调用 perceptionCoordinator.cleanup() 集中清理
 */

import type { DashboardPanelManager } from '../panels/dashboardPanelManager.js';
import type { PerceptionPanelManager } from '../panels/perceptionPanelManager.js';
import type { SpriteStatusPopover } from '../panels/spriteStatusPopover.js';

/**
 * 感知/仪表盘域二级协调器类
 *
 * 集中管理感知可视化相关的 3 个子模块，避免分散在 UIManager 中。
 * 退出时通过 cleanup() 集中调用各子模块的清理方法，确保定时器和事件监听器正确释放。
 */
export class PerceptionCoordinator {
  /** 仪表盘面板管理器（概览 + 指标 + 健康 + 趋势），UIManager 构造函数初始化 */
  dashboardPanel!: DashboardPanelManager;
  /** 完整版感知面板管理器（情感/默契/上下文/模式/在场/叙事），UIManager 构造函数初始化 */
  perceptionPanel!: PerceptionPanelManager;
  /** 精灵状态浮层（hover 弹出轻量感知摘要），UIManager 构造函数初始化 */
  spriteStatusPopover!: SpriteStatusPopover;

  /**
   * 集中清理 3 个子模块资源
   *
   * UIManager.cleanup() 调用，确保定时器和事件监听器正确释放。
   * 各子模块的 cleanup 由各自实现，此方法仅集中调度。
   */
  cleanup(): void {
    this.dashboardPanel.cleanup(); // 清理仪表盘脉冲定时器与重试按钮事件
    this.perceptionPanel.cleanup(); // 清理感知面板资源
    this.spriteStatusPopover.cleanup(); // 清理精灵状态浮层 hover 事件和定时器
  }
}
