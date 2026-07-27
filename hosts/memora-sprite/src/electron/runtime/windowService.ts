/**
 * 窗口/托盘基础设施状态容器
 *
 * 封装阶段 1 初始化的 4 个字段：
 * - windowStateManager（窗口状态管理器）
 * - windowManager（窗口管理器）
 * - interaction（交互层）
 * - trayManager（系统托盘管理器）
 *
 * 设计原则：
 * - 纯状态容器，不持有业务逻辑（业务逻辑仍在 main.ts）
 * - 字段公开暴露，IPC handler 和 main.ts 直接读写
 *
 * 集成点：
 * - main.ts 持有 windowService 实例并挂载到 appState.windowService
 * - minimalHandlers.ts 通过 MinimalIpcState.windowService 访问 windowManager
 * - IpcContext getter 通过 appState.windowService.windowManager 实时查询
 */

import type { WindowStateManager } from '../windows/windowState.js';
import type { WindowManager } from '../windows/windowManager.js';
import type { ElectronInteraction } from '../interaction.js';
import type { TrayManager } from '../trayIcon.js';

/**
 * 窗口/托盘基础设施状态容器类
 *
 * 集中管理阶段 1 初始化的 4 个窗口/托盘字段，避免分散在 appState 中。
 * 退出时通过 nullify() 集中切断引用，防止退出后定时器残留触发已销毁对象的方法。
 */
export class WindowService {
  /** 窗口状态管理器（三态切换 + 持久化），阶段 1 初始化 */
  windowStateManager!: WindowStateManager;
  /** 窗口管理器（完整窗口 + 浮动窗口），阶段 1 初始化 */
  windowManager!: WindowManager;
  /** 交互层（ElectronInteraction，注入主窗口引用），阶段 1 初始化 */
  interaction!: ElectronInteraction;
  /** 系统托盘管理器（无托盘环境降级为 null），阶段 1 初始化 */
  trayManager: TrayManager | null = null;

  /**
   * 清空所有引用（退出时调用）
   *
   * 切断所有字段引用，防止退出后定时器残留触发已销毁对象的方法。
   * windowManager/trayManager 的 destroy/closeAll 由 before-quit 回调前置执行。
   */
  nullify(): void {
    this.windowStateManager = null!;
    this.windowManager = null!;
    this.interaction = null!;
    this.trayManager = null;
  }
}
