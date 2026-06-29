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

import { EventTracker } from '../helpers/eventTracker.js';

/**
 * 主动提示横幅管理器
 *
 * 独立管理横幅的显示、隐藏和按钮事件，UIManager 通过组合持有。
 */
export class ProactiveBanner {
  /** 事件监听器跟踪器（统一管理事件监听器的注册与清理，避免内存泄漏） */
  private events = new EventTracker();

  /**
   * 显示主动提示 banner
   *
   * 对齐 docs/memora-sprite-preview.html §6.6：
   * 顶部滑入蓝粉渐变 banner，提供"查看/稍后/静默 1 小时"三个操作。
   * 里程碑事件使用金色渐变庆祝样式+奖杯图标。
   *
   * @param text 提示文本
   * @param isMilestone 是否为里程碑事件
   */
  showProactiveBanner(text: string, isMilestone = false): void {
    const banner = document.getElementById('proactive-banner');
    const textEl = document.getElementById('proactive-banner-text');
    const iconEl = banner?.querySelector<SVGElement>('.banner-icon');
    if (!banner || !textEl) return;

    textEl.textContent = text;
    // 里程碑事件添加专属样式类
    banner.classList.toggle('is-milestone', isMilestone);
    // 里程碑时切换图标为奖杯（使用 icon-trophy SVG）
    if (iconEl) {
      const useEl = iconEl.querySelector('use');
      if (useEl) {
        useEl.setAttribute('href', isMilestone ? '#icon-trophy' : '#icon-fairy');
      }
    }
    banner.classList.remove('hidden');
  }

  /**
   * 隐藏主动提示 banner
   *
   * 用户点击任意操作按钮后调用，或切换面板时调用。
   * 同时清除里程碑样式类和图标，恢复默认状态。
   */
  hideProactiveBanner(): void {
    const banner = document.getElementById('proactive-banner');
    if (!banner) return;
    banner.classList.add('hidden');
    // 隐藏时清除里程碑样式，避免下次普通提示仍显示金色样式
    banner.classList.remove('is-milestone');
    // 恢复默认精灵图标
    const iconEl = banner.querySelector<SVGElement>('.banner-icon');
    if (iconEl) {
      const useEl = iconEl.querySelector('use');
      if (useEl) {
        useEl.setAttribute('href', '#icon-fairy');
      }
    }
  }

  /**
   * 初始化主动提示 banner 按钮事件
   *
   * 四个按钮的语义：
   * - 查看：切换到对话面板（banner 已在对话面板内，仅隐藏 banner）
   * - 稍后：隐藏 banner，等待下次触发
   * - 静默 1 小时：通知主进程进入静默模式
   * - 不再提醒：进入静默模式并提示用户去设置调整阈值（P3-FLOW-08）
   *
   * 由 renderer.ts 调用以注册回调。
   */
  initProactiveBannerButtons(handlers: {
    onView: () => void;
    onLater: () => void;
    onSilent: () => void;
    onDisable?: () => void;
  }): void {
    const banner = document.getElementById('proactive-banner');
    if (!banner) return;

    banner.querySelectorAll<HTMLElement>('.banner-btn').forEach((btn) => {
      const action = btn.dataset.action;
      this.events.addEventListener(btn, 'click', () => {
        this.hideProactiveBanner();
        if (action === 'view') handlers.onView();
        else if (action === 'later') handlers.onLater();
        else if (action === 'silent') handlers.onSilent();
        // P3-FLOW-08 不再提醒：触发 onDisable 回调
        else if (action === 'disable') handlers.onDisable?.();
      });
    });

    // UI-UX-02 关闭按钮：直接隐藏 banner，不触发任何回调
    const closeBtn = banner.querySelector<HTMLElement>('.banner-close');
    if (closeBtn) {
      this.events.addEventListener(closeBtn, 'click', () => {
        this.hideProactiveBanner();
      });
    }
  }

  /** 清理所有事件监听器（UIManager.cleanup 时调用） */
  cleanup(): void {
    // 清理所有事件监听器（通过 EventTracker 统一管理）
    this.events.cleanup();
  }
}
