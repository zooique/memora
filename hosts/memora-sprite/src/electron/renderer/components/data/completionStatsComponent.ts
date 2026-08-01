/**
 * 补全统计面板组件
 *
 * 职责（与原子补全统计渲染器一致）：
 * - 渲染补全统计聚合数据（采纳率 / Top-1 命中率 / 平均位置 / 展示数 / 采纳数 / 激活率 / 召回时刻）
 * - 渲染最近事件流（展示/采纳/对话轮次/召回时刻事件，最近 50 条）
 * - 渲染按日趋势柱状图（最近 14 天，B2 纵向养成曲线）
 * - 提供"重置统计"入口（清空 localStorage 数据）
 *
 * 组件化改造（HEAL-17 Phase B 试点，对齐 ui-engineering-mindset-rules §四.1 / §四.4）：
 * - 由 CompletionStatsRenderer 升级为 Component 子类，统一生命周期 mount/update/destroy
 * - mount() 仅构建一次骨架（标题栏 + 6 张度量卡 + 趋势区 + 事件流区），并绑定导出/重置按钮（仅一次）
 * - update() 增量刷新数据：6 张度量卡 value/hint 原地更新；趋势区/事件流区为可变长度结构，
 *   按规则许可「结构变更，需重建」局部重建内部子节点（section 容器本身持久）
 * - 消除原 render() 的 container.innerHTML='' 全量重建与每次重绑按钮（避免事件监听器重复绑定泄漏）
 * - 消除原 render() 的 document.getElementById 内部元素查找，内部元素引用统一通过 this.el + 持久化子引用
 *
 * 挂载点：#completion-stats-bar（index.html 预留的静态容器，默认 hidden），本组件根 el 为挂载其内的
 *   独立 wrapper，故 destroy() 移除的是组件自身 wrapper，不会误删静态容器（区别于 ModalManager 的静态容器模式）。
 *
 * 宿主注入：CompletionStatsHost（showToast），由 MemoryPanelManager 注入，用于导出失败反馈。
 */

import { Component } from '../base/Component.js';
import { createEl, createEmptyState } from '../../helpers/domHelpers.js';
import { setIcon } from '../../helpers/icon.js';
import {
  getCompletionMetrics,
  type CompletionEvent,
  type CompletionAggregated,
  type DailyAggregatedItem,
} from '../../helpers/completionMetrics.js';
import { reportError } from '../../helpers/errorHelpers.js';
import { getLocalDate } from '../../../../sprite/constants.js';

// ─── 常量 ────────────────────────────────────────────────

/** 最近事件展示条数 */
const RECENT_EVENTS_LIMIT = 50;

/** 按日趋势默认覆盖天数（B2 纵向养成曲线，2 周观察窗口） */
const DAILY_TREND_DAYS = 14;

// ─── 选项 / 宿主接口 ──────────────────────────────────────

/** 补全统计组件所需的宿主能力（跨模块关注点，由 MemoryPanelManager 注入） */
export interface CompletionStatsHost {
  /** 显示 toast 通知（导出失败等场景反馈） */
  showToast(message: string, type?: string, duration?: number): void;
}

/** CompletionStatsComponent 配置（对齐 Component<P> 泛型契约） */
export interface CompletionStatsOptions {
  /** 宿主能力（导出失败反馈等跨模块关注点，可选） */
  host?: CompletionStatsHost;
}

// ─── 度量卡定义（骨架 + 增量更新共用，固定 6 张，顺序即视觉顺序） ──

interface MetricDef {
  /** 卡片标签 */
  label: string;
  /** 是否强调色（R1 发布前提验证数，对应 .stat-card--accent） */
  accent: boolean;
  /** 由聚合数据计算展示值 + 副提示 */
  compute: (agg: CompletionAggregated) => { value: string; hint: string };
}

// ─── 组件 ────────────────────────────────────────────────

/**
 * 补全统计面板组件
 *
 * 由 MemoryPanelManager 持有实例（Manager 持有 Component，不直接 createElement，对齐 §四.4）：
 * - 面板首次打开：holder 调用 mount('#completion-stats-bar') 构建骨架并填充首屏数据
 * - 面板再次打开：holder 调用 update() 增量刷新（不重建骨架、不重绑按钮）
 * - 面板卸载：holder 调用 destroy() 移除 wrapper + 解绑事件
 */
export class CompletionStatsComponent extends Component<CompletionStatsOptions> {
  /** 重置统计回调（用户点击"重置统计"按钮时触发，Controller 调 metrics.clear()） */
  private resetCallback: (() => void) | null = null;

  // ─── 持久化的内部子元素引用（替代原 getElementById 内部查找） ──
  /** 6 张度量卡的值/副提示元素（固定顺序，与 METRIC_DEFS 对齐，update 时原地写） */
  private metricValueEls: HTMLElement[] = [];
  private metricHintEls: HTMLElement[] = [];
  /** 趋势区容器（update 时结构变更：按日条数可变，需重建内部） */
  private trendSectionEl: HTMLElement | null = null;
  /** 事件流区容器（update 时结构变更：事件条数可变，需重建内部） */
  private eventsSectionEl: HTMLElement | null = null;

  /** 度量卡定义（固定 6 张，顺序 = 视觉顺序：R1 组[激活率,召回时刻] + 效率组[采纳率,Top-1命中率,平均位置,展示数]） */
  private readonly METRIC_DEFS: MetricDef[] = [
    {
      label: '激活率',
      accent: true,
      compute: (a) => ({
        value: `${(a.activationRate * 100).toFixed(1)}%`,
        hint: `展示 ${a.totalShown} / 对话 ${a.totalChatTurns}`,
      }),
    },
    {
      label: '召回时刻',
      accent: true,
      compute: (a) => ({
        value: String(a.recallMoments),
        hint: `"你教过我 X" 可感知次数`,
      }),
    },
    {
      label: '采纳率',
      accent: false,
      compute: (a) => ({
        value: `${(a.adoptionRate * 100).toFixed(1)}%`,
        hint: `${a.totalAdopted} / ${a.totalShown}`,
      }),
    },
    {
      label: 'Top-1 命中率',
      accent: false,
      compute: (a) => ({
        value: `${(a.top1HitRate * 100).toFixed(1)}%`,
        hint: `采纳中首位占比`,
      }),
    },
    {
      label: '平均采纳位置',
      accent: false,
      compute: (a) => ({
        value: a.totalAdopted > 0 ? a.avgAdoptedPosition.toFixed(2) : '—',
        hint: `0 = 首位（最佳）`,
      }),
    },
    {
      label: '展示次数',
      accent: false,
      compute: (a) => ({
        value: String(a.totalShown),
        hint: `候选列表展示给用户`,
      }),
    },
  ];

  /**
   * 构造函数——只合并配置，无副作用（对齐 §四.1）
   *
   * @param options 组件配置（host 可选）
   */
  constructor(options: CompletionStatsOptions = {}) {
    super(options);
  }

  /**
   * 挂载到容器——构建骨架 + 首次填充数据
   *
   * 解析容器（字符串选择器 → HTMLElement），构建根 wrapper 后追加到容器；
   * 骨架（标题栏 + 6 度量卡 + 趋势区 + 事件流区）仅在此构建一次，导出/重置按钮仅绑定一次。
   *
   * @param container 容器元素或选择器（静态挂载点 #completion-stats-bar）
   * @returns this（链式调用）
   */
  mount(container: HTMLElement | string): this {
    const target = typeof container === 'string'
      ? document.querySelector<HTMLElement>(container)
      : container;
    if (!target) return this;

    // 根 wrapper：本组件自有根，区别于静态容器（destroy 仅移除 wrapper，不误删静态 #completion-stats-bar）
    const el = document.createElement('div');
    el.className = 'completion-stats-component';

    // ─── 标题栏 + 导出/重置/关闭按钮 ──
    const headerEl = createEl('div', 'completion-stats-header analysis-panel__header');
    headerEl.appendChild(createEl('span', 'completion-stats-title analysis-panel__title', '补全统计'));

    const actionsEl = createEl('div', 'completion-stats-actions');

    const exportBtn = createEl('button', 'btn btn-primary btn-sm', '导出');
    exportBtn.title = '导出统计 JSON（含聚合+趋势+事件流，用于回传度量数据）';
    exportBtn.type = 'button';
    const onExport = () => this.exportStatsJson();
    exportBtn.addEventListener('click', onExport);
    this.trackEvent(() => exportBtn.removeEventListener('click', onExport));
    actionsEl.appendChild(exportBtn);

    const resetBtn = createEl('button', 'btn btn-secondary btn-sm', '重置统计');
    resetBtn.title = '清空所有补全统计数据';
    resetBtn.type = 'button';
    const onReset = () => this.resetCallback?.();
    resetBtn.addEventListener('click', onReset);
    this.trackEvent(() => resetBtn.removeEventListener('click', onReset));
    actionsEl.appendChild(resetBtn);

    // 关闭按钮：复用 .panel-close-btn，经 memoryPanelEvents 在 #completion-stats-bar 上的事件委托触发 hideAnalysisPanel（不在此直接绑定）
    const closeBtn = createEl('button', 'panel-close-btn icon-btn flex-shrink-0', '');
    closeBtn.id = 'btn-close-completion-stats';
    closeBtn.title = '关闭补全统计';
    closeBtn.setAttribute('aria-label', '关闭补全统计');
    closeBtn.type = 'button';
    setIcon(closeBtn, 'icon-close');
    actionsEl.appendChild(closeBtn);

    headerEl.appendChild(actionsEl);
    el.appendChild(headerEl);

    // ─── R1 度量卡片组（激活率 + 召回时刻） ──
    const r1El = createEl('div', 'completion-stats-metrics completion-stats-metrics-r1');
    for (let i = 0; i < 2; i++) this.appendMetricCard(r1El, this.METRIC_DEFS[i]!);
    el.appendChild(r1El);

    // ─── 补全效率卡片组（采纳率 + Top-1 + 平均位置 + 展示数） ──
    const metricsEl = createEl('div', 'completion-stats-metrics');
    for (let i = 2; i < 6; i++) this.appendMetricCard(metricsEl, this.METRIC_DEFS[i]!);
    el.appendChild(metricsEl);

    // ─── 趋势区（update 时局部重建内部） ──
    this.trendSectionEl = createEl('div', 'completion-stats-trend-section');
    el.appendChild(this.trendSectionEl);

    // ─── 事件流区（update 时局部重建内部） ──
    this.eventsSectionEl = createEl('div', 'completion-stats-events-section');
    el.appendChild(this.eventsSectionEl);

    // 挂载到容器
    target.appendChild(el);
    this.el = el;

    // 首次填充数据
    this._renderData();

    return this;
  }

  /**
   * 追加一张度量卡到容器，并登记其 value/hint 元素引用（供 update 原地写）
   *
   * @param parent 卡片组容器
   * @param def 度量卡定义（标签/强调色/计算函数）
   */
  private appendMetricCard(parent: HTMLElement, def: MetricDef): void {
    const cardEl = createEl('div', def.accent ? 'stat-card stat-card--accent' : 'stat-card');
    cardEl.appendChild(createEl('div', 'stat-card__label', def.label));
    const valueEl = createEl('div', 'stat-card__value');
    const hintEl = createEl('div', 'stat-card__hint');
    cardEl.appendChild(valueEl);
    cardEl.appendChild(hintEl);
    parent.appendChild(cardEl);
    this.metricValueEls.push(valueEl);
    this.metricHintEls.push(hintEl);
  }

  /**
   * 增量更新内部状态——不重建骨架，仅刷新数据
   *
   * 6 张度量卡 value/hint 原地更新（固定结构）；
   * 趋势区 / 事件流区为可变长度结构，按规则许可「结构变更，需重建」局部重建内部子节点。
   *
   * @param newOptions 新的配置项（可选，目前仅 host 可热更新）
   * @returns this（链式调用）
   */
  update(newOptions: Partial<CompletionStatsOptions> = {}): this {
    if (newOptions.host !== undefined) {
      this.options = { ...this.options, host: newOptions.host };
    }
    if (!this.el) return this;
    this._renderData();
    return this;
  }

  /**
   * 渲染/刷新数据（骨架已就绪时调用）
   *
   * 读取 CompletionMetrics 单例的聚合 + 最近事件流 + 按日趋势，填入骨架。
   * 由 mount（首屏）与 update（增量刷新）共用，避免逻辑重复。
   */
  private _renderData(): void {
    const metrics = getCompletionMetrics();
    const aggregated = metrics.getAggregated();
    const recentEvents = metrics.getRecentEvents(RECENT_EVENTS_LIMIT);
    const dailyTrend = metrics.getDailyAggregated(DAILY_TREND_DAYS);

    // ─── 6 张度量卡：原地更新 value/hint（固定结构，零重建） ──
    for (let i = 0; i < this.METRIC_DEFS.length; i++) {
      const { value, hint } = this.METRIC_DEFS[i]!.compute(aggregated);
      if (this.metricValueEls[i]) this.metricValueEls[i]!.textContent = value;
      if (this.metricHintEls[i]) this.metricHintEls[i]!.textContent = hint;
    }

    // ─── 趋势区：结构变更（按日条数可变），需重建内部 ──
    this.renderTrendSection(dailyTrend);

    // ─── 事件流区：结构变更（事件条数可变），需重建内部 ──
    this.renderEventsSection(recentEvents);
  }

  /**
   * 渲染趋势区内部（清空后重建，结构可变）
   *
   * @param daily 按日聚合数据（升序）
   */
  private renderTrendSection(daily: DailyAggregatedItem[]): void {
    const section = this.trendSectionEl;
    if (!section) return;
    section.replaceChildren();

    const trendEl = createEl('div', 'completion-stats-trend');
    trendEl.appendChild(createEl('div', 'completion-stats-trend-title', '最近 14 天趋势'));

    const hasData = daily.some(d => d.shown > 0 || d.adopted > 0 || d.chatTurns > 0 || d.recallMoments > 0);
    if (!hasData) {
      trendEl.appendChild(createEmptyState({ title: '暂无趋势数据，使用 1-2 天后可见' }));
      section.appendChild(trendEl);
      return;
    }

    const maxShown = Math.max(1, ...daily.map(d => d.shown));
    const maxRecall = Math.max(1, ...daily.map(d => d.recallMoments));

    const legendEl = createEl('div', 'completion-stats-trend-legend');
    legendEl.appendChild(createLegendItem('completion-stats-trend-legend-shown', '展示'));
    legendEl.appendChild(createLegendItem('completion-stats-trend-legend-recall', '召回时刻'));
    trendEl.appendChild(legendEl);

    const chartEl = createEl('div', 'completion-stats-trend-chart');
    for (const item of daily) {
      chartEl.appendChild(this.createDailyBarEl(item, maxShown, maxRecall));
    }
    trendEl.appendChild(chartEl);

    section.appendChild(trendEl);
  }

  /**
   * 渲染事件流区内部（清空后重建，结构可变）
   *
   * @param events 最近事件列表（降序）
   */
  private renderEventsSection(events: CompletionEvent[]): void {
    const section = this.eventsSectionEl;
    if (!section) return;
    section.replaceChildren();

    if (events.length > 0) {
      const eventsEl = createEl('div', 'completion-stats-events');
      eventsEl.appendChild(createEl('div', 'completion-stats-events-title', `最近 ${events.length} 条事件`));
      const listEl = createEl('div', 'completion-stats-event-list');
      for (const event of events) {
        listEl.appendChild(this.createEventItemEl(event));
      }
      eventsEl.appendChild(listEl);
      section.appendChild(eventsEl);
    } else {
      section.appendChild(createEmptyState({ title: '暂无统计数据，开始使用补全功能后将自动记录' }));
    }
  }

  // ─── 内部渲染方法（复用原私有方法，纯结构构建，无状态副作用） ──

  /**
   * 导出统计 JSON 并触发浏览器下载（同原实现，零新增 IPC）
   */
  private exportStatsJson(): void {
    try {
      const metrics = getCompletionMetrics();
      const payload = {
        exportedAt: new Date().toISOString(),
        aggregated: metrics.getAggregated(),
        dailyTrend: metrics.getDailyAggregated(DAILY_TREND_DAYS),
        events: metrics.getRecentEvents(500),
      };
      const json = JSON.stringify(payload, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `memora-completion-stats-${getLocalDate()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      reportError('CompletionStatsExport', err, 'warn');
      this.options.host?.showToast('统计导出失败', 'error');
    }
  }

  /** 创建单日柱组元素（同原实现） */
  private createDailyBarEl(item: DailyAggregatedItem, maxShown: number, maxRecall: number): HTMLElement {
    const barGroupEl = createEl('div', 'completion-stats-trend-bar-group');
    const barsEl = createEl('div', 'completion-stats-trend-bars');

    const shownBarEl = createEl('div', 'completion-stats-trend-bar shown');
    const shownHeightPct = item.shown > 0 ? 4 + (item.shown / maxShown) * 96 : 0;
    shownBarEl.style.height = `${shownHeightPct}%`;
    shownBarEl.title = `展示 ${item.shown} 次`;
    barsEl.appendChild(shownBarEl);

    const recallBarEl = createEl('div', 'completion-stats-trend-bar recall');
    const recallHeightPct = item.recallMoments > 0 ? 4 + (item.recallMoments / maxRecall) * 96 : 0;
    recallBarEl.style.height = `${recallHeightPct}%`;
    recallBarEl.title = `召回时刻 ${item.recallMoments} 次`;
    barsEl.appendChild(recallBarEl);

    if (item.shown > 0) {
      barsEl.appendChild(createEl('div', 'completion-stats-trend-value', String(item.shown)));
    }

    barGroupEl.appendChild(barsEl);

    const dateLabel = item.date.slice(5);
    barGroupEl.appendChild(createEl('div', 'completion-stats-trend-date', dateLabel));

    return barGroupEl;
  }

  /** 创建事件列表项元素（同原实现） */
  private createEventItemEl(event: CompletionEvent): HTMLElement {
    const itemEl = createEl('div', 'completion-stats-event-item');
    const typeBadge = this.getEventBadge(event.type);
    const typeEl = createEl('span', `completion-stats-event-type ${typeBadge.class} flex-shrink-0`, typeBadge.label);
    itemEl.appendChild(typeEl);

    const detailEl = createEl('span', 'completion-stats-event-detail');
    switch (event.type) {
      case 'shown':
        detailEl.textContent = `query ${event.queryLen} 字 → ${event.shownCount} 候选`;
        break;
      case 'adopted': {
        const positionLabel = event.adoptedPosition === 0 ? 'Top-1' : `#${event.adoptedPosition + 1}`;
        detailEl.textContent = `query ${event.queryLen} 字 → 采纳 ${positionLabel}`;
        break;
      }
      case 'chat-turn':
        detailEl.textContent = `用户发送对话`;
        break;
      case 'recall-moment':
        detailEl.textContent = `召回 ${event.recallCount} 条记忆`;
        break;
    }
    itemEl.appendChild(detailEl);

    const timeEl = createEl('span', 'completion-stats-event-time flex-shrink-0');
    const time = new Date(event.timestamp);
    timeEl.textContent = time.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    timeEl.title = event.timestamp;
    itemEl.appendChild(timeEl);

    return itemEl;
  }

  /** 获取事件类型徽章的样式类与标签（同原实现） */
  private getEventBadge(type: CompletionEvent['type']): { class: string; label: string } {
    switch (type) {
      case 'shown':
        return { class: 'shown', label: '展示' };
      case 'adopted':
        return { class: 'adopted', label: '采纳' };
      case 'chat-turn':
        return { class: 'chat-turn', label: '对话' };
      case 'recall-moment':
        return { class: 'recall-moment', label: '召回' };
    }
  }

  /**
   * 注册重置统计回调（由 MemoryPanelManager 委托转发）
   *
   * @param cb 回调函数
   */
  onResetStats(cb: () => void): void {
    this.resetCallback = cb;
  }

  /**
   * 销毁组件——彻底清理
   *
   * 先 nullify 组件自身引用，再调用基类 destroy()（移除 wrapper + 解绑导出/重置按钮监听）。
   * 关闭按钮未直接绑定，交由 memoryPanelEvents 委托处理，无需在此清理。
   */
  destroy(): void {
    this.resetCallback = null;
    super.destroy();
  }
}

/**
 * 创建图例项元素（模块级私有工具，同原实现）
 *
 * @param colorClass 颜色样式类
 * @param label 图例文字
 */
function createLegendItem(colorClass: string, label: string): HTMLElement {
  const itemEl = createEl('div', 'completion-stats-trend-legend-item');
  itemEl.appendChild(createEl('span', `completion-stats-trend-legend-dot ${colorClass}`));
  itemEl.appendChild(createEl('span', 'completion-stats-trend-legend-text', label));
  return itemEl;
}
