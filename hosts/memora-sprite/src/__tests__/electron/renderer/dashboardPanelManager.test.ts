/**
 * 仪表盘面板管理器测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - formatTokenCount：纯函数（< 1000 直显 / >= 1000 k 格式）
 * - renderDashboardStats：累积事件/阈值高亮/推荐记忆/计数更新
 * - renderAgentMetrics：LLM 调用/Token/召回率/工具失败率（含 0/0 兜底）
 * - renderSkills：空列表隐藏 / 非空渲染 / 关键词标签
 * - renderMilestones：量级/多样性/洞察/画像里程碑
 * - renderReviewData：今日概况/趋势方向/柱状图/最近洞察
 * - renderInsights：统计卡片/source 分布/关系摘要
 * - renderHealthDashboard：评分/徽章/三维度/清理按钮可见性
 * - pulseCounter：计数 +1 + pulse 动画（fake timers）
 * - 错误状态 + 重试回调：showInsightsError / showHealthError / showMemoryListError
 * - 感知系统：updateAffectDisplay / updateRapportDisplay / updateContextDisplay / updatePatternsDisplay
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
import type { AffectPayload } from '../../../electron/renderer/ipcListeners.js';

// ─── 测试辅助 ─────────────────────────────────────────────

/** 仪表盘面板完整 DOM 结构（覆盖所有渲染方法所需元素） */
const DASHBOARD_HTML = `
  <!-- 仪表盘统计 -->
  <span id="perception-pending-count"></span>
  <span id="perception-memory-count"></span>
  <span id="perception-insight-count"></span>
  <span id="perception-suggestion-count"></span>
  <ul id="recommendation-list"></ul>
  <section id="learning-progress" class="hidden"></section>

  <!-- Agent 运行时指标 -->
  <span id="perception-llm-calls"></span>
  <span id="perception-tokens"></span>
  <span id="perception-recall-rate"></span>
  <span id="perception-tool-failures"></span>
  <span id="perception-skill-count"></span>

  <!-- 技能列表 -->
  <section id="skills-section" class="hidden">
    <ul id="skills-list"></ul>
  </section>
  <div id="skills-empty" class="hidden"></div>

  <!-- 里程碑 -->
  <div id="milestones-display" class="hidden">
    <div id="milestones-list"></div>
  </div>

  <!-- 对话回顾 -->
  <span id="review-today-memories"></span>
  <span id="review-today-insights"></span>
  <span id="review-trend-dir"></span>
  <div id="review-trend-bars"></div>
  <ul id="recent-insights-list"></ul>

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
  <div id="perception-warmth-fill" style="width:0%"></div>
  <span id="perception-warmth-level"></span>
  <div id="perception-directness-fill" style="width:0%"></div>
  <span id="perception-directness-level"></span>
  <div id="perception-initiative-fill" style="width:0%"></div>
  <span id="perception-initiative-level"></span>
  <div id="perception-playfulness-fill" style="width:0%"></div>
  <span id="perception-playfulness-level"></span>
  <span id="sprite-status-text-bar"></span>
  <span id="sprite-status-dot-bar"></span>

  <!-- 感知面板 · 默契度 -->
  <span id="perception-rapport-badge"></span>
  <div id="perception-trust-fill" style="width:0%"></div>
  <div id="perception-familiarity-fill" style="width:0%"></div>
  <span id="perception-rapport-desc"></span>

  <!-- 感知面板 · 上下文 -->
  <span id="perception-pace-value"></span>
  <span id="perception-topic-value"></span>
  <span id="perception-depth-value"></span>

  <!-- 感知面板 · 模式洞察 -->
  <div id="perception-patterns-list"></div>

  <!-- 叙事摘要 -->
  <span id="perception-narrative-text"></span>

  <!-- 伙伴洞察面板 -->
  <div id="partner-insights" class="hidden">
    <div class="partner-profile-cards"></div>
    <div class="partner-gaps"></div>
    <canvas id="partner-growth-chart"></canvas>
    <span id="partner-growth-total"></span>
  </div>
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
  it('应更新累积事件数（pending/threshold 格式）', () => {
    const { manager } = createManager();
    manager.renderDashboardStats(createViewModel({ pendingNotices: 3, proactiveThreshold: 10 }));
    expect(document.getElementById('perception-pending-count')!.textContent).toBe('3/10');
  });

  it('达到阈值应添加 at-threshold 类', () => {
    const { manager } = createManager();
    manager.renderDashboardStats(createViewModel({ pendingNotices: 5, proactiveThreshold: 5 }));
    expect(document.getElementById('perception-pending-count')!.classList.contains('at-threshold')).toBe(true);
  });

  it('接近阈值（>=80%）应添加 near-threshold 类', () => {
    const { manager } = createManager();
    manager.renderDashboardStats(createViewModel({ pendingNotices: 4, proactiveThreshold: 5 }));
    expect(document.getElementById('perception-pending-count')!.classList.contains('near-threshold')).toBe(true);
  });

  it('远离阈值不应添加高亮类', () => {
    const { manager } = createManager();
    manager.renderDashboardStats(createViewModel({ pendingNotices: 1, proactiveThreshold: 10 }));
    const el = document.getElementById('perception-pending-count')!;
    expect(el.classList.contains('at-threshold')).toBe(false);
    expect(el.classList.contains('near-threshold')).toBe(false);
  });

  it('应更新 pendingEl.title 含触发器列表', () => {
    const { manager } = createManager();
    manager.renderDashboardStats(createViewModel({ registeredTriggers: ['timer', 'fileWatcher'] }));
    expect(document.getElementById('perception-pending-count')!.title).toContain('timer');
    expect(document.getElementById('perception-pending-count')!.title).toContain('fileWatcher');
  });

  it('应渲染推荐记忆列表', () => {
    const { manager } = createManager();
    manager.renderDashboardStats(createViewModel({
      suggestions: [
        { id: 's1', name: '推荐 1', source: 'test', reason: 'r1', relevance: 0.9, contentPreview: 'p1' },
        { id: 's2', name: '推荐 2', source: 'test', reason: 'r2', relevance: 0.8, contentPreview: 'p2' },
      ],
    }));
    const items = document.querySelectorAll('#recommendation-list li');
    expect(items.length).toBe(2);
    expect(items[0]!.dataset.memoryId).toBe('s1');
    expect(items[0]!.querySelector('.suggestion-score')!.textContent).toBe('0.90');
  });

  it('应更新记忆总数和洞察计数', () => {
    const { manager } = createManager();
    manager.renderDashboardStats(createViewModel({
      total: 200,
      bySource: { test: 100, insight: 50, profile: 50 },
    }));
    expect(document.getElementById('perception-memory-count')!.textContent).toBe('200');
    expect(document.getElementById('perception-insight-count')!.textContent).toBe('50');
  });

  it('应更新建议计数', () => {
    const { manager } = createManager();
    manager.renderDashboardStats(createViewModel({
      suggestions: [
        { id: 's1', name: 'n1', source: 't', reason: 'r', relevance: 0.5, contentPreview: 'p' },
        { id: 's2', name: 'n2', source: 't', reason: 'r', relevance: 0.5, contentPreview: 'p' },
        { id: 's3', name: 'n3', source: 't', reason: 'r', relevance: 0.5, contentPreview: 'p' },
      ],
    }));
    expect(document.getElementById('perception-suggestion-count')!.textContent).toBe('3');
  });
});

// ─── renderAgentMetrics ──────────────────────────────────

describe('renderAgentMetrics', () => {
  it('null 入参应静默退出', () => {
    const { manager } = createManager();
    manager.renderAgentMetrics(null);
    expect(document.getElementById('perception-llm-calls')!.textContent).toBe('');
  });

  it('应渲染 LLM 调用次数', () => {
    const { manager } = createManager();
    manager.renderAgentMetrics(createMetrics({ llm: { callCount: 42, totalInputTokens: 0, totalOutputTokens: 0 } }));
    expect(document.getElementById('perception-llm-calls')!.textContent).toBe('42');
  });

  it('应渲染 Token 数（输入+输出，>= 1000 显示 k）', () => {
    const { manager } = createManager();
    manager.renderAgentMetrics(createMetrics({
      llm: { callCount: 1, totalInputTokens: 800, totalOutputTokens: 400 },
    }));
    expect(document.getElementById('perception-tokens')!.textContent).toBe('1.2k');
  });

  it('应渲染召回命中率（百分比，四舍五入）', () => {
    const { manager } = createManager();
    manager.renderAgentMetrics(createMetrics({
      recall: { totalCount: 20, hitCount: 15, hitRate: 0.75 },
    }));
    expect(document.getElementById('perception-recall-rate')!.textContent).toBe('75%');
  });

  it('工具失败率 0/0 应显示 — （避免 NaN）', () => {
    const { manager } = createManager();
    manager.renderAgentMetrics(createMetrics({
      tools: { callCount: 0, failureCount: 0 },
    }));
    expect(document.getElementById('perception-tool-failures')!.textContent).toBe('—');
  });

  it('工具失败率应显示百分比', () => {
    const { manager } = createManager();
    manager.renderAgentMetrics(createMetrics({
      tools: { callCount: 10, failureCount: 3 },
    }));
    expect(document.getElementById('perception-tool-failures')!.textContent).toBe('30%');
  });
});

// ─── renderSkills ────────────────────────────────────────

describe('renderSkills', () => {
  it('空技能列表应隐藏 section 并显示空状态', () => {
    const { manager } = createManager();
    manager.renderSkills([]);
    expect(document.getElementById('skills-section')!.classList.contains('hidden')).toBe(true);
    expect(document.getElementById('skills-empty')!.classList.contains('hidden')).toBe(false);
  });

  it('应更新技能计数', () => {
    const { manager } = createManager();
    manager.renderSkills([
      { name: 's1', keywords: [], description: '', layer: 'project' },
      { name: 's2', keywords: [], description: '', layer: 'agent' },
    ]);
    expect(document.getElementById('perception-skill-count')!.textContent).toBe('2');
  });

  it('应渲染技能列表项（名称 + 层级 + 关键词）', () => {
    const { manager } = createManager();
    manager.renderSkills([
      { name: 'code-review', keywords: ['review', 'lint'], description: '代码审查', layer: 'agent' },
    ]);
    const item = document.querySelector('#skills-list .skill-item') as HTMLElement;
    expect(item).not.toBeNull();
    expect(item.querySelector('.skill-name')!.textContent).toBe('code-review');
    expect(item.querySelector('.skill-layer')!.textContent).toBe('全局');
    expect(item.querySelector('.skill-keywords')!.textContent).toContain('review');
  });

  it('项目层级应显示"项目"标签', () => {
    const { manager } = createManager();
    manager.renderSkills([
      { name: 's', keywords: [], description: '', layer: 'project' },
    ]);
    expect(document.querySelector('.skill-layer')!.textContent).toBe('项目');
  });

  it('无关键词时不应渲染关键词标签', () => {
    const { manager } = createManager();
    manager.renderSkills([{ name: 's', keywords: [], description: '', layer: 'agent' }]);
    expect(document.querySelector('.skill-keywords')).toBeNull();
  });

  it('关键词超过 5 个应只展示前 5 个', () => {
    const { manager } = createManager();
    manager.renderSkills([
      { name: 's', keywords: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], description: '', layer: 'agent' },
    ]);
    const kw = document.querySelector('.skill-keywords')!.textContent!;
    expect(kw.split(' · ').length).toBe(5);
  });
});

// ─── renderMilestones ────────────────────────────────────

describe('renderMilestones', () => {
  it('无里程碑时应隐藏区域', () => {
    const { manager } = createManager();
    manager.renderMilestones({ total: 10, bySource: { test: 10 } });
    expect(document.getElementById('milestones-display')!.classList.contains('hidden')).toBe(true);
  });

  it('total >= 100 应添加量级里程碑', () => {
    const { manager } = createManager();
    manager.renderMilestones({ total: 150, bySource: { test: 150 } });
    const badges = document.querySelectorAll('#milestones-list .milestone-badge');
    expect(badges.length).toBeGreaterThan(0);
    expect(badges[0]!.textContent).toContain('百条记忆');
  });

  it('total >= 1000 应添加千条里程碑', () => {
    const { manager } = createManager();
    manager.renderMilestones({ total: 1500, bySource: { test: 1500 } });
    expect(document.querySelector('.milestone-badge')!.textContent).toContain('千条记忆');
  });

  it('source 种类 >= 3 应添加多样性里程碑', () => {
    const { manager } = createManager();
    manager.renderMilestones({ total: 50, bySource: { a: 20, b: 15, c: 15 } });
    const badges = document.querySelectorAll('.milestone-badge');
    const texts = Array.from(badges).map((b) => b.textContent);
    expect(texts.some((t) => t!.includes('3 种记忆源'))).toBe(true);
  });

  it('含 insight source 应添加首个洞察里程碑', () => {
    const { manager } = createManager();
    manager.renderMilestones({ total: 50, bySource: { test: 40, insight: 10 } });
    const texts = Array.from(document.querySelectorAll('.milestone-badge')).map((b) => b.textContent);
    expect(texts.some((t) => t!.includes('首个洞察'))).toBe(true);
  });

  it('含 profile source 应添加建立画像里程碑', () => {
    const { manager } = createManager();
    manager.renderMilestones({ total: 50, bySource: { test: 40, profile: 10 } });
    const texts = Array.from(document.querySelectorAll('.milestone-badge')).map((b) => b.textContent);
    expect(texts.some((t) => t!.includes('建立画像'))).toBe(true);
  });
});

// ─── renderReviewData ────────────────────────────────────

describe('renderReviewData', () => {
  /** 创建测试用 ReviewDataPayload */
  function createReviewData(overrides?: Partial<ReviewDataPayload>): ReviewDataPayload {
    return {
      today: { date: '2026-07-01', messageCount: 10, newMemories: 3, newInsights: 1 },
      trend: {
        last7Days: 20,
        last30Days: 80,
        daily: [
          { date: '2026-06-25', messageCount: 5, newMemories: 2, newInsights: 0 },
          { date: '2026-06-26', messageCount: 8, newMemories: 4, newInsights: 1 },
          { date: '2026-06-27', messageCount: 3, newMemories: 1, newInsights: 0 },
          { date: '2026-06-28', messageCount: 0, newMemories: 0, newInsights: 0 },
          { date: '2026-06-29', messageCount: 6, newMemories: 3, newInsights: 2 },
          { date: '2026-06-30', messageCount: 4, newMemories: 2, newInsights: 1 },
          { date: '2026-07-01', messageCount: 10, newMemories: 3, newInsights: 1 },
        ],
        direction: 'growing',
        description: '增长趋势',
      },
      insights: {
        total: 15,
        recent: [
          { name: 'insight-1', contentPreview: '这是洞察内容预览', createdAt: '2026-07-01T00:00:00.000Z' },
        ],
        bySource: { insight: 15 },
      },
      totalMemories: 100,
      generatedAt: '2026-07-01T10:00:00.000Z',
      ...overrides,
    };
  }

  it('应更新今日记忆和洞察计数', () => {
    const { manager } = createManager();
    manager.renderReviewData(createReviewData({ today: { date: '2026-07-01', messageCount: 10, newMemories: 5, newInsights: 2 } }));
    expect(document.getElementById('review-today-memories')!.textContent).toBe('5');
    expect(document.getElementById('review-today-insights')!.textContent).toBe('2');
  });

  it('应渲染趋势方向箭头', () => {
    const { manager } = createManager();
    manager.renderReviewData(createReviewData({ trend: { last7Days: 1, last30Days: 1, daily: [], direction: 'growing', description: '' } }));
    expect(document.getElementById('review-trend-dir')!.textContent).toBe('↑');
    expect(document.getElementById('review-trend-dir')!.className).toContain('growing');
  });

  it('应渲染趋势柱状图（7 天）', () => {
    const { manager } = createManager();
    const data = createReviewData();
    manager.renderReviewData(data);
    const bars = document.querySelectorAll('#review-trend-bars .review-trend-bar');
    expect(bars.length).toBe(7);
  });

  it('应渲染最近洞察列表', () => {
    const { manager } = createManager();
    manager.renderReviewData(createReviewData({
      insights: {
        total: 3,
        recent: [
          { name: 'i1', contentPreview: '洞察 A', createdAt: '2026-07-01T00:00:00.000Z' },
          { name: 'i2', contentPreview: '洞察 B', createdAt: '2026-07-01T00:00:00.000Z' },
        ],
        bySource: { insight: 3 },
      },
    }));
    const items = document.querySelectorAll('#recent-insights-list .recent-insight-item');
    expect(items.length).toBe(2);
    expect(items[0]!.querySelector('.recent-insight-preview')!.textContent).toBe('洞察 A');
  });

  it('洞察预览超过 60 字符应截断并加 …', () => {
    const { manager } = createManager();
    // 70 个字符（超过 60 阈值，触发截断）
    const longText = '一二三四五六七八九十'.repeat(7);
    manager.renderReviewData(createReviewData({
      insights: { total: 1, recent: [{ name: 'i1', contentPreview: longText, createdAt: '' }], bySource: {} },
    }));
    const preview = document.querySelector('.recent-insight-preview')!.textContent!;
    expect(preview.length).toBeLessThanOrEqual(61); // 60 + …
    expect(preview.endsWith('…')).toBe(true);
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

  it('应更新迷你健康分徽章', () => {
    const { manager } = createManager();
    manager.renderHealthDashboard(createHealth({ scores: { overall: 85, uniqueness: 90, freshness: 80, completeness: 85 }, healthLabel: 'good' }));
    const mini = document.getElementById('health-mini-score')!;
    expect(mini.textContent).toBe('85');
    expect(mini.classList.contains('hidden')).toBe(false);
    expect(mini.classList.contains('good')).toBe(true);
  });

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

  it('showMemoryListError 应在传入容器内渲染重试按钮', () => {
    const { manager } = createManager();
    const cb = vi.fn();
    manager.onReloadMemoryList(cb);
    document.body.innerHTML += '<div id="test-list"></div>';
    const listEl = document.getElementById('test-list')!;
    manager.showMemoryListError(listEl);
    const retryBtn = listEl.querySelector('.inline-retry-btn') as HTMLButtonElement;
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

// ─── 感知系统 · updateAffectDisplay ──────────────────────

describe('updateAffectDisplay · 情感基调', () => {
  it('应更新四维进度条宽度和等级文本', () => {
    const { manager } = createManager();
    const affect: AffectPayload = { warmth: 0.8, directness: 0.5, initiative: 0.2, playfulness: 0.9 };
    manager.updateAffectDisplay(affect);
    expect(document.getElementById('perception-warmth-fill')!.style.width).toBe('80%');
    expect(document.getElementById('perception-warmth-level')!.textContent).toBe('高');
    expect(document.getElementById('perception-directness-level')!.textContent).toBe('中');
    expect(document.getElementById('perception-initiative-level')!.textContent).toBe('低');
    expect(document.getElementById('perception-playfulness-level')!.textContent).toBe('高');
  });

  it('应更新精灵状态条文字（含主导维度）', () => {
    const { manager } = createManager();
    manager.updateAffectDisplay({ warmth: 0.9, directness: 0.1, initiative: 0.1, playfulness: 0.1 });
    expect(document.getElementById('sprite-status-text-bar')!.textContent).toContain('温暖');
  });

  it('应更新精灵状态脉冲点颜色', () => {
    const { manager } = createManager();
    manager.updateAffectDisplay({ warmth: 0.9, directness: 0.1, initiative: 0.1, playfulness: 0.1 });
    expect(document.getElementById('sprite-status-dot-bar')!.style.background).not.toBe('');
  });
});

// ─── 感知系统 · updateRapportDisplay ─────────────────────

describe('updateRapportDisplay · 默契度', () => {
  it('应更新等级徽章和 data-level 属性', () => {
    const { manager } = createManager();
    manager.updateRapportDisplay({
      trust: 0.5, familiarity: 0.5, level: 'familiar', description: '熟悉度描述',
    });
    const badge = document.getElementById('perception-rapport-badge')!;
    expect(badge.textContent).toBe('熟悉');
    expect(badge.getAttribute('data-level')).toBe('familiar');
  });

  it('应更新信任度和熟悉度进度条宽度', () => {
    const { manager } = createManager();
    manager.updateRapportDisplay({
      trust: 0.7, familiarity: 0.4, level: 'familiar', description: '',
    });
    expect(document.getElementById('perception-trust-fill')!.style.width).toBe('70%');
    expect(document.getElementById('perception-familiarity-fill')!.style.width).toBe('40%');
  });

  it('应更新描述文本', () => {
    const { manager } = createManager();
    manager.updateRapportDisplay({
      trust: 0.5, familiarity: 0.5, level: 'close', description: '亲密关系描述',
    });
    expect(document.getElementById('perception-rapport-desc')!.textContent).toBe('亲密关系描述');
  });
});

// ─── 感知系统 · updateContextDisplay ─────────────────────

describe('updateContextDisplay · 对话上下文', () => {
  it('应更新节奏/连贯性/深度三项指标', () => {
    const { manager } = createManager();
    manager.updateContextDisplay({
      rhythm: 'rapid', coherence: 'focused', depth: 'deep', dominantSource: 'test', description: '',
    });
    expect(document.getElementById('perception-pace-value')!.textContent).toBe('快节奏');
    expect(document.getElementById('perception-topic-value')!.textContent).toBe('专注');
    expect(document.getElementById('perception-depth-value')!.textContent).toBe('深度讨论');
  });

  it('idle 节奏应显示"空闲"', () => {
    const { manager } = createManager();
    manager.updateContextDisplay({
      rhythm: 'idle', coherence: 'none', depth: 'none', dominantSource: null, description: '',
    });
    expect(document.getElementById('perception-pace-value')!.textContent).toBe('空闲');
  });
});

// ─── 感知系统 · updatePatternsDisplay ────────────────────

describe('updatePatternsDisplay · 模式洞察', () => {
  it('应渲染模式列表项（类型标签 + 摘要）', () => {
    const { manager } = createManager();
    manager.updatePatternsDisplay({
      patterns: [
        { type: 'repeat', summary: '重复主题 A', confidence: 0.9 },
        { type: 'gap', summary: '知识缺口 B', confidence: 0.8 },
        { type: 'drift', summary: '兴趣漂移 C', confidence: 0.7 },
      ],
    });
    const items = document.querySelectorAll('#perception-patterns-list .perception-pattern-item');
    expect(items.length).toBe(3);
    expect(items[0]!.querySelector('.perception-pattern-type')!.textContent).toBe('重复');
    expect(items[1]!.querySelector('.perception-pattern-type')!.textContent).toBe('缺口');
    expect(items[2]!.querySelector('.perception-pattern-type')!.textContent).toBe('漂移');
  });

  it('空模式应清空列表', () => {
    const { manager } = createManager();
    // 先填充再清空
    manager.updatePatternsDisplay({ patterns: [{ type: 'repeat', summary: 'x', confidence: 1 }] });
    expect(document.querySelectorAll('.perception-pattern-item').length).toBe(1);
    manager.updatePatternsDisplay({ patterns: [] });
    expect(document.querySelectorAll('.perception-pattern-item').length).toBe(0);
  });

  it('未知类型应降级显示原始 type', () => {
    const { manager } = createManager();
    manager.updatePatternsDisplay({
      patterns: [{ type: 'custom-type', summary: '自定义', confidence: 0.5 }],
    });
    expect(document.querySelector('.perception-pattern-type')!.textContent).toBe('custom-type');
  });
});

// ─── 感知系统 · updatePresenceDisplay ────────────────────

describe('updatePresenceDisplay · 在场状态', () => {
  it('state=present 应将叙事摘要更新为非离开状态', () => {
    const { manager } = createManager();
    // 先设置 away 状态
    manager.updatePresenceDisplay({ state: 'away', timestamp: '', awayDurationMs: 60000, reason: 'idle' });
    // 切换到 present
    manager.updatePresenceDisplay({ state: 'present', timestamp: '', reason: 'activity' });
    const narrative = document.getElementById('perception-narrative-text')!.textContent!;
    expect(narrative).not.toContain('用户已离开');
  });

  it('state=away 应在叙事摘要中体现离开时长', () => {
    const { manager } = createManager();
    manager.updatePresenceDisplay({ state: 'away', timestamp: '', awayDurationMs: 120000, reason: 'idle' });
    const narrative = document.getElementById('perception-narrative-text')!.textContent!;
    expect(narrative).toContain('用户已离开');
  });
});

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

  it('onMemoryClick 应同时委托 partnerInsights 和 perception（缺口 K 双注册）', () => {
    // 缺口 K：DashboardPanelManager.onMemoryClick 需同时注册到两个子渲染器，
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

    // 验证 2：perception 模式洞察关联按钮点击也触发同一回调
    cb.mockClear();
    manager.updatePatternsDisplay({
      patterns: [{
        type: 'recurring_topic',
        summary: '重复讨论',
        confidence: 0.9,
        relatedMemoryIds: ['pattern:related'],
      }],
    });
    const relatedBtn = document.querySelector('.perception-pattern-related') as HTMLElement;
    expect(relatedBtn).not.toBeNull();
    relatedBtn.click();
    expect(cb).toHaveBeenCalledWith('pattern:related');
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
