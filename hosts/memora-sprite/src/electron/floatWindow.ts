/**
 * 浮动窗口管理
 *
 * 80x80 像素悬浮球，单击 → 展开完整窗口，拖动 → 移动位置，右键 → 快速菜单
 *
 * 拖动实现（方案 §5.4 排雷修正）：
 * - 渲染进程捕获 mousedown/mousemove/mouseup 事件
 * - 通过 IPC 通知主进程移动窗口
 * - 阈值判断（>3px）区分单击与拖动，避免误判
 *
 * 右键菜单（方案 §5.4）：
 * - 使用 Electron 主进程原生 Menu（避免渲染进程实现复杂菜单，符合 CSP 安全约束）
 * - 菜单项：展开窗口 / 静默模式 / 隐藏到托盘 / 退出
 * - 角色切换子菜单归档为 P2（完整窗口侧边栏已有入口，浮动右键菜单保持精简）
 */

import { BrowserWindow, ipcMain, Menu } from 'electron';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { WindowStateManager } from './windowState.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 浮动窗口右键菜单回调（由 main.ts 注入，避免 FloatWindow 直接依赖 Sprite/Agent） */
export interface FloatWindowCallbacks {
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
}

export class FloatWindow {
  private win!: BrowserWindow;
  /** 当前拖动状态（用于 IPC 处理器判断） */
  private isDragging = false;
  /** 回调集合（由 main.ts 注入） */
  private callbacks: FloatWindowCallbacks;

  constructor(
    private windowStateManager: WindowStateManager,
    options?: FloatWindowCallbacks,
  ) {
    this.callbacks = options ?? {};
  }

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

    // 安全防护：拦截外部导航和弹窗（防止 XSS 后跳转到恶意页面获取 IPC 权限）
    this.win.webContents.on('will-navigate', (e, url) => {
      if (url !== this.win.webContents.getURL()) {
        e.preventDefault();
      }
    });
    this.win.webContents.setWindowOpenHandler(() => {
      return { action: 'deny' };
    });

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
        // 展开完整窗口时清零未读计数
        this.callbacks.onExpandToFull?.();
      }
    });

    // 渲染进程请求显示右键菜单（右键触发）
    ipcMain.on('float-context-menu', () => {
      this.showContextMenu();
    });
  }

  /**
   * 构建并显示浮动窗口右键菜单
   *
   * 对齐方案 §5.4 右键菜单设计：
   * - 展开窗口（切换到完整态）
   * - 静默模式（勾选态反映当前配置，点击切换）
   * - 隐藏到托盘（切换到托盘态）
   * - 退出（关闭应用）
   *
   * 使用 Electron 原生 Menu，避免在 80x80 浮动窗口内渲染 HTML 菜单（空间不足）
   */
  private showContextMenu(): void {
    if (this.win.isDestroyed()) return;

    const isSilent = this.callbacks.isSilentMode?.() ?? false;

    const menu = Menu.buildFromTemplate([
      {
        label: '展开窗口',
        click: () => {
          this.windowStateManager.transition('full');
          this.callbacks.onExpandToFull?.();
        },
      },
      { type: 'separator' },
      {
        label: '静默模式',
        type: 'checkbox',
        checked: isSilent,
        click: (menuItem) => {
          // menuItem.checked 已反映切换后的新状态
          this.callbacks.onToggleSilent?.(menuItem.checked);
        },
      },
      { type: 'separator' },
      {
        label: '隐藏到托盘',
        click: () => {
          this.callbacks.onHideToTray?.();
        },
      },
      {
        label: '退出',
        click: () => {
          this.callbacks.onQuit?.();
        },
      },
    ]);

    // 在浮动窗口位置弹出菜单（popup 会自动定位）
    menu.popup({ window: this.win });
  }

  show(): void {
    this.win.show();
  }

  /**
   * 更新回调集合（main.ts 在 Agent 初始化后补充注入静默模式相关回调）
   *
   * 场景：FloatWindow 在 Agent 初始化前创建，此时 onExpandToFull 已注入，
   * 但 onToggleSilent / isSilentMode 需要 Agent 就绪后才能补充。
   */
  updateCallbacks(callbacks: FloatWindowCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  close(): void {
    // 清理 IPC 监听器
    ipcMain.removeAllListeners('move-float-window');
    ipcMain.removeAllListeners('save-float-position');
    ipcMain.removeAllListeners('float-drag-begin');
    ipcMain.removeAllListeners('expand-to-full');
    ipcMain.removeAllListeners('float-context-menu');
    this.win.destroy();
  }

  /** 更新未读计数气泡 */
  setUnreadCount(count: number): void {
    if (!this.win.isDestroyed()) {
      this.win.webContents.send('float-unread', count);
    }
  }
}
