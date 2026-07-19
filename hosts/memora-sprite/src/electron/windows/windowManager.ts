/**
 * 窗口管理器模块
 *
 * 职责：
 * - 创建和管理应用窗口
 * - 处理窗口生命周期事件
 * - 注册窗口控制 IPC
 *
 * 设计原则：
 * - 单一职责：只负责窗口相关逻辑
 * - 依赖注入：通过构造函数接收依赖
 * - 错误处理：统一使用错误处理器
 */

import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { BrowserWindow, ipcMain } from 'electron';
import { applyWindowSecurity } from './windowSecurity.js';
import type { WindowStateManager } from './windowState.js';
import { FloatWindow } from './floatWindow.js';
import type { FloatWindowCallbacks } from './floatWindow.js';
import { injectThemeScript } from './themeInjector.js';
import { errorHandler, ErrorCode, SpriteError } from '../errorHandler.js';
import { IPC_CHANNELS, MAIN_TO_RENDERER_CHANNELS } from '../ipc/channels.js';
import { ELECTRON_DIR } from '../esmShim.js';

/** 完整窗口最小尺寸：侧边栏 240px + 主内容区至少 400px = 640px；高度 480px 保证核心内容可见 */
const FULL_WINDOW_MIN_WIDTH = 640;
const FULL_WINDOW_MIN_HEIGHT = 480;

/**
 * 解析应用图标路径
 *
 * 运行时代码位于 dist-electron/electron/，图标位于 dist-electron/build/icons/。
 *
 * @returns 图标文件绝对路径，不存在时返回空字符串
 */
function resolveAppIconPath(): string {
  // 从 ELECTRON_DIR（dist-electron/electron/）往上一级到 dist-electron/，再找 build/icons
  const iconPath = path.join(ELECTRON_DIR, '..', 'build', 'icons', 'icon.png');
  return existsSync(iconPath) ? iconPath : '';
}

/** 应用图标路径（模块加载时解析一次，缓存结果） */
const APP_ICON_PATH = resolveAppIconPath();

// ─── 窗口管理器类 ─────────────────────────────────────────

export class WindowManager {
  private windowStateManager: WindowStateManager;
  private floatWindow: FloatWindow | null = null;
  private fullWindow: BrowserWindow | null = null;
  /** 应用是否正在退出（区分"用户关闭"与"应用退出"） */
  private isQuitting = false;
  /** 浮动窗口回调集合（由 main.ts 注入，包含右键菜单所需的所有回调） */
  private floatCallbacks: FloatWindowCallbacks;

  constructor(
    windowStateManager: WindowStateManager,
    options?: FloatWindowCallbacks,
  ) {
    this.windowStateManager = windowStateManager;
    this.floatCallbacks = options ?? {};
  }

  /** 标记应用正在退出，允许窗口真正关闭 */
  setQuitting(quitting: boolean): void {
    this.isQuitting = quitting;
  }

  /**
   * 更新浮动窗口回调（main.ts 在 Agent 初始化后补充注入静默模式相关回调）
   *
   * 场景：WindowManager 在 Agent 初始化前创建，此时无法查询静默模式状态。
   * Agent 就绪后调用此方法补充注入 onToggleSilent / isSilentMode 回调。
   */
  updateFloatCallbacks(callbacks: FloatWindowCallbacks): void {
    this.floatCallbacks = { ...this.floatCallbacks, ...callbacks };
    // 同步更新已创建的 FloatWindow 实例的回调
    this.floatWindow?.updateCallbacks(this.floatCallbacks);
  }

  /** 创建所有窗口 */
  async createWindows(): Promise<void> {
    try {
      // 创建浮动窗口
      await this.createFloatWindow();

      // 创建完整窗口
      await this.createFullWindow();

      // 注册窗口控制 IPC
      this.registerWindowControls();

      // 设置窗口事件处理器
      this.setupWindowEvents();

      // 设置错误处理器的主窗口引用
      if (this.fullWindow) {
        errorHandler.setMainWindow(this.fullWindow);
      }
    } catch (error) {
      // 部分失败时清理已创建的资源
      // 场景：createFloatWindow 成功但 createFullWindow 失败，
      // floatWindow 已创建并注册 IPC 监听器，若不清理会泄漏
      this.closeAll();
      errorHandler.handle(error, {
        code: ErrorCode.WINDOW_CREATE_FAILED,
        context: '窗口创建失败',
      });
      // 包装为 SpriteError 统一错误体系（携带 code + cause，便于上层分类与诊断）
      throw new SpriteError(ErrorCode.WINDOW_CREATE_FAILED, '窗口创建失败', { cause: error });
    }
  }

  /** 创建浮动窗口 */
  private async createFloatWindow(): Promise<void> {
    this.floatWindow = new FloatWindow(this.windowStateManager, this.floatCallbacks);
    await this.floatWindow.create();
  }

  /** 创建完整窗口 */
  private async createFullWindow(): Promise<void> {
    const fullSize = this.windowStateManager.getFullSize();

    this.fullWindow = new BrowserWindow({
      width: fullSize.width,
      height: fullSize.height,
      minWidth: FULL_WINDOW_MIN_WIDTH,
      minHeight: FULL_WINDOW_MIN_HEIGHT,
      frame: false,
      show: false,
      // ADR-SP-008：浅色主题为默认，窗口背景色对齐大底板色（--bg: #f0f0f2），避免启动闪烁
      backgroundColor: '#f0f0f2',
      // 应用图标（任务栏、窗口切换器显示）
      icon: APP_ICON_PATH || undefined,
      webPreferences: {
        // preload 使用 .cjs（CommonJS 格式），兼容 sandbox: true；ESM 格式与 sandbox 不兼容
        preload: path.join(ELECTRON_DIR, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    this.windowStateManager.attachFullWindow(this.fullWindow);

    // 主进程注入主题初始化脚本（不受 CSP 约束）
    injectThemeScript(this.fullWindow.webContents);

    // 加载 HTML 文件
    const htmlPath = path.join(ELECTRON_DIR, 'renderer', 'index.html');
    await this.fullWindow.loadFile(htmlPath);

    // 缓存 fullWindow 引用避免非空断言，并确保回调中引用的是当前窗口实例
    const win = this.fullWindow;
    // 安全防护：拦截外部导航和弹窗（applyWindowSecurity 集中维护，ADR-017 枝叶层 2 次提取）
    // 防止 XSS 后跳转到恶意页面获取 IPC 权限
    applyWindowSecurity(win);
  }

  /** 注册窗口控制 IPC */
  private registerWindowControls(): void {
    ipcMain.on(IPC_CHANNELS.WINDOW_MINIMIZE, () => {
      this.fullWindow?.minimize();
    });

    ipcMain.on(IPC_CHANNELS.WINDOW_MAXIMIZE, () => {
      if (this.fullWindow?.isMaximized()) {
        this.fullWindow.unmaximize();
      } else {
        this.fullWindow?.maximize();
      }
    });

    ipcMain.on(IPC_CHANNELS.WINDOW_CLOSE, () => {
      // 关闭完整窗口 → 回到托盘态（float 显示由 showFloatBubble 偏好控制）
      this.windowStateManager.transition('tray');
    });
  }

  /** 设置窗口事件处理器 */
  private setupWindowEvents(): void {
    const win = this.fullWindow;
    if (!win) return;

    win.on('close', (e) => {
      // 应用退出时允许窗口真正关闭
      if (this.isQuitting) return;
      if (!win.isDestroyed()) {
        e.preventDefault();
        // 关闭完整窗口 → 回到托盘态（float 显示由 showFloatBubble 偏好控制）
        this.windowStateManager.transition('tray');
      }
    });

    // 最大化/还原状态变更 → 推送到渲染进程（用于按钮图标切换）
    win.on('maximize', () => {
      win.webContents.send(MAIN_TO_RENDERER_CHANNELS.WINDOW_STATE_CHANGED, { maximized: true });
    });
    win.on('unmaximize', () => {
      win.webContents.send(MAIN_TO_RENDERER_CHANNELS.WINDOW_STATE_CHANGED, { maximized: false });
    });
  }

  /** 获取完整窗口引用 */
  getFullWindow(): BrowserWindow | null {
    return this.fullWindow;
  }

  /** 获取浮动窗口引用 */
  getFloatWindow(): FloatWindow | null {
    return this.floatWindow;
  }

  /**
   * 动态更新窗口背景色
   *
   * 渲染进程主题切换时，通过 IPC 通知主进程调用此方法，
   * 使 BrowserWindow 的 backgroundColor 与当前主题一致。
   * 解决深色主题下窗口背景仍为浅色导致的启动闪烁问题。
   *
   * @param color 目标背景色（如 '#f0f0f2' 浅色 / '#1e1e2e' 深色）
   */
  updateBackgroundColor(color: string): void {
    if (this.fullWindow && !this.fullWindow.isDestroyed()) {
      this.fullWindow.setBackgroundColor(color);
    }
  }

  /** 关闭所有窗口 */
  closeAll(): void {
    // 清理窗口控制 IPC 监听器，避免 reinitAgent 或窗口重建时累积
    ipcMain.removeAllListeners(IPC_CHANNELS.WINDOW_MINIMIZE);
    ipcMain.removeAllListeners(IPC_CHANNELS.WINDOW_MAXIMIZE);
    ipcMain.removeAllListeners(IPC_CHANNELS.WINDOW_CLOSE);
    this.floatWindow?.close();
    this.fullWindow?.destroy();
    // 显式切断字段引用，允许 GC 回收 BrowserWindow 包装对象，
    // 避免退出后定时器/事件残留触发已销毁窗口的方法
    this.floatWindow = null;
    this.fullWindow = null;
  }

  /**
   * 切换窗口可见性（Phase 3.3：全局快捷键 toggle-window 动作）
   *
   * 当前为 tray 态 → 切换到 full 态（显示完整窗口）
   * 当前为 full 态 → 切换到 tray 态（隐藏到托盘）
   *
   * 委托给 WindowStateManager.transition，复用现有状态机逻辑。
   */
  toggleWindow(): void {
    const currentState = this.windowStateManager.getState();
    if (currentState === 'tray') {
      this.windowStateManager.transition('full');
    } else {
      this.windowStateManager.transition('tray');
    }
  }

  /**
   * 确保完整窗口可见（Phase 3.3 第二批：quick-record / recall-memory 动作）
   *
   * 与 toggleWindow 不同：仅在当前不是 full 态时切换到 full 态。
   * 如果已经是 full 态，不做任何操作（避免误隐藏）。
   */
  showFullWindow(): void {
    const currentState = this.windowStateManager.getState();
    if (currentState !== 'full') {
      this.windowStateManager.transition('full');
    }
  }
}