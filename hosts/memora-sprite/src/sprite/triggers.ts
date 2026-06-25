/**
 * 唤醒触发器 — 上下文感知而非内容感知（ADR-SP-004）
 *
 * 触发器架构：
 *   SpriteTrigger 接口 → 独立触发器实现（Timer / FileWatcher / ElectronIPC）
 *   TriggerBus → 触发器注册中心，统一管理生命周期和事件分发
 *
 * **永不监听键盘输入**——这是底线原则。
 */

// 引入安全定时器包装：统一追踪定时器生命周期，避免遗忘清理导致内存泄漏
import { safeSetInterval, clearSafeInterval } from 'memora';

// ─── SpriteTrigger 接口 ──────────────────────────────────

/** 触发器回调参数 */
export interface TriggerPayload {
  /** 触发原因（人类可读） */
  reason: string;
  /** 触发源名称 */
  source: string;
}

/** 触发器回调 */
export type TriggerCallback = (payload: TriggerPayload) => void;

/**
 * 精灵触发器接口
 *
 * 每种唤醒源实现此接口，注册到 TriggerBus。
 * 触发器只负责"感知信号"，不负责"决定是否唤醒"（由 Sprite 主控判断）。
 */
export interface SpriteTrigger {
  /** 触发器名称（用于日志和配置） */
  readonly name: string;
  /** 启动触发器 */
  start(cb: TriggerCallback): void;
  /** 停止触发器 */
  stop(): void;
}

// ─── TimerTrigger ────────────────────────────────────────

/**
 * 定时触发器
 *
 * 每隔固定间隔发射一次触发事件。
 * 阶段一的唯一触发器，阶段二与 FileWatcherTrigger 共存。
 */
export class TimerTrigger implements SpriteTrigger {
  readonly name = 'timer';
  private timer: ReturnType<typeof setInterval> | null = null;
  private callback: TriggerCallback | null = null;
  private intervalMs: number;

  /** 默认间隔（1 小时） */
  static readonly DEFAULT_INTERVAL_MS = 3_600_000;

  constructor(intervalMs?: number) {
    this.intervalMs = intervalMs ?? TimerTrigger.DEFAULT_INTERVAL_MS;
  }

  start(cb: TriggerCallback): void {
    this.callback = cb;
    // 使用 safeSetInterval 替代原生 setInterval，便于统一追踪定时器生命周期
    this.timer = safeSetInterval(() => {
      this.callback?.({ reason: '定时检查', source: this.name });
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      // 使用 clearSafeInterval 清理定时器并从注册表中移除
      clearSafeInterval(this.timer);
      this.timer = null;
    }
    this.callback = null;
  }
}

// ─── TriggerBus ──────────────────────────────────────────

type TriggerHandler = (payload: TriggerPayload) => void;

/**
 * 触发器总线
 *
 * 管理所有触发器源，统一分发触发事件。
 * 不依赖 memora 内部的 TypedEventEmitter（未导出），
 * 使用轻量自实现。
 */
export class TriggerBus {
  private handlers: Set<TriggerHandler> = new Set();
  private triggers: Map<string, SpriteTrigger> = new Map();
  /** 触发器回调引用（用于 stop 时清理） */
  private triggerCallbacks: Map<string, TriggerCallback> = new Map();

  /** 注册触发器回调 */
  on(handler: TriggerHandler): void {
    this.handlers.add(handler);
  }

  /** 移除触发器回调 */
  off(handler: TriggerHandler): void {
    this.handlers.delete(handler);
  }

  /** 发射触发事件 */
  private emit(payload: TriggerPayload): void {
    // P2-ERR-01 对每个 handler 调用包裹 try/catch，防止单个 handler 异常中断全部分发
    // 场景：TimerTrigger 的 setInterval 回调和 FileWatcherTrigger 的 fs.watch 回调间接调用 emit，
    //       未捕获异常会导致 Node.js 进程崩溃
    for (const handler of this.handlers) {
      try {
        handler(payload);
      } catch (err) {
        // 记录错误但不中断后续 handler 的分发
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[TriggerBus] handler 执行异常: ${msg}`);
      }
    }
  }

  /** 注册触发器 */
  register(trigger: SpriteTrigger): void {
    if (this.triggers.has(trigger.name)) {
      throw new Error(`触发器 "${trigger.name}" 已注册`);
    }
    this.triggers.set(trigger.name, trigger);
  }

  /** 注销触发器 */
  unregister(name: string): void {
    const trigger = this.triggers.get(name);
    if (trigger) {
      trigger.stop();
      this.triggers.delete(name);
      this.triggerCallbacks.delete(name);
    }
  }

  /** 启动所有触发器 */
  start(): void {
    for (const [name, trigger] of this.triggers) {
      const cb: TriggerCallback = (payload) => this.emit(payload);
      this.triggerCallbacks.set(name, cb);
      trigger.start(cb);
    }
  }

  /** 停止所有触发器 */
  stop(): void {
    for (const trigger of this.triggers.values()) {
      trigger.stop();
    }
    this.triggerCallbacks.clear();
  }

  /** 获取已注册的触发器名称列表 */
  get registeredTriggers(): string[] {
    return Array.from(this.triggers.keys());
  }
}
