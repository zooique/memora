/**
 * Component 抽象基类
 *
 * 所有 JS 层组件的统一生命周期契约（HEAL-17 Phase 0）：
 *   - new(options)     创建实例（构造函数只合并配置，无副作用）
 *   - mount(container) 挂载到 DOM
 *   - update(options)  增量更新内部状态
 *   - destroy()        解绑事件 + 移除 DOM + nullify 引用
 *
 * 设计原则（对齐 ui-engineering-mindset-rules §四.1）：
 *   - 构造函数只做配置合并 + 字段初始化，不做副作用
 *   - mount() 后 this.el 必须指向根 DOM 元素
 *   - update() 增量更新，不重建 DOM（避免丢失焦点/滚动/过渡）
 *   - destroy() 彻底清理，残留引用 = 内存泄漏
 *
 * 与现有 Manager 模式的关系（对齐 §四.4）：
 *   - Manager 的 init() + cleanup() 是生命周期的雏形
 *   - Component 是 Manager 内部 DOM 操作的替代者
 *   - Manager 持有 Component 实例，不直接 createElement
 *
 * 与现有 EventTracker 的关系：
 *   - EventTracker 是事件清理的统一工具，Component 内部使用 trackEvent 与之兼容
 *   - 现有 Manager 可同时持有 EventTracker（管理自身事件）+ Component 实例（管理子组件事件）
 *   - Component.destroy() 内置事件清理，无需额外 EventTracker（除非子类有大量外部事件）
 *
 * @template P 组件配置（Props）类型
 */

/**
 * 组件清理函数类型——所有需要清理的资源（事件解绑/定时器/引用 nullify）都包装为此类型
 */
type CleanupFn = () => void;

export abstract class Component<P = Record<string, unknown>> {
  /** 合并后的配置（构造函数合并 defaults + options） */
  protected options: P;
  /** 组件根 DOM 元素（mount() 后赋值，destroy() 后 nullify） */
  protected el: HTMLElement | null = null;
  /** 事件解绑函数列表（mount 时通过 trackEvent 收集，destroy 时统一调用） */
  private readonly _cleanups: CleanupFn[] = [];
  /** 组件是否已销毁（防止重复 destroy） */
  private _destroyed = false;

  /**
   * 构造函数——只做配置合并，不做副作用
   *
   * 副作用（DOM 查询、事件绑定、请求发起）放在 mount() 后。
   *
   * 注：设为 protected 强制子类显式声明 public 构造函数，
   * 避免基类被误用 `new Component()` 直接实例化（abstract 已阻止，但双保险）。
   * 子类应按需声明 `constructor(options: XXXOptions) { super(options); }`。
   *
   * @param options 组件配置
   */
  protected constructor(options: P) {
    this.options = { ...options };
  }

  /**
   * 挂载到容器——DOM 已就绪后才能调用
   *
   * 子类必须实现：
   *   1. 创建根 DOM 元素赋值给 this.el
   *   2. 绑定事件（通过 trackEvent 收集解绑函数）
   *   3. 将 this.el 追加到 container
   *
   * @param container 容器元素或选择器
   * @returns this（链式调用）
   */
  abstract mount(container: HTMLElement | string): this;

  /**
   * 增量更新内部状态——不重建 DOM
   *
   * 子类应通过 textContent / classList.toggle / setAttribute 等增量操作更新。
   * 当确实需要重建（结构变化）时，子类应明确注释「结构变更，需重建」。
   *
   * @param newOptions 新的配置项（与构造函数 options 同类型，部分字段可选）
   * @returns this（链式调用）
   */
  abstract update(newOptions: Partial<P>): this;

  /**
   * 销毁组件——彻底清理
   *
   * 子类应 override 并在最后调用 super.destroy()：
   *   1. 解绑所有事件（super 已处理 _cleanups）
   *   2. 移除 DOM 元素（super 已处理 el.remove()）
   *   3. nullify 子类自己的字段引用
   *   4. 调用 super.destroy() 完成通用清理
   *
   * 防重复销毁：已销毁的组件再次调用 destroy() 是 no-op。
   */
  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;

    /** 执行所有收集的解绑函数（事件 / 定时器 / 自定义清理） */
    for (const cleanup of this._cleanups) {
      try {
        cleanup();
      } catch {
        // 单个清理失败不影响其他清理（防御性，正常不应触发）
      }
    }
    this._cleanups.length = 0;

    /** 移除根 DOM 元素 */
    this.el?.remove();
    this.el = null;
  }

  /**
   * 收集清理函数——子类在 mount() 中调用
   *
   * 用于事件解绑、定时器清理、引用 nullify 等任何需要在 destroy 时执行的清理。
   * destroy() 时统一调用，避免遗漏。
   *
   * 使用示例（事件解绑）：
   * ```
   * const handleClick = () => this.hide();
   * this.el.addEventListener('click', handleClick);
   * this.trackEvent(() => this.el?.removeEventListener('click', handleClick));
   * ```
   *
   * 使用示例（定时器清理）：
   * ```
   * const timer = setTimeout(() => this.hide(), 3000);
   * this.trackEvent(() => clearTimeout(timer));
   * ```
   *
   * @param cleanup 清理函数
   */
  protected trackEvent(cleanup: CleanupFn): void {
    this._cleanups.push(cleanup);
  }

  /**
   * 获取根 DOM 元素——外部访问组件的唯一锚点
   *
   * 外部通过 component.getElement() 访问根元素（如父组件 appendChild(child.getElement())）。
   * 但外部不应访问 el.children 或内部结构——el 是挂载锚点，不是内部 API。
   *
   * @returns 根 DOM 元素（未挂载或已销毁时为 null）
   */
  getElement(): HTMLElement | null {
    return this.el;
  }

  /**
   * 组件是否已销毁
   *
   * 子类或外部可查询此状态，避免在销毁后操作组件。
   *
   * @returns true 表示已销毁，不可再使用
   */
  isDestroyed(): boolean {
    return this._destroyed;
  }
}
