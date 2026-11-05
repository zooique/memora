/**
 * Agent 事件订阅作用域（6.0.0 E5）——把「面板 × Agent 实例」的订阅生命周期收在一处
 *
 * 为什么需要：对话面板把十余个 Agent 级事件（会话异常 / 上下文压缩 / 归档失败…）绑定到
 * **自己持有的那个 Agent 实例**上。绑定本身已按实例（`agent.on`），但解绑散落在各 `off`
 * 调用里，面板销毁时**没有统一释放** ⇒ 被共享 Agent 长期持有（监听器泄漏），B 方案一会话
 * 一 Agent 后更会跨实例串味。作用域把「绑定到哪台实例 + 何时全部解绑」变成一个可测对象：
 * - 绑定 = `bindTo(agent, binder)`：先释放旧实例的全部订阅，再在**新实例**上重新装订；
 * - 解绑 = `dispose()`：逐条调用 binder 返回的解绑闭包，并清空实例引用。
 *
 * 🔴 实例边界：本类只碰传入的那一个 Agent，不做任何全局转发/广播——面板 A 的事件处理器
 * 永远只能挂在实例 A 上，事件不会流向另一个作用域。
 */
import type { Agent } from '@zooique/memora';

/**
 * 订阅装订器：在目标 Agent 上注册全部处理器，返回**逐条解绑闭包**
 *
 * 之所以返回闭包而不是复用 `off(event, handler)`：handler 引用由调用方持有，
 * 闭包把「哪个事件配哪个 handler」封在装订方内部，解绑方无需重复一份事件表（防两张表漂移）。
 */
export type AgentEventBinder = (agent: Agent) => Array<() => void>;

/** 单面板 × 单 Agent 的事件订阅作用域 */
export class AgentEventScope {
  /** 当前装订的 Agent 实例（undefined = 未绑定/已释放） */
  private _owner: Agent | undefined;

  /** 逐条解绑闭包（与 `_owner` 同生命周期） */
  private _unsubscribers: Array<() => void> = [];

  /** 当前装订的实例（测试/诊断用；normal 路径不需要读） */
  get owner(): Agent | undefined {
    return this._owner;
  }

  /**
   * 绑定到指定 Agent 实例（幂等：换实例/重复绑定都会先释放旧订阅）
   *
   * @param agent 本面板所属的 Agent 实例
   * @param binder 装订器：注册事件并返回解绑闭包
   */
  bindTo(agent: Agent, binder: AgentEventBinder): void {
    this.dispose();
    this._owner = agent;
    this._unsubscribers = binder(agent);
  }

  /** 释放本作用域的全部订阅（可重复调用；单条解绑失败不阻断其余） */
  dispose(): void {
    const unsubscribers = this._unsubscribers;
    // 先清状态再执行解绑：解绑过程中若重入 bindTo，不会拿到半清空的数组
    this._unsubscribers = [];
    this._owner = undefined;
    for (const unsubscribe of unsubscribers) {
      try {
        unsubscribe();
      } catch {
        // Agent 可能已 close/销毁订阅表——视为该条已释放，不影响其余解绑
      }
    }
  }
}
