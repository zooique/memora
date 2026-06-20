/**
 * 系统托盘管理
 *
 * 职责：
 * - 托盘图标 + 悬浮提示
 * - 右键菜单（浮动气泡开关 / 显示完整窗口 / 静默模式 / 隐藏到托盘 / 退出）
 * - 三态图标切换（idle/active/sleeping），对齐 HTML 预览 §6.3
 *
 * 三态语义：
 * - idle（默认）：绿色 #a6e3a1，精灵空闲
 * - active：蓝色 #89b4fa + 脉冲动画，精灵正在思考/流式输出
 * - sleeping：黄色 #f9e2af，静默模式
 */

import { Tray, Menu, nativeImage } from 'electron';
import type { NativeImage } from 'electron';

/** 托盘状态类型：对齐浮动窗口状态指示点 */
export type TrayState = 'idle' | 'active' | 'sleeping';

/** 托盘脉冲动画间隔（毫秒）——active 状态下 tooltip 文字循环切换 */
const TRAY_PULSE_INTERVAL_MS = 2000;

export interface TrayCallbacks {
  /** 显示完整窗口 */
  onShowFull: () => void;
  /** 切换浮动气泡显示（参数为切换后的新状态） */
  onToggleFloatBubble?: (checked: boolean) => void;
  /** 查询浮动气泡是否可见（同步返回，用于菜单勾选） */
  isFloatBubbleVisible?: () => boolean;
  /** 隐藏到托盘（当前窗口 → tray 态） */
  onHideToTray: () => void;
  /** 退出应用 */
  onQuit: () => void;
  /** 切换静默模式（参数为切换后的新状态，来自 menuItem.checked） */
  onToggleSilent?: (newSilent: boolean) => void;
  /** 查询当前静默模式状态（同步返回，用于菜单勾选） */
  isSilentMode?: () => boolean;
}

export class TrayManager {
  private tray: Tray;
  /** 当前托盘状态 */
  private state: TrayState = 'idle';
  /** 脉冲动画定时器（active 状态下使用） */
  private pulseTimer: ReturnType<typeof setInterval> | null = null;
  /** 预渲染的三态图标缓存（避免重复创建） */
  private icons: Record<TrayState, NativeImage>;
  /** 回调集合（由 main.ts 注入，支持延迟注入静默模式回调） */
  private callbacks: TrayCallbacks;

  constructor(iconPath: string | NativeImage, callbacks: TrayCallbacks) {
    this.callbacks = callbacks;
    // 预渲染三态图标
    this.icons = {
      idle: this.createStateIcon('idle'),
      active: this.createStateIcon('active'),
      sleeping: this.createStateIcon('sleeping'),
    };

    // 优先使用外部图标，无则用状态图标
    let trayIcon: NativeImage;
    if (typeof iconPath === 'string') {
      trayIcon = iconPath ? nativeImage.createFromPath(iconPath) : this.icons.idle;
    } else {
      trayIcon = iconPath.isEmpty() ? this.icons.idle : iconPath;
    }

    trayIcon = trayIcon.resize({ width: 16, height: 16 });
    this.tray = new Tray(trayIcon);
    this.tray.setToolTip('Memora 精灵');
    this.updateMenu();

    this.tray.on('double-click', () => {
      this.callbacks.onShowFull();
    });
  }

  /**
   * 更新托盘右键菜单
   *
   * 对齐方案：托盘菜单二态设计
   * - 浮动气泡（checkbox 勾选态，点击切换显示/隐藏）
   * - 显示完整窗口
   * - 静默模式（checkbox 勾选态，点击切换）
   * - 隐藏到托盘
   * - 退出
   */
  updateMenu(): void {
    const isSilent = this.callbacks.isSilentMode?.() ?? false;
    const isFloatVisible = this.callbacks.isFloatBubbleVisible?.() ?? true;

    const menuItems: Electron.MenuItemConstructorOptions[] = [
      {
        label: '显示浮动气泡',
        type: 'checkbox',
        checked: isFloatVisible,
        click: (menuItem) => {
          this.callbacks.onToggleFloatBubble?.(menuItem.checked);
        },
      },
      {
        label: '显示完整窗口',
        click: () => this.callbacks.onShowFull(),
      },
      { type: 'separator' },
      {
        label: '静默模式',
        type: 'checkbox',
        checked: isSilent,
        click: (menuItem) => {
          this.callbacks.onToggleSilent?.(menuItem.checked);
        },
      },
      { type: 'separator' },
      {
        label: '隐藏到托盘',
        click: () => this.callbacks.onHideToTray(),
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => this.callbacks.onQuit(),
      },
    ];

    const contextMenu = Menu.buildFromTemplate(menuItems);
    this.tray.setContextMenu(contextMenu);
  }

  /**
   * 更新回调集合（main.ts 在 Agent 初始化后补充注入静默模式相关回调）
   *
   * 场景：TrayManager 在 Agent 初始化前创建，此时 onToggleSilent / isSilentMode 不可用。
   * Agent 就绪后调用此方法补充注入，并重建菜单以反映当前静默状态。
   */
  updateCallbacks(callbacks: Partial<TrayCallbacks>): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
    this.updateMenu(); // 重建菜单以反映静默模式勾选状态
  }

  /**
   * 切换托盘状态
   *
   * 对齐 HTML 预览 §6.3 .float-status-dot：
   * - idle：绿色静态图标
   * - active：蓝色图标 + 脉冲动画（tooltip 闪烁）
   * - sleeping：黄色静态图标
   */
  setState(state: TrayState): void {
    if (this.state === state) return;
    this.state = state;

    // 停止之前的脉冲动画
    this.stopPulse();

    // 更新图标
    this.tray.setImage(this.icons[state].resize({ width: 16, height: 16 }));

    // active 状态启动脉冲
    if (state === 'active') {
      this.startPulse();
    } else {
      // 更新 tooltip
      const tooltips: Record<TrayState, string> = {
        idle: 'Memora 精灵',
        active: 'Memora 精灵（思考中...）',
        sleeping: 'Memora 精灵（静默模式）',
      };
      this.tray.setToolTip(tooltips[state]);
    }
  }

  /** 获取当前状态 */
  getState(): TrayState {
    return this.state;
  }

  /**
   * 开始托盘脉冲动画
   *
   * active 状态下使用，通过 tooltip 闪烁吸引注意力。
   * 注意：Electron 原生不支持托盘图标脉冲，用 tooltip 文字变化代替。
   */
  private startPulse(): void {
    const frames = [
      'Memora 🌀',
      'Memora ✨',
      'Memora 💡',
    ];

    let step = 0;
    this.pulseTimer = setInterval(() => {
      this.tray.setToolTip(frames[step % frames.length] ?? 'Memora');
      step++;
    }, TRAY_PULSE_INTERVAL_MS);
  }

  /** 停止托盘脉冲动画 */
  private stopPulse(): void {
    if (this.pulseTimer) {
      clearInterval(this.pulseTimer);
      this.pulseTimer = null;
    }
  }

  /**
   * 创建状态图标（16x16 纯色方块）
   *
   * 颜色对齐 Catppuccin Mocha + HTML 预览 §6.3：
   * - idle：#a6e3a1（green）
   * - active：#89b4fa（blue）
   * - sleeping：#f9e2af（yellow）
   */
  private createStateIcon(state: TrayState): NativeImage {
    const size = 16;
    const colors: Record<TrayState, [number, number, number]> = {
      idle:     [0xa6, 0xe3, 0xa1],  // green #a6e3a1
      active:   [0x89, 0xb4, 0xfa],  // blue  #89b4fa
      sleeping: [0xf9, 0xe2, 0xaf],  // yellow #f9e2af
    };
    const [r, g, b] = colors[state];

    const buf = Buffer.alloc(size * size * 4);
    for (let i = 0; i < size * size; i++) {
      buf[i * 4 + 0] = r;
      buf[i * 4 + 1] = g;
      buf[i * 4 + 2] = b;
      buf[i * 4 + 3] = 0xff;  // A
    }
    return nativeImage.createFromBuffer(buf, { width: size, height: size });
  }

  destroy(): void {
    this.stopPulse();
    this.tray.destroy();
  }
}
