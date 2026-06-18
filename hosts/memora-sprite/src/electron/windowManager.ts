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

import { BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { WindowStateManager } from './windowState.js';
import { FloatWindow } from './floatWindow.js';
import { errorHandler, ErrorCode } from './errorHandler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── 窗口管理器类 ─────────────────────────────────────────

export class WindowManager {
  private windowStateManager: WindowStateManager;
  private floatWindow: FloatWindow | null = null;
  private fullWindow: BrowserWindow | null = null;

  constructor(windowStateManager: WindowStateManager) {
    this.windowStateManager = windowStateManager;
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
        context: '窗口创建失败'
      });
      throw error;
    }
  }

  /** 创建浮动窗口 */
  private async createFloatWindow(): Promise<void> {
    this.floatWindow = new FloatWindow(this.windowStateManager);
    await this.floatWindow.create();
  }

  /** 创建完整窗口 */
  private async createFullWindow(): Promise<void> {
    const fullSize = this.windowStateManager.getFullSize();
    
    this.fullWindow = new BrowserWindow({
      width: fullSize.width,
      height: fullSize.height,
      minWidth: 320,
      minHeight: 480,
      frame: false,
      show: false,
      backgroundColor: '#1e1e2e',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    this.windowStateManager.fullWindow = this.fullWindow;

    // 加载 HTML 文件
    const htmlPath = path.join(__dirname, 'renderer', 'index.html');
    await this.fullWindow.loadFile(htmlPath);
  }

  /** 注册窗口控制 IPC */
  private registerWindowControls(): void {
    ipcMain.on('window-minimize', () => {
      this.fullWindow?.minimize();
    });

    ipcMain.on('window-maximize', () => {
      if (this.fullWindow?.isMaximized()) {
        this.fullWindow.unmaximize();
      } else {
        this.fullWindow?.maximize();
      }
    });

    ipcMain.on('window-close', () => {
      this.windowStateManager.transition('float');
    });

    ipcMain.on('window-float', () => {
      this.windowStateManager.transition('float');
    });
  }

  /** 设置窗口事件处理器 */
  private setupWindowEvents(): void {
    if (!this.fullWindow) return;

    this.fullWindow.on('close', (e) => {
      if (!this.fullWindow!.isDestroyed()) {
        e.preventDefault();
        this.windowStateManager.transition('float');
      }
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