/**
 * 全局相对时间刷新器
 *
 * 职责：
 * - 聚合所有"相对时间"元素的刷新触发，避免每个面板各自实现定时器
 * - 约定：所有需刷新的时间元素在创建时写入 data-timestamp="<ISO>"，
 *   刷新时统一调用 formatTimeAgo 重算 textContent
 *
 * 触发时机（三重覆盖"用户回来"场景）：
 * 1. window focus —— 从最小化恢复、从其他应用切回、从托盘点击展开
 * 2. visibilitychange (hidden→visible) —— 标签页切换、系统休眠唤醒
 * 3. setInterval 60s（仅可见时）—— 长时间停留同一窗口的兜底刷新
 *
 * 设计原则：
 * - 纯 renderer 层闭环，零主进程改动、零 IPC 通道
 * - 定时器仅在窗口可见时执行刷新，避免后台浪费 CPU
 * - 幂等 start：重复调用不会重复注册监听
 *
 * 不刷新的场景（与问题本质匹配，不过度设计）：
 * - 绝对时间（formatTimestamp / formatClock）不随时间变化，无需刷新
 * - dashboard 拼接文本（如"累计 X · 最近 Y"）随面板切换整体重渲染
 */
import { formatTimeAgo } from './domHelpers.js';

/** 兜底刷新间隔（ms）—— 60 秒覆盖"刚刚→1分钟前→N分钟前"的平滑过渡 */
const REFRESH_INTERVAL_MS = 60_000;

/**
 * TimeRefresher —— 全局相对时间刷新器单例
 *
 * 使用方式：
 * - 启动：在 renderer 初始化阶段调用 `timeRefresher.start()`
 * - 清理：在 beforeunload 时调用 `timeRefresher.stop()`
 * - 元素约定：创建时间元素时写入 `el.dataset.timestamp = isoString`
 */
class TimeRefresher {
  /** setInterval 句柄（null 表示未启动） */
  private intervalId: number | null = null;

  /** 是否已启动（幂等保护，避免重复注册监听） */
  private started = false;

  /** 绑定后的 focus 处理器引用（用于移除监听） */
  private readonly boundRefreshAll: () => void;

  /** 绑定后的 visibilitychange 处理器引用（用于移除监听） */
  private readonly boundHandleVisibilityChange: () => void;

  constructor() {
    // 箭头函数绑定 this，确保 removeEventListener 能移除同一引用
    this.boundRefreshAll = this.refreshAll.bind(this);
    this.boundHandleVisibilityChange = this.handleVisibilityChange.bind(this);
  }

  /**
   * 启动时间刷新器
   *
   * 注册 window focus + visibilitychange 监听，并启动 60s 兜底定时器。
   * 幂等：重复调用安全，不会重复注册。
   */
  start(): void {
    if (this.started) return;
    this.started = true;

    // 窗口获得焦点：覆盖从最小化恢复、从其他应用切回等场景
    window.addEventListener('focus', this.boundRefreshAll);
    // 可见性变化：覆盖标签页切换、系统休眠唤醒（部分 OS）等场景
    document.addEventListener('visibilitychange', this.boundHandleVisibilityChange);
    // 兜底定时器：长时间停留同一窗口时，"刚刚"也能平滑过渡到"N分钟前"
    this.intervalId = window.setInterval(this.refreshIfVisible, REFRESH_INTERVAL_MS);
  }

  /**
   * 停止时间刷新器
   *
   * 移除所有事件监听并清除定时器。在 beforeunload 时调用，防止内存泄漏。
   * 可重复调用（幂等）。
   */
  stop(): void {
    if (!this.started) return;
    this.started = false;

    window.removeEventListener('focus', this.boundRefreshAll);
    document.removeEventListener('visibilitychange', this.boundHandleVisibilityChange);
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * 手动触发一次全量刷新
   *
   * 遍历所有带 data-timestamp 属性的元素，用 formatTimeAgo 重算 textContent。
   * 面板渲染后无需调用（创建时已格式化），仅在需要强制刷新时使用。
   */
  refreshAll = (): void => {
    // querySelectorAll 返回 NodeList，遍历开销与元素数量线性相关
    const elements = document.querySelectorAll<HTMLElement>('[data-timestamp]');
    elements.forEach((el) => {
      // data-timestamp 约定存储 ISO 8601 时间字符串
      const iso = el.dataset.timestamp;
      if (!iso) return;
      el.textContent = formatTimeAgo(iso);
    });
  };

  /**
   * 仅在窗口可见时刷新（定时器回调专用）
   *
   * 避免窗口最小化/隐藏时仍执行 DOM 遍历浪费 CPU。
   */
  private readonly refreshIfVisible = (): void => {
    if (document.visibilityState === 'visible') {
      this.refreshAll();
    }
  };

  /**
   * visibilitychange 事件处理器
   *
   * 仅在页面从隐藏变为可见时触发刷新（可见→隐藏方向不刷新）。
   */
  private handleVisibilityChange(): void {
    if (document.visibilityState === 'visible') {
      this.refreshAll();
    }
  }
}

/** 全局单例（renderer 全程共享一个实例） */
export const timeRefresher = new TimeRefresher();
