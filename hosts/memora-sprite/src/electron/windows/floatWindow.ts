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

import * as path from 'node:path';
import { BrowserWindow, ipcMain, Menu } from 'electron';
import type { WindowStateManager } from './windowState.js';
import { injectThemeScript } from './themeInjector.js';
import { IPC_CHANNELS, MAIN_TO_RENDERER_CHANNELS } from '../ipc/channels.js';
import { ELECTRON_DIR } from '../esmShim.js';

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
  /** 回调集合（由 main.ts 注入） */
  private callbacks: FloatWindowCallbacks;
  /** 窗口状态管理器（查询浮动窗口尺寸/位置） */
  private windowStateManager: WindowStateManager;

  constructor(
    windowStateManager: WindowStateManager,
    options?: FloatWindowCallbacks,
  ) {
    this.windowStateManager = windowStateManager;
    this.callbacks = options ?? {};
  }

  async create(): Promise<BrowserWindow> {
    const size = this.windowStateManager.getFloatSize();

    this.win = new BrowserWindow({
      width: size.width,
      height: size.height,
      frame: false,
      // 透明窗口：让 badge 和 drag-hint 不被 opaque 背景裁剪
      transparent: true,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      webPreferences: {
        // preload 使用 .cjs（CommonJS 格式），兼容 sandbox: true；ESM 格式与 sandbox 不兼容
        preload: path.join(ELECTRON_DIR, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    this.windowStateManager.attachFloatWindow(this.win);

    // 主进程注入主题初始化脚本（替代内联 <script>，不受 CSP 约束）
    injectThemeScript(this.win.webContents);

    // 加载浮动窗口 HTML
    const htmlPath = path.join(ELECTRON_DIR, 'renderer', 'float', 'float.html');
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
    // 移除 isDragging 守卫：渲染进程完全控制拖动逻辑，避免 IPC 异步时序问题
    ipcMain.on(IPC_CHANNELS.MOVE_FLOAT_WINDOW, (_event, dx: number, dy: number) => {
      const [currentX, currentY] = this.win.getPosition() as [number, number];
      const newX = currentX + dx;
      const newY = currentY + dy;
      this.win.setPosition(newX, newY);
    });

    // 渲染进程通知拖动结束，保存最终位置
    ipcMain.on(IPC_CHANNELS.SAVE_FLOAT_POSITION, () => {
      const [x, y] = this.win.getPosition() as [number, number];
      this.windowStateManager.saveFloatPosition(x, y);
    });

    // 渲染进程请求展开为完整窗口（单击触发）
    ipcMain.on(IPC_CHANNELS.EXPAND_TO_FULL, () => {
      // 单击只在非拖动时触发（渲染进程已做阈值判断）
      const currentState = this.windowStateManager.getState();
      // 浮动气泡仅在 tray 态显示，展开到 full
      if (currentState === 'tray') {
        this.windowStateManager.transition('full');
        // 展开完整窗口时清零未读计数
        this.callbacks.onExpandToFull?.();
      }
    });

    // 渲染进程请求显示右键菜单（右键触发）
    ipcMain.on(IPC_CHANNELS.FLOAT_CONTEXT_MENU, () => {
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
    // 添加 isDestroyed 守卫，防止 create() 前或销毁后调用抛错
    // 对齐 setUnreadCount/broadcastTheme 的守卫模式
    if (!this.win.isDestroyed()) {
      this.win.show();
    }
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
    ipcMain.removeAllListeners(IPC_CHANNELS.MOVE_FLOAT_WINDOW);
    ipcMain.removeAllListeners(IPC_CHANNELS.SAVE_FLOAT_POSITION);
    ipcMain.removeAllListeners(IPC_CHANNELS.EXPAND_TO_FULL);
    ipcMain.removeAllListeners(IPC_CHANNELS.FLOAT_CONTEXT_MENU);
    this.win.destroy();
  }

  /** 更新未读计数气泡 */
  setUnreadCount(count: number): void {
    if (!this.win.isDestroyed()) {
      this.win.webContents.send(MAIN_TO_RENDERER_CHANNELS.FLOAT_UNREAD, count);
    }
  }

  /**
   * 向浮动窗口发送 IPC 消息（P4-1：消息预览 + 通用扩展点）
   *
   * 封装 webContents.send，带窗口销毁防护。
   * 供 chatStreamHandler 等主进程模块向浮动窗口推送数据。
   */
  send(channel: string, ...args: unknown[]): void {
    if (!this.win.isDestroyed()) {
      this.win.webContents.send(channel, ...args);
    }
  }

  /**
   * 广播主题变更到浮动窗口
   *
   * 完整窗口切换主题时，主进程通过此方法将主题同步到浮动窗口，
   * 避免两个窗口主题不一致。
   */
  broadcastTheme(theme: 'light' | 'dark'): void {
    if (!this.win.isDestroyed()) {
      this.win.webContents.send(MAIN_TO_RENDERER_CHANNELS.THEME_BROADCAST, theme);
    }
  }

  /**
   * 广播在场状态变化到浮动窗口
   *
   * 完整窗口通过 SPRITE_EVENT 通道接收 presenceChanged 事件并更新感知面板；
   * 浮动窗口此前无视觉反馈（80x80 迷你球体在用户离开时无变化）。
   *
   * 本方法复用 SPRITE_EVENT 通道（与完整窗口同通道），浮动窗口的 onSpriteEvent
   * 监听器按 type 分发即可，无需新增专用 IPC 通道常量。
   *
   * @param state 'present' 用户在场 / 'away' 用户离开
   * @param awayDurationMs 离开时长（毫秒），仅 state='away' 时有意义
   */
  broadcastPresence(state: 'present' | 'away', awayDurationMs?: number): void {
    if (this.win.isDestroyed()) return;
    // 复用 SPRITE_EVENT 通道，payload 结构与完整窗口接收的一致
    this.win.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_EVENT, {
      type: 'presenceChanged',
      payload: { state, awayDurationMs },
      silent: true, // 在场状态变化不弹通知，仅视觉反馈
    });
  }
}
