/**
 * 洞察组件 — 仪表盘内"记忆洞察"子区域渲染（Component 化，对齐 §四.1 / §四.4）
 *
 * 职责（与原子 InsightsRenderer 一致）：
 * - 显示洞察面板加载态（IPC 调用前）
 * - 渲染记忆洞察数据（统计卡片 + source 分布条形图 + 关系摘要）
 * - 显示加载失败状态（带重试按钮，触发回调重新拉取数据）
 *
 * 组件化改造（HEAL-17 Phase B，对齐 ui-engineering-mindset-rules §四.1 / §四.4）：
 * - 由 InsightsRenderer 升级为 Component 子类，统一生命周期 mount/update/destroy
 * - 采用「采纳静态容器」变体：#memory-insights-bar 是 index.html 预留的富骨架静态容器
 *   （header + 统计卡 + 来源分布 + 最近关系），mount() 直接将其采纳为 this.el 并缓存内部引用，
 *   不再用 document.getElementById 查内部元素（规则 §四.1 消除「组件查自身外部 DOM」反模式）
 * - update({dashboard, graph}) 增量刷新统计卡片；source 分布 / 关系摘要属结构可变，
 *   按规则许可「结构变更，需重建」（clearElement 后重建子节点，无副作用）。
 * - destroy() 不移除静态容器：#memory-insights-bar 由面板管理（仅 hidden 不销毁），
 *   故销毁前将 this.el 置 null，使基类 destroy 跳过 el.remove()，仅清理事件与引用
 *   （与 HealthDashboardComponent 同模式）。
 *
 * 由 MemoryPanelManager 持有实例（Manager 持有 Component，不直接操作 DOM，对齐 §四.4）。
 * 关闭按钮 #btn-close-insights 由 memoryPanelEvents 在 #memory-insights-bar 上委托处理，组件不绑定。
 */

import { Component } from '../base/component.js';
import { clearElement, createEl, showPanelLoading } from '../../helpers/domHelpers.js';
// getSourceLabel 将 source 字符串映射为中文标签（UX-2：source 分布条形图标签中文化）
import { getSourceLabel } from '../../helpers/sourceLabel.js';
import { getSourceColorClass } from '../../helpers/sourceColor.js';
import type { RelationGraphData } from '../relationGraph.js';

// ─── 类型定义 ────────────────────────────────────────────

/** 洞察面板所需的仪表盘数据子集 */
export interface InsightsDashboardData {
  /** 记忆总数 */
  total: number;
  /** 各 source 类型对应的记忆数量 */
  bySource: Record<string, number>;
  /** 冲突数（优先使用，若未提供则从 edges 推断） */
  conflictCount?: number;
}

/** 关系摘要最多展示的条数 */
const MAX_RELATION_ITEMS = 3;

/** 洞察组件配置（对齐 Component<P> 泛型契约；字段可选，由 update 传入） */
export interface InsightsOptions {
  /** 仪表盘数据子集（total/bySource/conflictCount） */
  dashboard?: InsightsDashboardData;
  /** 关系图谱数据 */
  graph?: RelationGraphData;
}

// ─── 洞察组件 ────────────────────────────────────────────

/**
 * 洞察组件
 *
 * 负责仪表盘内"记忆洞察"子区域的全部渲染逻辑。
 * 由 MemoryPanelManager 持有，通过外观方法委托调用。
 */
export class InsightsComponent extends Component<InsightsOptions> {
  // ─── 持久化内部引用（替代原 9 处 getElementById 内部查找，均为 #memory-insights-bar 子树内元素） ──
  private totalEl: HTMLElement | null = null;
  private relationsEl: HTMLElement | null = null;
  private conflictsEl: HTMLElement | null = null;
  private sourcesEl: HTMLElement | null = null;
  private totalBadgeEl: HTMLElement | null = null;
  private distEl: HTMLElement | null = null;
  private summaryEl: HTMLElement | null = null;

  /** 重试加载洞察数据回调（用户点击重试按钮时触发） */
  private reloadCallback: (() => void) | null = null;

  /**
   * 构造函数——只合并配置，无副作用（对齐 §四.1）
   *
   * @param options 组件配置（dashboard/graph 可选，由 update 传入）
   */
  constructor(options: InsightsOptions = {}) {
    super(options);
  }

  /**
   * 挂载到容器——采纳静态容器为根 + 缓存内部引用
   *
   * #memory-insights-bar 是 index.html 预留的富骨架（header + 统计卡 + 来源分布 + 最近关系），
   * 组件直接将其采纳为 this.el（不新建 wrapper），并在子树内缓存各内部元素引用，
   * 后续 update/showLoading/showError 仅通过这些引用原地操作，杜绝 getElementById。
   * 容器缺失时安全降级（返回 this，el 保持 null）。
   *
   * @param container 容器元素或选择器（静态挂载点 #memory-insights-bar）
   * @returns this（链式调用）
   */
  mount(container: HTMLElement | string): this {
    const target = typeof container === 'string'
      ? document.querySelector<HTMLElement>(container)
      : container;
    if (!target) return this;

    this.el = target;

    // ─── 缓存内部引用（this.el 子树内查找） ──
    this.totalBadgeEl = this.el.querySelector('#insights-total-badge');
    this.totalEl = this.el.querySelector('#insights-total');
    this.relationsEl = this.el.querySelector('#insights-relations');
    this.conflictsEl = this.el.querySelector('#insights-conflicts');
    this.sourcesEl = this.el.querySelector('#insights-sources');
    this.distEl = this.el.querySelector('#insights-distribution');
    this.summaryEl = this.el.querySelector('#insights-relations-summary');

    return this;
  }

  /**
   * 增量更新内部状态——不重建 DOM（统计卡片原地写；分布/摘要按结构变更重建子节点）
   *
   * @param newOptions 新的配置项（dashboard / graph 变化时刷新渲染）
   * @returns this（链式调用）
   */
  update(newOptions: Partial<InsightsOptions> = {}): this {
    if (newOptions.dashboard) {
      this.options = { ...this.options, dashboard: newOptions.dashboard };
    }
    if (newOptions.graph) {
      this.options = { ...this.options, graph: newOptions.graph };
    }
    if (!this.el) return this;
    const { dashboard, graph } = this.options;
    if (!dashboard || !graph) return this;
    this._renderData(dashboard, graph);
    return this;
  }

  /**
   * 显示洞察面板加载态（IPC 调用前调用）
   *
   * 同时在 source 分布区域和关系摘要区域插入加载态占位。
   */
  showLoading(): void {
    if (this.distEl) showPanelLoading(this.distEl, '加载洞察数据…');
    if (this.summaryEl) showPanelLoading(this.summaryEl, '加载关系数据…');
  }

  /**
   * 显示洞察面板加载失败状态（带重试按钮）
   *
   * 在 source 分布区域和关系摘要区域分别渲染重试按钮。
   * 用户点击重试按钮时触发 onReloadInsights 回调，由 Controller 重新拉取数据。
   */
  showError(): void {
    if (this.distEl) this.renderErrorWithRetry(this.distEl);
    if (this.summaryEl) this.renderErrorWithRetry(this.summaryEl);
  }

  /**
   * 注册重试加载洞察数据回调
   *
   * 用户点击重试按钮时触发，由 Controller 重新拉取数据。
   *
   * @param cb 回调函数
   */
  onReloadInsights(cb: () => void): void {
    this.reloadCallback = cb;
  }

  /**
   * 销毁组件——彻底清理
   *
   * 先清空 reloadCallback 与引用，再调用基类 destroy。
   * 注意：静态容器 #memory-insights-bar 为共享挂载点（由面板管理，仅 hidden 不销毁），
   * destroy 不应移除它——故先置 this.el = null，使基类 destroy 跳过 el.remove()，
   * 仅执行 _cleanups 与 this.el 置空。关闭按钮未直接绑定，交由 memoryPanelEvents 委托处理。
   */
  destroy(): void {
    this.reloadCallback = null;
    this.el = null;
    super.destroy();
  }

  // ─── 私有辅助方法 ──────────────────────────────────────

  /**
   * 渲染记忆洞察数据（统计卡片 + source 分布 + 关系摘要）
   *
   * 统计卡片逐行原地写；source 分布 / 关系摘要结构可变，clearElement 后重建（规则许可的「结构变更，需重建」）。
   *
   * @param dashboard 仪表盘数据子集
   * @param graph 关系图谱数据
   */
  private _renderData(dashboard: InsightsDashboardData, graph: RelationGraphData): void {
    // ─── 统计卡片（增量，原地写） ──────────────────────
    if (this.totalEl) this.totalEl.textContent = String(dashboard.total);
    // 顶部状态徽章同步总数（信息语义，固定青色 good）
    if (this.totalBadgeEl) this.totalBadgeEl.textContent = `${dashboard.total} 条记忆`;
    if (this.relationsEl) this.relationsEl.textContent = String(graph.edges.length);
    // 冲突数：优先用后端传的 conflictCount，fallback 从 edges 过滤（向后兼容）
    const conflictCount = dashboard.conflictCount ?? graph.edges.filter((e) => e.type === 'contradicts').length;
    if (this.conflictsEl) {
      this.conflictsEl.textContent = String(conflictCount);
      // 有冲突时红色高亮警示
      this.conflictsEl.classList.toggle('has-conflicts', conflictCount > 0);
    }
    if (this.sourcesEl) this.sourcesEl.textContent = String(Object.keys(dashboard.bySource).length);

    // ─── source 分布条形图（结构变更，需重建） ──────────
    if (this.distEl) {
      clearElement(this.distEl);
      const sources = Object.entries(dashboard.bySource).sort((a, b) => b[1] - a[1]);
      const maxCount = Math.max(1, ...sources.map((s) => s[1]));
      for (const [source, count] of sources) {
        const bar = createEl('div', 'dist-bar');
        bar.title = `${getSourceLabel(source)}: ${count} 条`;

        const label = createEl('span', 'dist-bar__label text-truncate', getSourceLabel(source));

        const fill = createEl('div', `dist-bar__fill source-${getSourceColorClass(source)}`);
        fill.style.width = `${(count / maxCount) * 100}%`;

        const countSpan = createEl('span', 'dist-bar__count', String(count));

        bar.appendChild(label);
        bar.appendChild(fill);
        bar.appendChild(countSpan);
        this.distEl.appendChild(bar);
      }
    }

    // ─── 关系摘要：最近 3 条关系（结构变更，需重建） ──
    if (this.summaryEl) {
      clearElement(this.summaryEl);
      if (graph.edges.length === 0) {
        this.summaryEl.textContent = '暂无关系数据';
      } else {
        // 构建节点 id → name 映射
        const nodeNameMap = new Map(graph.nodes.map((n) => [n.id, n.name]));
        // 按时间倒序
        const recentEdges = [...graph.edges]
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
          .slice(0, MAX_RELATION_ITEMS);

        const title = createEl('div', 'panel-section-title', '最近关系');
        this.summaryEl.appendChild(title);

        for (const edge of recentEdges) {
          const item = createEl('div', 'relation-item');

          const sourceName = nodeNameMap.get(edge.sourceId) ?? edge.sourceId;
          const targetName = nodeNameMap.get(edge.targetId) ?? edge.targetId;

          const typeTag = createEl('span', `relation-type-tag relation-type-${edge.type}`, edge.type);

          const desc = createEl('span', 'relation-desc text-truncate', `${sourceName} → ${targetName}`);

          item.appendChild(typeTag);
          item.appendChild(desc);
          this.summaryEl.appendChild(item);
        }
      }
    }
  }

  /**
   * 在指定容器内渲染"加载失败"文案 + 重试按钮
   *
   * 在指定容器内渲染加载失败文案 + 重试按钮（distEl 和 summaryEl 两处复用）。
   * 重试按钮监听经 trackEvent 收集，组件 destroy 时统一解绑（替代原独立 EventTracker）。
   *
   * @param container 目标容器（distEl 或 summaryEl）
   */
  private renderErrorWithRetry(container: HTMLElement): void {
    clearElement(container);
    container.textContent = '加载失败';
    const retryBtn = createEl('button', 'panel-error-btn inline-retry-btn', '重试');
    const handler = () => this.reloadCallback?.();
    retryBtn.addEventListener('click', handler);
    this.trackEvent(() => retryBtn.removeEventListener('click', handler));
    container.appendChild(retryBtn);
  }
}
