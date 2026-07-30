/**
 * 补全统计面板渲染器
 *
 * 职责：
 * - 渲染补全统计聚合数据（采纳率 / Top-1 命中率 / 平均位置 / 展示数 / 采纳数 / 激活率 / 召回时刻）
 * - 渲染最近事件流（展示/采纳/对话轮次/召回时刻事件，最近 50 条）
 * - 渲染按日趋势柱状图（最近 14 天，B2 纵向养成曲线）
 * - 提供"重置统计"入口（清空 localStorage 数据）
 *
 * 设计原则（遵循 ADR-SP-015 组合模式）：
 * - 模式 C（自包含 EventTracker）：重置按钮事件通过 EventTracker 统一管理
 * - 模式 D 衍生：onResetStats() 回调注册接口与外部协作（Controller 调 metrics.clear()）
 * - 由 MemoryPanelManager 持有实例，作为第 3 个 analysis panel
 *
 * 数据来源：
 * - CompletionMetrics 单例（getCompletionMetrics()），localStorage 持久化
 * - 打开面板时实时调用 getAggregated() + getRecentEvents() + getDailyAggregated() 渲染
 */

import { EventTracker } from '../helpers/eventTracker.js';
import { createEl, createEmptyState } from '../helpers/domHelpers.js';
import { setIcon } from '../helpers/icon.js';
import { getCompletionMetrics, type CompletionEvent, type DailyAggregatedItem } from '../helpers/completionMetrics.js';
import { reportError } from '../helpers/errorHelpers.js';
import { getLocalDate } from '../../../sprite/constants.js';

// ─── 常量 ────────────────────────────────────────────────

/** 统计面板根容器 DOM ID（index.html 中预留） */
const STATS_CONTAINER_ID = 'completion-stats-bar';

/** 最近事件展示条数 */
const RECENT_EVENTS_LIMIT = 50;

/** 按日趋势默认覆盖天数（B2 纵向养成曲线，2 周观察窗口） */
const DAILY_TREND_DAYS = 14;

// ─── 渲染器 ────────────────────────────────────────────────

/**
 * 补全统计面板渲染器
 *
 * 负责在 #completion-stats-bar 容器内渲染聚合统计 + 最近事件流。
 * 由 MemoryPanelManager 持有，打开面板时调用 render() 刷新数据。
 */
/** 补全统计渲染器所需的宿主能力（跨模块关注点，由 MemoryPanelManager 注入） */
interface CompletionStatsHost {
  /** 显示 toast 通知（导出失败等场景反馈） */
  showToast(message: string, type?: string, duration?: number): void;
}

export class CompletionStatsRenderer {
  /** 事件监听器跟踪器（统一管理重置按钮事件） */
  private events = new EventTracker();

  constructor(private host?: CompletionStatsHost) {}

  /** 重置统计回调（用户点击"重置统计"按钮时触发，Controller 调 metrics.clear()） */
  private resetCallback: (() => void) | null = null;

  // ─── 回调注册 ──────────────────────────────────────────

  /**
   * 注册重置统计回调
   *
   * 用户点击"重置统计"按钮时触发，Controller 负责调用 metrics.clear() 并重新渲染。
   *
   * @param cb 回调函数
   */
  onResetStats(cb: () => void): void {
    this.resetCallback = cb;
  }

  // ─── 资源清理 ──────────────────────────────────────────

  /**
   * 清理事件监听器（页面卸载时调用）
   */
  cleanup(): void {
    this.events.cleanup();
    this.resetCallback = null;
  }

  // ─── 渲染方法 ──────────────────────────────────────────

  /**
   * 渲染补全统计面板
   *
   * 从 CompletionMetrics 单例读取聚合数据 + 最近事件流 + 按日趋势，渲染到容器。
   * 每次打开面板时调用（实时刷新，无缓存）。
   */
  render(): void {
    const container = document.getElementById(STATS_CONTAINER_ID);
    if (!container) return;

    // 清空旧内容 + 清理旧事件
    this.events.cleanup();
    container.innerHTML = '';

    const metrics = getCompletionMetrics();
    const aggregated = metrics.getAggregated();
    const recentEvents = metrics.getRecentEvents(RECENT_EVENTS_LIMIT);
    const dailyTrend = metrics.getDailyAggregated(DAILY_TREND_DAYS);

    // ─── 标题栏 + 导出/重置/关闭按钮（统一外壳 + 通用 .btn） ──
    const headerEl = createEl('div', 'completion-stats-header analysis-panel__header');
    headerEl.appendChild(createEl('span', 'completion-stats-title analysis-panel__title', '补全统计'));

    // 按钮组容器（导出 + 重置 + 关闭并排，主动可见）
    const actionsEl = createEl('div', 'completion-stats-actions');

    // 导出按钮：渲染层 Blob 下载，零新增 IPC，beta 用户可回传统计 JSON 闭合度量环
    const exportBtn = createEl('button', 'btn btn-primary btn-sm', '导出');
    exportBtn.title = '导出统计 JSON（含聚合+趋势+事件流，用于回传度量数据）';
    exportBtn.type = 'button';
    this.events.addEventListener(exportBtn, 'click', () => {
      this.exportStatsJson();
    });
    actionsEl.appendChild(exportBtn);

    const resetBtn = createEl('button', 'btn btn-secondary btn-sm', '重置统计');
    resetBtn.title = '清空所有补全统计数据';
    resetBtn.type = 'button';
    this.events.addEventListener(resetBtn, 'click', () => {
      this.resetCallback?.();
    });
    actionsEl.appendChild(resetBtn);

    // 关闭按钮：复用 .panel-close-btn，经 memoryPanelEvents 在 #completion-stats-bar 上的事件委托触发 hideAnalysisPanel
    const closeBtn = createEl('button', 'panel-close-btn icon-btn flex-shrink-0', '');
    closeBtn.id = 'btn-close-completion-stats';
    closeBtn.title = '关闭补全统计';
    closeBtn.setAttribute('aria-label', '关闭补全统计');
    closeBtn.type = 'button';
    setIcon(closeBtn, 'icon-close');
    actionsEl.appendChild(closeBtn);

    headerEl.appendChild(actionsEl);
    container.appendChild(headerEl);

    // ─── R1 度量卡片组（激活率 + 召回时刻） ──────────────
    // 放在最前——R1 是"发布前提验证"的核心三数之一
    const r1El = createEl('div', 'completion-stats-metrics completion-stats-metrics-r1');
    r1El.appendChild(this.createMetricCard(
      '激活率',
      `${(aggregated.activationRate * 100).toFixed(1)}%`,
      `展示 ${aggregated.totalShown} / 对话 ${aggregated.totalChatTurns}`,
      true, // R1 = 发布前提验证数，数值用强调色（accent）
    ));
    r1El.appendChild(this.createMetricCard(
      '召回时刻',
      String(aggregated.recallMoments),
      `"你教过我 X" 可感知次数`,
      true,
    ));
    container.appendChild(r1El);

    // ─── 补全效率卡片组 ──────────────────────────────
    const metricsEl = createEl('div', 'completion-stats-metrics');

    // 采纳率（核心指标）
    metricsEl.appendChild(this.createMetricCard(
      '采纳率',
      `${(aggregated.adoptionRate * 100).toFixed(1)}%`,
      `${aggregated.totalAdopted} / ${aggregated.totalShown}`,
    ));

    // Top-1 命中率
    metricsEl.appendChild(this.createMetricCard(
      'Top-1 命中率',
      `${(aggregated.top1HitRate * 100).toFixed(1)}%`,
      `采纳中首位占比`,
    ));

    // 平均采纳位置
    metricsEl.appendChild(this.createMetricCard(
      '平均采纳位置',
      aggregated.totalAdopted > 0 ? aggregated.avgAdoptedPosition.toFixed(2) : '—',
      `0 = 首位（最佳）`,
    ));

    // 展示数
    metricsEl.appendChild(this.createMetricCard(
      '展示次数',
      String(aggregated.totalShown),
      `候选列表展示给用户`,
    ));

    container.appendChild(metricsEl);

    // ─── B2 按日趋势柱状图（纵向养成曲线） ──────────────
    container.appendChild(this.createDailyTrendEl(dailyTrend));

    // ─── 最近事件流 ──────────────────────────────────────
    if (recentEvents.length > 0) {
      const eventsEl = createEl('div', 'completion-stats-events');
      eventsEl.appendChild(createEl('div', 'completion-stats-events-title', `最近 ${recentEvents.length} 条事件`));

      const listEl = createEl('div', 'completion-stats-event-list');
      for (const event of recentEvents) {
        listEl.appendChild(this.createEventItemEl(event));
      }
      eventsEl.appendChild(listEl);
      container.appendChild(eventsEl);
    } else {
      container.appendChild(createEmptyState({ title: '暂无统计数据，开始使用补全功能后将自动记录' }));
    }
  }

  // ─── 内部渲染方法 ──────────────────────────────────────

  /**
   * 导出统计 JSON 并触发浏览器下载
   *
   * 渲染层 Blob 下载，零新增 IPC、零遥测、零隐私冲突。
   * beta 用户点击后获得 JSON 文件，可手动回传用于聚合真实度量数据。
   *
   * 导出内容：聚合统计 + 14 天趋势 + 全量事件流（最多 500 条，LRU 上限）。
   * 失败静默：try-catch 包裹，度量功能不能影响主路径（沿用项目规则"度量失败静默"）。
   */
  private exportStatsJson(): void {
    try {
      const metrics = getCompletionMetrics();
      // 导出 payload：聚合 + 趋势 + 事件流（用于离线分析与回传）
      const payload = {
        // 导出时间戳（用于排序回传数据）
        exportedAt: new Date().toISOString(),
        // 聚合统计（R1 三数 + B2 召回时刻）
        aggregated: metrics.getAggregated(),
        // 14 天按日趋势（B2 纵向曲线）
        dailyTrend: metrics.getDailyAggregated(DAILY_TREND_DAYS),
        // 全量事件流（LRU 上限 500，用于深度分析）
        events: metrics.getRecentEvents(500),
      };
      const json = JSON.stringify(payload, null, 2);
      // Blob 下载：渲染层原生 API，无需主进程介入
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      // 文件名含日期，便于多次导出归档
      a.download = `memora-completion-stats-${getLocalDate()}.json`;
      a.click();
      // 释放 Blob URL（避免内存泄漏）
      URL.revokeObjectURL(url);
    } catch (err) {
      // 导出失败须可观测 + 可感知：记录日志并提示用户（导出是可选度量回传，失败不应静默）
      reportError('CompletionStatsExport', err, 'warn');
      this.host?.showToast('统计导出失败', 'error');
    }
  }

  /**
   * 创建指标卡片元素（复用共享 .stat-card，避免三面板各自发明卡片样式）
   *
   * @param label 指标名称
   * @param value 指标值（主展示）
   * @param hint 提示文本（副展示，小字）
   * @param accent 是否用强调色渲染数值（R1 发布前提验证数，对应 .stat-card--accent）
   */
  private createMetricCard(label: string, value: string, hint: string, accent = false): HTMLElement {
    const cardEl = createEl('div', accent ? 'stat-card stat-card--accent' : 'stat-card');
    cardEl.appendChild(createEl('div', 'stat-card__label', label));
    cardEl.appendChild(createEl('div', 'stat-card__value', value));
    cardEl.appendChild(createEl('div', 'stat-card__hint', hint));
    return cardEl;
  }

  /**
   * 创建按日趋势柱状图区块（B2 纵向养成曲线）
   *
   * 渲染最近 N 天的双指标柱状图：
   * - 蓝色柱：当日展示数（左轴，归一化到全期最大值）
   * - 橙色柱：当日召回时刻数（同图叠加，归一化到全期最大值）
   * - 柱顶常驻显示数值（主动可见，不藏 hover）
   * - 柱底显示日期（MM-DD）
   *
   * 全零数据时显示空状态提示，避免渲染无意义空图。
   *
   * @param daily 按日聚合数据（由 getDailyAggregated 返回，升序）
   */
  private createDailyTrendEl(daily: DailyAggregatedItem[]): HTMLElement {
    const trendEl = createEl('div', 'completion-stats-trend');
    trendEl.appendChild(createEl('div', 'completion-stats-trend-title', '最近 14 天趋势'));

    // 全零数据空状态（避免渲染无意义空图）
    const hasData = daily.some(d => d.shown > 0 || d.adopted > 0 || d.chatTurns > 0 || d.recallMoments > 0);
    if (!hasData) {
      trendEl.appendChild(createEmptyState({ title: '暂无趋势数据，使用 1-2 天后可见' }));
      return trendEl;
    }

    // 归一化基准：取展示数和召回时刻数的最大值（分别归一化，避免召回数被展示数淹没）
    const maxShown = Math.max(1, ...daily.map(d => d.shown));
    const maxRecall = Math.max(1, ...daily.map(d => d.recallMoments));

    // 图例
    const legendEl = createEl('div', 'completion-stats-trend-legend');
    legendEl.appendChild(createLegendItem('completion-stats-trend-legend-shown', '展示'));
    legendEl.appendChild(createLegendItem('completion-stats-trend-legend-recall', '召回时刻'));
    trendEl.appendChild(legendEl);

    // 柱状图容器
    const chartEl = createEl('div', 'completion-stats-trend-chart');
    for (const item of daily) {
      chartEl.appendChild(this.createDailyBarEl(item, maxShown, maxRecall));
    }
    trendEl.appendChild(chartEl);

    return trendEl;
  }

  /**
   * 创建单日柱组元素
   *
   * 每日一组双柱（展示 + 召回），柱顶常驻数值，柱底日期。
   * 柱高归一化到 4-100% 区间（最小 4% 保证零值也可见，便于辨识空日）。
   *
   * @param item 单日聚合数据
   * @param maxShown 展示数归一化基准（全期最大值，至少为 1）
   * @param maxRecall 召回时刻归一化基准（全期最大值，至少为 1）
   */
  private createDailyBarEl(item: DailyAggregatedItem, maxShown: number, maxRecall: number): HTMLElement {
    const barGroupEl = createEl('div', 'completion-stats-trend-bar-group');

    // 双柱容器
    const barsEl = createEl('div', 'completion-stats-trend-bars');

    // 展示数柱（蓝色）
    const shownBarEl = createEl('div', 'completion-stats-trend-bar shown');
    const shownHeightPct = item.shown > 0 ? 4 + (item.shown / maxShown) * 96 : 0;
    shownBarEl.style.height = `${shownHeightPct}%`;
    shownBarEl.title = `展示 ${item.shown} 次`;
    barsEl.appendChild(shownBarEl);

    // 召回时刻柱（橙色）
    const recallBarEl = createEl('div', 'completion-stats-trend-bar recall');
    const recallHeightPct = item.recallMoments > 0 ? 4 + (item.recallMoments / maxRecall) * 96 : 0;
    recallBarEl.style.height = `${recallHeightPct}%`;
    recallBarEl.title = `召回时刻 ${item.recallMoments} 次`;
    barsEl.appendChild(recallBarEl);

    // 柱顶数值（仅展示数 > 0 时显示，避免空柱顶堆零；主动可见不藏 hover）
    if (item.shown > 0) {
      barsEl.appendChild(createEl('div', 'completion-stats-trend-value', String(item.shown)));
    }

    barGroupEl.appendChild(barsEl);

    // 柱底日期（MM-DD，省略年份节省宽度）
    const dateLabel = item.date.slice(5);
    barGroupEl.appendChild(createEl('div', 'completion-stats-trend-date', dateLabel));

    return barGroupEl;
  }

  /**
   * 创建事件列表项元素
   *
   * @param event 补全事件（展示/采纳/对话轮次/召回时刻）
   */
  private createEventItemEl(event: CompletionEvent): HTMLElement {
    const itemEl = createEl('div', 'completion-stats-event-item');

    // 事件类型徽章（按类型分色：展示/采纳/对话/召回）
    const typeBadge = this.getEventBadge(event.type);
    const typeEl = createEl('span', `completion-stats-event-type ${typeBadge.class} flex-shrink-0`, typeBadge.label);
    itemEl.appendChild(typeEl);

    // 事件详情
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

    // 时间戳
    const timeEl = createEl('span', 'completion-stats-event-time flex-shrink-0');
    const time = new Date(event.timestamp);
    timeEl.textContent = time.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    timeEl.title = event.timestamp;
    itemEl.appendChild(timeEl);

    return itemEl;
  }

  /**
   * 获取事件类型徽章的样式类与标签
   *
   * 4 种事件类型分色：展示=蓝 / 采纳=绿 / 对话=灰 / 召回=橙
   *
   * @param type 事件类型标识
   */
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
}

/**
 * 创建图例项元素（模块级私有工具）
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
