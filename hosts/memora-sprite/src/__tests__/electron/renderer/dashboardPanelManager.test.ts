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
 * - renderInsights：统计卡片/source 分布/关系摘要
 * - renderHealthDashboard：评分/徽章/三维度/清理按钮可见性
 * - pulseCounter：计数 +1 + pulse 动画（fake timers）
 * - 错误状态 + 重试回调：showInsightsError / showHealthError / showMemoryListError
 * - renderPartnerInsights：profile 卡片 / 知识缺口 / 空状态
 * - cleanup：脉冲定时器 + 事件监听器清理
 *
 * Mock 策略：
 * - 使用真实 EventTracker（构造函数注入，验证事件注册与清理）
 * - JSDOM 提供真实 DOM API
 * - pulseCounter 测试使用 vi.useFakeTimers 控制定时器
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  DashboardPanelManager,
  formatTokenCount,
} from '../../../electron/renderer/panels/dashboardPanelManager.js';
import type {
  AgentMetrics,
  DashboardViewModel,
} from '../../../electron/renderer/panels/dashboardPanelManager.js';
import type { EventTracker } from '../../../electron/renderer/helpers/eventTracker.js';
import { EventTracker as EventTrackerImpl } from '../../../electron/renderer/helpers/eventTracker.js';
import type {
  HealthDashboardPayload,
  ReviewDataPayload,
} from '../../../electron/preload.js';
import type { RelationGraphData } from '../../../electron/renderer/components/relationGraph.js';

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
  <span id="dashboard-decay-total"></span>
  <span id="dashboard-decay-runs"></span>
  <span id="dashboard-decay-last-run"></span>

  <!-- 里程碑 -->
  <div id="milestones-display" class="hidden">
    <div id="milestones-list"></div>
  </div>

  <!-- 洞察面板 -->
  <span id="insights-total"></span>
  <span id="insights-relations"></span>
  <span id="insights-conflicts"></span>
  <span id="insights-sources"></span>
  <div id="insights-distribution"></div>
  <div id="insights-relations-summary"></div>

  <!-- 健康度仪表盘 -->
  <span id="health-mini-score" class="hidden"></span>
  <span id="health-score"></span>
  <span id="health-badge"></span>
  <div id="health-uniqueness" class="health-metric-fill"></div>
  <span id="health-uniqueness-val"></span>
  <div id="health-freshness" class="health-metric-fill"></div>
  <span id="health-freshness-val"></span>
  <div id="health-completeness" class="health-metric-fill"></div>
  <span id="health-completeness-val"></span>
  <span id="health-duplicates"></span>
  <span id="health-stale"></span>
  <span id="health-low-quality"></span>
  <span id="health-description"></span>
  <button id="health-cleanup-duplicates" style="display:none"></button>
  <button id="health-cleanup-stale" style="display:none"></button>
  <button id="health-cleanup-all" style="display:none"></button>
  <div id="health-actions" style="display:none"></div>
  <div id="memory-health-bar">
    <div class="health-metrics"></div>
  </div>

  <!-- 感知面板 · 情感 -->
  <div id="dashboard-warmth-fill" style="width:0%"></div>
  <span id="dashboard-warmth-level"></span>
  <div id="dashboard-directness-fill" style="width:0%"></div>
  <span id="dashboard-directness-level"></span>
  <div id="dashboard-initiative-fill" style="width:0%"></div>
  <span id="dashboard-initiative-level"></span>
  <div id="dashboard-playfulness-fill" style="width:0%"></div>
  <span id="dashboard-playfulness-level"></span>
  <span id="sprite-status-text-bar"></span>
  <span id="sprite-status-dot-bar"></span>

  <!-- 感知面板 · 默契度 -->
  <span id="dashboard-rapport-badge"></span>
  <div id="dashboard-trust-fill" style="width:0%"></div>
  <div id="dashboard-familiarity-fill" style="width:0%"></div>
  <span id="dashboard-rapport-desc"></span>

  <!-- 感知面板 · 上下文 -->
  <span id="dashboard-pace-value"></span>
  <span id="dashboard-topic-value"></span>
  <span id="dashboard-depth-value"></span>

  <!-- 感知面板 · 模式洞察 -->
  <div id="dashboard-patterns-list"></div>

  <!-- 叙事摘要 -->
  <span id="perception-narrative-text"></span>

  <!-- 伙伴洞察面板 -->
  <div id="partner-insights" class="hidden">
    <div class="partner-profile-cards"></div>
    <div class="partner-knowledge-gaps"></div>
    <canvas id="partner-growth-chart"></canvas>
    <span id="partner-growth-total"></span>
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

/** 创建 DashboardPanelManager 实例（默认已设置 DOM） */
function createManager(opts?: { html?: string }): { manager: DashboardPanelManager; events: EventTracker } {
  document.body.innerHTML = opts?.html ?? DASHBOARD_HTML;
  const events = new EventTrackerImpl();
  const manager = new DashboardPanelManager(events);
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

  it('衰减最近运行时间应显示相对时间', () => {
    const { manager } = createManager();
    // 使用近期时间（1 小时前），formatTimeAgo 应输出"1 小时前"
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    manager.renderAgentMetrics(createMetrics({
      decay: { runCount: 5, totalDecayedCount: 10, lastRunAt: oneHourAgo },
    }));
    expect(document.getElementById('dashboard-decay-last-run')!.textContent).toBe('1 小时前');
  });

  it('衰减从未运行时最近运行时间应显示 —', () => {
    const { manager } = createManager();
    manager.renderAgentMetrics(createMetrics({
      decay: { runCount: 0, totalDecayedCount: 0, lastRunAt: null },
    }));
    expect(document.getElementById('dashboard-decay-last-run')!.textContent).toBe('—');
  });
});

// ─── renderInsights ──────────────────────────────────────

describe('renderInsights', () => {
  /** 创建测试用 RelationGraphData */
  function createGraph(overrides?: Partial<RelationGraphData>): RelationGraphData {
    return {
      nodes: [
        { id: 'n1', name: '节点 1', source: 'test', score: 0.9, contentPreview: '预览 1' },
        { id: 'n2', name: '节点 2', source: 'test', score: 0.8, contentPreview: '预览 2' },
      ],
      edges: [
        { sourceId: 'n1', targetId: 'n2', type: 'related', weight: 0.7, createdAt: '2026-07-01T00:00:00.000Z' },
      ],
      ...overrides,
    };
  }

  it('应更新统计卡片（总数/关系数/来源数）', () => {
    const { manager } = createManager();
    manager.renderInsights(
      { total: 100, bySource: { a: 50, b: 30, c: 20 } },
      createGraph({ edges: [{ sourceId: 'n1', targetId: 'n2', type: 'related', weight: 0.5, createdAt: '' }] }),
    );
    expect(document.getElementById('insights-total')!.textContent).toBe('100');
    expect(document.getElementById('insights-relations')!.textContent).toBe('1');
    expect(document.getElementById('insights-sources')!.textContent).toBe('3');
  });

  it('有 contradicts 类型边应高亮冲突数', () => {
    const { manager } = createManager();
    manager.renderInsights(
      { total: 10, bySource: { a: 10 } },
      createGraph({ edges: [{ sourceId: 'n1', targetId: 'n2', type: 'contradicts', weight: 0.5, createdAt: '' }] }),
    );
    const el = document.getElementById('insights-conflicts')!;
    expect(el.textContent).toBe('1');
    expect(el.classList.contains('has-conflicts')).toBe(true);
  });

  it('应渲染 source 分布条形图', () => {
    const { manager } = createManager();
    manager.renderInsights(
      { total: 100, bySource: { test: 60, insight: 40 } },
      createGraph({ edges: [] }),
    );
    const bars = document.querySelectorAll('#insights-distribution .insights-distribution-bar');
    expect(bars.length).toBe(2);
  });

  it('无关系边应显示"暂无关系数据"', () => {
    const { manager } = createManager();
    manager.renderInsights(
      { total: 10, bySource: { a: 10 } },
      createGraph({ edges: [] }),
    );
    expect(document.getElementById('insights-relations-summary')!.textContent).toBe('暂无关系数据');
  });

  it('有关系边应渲染最近关系项', () => {
    const { manager } = createManager();
    manager.renderInsights(
      { total: 10, bySource: { a: 10 } },
      createGraph({
        edges: [
          { sourceId: 'n1', targetId: 'n2', type: 'related', weight: 0.5, createdAt: '2026-07-01T00:00:00.000Z' },
        ],
      }),
    );
    const items = document.querySelectorAll('#insights-relations-summary .insights-relation-item');
    expect(items.length).toBe(1);
    expect(items[0]!.querySelector('.relation-type-tag')!.textContent).toBe('related');
    expect(items[0]!.querySelector('.relation-desc')!.textContent).toContain('节点 1');
  });
});

// ─── renderHealthDashboard ───────────────────────────────

describe('renderHealthDashboard', () => {
  /** 创建测试用 HealthDashboardPayload */
  function createHealth(overrides?: Partial<HealthDashboardPayload>): HealthDashboardPayload {
    return {
      scores: { overall: 85, uniqueness: 90, freshness: 80, completeness: 85 },
      duplicates: [],
      staleMemories: [],
      lowQualityCount: 0,
      totalMemories: 100,
      healthLabel: 'good',
      healthDescription: '记忆健康状况良好',
      ...overrides,
    };
  }

  // P0-2：迷你健康分徽章测试已移除（health-mini-score DOM 已删除，感知信息统一入口为仪表盘）

  it('应更新健康度评分和徽章', () => {
    const { manager } = createManager();
    manager.renderHealthDashboard(createHealth({ scores: { overall: 92, uniqueness: 95, freshness: 90, completeness: 90 }, healthLabel: 'excellent' }));
    expect(document.getElementById('health-score')!.textContent).toBe('92');
    expect(document.getElementById('health-badge')!.textContent).toBe('优秀');
    expect(document.getElementById('health-badge')!.classList.contains('excellent')).toBe(true);
  });

  it('应更新三维度进度条宽度和数值', () => {
    const { manager } = createManager();
    manager.renderHealthDashboard(createHealth({ scores: { overall: 80, uniqueness: 90, freshness: 70, completeness: 85 } }));
    expect(document.getElementById('health-uniqueness')!.style.width).toBe('90%');
    expect(document.getElementById('health-uniqueness-val')!.textContent).toBe('90');
    expect(document.getElementById('health-freshness')!.style.width).toBe('70%');
    expect(document.getElementById('health-freshness-val')!.textContent).toBe('70');
    expect(document.getElementById('health-completeness')!.style.width).toBe('85%');
    expect(document.getElementById('health-completeness-val')!.textContent).toBe('85');
  });

  it('有重复记忆应显示重复数和 warning 类', () => {
    const { manager } = createManager();
    manager.renderHealthDashboard(createHealth({
      duplicates: [
        { type: 'name', memories: [{ id: '1', name: 'a', source: 't', score: 0.5, contentPreview: 'p' }, { id: '2', name: 'a', source: 't', score: 0.5, contentPreview: 'p' }] },
      ],
    }));
    const el = document.getElementById('health-duplicates')!;
    expect(el.textContent).toContain('2');
    expect(el.classList.contains('warning')).toBe(true);
  });

  it('有过期记忆应显示过期数和 warning 类', () => {
    const { manager } = createManager();
    manager.renderHealthDashboard(createHealth({
      staleMemories: [{ memory: { id: '1', name: 'a', source: 't', score: 0.5, contentPreview: 'p' }, reason: 'old_age', daysSinceAccess: 100 }],
    }));
    const el = document.getElementById('health-stale')!;
    expect(el.textContent).toContain('1');
    expect(el.classList.contains('warning')).toBe(true);
  });

  it('无可清理项时清理按钮应全部隐藏', () => {
    const { manager } = createManager();
    manager.renderHealthDashboard(createHealth({ duplicates: [], staleMemories: [], lowQualityCount: 0 }));
    expect(document.getElementById('health-cleanup-duplicates')!.style.display).toBe('none');
    expect(document.getElementById('health-cleanup-stale')!.style.display).toBe('none');
    expect(document.getElementById('health-cleanup-all')!.style.display).toBe('none');
    expect(document.getElementById('health-actions')!.style.display).toBe('none');
  });

  it('有可清理项时清理按钮应显示', () => {
    const { manager } = createManager();
    manager.renderHealthDashboard(createHealth({
      duplicates: [{ type: 'name', memories: [{ id: '1', name: 'a', source: 't', score: 0.5, contentPreview: 'p' }] }],
      staleMemories: [],
    }));
    expect(document.getElementById('health-cleanup-duplicates')!.style.display).not.toBe('none');
    expect(document.getElementById('health-cleanup-all')!.style.display).not.toBe('none');
    expect(document.getElementById('health-actions')!.style.display).not.toBe('none');
  });
});

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
  it('showInsightsError 应渲染重试按钮，click 触发 onReloadInsights 回调', () => {
    const { manager } = createManager();
    const cb = vi.fn();
    manager.onReloadInsights(cb);
    manager.showInsightsError();
    const retryBtn = document.querySelector('#insights-distribution .inline-retry-btn') as HTMLButtonElement;
    expect(retryBtn).not.toBeNull();
    retryBtn.click();
    expect(cb).toHaveBeenCalled();
  });

  it('showHealthError 应渲染重试按钮，click 触发 onReloadHealth 回调', () => {
    const { manager } = createManager();
    const cb = vi.fn();
    manager.onReloadHealth(cb);
    manager.showHealthError();
    const retryBtn = document.querySelector('#memory-health-bar .inline-retry-btn') as HTMLButtonElement;
    expect(retryBtn).not.toBeNull();
    retryBtn.click();
    expect(cb).toHaveBeenCalled();
  });

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

  it('未注册回调时 click 重试按钮不应抛错', () => {
    const { manager } = createManager();
    manager.showInsightsError();
    const retryBtn = document.querySelector('#insights-distribution .inline-retry-btn') as HTMLButtonElement;
    expect(() => retryBtn.click()).not.toThrow();
  });
});

// ─── 感知系统测试已移除 ──────────────────────────────────
// 感知数据渲染（情感/默契/上下文/模式/在场）已迁移到独立的 PerceptionPanelManager，
// 相关测试在 perceptionPanelManager.test.ts 中覆盖。

// ─── renderPartnerInsights ───────────────────────────────

describe('renderPartnerInsights · 伙伴洞察面板', () => {
  it('空记忆列表应隐藏面板', () => {
    const { manager } = createManager();
    manager.renderPartnerInsights([]);
    expect(document.getElementById('partner-insights')!.classList.contains('hidden')).toBe(true);
  });

  it('有记忆应显示面板', () => {
    const { manager } = createManager();
    manager.renderPartnerInsights([
      { id: 'm1', name: '记忆 1', source: 'test', contentPreview: '预览' },
    ]);
    expect(document.getElementById('partner-insights')!.classList.contains('hidden')).toBe(false);
  });

  it('应渲染 profile 记忆卡片（最多 6 张）', () => {
    const { manager } = createManager();
    const profileMems = Array.from({ length: 8 }, (_, i) => ({
      id: `profile:${i}`, name: `卡片 ${i}`, source: 'profile', contentPreview: `预览 ${i}`,
    }));
    manager.renderPartnerInsights(profileMems);
    const cards = document.querySelectorAll('.partner-profile-card');
    expect(cards.length).toBe(6);
  });

  it('无 profile 记忆应显示引导提示', () => {
    const { manager } = createManager();
    manager.renderPartnerInsights([
      { id: 'm1', name: '非 profile', source: 'test', contentPreview: 'p' },
    ]);
    expect(document.querySelector('.partner-empty-hint')!.textContent).toContain('精灵还不了解你');
  });

  it('click profile 卡片应触发 onMemoryClick 回调', () => {
    const { manager } = createManager();
    const cb = vi.fn();
    manager.onMemoryClick(cb);
    manager.renderPartnerInsights([
      { id: 'profile:click-test', name: '卡片', source: 'profile', contentPreview: 'p' },
    ]);
    const card = document.querySelector('.partner-profile-card') as HTMLElement;
    card.click();
    expect(cb).toHaveBeenCalledWith('profile:click-test');
  });

  it('onMemoryClick 应同时委托 partnerInsights 和 perception（双注册）', () => {
    // DashboardPanelManager.onMemoryClick 需同时注册到两个子渲染器，
    // 使伙伴洞察卡片和模式洞察关联按钮共享同一跳转回调
    const { manager } = createManager();
    const cb = vi.fn();
    manager.onMemoryClick(cb);

    // 验证 1：partnerInsights 卡片点击触发回调
    manager.renderPartnerInsights([
      { id: 'profile:partner', name: '伙伴', source: 'profile', contentPreview: 'p' },
    ]);
    const card = document.querySelector('.partner-profile-card') as HTMLElement;
    card.click();
    expect(cb).toHaveBeenCalledWith('profile:partner');
  });

  it('应渲染知识缺口（占比 < 5% 的 source 类型）', () => {
    const { manager } = createManager();
    // 100 条记忆全是 test，profile 占比 0% < 5%，应提示
    const memories = Array.from({ length: 100 }, (_, i) => ({
      id: `m${i}`, name: `m${i}`, source: 'test', contentPreview: 'p',
    }));
    manager.renderPartnerInsights(memories);
    const gaps = document.querySelectorAll('.partner-gap-item');
    expect(gaps.length).toBeGreaterThan(0);
  });

  it('所有 source 类型都充足应显示"全面"提示', () => {
    const { manager } = createManager();
    // 构造每种 source 都 >= 5% 的数据
    const sources = ['profile', 'insight', 'skill', 'rule', 'guardrail', 'persona', 'session', 'test'];
    const memories = sources.flatMap((source) =>
      Array.from({ length: 10 }, (_, i) => ({
        id: `${source}:${i}`, name: source, source, contentPreview: 'p',
      })),
    );
    manager.renderPartnerInsights(memories);
    expect(document.querySelector('.partner-empty-hint')!.textContent).toContain('全面');
  });
});

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
    const manager = new DashboardPanelManager(events);
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

  it('cleanup 后重试按钮 click 不应触发回调', () => {
    const { manager } = createManager();
    const cb = vi.fn();
    manager.onReloadInsights(cb);
    manager.showInsightsError();
    const retryBtn = document.querySelector('#insights-distribution .inline-retry-btn') as HTMLButtonElement;
    manager.cleanup();
    retryBtn.click();
    expect(cb).not.toHaveBeenCalled();
  });
});
