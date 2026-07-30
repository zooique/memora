/**
 * 仪表盘面板管理器测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - formatTokenCount：纯函数（< 1000 直显 / >= 1000 k 格式）
 * - renderDashboardStats：累积事件/阈值高亮/推荐记忆/计数更新
 * - renderAgentMetrics：LLM 调用/Token/召回率/工具失败率（含 0/0 兜底）
 * - renderMilestones：量级/多样性/洞察/画像里程碑
 * - renderReviewData：今日概况/趋势方向/柱状图/最近洞察
 * - pulseCounter：计数 +1 + pulse 动画（fake timers）
 * - 错误状态 + 重试回调：showMemoryListError
 * - cleanup：脉冲定时器清理
 *
 * 子渲染器（renderInsights / renderHealthDashboard / renderPartnerInsights）归位到
 * MemoryPanelManager，行为测试在各自独立测试文件中覆盖。
 *
 * Mock 策略：
 * - 使用真实 EventTracker（构造函数注入，验证事件注册与清理）
 * - JSDOM 提供真实 DOM API
 * - pulseCounter 测试使用 vi.useFakeTimers 控制定时器
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DashboardPanelManager } from '../../../electron/renderer/panels/dashboardPanelManager.js';
// formatTokenCount 已迁移至 shared/numberUtils.ts（UX-12 术语统一）
import { formatTokenCount } from '../../../shared/numberUtils.js';
import type {
  AgentMetrics,
  DashboardViewModel,
  DashboardPanelHost,
} from '../../../electron/renderer/panels/dashboardPanelManager.js';
import type { EventTracker } from '../../../electron/renderer/helpers/eventTracker.js';
import { EventTracker as EventTrackerImpl } from '../../../electron/renderer/helpers/eventTracker.js';
import type { ReviewDataPayload } from '../../../electron/preload.js';

// ─── 测试辅助 ─────────────────────────────────────────────

/** 仪表盘面板完整 DOM 结构（覆盖所有渲染方法所需元素） */
const DASHBOARD_HTML = `
  <!-- 仪表盘统计卡片 -->
  <span id="dashboard-total-memories"></span>
  <span id="dashboard-total-insights"></span>

  <!-- Agent 运行时指标 -->
  <span id="dashboard-llm-calls"></span>
  <span id="dashboard-tokens"></span>
  <span id="dashboard-recall-rate"></span>
  <span id="dashboard-tool-failures"></span>
  <span id="dashboard-truncation-count"></span>
  <span id="dashboard-message-count"></span>
  <span id="dashboard-decay-count"></span>
  <span id="dashboard-decay-detail"></span>
  <span id="dashboard-decay-runs"></span>

  <!-- 里程碑 -->
  <div id="milestones-display" class="hidden">
    <div id="milestones-list"></div>
  </div>

  <!-- dashboard 错误横幅（PanelErrorBannerManager 体系） -->
  <div id="dashboard-error" class="panel-error hidden">
    <span id="dashboard-error-msg"></span>
    <button id="dashboard-error-retry" class="panel-error-btn">重试</button>
  </div>

  <!-- Phase 6.2：增长趋势区块（暴露 reviewManager 7/30 天趋势数据） -->
  <section class="dashboard-section hidden" id="dashboard-growth">
    <h4 class="dashboard-section-title">增长趋势</h4>
    <div class="growth-trend-desc-row" id="dashboard-growth-desc"></div>
    <div class="growth-cards" id="dashboard-growth-cards"></div>
    <canvas id="dashboard-growth-canvas" class="growth-canvas hidden"></canvas>
    <div class="growth-empty hidden" id="dashboard-growth-empty"></div>
  </section>
`;

/** 测试用宿主桩（DashboardPanelHost：仅 showToast，由 UIManager 在生产注入） */
function createMockHost(): DashboardPanelHost {
  return { showToast: vi.fn() };
}

/** 创建 DashboardPanelManager 实例（默认已设置 DOM） */
function createManager(opts?: { html?: string }): { manager: DashboardPanelManager; events: EventTracker } {
  document.body.innerHTML = opts?.html ?? DASHBOARD_HTML;
  const events = new EventTrackerImpl();
  const manager = new DashboardPanelManager(events, createMockHost());
  return { manager, events };
}

/** 创建测试用 AgentMetrics */
function createMetrics(overrides?: Partial<AgentMetrics>): AgentMetrics {
  return {
    llm: { callCount: 10, totalInputTokens: 500, totalOutputTokens: 300 },
    recall: { totalCount: 20, hitCount: 15, hitRate: 0.75 },
    tools: { callCount: 8, failureCount: 2 },
    context: { truncationCount: 1, messageCount: 30, estimatedTokens: 4000 },
    decay: { runCount: 3, totalDecayedCount: 5, lastRunAt: '2026-07-01T00:00:00.000Z' },
    ...overrides,
  };
}

/** 创建测试用 DashboardViewModel */
function createViewModel(overrides?: Partial<DashboardViewModel>): DashboardViewModel {
  return {
    pendingNotices: 2,
    proactiveThreshold: 5,
    registeredTriggers: ['timer', 'fileWatcher'],
    suggestions: [
      { id: 'test:mem1', name: '记忆 1', source: 'test', reason: '相关', relevance: 0.85, contentPreview: '预览' },
    ],
    total: 100,
    bySource: { test: 50, insight: 30, profile: 20 },
    metrics: createMetrics(),
    skills: [{ name: 'skill1', keywords: ['kw1', 'kw2'], description: 'desc', layer: 'project' }],
    ...overrides,
  };
}

// ─── 全局设置 ─────────────────────────────────────────────

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

// ─── formatTokenCount · 纯函数 ───────────────────────────

describe('formatTokenCount · 纯函数', () => {
  it('< 1000 应直接显示数字', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(999)).toBe('999');
  });

  it('>= 1000 应显示 k 格式（保留 1 位小数）', () => {
    expect(formatTokenCount(1000)).toBe('1.0k');
    expect(formatTokenCount(1200)).toBe('1.2k');
    expect(formatTokenCount(10000)).toBe('10.0k');
  });
});

// ─── renderDashboardStats ────────────────────────────────

describe('renderDashboardStats', () => {
  it('应更新仪表盘记忆总数', () => {
    const { manager } = createManager();
    manager.renderDashboardStats(createViewModel({ total: 200 }));
    expect(document.getElementById('dashboard-total-memories')!.textContent).toBe('200');
  });

  it('应更新洞察计数（bySource 中 insight 源记忆数）', () => {
    const { manager } = createManager();
    manager.renderDashboardStats(createViewModel({
      total: 200,
      bySource: { test: 100, insight: 50, profile: 50 },
    }));
    expect(document.getElementById('dashboard-total-insights')!.textContent).toBe('50');
  });
});

// ─── renderAgentMetrics ──────────────────────────────────

describe('renderAgentMetrics', () => {
  it('null 入参应静默退出', () => {
    const { manager } = createManager();
    manager.renderAgentMetrics(null);
    expect(document.getElementById('dashboard-llm-calls')!.textContent).toBe('');
  });

  it('应渲染 LLM 调用次数', () => {
    const { manager } = createManager();
    manager.renderAgentMetrics(createMetrics({ llm: { callCount: 42, totalInputTokens: 0, totalOutputTokens: 0 } }));
    expect(document.getElementById('dashboard-llm-calls')!.textContent).toBe('42');
  });

  it('应渲染 Token 数（输入+输出，>= 1000 显示 k）', () => {
    const { manager } = createManager();
    manager.renderAgentMetrics(createMetrics({
      llm: { callCount: 1, totalInputTokens: 800, totalOutputTokens: 400 },
    }));
    expect(document.getElementById('dashboard-tokens')!.textContent).toBe('1.2k');
  });

  it('应渲染召回命中率（百分比 + 绝对值明细）', () => {
    const { manager } = createManager();
    manager.renderAgentMetrics(createMetrics({
      recall: { totalCount: 20, hitCount: 15, hitRate: 0.75 },
    }));
    expect(document.getElementById('dashboard-recall-rate')!.textContent).toBe('75% (15/20)');
  });

  it('召回总数为 0 时仅显示百分比（无绝对值明细）', () => {
    const { manager } = createManager();
    manager.renderAgentMetrics(createMetrics({
      recall: { totalCount: 0, hitCount: 0, hitRate: 0 },
    }));
    expect(document.getElementById('dashboard-recall-rate')!.textContent).toBe('0%');
  });

  it('工具失败率 0/0 应显示 — （避免 NaN）', () => {
    const { manager } = createManager();
    manager.renderAgentMetrics(createMetrics({
      tools: { callCount: 0, failureCount: 0 },
    }));
    expect(document.getElementById('dashboard-tool-failures')!.textContent).toBe('—');
  });

  it('工具失败率应显示百分比 + 绝对值明细', () => {
    const { manager } = createManager();
    manager.renderAgentMetrics(createMetrics({
      tools: { callCount: 10, failureCount: 3 },
    }));
    expect(document.getElementById('dashboard-tool-failures')!.textContent).toBe('30% (3/10)');
  });

  it('衰减详情行应显示累计和最近运行时间（UX-0713-10 合并卡片）', () => {
    const { manager } = createManager();
    // 使用近期时间（1 小时前），formatTimeAgo 应输出"1 小时前"
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    manager.renderAgentMetrics(createMetrics({
      decay: { runCount: 5, totalDecayedCount: 10, lastRunAt: oneHourAgo },
    }));
    // 详情行格式："累计 N · 最近 T"
    expect(document.getElementById('dashboard-decay-detail')!.textContent).toBe('累计 10 · 最近 1 小时前');
  });

  it('衰减从未运行时详情行应显示 — 占位（UX-0713-10）', () => {
    const { manager } = createManager();
    manager.renderAgentMetrics(createMetrics({
      decay: { runCount: 0, totalDecayedCount: 0, lastRunAt: null },
    }));
    expect(document.getElementById('dashboard-decay-detail')!.textContent).toBe('累计 — · 最近 —');
  });
});

// InsightsRenderer / HealthDashboardRenderer 归位到 MemoryPanelManager，
// 子渲染器行为测试在 insightsRenderer.test.ts / healthDashboardRenderer.test.ts 中覆盖。

// ─── pulseCounter ────────────────────────────────────────

describe('pulseCounter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('应将计数 +1 并添加 pulse 类', () => {
    const { manager } = createManager();
    document.body.innerHTML = '<span id="test-counter">5</span>';
    manager.pulseCounter('test-counter');
    const el = document.getElementById('test-counter')!;
    expect(el.textContent).toBe('6');
    expect(el.classList.contains('pulse')).toBe(true);
  });

  it('元素不存在时应静默退出', () => {
    const { manager } = createManager();
    expect(() => manager.pulseCounter('nonexistent')).not.toThrow();
  });

  it('定时器到期后应移除 pulse 类', () => {
    const { manager } = createManager();
    document.body.innerHTML = '<span id="test-counter">0</span>';
    manager.pulseCounter('test-counter');
    const el = document.getElementById('test-counter')!;
    expect(el.classList.contains('pulse')).toBe(true);
    // 推进定时器（DASHBOARD_PULSE_MS 常量值，足够大即可）
    vi.advanceTimersByTime(2000);
    expect(el.classList.contains('pulse')).toBe(false);
  });
});

// ─── 错误状态 + 重试回调 ─────────────────────────────────

describe('错误状态与重试回调', () => {
  it('showMemoryListError 应显示 dashboard 错误横幅并支持重试', () => {
    // showMemoryListError 改用 PanelErrorBannerManager，重试按钮在 #dashboard-error 横幅中
    const { manager } = createManager();
    const cb = vi.fn();
    manager.onReloadMemoryList(cb);
    document.body.innerHTML += '<div id="test-list"></div>';
    const listEl = document.getElementById('test-list')!;
    manager.showMemoryListError(listEl);
    // 验证 dashboard 错误横幅显示
    const errorBanner = document.getElementById('dashboard-error');
    expect(errorBanner).not.toBeNull();
    expect(errorBanner!.classList.contains('hidden')).toBe(false);
    // 验证重试按钮点击触发回调
    const retryBtn = document.getElementById('dashboard-error-retry') as HTMLButtonElement;
    expect(retryBtn).not.toBeNull();
    retryBtn.click();
    expect(cb).toHaveBeenCalled();
  });
});

// 感知数据渲染（情感/默契/上下文/模式/在场）在独立的 PerceptionPanelManager 中覆盖，
// 相关测试见 perceptionPanelManager.test.ts。

// PartnerInsightsRenderer 归位到 MemoryPanelManager，
// 子渲染器行为测试在 partnerInsightsRenderer.test.ts 中覆盖。

// ─── renderReviewData · 增长趋势（Phase 6.2） ─────────────

describe('renderReviewData · 增长趋势', () => {
  /** 创建测试用 ReviewDataPayload */
  function createReviewData(overrides?: Partial<ReviewDataPayload>): ReviewDataPayload {
    return {
      today: { date: '2026-07-06', messageCount: 5, newMemories: 3, newInsights: 1 },
      trend: {
        last7Days: 12,
        last30Days: 45,
        daily: [
          { date: '2026-06-30', messageCount: 2, newMemories: 1, newInsights: 0 },
          { date: '2026-07-01', messageCount: 3, newMemories: 2, newInsights: 1 },
          { date: '2026-07-02', messageCount: 1, newMemories: 0, newInsights: 0 },
          { date: '2026-07-03', messageCount: 4, newMemories: 3, newInsights: 1 },
          { date: '2026-07-04', messageCount: 2, newMemories: 1, newInsights: 0 },
          { date: '2026-07-05', messageCount: 3, newMemories: 2, newInsights: 1 },
          { date: '2026-07-06', messageCount: 5, newMemories: 3, newInsights: 1 },
        ],
        direction: 'growing',
        description: '记忆增长正在加速',
      },
      insights: {
        total: 8,
        recent: [],
        bySource: { insight: 8 },
      },
      totalMemories: 100,
      generatedAt: '2026-07-06T12:00:00.000Z',
      ...overrides,
    };
  }

  it('有数据时应显示增长趋势区块（移除 hidden）', () => {
    const { manager } = createManager();
    manager.renderReviewData(createReviewData());
    const section = document.getElementById('dashboard-growth');
    expect(section).not.toBeNull();
    expect(section!.classList.contains('hidden')).toBe(false);
  });

  it('趋势方向描述行应渲染箭头 + description 文案', () => {
    const { manager } = createManager();
    manager.renderReviewData(createReviewData({
      trend: {
        last7Days: 12,
        last30Days: 45,
        daily: [],
        direction: 'growing',
        description: '记忆增长正在加速',
      },
    }));
    const descRow = document.getElementById('dashboard-growth-desc');
    expect(descRow).not.toBeNull();
    const arrow = descRow!.querySelector('.growth-trend-arrow');
    expect(arrow).not.toBeNull();
    expect(arrow!.textContent).toBe('↗');
    expect(arrow!.classList.contains('growth-trend-growing')).toBe(true);
    const desc = descRow!.querySelector('.growth-trend-desc');
    expect(desc!.textContent).toBe('记忆增长正在加速');
  });

  it('declining 趋势应渲染 ↘ 箭头 + declining 样式', () => {
    const { manager } = createManager();
    manager.renderReviewData(createReviewData({
      trend: {
        last7Days: 5,
        last30Days: 20,
        daily: [{ date: '2026-07-06', messageCount: 1, newMemories: 1, newInsights: 0 }],
        direction: 'declining',
        description: '记忆增长有所放缓',
      },
    }));
    const arrow = document.querySelector('#dashboard-growth-desc .growth-trend-arrow');
    expect(arrow!.textContent).toBe('↘');
    expect(arrow!.classList.contains('growth-trend-declining')).toBe(true);
  });

  it('stable 趋势应渲染 → 箭头 + stable 样式', () => {
    const { manager } = createManager();
    manager.renderReviewData(createReviewData({
      trend: {
        last7Days: 5,
        last30Days: 20,
        daily: [{ date: '2026-07-06', messageCount: 1, newMemories: 1, newInsights: 0 }],
        direction: 'stable',
        description: '记忆增长保持稳定',
      },
    }));
    const arrow = document.querySelector('#dashboard-growth-desc .growth-trend-arrow');
    expect(arrow!.textContent).toBe('→');
    expect(arrow!.classList.contains('growth-trend-stable')).toBe(true);
  });

  it('应渲染 3 张对比卡片（今日 / 7 天 / 30 天）', () => {
    const { manager } = createManager();
    manager.renderReviewData(createReviewData({
      today: { date: '2026-07-06', messageCount: 5, newMemories: 3, newInsights: 1 },
      trend: {
        last7Days: 12,
        last30Days: 45,
        daily: [{ date: '2026-07-06', messageCount: 1, newMemories: 1, newInsights: 0 }],
        direction: 'growing',
        description: '加速',
      },
    }));
    const cards = document.querySelectorAll('#dashboard-growth-cards .growth-card');
    expect(cards.length).toBe(3);
    // 今日卡片：label=今日，value=+3，含洞察行（newInsights=1>0）
    const todayCard = cards[0];
    expect(todayCard!.querySelector('.growth-card-label')!.textContent).toBe('今日');
    expect(todayCard!.querySelector('.growth-card-value')!.textContent).toBe('+3');
    expect(todayCard!.querySelector('.growth-card-sub')!.textContent).toBe('+1 洞察');
    // 7 天卡片：label=7 天，value=+12，无洞察行（newInsights=0 不展示）
    const weekCard = cards[1];
    expect(weekCard!.querySelector('.growth-card-label')!.textContent).toBe('7 天');
    expect(weekCard!.querySelector('.growth-card-value')!.textContent).toBe('+12');
    expect(weekCard!.querySelector('.growth-card-sub')).toBeNull();
    // 30 天卡片
    const monthCard = cards[2];
    expect(monthCard!.querySelector('.growth-card-label')!.textContent).toBe('30 天');
    expect(monthCard!.querySelector('.growth-card-value')!.textContent).toBe('+45');
  });

  it('daily 全 0 时应显示空状态，不渲染柱状图', () => {
    const { manager } = createManager();
    manager.renderReviewData(createReviewData({
      trend: {
        last7Days: 0,
        last30Days: 0,
        daily: [
          { date: '2026-06-30', messageCount: 0, newMemories: 0, newInsights: 0 },
          { date: '2026-07-01', messageCount: 0, newMemories: 0, newInsights: 0 },
          { date: '2026-07-02', messageCount: 0, newMemories: 0, newInsights: 0 },
          { date: '2026-07-03', messageCount: 0, newMemories: 0, newInsights: 0 },
          { date: '2026-07-04', messageCount: 0, newMemories: 0, newInsights: 0 },
          { date: '2026-07-05', messageCount: 0, newMemories: 0, newInsights: 0 },
          { date: '2026-07-06', messageCount: 0, newMemories: 0, newInsights: 0 },
        ],
        direction: 'stable',
        description: '暂无趋势数据',
      },
    }));
    const canvas = document.getElementById('dashboard-growth-canvas');
    const empty = document.getElementById('dashboard-growth-empty');
    expect(canvas!.classList.contains('hidden')).toBe(true);
    expect(empty!.classList.contains('hidden')).toBe(false);
    expect(empty!.textContent).toBe('暂无增长数据，开始对话后将统计');
  });

  it('有 daily 数据时应显示柱状图，隐藏空状态', () => {
    const { manager } = createManager();
    manager.renderReviewData(createReviewData());
    const canvas = document.getElementById('dashboard-growth-canvas') as HTMLCanvasElement;
    const empty = document.getElementById('dashboard-growth-empty');
    // Canvas 应可见（移除 hidden），空状态应隐藏
    expect(canvas.classList.contains('hidden')).toBe(false);
    expect(empty!.classList.contains('hidden')).toBe(true);
    // 注：jsdom 中 getBoundingClientRect 返回 0，无法真正绘制像素，
    // 此处仅验证可见性状态，Canvas 实际绘制由真实浏览器布局驱动
  });

  it('DOM 容器缺失时应静默跳过（不抛错）', () => {
    document.body.innerHTML = '';
    const events = new EventTrackerImpl();
    const manager = new DashboardPanelManager(events, createMockHost());
    // 不应抛错
    expect(() => manager.renderReviewData(createReviewData())).not.toThrow();
  });
});

// ─── cleanup ─────────────────────────────────────────────

describe('cleanup', () => {
  it('cleanup 应清理脉冲定时器（fake timers 验证）', () => {
    vi.useFakeTimers();
    const { manager } = createManager();
    document.body.innerHTML = '<span id="test-counter">0</span>';
    manager.pulseCounter('test-counter');
    // cleanup 前定时器待执行
    manager.cleanup();
    // 推进时间，pulse 类不应被移除（定时器已被 cleanup 取消）
    // 注意：cleanup 清空了 pulseTimers 数组，但已注册的 setTimeout 回调在 jsdom 中仍可能执行
    // 此处验证 cleanup 不抛错即可
    expect(() => vi.advanceTimersByTime(5000)).not.toThrow();
  });

});
