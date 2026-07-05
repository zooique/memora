/**
 * 记忆面板管理器实例方法测试（M1 补测：视图切换 + 分析面板 + 高亮 + 图谱 + 回收站 + 编辑模式）
 *
 * 覆盖范围：
 * - highlightText（private）：HTML 转义 + 正则高亮 + <mark> 包裹 + 特殊字符转义
 * - switchView：list/timeline/graph 切换 + 150ms 过渡动画 + 视图切换令牌（防竞态）
 * - toggleAnalysisPanel/hideAnalysisPanel/dismissAnalysisPanels：互斥切换 + previousViewMode 恢复
 * - loadGraphData/hasGraphData/getViewMode/highlightGraphNodes/selectGraphNode/clearGraphHighlights：图谱状态
 * - renderMemoryList 搜索高亮：name/preview 中 <mark> 包裹
 * - showMemoryDetail 关联记忆渲染：relations 列表 + 点击触发 memoryClickCallback
 * - renderRecycleBinList：回收站列表 + restore/purge 按钮 + 降级
 * - enterEditMode/exitEditMode/saveEdit（private）：pre↔textarea 切换 + 回调触发
 * - pulseNarrativeCard：脉冲效果 + 1500ms 后移除
 *
 * 与 memoryPanelManagerInstance.test.ts 互补，避免重复覆盖 renderMemoryList 基础渲染、
 * showMemoryDetail 字段填充、getAddMemoryFormData/clearAddMemoryForm、回调注册等已测内容。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MemoryPanelManager } from '../../../electron/renderer/panels/memoryPanelManager.js';
import { EventTracker } from '../../../electron/renderer/helpers/eventTracker.js';
import type { MemoryListItem, MemoryDetail, MemoryRelationItem } from '../../../electron/renderer/types.js';
import type { RelationGraphData } from '../../../electron/renderer/components/relationGraph.js';

// ─── Mock RelationGraphRenderer（避免 Canvas 2D / ResizeObserver / RAF 依赖） ───
// 全局共享的 mock 实例，每个测试通过 vi.clearAllMocks() 重置调用记录
// 注意：mockImplementation 必须用普通 function（不能用箭头函数），否则无法用 new 调用
const mockGraphRendererInstance = {
  loadData: vi.fn(),
  setHighlightedNodes: vi.fn(),
  setSelectedNode: vi.fn(),
  clearHighlights: vi.fn(),
  destroy: vi.fn(),
  setOnNodeClick: vi.fn(),
  setOnNodeContextMenu: vi.fn(),
  setOnEdgeClick: vi.fn(),
  setOnConnectionCreate: vi.fn(),
};

vi.mock('../../../electron/renderer/components/relationGraph.js', () => ({
  RelationGraphRenderer: vi.fn().mockImplementation(function () {
    return mockGraphRendererInstance;
  }),
}));

// ─── 测试辅助 ─────────────────────────────────────────────

/** 创建 mock host（包含完整接口签名，避免 TS 报错） */
function createMockHost() {
  return {
    showModal: vi.fn(),
    hideModal: vi.fn(),
    showConfirmDialog: vi.fn().mockResolvedValue(true),
    showToast: vi.fn(),
  };
}

/** 构造记忆列表项 */
function makeMemory(overrides: Partial<MemoryListItem> = {}): MemoryListItem {
  return {
    id: 'test-1',
    name: '测试记忆',
    source: 'insight',
    score: 0.85,
    contentPreview: '这是预览内容',
    createdAt: '2026-06-27T10:00:00Z',
    ...overrides,
  };
}

/** 构造记忆详情（默认 relations 为空数组） */
function makeDetail(overrides: Partial<MemoryDetail> = {}): MemoryDetail {
  return {
    id: 'detail-1',
    name: '详情记忆',
    source: 'profile',
    score: 0.92,
    content: '完整内容',
    createdAt: '2026-06-27T10:00:00Z',
    accessedAt: '2026-06-27T12:00:00Z',
    relations: [],
    ...overrides,
  };
}

/** 构造关联记忆项 */
function makeRelation(overrides: Partial<MemoryRelationItem> = {}): MemoryRelationItem {
  return {
    targetId: 'rel-1',
    targetName: '关联记忆',
    type: 'related',
    weight: 0.7,
    ...overrides,
  };
}

/** 构造图谱数据 */
function makeGraphData(overrides: Partial<RelationGraphData> = {}): RelationGraphData {
  return {
    nodes: [
      { id: 'n1', name: '节点1', source: 'insight', score: 0.8, contentPreview: '预览1' },
      { id: 'n2', name: '节点2', source: 'profile', score: 0.6, contentPreview: '预览2' },
    ],
    edges: [
      { sourceId: 'n1', targetId: 'n2', type: 'related', weight: 0.5, createdAt: '2026-06-27T10:00:00Z' },
    ],
    ...overrides,
  };
}

/** 创建完整 DOM 环境（含视图切换/分析面板/图谱/回收站所需元素） */
function setupDOM(): void {
  document.body.innerHTML = `
    <div id="memory-list"></div>
    <input id="memory-search" type="text" />
    <select id="memory-filter-source">
      <option value="">全部</option>
    </select>
    <div id="memory-detail-modal">
      <h3 id="memory-detail-name"></h3>
      <code id="memory-detail-source"></code>
      <span id="memory-detail-score"></span>
      <span id="memory-detail-created"></span>
      <span id="memory-detail-accessed"></span>
      <pre id="memory-detail-content"></pre>
      <div id="memory-detail-relations">
        <div id="memory-relations-list"></div>
      </div>
      <button id="btn-memory-edit">编辑</button>
      <button id="btn-memory-delete">删除</button>
      <button id="btn-memory-discuss">在对话中讨论</button>
      <button id="btn-memory-edit-save" class="hidden">保存</button>
      <button id="btn-memory-edit-cancel" class="hidden">取消</button>
    </div>
    <!-- 视图切换按钮 -->
    <button id="btn-list-view" class="active" aria-selected="true"></button>
    <button id="btn-timeline-view" aria-selected="false"></button>
    <button id="btn-graph-view" aria-selected="false"></button>
    <!-- 视图容器 -->
    <div id="memory-graph-container" class="hidden">
      <canvas id="memory-graph-canvas"></canvas>
      <div id="memory-graph-empty"></div>
    </div>
    <div id="memory-timeline-container" class="hidden"></div>
    <!-- 分析面板 -->
    <div id="memory-insights-bar" class="hidden">
      <div id="partner-insights"></div>
    </div>
    <div id="memory-health-bar" class="hidden"></div>
    <!-- 更多菜单（含视图切换项 + 分析面板项 + 高级搜索） -->
    <div id="memory-more-menu">
      <div class="more-menu-item" data-action="view-list">列表</div>
      <div class="more-menu-item" data-action="view-timeline">时间线</div>
      <div class="more-menu-item" data-action="view-graph">图谱</div>
      <div class="more-menu-item" data-action="insights">统计洞察</div>
      <div class="more-menu-item" data-action="health">健康度</div>
      <div class="more-menu-item" data-action="advanced-search">高级搜索</div>
    </div>
    <!-- 感知面板 -->
    <div id="perception-narrative-text"></div>
    <!-- 回收站列表 -->
    <div id="recycle-bin-list"></div>
    <!-- 添加记忆表单 -->
    <input id="memory-add-source" type="text" />
    <input id="memory-add-name" type="text" />
    <textarea id="memory-add-content"></textarea>
  `;
}

/** 通过类型断言访问 private 方法（不破坏封装） */
function callPrivate<T>(mgr: MemoryPanelManager, method: string, ...args: unknown[]): T {
  return (mgr as unknown as Record<string, (...args: unknown[]) => T>)[method](...args);
}

// ─── highlightText (private) ──────────────────────────────

describe('highlightText (private)', () => {
  beforeEach(() => {
    setupDOM();
  });

  it('空查询应返回 HTML 转义后的原文（不含 <mark>）', () => {
    const mgr = new MemoryPanelManager(createMockHost(), null, null, null, null, new EventTracker());
    const result = callPrivate<string>(mgr, 'highlightText', '<script>alert(1)</script>', '');
    expect(result).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('应转义 & 字符为 &amp;', () => {
    const mgr = new MemoryPanelManager(createMockHost(), null, null, null, null, new EventTracker());
    expect(callPrivate<string>(mgr, 'highlightText', 'a & b', '')).toBe('a &amp; b');
  });

  it('应转义双引号为 &quot;', () => {
    const mgr = new MemoryPanelManager(createMockHost(), null, null, null, null, new EventTracker());
    expect(callPrivate<string>(mgr, 'highlightText', '"quote"', '')).toBe('&quot;quote&quot;');
  });

  it('单关键词应用 <mark> 包裹', () => {
    const mgr = new MemoryPanelManager(createMockHost(), null, null, null, null, new EventTracker());
    expect(callPrivate<string>(mgr, 'highlightText', 'hello world', 'world')).toBe('hello <mark>world</mark>');
  });

  it('大小写不敏感高亮（HELLO 与 hello 都应被高亮）', () => {
    const mgr = new MemoryPanelManager(createMockHost(), null, null, null, null, new EventTracker());
    expect(callPrivate<string>(mgr, 'highlightText', 'Hello WORLD', 'hello')).toBe('<mark>Hello</mark> WORLD');
  });

  it('多次出现的关键词都应被高亮', () => {
    const mgr = new MemoryPanelManager(createMockHost(), null, null, null, null, new EventTracker());
    const result = callPrivate<string>(mgr, 'highlightText', 'test test test', 'test');
    expect(result).toBe('<mark>test</mark> <mark>test</mark> <mark>test</mark>');
  });

  it('正则特殊字符应被转义（不会抛错且能匹配字面值）', () => {
    const mgr = new MemoryPanelManager(createMockHost(), null, null, null, null, new EventTracker());
    expect(() => callPrivate<string>(mgr, 'highlightText', 'a(b)c', '(b)')).not.toThrow();
    expect(callPrivate<string>(mgr, 'highlightText', 'a(b)c', '(b)')).toBe('a<mark>(b)</mark>c');
  });

  it('中文关键词应被正确高亮', () => {
    const mgr = new MemoryPanelManager(createMockHost(), null, null, null, null, new EventTracker());
    expect(callPrivate<string>(mgr, 'highlightText', '今天天气真好', '天气')).toBe('今天<mark>天气</mark>真好');
  });

  it('HTML 转义后再高亮，避免 XSS', () => {
    const mgr = new MemoryPanelManager(createMockHost(), null, null, null, null, new EventTracker());
    // 输入含 HTML + 关键词，应先转义再高亮
    const result = callPrivate<string>(mgr, 'highlightText', '<b>hello</b>', 'hello');
    expect(result).toBe('&lt;b&gt;<mark>hello</mark>&lt;/b&gt;');
  });
});

// ─── switchView ───────────────────────────────────────────

describe('switchView', () => {
  beforeEach(() => {
    setupDOM();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('切换到 list：list 显示，graph/timeline hidden', () => {
    const mgr = new MemoryPanelManager(createMockHost(), document.getElementById('memory-list'), null, null, null, new EventTracker());
    mgr.switchView('list');
    // 推进时间让两层 setTimeout 都完成（150ms 退出 + 150ms 进入）
    vi.advanceTimersByTime(300);
    expect(document.getElementById('memory-list')?.classList.contains('hidden')).toBe(false);
    expect(document.getElementById('memory-graph-container')?.classList.contains('hidden')).toBe(true);
    expect(document.getElementById('memory-timeline-container')?.classList.contains('hidden')).toBe(true);
  });

  it('切换到 timeline：timeline 显示，list/graph hidden', () => {
    const mgr = new MemoryPanelManager(createMockHost(), document.getElementById('memory-list'), null, null, null, new EventTracker());
    mgr.switchView('timeline');
    vi.advanceTimersByTime(300);
    expect(document.getElementById('memory-timeline-container')?.classList.contains('hidden')).toBe(false);
    expect(document.getElementById('memory-list')?.classList.contains('hidden')).toBe(true);
    expect(document.getElementById('memory-graph-container')?.classList.contains('hidden')).toBe(true);
  });

  it('切换到 graph：graph 显示，list/timeline hidden', () => {
    const mgr = new MemoryPanelManager(createMockHost(), document.getElementById('memory-list'), null, null, null, new EventTracker());
    mgr.switchView('graph');
    vi.advanceTimersByTime(300);
    expect(document.getElementById('memory-graph-container')?.classList.contains('hidden')).toBe(false);
    expect(document.getElementById('memory-list')?.classList.contains('hidden')).toBe(true);
    expect(document.getElementById('memory-timeline-container')?.classList.contains('hidden')).toBe(true);
  });

  it('getViewMode 应返回最新模式（立即同步，不等动画）', () => {
    const mgr = new MemoryPanelManager(createMockHost(), null, null, null, null, new EventTracker());
    expect(mgr.getViewMode()).toBe('list');
    mgr.switchView('timeline');
    expect(mgr.getViewMode()).toBe('timeline');
    mgr.switchView('graph');
    expect(mgr.getViewMode()).toBe('graph');
  });

  it('切换到 timeline 时应触发 renderTimeline 渲染时间线', () => {
    const mgr = new MemoryPanelManager(createMockHost(), document.getElementById('memory-list'), null, null, null, new EventTracker());
    // 先缓存记忆列表（renderTimeline 依赖 allMemories）
    mgr.renderMemoryList([makeMemory({ createdAt: '2026-06-27T10:00:00Z' })]);
    mgr.switchView('timeline');
    vi.advanceTimersByTime(300);
    // timeline-container 内应有 .timeline 元素
    expect(document.getElementById('memory-timeline-container')?.querySelector('.timeline')).not.toBeNull();
  });

  it('视图切换令牌：快速切换时旧 token 回调应被忽略', () => {
    const mgr = new MemoryPanelManager(createMockHost(), document.getElementById('memory-list'), null, null, null, new EventTracker());
    mgr.switchView('timeline');
    // 在 150ms 退出动画内再次切换（旧 token 即将过期）
    vi.advanceTimersByTime(50);
    mgr.switchView('list');
    vi.advanceTimersByTime(300);
    // 最终状态应该是 list（最新 token 的回调胜出）
    expect(mgr.getViewMode()).toBe('list');
    expect(document.getElementById('memory-list')?.classList.contains('hidden')).toBe(false);
  });

  it('切换视图时应隐藏 insights/health 分析面板', () => {
    const mgr = new MemoryPanelManager(createMockHost(), document.getElementById('memory-list'), null, null, null, new EventTracker());
    // 先打开 insights 面板
    mgr.toggleAnalysisPanel('insights');
    expect(document.getElementById('memory-insights-bar')?.classList.contains('hidden')).toBe(false);
    // 切换视图应隐藏分析面板
    mgr.switchView('list');
    vi.advanceTimersByTime(300);
    expect(document.getElementById('memory-insights-bar')?.classList.contains('hidden')).toBe(true);
    expect(document.getElementById('memory-health-bar')?.classList.contains('hidden')).toBe(true);
  });

  it('切换到 list 时应给当前可见视图添加 memory-view-exit 类（150ms 内）', () => {
    const mgr = new MemoryPanelManager(createMockHost(), document.getElementById('memory-list'), null, null, null, new EventTracker());
    // 先切换到 timeline 让其可见
    mgr.switchView('timeline');
    vi.advanceTimersByTime(300);
    // 切换回 list
    mgr.switchView('list');
    // 退出动画类应在 timeline 容器上（150ms 内）
    expect(document.getElementById('memory-timeline-container')?.classList.contains('memory-view-exit')).toBe(true);
    vi.advanceTimersByTime(300);
  });

  it('切换视图后应同步更多菜单中对应项的 active 状态', () => {
    const mgr = new MemoryPanelManager(createMockHost(), null, null, null, null, new EventTracker());
    mgr.switchView('graph');
    const graphItem = document.querySelector('.more-menu-item[data-action="view-graph"]') as HTMLElement;
    const listItem = document.querySelector('.more-menu-item[data-action="view-list"]') as HTMLElement;
    expect(graphItem.classList.contains('active')).toBe(true);
    expect(listItem.classList.contains('active')).toBe(false);
  });
});

// ─── toggleAnalysisPanel / hideAnalysisPanel / dismissAnalysisPanels ─

describe('toggleAnalysisPanel', () => {
  beforeEach(() => {
    setupDOM();
  });

  it('打开 insights 应隐藏主视图（list/graph/timeline）和 health 面板', () => {
    const mgr = new MemoryPanelManager(createMockHost(), document.getElementById('memory-list'), null, null, null, new EventTracker());
    mgr.toggleAnalysisPanel('insights');
    expect(document.getElementById('memory-insights-bar')?.classList.contains('hidden')).toBe(false);
    expect(document.getElementById('memory-list')?.classList.contains('hidden')).toBe(true);
    expect(document.getElementById('memory-health-bar')?.classList.contains('hidden')).toBe(true);
  });

  it('打开 health 应隐藏 insights（互斥切换）', () => {
    const mgr = new MemoryPanelManager(createMockHost(), document.getElementById('memory-list'), null, null, null, new EventTracker());
    mgr.toggleAnalysisPanel('insights');
    mgr.toggleAnalysisPanel('health');
    expect(document.getElementById('memory-insights-bar')?.classList.contains('hidden')).toBe(true);
    expect(document.getElementById('memory-health-bar')?.classList.contains('hidden')).toBe(false);
  });

  it('再次点击当前已激活面板应关闭（恢复主视图）', () => {
    const mgr = new MemoryPanelManager(createMockHost(), document.getElementById('memory-list'), null, null, null, new EventTracker());
    mgr.toggleAnalysisPanel('insights');
    mgr.toggleAnalysisPanel('insights');
    expect(document.getElementById('memory-insights-bar')?.classList.contains('hidden')).toBe(true);
    expect(document.getElementById('memory-list')?.classList.contains('hidden')).toBe(false);
  });

  it('打开 insights 应触发 moreMenuActionCallback 携带 panel 名', () => {
    const mgr = new MemoryPanelManager(createMockHost(), document.getElementById('memory-list'), null, null, null, new EventTracker());
    const cb = vi.fn();
    mgr.onMoreMenuAction(cb);
    mgr.toggleAnalysisPanel('insights');
    expect(cb).toHaveBeenCalledWith('insights');
  });

  it('打开 insights 应高亮对应菜单项（active 类）', () => {
    const mgr = new MemoryPanelManager(createMockHost(), document.getElementById('memory-list'), null, null, null, new EventTracker());
    mgr.toggleAnalysisPanel('insights');
    const insightsItem = document.querySelector('.more-menu-item[data-action="insights"]') as HTMLElement;
    expect(insightsItem.classList.contains('active')).toBe(true);
  });

  it('targetBar 元素缺失时应静默降级（不抛错）', () => {
    // 移除 insights-bar 元素模拟缺失
    document.getElementById('memory-insights-bar')?.remove();
    const mgr = new MemoryPanelManager(createMockHost(), document.getElementById('memory-list'), null, null, null, new EventTracker());
    expect(() => mgr.toggleAnalysisPanel('insights')).not.toThrow();
  });
});

describe('hideAnalysisPanel', () => {
  beforeEach(() => {
    setupDOM();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('关闭分析面板应恢复打开前的视图模式（previousViewMode）', () => {
    const mgr = new MemoryPanelManager(createMockHost(), document.getElementById('memory-list'), null, null, null, new EventTracker());
    // 先切换到 graph 视图
    mgr.switchView('graph');
    vi.advanceTimersByTime(300);
    // 打开 insights（记录 previousViewMode=graph）
    mgr.toggleAnalysisPanel('insights');
    // 关闭分析面板应恢复 graph 视图
    mgr.hideAnalysisPanel();
    expect(mgr.getViewMode()).toBe('graph');
    expect(document.getElementById('memory-graph-container')?.classList.contains('hidden')).toBe(false);
  });

  it('关闭分析面板应同步视图按钮 active 状态', () => {
    const mgr = new MemoryPanelManager(createMockHost(), document.getElementById('memory-list'), null, null, null, new EventTracker());
    mgr.switchView('timeline');
    vi.advanceTimersByTime(300);
    mgr.toggleAnalysisPanel('insights');
    mgr.hideAnalysisPanel();
    expect(document.getElementById('btn-timeline-view')?.classList.contains('active')).toBe(true);
    expect(document.getElementById('btn-list-view')?.classList.contains('active')).toBe(false);
    expect(document.getElementById('btn-timeline-view')?.getAttribute('aria-selected')).toBe('true');
  });

  it('无激活面板时调用 hideAnalysisPanel 应安全（无副作用）', () => {
    const mgr = new MemoryPanelManager(createMockHost(), document.getElementById('memory-list'), null, null, null, new EventTracker());
    expect(() => mgr.hideAnalysisPanel()).not.toThrow();
    // 视图模式保持初始 list
    expect(mgr.getViewMode()).toBe('list');
  });
});

describe('dismissAnalysisPanels', () => {
  beforeEach(() => {
    setupDOM();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('应重置 viewMode 为 list（无论之前是什么视图）', () => {
    const mgr = new MemoryPanelManager(createMockHost(), document.getElementById('memory-list'), null, null, null, new EventTracker());
    mgr.switchView('graph');
    vi.advanceTimersByTime(300);
    mgr.dismissAnalysisPanels();
    expect(mgr.getViewMode()).toBe('list');
  });

  it('应同步视图按钮状态到 list', () => {
    const mgr = new MemoryPanelManager(createMockHost(), document.getElementById('memory-list'), null, null, null, new EventTracker());
    mgr.switchView('timeline');
    vi.advanceTimersByTime(300);
    mgr.dismissAnalysisPanels();
    expect(document.getElementById('btn-list-view')?.classList.contains('active')).toBe(true);
    expect(document.getElementById('btn-timeline-view')?.classList.contains('active')).toBe(false);
    expect(document.getElementById('btn-graph-view')?.classList.contains('active')).toBe(false);
  });

  it('应隐藏所有分析面板 DOM', () => {
    const mgr = new MemoryPanelManager(createMockHost(), document.getElementById('memory-list'), null, null, null, new EventTracker());
    mgr.toggleAnalysisPanel('insights');
    mgr.dismissAnalysisPanels();
    expect(document.getElementById('memory-insights-bar')?.classList.contains('hidden')).toBe(true);
    expect(document.getElementById('memory-health-bar')?.classList.contains('hidden')).toBe(true);
  });
});

// ─── 图谱视图状态 ─────────────────────────────────────────

describe('图谱视图状态', () => {
  beforeEach(() => {
    setupDOM();
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('hasGraphData 初始（无缓存）应返回 false', () => {
    const mgr = new MemoryPanelManager(createMockHost(), null, null, null, null, new EventTracker());
    expect(mgr.hasGraphData()).toBe(false);
  });

  it('hasGraphData 有缓存但 edges 为空应返回 false', () => {
    const mgr = new MemoryPanelManager(createMockHost(), null, null, null, null, new EventTracker());
    mgr.loadGraphData({ nodes: [{ id: 'n1', name: 'n1', source: 's', score: 0.5, contentPreview: 'p' }], edges: [] });
    expect(mgr.hasGraphData()).toBe(false);
  });

  it('hasGraphData 有缓存且 edges>0 应返回 true', () => {
    const mgr = new MemoryPanelManager(createMockHost(), null, null, null, null, new EventTracker());
    mgr.loadGraphData(makeGraphData());
    expect(mgr.hasGraphData()).toBe(true);
  });

  it('loadGraphData 在 graph 视图 + 渲染器已初始化时应调用 graphRenderer.loadData', () => {
    const mgr = new MemoryPanelManager(createMockHost(), document.getElementById('memory-list'), null, null, null, new EventTracker());
    // 切换到 graph 视图触发渲染器初始化
    mgr.switchView('graph');
    vi.advanceTimersByTime(300);
    const data = makeGraphData();
    mgr.loadGraphData(data);
    expect(mockGraphRendererInstance.loadData).toHaveBeenCalledWith(data);
  });

  it('loadGraphData 在非 graph 视图时只缓存数据，不调用 loadData', () => {
    const mgr = new MemoryPanelManager(createMockHost(), null, null, null, null, new EventTracker());
    mgr.loadGraphData(makeGraphData());
    expect(mockGraphRendererInstance.loadData).not.toHaveBeenCalled();
    // 但数据已缓存（hasGraphData 返回 true）
    expect(mgr.hasGraphData()).toBe(true);
  });

  it('highlightGraphNodes 应调用渲染器 setHighlightedNodes（渲染器已初始化时）', () => {
    const mgr = new MemoryPanelManager(createMockHost(), null, null, null, null, new EventTracker());
    mgr.switchView('graph');
    vi.advanceTimersByTime(300);
    mgr.highlightGraphNodes(['n1', 'n2']);
    expect(mockGraphRendererInstance.setHighlightedNodes).toHaveBeenCalledWith(['n1', 'n2']);
  });

  it('highlightGraphNodes 传 null 应清除高亮', () => {
    const mgr = new MemoryPanelManager(createMockHost(), null, null, null, null, new EventTracker());
    mgr.switchView('graph');
    vi.advanceTimersByTime(300);
    mgr.highlightGraphNodes(null);
    expect(mockGraphRendererInstance.setHighlightedNodes).toHaveBeenCalledWith(null);
  });

  it('selectGraphNode 应调用渲染器 setSelectedNode', () => {
    const mgr = new MemoryPanelManager(createMockHost(), null, null, null, null, new EventTracker());
    mgr.switchView('graph');
    vi.advanceTimersByTime(300);
    mgr.selectGraphNode('n1');
    expect(mockGraphRendererInstance.setSelectedNode).toHaveBeenCalledWith('n1');
  });

  it('clearGraphHighlights 应调用渲染器 clearHighlights', () => {
    const mgr = new MemoryPanelManager(createMockHost(), null, null, null, null, new EventTracker());
    mgr.switchView('graph');
    vi.advanceTimersByTime(300);
    mgr.clearGraphHighlights();
    expect(mockGraphRendererInstance.clearHighlights).toHaveBeenCalled();
  });

  it('cleanup 时应销毁图谱渲染器（destroy）', () => {
    const mgr = new MemoryPanelManager(createMockHost(), null, null, null, null, new EventTracker());
    mgr.switchView('graph');
    vi.advanceTimersByTime(300);
    mgr.cleanup();
    expect(mockGraphRendererInstance.destroy).toHaveBeenCalled();
  });
});

// ─── renderMemoryList 搜索高亮 ────────────────────────────

describe('renderMemoryList 搜索高亮', () => {
  beforeEach(() => {
    setupDOM();
  });

  it('searchQuery 应在 name 中高亮匹配部分（<mark> 包裹）', () => {
    const mgr = new MemoryPanelManager(createMockHost(), document.getElementById('memory-list'), null, null, null, new EventTracker());
    mgr.renderMemoryList([makeMemory({ name: 'Hello World', contentPreview: 'preview' })], 'Hello');
    const nameEl = document.querySelector('.memory-item .name') as HTMLElement;
    expect(nameEl.innerHTML).toContain('<mark>Hello</mark>');
  });

  it('searchQuery 应在 preview 中高亮匹配部分', () => {
    const mgr = new MemoryPanelManager(createMockHost(), document.getElementById('memory-list'), null, null, null, new EventTracker());
    mgr.renderMemoryList([makeMemory({ name: 'name', contentPreview: 'Hello Preview' })], 'Hello');
    const previewEl = document.querySelector('.memory-item .preview') as HTMLElement;
    expect(previewEl.innerHTML).toContain('<mark>Hello</mark>');
  });

  it('大小写不敏感高亮（HELLO 与 hello 都应被高亮）', () => {
    const mgr = new MemoryPanelManager(createMockHost(), document.getElementById('memory-list'), null, null, null, new EventTracker());
    mgr.renderMemoryList([makeMemory({ name: 'HELLO World', contentPreview: 'p' })], 'hello');
    const nameEl = document.querySelector('.memory-item .name') as HTMLElement;
    expect(nameEl.innerHTML).toContain('<mark>HELLO</mark>');
  });

  it('不传 searchQuery 时不应有 <mark> 标签', () => {
    const mgr = new MemoryPanelManager(createMockHost(), document.getElementById('memory-list'), null, null, null, new EventTracker());
    mgr.renderMemoryList([makeMemory({ name: 'hello' })]);
    const nameEl = document.querySelector('.memory-item .name') as HTMLElement;
    expect(nameEl.innerHTML).not.toContain('<mark>');
  });
});

// ─── 关联记忆渲染 ─────────────────────────────────────────

describe('showMemoryDetail 关联记忆渲染', () => {
  beforeEach(() => {
    setupDOM();
  });

  it('relations 非空应显示关联列表区域并渲染 relation-item', () => {
    const mgr = new MemoryPanelManager(createMockHost(), null, null, null, document.getElementById('memory-detail-modal'), new EventTracker());
    mgr.showMemoryDetail(makeDetail({
      relations: [makeRelation({ targetId: 'r1', targetName: '关联1' })],
    }));
    expect(document.getElementById('memory-detail-relations')?.classList.contains('hidden')).toBe(false);
    expect(document.querySelectorAll('.relation-item').length).toBe(1);
    expect(document.querySelector('.relation-target-name')?.textContent).toBe('关联1');
  });

  it('relations 为空应隐藏关联区域', () => {
    const mgr = new MemoryPanelManager(createMockHost(), null, null, null, document.getElementById('memory-detail-modal'), new EventTracker());
    mgr.showMemoryDetail(makeDetail({ relations: [] }));
    expect(document.getElementById('memory-detail-relations')?.classList.contains('hidden')).toBe(true);
  });

  it('关联项应包含 type 标签和 weight 显示', () => {
    const mgr = new MemoryPanelManager(createMockHost(), null, null, null, document.getElementById('memory-detail-modal'), new EventTracker());
    mgr.showMemoryDetail(makeDetail({
      relations: [makeRelation({ type: 'support', weight: 0.85 })],
    }));
    expect(document.querySelector('.relation-type-tag')?.textContent).toBe('support');
    expect(document.querySelector('.relation-weight')?.textContent).toBe('w:0.85');
  });

  it('点击关联项应触发 memoryClickCallback 携带 targetId', () => {
    const mgr = new MemoryPanelManager(createMockHost(), null, null, null, document.getElementById('memory-detail-modal'), new EventTracker());
    const cb = vi.fn();
    mgr.onMemoryClick(cb);
    mgr.showMemoryDetail(makeDetail({
      relations: [makeRelation({ targetId: 'target-mem' })],
    }));
    const item = document.querySelector('.relation-item') as HTMLElement;
    item.click();
    expect(cb).toHaveBeenCalledWith('target-mem');
  });

  it('键盘 Enter/Space 在关联项上应触发 memoryClickCallback', () => {
    const mgr = new MemoryPanelManager(createMockHost(), null, null, null, document.getElementById('memory-detail-modal'), new EventTracker());
    const cb = vi.fn();
    mgr.onMemoryClick(cb);
    mgr.showMemoryDetail(makeDetail({
      relations: [makeRelation({ targetId: 'kbd-target' })],
    }));
    const item = document.querySelector('.relation-item') as HTMLElement;
    item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(cb).toHaveBeenCalledWith('kbd-target');
  });
});

// ─── renderRecycleBinList ─────────────────────────────────

describe('renderRecycleBinList', () => {
  beforeEach(() => {
    setupDOM();
  });

  it('空列表应清空容器（不渲染任何项）', () => {
    const mgr = new MemoryPanelManager(createMockHost(), null, null, null, null, new EventTracker());
    mgr.renderRecycleBinList([]);
    expect(document.getElementById('recycle-bin-list')?.children.length).toBe(0);
  });

  it('单条回收站项应包含名称/来源/删除时间/预览', () => {
    const mgr = new MemoryPanelManager(createMockHost(), null, null, null, null, new EventTracker());
    mgr.renderRecycleBinList([{
      id: 'r1',
      name: '回收记忆1',
      source: 'insight',
      contentPreview: '预览内容',
      deletedAt: '2026-06-27T10:00:00Z',
    }]);
    const item = document.querySelector('.recycle-bin-item') as HTMLElement;
    expect(item).not.toBeNull();
    expect(item.querySelector('.recycle-bin-item-name')?.textContent).toBe('回收记忆1');
    expect(item.querySelector('.recycle-bin-item-source')?.textContent).toContain('insight');
    expect(item.querySelector('.recycle-bin-item-preview')?.textContent).toBe('预览内容');
  });

  it('restore 按钮应有 data-action=restore-memory + data-memory-id', () => {
    const mgr = new MemoryPanelManager(createMockHost(), null, null, null, null, new EventTracker());
    mgr.renderRecycleBinList([{
      id: 'r2', name: 'n', source: 's', contentPreview: 'p', deletedAt: '2026-06-27T10:00:00Z',
    }]);
    const restoreBtn = document.querySelector('[data-action="restore-memory"]') as HTMLElement;
    expect(restoreBtn).not.toBeNull();
    expect(restoreBtn.getAttribute('data-memory-id')).toBe('r2');
    expect(restoreBtn.textContent).toBe('恢复');
  });

  it('purge 按钮应有 data-action=purge-memory + danger 类', () => {
    const mgr = new MemoryPanelManager(createMockHost(), null, null, null, null, new EventTracker());
    mgr.renderRecycleBinList([{
      id: 'r3', name: 'n', source: 's', contentPreview: 'p', deletedAt: '2026-06-27T10:00:00Z',
    }]);
    const purgeBtn = document.querySelector('[data-action="purge-memory"]') as HTMLElement;
    expect(purgeBtn).not.toBeNull();
    expect(purgeBtn.classList.contains('danger')).toBe(true);
    expect(purgeBtn.textContent).toBe('彻底删除');
  });

  it('recycle-bin-list 元素缺失时应静默降级（不抛错）', () => {
    document.getElementById('recycle-bin-list')?.remove();
    const mgr = new MemoryPanelManager(createMockHost(), null, null, null, null, new EventTracker());
    expect(() => mgr.renderRecycleBinList([{
      id: 'r4', name: 'n', source: 's', contentPreview: 'p', deletedAt: '2026-06-27T10:00:00Z',
    }])).not.toThrow();
  });

  it('多条记忆应渲染多个 recycle-bin-item', () => {
    const mgr = new MemoryPanelManager(createMockHost(), null, null, null, null, new EventTracker());
    mgr.renderRecycleBinList([
      { id: 'a', name: 'A', source: 's', contentPreview: 'p', deletedAt: '2026-06-27T10:00:00Z' },
      { id: 'b', name: 'B', source: 's', contentPreview: 'p', deletedAt: '2026-06-27T11:00:00Z' },
    ]);
    expect(document.querySelectorAll('.recycle-bin-item').length).toBe(2);
  });
});

// ─── 编辑模式 (private) ──────────────────────────────────

describe('编辑模式 (private)', () => {
  beforeEach(() => {
    setupDOM();
  });

  it('enterEditMode 应将 pre 替换为 textarea，并保留原始内容', () => {
    const mgr = new MemoryPanelManager(createMockHost(), null, null, null, document.getElementById('memory-detail-modal'), new EventTracker());
    mgr.showMemoryDetail(makeDetail({ content: '原始内容' }));
    callPrivate(mgr, 'enterEditMode');
    const textarea = document.getElementById('memory-detail-content') as HTMLTextAreaElement;
    expect(textarea.tagName).toBe('TEXTAREA');
    expect(textarea.value).toBe('原始内容');
    expect(textarea.classList.contains('memory-edit-textarea')).toBe(true);
  });

  it('exitEditMode 应将 textarea 恢复为 pre，恢复原始内容', () => {
    const mgr = new MemoryPanelManager(createMockHost(), null, null, null, document.getElementById('memory-detail-modal'), new EventTracker());
    mgr.showMemoryDetail(makeDetail({ content: '原始内容' }));
    callPrivate(mgr, 'enterEditMode');
    // 在 textarea 中修改内容（模拟用户编辑）
    const textarea = document.getElementById('memory-detail-content') as HTMLTextAreaElement;
    textarea.value = '已修改的内容';
    // 退出编辑模式应恢复原始内容
    callPrivate(mgr, 'exitEditMode');
    const pre = document.getElementById('memory-detail-content') as HTMLElement;
    expect(pre.tagName).toBe('PRE');
    expect(pre.textContent).toBe('原始内容');
  });

  it('saveEdit 应调用 memoryEditCallback 携带 id 和新内容', () => {
    const mgr = new MemoryPanelManager(createMockHost(), null, null, null, document.getElementById('memory-detail-modal'), new EventTracker());
    const cb = vi.fn();
    mgr.onMemoryEdit(cb);
    mgr.showMemoryDetail(makeDetail({ id: 'edit-1', content: '原始' }));
    callPrivate(mgr, 'enterEditMode');
    const textarea = document.getElementById('memory-detail-content') as HTMLTextAreaElement;
    textarea.value = '新内容';
    callPrivate(mgr, 'saveEdit');
    expect(cb).toHaveBeenCalledWith('edit-1', '新内容');
  });

  it('saveEdit 在 textarea 为纯空格时不触发回调（trim 后为空）', () => {
    const mgr = new MemoryPanelManager(createMockHost(), null, null, null, document.getElementById('memory-detail-modal'), new EventTracker());
    const cb = vi.fn();
    mgr.onMemoryEdit(cb);
    mgr.showMemoryDetail(makeDetail({ id: 'edit-2', content: '原始' }));
    callPrivate(mgr, 'enterEditMode');
    const textarea = document.getElementById('memory-detail-content') as HTMLTextAreaElement;
    textarea.value = '   ';
    callPrivate(mgr, 'saveEdit');
    expect(cb).not.toHaveBeenCalled();
  });

  it('saveEdit 在 #memory-detail-content 元素缺失时静默降级', () => {
    const mgr = new MemoryPanelManager(createMockHost(), null, null, null, null, new EventTracker());
    const cb = vi.fn();
    mgr.onMemoryEdit(cb);
    // 移除 #memory-detail-content 元素，模拟未打开详情的场景
    document.getElementById('memory-detail-content')?.remove();
    expect(() => callPrivate(mgr, 'saveEdit')).not.toThrow();
    expect(cb).not.toHaveBeenCalled();
  });

  it('enterEditMode 在 isEditing=true 时应幂等（不重复切换）', () => {
    const mgr = new MemoryPanelManager(createMockHost(), null, null, null, document.getElementById('memory-detail-modal'), new EventTracker());
    mgr.showMemoryDetail(makeDetail({ content: '原始' }));
    callPrivate(mgr, 'enterEditMode');
    const textarea1 = document.getElementById('memory-detail-content');
    callPrivate(mgr, 'enterEditMode'); // 再次进入应幂等
    const textarea2 = document.getElementById('memory-detail-content');
    expect(textarea1).toBe(textarea2);
  });
});

// ─── pulseNarrativeCard ───────────────────────────────────

// TODO: pulseNarrativeCard() 方法保留以兼容接口，但不再执行任何 DOM 操作。
// 叙事卡片脉冲动画功能已迁移或移除，待恢复后取消 skip。
describe.skip('pulseNarrativeCard', () => {
  beforeEach(() => {
    setupDOM();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('元素存在时应添加 narrative-pulse 类', () => {
    const mgr = new MemoryPanelManager(createMockHost(), null, null, null, null, new EventTracker());
    mgr.pulseNarrativeCard();
    expect(document.getElementById('perception-narrative-text')?.classList.contains('narrative-pulse')).toBe(true);
  });

  it('1500ms 后应自动移除 narrative-pulse 类', () => {
    const mgr = new MemoryPanelManager(createMockHost(), null, null, null, null, new EventTracker());
    mgr.pulseNarrativeCard();
    vi.advanceTimersByTime(1500);
    expect(document.getElementById('perception-narrative-text')?.classList.contains('narrative-pulse')).toBe(false);
  });

  it('元素缺失时应静默降级（不抛错）', () => {
    document.getElementById('perception-narrative-text')?.remove();
    const mgr = new MemoryPanelManager(createMockHost(), null, null, null, null, new EventTracker());
    expect(() => mgr.pulseNarrativeCard()).not.toThrow();
  });
});
