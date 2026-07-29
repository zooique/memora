/**
 * 记忆面板控制器测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - formatTokenCount：token 数格式化（< 1000 直显 / >= 1000 显示为 "X.Xk"）
 * - 推荐记忆点击事件委托：
 *   - 点击推荐记忆项应调用 uiManager.triggerMemoryRecall
 *   - 点击非推荐记忆区域不应触发
 *   - 空 memoryName 不应触发
 *
 * Mock 策略：
 * - mock uiManager（triggerMemoryRecall 等方法用 vi.fn()）
 * - mock window.electronAPI.getDashboard 返回含 suggestions 的数据
 * - JSDOM 提供真实 DOM 事件（click 事件委托）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
// formatTokenCount 已迁移至 shared/numberUtils.ts（UX-12 术语统一）
import { formatTokenCount } from '../../../shared/numberUtils.js';
import { createMemoryOrchestrator } from '../../../electron/renderer/orchestrators/memoryOrchestrator.js';
import type { UIManager } from '../../../electron/renderer/ui.js';

// ─── 纯函数测试 ───────────────────────────────────────────

describe('formatTokenCount', () => {
  it('0 应返回 "0"', () => {
    expect(formatTokenCount(0)).toBe('0');
  });

  it('1 应返回 "1"', () => {
    expect(formatTokenCount(1)).toBe('1');
  });

  it('999 应返回 "999"（边界，< 1000 直显）', () => {
    expect(formatTokenCount(999)).toBe('999');
  });

  it('1000 应返回 "1.0k"（边界，>= 1000 走 k 格式）', () => {
    expect(formatTokenCount(1000)).toBe('1.0k');
  });

  it('1234 应返回 "1.2k"（toFixed(1) 截断）', () => {
    expect(formatTokenCount(1234)).toBe('1.2k');
  });

  it('1500 应返回 "1.5k"', () => {
    expect(formatTokenCount(1500)).toBe('1.5k');
  });

  it('9999 应返回 "10.0k"', () => {
    expect(formatTokenCount(9999)).toBe('10.0k');
  });

  it('12345 应返回 "12.3k"（万级数字格式化）', () => {
    expect(formatTokenCount(12345)).toBe('12.3k');
  });
});

// ─── 推荐记忆点击事件委托 ────────────────

/** 创建 mock uiManager（仅包含 createMemoryOrchestrator 用到的方法） */
function createMockUiManager(): UIManager & { triggerMemoryRecall: ReturnType<typeof vi.fn> } {
  const spies = {
    onMemorySearch: vi.fn(),
    onMemoryFilter: vi.fn(),
    onMemoryClick: vi.fn(),
    onMemoryDelete: vi.fn(),
    onMemoryAdd: vi.fn(),
    onMemoryEdit: vi.fn(),
    onMemoryDiscuss: vi.fn(),
    onGraphToggle: vi.fn(),
    onMoreMenuAction: vi.fn(),
    // 回收站操作回调 + 渲染方法 + 弹窗显示 + 确认对话框
    onRecycleBinAction: vi.fn(),
    onRecycleBinBatchAction: vi.fn(),
    renderRecycleBinList: vi.fn(),
    showModal: vi.fn(),
    showConfirmDialog: vi.fn().mockResolvedValue(true),
    onSortChange: vi.fn(),
    onTimeRangeChange: vi.fn(),
    onCleanupRequest: vi.fn(() => []),
    onCleanupConfirm: vi.fn(),
    onViewSwitch: vi.fn(),
    // 图谱关系交互回调（Phase 4：关系图可交互化）
    onGraphContextMenuAction: vi.fn(),
    onRelationEdit: vi.fn(),
    onRelationDelete: vi.fn(),
    onRelationCreate: vi.fn(),
    // 仪表盘重试回调（DashboardPanelManager 委托）
    onReloadInsights: vi.fn(),
    onReloadHealth: vi.fn(),
    onReloadMemoryList: vi.fn(),
    // 补全统计面板委托
    renderCompletionStat: vi.fn(),
    onResetCompletionStats: vi.fn(),
    // 伙伴洞察卡片点击回调
    onPartnerMemoryClick: vi.fn(),
    // LLM 记忆治理回调（G3：dedup/timeliness/conflicts，由 Controller 调用 IPC）
    onLlmGovernance: vi.fn(),
    switchMemoryView: vi.fn(),
    loadGraphData: vi.fn(),
    hasGraphData: vi.fn(() => false),
    // F6：图谱缓存失效 + 视图模式查询（记忆变更后刷新图谱）
    invalidateGraphCache: vi.fn(),
    getViewMode: vi.fn(() => 'list'),
    highlightGraphNodes: vi.fn(),
    selectGraphNode: vi.fn(),
    clearGraphHighlights: vi.fn(),
    triggerMemoryRecall: vi.fn(),
    renderMemoryList: vi.fn(),
    // 方案 2：删除记忆时半乐观更新，先从缓存移除避免全量 reload 闪烁
    removeMemoryFromCache: vi.fn(() => true),
    // 方案 1：source 筛选下拉项动态渲染（基于 distinct sources）
    renderMemorySourceFilter: vi.fn(),
    showMemoryDetail: vi.fn(),
    showToast: vi.fn(),
    showPanelError: vi.fn(),
    hideModal: vi.fn(),
    clearAddMemoryForm: vi.fn(),
    getCurrentMemoryId: vi.fn(() => null),
    updateLearningProgress: vi.fn(),
    // DashboardPanelManager 委托方法
    renderDashboardStats: vi.fn(),
    renderAgentMetrics: vi.fn(),
    renderReviewData: vi.fn(),
    showInsightsLoading: vi.fn(),
    renderInsights: vi.fn(),
    showInsightsError: vi.fn(),
    showHealthLoading: vi.fn(),
    renderHealthDashboard: vi.fn(),
    showHealthError: vi.fn(),
    showMemoryListError: vi.fn(),
    pulseCounter: vi.fn(),
    updateAffectDisplay: vi.fn(),
    updateRapportDisplay: vi.fn(),
    updateContextDisplay: vi.fn(),
    updatePatternsDisplay: vi.fn(),
    updateNarrative: vi.fn(),
    // 控制器通过 UIManager 门面读取搜索参数，不再直接访问 DOM
    getMemorySearchParams: vi.fn(() => ({ query: '', source: '', sort: 'relevance', timeRange: '' })),
    // memoryController 通过 UIManager 门面调用 renderSourceHealth/setMemoryListState
    renderSourceHealth: vi.fn(),
    setMemoryListState: vi.fn(),
  };
  // 使用类型断言避免完整实现 UIManager 的所有方法
  return spies as unknown as UIManager & { triggerMemoryRecall: ReturnType<typeof vi.fn> };
}

describe('推荐记忆点击事件委托', () => {
  let mockUiManager: ReturnType<typeof createMockUiManager>;

  beforeEach(() => {
    // 设置 DOM：仪表盘推荐记忆列表容器（合并到学习与回顾节）
    document.body.innerHTML = `
      <ul id="recommendation-list"></ul>
      <input id="memory-search" type="text" />
      <select id="memory-filter-source"><option value="">全部</option></select>
    `;

    // mock window.electronAPI.getDashboard 返回含 suggestions 的数据
    // suggestions 包含 name 字段，用于跳转
    window.electronAPI = {
      ...window.electronAPI,
      getDashboard: vi.fn().mockResolvedValue({
        pendingNotices: 0,
        proactiveThreshold: 5,
        registeredTriggers: [],
        suggestions: [
          { name: '推荐记忆A', source: 'insight', reason: '相关度高', relevance: 0.95, contentPreview: '预览A' },
          { name: '推荐记忆B', source: 'profile', reason: '近期访问', relevance: 0.80, contentPreview: '预览B' },
        ],
        // loadDashboard 调用 renderDashboardStats 需要这两个字段
        total: 2,
        bySource: { insight: 1, profile: 1 },
        sourceHealth: null,
        metrics: null,
        skills: [],
      }),
      listMemories: vi.fn().mockResolvedValue({ memories: [] }),
      // loadDashboard 串行调用 getReviewData，需提供 mock 避免抛错
      getReviewData: vi.fn().mockResolvedValue({
        today: { date: '2026-06-29', messageCount: 0, newMemories: 0, newInsights: 0 },
        trend: { last7Days: 0, last30Days: 0, daily: [], direction: 'stable', description: '无数据' },
        insights: { total: 0, recent: [], bySource: {} },
        totalMemories: 0,
        generatedAt: '2026-06-29T00:00:00.000Z',
      }),
    } as unknown as typeof window.electronAPI;

    mockUiManager = createMockUiManager();
  });

  // 点击事件委托已迁移到 UIManager.initEventListeners（通过 EventTracker 统一管理）
  // 点击行为测试见 ui.test.ts 的 "推荐记忆点击事件委托" 描述块

  it('loadDashboard 应将仪表盘数据委托给 renderDashboardStats 渲染（推荐记忆数据由 Manager 渲染为 li[data-action]）', async () => {
    const controller = createMemoryOrchestrator(mockUiManager);
    controller.setupMemoryPanel();
    await controller.loadDashboard();

    // Controller 仅做 IPC 编排，DOM 渲染委托 DashboardPanelManager
    // 此处验证 renderDashboardStats 被调用并接收含 suggestions 的完整数据
    expect(mockUiManager.renderDashboardStats).toHaveBeenCalledTimes(1);
    const callArg = mockUiManager.renderDashboardStats.mock.calls[0][0];
    expect(callArg.suggestions).toHaveLength(2);
    expect(callArg.suggestions[0].name).toBe('推荐记忆A');
    // 同时验证其他委托方法被调用
    expect(mockUiManager.renderAgentMetrics).toHaveBeenCalledWith(null);
    // Phase 6.2：loadDashboard 现在并发拉取 reviewData 并委托 renderReviewData 渲染增长趋势区块
    expect(mockUiManager.renderReviewData).toHaveBeenCalledTimes(1);
    // updateLearningProgress 为死代码，不应再被调用
    expect(mockUiManager.updateLearningProgress).not.toHaveBeenCalled();
  });
});

// ─── 删除按钮 loading 保护 ───────

describe('删除按钮 loading 保护', () => {
  let mockUiManager: ReturnType<typeof createMockUiManager>;
  /** 捕获 onMemoryDelete 注册的回调，测试中手动触发 */
  let deleteCallback: (() => Promise<void>) | null = null;

  beforeEach(() => {
    // 设置 DOM：需要 btn-memory-delete 按钮供 setButtonLoading 操作
    document.body.innerHTML = `
      <button id="btn-memory-delete">删除</button>
      <ul id="recommendation-list"></ul>
      <section id="recommendations"></section>
      <input id="memory-search" type="text" />
      <select id="memory-filter-source"><option value="">全部</option></select>
    `;

    window.electronAPI = {
      ...window.electronAPI,
      getDashboard: vi.fn().mockResolvedValue({
        pendingNotices: 0,
        proactiveThreshold: 5,
        registeredTriggers: [],
        suggestions: [],
        sourceHealth: null,
        metrics: null,
        skills: [],
      }),
      listMemories: vi.fn().mockResolvedValue({ memories: [] }),
      // deleteMemory 现返回 { deleted: boolean }，默认成功
      deleteMemory: vi.fn().mockResolvedValue({ deleted: true }),
      // 回收站 IPC mock（默认空列表 + 操作成功）
      listDeletedMemories: vi.fn().mockResolvedValue({ memories: [] }),
      restoreMemory: vi.fn().mockResolvedValue({ restored: true }),
      purgeMemory: vi.fn().mockResolvedValue({ purged: true }),
    } as unknown as typeof window.electronAPI;

    mockUiManager = createMockUiManager();
    // 捕获 onMemoryDelete 注册的回调
    mockUiManager.onMemoryDelete.mockImplementation((cb: () => Promise<void>) => {
      deleteCallback = cb;
    });
    // 模拟当前选中的记忆 ID
    mockUiManager.getCurrentMemoryId.mockReturnValue('mem-test-1');
    deleteCallback = null;
  });

  it('删除时应禁用按钮 + 显示"删除中…"', async () => {
    const controller = createMemoryOrchestrator(mockUiManager);
    controller.setupMemoryPanel();

    const btn = document.getElementById('btn-memory-delete') as HTMLButtonElement;
    expect(deleteCallback).not.toBeNull();

    // 触发删除回调（不 await，先检查 loading 状态）
    const promise = deleteCallback!();
    // 按钮应被禁用 + 文案改变
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toBe('删除中…');

    await promise;
  });

  it('删除成功后应恢复按钮状态', async () => {
    const controller = createMemoryOrchestrator(mockUiManager);
    controller.setupMemoryPanel();

    const btn = document.getElementById('btn-memory-delete') as HTMLButtonElement;
    await deleteCallback!();

    // 按钮应恢复
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe('删除');
    // IPC 应被调用
    expect(window.electronAPI.deleteMemory).toHaveBeenCalledWith('mem-test-1');
  });

  it('删除失败时也应恢复按钮状态（finally 兜底）', async () => {
    // mock deleteMemory 抛错
    (window.electronAPI.deleteMemory as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('网络错误'));

    const controller = createMemoryOrchestrator(mockUiManager);
    controller.setupMemoryPanel();

    const btn = document.getElementById('btn-memory-delete') as HTMLButtonElement;
    await deleteCallback!();

    // 按钮应恢复（finally 兜底）
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe('删除');
  });

  it('无记忆 ID 时不应触发删除 IPC', async () => {
    mockUiManager.getCurrentMemoryId.mockReturnValue(null);

    const controller = createMemoryOrchestrator(mockUiManager);
    controller.setupMemoryPanel();

    await deleteCallback!();

    expect(window.electronAPI.deleteMemory).not.toHaveBeenCalled();
  });
});

// ─── LLM 治理结果持久化展示 ───────

describe('LLM 治理结果持久化展示', () => {
  let mockUiManager: ReturnType<typeof createMockUiManager>;
  /** 捕获 onLlmGovernance 注册的回调，测试中手动触发 */
  let llmCallback: ((action: 'dedup' | 'timeliness' | 'conflicts') => Promise<void>) | null = null;

  beforeEach(() => {
    // 设置 DOM：需含 #health-llm-result 容器（G3 预留）供渲染器注入
    document.body.innerHTML = `
      <div id="health-llm-result"></div>
      <button id="btn-memory-delete">删除</button>
      <ul id="recommendation-list"></ul>
      <section id="recommendations"></section>
      <input id="memory-search" type="text" />
      <select id="memory-filter-source"><option value="">全部</option></select>
    `;

    // mock window.electronAPI：3 个治理方法 + boostMemory + loadHealthDashboard 依赖
    window.electronAPI = {
      ...window.electronAPI,
      deduplicateMemories: vi.fn().mockResolvedValue({
        scannedCount: 10,
        pairCount: 3,
        deduplicatedCount: 2,
        demotedIds: ['insight:dup-1', 'insight:dup-2'],
      }),
      evaluateTimeliness: vi.fn().mockResolvedValue({
        scannedCount: 5,
        outdatedCount: 1,
        demotedIds: ['insight:stale-1'],
      }),
      detectConflicts: vi.fn().mockResolvedValue({
        scannedCount: 8,
        pairCount: 4,
        conflictCount: 1,
        conflicts: [
          {
            memoryA: { id: 'rule:a', name: '规则A', content: '使用 TypeScript', source: 'rule', score: 0.9 },
            memoryB: { id: 'rule:b', name: '规则B', content: '使用 JavaScript', source: 'rule', score: 0.8 },
            hasConflict: true,
            conflictDescription: '技术栈选择冲突',
            recommendation: 'a' as const,
            reason: 'A 更符合项目现状',
          },
        ],
      }),
      boostMemory: vi.fn().mockResolvedValue(true),
      getHealthDashboard: vi.fn().mockResolvedValue({
        scores: { overall: 80, uniqueness: 70, freshness: 60, completeness: 90 },
        duplicates: [],
        staleMemories: [],
        lowQualityCount: 0,
        totalMemories: 10,
        healthLabel: 'good',
        healthDescription: '健康度良好',
      }),
      getDashboard: vi.fn().mockResolvedValue({
        pendingNotices: 0,
        proactiveThreshold: 5,
        registeredTriggers: [],
        suggestions: [],
        total: 0,
        bySource: {},
        sourceHealth: null,
        metrics: null,
        skills: [],
      }),
      getReviewData: vi.fn().mockResolvedValue({
        today: { date: '2026-07-15', messageCount: 0, newMemories: 0, newInsights: 0 },
        trend: { last7Days: 0, last30Days: 0, daily: [], direction: 'stable', description: '无数据' },
        insights: { total: 0, recent: [], bySource: {} },
        totalMemories: 0,
        generatedAt: '2026-07-15T00:00:00.000Z',
      }),
      listMemories: vi.fn().mockResolvedValue({ memories: [] }),
    } as unknown as typeof window.electronAPI;

    mockUiManager = createMockUiManager();

    // 捕获 onLlmGovernance 回调
    mockUiManager.onLlmGovernance.mockImplementation((cb) => {
      llmCallback = cb;
    });
  });

  it('dedup 治理：应在 #health-llm-result 渲染降级列表 + 恢复按钮', async () => {
    const controller = createMemoryOrchestrator(mockUiManager);
    controller.setupMemoryPanel();

    expect(llmCallback).not.toBeNull();
    await llmCallback!('dedup');

    // 容器应含摘要 + 降级列表
    const container = document.getElementById('health-llm-result')!;
    expect(container.querySelector('.llm-result-summary')).toBeTruthy();
    expect(container.querySelector('.llm-result-summary')!.textContent).toContain('降级 2 条');
    // 2 个降级项
    const items = container.querySelectorAll('.llm-result-item');
    expect(items).toHaveLength(2);
    // 每项含恢复按钮
    expect(items[0]!.querySelector('[data-action="restore-boost"]')).toBeTruthy();
  });

  it('timeliness 治理：应在 #health-llm-result 渲染降级列表', async () => {
    const controller = createMemoryOrchestrator(mockUiManager);
    controller.setupMemoryPanel();

    await llmCallback!('timeliness');

    const container = document.getElementById('health-llm-result')!;
    expect(container.querySelector('.llm-result-summary')!.textContent).toContain('过时 1 条');
    expect(container.querySelectorAll('.llm-result-item')).toHaveLength(1);
  });

  it('conflicts 治理：应在 #health-llm-result 渲染冲突对详情（无恢复按钮）', async () => {
    const controller = createMemoryOrchestrator(mockUiManager);
    controller.setupMemoryPanel();

    await llmCallback!('conflicts');

    const container = document.getElementById('health-llm-result')!;
    expect(container.querySelector('.llm-result-summary')!.textContent).toContain('发现 1 处冲突');
    // 1 个冲突对
    const pairs = container.querySelectorAll('.llm-result-pair');
    expect(pairs).toHaveLength(1);
    // 冲突对应含两条记忆展示
    expect(pairs[0]!.querySelectorAll('.llm-result-pair-memory')).toHaveLength(2);
    // 冲突对应含冲突描述 + 建议 + 理由
    expect(pairs[0]!.querySelector('.llm-result-pair-desc')!.textContent).toContain('技术栈选择冲突');
    expect(pairs[0]!.querySelector('.llm-result-pair-rec')!.textContent).toContain('保留 A');
    expect(pairs[0]!.querySelector('.llm-result-pair-reason')!.textContent).toContain('A 更符合项目现状');
    // 冲突对应不含恢复按钮（L3 仅检测不修复）
    expect(pairs[0]!.querySelector('[data-action="restore-boost"]')).toBeNull();
  });

  it('降级列表恢复按钮点击应调用 boostMemory IPC', async () => {
    const controller = createMemoryOrchestrator(mockUiManager);
    controller.setupMemoryPanel();

    await llmCallback!('dedup');

    // 点击第一个恢复按钮
    const restoreBtn = document.querySelector('[data-action="restore-boost"]') as HTMLButtonElement;
    expect(restoreBtn).toBeTruthy();
    restoreBtn.click();

    // 等待异步回调完成（boostMemory 是 async）
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(window.electronAPI.boostMemory).toHaveBeenCalledWith('insight:dup-1');
    expect(mockUiManager.showToast).toHaveBeenCalledWith(
      '记忆权重已恢复',
      'success',
    );
  });

  it('skippedReason 非空时应渲染跳过提示', async () => {
    (window.electronAPI.deduplicateMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      scannedCount: 0,
      pairCount: 0,
      deduplicatedCount: 0,
      demotedIds: [],
      skippedReason: 'backgroundProvider 未注入',
    });

    const controller = createMemoryOrchestrator(mockUiManager);
    controller.setupMemoryPanel();

    await llmCallback!('dedup');

    const container = document.getElementById('health-llm-result')!;
    expect(container.querySelector('.llm-result-skipped')).toBeTruthy();
    expect(container.querySelector('.llm-result-skipped')!.textContent).toContain('backgroundProvider 未注入');
    // 跳过时不应渲染降级列表
    expect(container.querySelector('.llm-result-list')).toBeNull();
  });
});
