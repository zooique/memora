/**
 * 记忆面板控制器测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - formatTokenCount：token 数格式化（< 1000 直显 / >= 1000 显示为 "X.Xk"）
 * - FD-ADD-REC-CLICK 推荐记忆点击事件委托：
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
import { formatTokenCount } from '../../../electron/renderer/panels/dashboardPanelManager.js';
import { createMemoryController } from '../../../electron/renderer/controllers/memoryPanelController.js';
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

// ─── FD-ADD-REC-CLICK 推荐记忆点击事件委托 ────────────────

/** 创建 mock uiManager（仅包含 createMemoryController 用到的方法） */
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
    onSortChange: vi.fn(),
    onTimeRangeChange: vi.fn(),
    onCleanupRequest: vi.fn(() => []),
    onCleanupConfirm: vi.fn(),
    onViewSwitch: vi.fn(),
    // 仪表盘重试回调（DashboardPanelManager 委托）
    onReloadInsights: vi.fn(),
    onReloadHealth: vi.fn(),
    onReloadMemoryList: vi.fn(),
    switchMemoryView: vi.fn(),
    loadGraphData: vi.fn(),
    hasGraphData: vi.fn(() => false),
    highlightGraphNodes: vi.fn(),
    selectGraphNode: vi.fn(),
    clearGraphHighlights: vi.fn(),
    pulseNarrativeCard: vi.fn(),
    triggerMemoryRecall: vi.fn(),
    renderMemoryList: vi.fn(),
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
    renderSkills: vi.fn(),
    renderMilestones: vi.fn(),
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
  };
  // 使用类型断言避免完整实现 UIManager 的所有方法
  return spies as unknown as UIManager & { triggerMemoryRecall: ReturnType<typeof vi.fn> };
}

describe('FD-ADD-REC-CLICK 推荐记忆点击事件委托', () => {
  let mockUiManager: ReturnType<typeof createMockUiManager>;

  beforeEach(() => {
    // 设置 DOM：仪表盘推荐记忆列表容器（合并到学习与回顾节）
    document.body.innerHTML = `
      <ul id="recommendation-list"></ul>
      <section id="learning-progress"></section>
      <input id="memory-search" type="text" />
      <select id="memory-filter-source"><option value="">全部</option></select>
    `;

    // mock window.electronAPI.getDashboard 返回含 suggestions 的数据
    // FD-ADD-REC-CLICK：suggestions 包含 name 字段，用于跳转
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
        // Phase 2 重构后 loadDashboard 调用 renderDashboardStats/renderMilestones 需要这两个字段
        total: 2,
        bySource: { insight: 1, profile: 1 },
        sourceHealth: null,
        metrics: null,
        skills: [],
      }),
      listMemories: vi.fn().mockResolvedValue({ memories: [] }),
      // Phase 2 重构后 loadDashboard 串行调用 getReviewData，需提供 mock 避免抛错
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

  // FD-ADD-REC-CLICK 点击事件委托已迁移到 UIManager.initEventListeners（通过 EventTracker 统一管理）
  // 点击行为测试见 ui.test.ts 的 "FD-ADD-REC-CLICK 推荐记忆点击事件委托" 描述块

  it('loadDashboard 应将仪表盘数据委托给 renderDashboardStats 渲染（推荐记忆数据由 Manager 渲染为 li[data-action]）', async () => {
    const controller = createMemoryController(mockUiManager);
    controller.setupMemoryPanel();
    await controller.loadDashboard();

    // Phase 2 重构后，Controller 仅做 IPC 编排，DOM 渲染委托 DashboardPanelManager
    // 此处验证 renderDashboardStats 被调用并接收含 suggestions 的完整数据
    expect(mockUiManager.renderDashboardStats).toHaveBeenCalledTimes(1);
    const callArg = mockUiManager.renderDashboardStats.mock.calls[0][0];
    expect(callArg.suggestions).toHaveLength(2);
    expect(callArg.suggestions[0].name).toBe('推荐记忆A');
    // 同时验证其他委托方法被调用
    expect(mockUiManager.renderAgentMetrics).toHaveBeenCalledWith(null);
    expect(mockUiManager.renderSkills).toHaveBeenCalledWith([]);
    expect(mockUiManager.renderMilestones).toHaveBeenCalledTimes(1);
    // v3: renderReviewData DOM 已恢复到感知面板
    expect(mockUiManager.renderReviewData).toHaveBeenCalledTimes(1);
    expect(mockUiManager.updateLearningProgress).toHaveBeenCalledTimes(1);
  });
});

// ─── FD-FIX-DELETE-LOADING 删除按钮 loading 保护 ───────

describe('FD-FIX-DELETE-LOADING 删除按钮 loading 保护', () => {
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
      deleteMemory: vi.fn().mockResolvedValue(undefined),
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

  it('删除时应禁用按钮 + 显示"删除中..."', async () => {
    const controller = createMemoryController(mockUiManager);
    controller.setupMemoryPanel();

    const btn = document.getElementById('btn-memory-delete') as HTMLButtonElement;
    expect(deleteCallback).not.toBeNull();

    // 触发删除回调（不 await，先检查 loading 状态）
    const promise = deleteCallback!();
    // 按钮应被禁用 + 文案改变
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toBe('删除中...');

    await promise;
  });

  it('删除成功后应恢复按钮状态', async () => {
    const controller = createMemoryController(mockUiManager);
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

    const controller = createMemoryController(mockUiManager);
    controller.setupMemoryPanel();

    const btn = document.getElementById('btn-memory-delete') as HTMLButtonElement;
    await deleteCallback!();

    // 按钮应恢复（finally 兜底）
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe('删除');
  });

  it('无记忆 ID 时不应触发删除 IPC', async () => {
    mockUiManager.getCurrentMemoryId.mockReturnValue(null);

    const controller = createMemoryController(mockUiManager);
    controller.setupMemoryPanel();

    await deleteCallback!();

    expect(window.electronAPI.deleteMemory).not.toHaveBeenCalled();
  });
});
