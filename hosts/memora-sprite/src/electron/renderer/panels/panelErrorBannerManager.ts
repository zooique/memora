/**
 * 面板错误横幅管理器
 *
 * 从 UIManager 拆分而来，统一管理 settings / memory / chat / dashboard 四个面板的
 * 错误横幅显示、隐藏和重试按钮事件。
 *
 * 职责：
 * - 绑定各面板错误横幅的重试按钮点击事件
 * - 提供 showPanelError / hidePanelError 通用接口
 * - 维护 panelId → retryCallback 映射，重试时查找并调用
 *
 * 设计原则：
 * - 自包含：仅依赖 EventTracker + DOM，不依赖 UIManager
 * - 统一接口：4 个面板共用同一套 show/hide 逻辑，通过 panelId 区分
 */

import { EventTracker } from '../helpers/eventTracker.js';

/** 支持错误横幅的面板 ID 列表（dashboard 纳入统一错误横幅体系） */
const PANEL_IDS = ['settings', 'memory', 'chat', 'dashboard'] as const;

/**
 * 面板错误横幅管理器
 *
 * 管理多面板错误横幅的显示状态和重试回调。
 * 通过 EventTracker 统一管理重试按钮的事件监听器，cleanup 时自动清理。
 */
export class PanelErrorBannerManager {
  /** 事件监听器跟踪器（统一管理重试按钮的 click 监听器） */
  private events = new EventTracker();
  /** 面板 ID → 重试回调映射（点击重试按钮时查找并调用） */
  private retryCallbacks = new Map<string, () => void>();

  /**
   * 初始化所有面板错误横幅的重试按钮
   *
   * 为 PANEL_IDS 中的每个面板绑定重试按钮 click 事件。
   * 按钮缺失时静默跳过（对应面板可能未提供错误横幅）。
   */
  init(): void {
    for (const panelId of PANEL_IDS) {
      const retryBtn = document.getElementById(`${panelId}-error-retry`);
      if (retryBtn) {
        this.events.addEventListener(retryBtn, 'click', () => {
          const callback = this.retryCallbacks.get(panelId);
          if (callback) {
            callback();
          }
        });
      }
    }
  }

  /**
   * 显示面板错误横幅
   *
   * @param panelId 面板标识（如 'settings' / 'memory' / 'chat'）
   * @param message 错误提示文本
   * @param retryCallback 重试回调（可选，点击重试按钮时触发）
   */
  showPanelError(panelId: string, message: string, retryCallback?: () => void): void {
    const errorEl = document.getElementById(`${panelId}-error`);
    const msgEl = document.getElementById(`${panelId}-error-msg`);
    if (errorEl && msgEl) {
      msgEl.textContent = message;
      errorEl.classList.remove('hidden');
    }
    if (retryCallback) {
      this.retryCallbacks.set(panelId, retryCallback);
    }
  }

  /**
   * 隐藏面板错误横幅
   *
   * @param panelId 面板标识
   */
  hidePanelError(panelId: string): void {
    const errorEl = document.getElementById(`${panelId}-error`);
    if (errorEl) {
      errorEl.classList.add('hidden');
    }
    this.retryCallbacks.delete(panelId);
  }

  /** 清理所有事件监听器和重试回调 */
  cleanup(): void {
    this.events.cleanup();
    this.retryCallbacks.clear();
  }
}
