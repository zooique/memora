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
  /** 当前提示的触发类型列表（用于点击"查看"时决定跳转哪个面板） */
  private currentTriggers: string[] = [];

  /**
   * 显示主动提示 banner
   *
   * 对齐设计契约 §6.6：
   * 顶部滑入蓝粉渐变 banner，提供"查看/稍后/静默 1 小时"三个操作。
   * 里程碑事件使用金色渐变庆祝样式+奖杯图标。
   *
   * @param text 提示文本
   * @param isMilestone 是否为里程碑事件
   * @param triggers 触发类型列表（memory/insight/persona/file/milestone/suggestion/pattern）
   */
  showProactiveBanner(text: string, isMilestone = false, triggers: string[] = []): void {
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
    // 保存当前提示的 triggers，供点击"查看"时使用
    this.currentTriggers = triggers;
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
    // 清空 triggers 缓存
    this.currentTriggers = [];
  }

  /**
   * 初始化主动提示 banner 按钮事件
   *
   * 四个按钮的语义：
   * - 查看：根据 triggers 类型跳转到相应面板展示详情
   * - 稍后：隐藏 banner，等待下次触发
   * - 静默 1 小时：通知主进程进入静默模式
   * - 不再提醒：进入静默模式并提示用户去设置调整阈值
   *
   * 由 renderer.ts 调用以注册回调。
   */
  initProactiveBannerButtons(handlers: {
    onView: (triggers: string[]) => void;
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
        if (action === 'view') handlers.onView(this.currentTriggers);
        else if (action === 'later') handlers.onLater();
        else if (action === 'silent') handlers.onSilent();
        // 不再提醒：触发 onDisable 回调
        else if (action === 'disable') handlers.onDisable?.();
      });
    });

    // 关闭按钮：承担原"稍后"语义——隐藏 banner 并记录拒绝事件，
    // 触发自适应冷却（精灵下次更晚再提示），符合用户"关闭=先别烦我"的心智。
    // 若仅隐藏不记录拒绝，精灵会按原节奏再次弹出，体验割裂。
    const closeBtn = banner.querySelector<HTMLElement>('.banner-close');
    if (closeBtn) {
      this.events.addEventListener(closeBtn, 'click', () => {
        this.hideProactiveBanner();
        handlers.onLater();
      });
    }
  }

  /** 清理所有事件监听器（UIManager.cleanup 时调用） */
  cleanup(): void {
    // 清理所有事件监听器（通过 EventTracker 统一管理）
    this.events.cleanup();
  }
}
