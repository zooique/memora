/**
 * 类型化事件总线 — 面板回调的统一存储与分发（AUDIT-H6）
 *
 * 语义说明（对抗式审查结论）：
 * - **单订阅（覆盖）语义**：on() 重复注册同一事件会覆盖前者，等价于旧
 *   onXxx() 赋值行为（测试 memoryPanelManagerInstance.test.ts「多次注册
 *   onMemoryDiscuss 应覆盖前者」锁定此语义）。**不是** Node EventEmitter 的
 *   多订阅语义——引入多订阅会破坏既有行为契约。
 * - **emit 支持返回值透传**：回调返回非 void 时（如 cleanup-request 返回
 *   string[]），emit 原样返回；未注册时返回 undefined（调用方用 ?? 兜底）。
 *
 * 设计边界（复杂度守恒，YAGNI）：
 * - 不做 once / wildcard / 异步队列 / 错误隔离——当前面板无此需求，
 *   出现真实需求再按 ADR-017 Scenario A 扩展。
 */

/**
 * 监听器基类约束：`never[]` 参数在函数赋值逆变下与任意具体签名兼容，
 * 同时 K extends keyof 索引后保留精确签名（Parameters/ReturnType 推导不受损）。
 * 避免使用 Function / any（对齐 project-rules §7.1 禁 as any 精神）。
 */
export type AnyListener = (...args: never[]) => unknown;

/** 类型化事件总线：事件名 → 回调签名的泛型注册表 */
export class TypedEventBus<TEventMap extends Record<string, AnyListener>> {
  /** 事件 → 回调（单订阅：Map.set 天然覆盖） */
  private handlers = new Map<keyof TEventMap, TEventMap[keyof TEventMap]>();

  /** 注册回调（覆盖旧值，等价于旧 onXxx 赋值语义） */
  on<K extends keyof TEventMap>(event: K, cb: TEventMap[K]): void {
    this.handlers.set(event, cb);
  }

  /** 移除回调（新增能力：现有代码无 off 用法，cleanup 场景用 clear） */
  off<K extends keyof TEventMap>(event: K): void {
    this.handlers.delete(event);
  }

  /**
   * 触发回调，透传返回值
   *
   * @returns 回调返回值；未注册时返回 undefined（调用方用 ?? 兜底）
   */
  emit<K extends keyof TEventMap>(
    event: K,
    ...args: Parameters<TEventMap[K]>
  ): ReturnType<TEventMap[K]> | undefined {
    // Map.get 返回联合类型，此处断言为精确 K 签名（必要类型适配，AUDIT-TRIG-2 判定）
    const handler = this.handlers.get(event) as TEventMap[K] | undefined;
    return handler?.(...args);
  }

  /** 是否已注册 */
  has<K extends keyof TEventMap>(event: K): boolean {
    return this.handlers.has(event);
  }

  /** 清空全部回调（cleanup() 时调用，对齐 ADR-SP-015 §2「清空回调引用」） */
  clear(): void {
    this.handlers.clear();
  }
}
