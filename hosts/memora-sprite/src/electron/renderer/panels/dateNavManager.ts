/**
 * 日期导航管理器 — 日历选择器，快速跳转到指定日期
 *
 * 从下拉列表重构为原生 <input type="date"> 日历选择器。
 * 时间流滚动加载（loadEarlierDay）已覆盖顺序浏览历史对话，
 * 日历选择器提供随机访问——用户选择日期后直接跳转。
 *
 * 职责：
 * - 绑定 #date-nav-picker 的 change 事件
 * - 加载有对话记录的日期列表，验证选择的日期是否有效
 * - 日期变更时触发跳转回调（仅对有记录的日期）
 * - 显示当前查看的日期（不再清空选择器值）
 *
 * 设计原则：
 * - 自包含 EventTracker，init() 绑定事件，cleanup() 统一清理
 * - 与 UIManager 解耦，通过回调接口通信
 * - 没有对话记录的日期禁用（选择后验证，原生 input[type="date"] 不支持直接禁用特定日期）
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
  /** 日期无效回调（选择了无记录的日期时通知 UI 显示提示） */
  private invalidDateCallback: (() => void) | null = null;
  /** 有对话记录的日期集合（用于验证选择的日期是否有效） */
  private availableDates = new Set<string>();
  /** 当前有效的日期值（用于无效日期时恢复） */
  private currentValidDate = '';

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
      if (!date) return;

      // 验证日期是否有对话记录
      if (!this.availableDates.has(date)) {
        // 日期无效：恢复到之前的有效值，触发回调通知 UI
        picker.value = this.currentValidDate;
        this.invalidDateCallback?.();
        return;
      }

      // 日期有效：更新当前有效日期记录
      this.currentValidDate = date;

      if (this.jumpCallback) {
        this.jumpCallback(date);
        // 不再清空选择器值，保持显示当前日期
      }
    });
  }

  /**
   * 更新有对话记录的日期集合
   *
   * @param dates 日期列表（YYYY-MM-DD 格式）
   */
  updateAvailableDates(dates: string[]): void {
    this.availableDates.clear();
    dates.forEach((d) => this.availableDates.add(d));
  }

  /**
   * 设置日期选择器显示的当前日期
   *
   * @param date 日期字符串（YYYY-MM-DD 格式），为空则清空选择器
   */
  setCurrentDate(date: string): void {
    const picker = document.getElementById('date-nav-picker') as HTMLInputElement | null;
    if (!picker) return;
    picker.value = date;
    // 更新当前有效日期记录
    this.currentValidDate = date;
  }

  /**
   * 注册日期跳转回调
   *
   * @param cb 跳转回调（接收日期字符串 YYYY-MM-DD）
   */
  onDateNavJump(cb: (date: string) => void): void {
    this.jumpCallback = cb;
  }

  /**
   * 注册日期无效回调
   *
   * @param cb 无效日期回调（选择了无记录的日期时触发）
   */
  onInvalidDate(cb: () => void): void {
    this.invalidDateCallback = cb;
  }

  /** 清理事件监听器 */
  cleanup(): void {
    this.events.cleanup();
    this.jumpCallback = null;
    this.invalidDateCallback = null;
    this.availableDates.clear();
    this.currentValidDate = '';
  }
}