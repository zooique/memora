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
 *
 * 类型隔离说明：
 * windowManager 字段使用本地 WindowManagerLike 接口而非导入 WindowManager 类，
 * 切断 windowService.ts → windowManager.ts → esmShim.ts 的类型追踪链，
 * 避免 preload（CJS 编译）追踪到 esmShim.ts（ESM 运行时）导致 import.meta.url 编译错误（TS1343）。
 * 与 ipc/types.ts 的 WindowManagerLike 模式一致。
 */

import type { BrowserWindow } from 'electron';
import type { WindowStateManager } from '../windows/windowState.js';
import type { ElectronInteraction } from '../interaction.js';
import type { TrayManager } from '../trayIcon.js';

/** 浮动窗口回调（与 floatWindow.ts 的 FloatWindowCallbacks 结构一致，避免导入追踪到 esmShim.ts） */
interface FloatWindowCallbacks {
  /** 展开为完整窗口（同时清零未读计数） */
  onExpandToFull?: () => void;
  /** 隐藏到托盘态 */
  onHideToTray?: () => void;
  /** 退出应用 */
  onQuit?: () => void;
  /** 切换静默模式（参数为切换后的新状态） */
  onToggleSilent?: (newSilent: boolean) => void;
  /** 查询当前静默模式状态（同步返回，用于菜单勾选） */
  isSilentMode?: () => boolean;
  /** 浮球单击 → 呼出补全弹窗（坐标 + 浮球 HWND） */
  onShowQuickInput?: (x: number, y: number, floatHwnd: number) => void;
}

/** 浮动窗口接口（覆盖 main.ts + spriteEventBridge.ts 使用的所有方法，避免导入追踪到 floatWindow.ts → esmShim.ts） */
interface FloatWindowLike {
  /** 向浮动窗口发送 IPC 消息（转发到底层 BrowserWindow.webContents.send） */
  send(channel: string, ...args: unknown[]): void;
  /** 广播主题变更到浮动窗口 */
  broadcastTheme(theme: 'light' | 'dark'): void;
  /** 广播在场状态（球体变暗 + 离开时长小标签） */
  broadcastPresence(state: 'present' | 'away', awayDurationMs?: number): void;
  /** 广播主动提示弹窗 */
  broadcastProactivePrompt(prompt: string, isMilestone: boolean): void;
  /** 设置未读计数（球体徽章） */
  setUnreadCount(count: number): void;
  /** 显示浮动窗口 */
  show(): void;
  /** 关闭浮动窗口 */
  close(): void;
  /** 更新回调 */
  updateCallbacks(callbacks: FloatWindowCallbacks): void;
  /** 创建窗口（返回 BrowserWindow 实例） */
  create(): Promise<BrowserWindow>;
}

/** 窗口管理器接口（覆盖 main.ts + minimalHandlers.ts + spriteEventBridge.ts + agentListeners.ts 使用的所有方法，避免导入 WindowManager 类追踪到 esmShim.ts） */
export interface WindowManagerLike {
  /** 显示完整窗口 */
  showFullWindow(): void;
  /** 获取完整窗口（主交互窗口），可能未创建 */
  getFullWindow(): BrowserWindow | null;
  /** 获取浮动窗口（56x56 悬浮球），可能未创建 */
  getFloatWindow(): FloatWindowLike | null;
  /** 更新浮动窗口回调 */
  updateFloatCallbacks(callbacks: FloatWindowCallbacks): void;
  /** 设置退出标志（closeAll 前调用，跳过关闭动画） */
  setQuitting(quitting: boolean): void;
  /** 关闭所有窗口 */
  closeAll(): void;
  /** 创建所有窗口（完整窗口 + 浮动窗口） */
  createWindows(): Promise<void>;
  /** 切换窗口可见性（显示/隐藏完整窗口） */
  toggleWindow(): void;
  /** 更新窗口背景色（主题切换时） */
  updateBackgroundColor(color: string): void;
}

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
  windowManager!: WindowManagerLike;
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
