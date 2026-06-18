/**
 * 三态窗口管理器
 *
 * 状态：tray（托盘态）/ float（浮动态）/ full（完整态）
 *
 * 设计要点：
 * - 两个独立的 BrowserWindow（float + full）
 * - 任意时刻只有一个窗口可见
 * - 状态变更写入 sprite.json 持久化（与精灵配置同文件）
 */

import type { BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { errorHandler, ErrorCode } from './errorHandler.js';

export type WindowState = 'tray' | 'float' | 'full';

export interface WindowStateOptions {
  defaultState?: WindowState;
  floatPosition?: { x: number; y: number };
  floatSize?: { width: number; height: number };
  fullSize?: { width: number; height: number };
  /** sprite.json 完整路径（用于持久化窗口状态） */
  configPath?: string;
}

const FLOAT_SIZE = { width: 80, height: 80 };
const FULL_SIZE = { width: 420, height: 640 };

export class WindowStateManager {
  private state: WindowState = 'float';
  private floatPosition: { x: number; y: number };
  private floatSize: { width: number; height: number };
  private fullSize: { width: number; height: number };

  // 窗口实例（由外部注入）
  floatWindow: BrowserWindow | null = null;
  fullWindow: BrowserWindow | null = null;

  private configPath: string;

  constructor(opts: WindowStateOptions = {}) {
    this.floatPosition = opts.floatPosition ?? { x: 100, y: 100 };
    this.floatSize = opts.floatSize ?? FLOAT_SIZE;
    this.fullSize = opts.fullSize ?? FULL_SIZE;
    this.state = opts.defaultState ?? 'float';
    this.configPath = opts.configPath ?? path.join(process.cwd(), 'sprite.json');
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
    this.saveState();
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

  /** 保存状态到配置文件 */
  private saveState(): void {
    try {
      let config: Record<string, unknown> = {};
      if (fs.existsSync(this.configPath)) {
        config = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
      }
      config.windowState = this.state;
      config.floatIconPosition = this.floatPosition;
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf-8');
    } catch (error) {
      // 记录错误但不中断应用运行
      errorHandler.handle(error, {
        code: ErrorCode.FILE_WRITE_FAILED,
        context: '保存窗口状态失败'
      });
    }
  }

  /** 保存浮动窗口位置 */
  saveFloatPosition(x: number, y: number): void {
    this.floatPosition = { x, y };
    this.saveState();
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
