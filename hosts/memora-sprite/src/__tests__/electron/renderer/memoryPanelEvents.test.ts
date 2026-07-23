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
    <div id="memory-list">
      <!-- 列表项：带 data-action 与 data-memory-id，用于事件委托分发 -->
      <div data-action="view-memory" data-memory-id="mem-001">记忆条目 1</div>
    </div>
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
      <div class="more-menu-item" data-action="recycle-bin">回收站</div>
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

    <!-- 回收站列表（事件委托：恢复 / 彻底删除按钮） -->
    <div id="recycle-bin-list">
      <button type="button" data-action="restore-memory" data-memory-id="mem-1">恢复</button>
      <button type="button" data-action="purge-memory" data-memory-id="mem-2">彻底删除</button>
    </div>

    <!-- 回收站批量操作按钮 -->
    <button id="recycle-bin-restore-all">全部恢复</button>
    <button id="recycle-bin-purge-all">全部清空</button>

    <!-- 添加记忆表单 -->
    <button id="btn-add-memory">添加</button>
    <button id="btn-memory-add-confirm">确认添加</button>
    <input id="memory-add-source" type="text" />
    <input id="memory-add-name" type="text" />
    <textarea id="memory-add-content"></textarea>
    <!-- 字段级错误文本容器（与 formValidation 约定一致：{inputId}-error） -->
    <div id="memory-add-source-error" class="hidden"></div>
    <div id="memory-add-name-error" class="hidden"></div>
    <div id="memory-add-content-error" class="hidden"></div>

    <!-- 详情操作按钮（删除 / 编辑 / 保存 / 取消 / 讨论） -->
    <button id="btn-memory-delete">删除</button>
    <button id="btn-memory-edit">编辑</button>
    <button id="btn-memory-edit-save">保存</button>
    <button id="btn-memory-edit-cancel">取消</button>
    <button id="btn-memory-discuss">讨论</button>
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
    recycleBinBatchAction: ReturnType<typeof vi.fn>;
    moreMenuAction: ReturnType<typeof vi.fn>;
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
    recycleBinBatchAction: vi.fn(),
    moreMenuAction: vi.fn(),
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
    // F2：编辑模式守卫方法（取消按钮/Esc/关闭按钮/backdrop 触发）
    confirmExitEditMode: vi.fn().mockResolvedValue(undefined),
    handleCloseRequest: vi.fn().mockResolvedValue(true),
    getIsEditing: vi.fn().mockReturnValue(false),
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
    getRecycleBinBatchActionCallback: () => callbacks.recycleBinBatchAction,
    getMoreMenuActionCallback: () => callbacks.moreMenuAction,
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
    it('点击恢复按钮应调用 recycleBinActionCallback("restore", id)', async () => {
      const { ctx, callbacks } = createMockCtx();
      initMemoryPanelListeners(ctx);

      const restoreBtn = document.querySelector('[data-action="restore-memory"]') as HTMLElement;
      restoreBtn.click();

      // B7：click handler 已改为 async（事件委托 + loading 包装），用 vi.waitFor 等待异步完成
      await vi.waitFor(() => {
        expect(callbacks.recycleBinAction).toHaveBeenCalledWith('restore', 'mem-1');
      });
    });

    it('点击彻底删除按钮应调用 recycleBinActionCallback("purge", id)', async () => {
      const { ctx, callbacks } = createMockCtx();
      initMemoryPanelListeners(ctx);

      const purgeBtn = document.querySelector('[data-action="purge-memory"]') as HTMLElement;
      purgeBtn.click();

      // B7：click handler 已改为 async，用 vi.waitFor 等待异步完成
      await vi.waitFor(() => {
        expect(callbacks.recycleBinAction).toHaveBeenCalledWith('purge', 'mem-2');
      });
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

// ─── M3：列表点击委托 + 搜索筛选 ────────────────────────────

describe('memoryPanelEvents M3 列表点击委托 + 搜索筛选', () => {
  beforeEach(() => {
    setupDOM();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('initListClickDelegation', () => {
    it('点击列表项应触发 getMemoryClickCallback 并传入 memoryId', () => {
      // 验证事件委托：在 list 容器上注册 click，通过 data-action 分发到具体回调
      const { ctx, callbacks } = createMockCtx();
      initMemoryPanelListeners(ctx);

      const item = document.querySelector('[data-action="view-memory"]') as HTMLElement;
      item.click();

      expect(callbacks.click).toHaveBeenCalledWith('mem-001');
    });

    it('点击列表容器（非列表项）不应触发 click 回调', () => {
      // 验证 closest 选择器：仅 data-action="view-memory" 元素触发
      const { ctx, callbacks } = createMockCtx();
      initMemoryPanelListeners(ctx);

      const list = document.getElementById('memory-list')!;
      list.click();

      expect(callbacks.click).not.toHaveBeenCalled();
    });

    it('列表项缺少 data-memory-id 时应回退为空字符串', () => {
      // 验证 dataset.memoryId ?? '' 降级：避免 undefined 传入回调
      const { ctx, callbacks } = createMockCtx();
      initMemoryPanelListeners(ctx);

      // 动态构造一个无 data-memory-id 的列表项
      const itemWithoutId = document.createElement('div');
      itemWithoutId.setAttribute('data-action', 'view-memory');
      document.getElementById('memory-list')!.appendChild(itemWithoutId);
      itemWithoutId.click();

      expect(callbacks.click).toHaveBeenCalledWith('');
    });

    it('按下 Enter 键应触发 click 回调（键盘可访问性）', () => {
      // 验证 keydown 委托：Enter 键与 click 等效
      const { ctx, callbacks } = createMockCtx();
      initMemoryPanelListeners(ctx);

      const item = document.querySelector('[data-action="view-memory"]') as HTMLElement;
      item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

      expect(callbacks.click).toHaveBeenCalledWith('mem-001');
    });

    it('按下 Space 键应触发 click 回调', () => {
      // 验证 keydown 委托：Space 键与 click 等效
      const { ctx, callbacks } = createMockCtx();
      initMemoryPanelListeners(ctx);

      const item = document.querySelector('[data-action="view-memory"]') as HTMLElement;
      item.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));

      expect(callbacks.click).toHaveBeenCalledWith('mem-001');
    });

    it('按下其他键（如 Tab）不应触发 click 回调', () => {
      // 验证 key 检查：仅 Enter/Space 触发，避免 Tab 等键误触发
      const { ctx, callbacks } = createMockCtx();
      initMemoryPanelListeners(ctx);

      const item = document.querySelector('[data-action="view-memory"]') as HTMLElement;
      item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));

      expect(callbacks.click).not.toHaveBeenCalled();
    });

    it('memoryListEl 缺失时应静默降级（不注册监听器）', () => {
      // 验证 if (!ctx.memoryListEl) return 分支
      const { ctx, callbacks } = createMockCtx({ memoryListEl: null });
      expect(() => initMemoryPanelListeners(ctx)).not.toThrow();
      // 由于 memorySearchEl/memoryFilterSourceEl 仍存在，会进入子初始化；
      // 列表委托本身因 memoryListEl=null 不应注册任何监听器
      expect(callbacks.click).not.toHaveBeenCalled();
    });
  });

  describe('initSearchAndFilter', () => {
    it('搜索框输入应在 300ms 防抖后触发 search 回调', () => {
      // 验证防抖：输入后 300ms 才触发回调
      const { ctx, callbacks } = createMockCtx();
      initMemoryPanelListeners(ctx);

      const searchEl = document.getElementById('memory-search') as HTMLInputElement;
      searchEl.value = '关键词';
      searchEl.dispatchEvent(new Event('input'));

      // 防抖期内不应触发
      vi.advanceTimersByTime(299);
      expect(callbacks.search).not.toHaveBeenCalled();

      // 300ms 后应触发，并传入 trim 后的值
      vi.advanceTimersByTime(1);
      expect(callbacks.search).toHaveBeenCalledWith('关键词');
    });

    it('连续输入应重置防抖定时器（只触发最后一次）', () => {
      // 验证 clearTimeout：连续输入只触发最后一次回调
      const { ctx, callbacks } = createMockCtx();
      initMemoryPanelListeners(ctx);

      const searchEl = document.getElementById('memory-search') as HTMLInputElement;
      searchEl.value = '第一';
      searchEl.dispatchEvent(new Event('input'));

      vi.advanceTimersByTime(200);
      searchEl.value = '第二';
      searchEl.dispatchEvent(new Event('input'));

      vi.advanceTimersByTime(200);
      searchEl.value = '最终';
      searchEl.dispatchEvent(new Event('input'));

      // 总时长 400ms（< 300+300），不应有任何触发
      expect(callbacks.search).not.toHaveBeenCalled();

      // 再过 300ms 应只触发一次（最终值）
      vi.advanceTimersByTime(300);
      expect(callbacks.search).toHaveBeenCalledTimes(1);
      expect(callbacks.search).toHaveBeenCalledWith('最终');
    });

    it('source 筛选变更应立即触发 filter 回调', () => {
      // 验证 source 筛选 change 事件（无防抖）
      const { ctx, callbacks } = createMockCtx();
      initMemoryPanelListeners(ctx);

      const filterEl = document.getElementById('memory-filter-source') as HTMLSelectElement;
      filterEl.value = 'insight';
      filterEl.dispatchEvent(new Event('change'));

      expect(callbacks.filter).toHaveBeenCalledWith('insight');
    });

    it('搜索框输入空字符串应 trim 后传入空字符串', () => {
      // 验证 trim 行为：纯空格输入应转为空字符串
      const { ctx, callbacks } = createMockCtx();
      initMemoryPanelListeners(ctx);

      const searchEl = document.getElementById('memory-search') as HTMLInputElement;
      searchEl.value = '   ';
      searchEl.dispatchEvent(new Event('input'));

      vi.advanceTimersByTime(300);
      expect(callbacks.search).toHaveBeenCalledWith('');
    });
  });
});

// ─── M4：添加记忆表单 + 校验 ────────────────────────────────

describe('memoryPanelEvents M4 添加记忆表单 + 校验', () => {
  beforeEach(() => {
    setupDOM();
  });

  describe('initAddMemoryForm', () => {
    it('点击添加按钮应清空错误状态并打开 memory-add-modal 弹窗', () => {
      // 验证添加按钮：清空残留错误 + 显示弹窗
      const { ctx, host } = createMockCtx();
      initMemoryPanelListeners(ctx);

      const btnAdd = document.getElementById('btn-add-memory')!;
      btnAdd.click();

      expect(host.showModal).toHaveBeenCalledWith('memory-add-modal');
    });

    it('点击确认按钮（校验通过）应清空错误状态并调用 add 回调', () => {
      // 验证确认按钮：getAddMemoryFormData 返回数据时调用 add 回调
      const { ctx, callbacks } = createMockCtx();
      initMemoryPanelListeners(ctx);

      const btnConfirm = document.getElementById('btn-memory-add-confirm')!;
      btnConfirm.click();

      expect(callbacks.add).toHaveBeenCalledWith({ source: 'insight', name: '测试', content: '内容' });
    });

    it('点击确认按钮（校验失败）应调用 validateMemoryAddForm 显示字段错误', () => {
      // 验证校验失败分支：getAddMemoryFormData 返回 null 时显示字段级错误
      const { ctx, callbacks } = createMockCtx();
      // 模拟表单数据为空（校验失败）
      (ctx.getAddMemoryFormData as ReturnType<typeof vi.fn>).mockReturnValue(null);
      initMemoryPanelListeners(ctx);

      const btnConfirm = document.getElementById('btn-memory-add-confirm')!;
      btnConfirm.click();

      // 不应调用 add 回调
      expect(callbacks.add).not.toHaveBeenCalled();
      // 应在 source 字段（首个空字段）上设置 aria-invalid
      const sourceInput = document.getElementById('memory-add-source')!;
      expect(sourceInput.getAttribute('aria-invalid')).toBe('true');
    });

    it('在 textarea 中按下 Ctrl+Enter（校验通过）应触发 add 回调', () => {
      // 验证 Ctrl+Enter 快捷提交：校验通过时调用 add 回调
      const { ctx, callbacks } = createMockCtx();
      initMemoryPanelListeners(ctx);

      const textarea = document.getElementById('memory-add-content')!;
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));

      expect(callbacks.add).toHaveBeenCalledWith({ source: 'insight', name: '测试', content: '内容' });
    });

    it('在 textarea 中按下 Cmd+Enter（校验通过）应触发 add 回调', () => {
      // 验证 metaKey（macOS Cmd）也能触发快捷提交
      const { ctx, callbacks } = createMockCtx();
      initMemoryPanelListeners(ctx);

      const textarea = document.getElementById('memory-add-content')!;
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));

      expect(callbacks.add).toHaveBeenCalled();
    });

    it('在 textarea 中按下 Ctrl+Enter（校验失败）应显示字段错误', () => {
      // 验证 Ctrl+Enter 校验失败分支：显示字段级错误反馈
      const { ctx, callbacks } = createMockCtx();
      (ctx.getAddMemoryFormData as ReturnType<typeof vi.fn>).mockReturnValue(null);
      initMemoryPanelListeners(ctx);

      const textarea = document.getElementById('memory-add-content')!;
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));

      expect(callbacks.add).not.toHaveBeenCalled();
      const sourceInput = document.getElementById('memory-add-source')!;
      expect(sourceInput.getAttribute('aria-invalid')).toBe('true');
    });

    it('在 textarea 中按下普通 Enter（无 Ctrl/Cmd）不应触发提交', () => {
      // 验证普通 Enter 是换行，不触发提交
      const { ctx, callbacks } = createMockCtx();
      initMemoryPanelListeners(ctx);

      const textarea = document.getElementById('memory-add-content')!;
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

      expect(callbacks.add).not.toHaveBeenCalled();
    });

    it('在 textarea 中按下 Ctrl+其他键 不应触发提交', () => {
      // 验证 key 检查：仅 Enter 触发，避免 Ctrl+S 等误触发
      const { ctx, callbacks } = createMockCtx();
      initMemoryPanelListeners(ctx);

      const textarea = document.getElementById('memory-add-content')!;
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }));

      expect(callbacks.add).not.toHaveBeenCalled();
    });
  });

  describe('validateMemoryAddForm（通过确认按钮间接触发）', () => {
    it('所有字段为空时应标记首个空字段并显示错误文本', () => {
      // 验证 validateMemoryAddForm：source/name/content 均空时，
      // 由于 `firstErrorField ??= showFieldError(...)` 短路求值，
      // 仅首个空字段（source）会被 showFieldError 标记，后续字段不调用 showFieldError
      const { ctx } = createMockCtx();
      (ctx.getAddMemoryFormData as ReturnType<typeof vi.fn>).mockReturnValue(null);
      initMemoryPanelListeners(ctx);

      // 确保所有字段为空
      const sourceInput = document.getElementById('memory-add-source') as HTMLInputElement;
      const nameInput = document.getElementById('memory-add-name') as HTMLInputElement;
      const contentEl = document.getElementById('memory-add-content') as HTMLTextAreaElement;
      sourceInput.value = '';
      nameInput.value = '';
      contentEl.value = '';

      const btnConfirm = document.getElementById('btn-memory-add-confirm')!;
      btnConfirm.click();

      // 首个空字段（source）应被标记为 aria-invalid=true
      expect(sourceInput.getAttribute('aria-invalid')).toBe('true');
      // 错误文本应填充
      const sourceError = document.getElementById('memory-add-source-error')!;
      expect(sourceError.textContent).toBe('请填写来源');
      expect(sourceError.classList.contains('hidden')).toBe(false);
    });

    it('source 有值时应标记首个空字段（name）', () => {
      // 验证逐字段检查：source 有值时，首个空字段（name）被标记
      const { ctx } = createMockCtx();
      (ctx.getAddMemoryFormData as ReturnType<typeof vi.fn>).mockReturnValue(null);
      initMemoryPanelListeners(ctx);

      const sourceInput = document.getElementById('memory-add-source') as HTMLInputElement;
      const nameInput = document.getElementById('memory-add-name') as HTMLInputElement;
      const contentEl = document.getElementById('memory-add-content') as HTMLTextAreaElement;
      sourceInput.value = 'insight';
      nameInput.value = '';
      contentEl.value = '';

      const btnConfirm = document.getElementById('btn-memory-add-confirm')!;
      btnConfirm.click();

      // source 有值，不应被标记
      expect(sourceInput.getAttribute('aria-invalid')).toBeNull();
      // name 是首个空字段，应被标记
      expect(nameInput.getAttribute('aria-invalid')).toBe('true');
      const nameError = document.getElementById('memory-add-name-error')!;
      expect(nameError.textContent).toBe('请填写名称');
    });
  });
});

// ─── M5：详情操作按钮（删除/编辑/讨论） ────────────────────

describe('memoryPanelEvents M5 详情操作按钮', () => {
  beforeEach(() => {
    setupDOM();
  });

  describe('initDetailActionButtons - 删除按钮', () => {
    it('删除按钮（确认）应调用 getMemoryDeleteCallback', async () => {
      // 验证删除流程：确认对话框返回 true 时调用 delete 回调
      const { ctx, callbacks, host } = createMockCtx();
      host.showConfirmDialog.mockResolvedValue(true);
      initMemoryPanelListeners(ctx);

      const btnDelete = document.getElementById('btn-memory-delete')!;
      btnDelete.click();

      // 等待 async showConfirmDialog 完成
      await vi.waitFor(() => {
        expect(callbacks.delete).toHaveBeenCalledTimes(1);
      });
      expect(host.showConfirmDialog).toHaveBeenCalledWith(
        expect.objectContaining({ title: '删除记忆', danger: true }),
      );
    });

    it('删除按钮（取消）不应调用 delete 回调', async () => {
      // 验证确认对话框返回 false 时跳过删除
      const { ctx, callbacks, host } = createMockCtx();
      host.showConfirmDialog.mockResolvedValue(false);
      initMemoryPanelListeners(ctx);

      const btnDelete = document.getElementById('btn-memory-delete')!;
      btnDelete.click();

      await vi.waitFor(() => {
        expect(host.showConfirmDialog).toHaveBeenCalled();
      });
      expect(callbacks.delete).not.toHaveBeenCalled();
    });
  });

  describe('initDetailActionButtons - 编辑按钮', () => {
    it('编辑按钮应调用 enterEditMode', () => {
      // 验证编辑按钮：进入编辑模式
      const { ctx } = createMockCtx();
      initMemoryPanelListeners(ctx);

      const btnEdit = document.getElementById('btn-memory-edit')!;
      btnEdit.click();

      expect(ctx.enterEditMode).toHaveBeenCalledTimes(1);
    });

    it('编辑保存按钮应调用 saveEdit', () => {
      // 验证保存按钮：保存编辑内容
      const { ctx } = createMockCtx();
      initMemoryPanelListeners(ctx);

      const btnSave = document.getElementById('btn-memory-edit-save')!;
      btnSave.click();

      expect(ctx.saveEdit).toHaveBeenCalledTimes(1);
    });

    it('编辑取消按钮应调用 confirmExitEditMode（含未保存提示）', async () => {
      // F2：取消按钮改为调用 confirmExitEditMode（含未保存修改检查），而非直接 exitEditMode
      const { ctx } = createMockCtx();
      initMemoryPanelListeners(ctx);

      const btnCancel = document.getElementById('btn-memory-edit-cancel')!;
      btnCancel.click();
      // confirmExitEditMode 是异步的，需 await microtask
      await vi.waitFor(() => {
        expect(ctx.confirmExitEditMode).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('initDetailActionButtons - 讨论按钮', () => {
    it('讨论按钮（有 memoryName）应调用 discuss 回调', async () => {
      // 验证讨论按钮：从 detail-modal dataset 读取 memoryName 并传入回调
      // F2：讨论按钮会先经过 handleCloseRequest 守卫（非编辑模式直接放行）
      const { ctx, callbacks } = createMockCtx();
      initMemoryPanelListeners(ctx);

      const btnDiscuss = document.getElementById('btn-memory-discuss')!;
      btnDiscuss.click();
      // handleCloseRequest 是异步的，需 await microtask 让 Promise resolve
      await vi.waitFor(() => {
        expect(callbacks.discuss).toHaveBeenCalledWith('测试记忆');
      });
    });

    it('讨论按钮（memoryName 为空）不应调用 discuss 回调', async () => {
      // 验证 memoryName 空字符串降级：避免向对话面板传入空讨论提示
      const { ctx, callbacks } = createMockCtx();
      initMemoryPanelListeners(ctx);

      // 清空 dataset.memoryName
      const modal = document.getElementById('memory-detail-modal')!;
      delete modal.dataset.memoryName;

      const btnDiscuss = document.getElementById('btn-memory-discuss')!;
      btnDiscuss.click();
      // 等待异步 handleCloseRequest 完成
      await vi.waitFor(() => {
        expect(callbacks.discuss).not.toHaveBeenCalled();
      });
    });
  });
});

// ─── M6：更多菜单位置计算 + 回收站按钮 + 批量操作 ────────────

describe('memoryPanelEvents M6 更多菜单位置 + 回收站按钮 + 批量操作', () => {
  beforeEach(() => {
    setupDOM();
  });

  describe('initMoreMenu - 菜单弹出位置计算', () => {
    it('右侧空间充足时应靠左对齐按钮展开（left=btnRect.left）', () => {
      // 验证 wouldOverflowRight=false 分支：btnRect.left + 150 <= window.innerWidth
      // 实现用统一 left 坐标定位（position:fixed），靠左展开时 left=按钮 left
      const { ctx } = createMockCtx();
      initMemoryPanelListeners(ctx);

      const moreBtn = document.getElementById('btn-memory-more') as HTMLElement;
      // mock getBoundingClientRect：按钮靠左，右侧空间充足
      moreBtn.getBoundingClientRect = () => ({
        left: 100, top: 10, right: 130, bottom: 40, width: 30, height: 30, x: 100, y: 10, toJSON: () => ({}),
      });
      Object.defineProperty(window, 'innerWidth', { value: 1000, configurable: true });

      moreBtn.click();

      const moreMenu = document.getElementById('memory-more-menu')!;
      // 靠左对齐按钮：left = btnRect.left = 100px
      expect(moreMenu.style.left).toBe('100px');
    });

    it('右侧空间不足时应靠右对齐按钮向左展开（left=btnRect.right-menuMinWidth）', () => {
      // 验证 wouldOverflowRight=true 分支：btnRect.left + 150 > window.innerWidth
      // 实现用统一 left 坐标定位，靠右展开时 left=按钮 right - menuMinWidth（保证菜单右边缘对齐按钮右边缘）
      const { ctx } = createMockCtx();
      initMemoryPanelListeners(ctx);

      const moreBtn = document.getElementById('btn-memory-more') as HTMLElement;
      // mock：按钮靠右，右侧空间不足 150px
      moreBtn.getBoundingClientRect = () => ({
        left: 900, top: 10, right: 930, bottom: 40, width: 30, height: 30, x: 900, y: 10, toJSON: () => ({}),
      });
      Object.defineProperty(window, 'innerWidth', { value: 1000, configurable: true });

      moreBtn.click();

      const moreMenu = document.getElementById('memory-more-menu')!;
      // 靠右对齐按钮向左展开：left = btnRect.right - menuMinWidth = 930 - 150 = 780px
      expect(moreMenu.style.left).toBe('780px');
    });
  });

  describe('initMoreMenu - 菜单项委托', () => {
    it('点击 recycle-bin 菜单项应调用 moreMenuActionCallback("recycle-bin")', () => {
      // 验证 recycle-bin 分支：仅调用 moreMenuAction，不调用 toggleAnalysisPanel
      const { ctx, callbacks } = createMockCtx();
      initMemoryPanelListeners(ctx);

      const moreBtn = document.getElementById('btn-memory-more')!;
      moreBtn.click();

      const recycleBinItem = document.querySelector('.more-menu-item[data-action="recycle-bin"]') as HTMLElement;
      recycleBinItem.click();

      expect(callbacks.moreMenuAction).toHaveBeenCalledWith('recycle-bin');
      expect(ctx.toggleAnalysisPanel).not.toHaveBeenCalled();
    });

    it('点击未知 action 菜单项不应触发任何回调', () => {
      // 验证 action 不匹配任何分支时静默忽略
      const { ctx, callbacks } = createMockCtx();
      initMemoryPanelListeners(ctx);

      const moreBtn = document.getElementById('btn-memory-more')!;
      moreBtn.click();

      // 动态插入未知 action 菜单项
      const unknownItem = document.createElement('div');
      unknownItem.className = 'more-menu-item';
      unknownItem.setAttribute('data-action', 'unknown');
      document.getElementById('memory-more-menu')!.appendChild(unknownItem);
      unknownItem.click();

      expect(callbacks.moreMenuAction).not.toHaveBeenCalled();
      expect(ctx.toggleAnalysisPanel).not.toHaveBeenCalled();
    });

    it('点击非 HTMLElement 的菜单项节点不应触发回调', () => {
      // 验证 instanceof HTMLElement 检查：SVGElement 等非 HTMLElement 不触发
      const { ctx } = createMockCtx();
      initMemoryPanelListeners(ctx);

      const moreMenu = document.getElementById('memory-more-menu')!;
      // 插入一个 SVG 元素（属于 SVGElement，不是 HTMLElement）
      const svgItem = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      svgItem.setAttribute('class', 'more-menu-item');
      svgItem.setAttribute('data-action', 'insights');
      moreMenu.appendChild(svgItem);
      svgItem.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      // 由于 instanceof HTMLElement 检查失败，不应触发 toggleAnalysisPanel
      expect(ctx.toggleAnalysisPanel).not.toHaveBeenCalled();
    });
  });

  // UX-0713-9：回收站按钮在更多菜单中，recycle-bin action 的事件委托测试在 initMoreMenu 块中覆盖

  describe('initRecycleBinBatchActions', () => {
    it('点击全部恢复按钮应调用 recycleBinBatchActionCallback("restore-all")', () => {
      // 验证全部恢复按钮
      const { ctx, callbacks } = createMockCtx();
      initMemoryPanelListeners(ctx);

      const restoreAllBtn = document.getElementById('recycle-bin-restore-all')!;
      restoreAllBtn.click();

      expect(callbacks.recycleBinBatchAction).toHaveBeenCalledWith('restore-all');
    });

    it('点击全部清空按钮应调用 recycleBinBatchActionCallback("purge-all")', () => {
      // 验证全部清空按钮
      const { ctx, callbacks } = createMockCtx();
      initMemoryPanelListeners(ctx);

      const purgeAllBtn = document.getElementById('recycle-bin-purge-all')!;
      purgeAllBtn.click();

      expect(callbacks.recycleBinBatchAction).toHaveBeenCalledWith('purge-all');
    });
  });
});

// ─── M7：清理对话框完整覆盖 ────────────────────────────────

describe('memoryPanelEvents M7 清理对话框完整覆盖', () => {
  beforeEach(() => {
    setupDOM();
  });

  describe('initCleanupDialog - 清理按钮', () => {
    it('清理过期按钮（无待清理 ID）应显示 toast 提示', () => {
      // 验证 stale 类型无 ID 时的 toast 反馈
      const { ctx, callbacks, host } = createMockCtx();
      callbacks.cleanupRequest.mockImplementation((type: string) =>
        type === 'stale' ? [] : ['id-1', 'id-2'],
      );
      initMemoryPanelListeners(ctx);

      const cleanupStaleBtn = document.getElementById('health-cleanup-stale')!;
      cleanupStaleBtn.click();

      expect(host.showToast).toHaveBeenCalledWith('没有可清理的过期记忆', 'info');
      expect(ctx.showCleanupDialog).not.toHaveBeenCalled();
    });

    it('清理全部按钮（无待清理 ID）应显示 toast 提示', () => {
      // 验证 all 类型无 ID 时的 toast 反馈
      const { ctx, callbacks, host } = createMockCtx();
      callbacks.cleanupRequest.mockImplementation((type: string) =>
        type === 'all' ? [] : ['id-1', 'id-2'],
      );
      initMemoryPanelListeners(ctx);

      const cleanupAllBtn = document.getElementById('health-cleanup-all')!;
      cleanupAllBtn.click();

      expect(host.showToast).toHaveBeenCalledWith('没有可清理的问题记忆', 'info');
      expect(ctx.showCleanupDialog).not.toHaveBeenCalled();
    });
  });

  describe('initCleanupDialog - 确认按钮', () => {
    it('确认按钮（disabled 状态）不应执行清理', async () => {
      // 验证 cleanupConfirmBtn.disabled 检查：防止重复提交
      const { ctx, callbacks } = createMockCtx();
      initMemoryPanelListeners(ctx);

      const confirmBtn = document.getElementById('cleanup-confirm-confirm') as HTMLButtonElement;
      // 设置 disabled 状态（模拟异步清理进行中）
      confirmBtn.disabled = true;
      ctx.setPendingCleanupIds(['id-1']);

      confirmBtn.click();

      // 不应调用清理回调
      expect(callbacks.cleanupConfirm).not.toHaveBeenCalled();
    });

    it('确认按钮（cleanupConfirmCallback 抛错）应调用 reportError 兜底', async () => {
      // 验证 catch 分支：回调抛错时调用 reportError 记录日志
      const { ctx, callbacks } = createMockCtx();
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      callbacks.cleanupConfirm.mockRejectedValue(new Error('清理失败'));
      initMemoryPanelListeners(ctx);

      ctx.setPendingCleanupIds(['id-1', 'id-2']);
      const confirmBtn = document.getElementById('cleanup-confirm-confirm')!;
      confirmBtn.click();

      // 等待 async 回调完成
      await vi.waitFor(() => {
        expect(callbacks.cleanupConfirm).toHaveBeenCalledWith(['id-1', 'id-2']);
      });
      // reportError 会调用 console.error（兜底日志）
      expect(consoleErrorSpy).toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    });

    it('确认按钮（无 pendingCleanupIds）应隐藏对话框但不调用清理回调', async () => {
      // 验证 pendingCleanupIds.length === 0 时提前返回
      const { ctx, callbacks } = createMockCtx();
      initMemoryPanelListeners(ctx);

      ctx.setPendingCleanupIds([]);
      const confirmBtn = document.getElementById('cleanup-confirm-confirm')!;
      const cleanupDialog = document.getElementById('cleanup-confirm-dialog')!;
      cleanupDialog.classList.remove('hidden');

      confirmBtn.click();

      await vi.waitFor(() => {
        expect(cleanupDialog.classList.contains('hidden')).toBe(true);
      });
      expect(callbacks.cleanupConfirm).not.toHaveBeenCalled();
    });

    it('确认按钮完成后应恢复按钮可用状态', async () => {
      // 验证 finally 块：setButtonLoadingEl(false) 恢复按钮
      const { ctx, callbacks } = createMockCtx();
      initMemoryPanelListeners(ctx);

      ctx.setPendingCleanupIds(['id-1']);
      const confirmBtn = document.getElementById('cleanup-confirm-confirm') as HTMLButtonElement;
      confirmBtn.click();

      await vi.waitFor(() => {
        expect(callbacks.cleanupConfirm).toHaveBeenCalled();
      });
      // finally 块应恢复按钮为可用
      expect(confirmBtn.disabled).toBe(false);
    });
  });
});

// ─── M8：回收站列表降级 + 缺失 id ────────────────────────────

describe('memoryPanelEvents M8 回收站列表降级 + 缺失 id', () => {
  beforeEach(() => {
    setupDOM();
  });

  describe('initRecycleBinActions', () => {
    it('recycleBinList 缺失时应静默降级（不注册监听器）', () => {
      // 验证 if (!recycleBinList) return 分支
      const { ctx, callbacks } = createMockCtx();
      // 移除 recycle-bin-list 元素
      document.getElementById('recycle-bin-list')!.remove();

      expect(() => initMemoryPanelListeners(ctx)).not.toThrow();
      expect(callbacks.recycleBinAction).not.toHaveBeenCalled();
    });

    it('恢复按钮缺少 data-memory-id 时不应触发回调', () => {
      // 验证 if (id) 检查：空 id 时跳过
      const { ctx, callbacks } = createMockCtx();
      initMemoryPanelListeners(ctx);

      // 动态插入一个无 data-memory-id 的恢复按钮（与生产 createRecycleBinItem 一致使用 button）
      const restoreBtn = document.createElement('button');
      restoreBtn.type = 'button';
      restoreBtn.setAttribute('data-action', 'restore-memory');
      document.getElementById('recycle-bin-list')!.appendChild(restoreBtn);
      restoreBtn.click();

      expect(callbacks.recycleBinAction).not.toHaveBeenCalled();
    });

    it('彻底删除按钮缺少 data-memory-id 时不应触发回调', () => {
      // 验证 if (id) 检查：空 id 时跳过
      const { ctx, callbacks } = createMockCtx();
      initMemoryPanelListeners(ctx);

      const purgeBtn = document.createElement('button');
      purgeBtn.type = 'button';
      purgeBtn.setAttribute('data-action', 'purge-memory');
      document.getElementById('recycle-bin-list')!.appendChild(purgeBtn);
      purgeBtn.click();

      expect(callbacks.recycleBinAction).not.toHaveBeenCalled();
    });
  });
});
