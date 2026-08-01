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
 * - DOM 操作委托给 Component 实例（DashboardGrowthComponent / DashboardSourceHealthComponent / DashboardErrorBannerComponent）
 */

import { clearElement, formatTimeAgo } from '../helpers/domHelpers.js';
import type { EventTracker } from '../helpers/eventTracker.js';
import type { ToastType } from '../types.js';
import type { ReviewDataPayload } from '../../preload.js';
// 仪表盘脉冲动画间隔常量从 constants.ts 真理源导入
import { DASHBOARD_PULSE_MS } from '../../../sprite/constants.js';
// Token 数量格式化纯函数（UX-12：从本文件原导出提取至 shared/numberUtils 真理源，消除与 inputAreaManager 的 K/k 大小写不一致）
import { formatTokenCount } from '../../../shared/numberUtils.js';
import { reportError } from '../helpers/errorHelpers.js';
// 仪表盘 Component（封装增长趋势/源健康/错误横幅的 DOM 操作）
import { DashboardGrowthComponent } from '../components/data/dashboardGrowthComponent.js';
import { DashboardSourceHealthComponent } from '../components/data/dashboardSourceHealthComponent.js';
import { DashboardErrorBannerComponent } from '../components/data/dashboardErrorBannerComponent.js';

// Token 数量格式化函数由 shared/numberUtils.ts 提供，本模块仅消费（UX-12 术语统一）

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
 * 消费内核 agent.sourceHealth()（sourceHealth 已从 agent.memory.sourceHealth() 迁移到 agent.sourceHealth()），
 * 展示每个 source 的质量维度：
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
 * - DOM 操作委托给 Component 实例（ARCH-COMP-1 阶段 1）
 */
export class DashboardPanelManager {
  // ─── 内部状态 ────────────────────────────────────────────
  /** 脉冲动画定时器句柄列表（cleanup 时统一清理，避免回调在 DOM 销毁后触发） */
  private pulseTimers: number[] = [];
  /** 记忆衰减按钮恢复定时器（cleanup 时统一清理，避免回调在已销毁 DOM 上执行） */
  private decayButtonTimer: number | null = null;

  // ─── Component 实例（ARCH-COMP-1：封装 DOM 操作，替代直接查询） ─
  /** 增长趋势组件（渲染趋势方向/对比卡片/柱状图/最近洞察） */
  private growthComponent: DashboardGrowthComponent;
  /** 记忆源健康诊断组件（渲染健康列表/总体状态/诊断时间） */
  private sourceHealthComponent: DashboardSourceHealthComponent;
  /** 错误提示横幅组件（显示加载失败状态和重试按钮） */
  private errorBannerComponent: DashboardErrorBannerComponent;

  // ─── 回调（由 Controller 注册，用于重试按钮触发数据重新加载） ──
  /** 重试加载记忆列表回调 */
  private reloadMemoryListCallback: (() => void) | null = null;

  constructor(
    /** 事件监听器跟踪器（统一管理重试按钮事件，避免内存泄漏） */
    private events: EventTracker,
    /** 宿主能力（showToast 跨模块关注点，由 UIManager 注入；UIManager 已实现 DashboardPanelHost） */
    private host: DashboardPanelHost,
  ) {
    // 创建 Component 实例并挂载到现有 HTML 模板元素
    this.growthComponent = new DashboardGrowthComponent().mount('');
    this.sourceHealthComponent = new DashboardSourceHealthComponent().mount('');
    this.errorBannerComponent = new DashboardErrorBannerComponent({
      // 重试回调委托给 reloadMemoryListCallback（由 Controller 通过 onReloadMemoryList 注册）
      onRetry: () => this.reloadMemoryListCallback?.(),
    }).mount('');

    // 绑定手动触发衰减按钮（点击调用 IPC，成功后刷新仪表盘指标）
    const triggerDecayBtn = document.getElementById('btn-trigger-decay');
    if (triggerDecayBtn instanceof HTMLButtonElement) {
      this.events.addEventListener(triggerDecayBtn, 'click', async () => {
        triggerDecayBtn.disabled = true;
        const originalText = triggerDecayBtn.textContent;
        triggerDecayBtn.textContent = '执行中…';
        try {
          const result = await window.electronAPI.triggerDecayRun();
          triggerDecayBtn.textContent = result.success ? '已完成' : '失败';
          // 衰减完成后刷新仪表盘（reloadMemoryListCallback 会触发 DASHBOARD_GET 重新加载）
          if (result.success) {
            this.reloadMemoryListCallback?.();
          }
        } catch (err) {
          reportError('DashboardDecay', err, 'warn');
          triggerDecayBtn.textContent = '失败';
          this.host.showToast('触发记忆衰减失败', 'error');
        } finally {
          // 1.5 秒后恢复按钮文字和可用状态（跟踪定时器，cleanup 时统一清理）
          this.decayButtonTimer = window.setTimeout(() => {
            triggerDecayBtn.textContent = originalText;
            triggerDecayBtn.disabled = false;
            this.decayButtonTimer = null;
          }, 1500);
        }
      });
    }
  }

  // ─── 资源清理 ──────────────────────────────────────────

  /** 清理脉冲动画定时器和事件监听器（页面卸载时调用，避免回调在 DOM 销毁后触发） */
  cleanup(): void {
    for (const t of this.pulseTimers) {
      window.clearTimeout(t);
    }
    this.pulseTimers = [];
    // 清理衰减按钮恢复定时器（避免回调在已销毁 DOM 上执行）
    if (this.decayButtonTimer !== null) {
      window.clearTimeout(this.decayButtonTimer);
      this.decayButtonTimer = null;
    }
    // 销毁 Component 实例（nullify 引用，解绑事件）
    this.growthComponent.destroy();
    this.sourceHealthComponent.destroy();
    this.errorBannerComponent.destroy();
    this.events.cleanup();
  }

  /**
   * 主题切换时重绘 Canvas 图表
   *
   * Canvas 2D 不会自动响应 CSS 变量变化，主题切换后需主动重绘。
   * 委托给增长趋势组件处理。
   */
  repaintOnThemeChange(): void {
    this.growthComponent.repaintChart();
  }

  // ─── 回调注册 ──────────────────────────────────────────

  /** 注册重试加载记忆列表回调（用户点击重试按钮时触发） */
  onReloadMemoryList(cb: () => void): void {
    this.reloadMemoryListCallback = cb;
    // 同步更新错误横幅组件的重试回调（确保新注册的回调立即生效）
    this.errorBannerComponent.update({ onRetry: cb });
  }

  // ─── 仪表盘统计渲染 ────────────────────────────────────

  /**
   * 渲染仪表盘统计数据（累积事件/触发器/推荐记忆/记忆计数/洞察计数/建议计数）
   *
   * 由 Controller 在 loadDashboard 中调用，传入 IPC 返回的仪表盘数据。
   * 所有元素查询均安全降级（null 检查），方法不会崩溃。
   *
   * @param data 仪表盘数据
   */
  renderDashboardStats(data: DashboardViewModel): void {
    // ─── 更新仪表盘记忆统计卡片 ──
    const dashboardMemoryCount = document.getElementById('dashboard-total-memories');
    if (dashboardMemoryCount) dashboardMemoryCount.textContent = String(data.total);

    // ─── 更新今日新增记忆微型指标 ──
    // != null 同时捕获 null 和 undefined，避免显示 "+undefined"
    const dashboardTodayCount = document.getElementById('dashboard-today-memories');
    if (dashboardTodayCount) {
      dashboardTodayCount.textContent = data.todayNewMemories !== null && data.todayNewMemories !== undefined ? `+${data.todayNewMemories}` : '—';
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

    // 上下文估算 Token 数（接近截断阈值时让用户预判，而非事后看到 truncationCount +1）
    const dashboardEstimatedTokens = document.getElementById('dashboard-estimated-tokens');
    if (dashboardEstimatedTokens) {
      dashboardEstimatedTokens.textContent = formatTokenCount(metrics.context.estimatedTokens);
    }

    const dashboardDecayCount = document.getElementById('dashboard-decay-count');
    if (dashboardDecayCount) {
      dashboardDecayCount.textContent = metrics.decay ? String(metrics.decay.runCount) : '—';
    }

    // UX-0713-10：衰减三项合并为 1 卡片，详情行显示"累计 N · 最近 T"
    const dashboardDecayDetail = document.getElementById('dashboard-decay-detail');
    if (dashboardDecayDetail) {
      // runCount=0 表示从未运行过衰减，此时 totalDecayedCount 也是默认值 0，应显示 — 而非 0
      const hasDecayRun = metrics.decay && metrics.decay.runCount > 0;
      const totalText = hasDecayRun ? String(metrics.decay!.totalDecayedCount) : '—';
      const lastRunText = metrics.decay?.lastRunAt ? formatTimeAgo(metrics.decay.lastRunAt) : '—';
      dashboardDecayDetail.textContent = `累计 ${totalText} · 最近 ${lastRunText}`;
    }

    // 仪表盘记忆统计卡片中的衰减运行次数
    const dashboardDecayRuns = document.getElementById('dashboard-decay-runs');
    if (dashboardDecayRuns) {
      dashboardDecayRuns.textContent = metrics.decay ? String(metrics.decay.runCount) : '—';
    }
  }

  /**
   * 渲染记忆源健康诊断（消费内核 sourceHealth()）
   *
   * 委托给 DashboardSourceHealthComponent 处理 DOM 操作。
   * 无数据时隐藏整个 section（包括标题），避免空标题占用空间。
   *
   * @param sourceHealth 记忆源健康诊断数据（null 表示不可用）
   */
  renderSourceHealth(sourceHealth: SourceHealth | null): void {
    this.sourceHealthComponent.update(sourceHealth);
  }

  // ─── 增长趋势渲染（Phase 6.2：暴露 reviewManager 7/30 天趋势数据） ──

  /**
   * 渲染增长趋势区块（今日 / 7 天 / 30 天对比 + 趋势方向描述）
   *
   * 委托给 DashboardGrowthComponent 处理 DOM 操作。
   * 数据已就绪，仅做 UI 暴露，零额外 IPC 调用。
   *
   * @param review 对话回顾数据（由 IPC MEMORIES_REVIEW_DATA 返回）
   */
  renderReviewData(review: ReviewDataPayload): void {
    this.growthComponent.update(review);
  }

  // ─── 记忆列表加载失败渲染 ──────────────────────────────

  /**
   * 显示记忆列表加载失败状态（带重试按钮）
   *
   * 委托给 DashboardErrorBannerComponent 处理 DOM 操作。
   * 清空列表区域，通过错误横幅显示错误信息。
   *
   * @param listEl 记忆列表容器元素（清空避免残留旧数据）
   */
  showMemoryListError(listEl: HTMLElement): void {
    // 清空列表区域，避免残留旧数据
    clearElement(listEl);
    // 通过错误横幅组件显示错误（统一错误横幅）
    this.errorBannerComponent.showError('加载记忆列表失败');
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

}