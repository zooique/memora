/**
 * 洞察组件独立测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - mount()：采纳静态容器 #memory-insights-bar 为根 + 缓存内部引用（消除 getElementById）
 * - showLoading()：在 distribution / summary 两区插入加载态占位
 * - update({dashboard, graph})：统计卡片 / source 分布条形图 / 关系摘要（空/非空/超过3条截断）
 * - showError()：失败状态 + 重试按钮 + 回调触发
 * - onReloadInsights()：回调注册与触发
 * - destroy()：事件清理 + 回调清空（点击重试不再触发）+ 幂等
 *
 * Mock 策略：
 * - JSDOM 提供真实 DOM API
 * - 组件自身通过 Component.trackEvent 管理重试按钮监听，destroy 时统一解绑
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { InsightsComponent } from '../../../electron/renderer/panels/insightsRenderer.js';
import type { InsightsDashboardData } from '../../../electron/renderer/panels/insightsRenderer.js';
import type { RelationGraphData } from '../../../electron/renderer/components/relationGraph.js';

// ─── 测试辅助 ─────────────────────────────────────────────

/** 洞察面板完整 DOM 结构（含静态容器 #memory-insights-bar，与 index.html 一致） */
const INSIGHTS_HTML = `
  <div id="memory-insights-bar">
    <span class="panel-badge good" id="insights-total-badge">0 条记忆</span>
    <span id="insights-total"></span>
    <span id="insights-relations"></span>
    <span id="insights-conflicts"></span>
    <span id="insights-sources"></span>
    <div id="insights-distribution"></div>
    <div id="insights-relations-summary"></div>
  </div>
`;

/** 创建测试用 InsightsDashboardData */
function createDashboard(overrides?: Partial<InsightsDashboardData>): InsightsDashboardData {
  return {
    total: 100,
    bySource: { test: 50, insight: 30, profile: 20 },
    conflictCount: 2,
    ...overrides,
  };
}

/** 创建测试用 RelationGraphData */
function createGraph(overrides?: Partial<RelationGraphData>): RelationGraphData {
  return {
    nodes: [
      { id: 'n1', name: '节点1', source: 'test', memoryId: 'test:n1' },
      { id: 'n2', name: '节点2', source: 'insight', memoryId: 'insight:n2' },
      { id: 'n3', name: '节点3', source: 'profile', memoryId: 'profile:n3' },
    ],
    edges: [
      { id: 'e1', sourceId: 'n1', targetId: 'n2', type: 'related', createdAt: '2026-07-01T10:00:00.000Z' },
      { id: 'e2', sourceId: 'n2', targetId: 'n3', type: 'contradicts', createdAt: '2026-07-01T11:00:00.000Z' },
      { id: 'e3', sourceId: 'n1', targetId: 'n3', type: 'derived', createdAt: '2026-07-01T12:00:00.000Z' },
      { id: 'e4', sourceId: 'n2', targetId: 'n1', type: 'related', createdAt: '2026-07-01T09:00:00.000Z' },
    ],
    ...overrides,
  };
}

/** 创建并挂载洞察组件（已设置 DOM） */
function createComponent(html?: string): InsightsComponent {
  document.body.innerHTML = html ?? INSIGHTS_HTML;
  return new InsightsComponent().mount('#memory-insights-bar');
}

// ─── 全局设置 ─────────────────────────────────────────────

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

// ─── mount() · 采纳静态容器 ──────────────────────────────

describe('mount() · 采纳静态容器', () => {
  it('应将 #memory-insights-bar 采纳为根元素', () => {
    const component = createComponent();
    expect(component.getElement()?.id).toBe('memory-insights-bar');
  });

  it('容器不存在时应安全降级（el 为 null，不抛错）', () => {
    document.body.innerHTML = '<div></div>';
    const component = new InsightsComponent().mount('#memory-insights-bar');
    expect(component.getElement()).toBeNull();
  });
});

// ─── showLoading() · 加载态 ──────────────────────────────

describe('showLoading() · 加载态', () => {
  it('应在 distribution 区域插入加载态', () => {
    const component = createComponent();
    component.showLoading();
    const distEl = document.getElementById('insights-distribution')!;
    expect(distEl.querySelector('.panel-loading')).not.toBeNull();
  });

  it('应在 relations-summary 区域插入加载态', () => {
    const component = createComponent();
    component.showLoading();
    const summaryEl = document.getElementById('insights-relations-summary')!;
    expect(summaryEl.querySelector('.panel-loading')).not.toBeNull();
  });

  it('面板不存在时应安全降级（不抛错）', () => {
    document.body.innerHTML = '<div></div>';
    const component = new InsightsComponent().mount('#memory-insights-bar');
    expect(() => component.showLoading()).not.toThrow();
  });
});

// ─── update() · 统计卡片 ─────────────────────────────────

describe('update() · 统计卡片', () => {
  it('应更新记忆总数', () => {
    const component = createComponent();
    component.update({ dashboard: createDashboard({ total: 200 }), graph: createGraph() });
    expect(document.getElementById('insights-total')!.textContent).toBe('200');
  });

  it('应更新关系总数（edges.length）', () => {
    const component = createComponent();
    component.update({ dashboard: createDashboard(), graph: createGraph() });
    expect(document.getElementById('insights-relations')!.textContent).toBe('4');
  });

  it('应更新冲突数（优先用 dashboard.conflictCount）', () => {
    const component = createComponent();
    component.update({ dashboard: createDashboard({ conflictCount: 7 }), graph: createGraph() });
    expect(document.getElementById('insights-conflicts')!.textContent).toBe('7');
  });

  it('冲突数应从 edges 过滤（fallback：dashboard.conflictCount 未提供时）', () => {
    const component = createComponent();
    component.update({ dashboard: createDashboard({ conflictCount: undefined }), graph: createGraph() });
    // createGraph 中有 1 条 contradicts 类型 edge
    expect(document.getElementById('insights-conflicts')!.textContent).toBe('1');
  });

  it('有冲突时应添加 has-conflicts 类（红色高亮）', () => {
    const component = createComponent();
    component.update({ dashboard: createDashboard({ conflictCount: 5 }), graph: createGraph() });
    expect(document.getElementById('insights-conflicts')!.classList.contains('has-conflicts')).toBe(true);
  });

  it('无冲突时不应添加 has-conflicts 类', () => {
    const component = createComponent();
    component.update({ dashboard: createDashboard({ conflictCount: 0 }), graph: createGraph() });
    expect(document.getElementById('insights-conflicts')!.classList.contains('has-conflicts')).toBe(false);
  });

  it('应更新来源数（bySource 的 key 数）', () => {
    const component = createComponent();
    component.update({ dashboard: createDashboard({ bySource: { test: 1, insight: 2, profile: 3, rule: 4 } }), graph: createGraph() });
    expect(document.getElementById('insights-sources')!.textContent).toBe('4');
  });

  it('应同步顶部状态徽章文本', () => {
    const component = createComponent();
    component.update({ dashboard: createDashboard({ total: 42 }), graph: createGraph() });
    expect(document.getElementById('insights-total-badge')!.textContent).toBe('42 条记忆');
  });
});

// ─── update() · source 分布条形图 ────────────────────────

describe('update() · source 分布条形图', () => {
  it('应按数量倒序渲染每个 source 的条形', () => {
    const component = createComponent();
    component.update({ dashboard: createDashboard({ bySource: { test: 50, insight: 30, profile: 20 } }), graph: createGraph() });
    const bars = document.querySelectorAll('#insights-distribution .dist-bar');
    expect(bars.length).toBe(3);
    // 第一个应为数量最多的 test
    expect(bars[0]!.querySelector('.dist-bar__label')!.textContent).toBe('test');
  });

  it('最大数量条形宽度应为 100%', () => {
    const component = createComponent();
    component.update({ dashboard: createDashboard({ bySource: { test: 50, insight: 30 } }), graph: createGraph() });
    const fills = document.querySelectorAll('#insights-distribution .dist-bar__fill');
    const firstFill = fills[0] as HTMLElement;
    expect(firstFill.style.width).toBe('100%');
  });

  it('非最大数量条形宽度按比例计算', () => {
    const component = createComponent();
    component.update({ dashboard: createDashboard({ bySource: { test: 50, insight: 25 } }), graph: createGraph() });
    const fills = document.querySelectorAll('#insights-distribution .dist-bar__fill');
    // test=50 (100%), insight=25 (50%)
    expect((fills[0] as HTMLElement).style.width).toBe('100%');
    expect((fills[1] as HTMLElement).style.width).toBe('50%');
  });

  it('空 bySource 应无条形（不报错）', () => {
    const component = createComponent();
    component.update({ dashboard: createDashboard({ bySource: {} }), graph: createGraph() });
    const bars = document.querySelectorAll('#insights-distribution .dist-bar');
    expect(bars.length).toBe(0);
  });

  it('条形应包含 source 颜色类（source-<colorClass>）', () => {
    const component = createComponent();
    component.update({ dashboard: createDashboard({ bySource: { test: 1 } }), graph: createGraph() });
    const fill = document.querySelector('#insights-distribution .dist-bar__fill') as HTMLElement;
    expect(fill.className).toMatch(/^dist-bar__fill source-/);
  });

  it('distribution 容器缺失时应安全降级', () => {
    const component = createComponent('<div id="memory-insights-bar"><span id="insights-total"></span></div>');
    expect(() => component.update({ dashboard: createDashboard(), graph: createGraph() })).not.toThrow();
  });
});

// ─── update() · 关系摘要 ─────────────────────────────────

describe('update() · 关系摘要', () => {
  it('空关系应显示"暂无关系数据"', () => {
    const component = createComponent();
    component.update({ dashboard: createDashboard(), graph: createGraph({ edges: [] }) });
    expect(document.getElementById('insights-relations-summary')!.textContent).toBe('暂无关系数据');
  });

  it('有关系时应渲染标题"最近关系"', () => {
    const component = createComponent();
    component.update({ dashboard: createDashboard(), graph: createGraph() });
    const title = document.querySelector('#insights-relations-summary .panel-section-title');
    expect(title).not.toBeNull();
    expect(title!.textContent).toBe('最近关系');
  });

  it('应按 createdAt 倒序取前 3 条关系', () => {
    const component = createComponent();
    component.update({ dashboard: createDashboard(), graph: createGraph() });
    const items = document.querySelectorAll('#insights-relations-summary .relation-item');
    expect(items.length).toBe(3);
    // 4 条 edges，倒序前 3 条：12:00 / 11:00 / 10:00
    const firstDesc = items[0]!.querySelector('.relation-desc')!.textContent;
    expect(firstDesc).toContain('节点1');
    expect(firstDesc).toContain('节点3');
  });

  it('关系项应展示类型标签和节点名称', () => {
    const component = createComponent();
    component.update({ dashboard: createDashboard(), graph: createGraph() });
    const firstItem = document.querySelector('#insights-relations-summary .relation-item')!;
    expect(firstItem.querySelector('.relation-type-tag')).not.toBeNull();
    expect(firstItem.querySelector('.relation-desc')!.textContent).toMatch(/→/);
  });

  it('summary 容器缺失时应安全降级', () => {
    const component = createComponent('<div id="memory-insights-bar"><span id="insights-total"></span></div>');
    expect(() => component.update({ dashboard: createDashboard(), graph: createGraph() })).not.toThrow();
  });
});

// ─── showError() · 失败状态 + 重试 ───────────────────────

describe('showError() · 失败状态 + 重试', () => {
  it('应在 distribution 区域渲染"加载失败"文案 + 重试按钮', () => {
    const component = createComponent();
    component.showError();
    const distEl = document.getElementById('insights-distribution')!;
    expect(distEl.textContent).toContain('加载失败');
    expect(distEl.querySelector('button.inline-retry-btn')).not.toBeNull();
  });

  it('应在 relations-summary 区域渲染"加载失败"文案 + 重试按钮', () => {
    const component = createComponent();
    component.showError();
    const summaryEl = document.getElementById('insights-relations-summary')!;
    expect(summaryEl.textContent).toContain('加载失败');
    expect(summaryEl.querySelector('button.inline-retry-btn')).not.toBeNull();
  });

  it('点击 distribution 重试按钮应触发 reloadCallback', () => {
    const component = createComponent();
    const cb = vi.fn();
    component.onReloadInsights(cb);
    component.showError();
    const btn = document.querySelector('#insights-distribution button.inline-retry-btn') as HTMLButtonElement;
    btn.click();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('点击 summary 重试按钮应触发 reloadCallback', () => {
    const component = createComponent();
    const cb = vi.fn();
    component.onReloadInsights(cb);
    component.showError();
    const btn = document.querySelector('#insights-relations-summary button.inline-retry-btn') as HTMLButtonElement;
    btn.click();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('未注册回调时点击重试不应抛错（reloadCallback 为 null）', () => {
    const component = createComponent();
    component.showError();
    const btn = document.querySelector('#insights-distribution button.inline-retry-btn') as HTMLButtonElement;
    expect(() => btn.click()).not.toThrow();
  });

  it('面板不存在时应安全降级', () => {
    document.body.innerHTML = '<div></div>';
    const component = new InsightsComponent().mount('#memory-insights-bar');
    expect(() => component.showError()).not.toThrow();
  });
});

// ─── destroy() · 资源清理 ────────────────────────────────

describe('destroy() · 资源清理', () => {
  it('destroy 后点击重试按钮不再触发回调', () => {
    const component = createComponent();
    const cb = vi.fn();
    component.onReloadInsights(cb);
    component.showError();
    const btn = document.querySelector('#insights-distribution button.inline-retry-btn') as HTMLButtonElement;
    component.destroy();
    btn.click();
    expect(cb).not.toHaveBeenCalled();
  });

  it('destroy 应清空 reloadCallback（重复调用 destroy 安全）', () => {
    const component = createComponent();
    component.onReloadInsights(() => {});
    component.destroy();
    expect(() => component.destroy()).not.toThrow();
  });

  it('destroy 不应移除共享静态容器 #memory-insights-bar', () => {
    const component = createComponent();
    component.destroy();
    expect(document.getElementById('memory-insights-bar')).not.toBeNull();
    expect(component.getElement()).toBeNull();
  });
});
