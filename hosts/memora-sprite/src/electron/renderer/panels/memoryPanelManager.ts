/**
 * 记忆面板管理器 — 记忆面板 UI 逻辑独立子模块
 *
 * 职责：
 * - 管理记忆面板所有 DOM 元素引用
 * - 初始化记忆面板事件监听（搜索/筛选/添加/删除）
 * - 渲染记忆列表（分页 + 空状态引导）
 * - 显示记忆详情弹窗
 * - 管理添加记忆表单
 *
 * 设计原则：
 * - 遵循 SettingsPanelManager 的组合模式，UIManager 持有实例并委托
 * - 自管理事件监听器，通过注入的 EventTracker 统一管理
 * - 跨模块关注点（showModal / showConfirmDialog）通过 host 回调注入
 *
 * 提取自 ui.ts（P2-008：ui.ts 体积过大拆分），减少约 290 行。
 */

import { getOptionalElement, clearElement, formatTimeAgo } from '../helpers/domHelpers.js';
import type { EventTracker } from '../helpers/eventTracker.js';
import type { MemoryListItem, MemoryDetail, ConfirmDialogOptions, ToastType } from '../types.js';
import { RelationGraphRenderer } from '../components/relationGraph.js';
import type { RelationGraphData } from '../components/relationGraph.js';

// ─── Host 接口（跨模块关注点注入） ────────────────────────

/** 记忆面板管理器需要的宿主能力（跨模块关注点，由 UIManager 注入） */
export interface MemoryPanelHost {
  /** 显示模态框 */
  showModal(modalId: string): void;
  /** 隐藏模态框 */
  hideModal(modalId: string): void;
  /** 显示确认对话框（FD-07 取消按钮） */
  showConfirmDialog(options: ConfirmDialogOptions): Promise<boolean>;
  /** 显示 toast 通知（添加记忆表单校验失败时反馈） */
  showToast(message: string, type?: ToastType, duration?: number): void;
}

/**
 * 将 source 字符串映射到颜色类名
 *
 * 颜色映射规则（对齐记忆系统 source 分类）：
 * - profile → green（用户画像，绿色代表身份）
 * - insight → blue（洞察，蓝色代表智慧）
 * - guardrail → pink（护栏，粉色代表警示）
 * - skill → yellow（技能，黄色代表能力）
 * - rule → purple（规则，紫色代表约束）
 * - persona → cyan（角色，青色代表个性）
 * - session → orange（会话，橙色代表活跃）
 * - 其他 → default（灰色）
 *
 * @param source 记忆来源字符串（开放字符串，如 'profile'、'insight'、'rule'）
 * @returns 对应的 CSS 颜色类名（如 'profile' / 'default'）
 */
export function getSourceColorClass(source: string): string {
  const normalized = source.toLowerCase().trim();
  const knownSources = ['profile', 'insight', 'guardrail', 'skill', 'rule', 'persona', 'session'];
  return knownSources.includes(normalized) ? normalized : 'default';
}

// ─── 记忆面板管理器类 ─────────────────────────────────────

export class MemoryPanelManager {
  // ─── 静态常量 ───────────────────────────────────────────
  /**
   * P3-FLOW-13 记忆列表分页每页大小
   * 50 条平衡了首屏渲染性能和用户浏览体验，超过时显示"加载更多"按钮
   */
  static readonly MEMORY_PAGE_SIZE = 50;

  // ─── 内部状态 ────────────────────────────────────────────
  /** P3-FLOW-13 完整记忆列表缓存（供分页使用） */
  private allMemories: MemoryListItem[] = [];
  /** P3-FLOW-13 当前记忆列表页码（从 1 开始） */
  private memoryPage = 1;
  /** 当前搜索关键词（Phase 2：搜索结果高亮，空字符串表示不高亮） */
  private currentSearchQuery = '';
  /** 记忆搜索防抖定时器（cleanup 时需清理，避免回调在 DOM 销毁后触发） */
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  // ─── 图谱视图状态（ADR-014：拓扑可视化） ──────────────────
  /** 当前视图模式：list（列表）、timeline（时间线）、graph（图谱），默认列表 */
  private viewMode: 'list' | 'timeline' | 'graph' = 'list';
  /** 图谱渲染器实例（Canvas 2D 力导向图） */
  private graphRenderer: RelationGraphRenderer | null = null;
  /** 图谱数据缓存（切换回图谱视图时避免重复请求 IPC） */
  private graphDataCache: RelationGraphData | null = null;
  /** 缓存的高亮节点 ID（渲染器初始化前设置的状态需要在初始化后恢复） */
  private cachedHighlightedNodeIds: string[] | null = null;
  /** 缓存的选中节点 ID（渲染器初始化前设置的状态需要在初始化后恢复） */
  private cachedSelectedNodeId: string | null = null;

  // ─── 回调 ────────────────────────────────────────────────
  private memorySearchCallback: ((query: string) => void) | null = null;
  private memoryFilterCallback: ((source: string) => void) | null = null;
  private memoryClickCallback: ((id: string) => void) | null = null;
  private memoryDeleteCallback: (() => void) | null = null;
  private memoryAddCallback:
    | ((data: { source: string; name: string; content: string }) => void)
    | null = null;
  /** P2-FLOW-08 记忆编辑回调：携带记忆 ID 和新内容 */
  private memoryEditCallback: ((id: string, content: string) => void) | null = null;
  /** FD-ADD-MEMORY-DISCUSS 记忆讨论回调：携带记忆名称，切换到对话面板预填讨论提示 */
  private memoryDiscussCallback: ((memoryName: string) => void) | null = null;
  /** P2-FLOW-08 编辑模式状态：true 时显示保存/取消按钮，隐藏编辑/删除按钮 */
  private isEditing = false;

  // ─── 工具栏/面板交互回调 ────────────────────────────────
  /** 更多菜单项点击回调（advanced-search/insights/health） */
  private moreMenuActionCallback: ((action: string) => void) | null = null;
  /** 排序方式变更回调 */
  private sortChangeCallback: (() => void) | null = null;
  /** 时间范围变更回调 */
  private timeRangeChangeCallback: (() => void) | null = null;
  /** 清理按钮点击回调（duplicates/stale/all），返回待清理ID列表 */
  private cleanupRequestCallback: ((type: 'duplicates' | 'stale' | 'all') => string[]) | null = null;
  /** 清理确认回调（执行批量删除） */
  private cleanupConfirmCallback: ((ids: string[]) => Promise<void>) | null = null;
  /** 视图切换按钮状态更新回调（通知Controller同步按钮active状态） */
  private viewSwitchCallback: ((mode: 'list' | 'timeline' | 'graph') => void) | null = null;

  // ─── 清理对话框状态 ────────────────────────────────────
  /** 待清理的记忆 ID 列表（确认对话框中使用） */
  private pendingCleanupIds: string[] = [];

  constructor(
    private host: MemoryPanelHost,
    /** 记忆列表容器元素（可选，缺失时渲染降级） */
    private memoryListEl: HTMLElement | null,
    /** 记忆搜索输入框（可选，缺失时搜索功能降级） */
    private memorySearchEl: HTMLInputElement | null,
    /** 记忆 source 筛选下拉框（可选，缺失时筛选功能降级） */
    private memoryFilterSourceEl: HTMLSelectElement | null,
    /** 记忆详情模态框容器（可选，缺失时详情功能降级） */
    private memoryDetailModal: HTMLElement | null,
    /** 事件监听器跟踪器（统一管理事件监听器的注册与清理，避免内存泄漏） */
    private events: EventTracker,
  ) {}

  // ─── 资源清理 ──────────────────────────────────────────

  /** 清理防抖定时器和事件监听器（页面卸载时调用，避免回调在 DOM 销毁后触发） */
  cleanup(): void {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    // 销毁图谱渲染器（释放 Canvas 和 rAF）
    if (this.graphRenderer) {
      this.graphRenderer.destroy();
      this.graphRenderer = null;
    }
    this.events.cleanup();
  }

  // ─── 事件监听器初始化 ───────────────────────────────────

  /** 初始化记忆面板事件监听 */
  initMemoryPanelListeners(): void {
    // 记忆面板元素缺失时静默降级（不阻塞其他功能）
    if (!this.memorySearchEl || !this.memoryFilterSourceEl) return;

    // 提取局部常量，避免闭包内控制流分析断裂导致的非空断言
    const searchEl = this.memorySearchEl;
    const filterSourceEl = this.memoryFilterSourceEl;

    // QC-22 记忆列表事件委托：在 list 容器上注册统一 click 监听器，
    // 通过 data-action="view-memory" + data-memory-id 分发，
    // 替代动态列表项各自的 addEventListener，统一纳入 EventTracker 管理
    if (this.memoryListEl) {
      this.events.addEventListener(this.memoryListEl, 'click', (e: Event) => {
        const target = e.target as HTMLElement;
        const item = target.closest<HTMLElement>('[data-action="view-memory"]');
        if (item) {
          const memoryId = item.dataset.memoryId ?? '';
          this.memoryClickCallback?.(memoryId);
        }
      });
    }

    // 搜索框：输入时触发搜索（带防抖）
    this.events.addEventListener(searchEl, 'input', () => {
      if (this.searchTimer) clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => {
        this.memorySearchCallback?.(searchEl.value.trim());
      }, 300);
    });

    // source 筛选变更
    this.events.addEventListener(filterSourceEl, 'change', () => {
      this.memoryFilterCallback?.(filterSourceEl.value);
    });

    // 排序下拉（高级搜索栏 #memory-sort-order）
    const sortOrder = document.getElementById('memory-sort-order');
    if (sortOrder) {
      this.events.addEventListener(sortOrder, 'change', () => {
        this.sortChangeCallback?.();
      });
    }

    // 时间范围下拉（高级搜索栏 #memory-time-range）
    const timeRange = document.getElementById('memory-time-range');
    if (timeRange) {
      this.events.addEventListener(timeRange, 'change', () => {
        this.timeRangeChangeCallback?.();
      });
    }

    // 添加按钮（可选）
    const btnAdd = getOptionalElement('btn-add-memory', 'button');
    if (btnAdd) {
      this.events.addEventListener(btnAdd, 'click', () => {
        this.host.showModal('memory-add-modal');
      });
    }

    // 添加确认按钮（可选）
    const btnAddConfirm = getOptionalElement('btn-memory-add-confirm', 'button');
    if (btnAddConfirm) {
      this.events.addEventListener(btnAddConfirm, 'click', () => {
        const data = this.getAddMemoryFormData();
        if (data) {
          this.memoryAddCallback?.(data);
        } else {
          // 表单校验失败时给出反馈（之前静默跳过，用户以为按钮失灵）
          this.host.showToast('请填写完整：来源、名称和内容', 'warning');
        }
      });
    }

    // FD-ADD-CTRL-ENTER：textarea 支持 Ctrl+Enter 快捷提交（与 confirm/prompt 弹窗的 Enter 确认行为对齐）
    // textarea 中 Enter 是换行，故用 Ctrl+Enter 触发提交
    const addContentEl = getOptionalElement('memory-add-content', 'textarea');
    if (addContentEl) {
      this.events.addEventListener(addContentEl, 'keydown', ((e: KeyboardEvent) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault();
          const data = this.getAddMemoryFormData();
          if (data) {
            this.memoryAddCallback?.(data);
          } else {
            // Ctrl+Enter 提交校验失败时同样给出反馈
            this.host.showToast('请填写完整：来源、名称和内容', 'warning');
          }
        }
      }) as EventListener);
    }

    // 删除按钮（可选，带确认对话框，防止误删不可恢复数据）
    const btnDelete = getOptionalElement('btn-memory-delete', 'button');
    if (btnDelete) {
      this.events.addEventListener(btnDelete, 'click', async () => {
        // 确认删除：记忆是持久化数据，删除后不可恢复，需二次确认
        const confirmed = await this.host.showConfirmDialog({
          title: '删除记忆',
          message: '确定要删除这条记忆吗？此操作不可撤销。',
          confirmText: '删除',
          danger: true,
        });
        if (!confirmed) return;
        this.memoryDeleteCallback?.();
      });
    }

    // P2-FLOW-08 编辑按钮：进入编辑模式，将 content 区域变为可编辑
    const btnEdit = getOptionalElement('btn-memory-edit', 'button');
    if (btnEdit) {
      this.events.addEventListener(btnEdit, 'click', () => {
        this.enterEditMode();
      });
    }

    // P2-FLOW-08 编辑保存按钮：保存编辑内容
    const btnEditSave = getOptionalElement('btn-memory-edit-save', 'button');
    if (btnEditSave) {
      this.events.addEventListener(btnEditSave, 'click', () => {
        this.saveEdit();
      });
    }

    // P2-FLOW-08 编辑取消按钮：退出编辑模式，恢复原始内容
    const btnEditCancel = getOptionalElement('btn-memory-edit-cancel', 'button');
    if (btnEditCancel) {
      this.events.addEventListener(btnEditCancel, 'click', () => {
        this.exitEditMode();
      });
    }

    // FD-ADD-MEMORY-DISCUSS 讨论按钮：关闭详情弹窗，切换到对话面板预填讨论提示
    const btnDiscuss = getOptionalElement('btn-memory-discuss', 'button');
    if (btnDiscuss) {
      this.events.addEventListener(btnDiscuss, 'click', () => {
        const memoryName = this.memoryDetailModal?.dataset.memoryName ?? '';
        if (memoryName) {
          this.memoryDiscussCallback?.(memoryName);
        }
      });
    }

    // ─── FD-03 叙事卡片点击：展开/折叠详情区 ────────────
    const narrativeCard = document.getElementById('sprite-narrative');
    const detailsContainer = document.getElementById('dashboard-details');
    const toggleArrow = document.getElementById('narrative-toggle');
    if (narrativeCard && detailsContainer && toggleArrow) {
      // 默认折叠详情区
      detailsContainer.classList.add('collapsed');
      this.events.addEventListener(narrativeCard, 'click', () => {
        const isCollapsed = detailsContainer.classList.toggle('collapsed');
        toggleArrow.classList.toggle('expanded', !isCollapsed);
      });
    }

    // ─── 更多菜单（高级搜索/洞察/健康度） ──────────────
    const moreBtn = document.getElementById('btn-memory-more');
    const moreMenu = document.getElementById('memory-more-menu');
    const advSearchBar = document.getElementById('advanced-search-bar');
    const insightsBar = document.getElementById('memory-insights-bar');
    const healthBar = document.getElementById('memory-health-bar');

    /** 切换更多菜单的显示/隐藏 */
    const toggleMoreMenu = (show?: boolean): void => {
      if (!moreMenu || !moreBtn) return;
      const shouldShow = show ?? moreMenu.classList.contains('hidden');
      moreMenu.classList.toggle('hidden', !shouldShow);
      moreBtn.setAttribute('aria-expanded', String(shouldShow));
    };

    if (moreBtn) {
      this.events.addEventListener(moreBtn, 'click', (e) => {
        (e as Event).stopPropagation();
        toggleMoreMenu();
      });
    }

    // 点击外部关闭更多菜单（注册到 document）
    this.events.addEventListener(document, 'click', (e) => {
      if (moreMenu && !moreMenu.classList.contains('hidden')) {
        const target = (e as Event).target as HTMLElement;
        if (!moreMenu.contains(target) && target !== moreBtn) {
          toggleMoreMenu(false);
        }
      }
    });

    // 更多菜单项事件委托
    if (moreMenu) {
      this.events.addEventListener(moreMenu, 'click', async (e) => {
        const item = ((e as Event).target as HTMLElement).closest('.more-menu-item') as HTMLElement | null;
        if (!item) return;
        const action = item.getAttribute('data-action');
        toggleMoreMenu(false);

        if (action === 'advanced-search') {
          if (advSearchBar) {
            advSearchBar.classList.toggle('hidden');
          }
        } else if (action === 'insights') {
          if (insightsBar) {
            const isHidden = insightsBar.classList.contains('hidden');
            insightsBar.classList.toggle('hidden', !isHidden);
            if (isHidden) {
              this.moreMenuActionCallback?.('insights');
            }
          }
        } else if (action === 'health') {
          if (healthBar) {
            const isHidden = healthBar.classList.contains('hidden');
            healthBar.classList.toggle('hidden', !isHidden);
            if (isHidden) {
              this.moreMenuActionCallback?.('health');
            }
          }
        }
      });
    }

    // ─── 视图切换按钮（列表 ↔ 图谱 segmented control） ──
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

    // 默认列表视图active
    updateViewSwitchBtns('list');

    if (listBtn) {
      this.events.addEventListener(listBtn, 'click', () => {
        updateViewSwitchBtns('list');
        this.switchView('list');
        this.viewSwitchCallback?.('list');
      });
    }

    if (graphBtn) {
      this.events.addEventListener(graphBtn, 'click', () => {
        const graphContainer = document.getElementById('memory-graph-container');
        const isGraphView = graphContainer && graphContainer.style.display !== 'none';

        if (isGraphView) {
          updateViewSwitchBtns('list');
          this.switchView('list');
          this.viewSwitchCallback?.('list');
        } else {
          updateViewSwitchBtns('graph');
          this.switchView('graph');
          this.viewSwitchCallback?.('graph');
        }
      });
    }

    // 时间线视图按钮
    const timelineBtn = document.getElementById('btn-timeline-view');
    if (timelineBtn) {
      this.events.addEventListener(timelineBtn, 'click', () => {
        const timelineContainer = document.getElementById('memory-timeline-container');
        const isTimelineView = timelineContainer && timelineContainer.style.display !== 'none';

        if (isTimelineView) {
          updateViewSwitchBtns('list');
          this.switchView('list');
          this.viewSwitchCallback?.('list');
        } else {
          updateViewSwitchBtns('timeline');
          this.switchView('timeline');
          this.viewSwitchCallback?.('timeline');
        }
      });
    }

    // ─── 排序方式变更 ──────────────────────────────────
    const sortEl = document.getElementById('memory-sort-order') as HTMLSelectElement | null;
    if (sortEl) {
      this.events.addEventListener(sortEl, 'change', () => {
        this.sortChangeCallback?.();
      });
    }

    // ─── 时间范围变更 ──────────────────────────────────
    const timeRangeEl = document.getElementById('memory-time-range') as HTMLSelectElement | null;
    if (timeRangeEl) {
      this.events.addEventListener(timeRangeEl, 'change', () => {
        this.timeRangeChangeCallback?.();
      });
    }

    // ─── 清理按钮（Phase 3：智能清理） ─────────────────
    const cleanupDupBtn = document.getElementById('health-cleanup-duplicates');
    const cleanupStaleBtn = document.getElementById('health-cleanup-stale');
    const cleanupAllBtn = document.getElementById('health-cleanup-all');
    const cleanupDialog = document.getElementById('cleanup-confirm-dialog');
    const cleanupCancelBtn = document.getElementById('cleanup-confirm-cancel');
    const cleanupConfirmBtn = document.getElementById('cleanup-confirm-confirm');

    if (cleanupDupBtn) {
      this.events.addEventListener(cleanupDupBtn, 'click', () => {
        const ids = this.cleanupRequestCallback?.('duplicates') ?? [];
        if (ids.length === 0) {
          this.host.showToast('没有可清理的重复记忆', 'info');
          return;
        }
        this.showCleanupDialog(`确定要清理 ${ids.length} 条重复记忆吗？每组将保留分数最高的一条。`, ids);
      });
    }

    if (cleanupStaleBtn) {
      this.events.addEventListener(cleanupStaleBtn, 'click', () => {
        const ids = this.cleanupRequestCallback?.('stale') ?? [];
        if (ids.length === 0) {
          this.host.showToast('没有可清理的过期记忆', 'info');
          return;
        }
        this.showCleanupDialog(`确定要清理 ${ids.length} 条过期记忆吗？这些记忆长期未访问或得分较低。`, ids);
      });
    }

    if (cleanupAllBtn) {
      this.events.addEventListener(cleanupAllBtn, 'click', () => {
        const ids = this.cleanupRequestCallback?.('all') ?? [];
        if (ids.length === 0) {
          this.host.showToast('没有可清理的问题记忆', 'info');
          return;
        }
        this.showCleanupDialog(`确定要清理 ${ids.length} 条问题记忆吗？`, ids);
      });
    }

    if (cleanupCancelBtn && cleanupDialog) {
      this.events.addEventListener(cleanupCancelBtn, 'click', () => {
        cleanupDialog.classList.add('hidden');
        this.pendingCleanupIds = [];
      });
    }

    if (cleanupConfirmBtn && cleanupDialog) {
      this.events.addEventListener(cleanupConfirmBtn, 'click', async () => {
        cleanupDialog.classList.add('hidden');
        if (this.pendingCleanupIds.length === 0) return;
        const ids = [...this.pendingCleanupIds];
        this.pendingCleanupIds = [];
        try {
          await this.cleanupConfirmCallback?.(ids);
        } catch {
          // cleanupConfirmCallback 由 Controller 实现，Controller 内部会报告错误和显示 toast
        }
      });
    }
  }

  /**
   * 显示清理确认对话框
   *
   * @param message 确认消息
   * @param ids 待清理的记忆 ID 列表
   */
  private showCleanupDialog(message: string, ids: string[]): void {
    const cleanupDialog = document.getElementById('cleanup-confirm-dialog');
    const cleanupMsgEl = document.getElementById('cleanup-confirm-msg');
    if (cleanupMsgEl) cleanupMsgEl.textContent = message;
    this.pendingCleanupIds = ids;
    if (cleanupDialog) cleanupDialog.classList.remove('hidden');
  }

  /**
   * 触发对话面板叙事行点击后，滚动侧边栏到叙事卡片并脉冲
   *
   * 由 Controller 在 chatNarrative 点击时调用（跨面板交互）。
   */
  pulseNarrativeCard(): void {
    const narrativeCard = document.getElementById('sprite-narrative');
    const detailsContainer = document.getElementById('dashboard-details');
    const toggleArrow = document.getElementById('narrative-toggle');
    if (!narrativeCard) return;

    // 展开详情区（若已折叠）
    if (detailsContainer) detailsContainer.classList.remove('collapsed');
    if (toggleArrow) toggleArrow.classList.add('expanded');

    // 滚动侧边栏使叙事卡片可见
    narrativeCard.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // 脉冲动画标记叙事卡片位置
    narrativeCard.classList.remove('narrative-updated');
    void narrativeCard.offsetWidth;
    narrativeCard.classList.add('narrative-updated');
  }

  // ─── 记忆列表渲染 ───────────────────────────────────────

  /**
   * 渲染记忆列表
   *
   * 卡片结构对齐 docs/memora-sprite-preview.html §6.4：
   *   <div class="memory-item">
   *     <div class="name">{name}</div>
   *     <div class="meta">
   *       <span class="source-tag">{source}</span>
   *       <span class="score">score: {score}</span>
   *     </div>
   *     <div class="preview">{contentPreview}</div>
   *   </div>
   */
  renderMemoryList(memories: MemoryListItem[], searchQuery?: string): void {
    // 记忆面板元素缺失时静默降级
    if (!this.memoryListEl) return;

    // P3-FLOW-13 缓存完整列表供分页使用
    this.allMemories = memories;
    this.memoryPage = 1;

    // 缓存搜索关键词供分页渲染时高亮使用（Phase 2：搜索增强）
    this.currentSearchQuery = searchQuery || '';

    // 安全清空容器（使用 clearElement 统一封装 while + removeChild 模式）
    clearElement(this.memoryListEl);

    if (memories.length === 0) {
      // Phase 4：空状态插画升级（SVG 图标 + 标题 + 副标题 + CTA 按钮）
      const empty = document.createElement('div');
      empty.className = 'empty-state memory-empty-state';

      // SVG 图标：大脑轮廓（简洁线条，无外部依赖）
      const icon = document.createElement('div');
      icon.className = 'empty-icon';
      icon.innerHTML = `<svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M24 8C18 8 14 12 14 18C10 18 8 22 8 26C8 30 10 34 14 34C14 38 18 40 22 40C26 40 28 38 28 34V14C28 10 26 8 24 8Z" stroke="currentColor" stroke-width="2" fill="none"/>
        <path d="M28 14C32 14 36 16 36 20C38 20 40 22 40 26C40 30 38 32 36 32C36 36 32 38 28 38" stroke="currentColor" stroke-width="2" fill="none"/>
        <circle cx="18" cy="24" r="2" fill="currentColor" opacity="0.5"/>
        <circle cx="32" cy="28" r="1.5" fill="currentColor" opacity="0.3"/>
      </svg>`;
      empty.appendChild(icon);

      // 标题
      const title = document.createElement('div');
      title.className = 'empty-title';
      title.textContent = '暂无记忆';
      empty.appendChild(title);

      // 副标题
      const subtitle = document.createElement('div');
      subtitle.className = 'empty-subtitle';
      subtitle.textContent = '积累对话后，记忆将自动归档到此处';
      empty.appendChild(subtitle);

      // 空状态引导：提供"添加第一条记忆"按钮，避免用户不知道下一步
      const hintBtn = document.createElement('button');
      // UX-P2-27 同时添加 .btn-secondary 类复用通用按钮样式
      hintBtn.className = 'empty-action-btn btn-secondary';
      hintBtn.textContent = '+ 添加第一条记忆';
      this.events.addEventListener(hintBtn, 'click', () => {
        this.host.showModal('memory-add-modal');
      });
      empty.appendChild(hintBtn);

      this.memoryListEl.appendChild(empty);
      return;
    }

    // P3-FLOW-13 渲染第一页
    this.renderMemoryPage();
  }

  /**
   * P3-FLOW-13 渲染当前页的记忆列表项
   *
   * 分页策略：每页 MEMORY_PAGE_SIZE 条，超出部分通过"加载更多"按钮加载。
   * 避免大量记忆一次性渲染导致 DOM 性能下降。
   */
  private renderMemoryPage(): void {
    if (!this.memoryListEl || !this.allMemories) return;

    // 计算当前页的起止索引
    const start = 0;
    const end = this.memoryPage * MemoryPanelManager.MEMORY_PAGE_SIZE;
    const pageItems = this.allMemories.slice(start, end);

    // 清空容器（保留"加载更多"按钮的容器结构）
    clearElement(this.memoryListEl);

    for (const mem of pageItems) {
      const item = document.createElement('div');
      item.className = 'memory-item';
      item.dataset.id = mem.id;
      // Phase 4：staggered fade-in 延迟（每项延迟 30ms，上限 300ms 避免长列表卡顿）
      const staggerIndex = this.memoryListEl.children.length;
      const delay = Math.min(staggerIndex * 30, 300);
      item.style.animationDelay = `${delay}ms`;

      // 名称（Phase 2：搜索结果高亮）
      const nameEl = document.createElement('div');
      nameEl.className = 'name';
      nameEl.innerHTML = this.highlightText(mem.name, this.currentSearchQuery);
      item.appendChild(nameEl);

      // 元数据（source 标签 + score + P3-FLOW-14 创建时间）
      const metaEl = document.createElement('div');
      metaEl.className = 'meta';

      const sourceTag = document.createElement('span');
      // source 标签颜色区分：不同 source 类型用不同颜色，提升视觉识别度
      // 颜色映射：profile(绿)/insight(蓝)/guardrail(粉)/skill(黄)/rule(紫)/persona(青)/session(橙)
      sourceTag.className = `source-tag source-${getSourceColorClass(mem.source)}`;
      sourceTag.textContent = mem.source;
      metaEl.appendChild(sourceTag);

      const scoreEl = document.createElement('span');
      scoreEl.className = 'score';
      scoreEl.textContent = `score: ${mem.score.toFixed(2)}`;
      metaEl.appendChild(scoreEl);

      // P3-FLOW-14 显示创建时间（仅当存在时）
      if (mem.createdAt) {
        const timeEl = document.createElement('span');
        timeEl.className = 'memory-time';
        timeEl.title = `创建于 ${mem.createdAt}`;
        timeEl.textContent = formatTimeAgo(mem.createdAt);
        metaEl.appendChild(timeEl);
      }

      item.appendChild(metaEl);

      // 预览（2 行截断，Phase 2：搜索结果高亮）
      const previewEl = document.createElement('div');
      previewEl.className = 'preview';
      previewEl.innerHTML = this.highlightText(mem.contentPreview, this.currentSearchQuery);
      item.appendChild(previewEl);

      // QC-22 事件委托：用 data-action + data-memory-id 替代直接 addEventListener
      item.setAttribute('data-action', 'view-memory');
      item.setAttribute('data-memory-id', mem.id);

      this.memoryListEl.appendChild(item);
    }

    // P3-FLOW-13 如果还有更多记忆，添加"加载更多"按钮
    if (this.allMemories.length > end) {
      const loadMoreBtn = document.createElement('button');
      loadMoreBtn.className = 'memory-load-more btn-secondary';
      loadMoreBtn.textContent = `加载更多（剩余 ${this.allMemories.length - end} 条）`;
      this.events.addEventListener(loadMoreBtn, 'click', () => {
        this.memoryPage++;
        this.renderMemoryPage();
      });
      this.memoryListEl.appendChild(loadMoreBtn);
    }
  }

  /**
   * A2：渲染时间线视图（按天分组记忆）
   *
   * 将缓存的记忆列表按 createdAt 分组为日期节点，
   * 以垂直时间线形式展示，每条记忆显示为时间线上的一个节点。
   * 支持搜索高亮和 source 颜色区分。
   */
  private renderTimeline(): void {
    const container = document.getElementById('memory-timeline-container');
    if (!container || !this.allMemories || this.allMemories.length === 0) return;

    // 清空容器
    while (container.firstChild) {
      container.removeChild(container.firstChild);
    }

    // 按天分组记忆（以 createdAt 日期为键）
    const groups = new Map<string, MemoryListItem[]>();
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    for (const mem of this.allMemories) {
      const date = mem.createdAt ? new Date(mem.createdAt) : new Date();
      const dateKey = this.formatDateKey(date);
      const existing = groups.get(dateKey);
      if (existing) {
        existing.push(mem);
      } else {
        groups.set(dateKey, [mem]);
      }
    }

    // 按日期降序排序（今天 → 昨天 → 更早）
    const sortedDates = Array.from(groups.keys()).sort((a, b) => b.localeCompare(a));

    if (sortedDates.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'timeline-empty';
      empty.textContent = '暂无时间线数据';
      container.appendChild(empty);
      return;
    }

    // 渲染时间线容器
    const timeline = document.createElement('div');
    timeline.className = 'timeline';

    for (const dateKey of sortedDates) {
      const items = groups.get(dateKey)!;
      const dateObj = new Date(dateKey);

      // 日期标签
      const dateLabel = this.formatDateLabel(dateObj, today, yesterday);

      // 日期组
      const group = document.createElement('div');
      group.className = 'timeline-group';

      const header = document.createElement('div');
      header.className = 'timeline-date-header';
      header.innerHTML = `<span class="timeline-date-dot"></span><span class="timeline-date-text">${dateLabel}</span><span class="timeline-date-count">${items.length} 条</span>`;
      group.appendChild(header);

      // 该日期下的记忆列表
      const itemList = document.createElement('div');
      itemList.className = 'timeline-items';

      for (const mem of items) {
        const item = document.createElement('div');
        item.className = 'timeline-item';
        item.dataset.id = mem.id;
        item.setAttribute('data-action', 'view-memory');
        item.setAttribute('data-memory-id', mem.id);

        // 时间点
        const timeDot = document.createElement('div');
        timeDot.className = 'timeline-item-dot';
        item.appendChild(timeDot);

        // 记忆内容
        const content = document.createElement('div');
        content.className = 'timeline-item-content';

        const nameEl = document.createElement('div');
        nameEl.className = 'timeline-item-name';
        nameEl.innerHTML = this.highlightText(mem.name, this.currentSearchQuery);
        content.appendChild(nameEl);

        const metaEl = document.createElement('div');
        metaEl.className = 'timeline-item-meta';
        const sourceTag = document.createElement('span');
        sourceTag.className = `source-tag source-${getSourceColorClass(mem.source)}`;
        sourceTag.textContent = mem.source;
        metaEl.appendChild(sourceTag);

        if (mem.createdAt) {
          const timeEl = document.createElement('span');
          timeEl.className = 'timeline-item-time';
          timeEl.textContent = new Date(mem.createdAt).toLocaleTimeString('zh-CN', {
            hour: '2-digit',
            minute: '2-digit',
          });
          metaEl.appendChild(timeEl);
        }
        content.appendChild(metaEl);

        const previewEl = document.createElement('div');
        previewEl.className = 'timeline-item-preview';
        previewEl.innerHTML = this.highlightText(mem.contentPreview, this.currentSearchQuery);
        content.appendChild(previewEl);

        item.appendChild(content);
        itemList.appendChild(item);
      }

      group.appendChild(itemList);
      timeline.appendChild(group);
    }

    container.appendChild(timeline);
  }

  /**
   * 格式化日期为 YYYY-MM-DD 键
   */
  private formatDateKey(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  /**
   * 格式化日期标签（今天/昨天/具体日期）
   */
  private formatDateLabel(date: Date, today: Date, yesterday: Date): string {
    const dateKey = this.formatDateKey(date);
    const todayKey = this.formatDateKey(today);
    const yesterdayKey = this.formatDateKey(yesterday);

    if (dateKey === todayKey) return '今天';
    if (dateKey === yesterdayKey) return '昨天';

    const options: Intl.DateTimeFormatOptions = {
      month: 'long',
      day: 'numeric',
      weekday: 'long',
    };
    return date.toLocaleDateString('zh-CN', options);
  }

  // ─── 记忆详情 ───────────────────────────────────────────

  /** 显示记忆详情 */
  showMemoryDetail(memory: MemoryDetail): void {
    if (!this.memoryDetailModal) return;

    // P2-FLOW-08 打开详情时退出编辑模式，恢复只读状态
    this.isEditing = false;

    const nameEl = getOptionalElement('memory-detail-name', 'h3');
    const sourceEl = getOptionalElement('memory-detail-source', 'code');
    const scoreEl = getOptionalElement('memory-detail-score', 'span');
    const createdEl = getOptionalElement('memory-detail-created', 'span');
    const accessedEl = getOptionalElement('memory-detail-accessed', 'span');
    const contentEl = getOptionalElement('memory-detail-content', 'pre');

    if (nameEl) nameEl.textContent = memory.name;
    if (sourceEl) {
      sourceEl.textContent = memory.source;
      // source 标签颜色区分（与列表保持一致）
      sourceEl.className = `source-${getSourceColorClass(memory.source)}`;
    }
    if (scoreEl) scoreEl.textContent = memory.score.toFixed(2);
    // R5 详情面板日期用 formatTimeAgo 统一格式化（ISO → 相对时间）
    if (createdEl) createdEl.textContent = formatTimeAgo(memory.createdAt);
    if (accessedEl) accessedEl.textContent = formatTimeAgo(memory.accessedAt);
    if (contentEl) contentEl.textContent = memory.content;

    // P2-FLOW-08 保存原始内容到 dataset，供编辑取消时恢复
    if (contentEl) contentEl.dataset.originalContent = memory.content;

    // 记录当前查看的记忆 ID（供删除/编辑按钮使用）
    this.memoryDetailModal.dataset.memoryId = memory.id;
    // P2-FLOW-08 保存 source 和 name 到 dataset，供编辑保存时使用
    this.memoryDetailModal.dataset.memorySource = memory.source;
    this.memoryDetailModal.dataset.memoryName = memory.name;

    // P2-FLOW-08 切换按钮可见性：只读模式显示编辑/删除，隐藏保存/取消
    this.updateDetailButtons();
    this.host.showModal('memory-detail-modal');
  }

  // ─── 辅助方法 ───────────────────────────────────────────

  // getSourceColorClass 已提取到模块顶层（对齐 formatTokenCount 模式，支持纯函数测试）

  // ─── P2-FLOW-08 记忆编辑模式 ────────────────────────────

  /**
   * 进入编辑模式
   *
   * 将 content 区域从只读 <pre> 变为可编辑 <textarea>，
   * 切换底部按钮：隐藏编辑/删除，显示保存/取消。
   */
  private enterEditMode(): void {
    if (this.isEditing) return;
    this.isEditing = true;

    const contentEl = getOptionalElement('memory-detail-content', 'pre');
    if (!contentEl) return;

    // 将 <pre> 内容替换为 <textarea>，保留原始内容
    const originalContent = contentEl.dataset.originalContent ?? contentEl.textContent ?? '';
    const textarea = document.createElement('textarea');
    textarea.id = 'memory-detail-content';
    textarea.className = 'memory-edit-textarea';
    textarea.value = originalContent;
    // 保留 dataset 引用
    textarea.dataset.originalContent = originalContent;
    contentEl.replaceWith(textarea);
    textarea.focus();

    this.updateDetailButtons();
  }

  /**
   * 退出编辑模式
   *
   * 将 <textarea> 恢复为只读 <pre>，恢复原始内容，
   * 切换底部按钮：显示编辑/删除，隐藏保存/取消。
   */
  private exitEditMode(): void {
    if (!this.isEditing) return;
    this.isEditing = false;

    const textarea = document.getElementById('memory-detail-content');
    if (!textarea) return;

    // 恢复为只读 <pre>，使用原始内容
    const originalContent = textarea.dataset.originalContent ?? '';
    const pre = document.createElement('pre');
    pre.id = 'memory-detail-content';
    pre.textContent = originalContent;
    pre.dataset.originalContent = originalContent;
    textarea.replaceWith(pre);

    this.updateDetailButtons();
  }

  /**
   * 保存编辑内容
   *
   * 读取 textarea 中的新内容，通过回调通知宿主层保存。
   * 底层使用 upsert 语义（MEMORIES_ADD 通道），无需新增 IPC 通道。
   */
  private saveEdit(): void {
    const textarea = document.getElementById('memory-detail-content') as HTMLTextAreaElement | null;
    if (!textarea) return;

    const newContent = textarea.value.trim();
    if (!newContent) return;

    const id = this.memoryDetailModal?.dataset.memoryId;
    if (!id) return;

    this.memoryEditCallback?.(id, newContent);
  }

  /**
   * 切换详情弹窗底部按钮可见性
   *
   * 只读模式：显示编辑 + 删除 + 讨论 + 关闭
   * 编辑模式：显示保存 + 取消 + 关闭
   */
  private updateDetailButtons(): void {
    const btnEdit = getOptionalElement('btn-memory-edit', 'button');
    const btnDelete = getOptionalElement('btn-memory-delete', 'button');
    const btnDiscuss = getOptionalElement('btn-memory-discuss', 'button');
    const btnEditSave = getOptionalElement('btn-memory-edit-save', 'button');
    const btnEditCancel = getOptionalElement('btn-memory-edit-cancel', 'button');

    if (btnEdit) btnEdit.classList.toggle('hidden', this.isEditing);
    if (btnDelete) btnDelete.classList.toggle('hidden', this.isEditing);
    if (btnDiscuss) btnDiscuss.classList.toggle('hidden', this.isEditing);
    if (btnEditSave) btnEditSave.classList.toggle('hidden', !this.isEditing);
    if (btnEditCancel) btnEditCancel.classList.toggle('hidden', !this.isEditing);
  }

  // ─── 添加记忆表单 ───────────────────────────────────────

  /** 获取添加记忆表单数据（供测试与外部调用） */
  getAddMemoryFormData(): { source: string; name: string; content: string } | null {
    const sourceEl = getOptionalElement('memory-add-source', 'input');
    const nameEl = getOptionalElement('memory-add-name', 'input');
    const contentEl = getOptionalElement('memory-add-content', 'textarea');
    if (!sourceEl || !nameEl || !contentEl) return null;

    const source = sourceEl.value.trim();
    const name = nameEl.value.trim();
    const content = contentEl.value.trim();

    if (!source || !name || !content) {
      return null;
    }
    return { source, name, content };
  }

  /** 清空添加记忆表单 */
  clearAddMemoryForm(): void {
    const sourceEl = getOptionalElement('memory-add-source', 'input');
    const nameEl = getOptionalElement('memory-add-name', 'input');
    const contentEl = getOptionalElement('memory-add-content', 'textarea');
    if (sourceEl) sourceEl.value = '';
    if (nameEl) nameEl.value = '';
    if (contentEl) contentEl.value = '';
  }

  /** 获取当前查看的记忆 ID（供删除使用） */
  getCurrentMemoryId(): string | null {
    return this.memoryDetailModal?.dataset.memoryId ?? null;
  }

  // ─── 图谱视图（ADR-014：拓扑可视化） ──────────────────────

  /**
   * 高亮文本中的搜索关键词（Phase 2：搜索增强）
   *
   * 将匹配关键词的部分用 <mark> 标签包裹，支持中文和英文。
   * 使用 innerHTML 渲染，已做 HTML 转义处理防止 XSS。
   *
   * @param text 原始文本
   * @param query 搜索关键词（空字符串时返回转义后的原文）
   * @returns 带 <mark> 高亮的 HTML 字符串
   */
  private highlightText(text: string, query: string): string {
    // 转义 HTML 特殊字符，防止 XSS
    const escaped = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

    if (!query) return escaped;

    // 转义正则特殊字符，构建匹配模式
    const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${escapedQuery})`, 'gi');

    return escaped.replace(regex, '<mark>$1</mark>');
  }

  /**
   * 切换记忆视图模式（列表 ↔ 时间线 ↔ 图谱）
   *
   * 图谱视图使用 Canvas 2D 力导向图渲染记忆关系网络。
   * 时间线视图按天分组记忆列表。
   * 首次切换时延迟初始化渲染器（确保 Canvas DOM 已就绪）。
   * 关系数据为空时隐藏图谱标签，保持列表视图。
   *
   * @param mode 目标视图模式
   */
  switchView(mode: 'list' | 'timeline' | 'graph'): void {
    this.viewMode = mode;

    // 切换列表、时间线和图谱容器的可见性
    const listEl = this.memoryListEl;
    const graphEl = document.getElementById('memory-graph-container');
    const timelineEl = document.getElementById('memory-timeline-container');

    if (mode === 'list') {
      if (listEl) listEl.style.display = '';
      if (graphEl) graphEl.style.display = 'none';
      if (timelineEl) timelineEl.style.display = 'none';
    } else if (mode === 'timeline') {
      if (listEl) listEl.style.display = 'none';
      if (graphEl) graphEl.style.display = 'none';
      if (timelineEl) {
        timelineEl.style.display = '';
        // 渲染时间线视图（使用缓存的记忆列表）
        this.renderTimeline();
      }
    } else {
      if (listEl) listEl.style.display = 'none';
      if (timelineEl) timelineEl.style.display = 'none';
      if (graphEl) {
        graphEl.style.display = '';
        // 延迟初始化图谱渲染器（确保容器尺寸已计算）
        this.initGraphRenderer();
        // 如果已有缓存数据，直接加载并应用缓存状态；
        // 无缓存时数据加载由 onViewSwitch 回调统一处理（Controller负责IPC）
        if (this.graphDataCache) {
          this.graphRenderer?.loadData(this.graphDataCache);
          this.applyCachedGraphState();
        }
      }
    }
  }

  /**
   * 加载图谱数据到渲染器
   *
   * 由宿主层调用（IPC 返回图谱数据后）。
   * 缓存数据以便切换回图谱视图时避免重复请求。
   * 加载后自动应用缓存的高亮/选中状态（列表视图中操作的状态）。
   *
   * @param data 图谱原始数据（nodes + edges）
   */
  loadGraphData(data: RelationGraphData): void {
    this.graphDataCache = data;
    if (this.viewMode === 'graph' && this.graphRenderer) {
      this.graphRenderer.loadData(data);
      // 数据加载后恢复缓存的高亮/选中状态
      this.applyCachedGraphState();
    }
  }

  /**
   * 将缓存的高亮/选中状态应用到渲染器
   *
   * 解决问题：用户在列表视图搜索/点击后切换到图谱，
   * 状态需要在渲染器初始化和数据加载后恢复。
   */
  private applyCachedGraphState(): void {
    if (!this.graphRenderer) return;
    if (this.cachedHighlightedNodeIds !== null) {
      this.graphRenderer.setHighlightedNodes(this.cachedHighlightedNodeIds);
    }
    if (this.cachedSelectedNodeId !== null) {
      this.graphRenderer.setSelectedNode(this.cachedSelectedNodeId);
    }
  }

  /**
   * 检查是否有关系数据（用于决定是否显示图谱标签）
   *
   * @returns 有缓存数据且边数 > 0 时返回 true
   */
  hasGraphData(): boolean {
    return this.graphDataCache !== null && this.graphDataCache.edges.length > 0;
  }

  /** 获取当前视图模式 */
  getViewMode(): 'list' | 'timeline' | 'graph' {
    return this.viewMode;
  }

  /**
   * 设置图谱高亮节点（搜索结果联动）
   *
   * 高亮节点正常显示，非高亮节点淡化。
   * 传 null 清除高亮。
   * 若渲染器尚未初始化，缓存状态待初始化后应用。
   */
  highlightGraphNodes(nodeIds: string[] | null): void {
    this.cachedHighlightedNodeIds = nodeIds;
    this.graphRenderer?.setHighlightedNodes(nodeIds);
  }

  /**
   * 设置图谱选中节点（列表/详情联动）
   *
   * 选中节点显示蓝色外发光环，并平滑居中到视口。
   * 传 null 取消选中。
   * 若渲染器尚未初始化，缓存状态待初始化后应用。
   */
  selectGraphNode(nodeId: string | null): void {
    this.cachedSelectedNodeId = nodeId;
    this.graphRenderer?.setSelectedNode(nodeId);
  }

  /** 清除图谱所有高亮和选中状态 */
  clearGraphHighlights(): void {
    this.cachedHighlightedNodeIds = null;
    this.cachedSelectedNodeId = null;
    this.graphRenderer?.clearHighlights();
  }

  /**
   * 延迟初始化图谱渲染器
   *
   * 首次切换到图谱视图时，Canvas 元素可能尚未渲染，
   * 使用 requestAnimationFrame 延迟一帧确保 DOM 就绪。
   */
  private initGraphRenderer(): void {
    if (this.graphRenderer) return;

    const canvas = document.getElementById('memory-graph-canvas') as HTMLCanvasElement | null;
    if (!canvas) return;

    this.graphRenderer = new RelationGraphRenderer(canvas);
    // 节点点击回调：通过 memoryClickCallback 显示详情
    this.graphRenderer.setOnNodeClick((nodeId: string) => {
      this.memoryClickCallback?.(nodeId);
    });
  }

  // ─── 回调注册 ───────────────────────────────────────────

  onMemorySearch(cb: (query: string) => void): void {
    this.memorySearchCallback = cb;
  }
  onMemoryFilter(cb: (source: string) => void): void {
    this.memoryFilterCallback = cb;
  }
  onMemoryClick(cb: (id: string) => void): void {
    this.memoryClickCallback = cb;
  }
  onMemoryDelete(cb: () => void): void {
    this.memoryDeleteCallback = cb;
  }
  onMemoryAdd(cb: (data: { source: string; name: string; content: string }) => void): void {
    this.memoryAddCallback = cb;
  }
  /** P2-FLOW-08 注册记忆编辑回调 */
  onMemoryEdit(cb: (id: string, content: string) => void): void {
    this.memoryEditCallback = cb;
  }
  /** FD-ADD-MEMORY-DISCUSS 注册记忆讨论回调（记忆名称 → 切换到对话面板预填讨论提示） */
  onMemoryDiscuss(cb: (memoryName: string) => void): void {
    this.memoryDiscussCallback = cb;
  }
  /** 注册更多菜单项点击回调（加载洞察/健康度数据） */
  onMoreMenuAction(cb: (action: string) => void): void {
    this.moreMenuActionCallback = cb;
  }
  /** 注册排序变更回调 */
  onSortChange(cb: () => void): void {
    this.sortChangeCallback = cb;
  }
  /** 注册时间范围变更回调 */
  onTimeRangeChange(cb: () => void): void {
    this.timeRangeChangeCallback = cb;
  }
  /** 注册清理请求回调（返回待清理ID列表） */
  onCleanupRequest(cb: (type: 'duplicates' | 'stale' | 'all') => string[]): void {
    this.cleanupRequestCallback = cb;
  }
  /** 注册清理确认回调（执行批量删除IPC） */
  onCleanupConfirm(cb: (ids: string[]) => Promise<void>): void {
    this.cleanupConfirmCallback = cb;
  }
  /** 注册视图切换回调（通知Controller切换视图后的业务逻辑） */
  onViewSwitch(cb: (mode: 'list' | 'timeline' | 'graph') => void): void {
    this.viewSwitchCallback = cb;
  }
}