/**
 * 记忆面板事件监听器初始化辅助（从 memoryPanelManager.ts 提取）
 *
 * 职责：
 *   将记忆面板所有事件监听器的注册逻辑集中到本模块，降低 memoryPanelManager.ts 体量。
 *   涵盖：列表点击委托、搜索防抖、source 筛选、添加/编辑/删除/讨论按钮、
 *   高级筛选栏（排序/时间范围）、更多菜单（统计洞察/健康度诊断）、
 *   分析面板关闭、视图切换（列表/图谱/时间线）、智能清理对话框。
 *
 * 提取原因：
 *   memoryPanelManager.ts 超标，initMemoryPanelListeners 单方法 375 行
 *   是全场最大单方法。事件监听器注册是相对独立的子功能，提取为接受 context 的纯函数
 *   模块，既降低体量又便于独立测试。
 *
 * 设计：
 *   - 纯函数模块，不持有状态，所有依赖通过 MemoryPanelEventContext 注入
 *   - 回调通过 getter 函数读取（运行时获取最新值，因为 onXxx 注册晚于 init 调用）
 *   - 状态（searchTimer 防抖定时器、pendingCleanupIds）通过 getter/setter 访问
 *   - 所有事件监听器纳入 EventTracker 统一管理，避免内存泄漏
 */

import { getOptionalElement, setButtonLoadingEl } from './domHelpers.js';
import { reportError } from './errorHelpers.js';
import { showFieldError, clearFieldErrors, attachRequiredBlurValidation } from './formValidation.js';
import type { EventTracker } from './eventTracker.js';
import type { ConfirmDialogOptions } from '../types.js';
// 类型仅导入：运行时不会产生循环依赖（type-only 在编译期擦除）
import type { MemoryPanelHost } from '../panels/memoryPanelManager.js';

// ─── 上下文接口（依赖注入容器） ────────────────────────────

/**
 * 添加记忆表单所有可校验字段的 id 数组
 *
 * 用于 clearFieldErrors 批量清空错误状态，避免在多处重复字面量数组。
 * 字段 id 与 HTML 中 input/textarea 元素 id 一一对应。
 */
const MEMORY_ADD_FIELD_IDS = [
  'memory-add-source',
  'memory-add-name',
  'memory-add-content',
] as const;

/**
 * memory-add 表单必填字段 id 与中文标签映射
 *
 * 用于 validateMemoryAddForm 提交校验和 attachRequiredBlurValidation blur 即时校验，
 * 避免两处重复定义（ADR-017 枝叶层 2 次提取原则）。
 */
const MEMORY_ADD_REQUIRED_FIELDS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'memory-add-source', label: '来源' },
  { id: 'memory-add-name', label: '名称' },
  { id: 'memory-add-content', label: '内容' },
];

/**
 * 记忆面板事件初始化所需的上下文
 *
 * 由 MemoryPanelManager 在 initMemoryPanelListeners() 中构建并传入。
 * 设计为接口而非直接传入 manager 实例，避免运行时循环依赖并便于独立测试。
 */
export interface MemoryPanelEventContext {
  // ─── DOM 元素（构造函数注入的可选元素，缺失时对应功能降级） ───
  /** 记忆列表容器（缺失时列表点击委托降级） */
  readonly memoryListEl: HTMLElement | null;
  /** 记忆搜索输入框（缺失时整个初始化静默返回） */
  readonly memorySearchEl: HTMLInputElement | null;
  /** 记忆 source 筛选下拉框（缺失时整个初始化静默返回） */
  readonly memoryFilterSourceEl: HTMLSelectElement | null;
  /** 记忆详情模态框（供讨论按钮读取 dataset.memoryName） */
  readonly memoryDetailModal: HTMLElement | null;

  // ─── 事件跟踪器（统一管理监听器注册与清理） ───
  readonly events: EventTracker;

  // ─── 宿主能力（跨模块关注点，由 UIManager 注入） ───
  readonly host: MemoryPanelHost;

  // ─── 状态访问器（searchTimer 防抖定时器，cleanup 时需清理） ───
  getSearchTimer(): ReturnType<typeof setTimeout> | null;
  setSearchTimer(timer: ReturnType<typeof setTimeout> | null): void;

  // ─── 清理对话框状态（待清理 ID 列表，确认/取消时读写） ───
  getPendingCleanupIds(): string[];
  setPendingCleanupIds(ids: string[]): void;

  // ─── 实例方法引用（事件触发时调用，需绑定 this） ───
  /** 获取添加记忆表单数据（校验通过返回对象，否则 null） */
  getAddMemoryFormData(): { source: string; name: string; content: string } | null;
  /** 进入编辑模式 */
  enterEditMode(): void;
  /** 退出编辑模式，恢复原始内容 */
  exitEditMode(): void;
  /** 保存编辑内容，通过回调通知宿主层 */
  saveEdit(): void;
  /** 切换分析面板（insights/health 互斥） */
  toggleAnalysisPanel(panel: 'insights' | 'health'): void;
  /** 隐藏分析面板并恢复主视图 */
  hideAnalysisPanel(): void;
  /** 切换视图模式（list/timeline/graph） */
  switchView(mode: 'list' | 'timeline' | 'graph'): void;
  /** 显示清理确认对话框 */
  showCleanupDialog(message: string, ids: string[]): void;

  // ─── 回调读取器（onXxx 注册晚于 init，故用 getter 读取最新值） ───
  getMemorySearchCallback(): ((query: string) => void) | null;
  getMemoryFilterCallback(): ((source: string) => void) | null;
  getMemoryClickCallback(): ((id: string) => void) | null;
  getMemoryDeleteCallback(): (() => void) | null;
  getMemoryAddCallback(): ((data: { source: string; name: string; content: string }) => void) | null;
  getMemoryDiscussCallback(): ((memoryName: string) => void) | null;
  getSortChangeCallback(): (() => void) | null;
  getTimeRangeChangeCallback(): (() => void) | null;
  getCleanupRequestCallback(): ((type: 'duplicates' | 'stale' | 'all') => string[]) | null;
  getCleanupConfirmCallback(): ((ids: string[]) => Promise<void>) | null;
  getViewSwitchCallback(): ((mode: 'list' | 'timeline' | 'graph') => void) | null;
  /** 回收站操作回调（恢复/彻底删除） */
  getRecycleBinActionCallback(): ((action: 'restore' | 'purge', id: string) => void) | null;
  /** 回收站批量操作回调（全部恢复/全部清空） */
  getRecycleBinBatchActionCallback(): ((action: 'restore-all' | 'purge-all') => void) | null;
  /** 更多菜单操作回调（insights/health/recycle-bin） */
  getMoreMenuActionCallback(): ((action: string) => void) | null;
}

// ─── 事件监听器初始化主函数 ────────────────────────────────

/**
 * 初始化记忆面板所有事件监听器
 *
 * 调用时机：MemoryPanelManager 构造后，由 UIManager 在初始化记忆面板时调用一次。
 * 所有监听器通过 ctx.events 注册，cleanup() 时统一清理。
 *
 * @param ctx 事件初始化上下文（依赖注入）
 */
export function initMemoryPanelListeners(ctx: MemoryPanelEventContext): void {
  // 记忆面板核心元素缺失时静默降级（不阻塞其他功能）
  if (!ctx.memorySearchEl || !ctx.memoryFilterSourceEl) return;

  // 提取局部常量，避免闭包内控制流分析断裂导致的非空断言
  const searchEl = ctx.memorySearchEl;
  const filterSourceEl = ctx.memoryFilterSourceEl;

  initListClickDelegation(ctx);
  initSearchAndFilter(ctx, searchEl, filterSourceEl);
  initAddMemoryForm(ctx);
  initDetailActionButtons(ctx);
  initAdvancedFilterBar(ctx);
  initMoreMenu(ctx);
  initAnalysisPanelClose(ctx);
  initViewSwitchButtons(ctx);
  initCleanupDialog(ctx);
  // 回收站列表事件委托（恢复/彻底删除按钮）
  initRecycleBinActions(ctx);
  // 回收站批量操作（全部恢复/全部清空）
  initRecycleBinBatchActions(ctx);
}

// ─── 1. 列表点击事件委托 ──────────────────────────────────

/**
 * 记忆列表事件委托：在 list 容器上注册统一 click 监听器，
 * 通过 data-action="view-memory" + data-memory-id 分发，
 * 替代动态列表项各自的 addEventListener，统一纳入 EventTracker 管理。
 */
function initListClickDelegation(ctx: MemoryPanelEventContext): void {
  if (!ctx.memoryListEl) return;
  ctx.events.addEventListener(ctx.memoryListEl, 'click', (e: Event) => {
    const target = e.target as HTMLElement;
    const item = target.closest<HTMLElement>('[data-action="view-memory"]');
    if (item) {
      const memoryId = item.dataset.memoryId ?? '';
      ctx.getMemoryClickCallback()?.(memoryId);
    }
  });
  // 键盘可访问性——Enter/Space 触发与 click 等效的查看动作
  // handler 签名用 Event（与 EventTracker 签名一致），内部断言为 KeyboardEvent 访问 key 属性
  ctx.events.addEventListener(ctx.memoryListEl, 'keydown', (e: Event) => {
    const ke = e as KeyboardEvent;
    if (ke.key !== 'Enter' && ke.key !== ' ') return;
    const target = ke.target as HTMLElement;
    const item = target.closest<HTMLElement>('[data-action="view-memory"]');
    if (item) {
      ke.preventDefault();
      const memoryId = item.dataset.memoryId ?? '';
      ctx.getMemoryClickCallback()?.(memoryId);
    }
  });
}

// ─── 2. 搜索框 + source 筛选 ──────────────────────────────

/**
 * 搜索框输入触发搜索（300ms 防抖），source 筛选变更立即触发。
 */
function initSearchAndFilter(
  ctx: MemoryPanelEventContext,
  searchEl: HTMLInputElement,
  filterSourceEl: HTMLSelectElement,
): void {
  // 搜索框：输入时触发搜索（带防抖）
  ctx.events.addEventListener(searchEl, 'input', () => {
    if (ctx.getSearchTimer()) clearTimeout(ctx.getSearchTimer()!);
    ctx.setSearchTimer(
      setTimeout(() => {
        ctx.getMemorySearchCallback()?.(searchEl.value.trim());
      }, 300),
    );
  });

  // source 筛选变更
  ctx.events.addEventListener(filterSourceEl, 'change', () => {
    ctx.getMemoryFilterCallback()?.(filterSourceEl.value);
  });
}

// ─── 3. 添加记忆表单 ──────────────────────────────────────

/**
 * 添加按钮 + 确认按钮 + Ctrl+Enter 快捷提交。
 * 表单校验失败时给出 toast 反馈（避免用户以为按钮失灵）。
 */
function initAddMemoryForm(ctx: MemoryPanelEventContext): void {
  // 添加按钮（可选）
  const btnAdd = getOptionalElement('btn-add-memory', 'button');
  if (btnAdd) {
    ctx.events.addEventListener(btnAdd, 'click', () => {
      // 打开弹窗前清空上次的错误状态（aria-invalid 残留 + 错误文本）
      clearFieldErrors([...MEMORY_ADD_FIELD_IDS]);
      ctx.host.showModal('memory-add-modal');
    });
  }

  // 添加确认按钮（可选）
  const btnAddConfirm = getOptionalElement('btn-memory-add-confirm', 'button');
  if (btnAddConfirm) {
    ctx.events.addEventListener(btnAddConfirm, 'click', () => {
      const data = ctx.getAddMemoryFormData();
      if (data) {
        clearFieldErrors([...MEMORY_ADD_FIELD_IDS]);
        ctx.getMemoryAddCallback()?.(data);
      } else {
        // 字段级校验反馈：标记缺失字段并聚焦首个错误字段
        validateMemoryAddForm();
      }
    });
  }

  // textarea 支持 Ctrl+Enter 快捷提交（与 confirm/prompt 弹窗的 Enter 确认行为对齐）
  // textarea 中 Enter 是换行，故用 Ctrl+Enter 触发提交
  const addContentEl = getOptionalElement('memory-add-content', 'textarea');
  if (addContentEl) {
    ctx.events.addEventListener(addContentEl, 'keydown', ((e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        const data = ctx.getAddMemoryFormData();
        if (data) {
          clearFieldErrors([...MEMORY_ADD_FIELD_IDS]);
          ctx.getMemoryAddCallback()?.(data);
        } else {
          // Ctrl+Enter 提交校验失败时同样给出字段级反馈
          validateMemoryAddForm();
        }
      }
    }) as EventListener);
  }

  // 必填字段 blur 即时校验（UX-0712-6）
  attachRequiredBlurValidation(MEMORY_ADD_REQUIRED_FIELDS, ctx.events);
}

/**
 * 校验添加记忆表单，显示字段级错误反馈
 *
 * 逐字段检查 source/name/content 是否为空，为空时通过公共 showFieldError
 * 设置 aria-invalid=true 并填充错误文本，最后聚焦首个错误字段。
 */
function validateMemoryAddForm(): void {
  let firstErrorField: HTMLElement | null = null;
  for (const { id, label } of MEMORY_ADD_REQUIRED_FIELDS) {
    const input = document.getElementById(id);
    if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
      if (!input.value.trim()) {
        firstErrorField ??= showFieldError(id, `请填写${label}`);
      }
    }
  }
  if (firstErrorField) {
    firstErrorField.focus();
  }
}

// ─── 4. 详情操作按钮（删除/编辑/讨论） ────────────────────

/**
 * 删除（带确认对话框）、编辑/保存/取消、讨论。
 */
function initDetailActionButtons(ctx: MemoryPanelEventContext): void {
  // 删除按钮（可选，带确认对话框，防止误删不可恢复数据）
  const btnDelete = getOptionalElement('btn-memory-delete', 'button');
  if (btnDelete) {
    ctx.events.addEventListener(btnDelete, 'click', async () => {
      // 确认删除：记忆是持久化数据，删除后不可恢复，需二次确认
      const confirmed = await ctx.host.showConfirmDialog({
        title: '删除记忆',
        message: '确定要删除这条记忆吗？此操作不可撤销。',
        confirmText: '删除',
        danger: true,
      } satisfies ConfirmDialogOptions);
      if (!confirmed) return;
      ctx.getMemoryDeleteCallback()?.();
    });
  }

  // 编辑按钮：进入编辑模式，将 content 区域变为可编辑
  const btnEdit = getOptionalElement('btn-memory-edit', 'button');
  if (btnEdit) {
    ctx.events.addEventListener(btnEdit, 'click', () => {
      ctx.enterEditMode();
    });
  }

  // 编辑保存按钮：保存编辑内容
  const btnEditSave = getOptionalElement('btn-memory-edit-save', 'button');
  if (btnEditSave) {
    ctx.events.addEventListener(btnEditSave, 'click', () => {
      ctx.saveEdit();
    });
  }

  // 编辑取消按钮：退出编辑模式，恢复原始内容
  const btnEditCancel = getOptionalElement('btn-memory-edit-cancel', 'button');
  if (btnEditCancel) {
    ctx.events.addEventListener(btnEditCancel, 'click', () => {
      ctx.exitEditMode();
    });
  }

  // 讨论按钮：关闭详情弹窗，切换到对话面板预填讨论提示
  const btnDiscuss = getOptionalElement('btn-memory-discuss', 'button');
  if (btnDiscuss) {
    ctx.events.addEventListener(btnDiscuss, 'click', () => {
      const memoryName = ctx.memoryDetailModal?.dataset.memoryName ?? '';
      if (memoryName) {
        ctx.getMemoryDiscussCallback()?.(memoryName);
      }
    });
  }
}

// ─── 5. 高级筛选栏（排序/时间范围，合并原重复注册） ────────

/**
 * 高级筛选按钮切换 + 排序/时间范围下拉变更。
 *
 * 合并说明：原 initMemoryPanelListeners 在"高级搜索栏"和"排序方式变更"两处
 * 各为 #memory-sort-order / #memory-time-range 注册了一次 change 监听器，
 * 导致回调被触发两次。此处合并为单次注册。
 */
function initAdvancedFilterBar(ctx: MemoryPanelEventContext): void {
  // 高级筛选按钮（独立图标按钮，切换筛选栏显示）
  const advFilterBtn = document.getElementById('btn-advanced-filter');
  const advSearchBar = document.getElementById('advanced-search-bar');
  if (advFilterBtn && advSearchBar) {
    ctx.events.addEventListener(advFilterBtn, 'click', () => {
      advSearchBar.classList.toggle('hidden');
      advFilterBtn.classList.toggle('active', !advSearchBar.classList.contains('hidden'));
    });
  }

  // 排序方式变更
  const sortEl = document.getElementById('memory-sort-order');
  if (sortEl instanceof HTMLSelectElement) {
    ctx.events.addEventListener(sortEl, 'change', () => {
      ctx.getSortChangeCallback()?.();
    });
  }

  // 时间范围变更
  const timeRangeEl = document.getElementById('memory-time-range');
  if (timeRangeEl instanceof HTMLSelectElement) {
    ctx.events.addEventListener(timeRangeEl, 'change', () => {
      ctx.getTimeRangeChangeCallback()?.();
    });
  }
}

// ─── 6. 更多菜单（统计洞察/健康度诊断） ───────────────────

/**
 * 更多菜单按钮 + 点击外部关闭 + 菜单项事件委托。
 * 菜单项仅保留统计洞察和健康度诊断两个动作。
 */
function initMoreMenu(ctx: MemoryPanelEventContext): void {
  const moreBtn = document.getElementById('btn-memory-more');
  const moreMenu = document.getElementById('memory-more-menu');

  /** 切换更多菜单的显示/隐藏 */
  const toggleMoreMenu = (show?: boolean): void => {
    if (!moreMenu || !moreBtn) return;
    const shouldShow = show ?? moreMenu.classList.contains('hidden');
    if (shouldShow) {
      // 动态计算弹出框位置，默认靠左展开（符合用户期望），
      // 若右侧空间不足则降级为靠右展开，避免超出窗口被 panel overflow:hidden 裁剪
      const btnRect = moreBtn.getBoundingClientRect();
      const menuMinWidth = 150; // 与 CSS .more-menu min-width 一致
      const wouldOverflowRight = btnRect.left + menuMinWidth > window.innerWidth;
      if (wouldOverflowRight) {
        // 右侧空间不足，靠右展开（向左）
        moreMenu.style.left = 'auto';
        moreMenu.style.right = '0';
      } else {
        // 右侧空间充足，靠左展开（向右）
        moreMenu.style.left = '0';
        moreMenu.style.right = 'auto';
      }
    }
    moreMenu.classList.toggle('hidden', !shouldShow);
    moreBtn.setAttribute('aria-expanded', String(shouldShow));
  };

  if (moreBtn) {
    ctx.events.addEventListener(moreBtn, 'click', (e) => {
      (e as Event).stopPropagation();
      toggleMoreMenu();
    });
  }

  // 点击外部关闭更多菜单（注册到 document）
  ctx.events.addEventListener(document, 'click', (e) => {
    if (moreMenu && !moreMenu.classList.contains('hidden')) {
      const target = (e as Event).target as HTMLElement;
      if (!moreMenu.contains(target) && target !== moreBtn) {
        toggleMoreMenu(false);
      }
    }
  });

  // 更多菜单项事件委托（insights/health/recycle-bin）
  if (moreMenu) {
    ctx.events.addEventListener(moreMenu, 'click', async (e) => {
      const target = (e as Event).target as HTMLElement;
      const item = target.closest('.more-menu-item');
      if (!(item instanceof HTMLElement)) return;
      const action = item.getAttribute('data-action');
      toggleMoreMenu(false);

      if (action === 'insights') {
        ctx.toggleAnalysisPanel('insights');
        ctx.getMoreMenuActionCallback()?.(action);
      } else if (action === 'health') {
        ctx.toggleAnalysisPanel('health');
        ctx.getMoreMenuActionCallback()?.(action);
      } else if (action === 'recycle-bin') {
        ctx.getMoreMenuActionCallback()?.(action);
      }
    });
  }
}

// ─── 7.5 回收站按钮已迁入更多菜单（UX-0713-9），事件委托见 initMoreMenu ───

// ─── 8. 分析面板关闭按钮 ─────────────────────────────

/**
 * 统计洞察/健康度分析面板的关闭按钮。
 */
function initAnalysisPanelClose(ctx: MemoryPanelEventContext): void {
  const closeInsightsBtn = document.getElementById('btn-close-insights');
  if (closeInsightsBtn) {
    ctx.events.addEventListener(closeInsightsBtn, 'click', () => {
      ctx.hideAnalysisPanel();
    });
  }
  const closeHealthBtn = document.getElementById('btn-close-health');
  if (closeHealthBtn) {
    ctx.events.addEventListener(closeHealthBtn, 'click', () => {
      ctx.hideAnalysisPanel();
    });
  }
}

// ─── 8. 视图切换按钮（列表 ↔ 图谱 ↔ 时间线） ─────────────

/**
 * 三视图 segmented control 切换：点击当前激活视图时降级回列表，
 * 点击其他视图时切换到该视图。同步更新按钮 active 状态。
 */
function initViewSwitchButtons(ctx: MemoryPanelEventContext): void {
  const listBtn = document.getElementById('btn-list-view');
  const graphBtn = document.getElementById('btn-graph-view');

  /** 更新视图切换按钮的 active 状态 */
  const updateViewSwitchBtns = (view: 'list' | 'timeline' | 'graph'): void => {
    if (listBtn) {
      listBtn.classList.toggle('active', view === 'list');
      listBtn.setAttribute('aria-selected', String(view === 'list'));
    }
    const timelineBtn = document.getElementById('btn-timeline-view');
    if (timelineBtn) {
      timelineBtn.classList.toggle('active', view === 'timeline');
      timelineBtn.setAttribute('aria-selected', String(view === 'timeline'));
    }
    if (graphBtn) {
      graphBtn.classList.toggle('active', view === 'graph');
      graphBtn.setAttribute('aria-selected', String(view === 'graph'));
    }
  };

  // 默认列表视图 active
  updateViewSwitchBtns('list');

  if (listBtn) {
    ctx.events.addEventListener(listBtn, 'click', () => {
      updateViewSwitchBtns('list');
      ctx.switchView('list');
      ctx.getViewSwitchCallback()?.('list');
    });
  }

  if (graphBtn) {
    ctx.events.addEventListener(graphBtn, 'click', () => {
      const graphContainer = document.getElementById('memory-graph-container');
      // B2: 统一用 .hidden 类判断可见性（替代 style.display 内联样式）
      const isGraphView = graphContainer && !graphContainer.classList.contains('hidden');

      if (isGraphView) {
        updateViewSwitchBtns('list');
        ctx.switchView('list');
        ctx.getViewSwitchCallback()?.('list');
      } else {
        updateViewSwitchBtns('graph');
        ctx.switchView('graph');
        ctx.getViewSwitchCallback()?.('graph');
      }
    });
  }

  // 时间线视图按钮
  const timelineBtn = document.getElementById('btn-timeline-view');
  if (timelineBtn) {
    ctx.events.addEventListener(timelineBtn, 'click', () => {
      const timelineContainer = document.getElementById('memory-timeline-container');
      // B2: 统一用 .hidden 类判断可见性（替代 style.display 内联样式）
      const isTimelineView = timelineContainer && !timelineContainer.classList.contains('hidden');

      if (isTimelineView) {
        updateViewSwitchBtns('list');
        ctx.switchView('list');
        ctx.getViewSwitchCallback()?.('list');
      } else {
        updateViewSwitchBtns('timeline');
        ctx.switchView('timeline');
        ctx.getViewSwitchCallback()?.('timeline');
      }
    });
  }
}

// ─── 9. 智能清理对话框（Phase 3） ─────────────────────────

/**
 * 三类清理按钮（重复/过期/全部）+ 取消/确认对话框。
 * 清理前通过 ctx.getCleanupRequestCallback() 获取待清理 ID 列表，
 * 确认后通过 ctx.getCleanupConfirmCallback() 执行批量删除。
 */
function initCleanupDialog(ctx: MemoryPanelEventContext): void {
  const cleanupDupBtn = document.getElementById('health-cleanup-duplicates');
  const cleanupStaleBtn = document.getElementById('health-cleanup-stale');
  const cleanupAllBtn = document.getElementById('health-cleanup-all');
  const cleanupDialog = document.getElementById('cleanup-confirm-dialog');
  const cleanupCancelBtn = document.getElementById('cleanup-confirm-cancel');
  const cleanupConfirmBtn = document.getElementById('cleanup-confirm-confirm');

  if (cleanupDupBtn) {
    ctx.events.addEventListener(cleanupDupBtn, 'click', () => {
      const ids = ctx.getCleanupRequestCallback()?.('duplicates') ?? [];
      if (ids.length === 0) {
        ctx.host.showToast('没有可清理的重复记忆', 'info');
        return;
      }
      ctx.showCleanupDialog(`确定要清理 ${ids.length} 条重复记忆吗？每组将保留分数最高的一条。`, ids);
    });
  }

  if (cleanupStaleBtn) {
    ctx.events.addEventListener(cleanupStaleBtn, 'click', () => {
      const ids = ctx.getCleanupRequestCallback()?.('stale') ?? [];
      if (ids.length === 0) {
        ctx.host.showToast('没有可清理的过期记忆', 'info');
        return;
      }
      ctx.showCleanupDialog(`确定要清理 ${ids.length} 条过期记忆吗？这些记忆长期未访问或得分较低。`, ids);
    });
  }

  if (cleanupAllBtn) {
    ctx.events.addEventListener(cleanupAllBtn, 'click', () => {
      const ids = ctx.getCleanupRequestCallback()?.('all') ?? [];
      if (ids.length === 0) {
        ctx.host.showToast('没有可清理的问题记忆', 'info');
        return;
      }
      ctx.showCleanupDialog(`确定要清理 ${ids.length} 条问题记忆吗？`, ids);
    });
  }

  if (cleanupCancelBtn && cleanupDialog) {
    ctx.events.addEventListener(cleanupCancelBtn, 'click', () => {
      cleanupDialog.classList.add('hidden');
      ctx.setPendingCleanupIds([]);
    });
  }

  if (cleanupConfirmBtn && cleanupDialog) {
    ctx.events.addEventListener(cleanupConfirmBtn, 'click', async () => {
      // 异步执行清理期间禁用按钮，防止重复提交
      if (!(cleanupConfirmBtn instanceof HTMLButtonElement)) return;
      if (cleanupConfirmBtn.disabled) return;
      setButtonLoadingEl(cleanupConfirmBtn, true, '清理中…');
      try {
        cleanupDialog.classList.add('hidden');
        if (ctx.getPendingCleanupIds().length === 0) return;
        const ids = [...ctx.getPendingCleanupIds()];
        ctx.setPendingCleanupIds([]);
        try {
          await ctx.getCleanupConfirmCallback()?.(ids);
        } catch (err) {
          // cleanupConfirmCallback 由 Controller 实现，Controller 内部会报告错误和显示 toast
          // 补充 warn 日志兜底，防止回调未处理时异常被完全吞没
          reportError('MemoryPanel cleanupConfirmCallback', err);
        }
      } finally {
        setButtonLoadingEl(cleanupConfirmBtn, false);
      }
    });
  }
}

// ─── 11. 回收站列表事件委托 ─────────────────────────

/**
 * 回收站列表事件委托：恢复 / 彻底删除
 *
 * 通过 data-action="restore-memory" / "purge-memory" + data-memory-id 分发，
 * 与列表点击委托模式一致。回调由 Controller 实现，包含确认对话框 + IPC 调用。
 */
function initRecycleBinActions(ctx: MemoryPanelEventContext): void {
  const recycleBinList = document.getElementById('recycle-bin-list');
  if (!recycleBinList) return;

  ctx.events.addEventListener(recycleBinList, 'click', (e: Event) => {
    const target = e.target as HTMLElement;
    // 优先匹配恢复按钮
    const restoreBtn = target.closest<HTMLElement>('[data-action="restore-memory"]');
    if (restoreBtn) {
      const id = restoreBtn.dataset.memoryId ?? '';
      if (id) {
        ctx.getRecycleBinActionCallback()?.('restore', id);
      }
      return;
    }
    // 其次匹配彻底删除按钮
    const purgeBtn = target.closest<HTMLElement>('[data-action="purge-memory"]');
    if (purgeBtn) {
      const id = purgeBtn.dataset.memoryId ?? '';
      if (id) {
        ctx.getRecycleBinActionCallback()?.('purge', id);
      }
      return;
    }
  });
}

/**
 * 回收站批量操作事件：全部恢复 / 全部清空
 *
 * 通过 ID 选择器直接绑定按钮，操作前需二次确认（由 Controller 回调实现）。
 */
function initRecycleBinBatchActions(ctx: MemoryPanelEventContext): void {
  const restoreAllBtn = document.getElementById('recycle-bin-restore-all');
  const purgeAllBtn = document.getElementById('recycle-bin-purge-all');

  if (restoreAllBtn) {
    ctx.events.addEventListener(restoreAllBtn, 'click', () => {
      ctx.getRecycleBinBatchActionCallback()?.('restore-all');
    });
  }
  if (purgeAllBtn) {
    ctx.events.addEventListener(purgeAllBtn, 'click', () => {
      ctx.getRecycleBinBatchActionCallback()?.('purge-all');
    });
  }
}
