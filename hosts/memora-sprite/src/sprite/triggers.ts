/**
 * 唤醒触发器 — 上下文感知而非内容感知（ADR-SP-004）
 *
 * 阶段一：定时触发器（每小时检查一次）
 * 阶段二：文件变化触发器（fs.watch）
 * 阶段三：系统事件触发器（Electron IPC）
 *
 * **永不监听键盘输入**——这是底线原则。
 *
 * TODO: 阶段二重构为 SpriteTrigger 接口（感知层规范 §3）：
 *   interface SpriteTrigger { name: string; start(cb: () => void): void; stop(): void; }
 *   当前 TriggerBus 是事件总线模式，阶段二需拆分为独立触发器 + 总线注册。
 */

type TriggerHandler = (reason: string) => void;

/**
 * 触发器总线
 *
 * 管理所有触发器源，统一发射 'trigger' 事件。
 * 不依赖 memora 内部的 TypedEventEmitter（未导出），
 * 使用轻量自实现。
 */
export class TriggerBus {
  private handlers: Set<TriggerHandler> = new Set();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 定时触发间隔 */
  private intervalMs: number;
  /** 默认间隔（1 小时） */
  static readonly DEFAULT_INTERVAL_MS = 3_600_000;

  constructor(intervalMs?: number) {
    this.intervalMs = intervalMs ?? TriggerBus.DEFAULT_INTERVAL_MS;
  }

  /** 注册触发器回调 */
  on(handler: TriggerHandler): void {
    this.handlers.add(handler);
  }

  /** 移除触发器回调 */
  off(handler: TriggerHandler): void {
    this.handlers.delete(handler);
  }

  /** 发射触发事件 */
  emit(reason: string): void {
    for (const handler of this.handlers) {
      handler(reason);
    }
  }

  /** 启动所有触发器 */
  start(): void {
    // 定时触发器
    this.timer = setInterval(() => {
      this.emit('定时检查');
    }, this.intervalMs);
  }

  /** 停止所有触发器 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
