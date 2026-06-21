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
import { BrowserWindow, ipcMain } from 'electron';
import type { WindowStateManager } from './windowState.js';
import { FloatWindow } from './floatWindow.js';
import type { FloatWindowCallbacks } from './floatWindow.js';
import { errorHandler, ErrorCode } from './errorHandler.js';
import { IPC_CHANNELS, MAIN_TO_RENDERER_CHANNELS } from './ipcChannels.js';
import { ELECTRON_DIR } from './utils/esmShim.js';

/** 完整窗口最小尺寸：侧边栏 240px + 主内容区至少 400px = 640px；高度 480px 保证核心内容可见 */
const FULL_WINDOW_MIN_WIDTH = 640;
const FULL_WINDOW_MIN_HEIGHT = 480;

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
      errorHandler.handle(error, {
        code: ErrorCode.WINDOW_CREATE_FAILED,
        context: '窗口创建失败',
      });
      throw error;
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
      // ADR-SP-008：浅色主题为默认，窗口背景色对齐大底板色（--bg: #f0f0f2）
      // 避免启动时闪深色（旧值为深色主题的 #1e1e2e）
      backgroundColor: '#f0f0f2',
      webPreferences: {
        // P1-ROOT 修复：preload 改为 .cjs（CommonJS 格式），兼容 sandbox: true
        // ESM 格式的 preload.js 与 sandbox 不兼容，导致 contextBridge 暴露失败
        preload: path.join(ELECTRON_DIR, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    this.windowStateManager.fullWindow = this.fullWindow;

    // 加载 HTML 文件
    const htmlPath = path.join(ELECTRON_DIR, 'renderer', 'index.html');
    await this.fullWindow.loadFile(htmlPath);

    // 安全防护：拦截外部导航和弹窗（防止 XSS 后跳转到恶意页面获取 IPC 权限）
    // 缓存 fullWindow 引用避免非空断言，并确保回调中引用的是当前窗口实例
    const win = this.fullWindow;
    win.webContents.on('will-navigate', (e, url) => {
      if (url !== win.webContents.getURL()) {
        e.preventDefault();
      }
    });
    win.webContents.setWindowOpenHandler(() => {
      return { action: 'deny' };
    });
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

  /** 关闭所有窗口 */
  closeAll(): void {
    this.floatWindow?.close();
    this.fullWindow?.destroy();
  }
}