/**
 * memoryPanelEvents 事件接线测试
 *
 * 覆盖目标：initMemoryPanelListeners 提取出的 10 个 init 子函数中
 * 现有 memoryPanelManagerInstance.test.ts 未直接覆盖的 6 个：
 *   - M1: initAdvancedFilterBar + initMoreMenu + initAnalysisPanelClose
 *   - M2: initViewSwitchButtons + initCleanupDialog + initRecycleBinActions
 *
 * Mock 策略：
 * - jsdom 环境 + setupDOM() 设置完整 DOM
 * - 构造 mock MemoryPanelEventContext（DI 注入）
 * - 通过 dispatchEvent 触发事件 + 验证 callback 调用
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { initMemoryPanelListeners } from '../../../electron/renderer/helpers/memoryPanelEvents.js';
import type { MemoryPanelEventContext } from '../../../electron/renderer/helpers/memoryPanelEvents.js';
import { EventTracker } from '../../../electron/renderer/helpers/eventTracker.js';

// ─── 测试辅助 ─────────────────────────────────────────────

/** 创建 mock host（showModal/showConfirmDialog/showToast） */
function createMockHost() {
  return {
    showModal: vi.fn(),
    showConfirmDialog: vi.fn().mockResolvedValue(true),
    showToast: vi.fn(),
  };
}

/** 设置完整 DOM 环境（记忆面板所有元素） */
function setupDOM(): void {
  document.body.innerHTML = `
    <!-- 核心元素（initMemoryPanelListeners 入口检查） -->
    <input id="memory-search" type="text" />
    <select id="memory-filter-source">
      <option value="">全部</option>
      <option value="insight">洞察</option>
    </select>
    <div id="memory-list"></div>
    <div id="memory-detail-modal" data-memory-name="测试记忆"></div>

    <!-- 高级筛选栏 -->
    <button id="btn-advanced-filter">高级筛选</button>
    <div id="advanced-search-bar" class="hidden"></div>
    <select id="memory-sort-order">
      <option value="score">按分数</option>
      <option value="time">按时间</option>
    </select>
    <select id="memory-time-range">
      <option value="all">全部时间</option>
      <option value="7d">最近7天</option>
    </select>

    <!-- 更多菜单 -->
    <button id="btn-memory-more">更多</button>
    <div id="memory-more-menu" class="hidden">
      <div class="more-menu-item" data-action="insights">统计洞察</div>
      <div class="more-menu-item" data-action="health">健康度诊断</div>
    </div>

    <!-- 分析面板关闭按钮 -->
    <button id="btn-close-insights">关闭洞察</button>
    <button id="btn-close-health">关闭健康度</button>

    <!-- 视图切换按钮 -->
    <button id="btn-list-view" class="active" aria-selected="true">列表</button>
    <button id="btn-graph-view" aria-selected="false">图谱</button>
    <button id="btn-timeline-view" aria-selected="false">时间线</button>
    <div id="memory-graph-container" class="hidden"></div>
    <div id="memory-timeline-container" class="hidden"></div>

    <!-- 智能清理对话框 -->
    <button id="health-cleanup-duplicates">清理重复</button>
    <button id="health-cleanup-stale">清理过期</button>
    <button id="health-cleanup-all">清理全部</button>
    <div id="cleanup-confirm-dialog" class="hidden"></div>
    <button id="cleanup-confirm-cancel">取消</button>
    <button id="cleanup-confirm-confirm">确认</button>

    <!-- 回收站列表 -->
    <div id="recycle-bin-list">
      <div data-action="restore-memory" data-memory-id="mem-1">恢复</div>
      <div data-action="purge-memory" data-memory-id="mem-2">彻底删除</div>
    </div>

    <!-- 添加记忆表单 -->
    <button id="btn-add-memory">添加</button>
    <button id="btn-memory-add-confirm">确认添加</button>
    <textarea id="memory-add-content"></textarea>
  `;
}

/** 创建 mock MemoryPanelEventContext（DI 容器） */
function createMockCtx(overrides?: Partial<MemoryPanelEventContext>): {
  ctx: MemoryPanelEventContext;
  callbacks: {
    search: ReturnType<typeof vi.fn>;
    filter: ReturnType<typeof vi.fn>;
    click: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    add: ReturnType<typeof vi.fn>;
    discuss: ReturnType<typeof vi.fn>;
    sortChange: ReturnType<typeof vi.fn>;
    timeRangeChange: ReturnType<typeof vi.fn>;
    cleanupRequest: ReturnType<typeof vi.fn>;
    cleanupConfirm: ReturnType<typeof vi.fn>;
    viewSwitch: ReturnType<typeof vi.fn>;
    recycleBinAction: ReturnType<typeof vi.fn>;
  };
  host: ReturnType<typeof createMockHost>;
  events: EventTracker;
} {
  const callbacks = {
    search: vi.fn(),
    filter: vi.fn(),
    click: vi.fn(),
    delete: vi.fn(),
    add: vi.fn(),
    discuss: vi.fn(),
    sortChange: vi.fn(),
    timeRangeChange: vi.fn(),
    cleanupRequest: vi.fn().mockReturnValue(['id-1', 'id-2']),
    cleanupConfirm: vi.fn().mockResolvedValue(undefined),
    viewSwitch: vi.fn(),
    recycleBinAction: vi.fn(),
  };
  const host = createMockHost();
  const events = new EventTracker();

  // 状态访问器（防抖定时器 + pendingCleanupIds）
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingCleanupIds: string[] = [];

  const ctx: MemoryPanelEventContext = {
    memoryListEl: document.getElementById('memory-list'),
    memorySearchEl: document.getElementById('memory-search') as HTMLInputElement,
    memoryFilterSourceEl: document.getElementById('memory-filter-source') as HTMLSelectElement,
    memoryDetailModal: document.getElementById('memory-detail-modal'),
    events,
    host,
    getSearchTimer: () => searchTimer,
    setSearchTimer: (t) => { searchTimer = t; },
    getPendingCleanupIds: () => pendingCleanupIds,
    setPendingCleanupIds: (ids) => { pendingCleanupIds = ids; },
    getAddMemoryFormData: vi.fn().mockReturnValue({ source: 'insight', name: '测试', content: '内容' }),
    enterEditMode: vi.fn(),
    exitEditMode: vi.fn(),
    saveEdit: vi.fn(),
    toggleAnalysisPanel: vi.fn(),
    hideAnalysisPanel: vi.fn(),
    switchView: vi.fn(),
    showCleanupDialog: vi.fn(),
    getMemorySearchCallback: () => callbacks.search,
    getMemoryFilterCallback: () => callbacks.filter,
    getMemoryClickCallback: () => callbacks.click,
    getMemoryDeleteCallback: () => callbacks.delete,
    getMemoryAddCallback: () => callbacks.add,
    getMemoryDiscussCallback: () => callbacks.discuss,
    getSortChangeCallback: () => callbacks.sortChange,
    getTimeRangeChangeCallback: () => callbacks.timeRangeChange,
    getCleanupRequestCallback: () => callbacks.cleanupRequest,
    getCleanupConfirmCallback: () => callbacks.cleanupConfirm,
    getViewSwitchCallback: () => callbacks.viewSwitch,
    getRecycleBinActionCallback: () => callbacks.recycleBinAction,
    ...overrides,
  };

  return { ctx, callbacks, host, events };
}

// ─── M1：高级筛选栏 + 更多菜单 + 分析面板关闭 ────────────────

describe('memoryPanelEvents M1 高级筛选栏 + 更多菜单 + 分析面板关闭', () => {
  beforeEach(() => {
    setupDOM();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('initAdvancedFilterBar', () => {
    it('高级筛选按钮点击应切换 advanced-search-bar 的 hidden 状态', () => {
      const { ctx } = createMockCtx();
      initMemoryPanelListeners(ctx);

      const advBtn = document.getElementById('btn-advanced-filter')!;
      const advBar = document.getElementById('advanced-search-bar')!;

      // 初始 hidden
      expect(advBar.classList.contains('hidden')).toBe(true);
      expect(advBtn.classList.contains('active')).toBe(false);

      // 第一次点击：显示筛选栏 + active
      advBtn.click();
      expect(advBar.classList.contains('hidden')).toBe(false);
      expect(advBtn.classList.contains('active')).toBe(true);

      // 第二次点击：隐藏筛选栏 + 取消 active
      advBtn.click();
      expect(advBar.classList.contains('hidden')).toBe(true);
      expect(advBtn.classList.contains('active')).toBe(false);
    });

    it('排序方式变更应触发 getSortChangeCallback', () => {
      const { ctx, callbacks } = createMockCtx();
      initMemoryPanelListeners(ctx);

      const sortEl = document.getElementById('memory-sort-order') as HTMLSelectElement;
      sortEl.value = 'time';
      sortEl.dispatchEvent(new Event('change'));

      expect(callbacks.sortChange).toHaveBeenCalledTimes(1);
    });

    it('时间范围变更应触发 getTimeRangeChangeCallback', () => {
      const { ctx, callbacks } = createMockCtx();
      initMemoryPanelListeners(ctx);

      const timeRangeEl = document.getElementById('memory-time-range') as HTMLSelectElement;
      timeRangeEl.value = '7d';
      timeRangeEl.dispatchEvent(new Event('change'));

      expect(callbacks.timeRangeChange).toHaveBeenCalledTimes(1);
    });
  });

  describe('initMoreMenu', () => {
    it('更多菜单按钮点击应切换菜单显示 + 阻止冒泡', () => {
      const { ctx } = createMockCtx();
      initMemoryPanelListeners(ctx);

      const moreBtn = document.getElementById('btn-memory-more')!;
      const moreMenu = document.getElementById('memory-more-menu')!;

      // 初始 hidden
      expect(moreMenu.classList.contains('hidden')).toBe(true);

      // 点击切换显示
      moreBtn.click();
      expect(moreMenu.classList.contains('hidden')).toBe(false);
      expect(moreBtn.getAttribute('aria-expanded')).toBe('true');

      // 再次点击隐藏
      moreBtn.click();
      expect(moreMenu.classList.contains('hidden')).toBe(true);
      expect(moreBtn.getAttribute('aria-expanded')).toBe('false');
    });

    it('点击菜单外部应关闭更多菜单', () => {
      const { ctx } = createMockCtx();
      initMemoryPanelListeners(ctx);

      const moreBtn = document.getElementById('btn-memory-more')!;
      const moreMenu = document.getElementById('memory-more-menu')!;

      // 先打开菜单
      moreBtn.click();
      expect(moreMenu.classList.contains('hidden')).toBe(false);

      // 点击 document body（菜单外部）应关闭
      document.body.click();
      expect(moreMenu.classList.contains('hidden')).toBe(true);
    });

    it('点击 insights 菜单项应调用 toggleAnalysisPanel("insights") 并关闭菜单', () => {
      const { ctx } = createMockCtx();
      initMemoryPanelListeners(ctx);

      const moreBtn = document.getElementById('btn-memory-more')!;
      const insightsItem = document.querySelector('.more-menu-item[data-action="insights"]') as HTMLElement;

      // 打开菜单
      moreBtn.click();

      // 点击 insights 菜单项
      insightsItem.click();

      expect(ctx.toggleAnalysisPanel).toHaveBeenCalledWith('insights');
      // 菜单应自动关闭
      const moreMenu = document.getElementById('memory-more-menu')!;
      expect(moreMenu.classList.contains('hidden')).toBe(true);
    });

    it('点击 health 菜单项应调用 toggleAnalysisPanel("health") 并关闭菜单', () => {
      const { ctx } = createMockCtx();
      initMemoryPanelListeners(ctx);

      const moreBtn = document.getElementById('btn-memory-more')!;
      const healthItem = document.querySelector('.more-menu-item[data-action="health"]') as HTMLElement;

      moreBtn.click();
      healthItem.click();

      expect(ctx.toggleAnalysisPanel).toHaveBeenCalledWith('health');
      const moreMenu = document.getElementById('memory-more-menu')!;
      expect(moreMenu.classList.contains('hidden')).toBe(true);
    });
  });

  describe('initAnalysisPanelClose', () => {
    it('点击关闭洞察按钮应调用 hideAnalysisPanel', () => {
      const { ctx } = createMockCtx();
      initMemoryPanelListeners(ctx);

      const closeInsightsBtn = document.getElementById('btn-close-insights')!;
      closeInsightsBtn.click();

      expect(ctx.hideAnalysisPanel).toHaveBeenCalledTimes(1);
    });

    it('点击关闭健康度按钮应调用 hideAnalysisPanel', () => {
      const { ctx } = createMockCtx();
      initMemoryPanelListeners(ctx);

      const closeHealthBtn = document.getElementById('btn-close-health')!;
      closeHealthBtn.click();

      expect(ctx.hideAnalysisPanel).toHaveBeenCalledTimes(1);
    });
  });

  describe('initMemoryPanelListeners 入口降级', () => {
    it('memorySearchEl 缺失时应静默返回（不注册任何监听器）', () => {
      const { ctx, events } = createMockCtx({ memorySearchEl: null });
      // 不应抛错
      expect(() => initMemoryPanelListeners(ctx)).not.toThrow();
      // 由于入口检查，不应注册任何监听器（可通过 cleanup 验证无副作用）
      events.cleanup();
    });

    it('memoryFilterSourceEl 缺失时应静默返回', () => {
      const { ctx } = createMockCtx({ memoryFilterSourceEl: null });
      expect(() => initMemoryPanelListeners(ctx)).not.toThrow();
    });
  });
});

// ─── M2：视图切换 + 清理对话框 + 回收站 ────────────────────

describe('memoryPanelEvents M2 视图切换 + 清理对话框 + 回收站', () => {
  beforeEach(() => {
    setupDOM();
  });

  describe('initViewSwitchButtons', () => {
    it('点击列表视图按钮应切换 active 状态 + 调用 switchView + viewSwitchCallback', () => {
      const { ctx, callbacks } = createMockCtx();
      initMemoryPanelListeners(ctx);

      const listBtn = document.getElementById('btn-list-view')!;
      listBtn.click();

      expect(ctx.switchView).toHaveBeenCalledWith('list');
      expect(callbacks.viewSwitch).toHaveBeenCalledWith('list');
      // list 按钮应保持 active
      expect(listBtn.classList.contains('active')).toBe(true);
      expect(listBtn.getAttribute('aria-selected')).toBe('true');
    });

    it('点击图谱视图按钮（当前为列表）应切换到图谱视图', () => {
      const { ctx, callbacks } = createMockCtx();
      initMemoryPanelListeners(ctx);

      const graphBtn = document.getElementById('btn-graph-view')!;
      // memory-graph-container 初始 hidden，即当前非图谱视图
      graphBtn.click();

      expect(ctx.switchView).toHaveBeenCalledWith('graph');
      expect(callbacks.viewSwitch).toHaveBeenCalledWith('graph');
      // graph 按钮应变 active
      expect(graphBtn.classList.contains('active')).toBe(true);
      expect(graphBtn.getAttribute('aria-selected')).toBe('true');
      // list 按钮应取消 active
      const listBtn = document.getElementById('btn-list-view')!;
      expect(listBtn.classList.contains('active')).toBe(false);
    });

    it('点击图谱视图按钮（当前已是图谱）应降级回列表视图', () => {
      const { ctx, callbacks } = createMockCtx();
      initMemoryPanelListeners(ctx);

      // 模拟当前已是图谱视图：移除 graph-container 的 hidden
      const graphContainer = document.getElementById('memory-graph-container')!;
      graphContainer.classList.remove('hidden');

      const graphBtn = document.getElementById('btn-graph-view')!;
      graphBtn.click();

      // 应降级回列表
      expect(ctx.switchView).toHaveBeenCalledWith('list');
      expect(callbacks.viewSwitch).toHaveBeenCalledWith('list');
    });

    it('点击时间线视图按钮（当前为列表）应切换到时间线视图', () => {
      const { ctx, callbacks } = createMockCtx();
      initMemoryPanelListeners(ctx);

      const timelineBtn = document.getElementById('btn-timeline-view')!;
      timelineBtn.click();

      expect(ctx.switchView).toHaveBeenCalledWith('timeline');
      expect(callbacks.viewSwitch).toHaveBeenCalledWith('timeline');
      expect(timelineBtn.classList.contains('active')).toBe(true);
    });

    it('点击时间线视图按钮（当前已是时间线）应降级回列表视图', () => {
      const { ctx, callbacks } = createMockCtx();
      initMemoryPanelListeners(ctx);

      // 模拟当前已是时间线视图
      const timelineContainer = document.getElementById('memory-timeline-container')!;
      timelineContainer.classList.remove('hidden');

      const timelineBtn = document.getElementById('btn-timeline-view')!;
      timelineBtn.click();

      expect(ctx.switchView).toHaveBeenCalledWith('list');
      expect(callbacks.viewSwitch).toHaveBeenCalledWith('list');
    });
  });

  describe('initCleanupDialog', () => {
    it('清理重复按钮（有待清理 ID）应调用 showCleanupDialog', () => {
      const { ctx, callbacks } = createMockCtx();
      initMemoryPanelListeners(ctx);

      const cleanupDupBtn = document.getElementById('health-cleanup-duplicates')!;
      cleanupDupBtn.click();

      expect(callbacks.cleanupRequest).toHaveBeenCalledWith('duplicates');
      expect(ctx.showCleanupDialog).toHaveBeenCalledWith(
        expect.stringContaining('2 条重复记忆'),
        ['id-1', 'id-2'],
      );
    });

    it('清理重复按钮（无待清理 ID）应显示 toast 提示', () => {
      const { ctx, callbacks, host } = createMockCtx();
      callbacks.cleanupRequest.mockReturnValue([]);
      initMemoryPanelListeners(ctx);

      const cleanupDupBtn = document.getElementById('health-cleanup-duplicates')!;
      cleanupDupBtn.click();

      expect(host.showToast).toHaveBeenCalledWith('没有可清理的重复记忆', 'info');
      expect(ctx.showCleanupDialog).not.toHaveBeenCalled();
    });

    it('清理过期按钮（有待清理 ID）应调用 showCleanupDialog', () => {
      const { ctx, callbacks } = createMockCtx();
      initMemoryPanelListeners(ctx);

      const cleanupStaleBtn = document.getElementById('health-cleanup-stale')!;
      cleanupStaleBtn.click();

      expect(callbacks.cleanupRequest).toHaveBeenCalledWith('stale');
      expect(ctx.showCleanupDialog).toHaveBeenCalledWith(
        expect.stringContaining('2 条过期记忆'),
        ['id-1', 'id-2'],
      );
    });

    it('清理全部按钮（有待清理 ID）应调用 showCleanupDialog', () => {
      const { ctx, callbacks } = createMockCtx();
      initMemoryPanelListeners(ctx);

      const cleanupAllBtn = document.getElementById('health-cleanup-all')!;
      cleanupAllBtn.click();

      expect(callbacks.cleanupRequest).toHaveBeenCalledWith('all');
      expect(ctx.showCleanupDialog).toHaveBeenCalledWith(
        expect.stringContaining('2 条问题记忆'),
        ['id-1', 'id-2'],
      );
    });

    it('取消按钮应隐藏对话框 + 清空 pendingCleanupIds', () => {
      const { ctx } = createMockCtx();
      initMemoryPanelListeners(ctx);

      // 模拟 showCleanupDialog 已设置 pendingCleanupIds
      ctx.setPendingCleanupIds(['id-1', 'id-2']);
      const cleanupDialog = document.getElementById('cleanup-confirm-dialog')!;
      cleanupDialog.classList.remove('hidden'); // 模拟对话框已显示

      const cancelBtn = document.getElementById('cleanup-confirm-cancel')!;
      cancelBtn.click();

      expect(cleanupDialog.classList.contains('hidden')).toBe(true);
      expect(ctx.getPendingCleanupIds()).toEqual([]);
    });

    it('确认按钮应隐藏对话框 + 清空 pendingCleanupIds + 调用 cleanupConfirmCallback', async () => {
      const { ctx, callbacks } = createMockCtx();
      initMemoryPanelListeners(ctx);

      // 模拟 showCleanupDialog 已设置 pendingCleanupIds
      ctx.setPendingCleanupIds(['id-1', 'id-2']);
      const cleanupDialog = document.getElementById('cleanup-confirm-dialog')!;
      cleanupDialog.classList.remove('hidden');

      const confirmBtn = document.getElementById('cleanup-confirm-confirm')!;
      confirmBtn.click();

      // 等待 async 回调完成
      await vi.waitFor(() => {
        expect(callbacks.cleanupConfirm).toHaveBeenCalledWith(['id-1', 'id-2']);
      });

      expect(cleanupDialog.classList.contains('hidden')).toBe(true);
      expect(ctx.getPendingCleanupIds()).toEqual([]);
    });

    it('确认按钮（pendingCleanupIds 为空）应直接返回不调用 cleanupConfirmCallback', async () => {
      const { ctx, callbacks } = createMockCtx();
      initMemoryPanelListeners(ctx);

      // pendingCleanupIds 为空
      ctx.setPendingCleanupIds([]);
      const confirmBtn = document.getElementById('cleanup-confirm-confirm')!;
      confirmBtn.click();

      // 不应调用 cleanupConfirmCallback
      expect(callbacks.cleanupConfirm).not.toHaveBeenCalled();
    });
  });

  describe('initRecycleBinActions', () => {
    it('点击恢复按钮应调用 recycleBinActionCallback("restore", id)', () => {
      const { ctx, callbacks } = createMockCtx();
      initMemoryPanelListeners(ctx);

      const restoreBtn = document.querySelector('[data-action="restore-memory"]') as HTMLElement;
      restoreBtn.click();

      expect(callbacks.recycleBinAction).toHaveBeenCalledWith('restore', 'mem-1');
    });

    it('点击彻底删除按钮应调用 recycleBinActionCallback("purge", id)', () => {
      const { ctx, callbacks } = createMockCtx();
      initMemoryPanelListeners(ctx);

      const purgeBtn = document.querySelector('[data-action="purge-memory"]') as HTMLElement;
      purgeBtn.click();

      expect(callbacks.recycleBinAction).toHaveBeenCalledWith('purge', 'mem-2');
    });

    it('点击回收站列表空白区域不应触发回调', () => {
      const { ctx, callbacks } = createMockCtx();
      initMemoryPanelListeners(ctx);

      const recycleBinList = document.getElementById('recycle-bin-list')!;
      // 点击列表容器本身（非按钮）
      recycleBinList.click();

      expect(callbacks.recycleBinAction).not.toHaveBeenCalled();
    });
  });
});
