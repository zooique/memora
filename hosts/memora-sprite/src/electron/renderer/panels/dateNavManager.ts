/**
 * 日期导航管理器 — 日历选择器，快速跳转到指定日期
 *
 * 从下拉列表重构为原生 <input type="date"> 日历选择器。
 * 时间流滚动加载（loadEarlierDay）已覆盖顺序浏览历史对话，
 * 日历选择器提供随机访问——用户选择日期后直接跳转。
 *
 * 职责：
 * - 绑定 #date-nav-picker 的 change 事件
 * - 日期变更时触发跳转回调
 * - 跳转后清空选择器值（还原为"选择日期"占位状态）
 *
 * 设计原则：
 * - 自包含 EventTracker，init() 绑定事件，cleanup() 统一清理
 * - 与 UIManager 解耦，通过回调接口通信
 */
import { EventTracker } from '../helpers/eventTracker.js';

/**
 * 日期导航管理器类
 *
 * 生命周期：init() 绑定事件 → cleanup() 清理事件 + 回调
 */
export class DateNavManager {
  /** 事件监听器跟踪器 */
  private events = new EventTracker();
  /** 日期跳转回调（由 renderer.ts 注册，调用 sessionController.jumpToDate） */
  private jumpCallback: ((date: string) => void) | null = null;

  /**
   * 初始化事件监听器
   *
   * 绑定 #date-nav-picker 的 change 事件。
   * 在 UIManager 构造完成后调用。
   */
  init(): void {
    const picker = document.getElementById('date-nav-picker') as HTMLInputElement | null;
    if (!picker) return;

    this.events.addEventListener(picker, 'change', () => {
      const date = picker.value; // YYYY-MM-DD 格式
      if (date && this.jumpCallback) {
        this.jumpCallback(date);
        // 跳转后清空选择器，还原为"选择日期"占位状态
        picker.value = '';
      }
    });
  }

  /**
   * 注册日期跳转回调
   *
   * @param cb 跳转回调（接收日期字符串 YYYY-MM-DD）
   */
  onDateNavJump(cb: (date: string) => void): void {
    this.jumpCallback = cb;
  }

  /** 清理事件监听器 */
  cleanup(): void {
    this.events.cleanup();
    this.jumpCallback = null;
  }
}