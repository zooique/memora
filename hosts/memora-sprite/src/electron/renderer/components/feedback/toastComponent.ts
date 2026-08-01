/**
 * ToastComponent - 单条 Toast 反馈组件（HEAL-17 Phase 1）
 *
 * 遵循 Component 统一生命周期（对齐 ui-engineering-mindset-rules §四.1）：
 *   - create(options)  创建实例（不挂载）
 *   - mount(container) 挂载到 DOM（创建根元素 + 绑定事件 + 启动定时器）
 *   - update(options)  增量更新（消息/类型/按钮）
 *   - destroy()        清理定时器 + 移除 DOM + nullify 引用
 *
 * 与 ToastManager 的关系（对齐 §四.4 Manager 与 Component 边界）：
 *   - ToastManager 作为 Manager，负责多 Toast 实例编排（FIFO 队列 + 最大数量限制）
 *   - ToastManager 通过 `new ToastComponent(options).mount(container)` 创建实例
 *   - ToastManager 通过 `component.destroy()` 销毁实例（FIFO 移除最早条目时）
 *   - ToastComponent 单实例自包含：DOM 结构 + 事件 + 自动消失定时器
 *
 * 设计决策：
 *   - 不在 ToastComponent 内实现 FIFO——这是 Manager 的编排职责
 *   - 离场动画通过现有 removeWithAnimation helper（保留与原实现一致的视觉行为）
 *   - SVG 图标、aria 属性、role 等无障碍特性全部保留
 *   - onRetry / onAction 回调由 Component 内部绑定，destroy 时自动解绑
 */

import { Component } from '../base/Component.js';
import type { ToastType, ToastOptions } from '../../types.js';
// 复用 sprite 层共享常量，避免多处硬编码 Toast 时长导致口径不一致
import { TOAST_LONG_MS } from '../../../../sprite/constants.js';
import { setIcon } from '../../helpers/icon.js';

/**
 * Toast 类型与图标映射
 * 使用 SVG sprite 引用，跨平台渲染一致（代替 Unicode 符号 ✓✗⚠ℹ）
 */
const TOAST_ICONS: Record<ToastType, string> = {
  success: '<svg class="icon"><use href="#icon-check"/></svg>',
  error: '<svg class="icon"><use href="#icon-close"/></svg>',
  warning: '<svg class="icon"><use href="#icon-warning"/></svg>',
  info: '<svg class="icon"><use href="#icon-info"/></svg>',
};

/**
 * Toast 默认自动消失时长（毫秒），error 类型不自动消失
 * 引用 sprite 层共享常量 TOAST_LONG_MS，统一全局 Toast 长时长口径
 */
const TOAST_DEFAULT_DURATION = TOAST_LONG_MS;

/**
 * ToastComponent 配置类型
 *
 * 与 ToastOptions（来自 types.ts）的区别：
 *   - ToastOptions 是 ToastManager.showToast 的附加选项（onRetry/onAction）
 *   - ToastComponentOptions 是 Component 实例化的完整配置（消息 + 类型 + 时长 + 选项）
 */
export interface ToastComponentOptions extends ToastOptions {
  /** 消息文本 */
  message: string;
  /** Toast 类型（默认 info） */
  type: ToastType;
  /**
   * 自动消失时长（毫秒）
   *   - 0 表示不自动消失（error 类型默认）
   *   - undefined 表示按类型决定（info/warning/success 用 TOAST_DEFAULT_DURATION，error 用 0）
   *   - 有 onRetry / onAction 时强制不自动消失（让用户有时间点击按钮）
   */
  duration?: number;
}

/**
 * ToastComponent 单实例组件
 *
 * 一条 Toast = 一个 ToastComponent 实例。
 * ToastManager 持有多个实例，通过 FIFO 策略管理生命周期。
 */
export class ToastComponent extends Component<ToastComponentOptions> {
  /** 自动消失定时器引用（destroy 时清理，避免回调在 DOM 销毁后触发） */
  private _timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * 构造函数——只合并配置，不做副作用
   *
   * @param options Toast 配置（部分可选，默认值在 _normalizeOptions 中处理）
   */
  constructor(options: Partial<ToastComponentOptions> & { message: string }) {
    super({ ...ToastComponent.defaults, ...options } as ToastComponentOptions);
  }

  /** 默认配置 */
  static defaults: ToastComponentOptions = {
    message: '',
    type: 'info',
    duration: undefined,
  };

  /**
   * 挂载到容器——创建 DOM + 绑定事件 + 启动定时器
   *
   * @param container 容器元素或选择器（通常是 #toast-container）
   * @returns this（链式调用）
   */
  mount(container: HTMLElement | string): this {
    /** 解析容器 */
    const target = typeof container === 'string'
      ? document.querySelector<HTMLElement>(container)
      : container;
    if (!target) return this;

    /** 创建根 DOM 元素 */
    const toast = document.createElement('div');
    toast.className = `toast ${this.options.type}`;
    toast.setAttribute('role', this.options.type === 'error' ? 'alert' : 'status');
    this.el = toast;

    /** 图标（SVG sprite，跨平台一致） */
    const icon = document.createElement('span');
    icon.className = 'toast-icon flex-shrink-0';
    icon.innerHTML = TOAST_ICONS[this.options.type];
    toast.appendChild(icon);

    /** 内容 + 操作按钮容器 */
    const body = document.createElement('div');
    body.className = 'toast-body';

    /** 内容文本 */
    const content = document.createElement('div');
    content.className = 'toast-content';
    content.textContent = this.options.message;
    body.appendChild(content);

    /** 重试按钮（仅在提供 onRetry 时显示） */
    if (this.options.onRetry) {
      // 提取局部常量，避免闭包内控制流分析断裂导致的非空断言
      const onRetry = this.options.onRetry;
      const retryBtn = document.createElement('button');
      retryBtn.className = 'toast-retry';
      retryBtn.textContent = '重试';
      retryBtn.title = '重新发送上一条消息';
      retryBtn.addEventListener('click', () => {
        // 先 hide() 触发离场动画，动画结束后 destroy 并回调 onRetry
        // 这样保留与原实现一致的视觉行为（添加 leaving 类 + animationend 后移除）
        this.hide();
        onRetry();
      });
      body.appendChild(retryBtn);
    }

    /** 自定义操作按钮（如"分析"按钮，触发剪贴板分析），复用 onRetry 的 UI 模式但语义更通用 */
    if (this.options.onAction && this.options.actionLabel) {
      const onAction = this.options.onAction;
      const actionBtn = document.createElement('button');
      actionBtn.className = 'toast-retry';
      actionBtn.textContent = this.options.actionLabel;
      actionBtn.title = this.options.actionLabel;
      actionBtn.addEventListener('click', () => {
        // 先 hide() 触发离场动画，动画结束后 destroy 并回调 onAction
        this.hide();
        onAction();
      });
      body.appendChild(actionBtn);
    }

    toast.appendChild(body);

    /** 关闭按钮（始终显示，让用户可手动关闭） */
    const closeBtn = document.createElement('button');
    closeBtn.className = 'toast-close flex-shrink-0';
    setIcon(closeBtn, 'icon-close');
    closeBtn.title = '关闭';
    // aria-label 为屏幕阅读器提供可访问名称（title 是弱回退，部分阅读器默认不朗读）
    closeBtn.setAttribute('aria-label', '关闭');
    closeBtn.addEventListener('click', () => this.hide());
    toast.appendChild(closeBtn);

    /** 挂载到容器 */
    target.appendChild(toast);

    /** 启动自动消失定时器（有重试/操作按钮时不自动消失，让用户有时间点击） */
    this._startTimer();

    return this;
  }

  /**
   * 增量更新内部状态——不重建 DOM
   *
   * 当前 ToastComponent 的使用场景是单次显示后销毁，update 较少被调用。
   * 保留 update 以满足 Component 契约，未来可用于"替换最早 Toast 内容"等场景。
   *
   * @param newOptions 新的配置项
   * @returns this（链式调用）
   */
  update(newOptions: Partial<ToastComponentOptions>): this {
    /** 增量更新配置 */
    Object.assign(this.options, newOptions);

    if (!this.el) return this;

    /** 增量更新 DOM（不重建） */
    if (newOptions.message !== undefined) {
      const content = this.el.querySelector<HTMLElement>('.toast-content');
      if (content) content.textContent = newOptions.message;
    }
    if (newOptions.type !== undefined) {
      this.el.className = `toast ${newOptions.type}`;
      this.el.setAttribute('role', newOptions.type === 'error' ? 'alert' : 'status');
      // 同步更新图标
      const icon = this.el.querySelector<HTMLElement>('.toast-icon');
      if (icon) icon.innerHTML = TOAST_ICONS[newOptions.type];
    }

    /** 重启定时器（duration 可能变化） */
    this._startTimer();

    return this;
  }

  /**
   * 隐藏 Toast（触发离场动画后销毁）
   *
   * 通过添加 `leaving` CSS 类触发离场动画（toast.css 中的 @keyframes toast-slide-out），
   * 动画结束后通过 animationend 回调触发 destroy。
   * 与原 ToastManager.removeToast(toast) → removeWithAnimation(toast, 'leaving') 行为等价。
   */
  hide(): void {
    if (!this.el || this.isDestroyed()) return;
    // 添加 leaving 类触发 toast-slide-out 动画
    this.el.classList.add('leaving');
    // animationend 触发时调用 destroy（once: true 保证监听器自动解绑）
    this.el.addEventListener('animationend', () => this.destroy(), { once: true });
  }

  /**
   * 取消自动消失——只清理定时器，不移除 DOM
   *
   * 用于 ToastManager.cleanup() 场景：停止所有 Toast 的自动消失定时器，
   * 但保留已显示的 Toast DOM（让用户看到残留内容，直到自然关闭或页面卸载）。
   *
   * 与 destroy() 的区别：
   *   - cancelAutoDismiss()：只停定时器，DOM 保留
   *   - destroy()：停定时器 + 移除 DOM + nullify 引用
   */
  cancelAutoDismiss(): void {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  /**
   * 销毁组件——清理定时器 + 移除 DOM + nullify 引用
   *
   * override 以清理 _timer，然后调用 super.destroy() 完成通用清理。
   */
  destroy(): void {
    /** 清理自动消失定时器 */
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    /** 调用基类 destroy（清理事件 + 移除 DOM + nullify el） */
    super.destroy();
  }

  /**
   * 启动自动消失定时器
   *
   * 计算规则：
   *   1. 有 onRetry / onAction → 不自动消失（duration = 0）
   *   2. 显式指定 duration → 用指定值
   *   3. 未指定 duration + error 类型 → 不自动消失
   *   4. 未指定 duration + 其他类型 → 用 TOAST_DEFAULT_DURATION
   */
  private _startTimer(): void {
    /** 清理已有定时器（避免重复） */
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }

    /** 有重试或操作按钮时不自动消失，让用户有时间点击 */
    const hasRetry = !!this.options.onRetry;
    const hasAction = !!this.options.onAction && !!this.options.actionLabel;
    if (hasRetry || hasAction) return;

    /** 计算实际时长 */
    const autoDuration = this.options.duration
      ?? (this.options.type === 'error' ? 0 : TOAST_DEFAULT_DURATION);

    if (autoDuration > 0) {
      this._timer = setTimeout(() => this.hide(), autoDuration);
      // _timer 的清理在 destroy() override 中统一处理，无需通过 trackEvent 收集
      // （否则 update 重启定时器时会重复堆积清理函数）
    }
  }
}
