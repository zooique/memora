/**
 * Memory 域二级协调器
 *
 * 封装记忆相关的 4 个子模块：
 * - memoryPanel（记忆列表、搜索过滤、详情弹窗、图谱视图）
 * - profilePanel（用户画像 tab：已确认/待处理）
 * - workProjectionPanel（作品投影 tab）
 * - auditPanel（审计日志 tab）
 *
 * 设计原则（对齐 ChatCoordinator / PerceptionCoordinator 模式）：
 * - 纯状态容器 + cleanup 集中清理（不持有业务逻辑，业务逻辑仍在 UIManager + mixin）
 * - 字段公开暴露，memoryDelegations / dashboardDelegations / settingsModalDelegations mixin 直接读写
 * - 初始化仍在 UIManager 构造函数（memoryPanel 依赖 MemoryPanelHost 反向注入）
 *
 * 集成点：
 * - UIManager 持有 memoryCoordinator 实例并挂载到 this.memoryCoordinator
 * - memoryDelegations.ts 通过 this.memoryCoordinator.memoryPanel 等访问
 * - UIManager.cleanup() 调用 memoryCoordinator.cleanup() 集中清理
 */

import type { MemoryPanelManager } from '../panels/memoryPanelManager.js';
import type { ProfilePanelManager } from '../panels/profilePanelManager.js';
import type { WorkProjectionPanelManager } from '../panels/workProjectionPanelManager.js';
import type { AuditPanelManager } from '../panels/auditPanelManager.js';

/**
 * Memory 域二级协调器类
 *
 * 集中管理记忆相关的 4 个子模块，避免分散在 UIManager 中。
 * 退出时通过 cleanup() 集中调用各子模块的清理方法，确保防抖定时器、
 * 事件监听器等正确释放。
 */
export class MemoryCoordinator {
  /** 记忆面板管理器（列表、搜索、详情、图谱），UIManager 构造函数初始化 */
  memoryPanel!: MemoryPanelManager;
  /** 用户画像面板管理器（已确认/待处理），UIManager 构造函数初始化 */
  profilePanel!: ProfilePanelManager;
  /** 作品投影面板管理器，UIManager 构造函数初始化 */
  workProjectionPanel!: WorkProjectionPanelManager;
  /** 审计日志面板管理器，UIManager 构造函数初始化 */
  auditPanel!: AuditPanelManager;

  /**
   * 集中清理 4 个子模块资源
   *
   * UIManager.cleanup() 调用，确保防抖定时器、事件监听器等正确释放。
   */
  cleanup(): void {
    this.memoryPanel.cleanup(); // 清理防抖定时器
    this.profilePanel.cleanup(); // 清理用户画像面板事件监听器
    this.workProjectionPanel.cleanup(); // 清理作品投影面板事件监听器
    this.auditPanel.cleanup(); // 清理审计日志面板事件监听器
  }
}
