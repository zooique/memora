/**
 * 浮动窗口管理
 *
 * 56x56 像素悬浮球（球体本体 48x48），单击 → 展开完整窗口，拖动 → 移动位置，右键 → 快速菜单
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
import { applyWindowSecurity } from './windowSecurity.js';
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
  /**
   * 浮球单击 → 呼出补全弹窗（STEP-4 交互重构）
   *
   * 携带浮球位置（x, y）和浮球窗口的 Win32 HWND，
   * 供 quickInputWindow.showAtPosition() 定位弹窗并排除浮球自身。
   */
  onShowQuickInput?: (x: number, y: number, floatHwnd: number) => void;
}

export class FloatWindow {
  /**
   * BrowserWindow 实例
   *
   * nullable：create() 前为 null，close() 后置 null。
   * 类型显式 nullable 后，所有访问点必须先做 null 守卫，
   * 防止 create() 前或 close() 后调用方法抛错。
   */
  private win: BrowserWindow | null = null;
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

    const win = new BrowserWindow({
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
        // preload 使用 preloadFloat.cjs（12 API 最小化暴露面，ADR-SP-017 §何时回顾触发）
        // 主 preload.cjs 暴露 266 API，浮动窗口仅需 12 API，独立化剥离高危 API（deleteMemory/installSkill 等）
        preload: path.join(ELECTRON_DIR, 'preloadFloat.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.win = win;

    this.windowStateManager.attachFloatWindow(win);

    // 主进程注入主题初始化脚本（替代内联 <script>，不受 CSP 约束）
    injectThemeScript(win.webContents);

    // 加载浮动窗口 HTML
    const htmlPath = path.join(ELECTRON_DIR, 'renderer', 'float', 'float.html');
    await win.loadFile(htmlPath);

    // 安全防护：拦截外部导航和弹窗（applyWindowSecurity 集中维护，ADR-017 枝叶层 2 次提取）
    applyWindowSecurity(win);

    // 关闭时隐藏而非退出（使用 win 局部变量，避免 TS 在闭包中无法收窄 this.win）
    win.on('close', (e) => {
      if (!win.isDestroyed()) {
        e.preventDefault();
        win.hide();
      }
    });

    // 注册浮动窗口 IPC 处理器
    this.registerFloatIpcHandlers();

    return win;
  }

  /** 注册浮动窗口专用 IPC 处理器 */
  private registerFloatIpcHandlers(): void {
    // 渲染进程请求移动窗口（拖动时持续调用），渲染进程完全控制拖动逻辑
    ipcMain.on(IPC_CHANNELS.MOVE_FLOAT_WINDOW, (_event, dx: number, dy: number) => {
      if (!this.win || this.win.isDestroyed()) return;
      const [currentX, currentY] = this.win.getPosition() as [number, number];
      const newX = currentX + dx;
      const newY = currentY + dy;
      this.win.setPosition(newX, newY);
    });

    // 渲染进程通知拖动结束，保存最终位置
    ipcMain.on(IPC_CHANNELS.SAVE_FLOAT_POSITION, () => {
      if (!this.win || this.win.isDestroyed()) return;
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

    // 浮球单击 → 呼出补全弹窗（STEP-4 交互重构，替代 EXPAND_TO_FULL 的单击行为）
    // 获取浮球位置 + HWND，通过回调传递给 quickInputWindow.showAtPosition()
    ipcMain.on(IPC_CHANNELS.SHOW_QUICK_INPUT_FROM_FLOAT, () => {
      if (!this.win || this.win.isDestroyed()) return;
      const [x, y] = this.win.getPosition() as [number, number];
      const size = this.windowStateManager.getFloatSize();
      // 弹窗锚点：浮球正下方偏移 CURSOR_OFFSET_PX（16px）
      const popupY = y + size.height + 16;
      // 提取浮球 HWND 用于排除浮球自身（浮球单击后成为前台窗口）
      const floatHwnd = Number(this.win.getNativeWindowHandle().readBigUInt64LE(0));
      this.callbacks.onShowQuickInput?.(x, popupY, floatHwnd);
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
   * 使用 Electron 原生 Menu，避免在 56x56 浮动窗口内渲染 HTML 菜单（空间不足）
   */
  private showContextMenu(): void {
    const win = this.win;
    if (!win || win.isDestroyed()) return;

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
    menu.popup({ window: win });
  }

  show(): void {
    // null 守卫 + isDestroyed 守卫，防止 create() 前或 close() 后调用抛错
    if (this.win && !this.win.isDestroyed()) {
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
    ipcMain.removeAllListeners(IPC_CHANNELS.SHOW_QUICK_INPUT_FROM_FLOAT);
    if (this.win && !this.win.isDestroyed()) {
      this.win.destroy();
    }
    // 显式切断引用，允许 GC 回收 BrowserWindow，避免定时器残留触发已销毁窗口方法
    this.win = null;
  }

  /** 更新未读计数气泡 */
  setUnreadCount(count: number): void {
    // 复用 send() 方法，集中守卫逻辑（ADR-017 枝叶层 2 次提取：4 处 isDestroyed+send 模式）
    this.send(MAIN_TO_RENDERER_CHANNELS.FLOAT_UNREAD, count);
  }

  /**
   * 向浮动窗口发送 IPC 消息（P4-1：消息预览 + 通用扩展点）
   *
   * 封装 webContents.send，带 null + 销毁双重防护。
   * 供 chatStreamHandler 等主进程模块向浮动窗口推送数据，
   * 也是 setUnreadCount / broadcastTheme / broadcastPresence / broadcastProactivePrompt 的共同守卫入口。
   */
  send(channel: string, ...args: unknown[]): void {
    if (this.win && !this.win.isDestroyed()) {
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
    // 复用 send() 方法，集中守卫逻辑
    this.send(MAIN_TO_RENDERER_CHANNELS.THEME_BROADCAST, theme);
  }

  /**
   * 广播在场状态变化到浮动窗口
   *
   * 完整窗口通过 SPRITE_EVENT 通道接收 presenceChanged 事件并更新感知面板；
   * 浮动窗口需同步在场状态以更新迷你球体视觉。
   *
   * 本方法复用 SPRITE_EVENT 通道（与完整窗口同通道），浮动窗口的 onSpriteEvent
   * 监听器按 type 分发即可，无需新增专用 IPC 通道常量。
   *
   * @param state 'present' 用户在场 / 'away' 用户离开
   * @param awayDurationMs 离开时长（毫秒），仅 state='away' 时有意义
   */
  broadcastPresence(state: 'present' | 'away', awayDurationMs?: number): void {
    // 复用 send() 方法，集中守卫逻辑；复用 SPRITE_EVENT 通道，payload 与完整窗口接收的一致
    this.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_EVENT, {
      type: 'presenceChanged',
      payload: { state, awayDurationMs },
      silent: true, // 在场状态变化不弹通知，仅视觉反馈
    });
  }

  /**
   * 广播主动提示到浮动窗口
   *
   * 主动提示触发时，完整窗口可见则展示 banner，不可见则累积未读徽章。
   * 浮动窗口需同步接收 proactivePrompt 事件以触发球体 bounce 动画 + 状态点切换，
   * 否则完整窗口隐藏时球体无视觉反馈，违反"主动可见"原则。
   *
   * 复用 SPRITE_EVENT 通道（与 broadcastPresence 同模式），浮动窗口的 onSpriteEvent
   * 监听器已注册 proactivePrompt 分支（float.ts），无需新增 IPC 通道或修改渲染层。
   *
   * @param prompt 提示文本
   * @param isMilestone 是否为里程碑事件
   */
  broadcastProactivePrompt(prompt: string, isMilestone: boolean): void {
    // 复用 send() 方法，集中守卫逻辑；复用 SPRITE_EVENT 通道，payload 与完整窗口接收的一致
    this.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_EVENT, {
      type: 'proactivePrompt',
      payload: { prompt, isMilestone, lightweight: false },
      silent: false,
    });
  }
}
