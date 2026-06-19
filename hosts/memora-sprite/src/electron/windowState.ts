/**
 * 三态窗口管理器
 *
 * 状态：tray（托盘态）/ float（浮动态）/ full（完整态）
 *
 * 设计要点：
 * - 两个独立的 BrowserWindow（float + full）
 * - 任意时刻只有一个窗口可见
 * - 持久化委托给外部回调（避免与 spriteConfig.ts 重复写文件）
 */

import type { BrowserWindow } from 'electron';

export type WindowState = 'tray' | 'float' | 'full';

/** 窗口状态持久化数据（由外部回调保存到配置文件） */
export interface WindowStateData {
  windowState: WindowState;
  floatPosition: { x: number; y: number };
}

export interface WindowStateOptions {
  defaultState?: WindowState;
  floatPosition?: { x: number; y: number };
  floatSize?: { width: number; height: number };
  fullSize?: { width: number; height: number };
  /** 窗口状态持久化回调（由 main.ts 注入，委托给 saveSpriteConfig） */
  onSaveState?: (data: WindowStateData) => void;
}

const FLOAT_SIZE = { width: 80, height: 80 };
const FULL_SIZE = { width: 420, height: 640 };
/** 首次启动时浮动窗口的默认位置（屏幕左上角偏移） */
export const DEFAULT_FLOAT_POSITION = { x: 100, y: 100 };

export class WindowStateManager {
  private state: WindowState = 'float';
  private floatPosition: { x: number; y: number };
  private floatSize: { width: number; height: number };
  private fullSize: { width: number; height: number };

  // 窗口实例（由外部注入）
  floatWindow: BrowserWindow | null = null;
  fullWindow: BrowserWindow | null = null;

  /** 持久化回调（由 main.ts 注入，委托给 saveSpriteConfig） */
  private onSaveState?: (data: WindowStateData) => void;

  constructor(opts: WindowStateOptions = {}) {
    this.floatPosition = opts.floatPosition ?? DEFAULT_FLOAT_POSITION;
    this.floatSize = opts.floatSize ?? FLOAT_SIZE;
    this.fullSize = opts.fullSize ?? FULL_SIZE;
    this.state = opts.defaultState ?? 'float';
    this.onSaveState = opts.onSaveState;
  }

  /** 状态转换：隐藏当前窗口 → 显示目标窗口 → 持久化 */
  async transition(target: WindowState): Promise<void> {
    if (this.state === target) return;

    // 隐藏当前窗口
    if (this.state === 'float' && this.floatWindow) {
      this.floatWindow.hide();
    }
    if (this.state === 'full' && this.fullWindow) {
      this.fullWindow.hide();
    }

    // 显示目标窗口
    if (target === 'float' && this.floatWindow) {
      this.floatWindow.setPosition(this.floatPosition.x, this.floatPosition.y);
      this.floatWindow.show();
    }
    if (target === 'full' && this.fullWindow) {
      this.fullWindow.show();
      this.fullWindow.focus();
    }

    this.state = target;
    this.persistState();
  }

  /**
   * 显示当前状态对应的窗口（首次启动用）
   *
   * 与 transition 的区别：不隐藏其他窗口（创建后均为 hidden），
   * 仅根据当前 state 显示对应窗口。解决 transition 早返回导致首次启动窗口不显示的问题。
   */
  showInitial(): void {
    if (this.state === 'float' && this.floatWindow) {
      this.floatWindow.setPosition(this.floatPosition.x, this.floatPosition.y);
      this.floatWindow.show();
    }
    if (this.state === 'full' && this.fullWindow) {
      this.fullWindow.show();
      this.fullWindow.focus();
    }
    // tray 态：不显示任何窗口（仅托盘图标）
  }

  /** 持久化当前状态到配置文件（委托外部回调） */
  private persistState(): void {
    this.onSaveState?.({
      windowState: this.state,
      floatPosition: this.floatPosition,
    });
  }

  /** 保存浮动窗口位置 */
  saveFloatPosition(x: number, y: number): void {
    this.floatPosition = { x, y };
    this.persistState();
  }

  getState(): WindowState {
    return this.state;
  }

  getFloatSize() {
    return this.floatSize;
  }

  getFullSize() {
    return this.fullSize;
  }
}