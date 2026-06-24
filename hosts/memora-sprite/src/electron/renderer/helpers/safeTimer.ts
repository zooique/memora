/**
 * 安全定时器工具 — 提供可追踪的生命周期管理
 *
 * 原生 setTimeout / setInterval 不跟踪定时器 ID，
 * 如果忘记清理可能导致内存泄漏。本模块提供轻量包装，
 * 统一管理定时器的创建和清理。
 *
 * 设计原则：
 * - 方法签名与内核 utils/safeTimer.ts 对齐（setTimeout/clearSafeTimeout 等签名一致）
 * - 范式不同：内核为模块级函数式全局跟踪，渲染层为实例级类隔离跟踪
 * - 渲染层（renderer）和主进程（main）均可使用
 * - 返回的 timer ID 可用于 clearSafeTimeout 清理
 *
 * 使用示例：
 * ```ts
 * class MyManager {
 *   private timers = new SafeTimerTracker();
 *
 *   init() {
 *     this.timers.setTimeout(() => { ... }, 1000);
 *   }
 *
 *   cleanup() {
 *     this.timers.cleanup();
 *   }
 * }
 * ```
 */

/** 定时器 ID 类型（兼容 setTimeout 和 setInterval 的返回值） */
type TimerId = ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>;

/**
 * 安全定时器跟踪器
 *
 * 跟踪所有通过 safeSetTimeout / safeSetInterval 创建的定时器，
 * 在 cleanup 时统一清理，避免内存泄漏。
 */
export class SafeTimerTracker {
  /** 已注册的定时器 ID 集合 */
  private activeTimers = new Set<TimerId>();

  /**
   * 安全的 setTimeout 包装
   *
   * @param callback 回调函数
   * @param ms 延迟毫秒数
   * @returns 定时器 ID，可用于 clearSafeTimeout 提前清理
   */
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout> {
    const id = setTimeout(() => {
      this.activeTimers.delete(id);
      callback();
    }, ms);
    this.activeTimers.add(id);
    return id;
  }

  /**
   * 安全的 setInterval 包装
   *
   * 注意：interval 不会自动从集合中移除，需显式调用 clearSafeInterval 或 cleanup
   *
   * @param callback 回调函数
   * @param ms 间隔毫秒数
   * @returns 定时器 ID，可用于 clearSafeInterval 提前清理
   */
  setInterval(callback: () => void, ms: number): ReturnType<typeof setInterval> {
    const id = setInterval(callback, ms);
    this.activeTimers.add(id);
    return id;
  }

  /**
   * 清理安全的 setTimeout
   *
   * @param id setTimeout 返回的定时器 ID，传 null 静默跳过
   */
  clearSafeTimeout(id: ReturnType<typeof setTimeout> | null): void {
    if (id !== null) {
      clearTimeout(id);
      this.activeTimers.delete(id);
    }
  }

  /**
   * 清理安全的 setInterval
   *
   * @param id setInterval 返回的定时器 ID，传 null 静默跳过
   */
  clearSafeInterval(id: ReturnType<typeof setInterval> | null): void {
    if (id !== null) {
      clearInterval(id);
      this.activeTimers.delete(id);
    }
  }

  /**
   * 清理所有活跃定时器
   *
   * 用于组件销毁或窗口关闭时统一清理，避免定时器回调在已销毁的 DOM 上执行
   */
  cleanup(): void {
    for (const id of this.activeTimers) {
      clearTimeout(id);
    }
    this.activeTimers.clear();
  }
}
