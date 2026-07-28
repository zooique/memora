/**
 * 窗口控制 Controller —— 管理最小化/最大化/关闭按钮 + 最大化图标切换
 *
 * HEAL-12 从 PanelRouter 拆分（模式 B 职责拆分）。原 PanelRouter 6 职责过载，
 * 窗口控制与面板切换/快捷键/AUX 侧栏正交，独立为 Controller。
 *
 * 职责：
 * - 绑定 btn-minimize / btn-maximize / btn-close 点击事件
 * - 监听 window.electronAPI.onWindowStateChanged 同步最大化图标
 * - handleClose 包含设置面板未保存修改检查（与 PanelRouter.switchPanel 行为一致）
 *
 * 设计原则：
 * - 通过 WindowControlsHost 接口与 UIManager 解耦
 * - 持有独立 EventTracker，cleanup 时统一清理
 * - 与 PanelRouter / AuxSidebarManager / GlobalShortcutDispatcher 同层并列
 */

import { EventTracker } from '../helpers/eventTracker.js';
import { getOptionalElement } from '../helpers/domHelpers.js';
import { reportError } from '../helpers/errorHelpers.js';
import { setIcon } from '../helpers/icon.js';
import type { UIState, ConfirmDialogOptions } from '../types.js';

// ─── WindowControlsController 宿主接口 ─────────────────

/** WindowControlsController 所需的宿主能力（UIManager 实现此接口） */
export interface WindowControlsHost {
  /** 获取当前 UI 状态（用于 handleClose 检查 settings 面板） */
  getState(): UIState;
  /** 获取最大化按钮元素（可能为 null，部分布局无标题栏） */
  getBtnMaximize(): HTMLButtonElement | null;
  /** 检查设置面板是否有未保存修改 */
  isSettingsDirty(): boolean;
  /** 重置设置面板 dirty 标志 */
  resetSettingsFormDirty(): void;
  /** 显示确认对话框（关闭窗口时检查未保存修改） */
  showConfirmDialog(options: ConfirmDialogOptions): Promise<boolean>;
}

// ─── WindowControlsController 类 ───────────────────────

export class WindowControlsController {
  /** 事件监听器跟踪器（独立于 UIManager 的 EventTracker） */
  private events = new EventTracker();

  constructor(private host: WindowControlsHost) {}

  // ─── 初始化 ────────────────────────────────────────

  /**
   * 初始化窗口控制按钮事件监听器
   *
   * 绑定：btn-minimize / btn-maximize / btn-close click + onWindowStateChanged。
   * 在 UIManager 构造函数末尾调用（与 PanelRouter.init 同阶段）。
   */
  init(): void {
    // 标题栏按钮（可选，部分布局可能不提供）
    const btnMinimize = getOptionalElement('btn-minimize', 'button');
    const btnClose = getOptionalElement('btn-close', 'button');
    if (btnMinimize) {
      this.events.addEventListener(btnMinimize, 'click', this.handleMinimize.bind(this));
    }
    const btnMaximize = this.host.getBtnMaximize();
    if (btnMaximize) {
      this.events.addEventListener(btnMaximize, 'click', this.handleMaximize.bind(this));
    }
    if (btnClose) {
      this.events.addEventListener(btnClose, 'click', this.handleClose.bind(this));
    }

    // 窗口状态变更监听（最大化按钮图标切换）
    window.electronAPI.onWindowStateChanged((msg: { maximized: boolean }) => {
      this.updateMaximizeButton(msg.maximized);
    });
  }

  // ─── 清理 ──────────────────────────────────────────

  /** 清理所有事件监听器 */
  cleanup(): void {
    this.events.cleanup();
  }

  // ─── 窗口控制 ──────────────────────────────────────

  /** 最小化窗口 */
  private handleMinimize(): void {
    window.electronAPI.windowMinimize();
  }

  /** 最大化/还原窗口 */
  private handleMaximize(): void {
    window.electronAPI.windowMaximize();
  }

  /**
   * 关闭完整窗口（隐藏到托盘态）
   *
   * 行为分支：取决于 showFloatBubble 偏好（由 windowStateManager 控制）：
   *   - showFloatBubble=true → 浮动气泡显示
   *   - showFloatBubble=false → 仅托盘态（用户从托盘菜单恢复）
   *
   * 关闭前检查设置面板是否有未保存修改，与 PanelRouter.switchPanel 行为一致：
   * 有未保存修改时弹确认对话框，用户取消则中止关闭。
   */
  private async handleClose(): Promise<void> {
    try {
      const state = this.host.getState();

      // 当前在设置面板且有未保存修改时，确认后再关闭
      if (state.currentPanel === 'settings' && this.host.isSettingsDirty()) {
        const confirmed = await this.host.showConfirmDialog({
          title: '关闭窗口',
          message: '有未保存的修改，关闭后将丢失。确定要关闭吗？',
          confirmText: '关闭',
          danger: true,
        });
        if (!confirmed) return;
        // 用户选择关闭，重置 dirty 状态避免下次打开设置面板时误判
        this.host.resetSettingsFormDirty();
      }

      window.electronAPI.windowClose();
    } catch (error) {
      // 关闭失败不应阻塞 UI，仅记录日志供排查
      reportError('WindowControlsController.handleClose', error);
    }
  }

  // ─── 最大化按钮图标 ────────────────────────────────

  /**
   * 更新最大化按钮图标
   *
   * 根据窗口当前是否最大化切换 SVG 图标：
   * - 最大化时显示还原图标（icon-restore）
   * - 普通状态时显示最大化图标（icon-maximize）
   *
   * 仅当 btnMaximize 元素存在时执行（部分布局可能不提供标题栏）
   */
  updateMaximizeButton(isMaximized: boolean): void {
    const btnMaximize = this.host.getBtnMaximize();
    if (!btnMaximize) return;
    const iconId = isMaximized ? 'icon-restore' : 'icon-maximize';
    setIcon(btnMaximize, iconId);
    btnMaximize.title = isMaximized ? '还原' : '最大化';
  }
}
