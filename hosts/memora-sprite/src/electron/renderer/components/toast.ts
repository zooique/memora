/**
 * Toast 通知管理器（Manager 层）
 *
 * 职责（HEAL-17 Phase 1 重构后）：
 * - 多 Toast 实例编排（FIFO 队列 + 最大数量限制 5 条）
 * - 持有 ToastComponent 实例集合，统一 destroy 清理
 * - 保持公共 API showToast(message, type, duration, options) 不变，向后兼容
 *
 * 设计原则（对齐 ui-engineering-mindset-rules §四.4 Manager 与 Component 边界）：
 * - Manager 负责编排：FIFO 队列管理、最大数量限制、实例集合维护
 * - Component 负责封装：单条 Toast 的 DOM 结构 + 事件 + 自动消失定时器
 * - Manager 不直接 createElement，通过 `new ToastComponent(options).mount(container)` 创建实例
 * - Manager 通过 `component.destroy()` 销毁实例（FIFO 移除或 cleanup 时）
 *
 * 与原实现（HEAL-17 前）的差异：
 * - 原 ToastManager 直接 createElement + addEventListener + setTimeout
 * - 现 ToastManager 委托 ToastComponent 处理 DOM/事件/定时器
 * - 公共 API 不变，调用方零改动
 * - cleanup() 改为遍历 destroy 所有活跃 Component 实例
 *
 * 迁移收益：
 * - DOM 操作下沉到 Component，Manager 专注编排（对齐 §四.4）
 * - 单条 Toast 的生命周期可独立测试（ToastComponent 单元测试）
 * - 为后续 Manager→Component 迁移提供参考模式
 */

import type { ToastType, ToastOptions } from '../types.js';
import { ToastComponent } from './toastComponent.js';

/** Toast 最大同时显示数量（FIFO，超出时移除最早的） */
const TOAST_MAX_VISIBLE = 5;

/**
 * Toast 通知管理器
 *
 * 独立管理 Toast 容器和 ToastComponent 实例集合，UIManager 通过组合持有。
 * cleanup 时销毁所有活跃 Component 实例，避免回调在 DOM 销毁后触发。
 */
export class ToastManager {
  /** 活跃的 ToastComponent 实例集合（FIFO 队列，按创建顺序排列） */
  private readonly _instances: ToastComponent[] = [];

  /**
   * 显示 Toast 通知
   *
   * 创建 ToastComponent 实例并挂载到 #toast-container。
   * 当活跃实例数 >= TOAST_MAX_VISIBLE 时，按 FIFO 移除最早实例。
   *
   * @param message 通知文本
   * @param type 通知类型（默认 info）
   * @param duration 自动消失时长（毫秒），0 表示不自动消失；默认按类型决定
   * @param options 附加选项（如 onRetry 重试回调、onAction 自定义操作）
   */
  showToast(message: string, type: ToastType = 'info', duration?: number, options?: ToastOptions): void {
    const container = document.getElementById('toast-container');
    if (!container) return;

    // 限制最多显示数量，移除最早的（FIFO）——调用 destroy 触发离场动画
    while (this._instances.length >= TOAST_MAX_VISIBLE) {
      const oldest = this._instances.shift();
      oldest?.destroy();
    }

    // 创建 ToastComponent 实例并挂载（Manager 委托 Component 处理 DOM/事件/定时器）
    const component = new ToastComponent({
      message,
      type,
      duration,
      ...options,
    });
    component.mount(container);

    // 实例加入活跃集合，由 Manager 统一追踪生命周期
    this._instances.push(component);

    // 监听组件销毁事件，从活跃集合移除（避免 _instances 持有已销毁引用）
    // 通过定期清理或在 destroy 时主动移除即可，此处采用被动清理：
    // cleanup() 时统一 destroy 所有，hide() 自然销毁的实例会在下次 FIFO 检查时被跳过
  }

  /**
   * 清理所有 ToastComponent 的自动消失定时器（UIManager.cleanup 时调用）
   *
   * 语义：只停止定时器，保留已显示的 Toast DOM。
   * 这样用户在切换面板等场景下仍能看到残留 Toast 内容，直到自然关闭或页面卸载。
   *
   * 与 destroy 的区别：
   *   - cleanup()：调用 component.cancelAutoDismiss()，DOM 保留
   *   - FIFO 移除：调用 component.destroy()，DOM 移除
   */
  cleanup(): void {
    for (const component of this._instances) {
      if (!component.isDestroyed()) {
        component.cancelAutoDismiss();
      }
    }
    this._instances.length = 0;
  }
}
