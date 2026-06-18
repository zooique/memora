/**
 * 浮动窗口管理
 *
 * 80x80 像素悬浮球，单击 → 展开完整窗口，拖动 → 移动位置
 *
 * 拖动实现（方案 §5.4 排雷修正）：
 * - 渲染进程捕获 mousedown/mousemove/mouseup 事件
 * - 通过 IPC 通知主进程移动窗口
 * - 阈值判断（>3px）区分单击与拖动，避免误判
 */

import { BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { WindowStateManager } from './windowState.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class FloatWindow {
  private win!: BrowserWindow;
  /** 当前拖动状态（用于 IPC 处理器判断） */
  private isDragging = false;

  constructor(private windowStateManager: WindowStateManager) {}

  async create(): Promise<BrowserWindow> {
    const size = this.windowStateManager.getFloatSize();

    this.win = new BrowserWindow({
      width: size.width,
      height: size.height,
      frame: false,
      transparent: false,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      backgroundColor: '#1e1e2e',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    this.windowStateManager.floatWindow = this.win;

    // 加载浮动窗口 HTML
    const htmlPath = path.join(__dirname, 'renderer', 'float.html');
    await this.win.loadFile(htmlPath);

    // 关闭时隐藏而非退出
    this.win.on('close', (e) => {
      if (!this.win.isDestroyed()) {
        e.preventDefault();
        this.win.hide();
      }
    });

    // 注册浮动窗口 IPC 处理器
    this.registerFloatIpcHandlers();

    return this.win;
  }

  /** 注册浮动窗口专用 IPC 处理器 */
  private registerFloatIpcHandlers(): void {
    // 渲染进程请求移动窗口（拖动时持续调用）
    ipcMain.on('move-float-window', (_event, dx: number, dy: number) => {
      if (!this.isDragging) return;
      const pos = this.win.getPosition();
      const currentX = pos[0] ?? 0;
      const currentY = pos[1] ?? 0;
      const newX = currentX + dx;
      const newY = currentY + dy;
      this.win.setPosition(newX, newY);
    });

    // 渲染进程通知拖动结束，保存最终位置
    ipcMain.on('save-float-position', () => {
      if (this.isDragging) {
        const pos = this.win.getPosition();
        const x = pos[0] ?? 0;
        const y = pos[1] ?? 0;
        this.windowStateManager.saveFloatPosition(x, y);
        this.isDragging = false;
        this.win.webContents.send('float-drag-end');
      }
    });

    // 渲染进程通知拖动开始
    ipcMain.on('float-drag-begin', () => {
      this.isDragging = true;
      this.win.webContents.send('float-drag-start');
    });

    // 渲染进程请求展开为完整窗口（单击触发）
    ipcMain.on('expand-to-full', () => {
      // 单击只在非拖动时触发（渲染进程已做阈值判断）
      const currentState = this.windowStateManager.getState();
      if (currentState === 'float') {
        this.windowStateManager.transition('full');
      }
    });
  }

  show(): void {
    this.win.show();
  }

  close(): void {
    // 清理 IPC 监听器
    ipcMain.removeAllListeners('move-float-window');
    ipcMain.removeAllListeners('save-float-position');
    ipcMain.removeAllListeners('float-drag-begin');
    ipcMain.removeAllListeners('expand-to-full');
    this.win.destroy();
  }

  /** 更新未读计数气泡 */
  setUnreadCount(count: number): void {
    if (!this.win.isDestroyed()) {
      this.win.webContents.send('float-unread', count);
    }
  }
}
