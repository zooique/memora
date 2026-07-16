/**
 * 补全统计面板渲染器
 *
 * 职责：
 * - 渲染补全统计聚合数据（采纳率 / Top-1 命中率 / 平均位置 / 展示数 / 采纳数）
 * - 渲染最近事件流（展示/采纳事件，最近 50 条）
 * - 提供"重置统计"入口（清空 localStorage 数据）
 *
 * 设计原则（遵循 ADR-SP-015 组合模式）：
 * - 模式 C（自包含 EventTracker）：重置按钮事件通过 EventTracker 统一管理
 * - 模式 D 衍生：onResetStats() 回调注册接口与外部协作（Controller 调 metrics.clear()）
 * - 由 MemoryPanelManager 持有实例，作为第 3 个 analysis panel
 *
 * 数据来源：
 * - CompletionMetrics 单例（getCompletionMetrics()），localStorage 持久化
 * - 打开面板时实时调用 getAggregated() + getRecentEvents() 渲染
 */

import { EventTracker } from '../helpers/eventTracker.js';
import { createEl } from '../helpers/domHelpers.js';
import { getCompletionMetrics, type CompletionEvent } from '../helpers/completionMetrics.js';

// ─── 常量 ────────────────────────────────────────────────

/** 统计面板根容器 DOM ID（index.html 中预留） */
const STATS_CONTAINER_ID = 'completion-stats-bar';

/** 最近事件展示条数 */
const RECENT_EVENTS_LIMIT = 50;

// ─── 渲染器 ────────────────────────────────────────────────

/**
 * 补全统计面板渲染器
 *
 * 负责在 #completion-stats-bar 容器内渲染聚合统计 + 最近事件流。
 * 由 MemoryPanelManager 持有，打开面板时调用 render() 刷新数据。
 */
export class CompletionStatsRenderer {
  /** 事件监听器跟踪器（统一管理重置按钮事件） */
  private events = new EventTracker();

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
   * 从 CompletionMetrics 单例读取聚合数据 + 最近事件流，渲染到容器。
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

    // ─── 标题栏 + 重置按钮 ──────────────────────────────
    const headerEl = createEl('div', 'completion-stats-header');
    headerEl.appendChild(createEl('span', 'completion-stats-title', '补全统计'));

    const resetBtn = createEl('button', 'completion-stats-reset-btn', '重置统计');
    resetBtn.title = '清空所有补全统计数据';
    this.events.addEventListener(resetBtn, 'click', () => {
      this.resetCallback?.();
    });
    headerEl.appendChild(resetBtn);
    container.appendChild(headerEl);

    // ─── 聚合指标卡片 ──────────────────────────────────
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
      container.appendChild(createEl('div', 'completion-stats-empty', '暂无统计数据，开始使用补全功能后将自动记录'));
    }
  }

  // ─── 内部渲染方法 ──────────────────────────────────────

  /**
   * 创建指标卡片元素
   *
   * @param label 指标名称
   * @param value 指标值（主展示）
   * @param hint 提示文本（副展示，小字）
   */
  private createMetricCard(label: string, value: string, hint: string): HTMLElement {
    const cardEl = createEl('div', 'completion-stats-card');
    cardEl.appendChild(createEl('div', 'completion-stats-card-label', label));
    cardEl.appendChild(createEl('div', 'completion-stats-card-value', value));
    cardEl.appendChild(createEl('div', 'completion-stats-card-hint', hint));
    return cardEl;
  }

  /**
   * 创建事件列表项元素
   *
   * @param event 补全事件（展示/采纳）
   */
  private createEventItemEl(event: CompletionEvent): HTMLElement {
    const itemEl = createEl('div', 'completion-stats-event-item');

    // 事件类型徽章
    const typeEl = createEl(
      'span',
      event.type === 'shown' ? 'completion-stats-event-type shown flex-shrink-0' : 'completion-stats-event-type adopted flex-shrink-0',
      event.type === 'shown' ? '展示' : '采纳',
    );
    itemEl.appendChild(typeEl);

    // 事件详情
    const detailEl = createEl('span', 'completion-stats-event-detail');
    if (event.type === 'shown') {
      detailEl.textContent = `query ${event.queryLen} 字 → ${event.shownCount} 候选`;
    } else {
      const positionLabel = event.adoptedPosition === 0 ? 'Top-1' : `#${event.adoptedPosition + 1}`;
      detailEl.textContent = `query ${event.queryLen} 字 → 采纳 ${positionLabel}`;
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
}
