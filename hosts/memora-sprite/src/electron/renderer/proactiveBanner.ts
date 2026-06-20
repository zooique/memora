/**
 * 主动提示横幅模块
 *
 * 职责：
 * - 显示/隐藏主动提示横幅（proactive banner）
 * - 初始化横幅按钮事件（查看/稍后/静默 1 小时/关闭）
 *
 * 设计原则：
 * - 顶部滑入蓝粉渐变 banner，提供"查看/稍后/静默 1 小时"三个操作
 * - 独立于 UIManager，通过组合方式持有
 * - 事件监听器纳入跟踪集合，cleanup 时统一清理
 */

/**
 * 主动提示横幅管理器
 *
 * 独立管理横幅的显示、隐藏和按钮事件，UIManager 通过组合持有。
 */
export class ProactiveBanner {
  /** 事件清理函数集合（initProactiveBannerButtons 注册的监听器） */
  private eventCleanupFunctions: Array<() => void> = [];

  /** 添加事件监听器并记录清理函数 */
  private addEventListener(element: HTMLElement, event: string, handler: EventListener): void {
    element.addEventListener(event, handler);
    this.eventCleanupFunctions.push(() => {
      element.removeEventListener(event, handler);
    });
  }

  /**
   * 显示主动提示 banner
   *
   * 对齐 docs/memora-sprite-preview.html §6.6：
   * 顶部滑入蓝粉渐变 banner，提供"查看/稍后/静默 1 小时"三个操作。
   * 由 renderer.ts 在收到 proactivePrompt 事件时调用。
   */
  showProactiveBanner(text: string): void {
    const banner = document.getElementById('proactive-banner');
    const textEl = document.getElementById('proactive-banner-text');
    if (!banner || !textEl) return;

    textEl.textContent = text;
    banner.classList.remove('hidden');
  }

  /**
   * 隐藏主动提示 banner
   *
   * 用户点击任意操作按钮后调用，或切换面板时调用。
   */
  hideProactiveBanner(): void {
    const banner = document.getElementById('proactive-banner');
    if (!banner) return;
    banner.classList.add('hidden');
  }

  /**
   * 初始化主动提示 banner 按钮事件
   *
   * 三个按钮的语义：
   * - 查看：切换到对话面板（banner 已在对话面板内，仅隐藏 banner）
   * - 稍后：隐藏 banner，等待下次触发
   * - 静默 1 小时：通知主进程进入静默模式
   *
   * 由 renderer.ts 调用以注册回调。
   */
  initProactiveBannerButtons(handlers: {
    onView: () => void;
    onLater: () => void;
    onSilent: () => void;
  }): void {
    const banner = document.getElementById('proactive-banner');
    if (!banner) return;

    banner.querySelectorAll<HTMLElement>('.banner-btn').forEach((btn) => {
      const action = btn.dataset.action;
      this.addEventListener(btn, 'click', () => {
        this.hideProactiveBanner();
        if (action === 'view') handlers.onView();
        else if (action === 'later') handlers.onLater();
        else if (action === 'silent') handlers.onSilent();
      });
    });

    // UI-UX-02 关闭按钮：直接隐藏 banner，不触发任何回调
    const closeBtn = banner.querySelector<HTMLElement>('.banner-close');
    if (closeBtn) {
      this.addEventListener(closeBtn, 'click', () => {
        this.hideProactiveBanner();
      });
    }
  }

  /** 清理所有事件监听器（UIManager.cleanup 时调用） */
  cleanup(): void {
    this.eventCleanupFunctions.forEach((cleanup) => cleanup());
    this.eventCleanupFunctions = [];
  }
}
