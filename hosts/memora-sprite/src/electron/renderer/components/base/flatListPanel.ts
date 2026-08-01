/**
 * FlatListPanel —— 扁平列表面板声明式工厂（§四.2 声明式工厂）
 *
 * 覆盖 audit / workProjection 两类"单容器 + 单 load 返回 T[] + 计数 + 刷新 + 空/错态"
 * 的扁平列表面板。共同点（容器采纳、计数更新、刷新绑定、空态、错误态、事件清理）入工厂；
 * 差异（load / renderRow / emptyText / errorText / 行布局）收敛为配置。
 *
 * 设计约束：
 * - 采纳 index.html 静态列表容器为 this.el（与 Phase B 各 Component 同模式）。
 *   静态容器为共享元素，destroy 时不移除——destroy() 先清理行级监听、再置 this.el=null、再 super.destroy()。
 * - load 返回数组 T[]（对齐 audit/work 真实 IPC 形态），非 {items,total} 亦非 {entries}。
 * - customRender 为逃生舱：当默认"clearElement + 逐行 renderRow"无法满足时
 *   （如 work 行内展开 + 空态引导 hint），由调用方接管整段渲染；工厂向其注入
 *   rowEvents（EventTracker）以便行级交互监听被正确清理（防 customRender 架空工厂）。
 * - 不含 search / 模态 detail（memory 异类，不纳入）。
 * - profile 因"双列表 + 单 fetch 返回 {entries} + 无外层包裹 + 双计数"被刻意排除
 *   （与 memory 同级），否则需为单消费者撑大工厂契约 → God Object 风险（§四.2）。
 */
import { Component } from './Component.js';
import { EventTracker } from '../../helpers/eventTracker.js';
import { getOptionalElement, clearElement, createEmptyState } from '../../helpers/domHelpers.js';
import { bindRefreshButton } from '../../helpers/buttonHelpers.js';
import { renderErrorState } from '../../helpers/errorState.js';

/**
 * 扁平列表面板配置（§四.2「配置项应声明完整契约」）
 *
 * @template T 列表项类型
 */
export interface FlatListPanelOptions<T> {
  /** 静态列表容器 id（不含 #；mount 时拼 # 选择器采纳为 this.el） */
  listContainerId: string;
  /** 计数元素 id（可选；渲染后更新 textContent 为条目数） */
  countElId?: string;
  /** 刷新按钮 id（可选；绑定 click → loading → load） */
  refreshBtnId?: string;
  /** 数据加载函数：返回数组 T[]（对齐 audit/work 真实 IPC 形态；profile 返回 {entries} 故排除） */
  load: () => Promise<T[]>;
  /** 行渲染：将单项渲染为 DOM 元素（调用方负责 XSS 安全）；仅在未提供 customRender 时必填 */
  renderRow?: (item: T, index: number) => HTMLElement;
  /** 空态标题 */
  emptyText: string;
  /** 错误文案构建（可选；默认 String(err)） */
  errorText?: (err: unknown) => string;
  /**
   * 逃生舱：自定义整段渲染（默认 clearElement + 逐行 renderRow 追加）。
   * 第三个参数 rowEvents 为工厂注入的行级事件追踪器——自定义渲染中的交互监听
   * （如 work 的展开按钮）须经其绑定，方能在下次渲染/销毁时被正确清理。
   */
  customRender?: (container: HTMLElement, items: T[], rowEvents: EventTracker) => void;
}

/**
 * 扁平列表工厂组件。
 *
 * 这是 §四.2「≥3 结构相似面板抽工厂」的最小可行实现：覆盖 audit / workProjection
 * 两个真正结构相似的单容器扁平列表（无 search、无 detail）。
 * memory（list+search+detail+分页）与 profile（双列表 + {entries} 返回 + 双计数）
 * 因结构异类被刻意排除，避免为单消费者撑大契约 → God Object（§四.2）。
 */
export class FlatListPanel<T> extends Component<FlatListPanelOptions<T>> {
  /** mount-once 监听（刷新按钮），destroy 时经 trackEvent 统一清理 */
  private readonly _events = new EventTracker();
  /** 行级监听（customRender 中绑定，每次 _renderItems 重建前清理，防跨刷新累积泄漏） */
  private readonly _rowEvents = new EventTracker();
  private _countEl: HTMLElement | null = null;

  public constructor(options: FlatListPanelOptions<T>) {
    super(options);
  }

  mount(container: HTMLElement | string = `#${this.options.listContainerId}`): this {
    if (this.el) return this; // 幂等：已挂载则不重复（对齐 Manager.init 幂等保护）
    const target =
      typeof container === 'string'
        ? document.querySelector<HTMLElement>(container)
        : container;
    if (!target) return this; // 静态容器缺失，静默降级（不抛错，对齐既有 Manager 权衡）
    this.el = target;

    this._countEl = this.options.countElId
      ? document.getElementById(this.options.countElId)
      : null;

    if (this.options.refreshBtnId) {
      const btn = getOptionalElement(this.options.refreshBtnId, 'button');
      if (btn) {
        // 刷新按钮 → loading → 异步 load，标准模式由 bindRefreshButton 收口
        bindRefreshButton(btn, this._events, () => this.load());
      }
    }
    // 刷新按钮监听统一由 Component.destroy() 经此 cleanup 解绑
    this.trackEvent(() => this._events.cleanup());

    return this;
  }

  /**
   * 加载并渲染列表。
   * 失败渲染错误态（含重试按钮 → 重新 load）。
   */
  async load(): Promise<void> {
    const el = this.el;
    if (!el) return;
    let items: T[];
    try {
      items = await this.options.load();
    } catch (err) {
      this.renderError(
        this.options.errorText ? this.options.errorText(err) : `加载失败: ${String(err)}`,
      );
      return;
    }
    this._renderItems(items);
  }

  /**
   * 渲染错误态（含重试按钮）。供 Manager 在清空失败等非 load 路径复用。
   * 重试按钮属"随渲染重生"的元素，纳入 _rowEvents 以便下次渲染/销毁时清理。
   */
  renderError(message: string): void {
    const el = this.el;
    if (!el) return;
    renderErrorState(el, message, () => {
      void this.load();
    }, this._rowEvents);
  }

  /**
   * 渲染列表项。空态与有数据态结构不同，故此处属「结构变更，需重建」（§四.1 许可）。
   */
  private _renderItems(items: T[]): void {
    const el = this.el;
    if (!el) return;
    // 先解绑上一轮渲染绑定的行级监听（customRender 注入），避免跨刷新累积泄漏
    this._rowEvents.cleanup();
    if (this._countEl) this._countEl.textContent = String(items.length);

    // customRender 拥有整段渲染权（含空态），优先于默认分支
    if (this.options.customRender) {
      this.options.customRender(el, items, this._rowEvents);
      return;
    }

    if (items.length === 0) {
      clearElement(el);
      el.appendChild(createEmptyState({ title: this.options.emptyText }));
      return;
    }

    if (!this.options.renderRow) return; // 防御：既无 customRender 又无 renderRow，配置不完整
    const renderRow = this.options.renderRow;
    const frag = document.createDocumentFragment();
    items.forEach((item, i) => frag.appendChild(renderRow(item, i)));
    clearElement(el);
    el.appendChild(frag);
  }

  update(newOptions: Partial<FlatListPanelOptions<T>>): this {
    Object.assign(this.options, newOptions);
    return this;
  }

  /**
   * 销毁：先清理行级监听（随渲染重生），再置 this.el=null（静态容器不移除，共享元素），
   * 最后 super.destroy() 经 trackEvent 清理刷新按钮监听。
   */
  destroy(): void {
    this._rowEvents.cleanup();
    this.el = null;
    super.destroy();
  }
}
