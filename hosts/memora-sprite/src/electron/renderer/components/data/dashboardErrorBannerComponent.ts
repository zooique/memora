/**
 * 仪表盘错误提示横幅组件
 *
 * 职责（封装 dashboardPanelManager 中 showMemoryListError 的 DOM 操作）：
 * - 显示记忆列表加载失败状态（带错误信息和重试按钮）
 * - 重试按钮通过回调委托给 Manager 触发数据重新加载
 *
 * 与现有 HTML 模板的关系：
 * - 错误横幅 DOM 元素已存在于 index.html 模板中
 * - 本组件 mount() 时查询并缓存这些已有元素引用
 * - destroy() 不删除 DOM 元素，仅 nullify 引用
 *
 * 对齐 ui-engineering-mindset-rules §四.1 / §四.4：
 * - mount() 缓存元素引用
 * - update() 显示/隐藏错误信息
 * - destroy() 彻底清理引用
 */

import { Component } from '../base/component.js';

// ─── 选项 / 宿主接口 ──────────────────────────────────────

/** DashboardErrorBannerComponent 配置 */
export interface DashboardErrorBannerOptions {
  /** 重试回调（由 Manager 注册，触发数据重新加载） */
  onRetry?: () => void;
}

// ─── 组件 ────────────────────────────────────────────────

/**
 * 仪表盘错误提示横幅组件
 *
 * 由 DashboardPanelManager 持有实例，替代原有 3 处 document.getElementById 直接 DOM 操作。
 * 挂载到现有 HTML 模板中的 #dashboard-error 及相关元素。
 */
export class DashboardErrorBannerComponent extends Component<DashboardErrorBannerOptions> {
  // ─── 缓存的 DOM 元素引用（mount 时查询，destroy 时 nullify） ──
  /** 错误横幅容器 */
  private errorEl: HTMLElement | null = null;
  /** 错误信息文本元素 */
  private msgEl: HTMLElement | null = null;
  /** 重试按钮 */
  private retryBtn: HTMLButtonElement | null = null;

  /**
   * 构造函数——只合并配置，无副作用
   *
   * @param options 组件配置（含重试回调）
   */
  constructor(options: DashboardErrorBannerOptions = {}) {
    super(options);
  }

  /**
   * 挂载到容器——查询并缓存现有 DOM 元素引用，绑定重试按钮事件
   *
   * @param _container 容器元素或选择器（兼容 Component 契约）
   * @returns this（链式调用）
   */
  mount(_container: HTMLElement | string): this {
    this.errorEl = document.getElementById('dashboard-error');
    this.msgEl = document.getElementById('dashboard-error-msg');
    const retryBtn = document.getElementById('dashboard-error-retry');
    this.retryBtn = retryBtn instanceof HTMLButtonElement ? retryBtn : null;

    // 绑定重试按钮事件（用 onclick 覆盖式绑定，避免累积监听器）
    if (this.retryBtn) {
      const onRetry = () => this.options.onRetry?.();
      this.retryBtn.onclick = onRetry;
      this.trackEvent(() => {
        if (this.retryBtn) this.retryBtn.onclick = null;
      });
    }

    this.el = this.errorEl;

    return this;
  }

  /**
   * 显示错误信息
   *
   * @param message 错误信息文本
   * @returns this（链式调用）
   */
  showError(message: string): this {
    if (!this.errorEl || !this.msgEl) return this;
    this.msgEl.textContent = message;
    this.errorEl.classList.remove('hidden');
    return this;
  }

  /**
   * 隐藏错误横幅
   *
   * @returns this（链式调用）
   */
  hideError(): this {
    if (this.errorEl) {
      this.errorEl.classList.add('hidden');
    }
    return this;
  }

  /**
   * 增量更新——更新重试回调
   *
   * @param newOptions 新的配置项
   * @returns this（链式调用）
   */
  update(newOptions: Partial<DashboardErrorBannerOptions> = {}): this {
    if (newOptions.onRetry !== undefined) {
      this.options = { ...this.options, onRetry: newOptions.onRetry };
      // 更新重试按钮的回调
      if (this.retryBtn) {
        this.retryBtn.onclick = () => this.options.onRetry?.();
      }
    }
    return this;
  }

  /**
   * 销毁组件——nullify 引用
   */
  destroy(): void {
    this.errorEl = null;
    this.msgEl = null;
    this.retryBtn = null;
    super.destroy();
  }
}