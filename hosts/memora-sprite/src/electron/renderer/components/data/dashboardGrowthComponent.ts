/**
 * 仪表盘增长趋势组件
 *
 * 职责（封装 dashboardPanelManager 中增长趋势区域的 DOM 操作）：
 * - 渲染趋势方向描述行（箭头 + description 文案）
 * - 渲染 3 张对比卡片（今日 / 7 天 / 30 天）
 * - 渲染 7 天每日柱状图（Canvas 2D，主题色适配）
 * - 提供主题切换重绘入口
 * - 渲染最近洞察列表（ReviewData.insights.recent）
 *
 * 与现有 HTML 模板的关系：
 * - 增长趋势 DOM 元素已存在于 index.html 模板中
 * - 本组件 mount() 时查询并缓存这些已有元素引用
 * - destroy() 不删除 DOM 元素（它们是模板的一部分），仅 nullify 引用
 *
 * 对齐 ui-engineering-mindset-rules §四.1 / §四.4：
 * - mount() 缓存元素引用
 * - update() 增量渲染数据
 * - destroy() 彻底清理引用
 */

import { Component } from '../base/component.js';
import { clearElement, formatTimeAgo, setCanvasSize } from '../../helpers/domHelpers.js';
import type { ReviewDataPayload } from '../../../preload.js';

// ─── 选项 / 宿主接口 ──────────────────────────────────────

/** DashboardGrowthComponent 配置 */
export interface DashboardGrowthOptions {
  // 当前无跨模块关注点注入，保留 Options 接口供后续扩展
}

// ─── 组件 ────────────────────────────────────────────────

/**
 * 仪表盘增长趋势组件
 *
 * 由 DashboardPanelManager 持有实例，替代原有 5 处 document.getElementById 直接 DOM 操作。
 * 挂载到现有 HTML 模板中的 #dashboard-growth 及相关元素。
 */
export class DashboardGrowthComponent extends Component<DashboardGrowthOptions> {
  // ─── 缓存的 DOM 元素引用（mount 时查询，destroy 时 nullify） ──
  /** 增长趋势 - 区域容器 */
  private sectionEl: HTMLElement | null = null;
  /** 增长趋势 - 趋势描述行（箭头 + 文案） */
  private descEl: HTMLElement | null = null;
  /** 增长趋势 - 3 张对比卡片容器 */
  private cardsEl: HTMLElement | null = null;
  /** 增长趋势 - 7 天每日柱状图 Canvas */
  private canvasEl: HTMLCanvasElement | null = null;
  /** 增长趋势 - 空状态元素 */
  private emptyEl: HTMLElement | null = null;
  /** 最近洞察 - 区块容器 */
  private insightsSectionEl: HTMLElement | null = null;
  /** 最近洞察 - 列表容器 */
  private insightsListEl: HTMLElement | null = null;

  /** 缓存最近一次渲染的 daily 数据（主题切换时重绘用） */
  private lastGrowthDaily: Array<{ date: string; newMemories: number; newInsights: number }> | null = null;

  /**
   * 构造函数——只合并配置，无副作用
   *
   * @param options 组件配置
   */
  constructor(options: DashboardGrowthOptions = {}) {
    super(options);
  }

  /**
   * 挂载到容器——查询并缓存现有 DOM 元素引用
   *
   * 增长趋势元素已存在于 index.html 模板中，mount 仅做查询缓存，不创建新元素。
   *
   * @param container 容器元素或选择器（兼容 Component 契约，但不使用 container 参数）
   * @returns this（链式调用）
   */
  mount(_container: HTMLElement | string): this {
    // 查询现有模板元素（静默降级：单个元素缺失不影响其他功能）
    this.sectionEl = document.getElementById('dashboard-growth');
    this.descEl = document.getElementById('dashboard-growth-desc');
    this.cardsEl = document.getElementById('dashboard-growth-cards');
    const canvasEl = document.getElementById('dashboard-growth-canvas');
    this.canvasEl = canvasEl instanceof HTMLCanvasElement ? canvasEl : null;
    this.emptyEl = document.getElementById('dashboard-growth-empty');
    this.insightsSectionEl = document.getElementById('dashboard-recent-insights');
    this.insightsListEl = document.getElementById('recent-insights-list');

    // 设置 this.el 为 sectionEl（Component 基类需要，但 destroy 时不会删除模板元素）
    this.el = this.sectionEl;

    return this;
  }

  /**
   * 增量更新——渲染增长趋势数据
   *
   * @param review 对话回顾数据（由 IPC MEMORIES_REVIEW_DATA 返回）
   * @returns this（链式调用）
   */
  update(review: ReviewDataPayload): this {
    if (!this.el) return this;
    this.renderReviewData(review);
    return this;
  }

  /**
   * 主题切换时重绘 Canvas 图表
   *
   * Canvas 2D 不会自动响应 CSS 变量变化，主题切换后需主动重绘。
   * 由 UIManager 在 data-theme 变更时通过 DashboardPanelManager 调用。
   */
  repaintChart(): void {
    if (this.lastGrowthDaily && this.canvasEl && !this.canvasEl.classList.contains('hidden')) {
      this.renderGrowthChart(this.lastGrowthDaily);
    }
  }

  /**
   * 销毁组件——nullify 引用
   *
   * 增长趋势元素是 HTML 模板的一部分，不删除 DOM。
   * 仅 nullify 内部引用，防止内存泄漏。
   */
  destroy(): void {
    this.lastGrowthDaily = null;
    this.sectionEl = null;
    this.descEl = null;
    this.cardsEl = null;
    this.canvasEl = null;
    this.emptyEl = null;
    this.insightsSectionEl = null;
    this.insightsListEl = null;
    // 防重复销毁 + 清理 trackEvent（尽管本组件未使用 trackEvent，但基类契约需维护）
    super.destroy();
  }

  // ─── 数据渲染（从 dashboardPanelManager 迁移） ────────────

  /**
   * 渲染增长趋势区块（今日 / 7 天 / 30 天对比 + 趋势方向描述 + 柱状图 + 最近洞察）
   *
   * @param review 对话回顾数据
   */
  private renderReviewData(review: ReviewDataPayload): void {
    if (!this.sectionEl) return;

    // ─── 1. 趋势方向描述行 ──
    if (this.descEl) {
      const arrow = this.getTrendArrow(review.trend.direction);
      clearElement(this.descEl);
      const arrowEl = document.createElement('span');
      arrowEl.className = `growth-trend-arrow growth-trend-${review.trend.direction}`;
      arrowEl.textContent = arrow;
      const descEl = document.createElement('span');
      descEl.className = 'growth-trend-desc';
      descEl.textContent = review.trend.description;
      this.descEl.appendChild(arrowEl);
      this.descEl.appendChild(descEl);
    }

    // ─── 2. 3 张对比卡片 ──
    if (this.cardsEl) {
      clearElement(this.cardsEl);
      this.cardsEl.appendChild(this.createGrowthCard('今日', review.today.newMemories, review.today.newInsights));
      this.cardsEl.appendChild(this.createGrowthCard('7 天', review.trend.last7Days, 0));
      this.cardsEl.appendChild(this.createGrowthCard('30 天', review.trend.last30Days, 0));
    }

    // ─── 3. 柱状图 / 空状态 ──
    const hasDailyData = review.trend.daily.some((d) => d.newMemories > 0 || d.newInsights > 0);
    if (hasDailyData) {
      this.emptyEl?.classList.add('hidden');
      this.canvasEl?.classList.remove('hidden');
      this.lastGrowthDaily = review.trend.daily;
      this.renderGrowthChart(review.trend.daily);
    } else {
      this.canvasEl?.classList.add('hidden');
      this.lastGrowthDaily = null;
      if (this.emptyEl) {
        this.emptyEl.classList.remove('hidden');
        this.emptyEl.textContent = '暂无增长数据，开始对话后将统计';
      }
    }

    // 显示整个区块
    this.sectionEl.classList.remove('hidden');

    // ─── 4. 最近洞察列表 ──
    this.renderRecentInsights(review);
  }

  /**
   * 渲染最近洞察列表
   *
   * @param review 对话回顾数据（含 insights.recent 数组）
   */
  private renderRecentInsights(review: ReviewDataPayload): void {
    if (!this.insightsSectionEl || !this.insightsListEl) return;

    const { recent } = review.insights;
    if (recent.length === 0) {
      this.insightsSectionEl.classList.add('hidden');
      return;
    }

    clearElement(this.insightsListEl);

    for (const insight of recent) {
      const item = document.createElement('div');
      item.className = 'recent-insight-item';

      const nameEl = document.createElement('div');
      nameEl.className = 'recent-insight-name';
      nameEl.textContent = insight.name;

      const timeEl = document.createElement('div');
      timeEl.className = 'recent-insight-time';
      timeEl.textContent = formatTimeAgo(insight.createdAt);
      timeEl.dataset.timestamp = insight.createdAt;

      const previewEl = document.createElement('div');
      previewEl.className = 'recent-insight-preview';
      previewEl.textContent = insight.contentPreview;
      previewEl.title = insight.contentPreview;

      item.appendChild(nameEl);
      item.appendChild(timeEl);
      item.appendChild(previewEl);
      this.insightsListEl.appendChild(item);
    }

    this.insightsSectionEl.classList.remove('hidden');
  }

  /**
   * 创建增长对比卡片
   *
   * @param label 卡片标签（今日 / 7 天 / 30 天）
   * @param newMemories 新增记忆数
   * @param newInsights 新增洞察数（仅今日卡片展示）
   * @returns 卡片 DOM 元素
   */
  private createGrowthCard(label: string, newMemories: number, newInsights: number): HTMLElement {
    const card = document.createElement('div');
    card.className = 'growth-card';

    const labelEl = document.createElement('span');
    labelEl.className = 'growth-card-label';
    labelEl.textContent = label;

    const memEl = document.createElement('span');
    memEl.className = 'growth-card-value';
    memEl.textContent = `+${newMemories}`;
    memEl.title = `${label}新增记忆数`;

    card.appendChild(labelEl);
    card.appendChild(memEl);

    if (newInsights > 0) {
      const insightEl = document.createElement('span');
      insightEl.className = 'growth-card-sub';
      insightEl.textContent = `+${newInsights} 洞察`;
      card.appendChild(insightEl);
    }

    return card;
  }

  /**
   * 将趋势方向映射为箭头符号
   *
   * @param direction 趋势方向
   * @returns 箭头符号
   */
  private getTrendArrow(direction: 'growing' | 'stable' | 'declining'): string {
    switch (direction) {
      case 'growing': return '↗';
      case 'declining': return '↘';
      case 'stable':
      default: return '→';
    }
  }

  /**
   * 渲染 7 天每日柱状图（Canvas 2D，主题色适配）
   *
   * @param daily 最近 7 天每日明细数组
   */
  private renderGrowthChart(
    daily: Array<{ date: string; newMemories: number; newInsights: number }>,
  ): void {
    if (!this.canvasEl) return;

    const canvas = this.canvasEl;
    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    if (w === 0) return;
    const computedHeight = parseInt(getComputedStyle(canvas).height) || 70;
    const h = computedHeight;
    const dpr = setCanvasSize(canvas, w, h);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.scale(dpr, dpr);

    const rootStyle = getComputedStyle(document.documentElement);
    const cssVar = (name: string, fallback: string): string =>
      rootStyle.getPropertyValue(name).trim() || fallback;
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const accentColor = cssVar('--accent', '#0d7377');
    const textColor = cssVar('--text-3', isDark ? '#b5bcd6' : '#6a6a72');
    const gridColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';

    const padding = { top: 8, right: 8, bottom: 20, left: 28 };
    const chartW = w - padding.left - padding.right;
    const chartH = h - padding.top - padding.bottom;

    const maxVal = Math.max(
      ...daily.map((d) => d.newMemories + d.newInsights),
      1,
    );
    const yMax = maxVal * 1.15;

    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    ctx.fillStyle = textColor;
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 2; i++) {
      const y = padding.top + (chartH * i / 2);
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(w - padding.right, y);
      ctx.stroke();

      if (i === 0) {
        ctx.fillText(Math.round(yMax).toString(), padding.left - 4, y);
      } else if (i === 2) {
        ctx.fillText('0', padding.left - 4, y);
      }
    }

    const barWidth = chartW / daily.length;
    const barInnerWidth = barWidth * 0.6;
    const barGap = (barWidth - barInnerWidth) / 2;

    daily.forEach((d, idx) => {
      const x = padding.left + idx * barWidth + barGap;
      const memHeight = (d.newMemories / yMax) * chartH;
      const insightHeight = (d.newInsights / yMax) * chartH;

      if (d.newMemories > 0) {
        ctx.fillStyle = accentColor;
        ctx.fillRect(x, padding.top + chartH - memHeight, barInnerWidth, memHeight);
      }

      if (d.newInsights > 0) {
        ctx.fillStyle = this.hexToRgba(accentColor, isDark ? 0.45 : 0.35);
        const baseY = padding.top + chartH - memHeight - insightHeight;
        ctx.fillRect(x, baseY, barInnerWidth, insightHeight);
      }

      const date = new Date(d.date);
      if (!isNaN(date.getTime())) {
        const dayNames = ['日', '一', '二', '三', '四', '五', '六'];
        const dayLabel = `周${dayNames[date.getDay()]}`;
        ctx.fillStyle = textColor;
        ctx.font = '10px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(dayLabel, x + barInnerWidth / 2, h - 4);
      }
    });
  }

  /**
   * 将十六进制颜色转换为 rgba 字符串
   *
   * @param hex 十六进制颜色值
   * @param alpha 透明度（0-1）
   * @returns rgba 字符串
   */
  private hexToRgba(hex: string, alpha: number): string {
    const h = hex.replace('#', '');
    if (h.length !== 6) return `rgba(0,0,0,${alpha})`;
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
}