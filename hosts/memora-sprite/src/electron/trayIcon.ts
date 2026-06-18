/**
 * 系统托盘管理
 *
 * 职责：
 * - 托盘图标 + 悬浮提示
 * - 右键菜单（显示浮动图标 / 显示完整窗口 / 隐藏到托盘 / 退出）
 * - 托盘脉冲动画（Electron 原生不支持原生脉冲，用闪烁代替）
 */

import { Tray, Menu, nativeImage } from 'electron';
import type { NativeImage } from 'electron';

export interface TrayCallbacks {
  onShowFloat: () => void;
  onShowFull: () => void;
  onHideToTray: () => void;
  onQuit: () => void;
}

export class TrayManager {
  private tray: Tray;
  private isPulsing = false;
  private pulseTimer: ReturnType<typeof setInterval> | null = null;

  constructor(iconPath: string | NativeImage, private callbacks: TrayCallbacks) {
    let trayIcon: NativeImage;

    if (typeof iconPath === 'string') {
      trayIcon = iconPath ? nativeImage.createFromPath(iconPath) : this.createPlaceholderIcon();
    } else {
      trayIcon = iconPath.isEmpty() ? this.createPlaceholderIcon() : iconPath;
    }

    trayIcon = trayIcon.resize({ width: 16, height: 16 });
    this.tray = new Tray(trayIcon);
    this.tray.setToolTip('Memora 精灵');
    this.updateMenu();

    this.tray.on('double-click', () => {
      this.callbacks.onShowFull();
    });
  }

  private updateMenu(): void {
    const contextMenu = Menu.buildFromTemplate([
      {
        label: '显示浮动图标',
        click: () => this.callbacks.onShowFloat(),
      },
      {
        label: '显示完整窗口',
        click: () => this.callbacks.onShowFull(),
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
    ]);
    this.tray.setContextMenu(contextMenu);
  }

  /** 
   * 开始托盘脉冲动画
   * 
   * 用于主动提示时吸引用户注意力
   * 注意：此方法为迭代3预留，目前未被调用
   */
  startPulse(): void {
    if (this.isPulsing) return;
    this.isPulsing = true;

    let step = 0;
    const frames = [
      'Memora 🌀',
      'Memora ✨',
      'Memora 💡',
    ];

    this.pulseTimer = setInterval(() => {
      this.tray.setToolTip(frames[step % frames.length] ?? 'Memora');
      step++;
    }, 2000);
  }

  /** 
   * 停止托盘脉冲动画
   * 
   * 注意：此方法为迭代3预留，目前仅在destroy中调用
   */
  stopPulse(): void {
    if (this.pulseTimer) {
      clearInterval(this.pulseTimer);
      this.pulseTimer = null;
    }
    this.isPulsing = false;
    this.tray.setToolTip('Memora 精灵');
  }

  /** 创建占位图标（16x16 像素绿色方块） */
  private createPlaceholderIcon(): NativeImage {
    const size = 16;
    const buf = Buffer.alloc(size * size * 4);
    for (let i = 0; i < size * size; i++) {
      buf[i * 4 + 0] = 0x1e;     // R
      buf[i * 4 + 1] = 0x8b;     // G (Catppuccin green)
      buf[i * 4 + 2] = 0x96;     // B
      buf[i * 4 + 3] = 0xff;     // A
    }
    return nativeImage.createFromBuffer(buf, { width: size, height: size });
  }

  destroy(): void {
    this.stopPulse();
    this.tray.destroy();
  }
}
