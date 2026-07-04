/**
 * 二态窗口状态管理器
 *
 * 状态：tray（托盘态）/ full（完整态）
 * 浮动气泡：独立偏好 showFloatBubble，不在状态机内
 *
 * 设计要点：
 * - 两个独立的 BrowserWindow（float + full）
 * - 任意时刻最多一个窗口可见（float 仅在 tray 态 + showFloatBubble 时显示）
 * - 持久化委托给外部回调（避免与 spriteConfig.ts 重复写文件）
 *
 * 过渡规则：
 *   tray → full:  托盘菜单 / 双击浮动气泡
 *   full → tray:  关闭完整窗口（X 按钮）/ 最小化
 *   float 可见:   当 state === 'tray' && showFloatBubble === true 时
 *   float 隐藏:   当 showFloatBubble === false 时
 */

import type { BrowserWindow } from 'electron';

/** 窗口状态（仅二态，float 已独立为偏好） */
export type WindowState = 'tray' | 'full';

/** 窗口状态持久化数据（由外部回调保存到配置文件） */
export interface WindowStateData {
  windowState: WindowState;
  floatPosition: { x: number; y: number };
  /** 浮动气泡显示偏好 */
  showFloatBubble: boolean;
}

export interface WindowStateOptions {
  defaultState?: WindowState;
  floatPosition?: { x: number; y: number };
  floatSize?: { width: number; height: number };
  fullSize?: { width: number; height: number };
  /** 浮动气泡显示偏好（从配置读取），默认 true */
  showFloatBubble?: boolean;
  /** 窗口状态持久化回调（由 main.ts 注入，委托给 saveSpriteConfig） */
  onSaveState?: (data: WindowStateData) => void;
}

/** 浮动窗口尺寸（80x80 悬浮球） */
export const FLOAT_SIZE = { width: 80, height: 80 };
/** 完整窗口默认尺寸：900x680 确保侧边栏（240px）+ 主内容区有足够空间 */
export const FULL_SIZE = { width: 900, height: 680 };
/** 首次启动时浮动窗口的默认位置（屏幕左上角偏移） */
export const DEFAULT_FLOAT_POSITION = { x: 100, y: 100 };

export class WindowStateManager {
  private state: WindowState = 'tray';
  private floatPosition: { x: number; y: number };
  private floatSize: { width: number; height: number };
  private fullSize: { width: number; height: number };
  /** 浮动气泡显示偏好（独立于状态机） */
  private showFloatBubble: boolean;

  /** 窗口实例（由外部注入，通过 attach 方法设置） */
  private floatWindow: BrowserWindow | null = null;
  private fullWindow: BrowserWindow | null = null;

  /** 持久化回调（由 main.ts 注入，委托给 saveSpriteConfig） */
  private onSaveState?: (data: WindowStateData) => void;

  constructor(opts: WindowStateOptions = {}) {
    this.floatPosition = opts.floatPosition ?? DEFAULT_FLOAT_POSITION;
    this.floatSize = opts.floatSize ?? FLOAT_SIZE;
    this.fullSize = opts.fullSize ?? FULL_SIZE;
    this.state = opts.defaultState ?? 'tray';
    this.showFloatBubble = opts.showFloatBubble ?? true;
    this.onSaveState = opts.onSaveState;
  }

  // ─── 状态转换 ──────────────────────────────────────────────

  /**
   * 状态转换：tray ↔ full
   *
   * 仅管理二态切换。float 的显示/隐藏由 setShowFloatBubble 控制。
   *
   * 同步方法：内部 hideCurrentWindow/showTargetWindow/persistState 均为同步操作
   * （BrowserWindow.show/hide 是同步的，持久化回调也是同步的），调用方无需 await。
   */
  transition(target: WindowState): void {
    if (this.state === target) return;

    // 隐藏当前窗口
    this.hideCurrentWindow();

    // 显示目标窗口
    this.state = target;
    this.showTargetWindow();
    this.persistState();
  }

  /**
   * 显示当前状态对应的窗口（首次启动用）
   *
   * 与 transition 的区别：不隐藏其他窗口（创建后均为 hidden），
   * 仅根据当前 state 和 showFloatBubble 显示对应窗口。
   *
   * 添加 isDestroyed 守卫，对齐 transition 的 showTargetWindow 守卫模式。
   */
  showInitial(): void {
    if (this.state === 'full' && this.fullWindow && !this.fullWindow.isDestroyed()) {
      this.fullWindow.show();
      this.fullWindow.focus();
    } else if (this.state === 'tray' && this.showFloatBubble && this.floatWindow && !this.floatWindow.isDestroyed()) {
      // tray 态 + 浮动气泡可见 → 显示浮动气泡
      this.floatWindow.setPosition(this.floatPosition.x, this.floatPosition.y);
      this.floatWindow.show();
    }
    // tray 态 + 浮动气泡隐藏 → 不显示任何窗口（仅托盘图标）
  }

  // ─── 浮动气泡偏好 ──────────────────────────────────────────

  /** 查询浮动气泡是否可见 */
  getShowFloatBubble(): boolean {
    return this.showFloatBubble;
  }

  /**
   * 设置浮动气泡显示偏好
   *
   * 立即生效：如果当前是 tray 态，根据新值显示/隐藏浮动气泡。
   */
  setShowFloatBubble(value: boolean): void {
    if (this.showFloatBubble === value) return;
    this.showFloatBubble = value;

    if (this.state === 'tray' && this.floatWindow && !this.floatWindow.isDestroyed()) {
      if (value) {
        this.floatWindow.setPosition(this.floatPosition.x, this.floatPosition.y);
        this.floatWindow.show();
      } else {
        this.floatWindow.hide();
      }
    }
    // full 态时浮动气泡始终隐藏，切换偏好不影响当前显示

    this.persistState();
  }

  // ─── 内部方法 ──────────────────────────────────────────────

  /** 隐藏当前状态对应的窗口 */
  private hideCurrentWindow(): void {
    if (this.state === 'tray' && this.floatWindow && !this.floatWindow.isDestroyed()) {
      this.floatWindow.hide();
    }
    if (this.state === 'full' && this.fullWindow && !this.fullWindow.isDestroyed()) {
      this.fullWindow.hide();
    }
  }

  /** 显示目标状态对应的窗口 */
  private showTargetWindow(): void {
    if (this.state === 'full' && this.fullWindow && !this.fullWindow.isDestroyed()) {
      this.fullWindow.show();
      this.fullWindow.focus();
    } else if (this.state === 'tray' && this.showFloatBubble && this.floatWindow && !this.floatWindow.isDestroyed()) {
      // tray 态 + 浮动气泡可见 → 显示浮动气泡
      this.floatWindow.setPosition(this.floatPosition.x, this.floatPosition.y);
      this.floatWindow.show();
    }
    // tray 态 + 浮动气泡隐藏 → 不显示任何窗口
  }

  /** 持久化当前状态到配置文件（委托外部回调） */
  private persistState(): void {
    this.onSaveState?.({
      windowState: this.state,
      floatPosition: this.floatPosition,
      showFloatBubble: this.showFloatBubble,
    });
  }

  // ─── 公共访问器 ────────────────────────────────────────────

  /** 注入浮动窗口实例（由 FloatWindow 创建后调用） */
  attachFloatWindow(window: BrowserWindow): void {
    this.floatWindow = window;
  }

  /** 注入完整窗口实例（由 WindowManager 创建后调用） */
  attachFullWindow(window: BrowserWindow): void {
    this.fullWindow = window;
  }

  /** 保存浮动窗口位置 */
  saveFloatPosition(x: number, y: number): void {
    this.floatPosition = { x, y };
    this.persistState();
  }

  getState(): WindowState {
    return this.state;
  }

  /** 获取浮动窗口尺寸（显式返回类型注解） */
  getFloatSize(): { width: number; height: number } {
    return this.floatSize;
  }

  /** 获取完整窗口尺寸（显式返回类型注解） */
  getFullSize(): { width: number; height: number } {
    return this.fullSize;
  }
}