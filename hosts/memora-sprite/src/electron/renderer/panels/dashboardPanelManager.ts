/**
 * 仪表盘面板管理器 — 仪表盘渲染独立子模块
 *
 * 职责：
 * - 渲染仪表盘统计数据（累积事件/触发器/推荐记忆/记忆计数/洞察计数/建议计数）
 * - 渲染 Agent 运行时指标、技能列表、里程碑成就、对话回顾
 * - 渲染最近洞察列表（ReviewData.insights.recent，名称/时间/内容预览）
 * - 渲染记忆源健康诊断（按 source 分组的健康状态列表）
 * - 自管理脉冲动画定时器与事件监听器
 *
 * 设计原则：
 * - 遵循 MemoryPanelManager 的组合模式，UIManager 持有实例并委托
 * - Controller 仅做 IPC 编排，拉取数据后调用 Manager 渲染方法
 * - 跨模块关注点（showToast）通过 host 回调注入
 */

import { clearElement, formatTimeAgo } from '../helpers/domHelpers.js';
import type { EventTracker } from '../helpers/eventTracker.js';
// 复用 source → CSS 颜色类映射（与 InsightsRenderer 的 source 分布条形图共享配色）
import { getSourceColorClass } from './memoryPanelManager.js';
import type { ToastType } from '../types.js';
import type { ReviewDataPayload } from '../../preload.js';
// 仪表盘脉冲动画间隔常量从 constants.ts 真理源导入
import { DASHBOARD_PULSE_MS } from '../../../sprite/constants.js';

// ─── Host 接口（跨模块关注点注入） ────────────────────────

/** 仪表盘面板管理器需要的宿主能力（跨模块关注点，由 UIManager 注入） */
export interface DashboardPanelHost {
  /** 显示 toast 通知（清理失败等场景反馈） */
  showToast(message: string, type?: ToastType, duration?: number): void;
}

// ─── 类型定义（避免重复 inline，提升可读性） ─────────────

/** Agent 运行时指标快照（对齐内核 agent.getMetrics() 返回结构） */
export interface AgentMetrics {
  /** LLM 调用统计 */
  llm: {
    callCount: number;
    totalInputTokens: number;
    totalOutputTokens: number;
  };
  /** 召回统计 */
  recall: {
    totalCount: number;
    hitCount: number;
    hitRate: number;
  };
  /** 工具调用统计 */
  tools: {
    callCount: number;
    failureCount: number;
  };
  /** 上下文管理统计 */
  context: {
    truncationCount: number;
    messageCount: number;
    estimatedTokens: number;
  };
  /** 衰减统计（null 表示从未运行过衰减） */
  decay: {
    runCount: number;
    totalDecayedCount: number;
    lastRunAt: string | null;
  } | null;
}

/**
 * 记忆源健康诊断快照（对齐 preload.ts getDashboard 返回的 sourceHealth 结构）
 *
 * 消费内核 agent.memory.sourceHealth()，展示每个 source 的质量维度：
 * - count：该 source 记忆数
 * - avgScore：平均分（0-1，反映记忆整体质量）
 * - daysSinceLastAccess：距上次访问天数（反映活跃度）
 * - status：健康状态徽章（healthy/warning/critical）
 */
export interface SourceHealth {
  /** 各 source 的健康明细 */
  sources: Array<{
    source: string;
    count: number;
    avgScore: number;
    daysSinceLastAccess: number;
    status: 'healthy' | 'warning' | 'critical';
  }>;
  /** 总体健康状态（取最差的 source 状态） */
  overallStatus: 'healthy' | 'warning' | 'critical';
  /** 诊断时间戳（ISO 字符串） */
  diagnosedAt: string;
}

/**
 * 仪表盘视图模型（对齐 IPC getDashboard 返回结构，仅声明 Manager 用到的字段）
 *
 * 与 sprite 层 memoryController.DashboardData 概念不同：
 * - sprite 层 DashboardData 是"记忆仪表盘业务数据"
 * - 本类型是"完整仪表盘视图模型"（含事件/触发器/技能等 UI 字段）
 */
export interface DashboardViewModel {
  /** 累积事件数 */
  pendingNotices: number;
  /** 主动提示阈值 */
  proactiveThreshold: number;
  /** 已注册触发器名称列表 */
  registeredTriggers: string[];
  /** 推荐记忆列表 */
  suggestions: Array<{
    /** 记忆唯一标识（source:name 格式，用于点击跳转详情） */
    id: string;
    name: string;
    source: string;
    reason: string;
    relevance: number;
    contentPreview: string;
  }>;
  /** 全量记忆总数 */
  total: number;
  /** source → 计数映射 */
  bySource: Record<string, number>;
  /** 今日新增记忆数（用于概览区微型指标） */
  todayNewMemories?: number;
  /** 记忆源健康诊断（null 表示不可用，消费内核 sourceHealth()） */
  sourceHealth: SourceHealth | null;
  /** Agent 运行时指标（null 表示不可用） */
  metrics: AgentMetrics | null;
  /** 已加载技能列表 */
  skills: Array<{
    name: string;
    keywords: string[];
    description: string;
    layer: string;
  }>;
}

// P1 类型统一：感知数据 Payload 类型从 ipcListeners.ts（IPC 契约真理源）导入

// ─── 常量 ────────────────────────────────────────────────

// ─── 导出的纯函数（保持向后兼容） ─────────────────────────

/**
 * 格式化 token 数显示
 *
 * 超过 1000 时显示为 "1.2k" 格式，否则直接显示数字。
 * 供仪表盘 LLM Token 指标卡片使用。
 *
 * @param tokens token 数量
 * @returns 格式化后的字符串（如 "999" / "1.2k"）
 */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}k`;
  }
  return String(tokens);
}

// ─── 仪表盘面板管理器类 ───────────────────────────────────

/**
 * 仪表盘面板管理器
 *
 * 职责：
 * - 渲染仪表盘统计数据（累积事件/触发器/推荐记忆/记忆计数/洞察计数/建议计数）
 * - 渲染 Agent 运行时指标、技能列表、里程碑成就、对话回顾
 * - 渲染最近洞察列表（ReviewData.insights.recent，名称/时间/内容预览）
 * - 渲染记忆源健康（按 source 分组的健康诊断列表）
 * - 自管理脉冲动画定时器与事件监听器
 *
 * 设计原则：
 * - 遵循 MemoryPanelManager 的组合模式，UIManager 持有实例并委托
 * - Controller 仅做 IPC 编排，拉取数据后调用 Manager 渲染方法
 * - 跨模块关注点（showToast）通过 host 回调注入
 */
export class DashboardPanelManager {
  // ─── 内部状态 ────────────────────────────────────────────
  /** 脉冲动画定时器句柄列表（cleanup 时统一清理，避免回调在 DOM 销毁后触发） */
  private pulseTimers: number[] = [];

  // ─── 缓存 DOM 元素（渲染方法中重复查询，构造时获取一次） ─
  /** 增长趋势 - 区域容器（Phase 6.2：暴露 reviewManager 7/30 天趋势数据） */
  private growthSectionEl: HTMLElement | null;
  /** 增长趋势 - 趋势描述行（direction 箭头 + description 文案） */
  private growthDescEl: HTMLElement | null;
  /** 增长趋势 - 3 张对比卡片容器（今日 / 7 天 / 30 天） */
  private growthCardsEl: HTMLElement | null;
  /** 增长趋势 - 7 天每日柱状图 Canvas */
  private growthCanvasEl: HTMLCanvasElement | null;
  /** 增长趋势 - 空状态元素（daily 全 0 时显示） */
  private growthEmptyEl: HTMLElement | null;

  // ─── 回调（由 Controller 注册，用于重试按钮触发数据重新加载） ──
  /** 重试加载记忆列表回调 */
  private reloadMemoryListCallback: (() => void) | null = null;

  constructor(
    /** 事件监听器跟踪器（统一管理重试按钮事件，避免内存泄漏） */
    private events: EventTracker,
  ) {
    // 缓存渲染方法中重复查询的 DOM 元素（仪表盘 HTML 模板在页面加载时已存在）
    // 增长趋势区块 DOM 元素缓存（Phase 6.2：新增）
    this.growthSectionEl = document.getElementById('dashboard-growth');
    this.growthDescEl = document.getElementById('dashboard-growth-desc');
    this.growthCardsEl = document.getElementById('dashboard-growth-cards');
    const canvasEl = document.getElementById('dashboard-growth-canvas');
    this.growthCanvasEl = canvasEl instanceof HTMLCanvasElement ? canvasEl : null;
    this.growthEmptyEl = document.getElementById('dashboard-growth-empty');
  }

  // ─── 资源清理 ──────────────────────────────────────────

  /** 清理脉冲动画定时器和事件监听器（页面卸载时调用，避免回调在 DOM 销毁后触发） */
  cleanup(): void {
    for (const t of this.pulseTimers) {
      window.clearTimeout(t);
    }
    this.pulseTimers = [];
    this.events.cleanup();
  }

  /**
   * 主题切换时重绘 Canvas 图表
   *
   * Canvas 2D 不会自动响应 CSS 变量变化，主题切换后需主动重绘。
   * 增长趋势 Canvas 需重绘（主题切换后 CSS 变量值改变）。
   */
  repaintOnThemeChange(): void {
    this.repaintGrowthChart();
  }

  // ─── 回调注册 ──────────────────────────────────────────

  /** 注册重试加载记忆列表回调（用户点击重试按钮时触发） */
  onReloadMemoryList(cb: () => void): void {
    this.reloadMemoryListCallback = cb;
  }

  // ─── 仪表盘统计渲染 ────────────────────────────────────

  /**
   * 渲染仪表盘统计数据（累积事件/触发器/推荐记忆/记忆计数/洞察计数/建议计数）
   *
   * 由 Controller 在 loadDashboard 中调用，传入 IPC 返回的仪表盘数据。
   * 原 DOM 位置已移除，所有元素查询均安全降级（null 检查），方法不会崩溃。
   * 推荐记忆列表通过 data-action="view-recommendation" 标记，事件委托由 UIManager 统一处理。
   *
   * @param data 仪表盘数据
   */
  renderDashboardStats(data: DashboardViewModel): void {
    // ─── 更新仪表盘记忆统计卡片 ──
    const dashboardMemoryCount = document.getElementById('dashboard-total-memories');
    if (dashboardMemoryCount) dashboardMemoryCount.textContent = String(data.total);

    // ─── 更新今日新增记忆微型指标 ──
    const dashboardTodayCount = document.getElementById('dashboard-today-memories');
    if (dashboardTodayCount) {
      dashboardTodayCount.textContent = data.todayNewMemories !== null ? `+${data.todayNewMemories}` : '—';
    }

    // ─── 更新洞察计数（bySource 中 source='insight' 的记忆数） ──
    const insightCount = data.bySource['insight'] ?? 0;
    const dashboardInsightCount = document.getElementById('dashboard-total-insights');
    if (dashboardInsightCount) dashboardInsightCount.textContent = String(insightCount);
  }

  /**
   * 渲染 Agent 运行时指标（感知面板指标网格）
   *
   * 消费内核 agent.getMetrics() 数据，在感知面板中展示 4 项核心指标：
   * - LLM 调用次数 / Token 数 / 召回命中率 / 工具失败率
   *
   * 无数据时静默 return。token 数超过 1000 时显示为 "1.2k" 格式。
   *
   * @param metrics Agent 运行时指标快照（null 表示不可用）
   */
  renderAgentMetrics(metrics: AgentMetrics | null): void {
    // 无数据时静默跳过
    if (!metrics) return;

    // ─── 仪表盘面板：运行指标（LLM/Token/召回/失败/截断/消息/衰减） ──
    const dashboardLlmCalls = document.getElementById('dashboard-llm-calls');
    if (dashboardLlmCalls) dashboardLlmCalls.textContent = String(metrics.llm.callCount);

    const dashboardTokens = document.getElementById('dashboard-tokens');
    if (dashboardTokens) {
      const totalTokens = metrics.llm.totalInputTokens + metrics.llm.totalOutputTokens;
      dashboardTokens.textContent = formatTokenCount(totalTokens);
    }

    const dashboardRecallRate = document.getElementById('dashboard-recall-rate');
    if (dashboardRecallRate) {
      // 补全绝对值明细：60% → 60% (6/10)，让用户感知命中规模（避免 1/2 和 50/100 显示相同）
      const rate = `${Math.round(metrics.recall.hitRate * 100)}%`;
      dashboardRecallRate.textContent = metrics.recall.totalCount > 0
        ? `${rate} (${metrics.recall.hitCount}/${metrics.recall.totalCount})`
        : rate;
    }

    const dashboardToolFailures = document.getElementById('dashboard-tool-failures');
    if (dashboardToolFailures) {
      // 补全绝对值明细：10% → 10% (1/10)，让用户感知失败规模
      if (metrics.tools.callCount > 0) {
        const failRate = metrics.tools.failureCount / metrics.tools.callCount;
        dashboardToolFailures.textContent = `${Math.round(failRate * 100)}% (${metrics.tools.failureCount}/${metrics.tools.callCount})`;
      } else {
        dashboardToolFailures.textContent = '—';
      }
    }

    const dashboardTruncation = document.getElementById('dashboard-truncation-count');
    if (dashboardTruncation) {
      dashboardTruncation.textContent = String(metrics.context.truncationCount);
    }

    const dashboardMessageCount = document.getElementById('dashboard-message-count');
    if (dashboardMessageCount) {
      dashboardMessageCount.textContent = String(metrics.context.messageCount);
    }

    const dashboardDecayCount = document.getElementById('dashboard-decay-count');
    if (dashboardDecayCount) {
      dashboardDecayCount.textContent = metrics.decay ? String(metrics.decay.runCount) : '—';
    }

    const dashboardDecayTotal = document.getElementById('dashboard-decay-total');
    if (dashboardDecayTotal) {
      dashboardDecayTotal.textContent = metrics.decay ? String(metrics.decay.totalDecayedCount) : '—';
    }

    // 仪表盘记忆统计卡片中的衰减运行次数
    const dashboardDecayRuns = document.getElementById('dashboard-decay-runs');
    if (dashboardDecayRuns) {
      dashboardDecayRuns.textContent = metrics.decay ? String(metrics.decay.runCount) : '—';
    }

    // 衰减最近运行时间（消费 lastRunAt，用相对时间格式化：3 小时前 / 2 天前）
    const dashboardDecayLastRun = document.getElementById('dashboard-decay-last-run');
    if (dashboardDecayLastRun) {
      dashboardDecayLastRun.textContent = metrics.decay?.lastRunAt ? formatTimeAgo(metrics.decay.lastRunAt) : '—';
    }
  }

  /**
   * 渲染记忆源健康诊断（消费内核 sourceHealth()）
   *
   * 在仪表盘展示每个 source 的质量维度：计数 / 平均分 / 距上次访问天数 / 健康状态徽章。
   * 采用主行+次行双层布局：主行展示 source 名称和状态徽章，次行展示详细指标。
   * 与 InsightsRenderer 的 source 分布条形图互补：
   * - InsightsRenderer 展示"每个 source 有多少条"（数量维度）
   * - 本方法展示"每个 source 质量如何"（健康维度）
   *
   * 无数据时隐藏整个 section（包括标题），避免空标题占用空间。
   * 有数据时按 status 严重度排序（critical → warning → healthy），让用户优先看到需要关注的 source。
   *
   * @param sourceHealth 记忆源健康诊断数据（null 表示不可用）
   */
  renderSourceHealth(sourceHealth: SourceHealth | null): void {
    const dashboardListEl = document.getElementById('dashboard-source-health-list');
    const dashboardSectionEl = document.getElementById('dashboard-source-health');
    if (!dashboardListEl || !dashboardSectionEl) return;

    // 无数据时保留 section 标题，仅在列表区显示空状态文案
    // （遵循"主动可见"原则——用户能区分"功能未加载"与"确实无数据"）
    if (!sourceHealth || sourceHealth.sources.length === 0) {
      dashboardSectionEl.classList.remove('hidden');
      clearElement(dashboardListEl);
      const emptyEl = document.createElement('div');
      emptyEl.className = 'empty-state';
      emptyEl.textContent = '暂无记忆源健康数据';
      dashboardListEl.appendChild(emptyEl);
      return;
    }

    dashboardSectionEl.classList.remove('hidden');

    // 按 status 严重度排序：critical(0) → warning(1) → healthy(2)
    const statusOrder: Record<string, number> = { critical: 0, warning: 1, healthy: 2 };
    const sortedSources = [...sourceHealth.sources].sort(
      (a, b) => (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9),
    );

    // 清空并重建（复用 clearElement 统一 DOM 操作模式）
    clearElement(dashboardListEl);
    for (const s of sortedSources) {
      // 主容器
      const item = document.createElement('div');
      item.className = `source-health-item ${s.status}`;

      // 主行：source 标签 + 状态徽章
      const mainRow = document.createElement('div');
      mainRow.className = 'source-health-main';

      const labelSpan = document.createElement('span');
      labelSpan.className = `source-health-label source-${getSourceColorClass(s.source)}`;
      labelSpan.textContent = this.getSourceLabel(s.source);

      const statusSpan = document.createElement('span');
      statusSpan.className = `source-health-status ${s.status}`;
      statusSpan.textContent = this.getSourceHealthStatusLabel(s.status);

      mainRow.appendChild(labelSpan);
      mainRow.appendChild(statusSpan);

      // 次行：计数 / 均分 / 访问天数 三个指标
      const metaRow = document.createElement('div');
      metaRow.className = 'source-health-meta';

      const countSpan = document.createElement('span');
      countSpan.textContent = `${s.count} 条`;
      countSpan.title = '该 source 的记忆总数';

      const scoreSpan = document.createElement('span');
      scoreSpan.textContent = `均分 ${Math.round(s.avgScore * 100)}`;
      scoreSpan.title = '该 source 所有记忆的平均分（0-100）';

      const accessSpan = document.createElement('span');
      accessSpan.textContent = s.daysSinceLastAccess === 0
        ? '今日访问'
        : `${s.daysSinceLastAccess} 天未访`;
      accessSpan.title = '距上次访问该 source 的天数';

      metaRow.appendChild(countSpan);
      metaRow.appendChild(scoreSpan);
      metaRow.appendChild(accessSpan);

      item.appendChild(mainRow);
      item.appendChild(metaRow);
      dashboardListEl.appendChild(item);
    }
  }

  // ─── 增长趋势渲染（Phase 6.2：暴露 reviewManager 7/30 天趋势数据） ──

  /**
   * 渲染增长趋势区块（今日 / 7 天 / 30 天对比 + 趋势方向描述）
   *
   * 消费 sprite 层 reviewManager.buildReviewData() 已计算的趋势数据：
   * - today：今日新增记忆数 / 洞察数
   * - trend：7 天/30 天累计 + 每日明细 + direction（growing/stable/declining）+ description
   * - daily：最近 7 天每日明细（含 newMemories，由 renderGrowthChart 绘制为柱状图）
   *
   * 设计原则：
   * - 数据已就绪，仅做 UI 暴露，零额外 IPC 调用
   * - 空数据态（daily 全 0）显示空状态文案，不渲染柱状图
   * - 主题色通过 CSS 变量解析（与 partnerInsightsRenderer 一致）
   *
   * @param review 对话回顾数据（由 IPC MEMORIES_REVIEW_DATA 返回）
   */
  renderReviewData(review: ReviewDataPayload): void {
    // 缺少 DOM 容器时静默跳过（与 renderSourceHealth 一致的降级策略）
    if (!this.growthSectionEl) return;

    // ─── 1. 趋势方向描述行：箭头 + description 文案 ──
    if (this.growthDescEl) {
      const arrow = this.getTrendArrow(review.trend.direction);
      clearElement(this.growthDescEl);
      const arrowEl = document.createElement('span');
      arrowEl.className = `growth-trend-arrow growth-trend-${review.trend.direction}`;
      arrowEl.textContent = arrow;
      const descEl = document.createElement('span');
      descEl.className = 'growth-trend-desc';
      descEl.textContent = review.trend.description;
      this.growthDescEl.appendChild(arrowEl);
      this.growthDescEl.appendChild(descEl);
    }

    // ─── 2. 3 张对比卡片：今日 / 7 天 / 30 天 ──
    if (this.growthCardsEl) {
      clearElement(this.growthCardsEl);
      // 今日卡片
      const todayCard = this.createGrowthCard('今日', review.today.newMemories, review.today.newInsights);
      this.growthCardsEl.appendChild(todayCard);
      // 7 天卡片
      const weekCard = this.createGrowthCard('7 天', review.trend.last7Days, 0);
      this.growthCardsEl.appendChild(weekCard);
      // 30 天卡片
      const monthCard = this.createGrowthCard('30 天', review.trend.last30Days, 0);
      this.growthCardsEl.appendChild(monthCard);
    }

    // ─── 3. 柱状图 / 空状态 ──
    const hasDailyData = review.trend.daily.some((d) => d.newMemories > 0 || d.newInsights > 0);
    if (hasDailyData) {
      // 有数据：渲染柱状图，隐藏空状态
      this.growthEmptyEl?.classList.add('hidden');
      this.growthCanvasEl?.classList.remove('hidden');
      // 缓存 daily 供主题切换时重绘
      this.lastGrowthDaily = review.trend.daily;
      this.renderGrowthChart(review.trend.daily);
    } else {
      // 空数据：隐藏柱状图，显示空状态文案
      this.growthCanvasEl?.classList.add('hidden');
      this.lastGrowthDaily = null;
      if (this.growthEmptyEl) {
        this.growthEmptyEl.classList.remove('hidden');
        this.growthEmptyEl.textContent = '暂无增长数据，开始对话后将统计';
      }
    }

    // 显示整个区块
    this.growthSectionEl.classList.remove('hidden');

    // ─── 4. 最近洞察列表（ReviewData.insights.recent） ──
    this.renderRecentInsights(review);
  }

  /**
   * 渲染最近洞察列表（ReviewData.insights.recent）
   *
   * 显示 agent 最近发现的 5 条洞察，包含名称、时间戳和内容预览。
   * 数据由 reviewManager.buildReviewData() 预计算，零额外 IPC 调用。
   * 无洞察时隐藏整个区块。
   *
   * @param review 对话回顾数据（含 insights.recent 数组）
   */
  private renderRecentInsights(review: ReviewDataPayload): void {
    const sectionEl = document.getElementById('dashboard-recent-insights');
    const listEl = document.getElementById('recent-insights-list');
    if (!sectionEl || !listEl) return;

    const { recent } = review.insights;
    if (recent.length === 0) {
      sectionEl.style.display = 'none';
      return;
    }

    clearElement(listEl);

    for (const insight of recent) {
      const item = document.createElement('div');
      item.className = 'recent-insight-item';

      // 洞察名称
      const nameEl = document.createElement('div');
      nameEl.className = 'recent-insight-name';
      nameEl.textContent = insight.name;

      // 时间戳
      const timeEl = document.createElement('div');
      timeEl.className = 'recent-insight-time';
      timeEl.textContent = formatTimeAgo(insight.createdAt);

      // 内容预览
      const previewEl = document.createElement('div');
      previewEl.className = 'recent-insight-preview';
      previewEl.textContent = insight.contentPreview;
      previewEl.title = insight.contentPreview; // 完整内容在 hover 时显示

      item.appendChild(nameEl);
      item.appendChild(timeEl);
      item.appendChild(previewEl);
      listEl.appendChild(item);
    }

    sectionEl.style.display = 'block';
  }

  /**
   * 创建增长对比卡片（label + newMemories + newInsights 两行）
   *
   * @param label 卡片标签（今日 / 7 天 / 30 天）
   * @param newMemories 新增记忆数
   * @param newInsights 新增洞察数（仅今日卡片展示，7/30 天仅展示记忆数）
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

    // 仅当 newInsights > 0 时显示洞察行（避免 7/30 天卡片多一行无意义 0）
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
   * @param direction 趋势方向（growing/stable/declining）
   * @returns 箭头符号
   */
  private getTrendArrow(direction: 'growing' | 'stable' | 'declining'): string {
    switch (direction) {
      case 'growing':
        return '↗';
      case 'declining':
        return '↘';
      case 'stable':
      default:
        return '→';
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
    if (!this.growthCanvasEl) return;

    const canvas = this.growthCanvasEl;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    // 面板隐藏时宽度为 0，跳过绘制避免 canvas.style.width 被设为 '0px' 导致永久空白
    if (w === 0) return;
    // 从 CSS 获取高度（由 .growth-canvas 类控制，避免硬编码）
    const computedHeight = parseInt(getComputedStyle(canvas).height) || 70;
    const h = computedHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.scale(dpr, dpr);

    // 从 CSS 变量读取主题色（与 partnerInsightsRenderer.renderGrowthChart 一致）
    const rootStyle = getComputedStyle(document.documentElement);
    const cssVar = (name: string, fallback: string): string =>
      rootStyle.getPropertyValue(name).trim() || fallback;
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const accentColor = cssVar('--accent', '#0066ff');
    // --text-3 fallback 与 base.css 保持一致：浅色 #7a7a82 / 深色 #a1a1a6
    const textColor = cssVar('--text-3', isDark ? '#a1a1a6' : '#7a7a82');
    const gridColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';

    // 背景透明（让 dashboard-body 背景透出，视觉融入）
    // 边距：左侧留空给 Y 轴数值标签，底部留空给 X 轴标签，顶部留少量空间
    const padding = { top: 8, right: 8, bottom: 20, left: 28 };
    const chartW = w - padding.left - padding.right;
    const chartH = h - padding.top - padding.bottom;

    // 计算 Y 轴最大值（newMemories + newInsights 的最大值，至少为 1 避免除零）
    const maxVal = Math.max(
      ...daily.map((d) => d.newMemories + d.newInsights),
      1,
    );
    const yMax = maxVal * 1.15; // 顶部留 15% 空间

    // 绘制基线网格（3 条横线，提供视觉参考）+ Y 轴数值标签
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

      // Y 轴数值标签：顶部标签显示 yMax（取整），底部标签显示 0
      if (i === 0) {
        ctx.fillText(Math.round(yMax).toString(), padding.left - 4, y);
      } else if (i === 2) {
        ctx.fillText('0', padding.left - 4, y);
      }
    }

    // 绘制 7 个柱子（每个柱子含 newMemories 底部 + newInsights 顶部堆叠）
    const barWidth = chartW / daily.length;
    const barInnerWidth = barWidth * 0.6; // 柱子实际宽度（留间距）
    const barGap = (barWidth - barInnerWidth) / 2;

    daily.forEach((d, idx) => {
      const x = padding.left + idx * barWidth + barGap;
      const memHeight = (d.newMemories / yMax) * chartH;
      const insightHeight = (d.newInsights / yMax) * chartH;

      // 底部：newMemories 柱（accent 色）
      if (d.newMemories > 0) {
        ctx.fillStyle = accentColor;
        ctx.fillRect(x, padding.top + chartH - memHeight, barInnerWidth, memHeight);
      }

      // 顶部：newInsights 柱（accent 半透明，堆叠在 newMemories 上方）
      if (d.newInsights > 0) {
        // 通过 hexToRgba 从 --accent 派生半透明色，确保深色主题下颜色正确
        ctx.fillStyle = this.hexToRgba(accentColor, isDark ? 0.45 : 0.35);
        const baseY = padding.top + chartH - memHeight - insightHeight;
        ctx.fillRect(x, baseY, barInnerWidth, insightHeight);
      }

      // X 轴标签：星期几（取日期的 getDay，转为 周X）
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
   * 主题切换时重绘柱状图（与 partnerInsightsRenderer.repaintOnThemeChange 一致）
   *
   * 主题切换后 CSS 变量值改变，需重新解析颜色并重绘 Canvas。
   * 由 UIManager 在 data-theme 变更时调用。
   */
  repaintGrowthChart(): void {
    // 缓存最近一次的 daily 数据用于重绘
    if (this.lastGrowthDaily && this.growthCanvasEl && !this.growthCanvasEl.classList.contains('hidden')) {
      this.renderGrowthChart(this.lastGrowthDaily);
    }
  }

  /** 缓存最近一次渲染的 daily 数据（主题切换时重绘用） */
  private lastGrowthDaily: Array<{ date: string; newMemories: number; newInsights: number }> | null = null;

  // ─── 记忆列表加载失败渲染 ──────────────────────────────

  /**
   * 显示记忆列表加载失败状态（带重试按钮）
   *
   * 改用统一错误横幅体系（与 settings/memory/chat 对齐），
   * 不再自建 .error-state DOM。重试按钮用 onclick 覆盖式绑定（避免累积监听器）。
   *
   * @param listEl 记忆列表容器元素（保留参数兼容，实际错误显示在面板级横幅）
   */
  showMemoryListError(listEl: HTMLElement): void {
    // 清空列表区域，避免残留旧数据
    clearElement(listEl);
    // 通过 dashboard-error 横幅显示错误（统一错误横幅）
    const errorEl = document.getElementById('dashboard-error');
    const msgEl = document.getElementById('dashboard-error-msg');
    if (errorEl && msgEl) {
      msgEl.textContent = '加载记忆列表失败';
      errorEl.classList.remove('hidden');
    }
    // 重试按钮：用 onclick 覆盖式绑定（每次调用覆盖前一次，无累积）
    const retryBtn = document.getElementById('dashboard-error-retry');
    if (retryBtn instanceof HTMLButtonElement) {
      retryBtn.onclick = () => {
        this.reloadMemoryListCallback?.();
      };
    }
  }

  // ─── 脉冲计数 ──────────────────────────────────────────

  /**
   * 仪表盘计数 +1 并触发脉冲动画
   *
   * 对齐 HTML 预览 §6.3 .stat-value.pulse。
   * 由精灵事件监听器在 memoryNoticed/insightGained 事件时调用。
   *
   * @param id 计数元素 DOM ID
   */
  pulseCounter(id: string): void {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = String(parseInt(el.textContent ?? '0') + 1);
    el.classList.add('pulse');
    // 跟踪定时器句柄，支持 cleanup 时统一清理
    const timer = window.setTimeout(() => {
      el.classList.remove('pulse');
      // 从跟踪数组中移除已完成的定时器
      const idx = this.pulseTimers.indexOf(timer);
      if (idx !== -1) this.pulseTimers.splice(idx, 1);
    }, DASHBOARD_PULSE_MS);
    this.pulseTimers.push(timer);
  }

  // ─── 私有辅助方法（source 健康映射） ──────────────────

  /**
   * 将记忆源健康状态映射为中文标签
   *
   * @param status 健康状态标识符（healthy/warning/critical）
   * @returns 中文标签
   */
  private getSourceHealthStatusLabel(status: 'healthy' | 'warning' | 'critical'): string {
    switch (status) {
      case 'healthy':
        return '健康';
      case 'warning':
        return '需关注';
      case 'critical':
        return '异常';
      default:
        return status;
    }
  }

  /**
   * 将十六进制颜色转换为 rgba 字符串（用于 Canvas 绘制需要透明度的场景）
   *
   * 从 CSS 变量 --accent 读取的 hex 值无法直接带透明度，需通过此方法转换。
   * 与 relationGraph.ts 的 hexToRgba 实现保持一致，后续可提取为共享工具。
   *
   * @param hex 十六进制颜色值（如 "#0066ff" 或 "0066ff"）
   * @param alpha 透明度（0-1）
   * @returns rgba 字符串（如 "rgba(0, 102, 255, 0.45)"）
   */
  private hexToRgba(hex: string, alpha: number): string {
    const h = hex.replace('#', '');
    if (h.length !== 6) return `rgba(0,0,0,${alpha})`;
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  /**
   * 将 source 标识符映射为中文友好名称
   *
   * 与 PatternDetector.sourceLabel 保持一致，确保全 UI 层 source 命名统一。
   * 未知 source 透传原值，避免信息丢失。
   *
   * @param source 原始 source 字符串
   * @returns 中文标签
   */
  private getSourceLabel(source: string): string {
    const labels: Record<string, string> = {
      profile: '个人偏好',
      insight: '洞察',
      rule: '规则',
      skill: '技能',
      guardrail: '安全',
      chat: '对话',
      file: '文件',
      work: '工作',
      memory: '记忆',
      summary: '摘要',
      note: '笔记',
      persona: '角色',
      session: '会话',
    };
    return labels[source] ?? source;
  }

  // ─── 感知系统渲染已移除 ──────────────────────────────────
  // 感知数据渲染（情感/默契/上下文/模式/在场/叙事/主动提示）已迁移到
  // 独立的 PerceptionPanelManager，仪表盘不再承载感知分区。
}
