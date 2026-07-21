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
 */

import { getOptionalElement, clearElement, formatTimeAgo, formatTimestamp, escapeHtml, createEmptyState, createEl } from '../helpers/domHelpers.js';
// escapeRegExp 转义正则特殊字符（ADR-017 枝叶层 2 次提取）
import { escapeRegExp } from '../../../shared/escapeRegExp.js';
// getSourceLabel 将 source 字符串映射为中文标签（UX-2：消除英文原值直显，单一真理源在 helpers/sourceLabel.ts）
import { getSourceLabel } from '../helpers/sourceLabel.js';
// 渲染进程统一日志入口（替代散落的 console.error/warn）
import { reportError } from '../helpers/errorHelpers.js';
import type { EventTracker } from '../helpers/eventTracker.js';
import type { MemoryListItem, MemoryDetail, ConfirmDialogOptions, ToastType, RelationPath, RelationNeighbor } from '../types.js';
import type { RelationGraphRenderer, RelationGraphData } from '../components/relationGraph.js';
// 健康度仪表盘数据载荷（renderHealthDashboard 委托方法签名需要）
import type { HealthDashboardPayload } from '../../preload.js';
// 记忆面板所属子渲染器（DOM 在 panel-memories 内，归 MemoryPanelManager 管理）
import { PartnerInsightsRenderer } from './partnerInsightsRenderer.js';
import { HealthDashboardRenderer } from './healthDashboardRenderer.js';
import { InsightsRenderer } from './insightsRenderer.js';
// 补全统计面板渲染器（第 3 个 analysis panel）
import { CompletionStatsRenderer } from './completionStatsRenderer.js';
// 事件监听器注册逻辑提取到独立 helper（降低本文件体量）
import { initMemoryPanelListeners as initMemoryPanelListenersImpl } from '../helpers/memoryPanelEvents.js';
import type { MemoryPanelEventContext } from '../helpers/memoryPanelEvents.js';
// 图谱视图子系统（初始化/空状态/缓存状态/上下文菜单/关系弹窗）提取到独立子模块（panels/ 同层）
import {
  initGraphRenderer as initGraphRendererHelper,
  updateGraphEmptyState as updateGraphEmptyStateHelper,
  applyCachedGraphState as applyCachedGraphStateHelper,
  clearGraphHighlights as clearGraphHighlightsHelper,
} from './memoryGraphPanel.js';
import type { MemoryGraphPanelContext } from './memoryGraphPanel.js';
// 记忆详情子系统（详情/脉络/邻居/按钮）提取到独立 helper
import {
  showMemoryDetail as showMemoryDetailHelper,
  resetLineage as resetLineageHelper,
  showMemoryLineage as showMemoryLineageHelper,
  showLineageError as showLineageErrorHelper,
  resetNeighbors as resetNeighborsHelper,
  showMemoryNeighbors as showMemoryNeighborsHelper,
  showNeighborsError as showNeighborsErrorHelper,
  updateDetailButtons as updateDetailButtonsHelper,
} from '../helpers/memoryDetailPanel.js';
import type { MemoryDetailPanelContext } from '../helpers/memoryDetailPanel.js';
// 视图切换 / 分析面板管理子系统（视图显隐 + 互斥切换 + viewSwitchToken 竞态保护）提取到独立 helper
import {
  toggleAnalysisPanel as toggleAnalysisPanelHelper,
  hideAnalysisPanel as hideAnalysisPanelHelper,
  dismissAnalysisPanels as dismissAnalysisPanelsHelper,
  switchView as switchViewHelper,
} from '../helpers/memoryViewSwitcher.js';
import type { MemoryViewSwitcherContext } from '../helpers/memoryViewSwitcher.js';
// 时间线视图子系统（按天分组渲染 + 日期标签格式化）提取到独立 helper
import { renderTimeline as renderTimelineHelper } from '../helpers/memoryTimelineView.js';
import type { MemoryTimelineContext } from '../helpers/memoryTimelineView.js';
// source 颜色映射纯函数（从本文件提取到 helpers/sourceColor.ts，消除 helpers→panels 循环依赖）
import { getSourceColorClass } from '../helpers/sourceColor.js';

// ─── Host 接口（跨模块关注点注入） ────────────────────────

/** 记忆面板管理器需要的宿主能力（跨模块关注点，由 UIManager 注入） */
export interface MemoryPanelHost {
  /** 显示模态框 */
  showModal(modalId: string): void;
  /** 隐藏模态框 */
  hideModal(modalId: string): void;
  /** 显示确认对话框（取消按钮） */
  showConfirmDialog(options: ConfirmDialogOptions): Promise<boolean>;
  /** 显示 toast 通知（添加记忆表单校验失败时反馈） */
  showToast(message: string, type?: ToastType, duration?: number): void;
}

// ─── 记忆面板管理器类 ─────────────────────────────────────

export class MemoryPanelManager {
  // ─── 静态常量 ───────────────────────────────────────────
  /**
   * 记忆列表分页每页大小
   * 50 条平衡了首屏渲染性能和用户浏览体验，超过时显示"加载更多"按钮
   */
  static readonly MEMORY_PAGE_SIZE = 50;

  // ─── 内部状态 ────────────────────────────────────────────
  /** 完整记忆列表缓存（供分页使用） */
  private allMemories: MemoryListItem[] = [];
  /** 当前记忆列表页码（从 1 开始） */
  private memoryPage = 1;
  /** 当前搜索关键词（Phase 2：搜索结果高亮，空字符串表示不高亮） */
  private currentSearchQuery = '';
  /** 记忆搜索防抖定时器（cleanup 时需清理，避免回调在 DOM 销毁后触发） */
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  // ─── 图谱视图状态（ADR-014：拓扑可视化） ──────────────────
  /** 当前视图模式：list（列表）、timeline（时间线）、graph（图谱），默认列表 */
  private viewMode: 'list' | 'timeline' | 'graph' = 'list';
  /** 打开分析面板（统计洞察/健康度诊断）前的视图模式，关闭时恢复 */
  private previousViewMode: 'list' | 'timeline' | 'graph' = 'list';
  /** 当前激活的分析面板：null 表示无，'insights' / 'health' */
  private activeAnalysisPanel: 'insights' | 'health' | 'completion-stats' | null = null;
  /** 图谱渲染器实例（Canvas 2D 力导向图） */
  private graphRenderer: RelationGraphRenderer | null = null;
  /** 图谱数据缓存（切换回图谱视图时避免重复请求 IPC） */
  private graphDataCache: RelationGraphData | null = null;
  /** 缓存的高亮节点 ID（渲染器初始化前设置的状态需要在初始化后恢复） */
  private cachedHighlightedNodeIds: string[] | null = null;
  /** 缓存的选中节点 ID（渲染器初始化前设置的状态需要在初始化后恢复） */
  private cachedSelectedNodeId: string | null = null;

  // ─── 子渲染器（DOM 在 panel-memories 内，归本面板管理） ──
  /** 伙伴洞察渲染器（profile 卡片 / 知识缺口 / 增长趋势图） */
  private partnerInsights = new PartnerInsightsRenderer();
  /** 健康度仪表盘渲染器（评分 / 徽章 / 三维度 / 清理按钮） */
  private healthDashboard = new HealthDashboardRenderer();
  /** 洞察渲染器（统计卡片 / source 分布 / 关系摘要） */
  private insights = new InsightsRenderer();
  /** 补全统计渲染器（采纳率 / Top-1 命中率 / 事件流） */
  private completionStats = new CompletionStatsRenderer();

  // ─── 回调 ────────────────────────────────────────────────
  private memorySearchCallback: ((query: string) => void) | null = null;
  private memoryFilterCallback: ((source: string) => void) | null = null;
  private memoryClickCallback: ((id: string) => void) | null = null;
  private memoryDeleteCallback: (() => void) | null = null;
  private memoryAddCallback:
    | ((data: { source: string; name: string; content: string }) => void)
    | null = null;
  /** 记忆编辑回调：携带记忆 ID 和新内容 */
  private memoryEditCallback: ((id: string, content: string) => void) | null = null;
  /** 记忆讨论回调：携带记忆名称，切换到对话面板预填讨论提示 */
  private memoryDiscussCallback: ((memoryName: string) => void) | null = null;
  /** 编辑模式状态：true 时显示保存/取消按钮，隐藏编辑/删除按钮 */
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
  /** LLM 治理回调（G3：dedup/timeliness/conflicts，由 Controller 调用 IPC） */
  private llmGovernanceCallback: ((action: 'dedup' | 'timeliness' | 'conflicts') => Promise<void>) | null = null;
  /** 清理确认回调（执行批量删除） */
  private cleanupConfirmCallback: ((ids: string[]) => Promise<void>) | null = null;
  /** 视图切换按钮状态更新回调（通知Controller同步按钮active状态） */
  private viewSwitchCallback: ((mode: 'list' | 'timeline' | 'graph') => void) | null = null;
  /** 图谱上下文菜单操作回调 */
  private graphContextMenuCallback: ((action: string, nodeId: string) => void) | null = null;
  /** 关系编辑回调 */
  private relationEditCallback: ((sourceId: string, targetId: string, type: string, weight: number) => void) | null = null;
  /** 关系删除回调 */
  private relationDeleteCallback: ((sourceId: string, targetId: string, type: string) => void) | null = null;
  /** 关系创建回调 */
  private relationCreateCallback: ((sourceId: string, targetId: string, type: string, weight: number) => void) | null = null;
  /** 回收站操作回调：action='restore' 恢复 / action='purge' 彻底删除 */
  private recycleBinActionCallback: ((action: 'restore' | 'purge', id: string) => void) | null = null;
  /** 回收站批量操作回调：action='restore-all' 全部恢复 / action='purge-all' 全部清空 */
  private recycleBinBatchActionCallback: ((action: 'restore-all' | 'purge-all') => void) | null = null;
  /** 回收站完整列表缓存（供分页使用，避免每次翻页重新请求 IPC） */
  private allRecycleBinMemories: Array<{ id: string; name: string; source: string; contentPreview: string; deletedAt: string }> = [];
  /** 回收站当前页码（从 1 开始，与记忆列表分页模式一致） */
  private recycleBinPage = 1;
// ─── 清理对话框状态 ────────────────────────────────────
  /** 待清理的记忆 ID 列表（确认对话框中使用） */
  private pendingCleanupIds: string[] = [];
  /** 视图切换令牌，防止快速切换时 setTimeout 回调竞态导致空白 */
  private viewSwitchToken = 0;
  /** 图谱右键菜单的 document click 关闭处理器（hideGraphContextMenu 时移除，避免泄漏） */
  private graphContextMenuCloseHandler: ((e: MouseEvent) => void) | null = null;
  /** 图谱右键菜单的键盘导航处理器（Arrow/Escape，hideGraphContextMenu 时移除） */
  private graphContextMenuKeyHandler: ((e: KeyboardEvent) => void) | null = null;

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
    // 清理子渲染器
    this.partnerInsights.cleanup();
    this.healthDashboard.cleanup();
    this.insights.cleanup();
    this.completionStats.cleanup();
    this.events.cleanup();
  }

  // ─── 事件监听器初始化 ───────────────────────────────────

  /** 初始化记忆面板事件监听 */
  initMemoryPanelListeners(): void {
    // 事件监听器注册逻辑提取到 helpers/memoryPanelEvents.ts
    // 此处构建上下文并委托，降低本文件体量（原 375 行单方法 → ~50 行薄委托层）
    const ctx: MemoryPanelEventContext = {
      // ─── DOM 元素（构造函数注入的可选元素） ───
      memoryListEl: this.memoryListEl,
      memorySearchEl: this.memorySearchEl,
      memoryFilterSourceEl: this.memoryFilterSourceEl,
      memoryDetailModal: this.memoryDetailModal,
      // ─── 事件跟踪器 + 宿主能力 ───
      events: this.events,
      host: this.host,
      // ─── 状态访问器（searchTimer 防抖定时器，cleanup 时需清理） ───
      getSearchTimer: () => this.searchTimer,
      setSearchTimer: (timer) => {
        this.searchTimer = timer;
      },
      // ─── 清理对话框状态（待清理 ID 列表） ───
      getPendingCleanupIds: () => this.pendingCleanupIds,
      setPendingCleanupIds: (ids) => {
        this.pendingCleanupIds = ids;
      },
      // ─── 实例方法引用（箭头函数绑定 this，覆盖 public/private 方法） ───
      getAddMemoryFormData: () => this.getAddMemoryFormData(),
      enterEditMode: () => this.enterEditMode(),
      exitEditMode: () => this.exitEditMode(),
      // 编辑模式守卫：取消按钮/Esc/关闭按钮/backdrop 关闭时调用，含未保存提示
      confirmExitEditMode: () => this.confirmExitEditMode(),
      // 关闭请求守卫：编辑模式下返回 false 阻止关闭，非编辑模式返回 true 放行
      handleCloseRequest: () => this.handleCloseRequest(),
      // 读取编辑状态（事件层 capture phase 拦截关闭按钮/backdrop 时判断）
      getIsEditing: () => this.isEditing,
      saveEdit: () => this.saveEdit(),
      toggleAnalysisPanel: (panel) => this.toggleAnalysisPanel(panel),
      hideAnalysisPanel: () => this.hideAnalysisPanel(),
      switchView: (mode) => this.switchView(mode),
      showCleanupDialog: (message, ids) => this.showCleanupDialog(message, ids),
      // ─── 回调读取器（onXxx 注册晚于 init，用 getter 读取最新值） ───
      getMemorySearchCallback: () => this.memorySearchCallback,
      getMemoryFilterCallback: () => this.memoryFilterCallback,
      getMemoryClickCallback: () => this.memoryClickCallback,
      getMemoryDeleteCallback: () => this.memoryDeleteCallback,
      getMemoryAddCallback: () => this.memoryAddCallback,
      getMemoryDiscussCallback: () => this.memoryDiscussCallback,
      getSortChangeCallback: () => this.sortChangeCallback,
      getTimeRangeChangeCallback: () => this.timeRangeChangeCallback,
      getCleanupRequestCallback: () => this.cleanupRequestCallback,
      getCleanupConfirmCallback: () => this.cleanupConfirmCallback,
      getLlmGovernanceCallback: () => this.llmGovernanceCallback,
      getViewSwitchCallback: () => this.viewSwitchCallback,
      // 回收站操作回调读取器
      getRecycleBinActionCallback: () => this.recycleBinActionCallback,
      getRecycleBinBatchActionCallback: () => this.recycleBinBatchActionCallback,
      // 更多菜单操作回调读取器（insights/health/recycle-bin）
      getMoreMenuActionCallback: () => this.moreMenuActionCallback,
    };
    initMemoryPanelListenersImpl(ctx);
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

  // ─── 记忆列表渲染 ───────────────────────────────────────

  /**
   * 渲染记忆列表
   *
   * 卡片结构对齐设计契约 §6.4：
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

    // 缓存完整列表供分页使用
    this.allMemories = memories;
    this.memoryPage = 1;

    // 缓存搜索关键词供分页渲染时高亮使用（Phase 2：搜索增强）
    this.currentSearchQuery = searchQuery || '';

    // 安全清空容器（使用 clearElement 统一封装 while + removeChild 模式）
    clearElement(this.memoryListEl);

    if (memories.length === 0) {
      // 空状态：图标 + 标题 + 副标题 + CTA 按钮（用 createEmptyState 工厂统一结构）
      const empty = createEmptyState({
        panelPrefix: 'memory',
        iconHtml: `<svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M24 8C18 8 14 12 14 18C10 18 8 22 8 26C8 30 10 34 14 34C14 38 18 40 22 40C26 40 28 38 28 34V14C28 10 26 8 24 8Z" stroke="currentColor" stroke-width="2" fill="none"/>
          <path d="M28 14C32 14 36 16 36 20C38 20 40 22 40 26C40 30 38 32 36 32C36 36 32 38 28 38" stroke="currentColor" stroke-width="2" fill="none"/>
          <circle cx="18" cy="24" r="2" fill="currentColor" opacity="0.5"/>
          <circle cx="32" cy="28" r="1.5" fill="currentColor" opacity="0.3"/>
        </svg>`,
        title: '暂无记忆',
        subtitle: '积累对话后，记忆将自动归档到此处',
        ctaText: '+ 添加第一条记忆',
        ctaOnClick: () => this.host.showModal('memory-add-modal'),
      });
      this.memoryListEl.appendChild(empty);
      return;
    }

    // 渲染第一页
    this.renderMemoryPage();
  }

  /**
   * 渲染当前页的记忆列表项
   *
   * 分页策略：每页 MEMORY_PAGE_SIZE 条，超出部分通过"加载更多"按钮加载。
   * 避免大量记忆一次性渲染导致 DOM 性能下降。
   */
  private renderMemoryPage(): void {
    if (!this.memoryListEl) return;

    // 计算当前页的起止索引
    const start = 0;
    const end = this.memoryPage * MemoryPanelManager.MEMORY_PAGE_SIZE;
    const pageItems = this.allMemories.slice(start, end);

    // 清空容器（保留"加载更多"按钮的容器结构）
    clearElement(this.memoryListEl);

    for (const mem of pageItems) {
      const item = this.createMemoryItemElement(mem, this.memoryListEl.children.length);
      this.memoryListEl.appendChild(item);
    }

    // 如果还有更多记忆，添加"加载更多"按钮
    if (this.allMemories.length > end) {
      const loadMoreBtn = createEl('button', 'memory-load-more btn-secondary', `加载更多（剩余 ${this.allMemories.length - end} 条）`);
      this.events.addEventListener(loadMoreBtn, 'click', () => {
        this.memoryPage++;
        this.renderMemoryPage();
      });
      this.memoryListEl.appendChild(loadMoreBtn);
    }
  }

  /**
   * 创建单个记忆列表项 DOM 元素（renderMemoryPage 的辅助方法）
   *
   * 提取自 renderMemoryPage 的 54 行内联 DOM 创建逻辑，
   * 包含名称、source 标签、score、时间、预览和事件委托属性。
   *
   * @param mem 记忆列表项数据
   * @param staggerIndex 交错动画索引（用于 staggered fade-in）
   * @returns 完整的记忆项 DOM 元素
   */
  private createMemoryItemElement(mem: MemoryListItem, staggerIndex: number): HTMLElement {
    const item = createEl('div', 'memory-item');
    item.dataset.id = mem.id;
    // 键盘可访问性（tabindex + role + aria-label），让键盘用户能 Tab 聚焦并回车查看
    item.setAttribute('tabindex', '0');
    item.setAttribute('role', 'button');
    item.setAttribute('aria-label', `查看记忆：${mem.name}`);
    // Phase 4：staggered fade-in 延迟（每项延迟 30ms，上限 300ms 避免长列表卡顿）
    const delay = Math.min(staggerIndex * 30, 300);
    item.style.animationDelay = `${delay}ms`;

    // 名称（Phase 2：搜索结果高亮）
    const nameEl = document.createElement('div');
    nameEl.className = 'name';
    nameEl.innerHTML = this.highlightText(mem.name, this.currentSearchQuery);
    item.appendChild(nameEl);

    // 元数据（source 标签 + score + 创建时间）
    const metaEl = createEl('div', 'meta');

    const sourceTag = createEl('span', `source-tag source-${getSourceColorClass(mem.source)}`, mem.source);
    metaEl.appendChild(sourceTag);

    const scoreEl = createEl('span', 'score', `权重: ${mem.score.toFixed(2)}`);
    metaEl.appendChild(scoreEl);

    if (mem.createdAt) {
      const timeEl = createEl('span', 'memory-time', formatTimeAgo(mem.createdAt));
      timeEl.title = `创建于 ${mem.createdAt}`;
      metaEl.appendChild(timeEl);
    }

    item.appendChild(metaEl);

    // 预览（2 行截断，Phase 2：搜索结果高亮）
    const previewEl = document.createElement('div');
    previewEl.className = 'preview';
    previewEl.innerHTML = this.highlightText(mem.contentPreview, this.currentSearchQuery);
    item.appendChild(previewEl);

    // 事件委托：用 data-action + data-memory-id 替代直接 addEventListener
    item.setAttribute('data-action', 'view-memory');
    item.setAttribute('data-memory-id', mem.id);

    return item;
  }

  /**
   * 渲染时间线视图（按天分组记忆，委托到 memoryTimelineView helper）
   *
   * 由 switchView 切换到 timeline 视图时调用。
   * 实现细节（空状态 / 日期分组 / 降序排序 / 项 DOM 构建 / 日期标签格式化）
   * 提取到 helpers/memoryTimelineView.ts，通过 buildTimelineContext 注入依赖。
   */
  private renderTimeline(): void {
    renderTimelineHelper(this.buildTimelineContext());
  }

  // ─── 记忆详情（委托到 memoryDetailPanel helper） ─────────

  /**
   * 显示记忆详情（委托到 memoryDetailPanel helper）
   *
   * 进入前做一次防御性清理：若上一次编辑后 Controller 未调用 exitEditMode
   * （如保存成功后直接 hideModal），#memory-detail-content 可能仍是 textarea，
   * 此时 helper 的 getOptionalElement('pre') 会返回 null 导致内容不渲染。
   * 此处检测并恢复为 pre，确保每次打开详情都是干净的只读状态。
   */
  showMemoryDetail(memory: MemoryDetail): void {
    const current = document.getElementById('memory-detail-content');
    if (current instanceof HTMLTextAreaElement) {
      const originalContent = current.dataset.originalContent ?? '';
      const pre = document.createElement('pre');
      pre.id = 'memory-detail-content';
      pre.textContent = originalContent;
      pre.dataset.originalContent = originalContent;
      current.replaceWith(pre);
      this.isEditing = false;
    }
    showMemoryDetailHelper(this.buildDetailPanelContext(), memory);
  }

  // ─── 演化脉络（Phase 5.1：路径追溯，委托到 memoryDetailPanel helper） ────

  /** 重置演化脉络区域（委托到 memoryDetailPanel helper） */
  resetLineage(): void {
    resetLineageHelper();
  }

  /**
   * 渲染演化脉络（异步加载完成后注入，委托到 memoryDetailPanel helper）
   *
   * @param path 内核 BFS 返回的路径节点数组
   */
  showMemoryLineage(path: RelationPath[]): void {
    showMemoryLineageHelper(this.buildDetailPanelContext(), path);
  }

  /**
   * 显示演化脉络加载失败状态 + 重试按钮（委托到 memoryDetailPanel helper）
   *
   * @param onRetry 重试回调（点击重试按钮触发）
   */
  showLineageError(onRetry: () => void): void {
    showLineageErrorHelper(this.buildDetailPanelContext(), onRetry);
  }

  // ─── Phase 5.2：直接邻居视图（委托到 memoryDetailPanel helper） ────

  /** 重置直接邻居区域（委托到 memoryDetailPanel helper） */
  resetNeighbors(): void {
    resetNeighborsHelper();
  }

  /**
   * 渲染直接关联邻居（异步加载完成后注入，委托到 memoryDetailPanel helper）
   *
   * @param neighbors 内核返回的邻居节点数组
   */
  showMemoryNeighbors(neighbors: RelationNeighbor[]): void {
    showMemoryNeighborsHelper(this.buildDetailPanelContext(), neighbors);
  }

  /**
   * 显示直接邻居加载失败状态 + 重试按钮（委托到 memoryDetailPanel helper）
   *
   * @param onRetry 重试回调（点击重试按钮触发）
   */
  showNeighborsError(onRetry: () => void): void {
    showNeighborsErrorHelper(this.buildDetailPanelContext(), onRetry);
  }

  // ─── 辅助方法 ───────────────────────────────────────────

  // getSourceColorClass 位于模块顶层（对齐 formatTokenCount 模式，支持纯函数测试）

  // ─── 记忆编辑模式 ────────────────────────────

  /**
   * 进入编辑模式
   *
   * 将 content 区域从只读 <pre> 变为可编辑 <textarea>，
   * 切换底部按钮：隐藏编辑/删除，显示保存/取消。
   * 同时绑定 Ctrl+Enter 快捷保存和 Esc 退出编辑（含未保存提示）。
   */
  private enterEditMode(): void {
    if (this.isEditing) return;

    const contentEl = getOptionalElement('memory-detail-content', 'pre');
    // P2-1：仅在元素校验通过后才置位 isEditing，避免后续按钮切换状态错乱
    if (!contentEl) return;
    this.isEditing = true;

    // 将 <pre> 内容替换为 <textarea>，保留原始内容
    const originalContent = contentEl.dataset.originalContent ?? contentEl.textContent ?? '';
    const textarea = createEl('textarea', 'memory-edit-textarea');
    textarea.id = 'memory-detail-content';
    textarea.value = originalContent;
    // 保留 dataset 引用，供 exitEditMode 比较和恢复使用
    textarea.dataset.originalContent = originalContent;
    contentEl.replaceWith(textarea);
    textarea.focus();

    // 编辑模式键盘快捷键：Ctrl+Enter 保存，Esc 退出编辑（含未保存提示）
    // Esc 调用 stopPropagation 阻止冒泡到 modal.ts 全局 Escape 监听器，由本管理器内部处理
    this.events.addEventListener(
      textarea,
      'keydown',
      ((e: KeyboardEvent) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault();
          this.saveEdit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          void this.confirmExitEditMode();
        }
      }) as EventListener,
    );

    this.updateDetailButtons();
  }

  /**
   * 退出编辑模式（强制退出，无未保存提示）
   *
   * 将 <textarea> 恢复为只读 <pre>，恢复原始内容，
   * 切换底部按钮：显示编辑/删除，隐藏保存/取消。
   *
   * 用于保存成功后或 confirmExitEditMode 用户确认放弃修改后调用。
   * 用户主动退出（取消按钮/Esc/关闭弹窗）应调用 confirmExitEditMode 而非本方法。
   */
  private exitEditMode(): void {
    if (!this.isEditing) return;
    this.isEditing = false;

    const textarea = document.getElementById('memory-detail-content');
    if (!textarea) return;

    // 恢复为只读 <pre>，使用原始内容
    const originalContent = (textarea as HTMLTextAreaElement).dataset.originalContent ?? '';
    const pre = document.createElement('pre');
    pre.id = 'memory-detail-content';
    pre.textContent = originalContent;
    pre.dataset.originalContent = originalContent;
    textarea.replaceWith(pre);

    this.updateDetailButtons();
  }

  /**
   * 检查未保存修改并按需弹确认对话框后退出编辑模式
   *
   * 编辑模式下取消按钮/Esc/关闭弹窗/backdrop 关闭时调用：
   * - 有修改：弹"放弃未保存的修改？"确认对话框，确认后退出编辑模式
   * - 无修改：直接退出编辑模式
   */
  private async confirmExitEditMode(): Promise<void> {
    if (!this.isEditing) return;

    const textarea = document.getElementById('memory-detail-content');
    const original = textarea instanceof HTMLTextAreaElement
      ? (textarea.dataset.originalContent ?? '')
      : '';
    const current = textarea instanceof HTMLTextAreaElement ? textarea.value : '';

    // 比较当前值与原始值，有差异时弹确认对话框
    if (current !== original) {
      const confirmed = await this.host.showConfirmDialog({
        title: '放弃修改',
        message: '当前编辑内容未保存，确定要放弃修改吗？',
        confirmText: '放弃',
        danger: true,
      } satisfies ConfirmDialogOptions);
      if (!confirmed) return; // 用户选择保留修改，停留在编辑模式
    }

    this.exitEditMode();
  }

  /**
   * 处理关闭请求（关闭按钮/Escape/backdrop 触发）
   *
   * 编辑模式下：调用 confirmExitEditMode，由用户决定是否放弃未保存修改。
   *   - 用户确认放弃：isEditing 被置为 false，返回 true 表示可关闭弹窗
   *   - 用户选择保留：isEditing 仍为 true，返回 false 表示应阻止关闭
   * 非编辑模式：直接返回 true，由调用方执行 hideModal。
   *
   * @returns true 表示可关闭弹窗，false 表示应阻止关闭
   */
  async handleCloseRequest(): Promise<boolean> {
    if (!this.isEditing) return true;
    await this.confirmExitEditMode();
    return !this.isEditing;
  }

  /**
   * 保存编辑内容
   *
   * 读取 textarea 中的新内容，通过回调通知宿主层保存。
   * 底层使用 upsert 语义（MEMORIES_ADD 通道），无需新增 IPC 通道。
   */
  private saveEdit(): void {
    const textarea = document.getElementById('memory-detail-content');
    if (!(textarea instanceof HTMLTextAreaElement)) {
      reportError('MemoryPanel saveEdit memory-detail-content 元素缺失', new Error('HTMLTextAreaElement 校验失败'));
      return;
    }

    const newContent = textarea.value.trim();
    // UX-0713-L5：空内容时给出用户反馈，避免静默失败
    if (!newContent) {
      this.host.showToast('内容不能为空', 'warning');
      return;
    }

    const id = this.memoryDetailModal?.dataset.memoryId;
    // P1-6：id 缺失时给出用户反馈，避免静默失败导致用户以为保存成功
    if (!id) {
      this.host.showToast('记忆 ID 缺失，无法保存', 'error');
      reportError('MemoryPanel saveEdit 记忆 ID 缺失', new Error('memoryDetailModal.dataset.memoryId 为空'));
      return;
    }

    this.memoryEditCallback?.(id, newContent);
  }

  /**
   * 切换详情弹窗底部按钮可见性（委托到 memoryDetailPanel helper）
   *
   * 只读模式：显示编辑 + 删除 + 讨论 + 关闭
   * 编辑模式：显示保存 + 取消 + 关闭
   */
  private updateDetailButtons(): void {
    updateDetailButtonsHelper(this.isEditing);
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
    const escaped = escapeHtml(text);

    if (!query) return escaped;

    // 转义正则特殊字符，构建匹配模式（escapeRegExp 统一封装，ADR-017 枝叶层 2 次提取）
    const escapedQuery = escapeRegExp(query);
    const regex = new RegExp(`(${escapedQuery})`, 'gi');

    return escaped.replace(regex, '<mark>$1</mark>');
  }

  /**
   * 切换分析面板（统计洞察 / 健康度诊断，委托到 memoryViewSwitcher helper）
   *
   * - 如果点击的是当前已激活的面板，则关闭它并恢复之前的视图
   * - 如果点击的是不同面板，则切换到新面板（互斥）
   * - 首次打开时记录当前视图模式，关闭时恢复
   *
   * @param panel 目标面板：'insights' 或 'health'
   */
  toggleAnalysisPanel(panel: 'insights' | 'health' | 'completion-stats'): void {
    toggleAnalysisPanelHelper(this.buildViewSwitcherContext(), panel);
  }

  /**
   * 隐藏分析面板并恢复主视图（委托到 memoryViewSwitcher helper）
   *
   * 点击关闭按钮、再次点击菜单项、或切换视图时调用。
   * 恢复打开分析面板前的视图模式。
   */
  hideAnalysisPanel(): void {
    hideAnalysisPanelHelper(this.buildViewSwitcherContext());
  }

  /**
   * 切换面板时关闭分析面板（委托到 memoryViewSwitcher helper）
   *
   * 只隐藏 DOM 元素和重置状态，不恢复视图——因为面板本身将被隐藏，
   * 下次进入记忆面板时默认显示列表视图。
   */
  dismissAnalysisPanels(): void {
    dismissAnalysisPanelsHelper(this.buildViewSwitcherContext());
  }

  /**
   * 切换记忆视图模式（列表 ↔ 时间线 ↔ 图谱，委托到 memoryViewSwitcher helper）
   *
   * 图谱视图使用 Canvas 2D 力导向图渲染记忆关系网络。
   * 时间线视图按天分组记忆列表。
   * 首次切换时延迟初始化渲染器（确保 Canvas DOM 已就绪）。
   * 关系数据为空时隐藏图谱标签，保持列表视图。
   *
   * viewSwitchToken 竞态保护已迁移到 helper，快速切换时仅最后一次生效。
   *
   * @param mode 目标视图模式
   */
  switchView(mode: 'list' | 'timeline' | 'graph'): void {
    switchViewHelper(this.buildViewSwitcherContext(), mode);
  }

  /**
   * 激活图谱视图（由 viewSwitcher 通过 onGraphViewActivated 回调调用）
   *
   * 视图切换 helper 完成容器显隐后委托本方法执行图谱专属初始化：
   * 更新空状态 → 延迟初始化渲染器 → 加载缓存数据并恢复高亮/选中状态。
   */
  private activateGraphView(): void {
    this.updateGraphEmptyState();
    this.initGraphRenderer();
    if (this.graphDataCache) {
      this.graphRenderer?.loadData(this.graphDataCache);
      this.applyCachedGraphState();
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
    // 数据加载后更新空状态（有数据时隐藏空状态提示）
    this.updateGraphEmptyState();
    if (this.viewMode === 'graph' && this.graphRenderer) {
      this.graphRenderer.loadData(data);
      // 数据加载后恢复缓存的高亮/选中状态
      this.applyCachedGraphState();
    }
  }

  /**
   * 更新图谱空状态提示的可见性（委托到 memoryGraphPanel 子模块）
   */
  private updateGraphEmptyState(): void {
    updateGraphEmptyStateHelper(this.buildGraphPanelContext());
  }

  /**
   * 将缓存的高亮/选中状态应用到渲染器（委托到 memoryGraphPanel 子模块）
   */
  private applyCachedGraphState(): void {
    applyCachedGraphStateHelper(this.buildGraphPanelContext());
  }

  /**
   * 检查是否有关系数据（用于决定是否显示图谱标签）
   *
   * @returns 有缓存数据且边数 > 0 时返回 true
   */
  hasGraphData(): boolean {
    return this.graphDataCache !== null && this.graphDataCache.edges.length > 0;
  }

  /**
   * 使图谱数据缓存失效
   *
   * 在记忆 delete/purge/restore/purgeAll/restoreAll/addMemory 等变更节点拓扑的操作后调用，
   * 防止图谱视图显示陈旧数据（已删除节点仍存在、新增节点缺失）。
   *
   * 设计：
   * - 仅清空 graphDataCache，不主动重新请求 IPC（避免无视图谱视图时的无谓请求）
   * - 下次切换到图谱视图时 onViewSwitch 回调会重新请求 getRelationGraph
   * - 若当前已在图谱视图，Controller 应额外调用 loadGraphData 重新加载渲染器
   */
  invalidateGraphCache(): void {
    this.graphDataCache = null;
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

  /** 清除图谱所有高亮和选中状态（委托到 memoryGraphPanel 子模块，含缓存清理） */
  clearGraphHighlights(): void {
    clearGraphHighlightsHelper(this.buildGraphPanelContext());
  }

  /**
   * 延迟初始化图谱渲染器（委托到 memoryGraphPanel 子模块）
   *
   * 首次切换到图谱视图时，Canvas 元素可能尚未渲染，
   * 使用 requestAnimationFrame 延迟一帧确保 DOM 就绪。
   */
  private initGraphRenderer(): void {
    initGraphRendererHelper(this.buildGraphPanelContext());
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
  /** 注册记忆编辑回调 */
  onMemoryEdit(cb: (id: string, content: string) => void): void {
    this.memoryEditCallback = cb;
  }
  /** 注册记忆讨论回调（记忆名称 → 切换到对话面板预填讨论提示） */
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
  /** 注册 LLM 治理回调（G3：dedup/timeliness/conflicts，由 Controller 调用 IPC） */
  onLlmGovernance(cb: (action: 'dedup' | 'timeliness' | 'conflicts') => Promise<void>): void {
    this.llmGovernanceCallback = cb;
  }
  /** 注册视图切换回调（通知Controller切换视图后的业务逻辑） */
  onViewSwitch(cb: (mode: 'list' | 'timeline' | 'graph') => void): void {
    this.viewSwitchCallback = cb;
  }

  /** 注册图谱上下文菜单操作回调 */
  onGraphContextMenuAction(cb: (action: string, nodeId: string) => void): void {
    this.graphContextMenuCallback = cb;
  }

  /** 注册关系编辑/创建回调（sourceId, targetId, type, weight） */
  onRelationEdit(cb: (sourceId: string, targetId: string, type: string, weight: number) => void): void {
    this.relationEditCallback = cb;
  }

  /** 注册关系删除回调 */
  onRelationDelete(cb: (sourceId: string, targetId: string, type: string) => void): void {
    this.relationDeleteCallback = cb;
  }

  /** 注册关系创建回调 */
  onRelationCreate(cb: (sourceId: string, targetId: string, type: string, weight: number) => void): void {
    this.relationCreateCallback = cb;
  }

  /** 注册回收站操作回调（恢复/彻底删除） */
  onRecycleBinAction(cb: (action: 'restore' | 'purge', id: string) => void): void {
    this.recycleBinActionCallback = cb;
  }

  /** 注册回收站批量操作回调（全部恢复/全部清空） */
  onRecycleBinBatchAction(cb: (action: 'restore-all' | 'purge-all') => void): void {
    this.recycleBinBatchActionCallback = cb;
  }

  // ─── 回收站列表渲染 ───────────────────────────────

  /**
   * 渲染回收站列表
   *
   * 缓存完整列表后按页渲染，复用记忆列表的分页模式（MEMORY_PAGE_SIZE + "加载更多"按钮）。
   * 每项结构：header(名称 + 操作按钮) + meta(来源 + 删除时间) + preview(内容预览)
   * 操作按钮通过 data-action + data-memory-id 委托，由 initRecycleBinActions 统一处理
   *
   * @param memories 回收站记忆列表项（已由控制器截断 contentPreview）
   */
  renderRecycleBinList(memories: Array<{ id: string; name: string; source: string; contentPreview: string; deletedAt: string }>): void {
    const listEl = document.getElementById('recycle-bin-list');
    if (!listEl) return;
    // 缓存完整列表 + 重置页码（与 renderMemoryList 分页入口一致）
    this.allRecycleBinMemories = memories;
    this.recycleBinPage = 1;
    this.renderRecycleBinPage();
  }

  /**
   * 渲染回收站当前页（分页策略与 renderMemoryPage 一致）
   *
   * 每页 MEMORY_PAGE_SIZE 条，超出部分通过"加载更多"按钮加载。
   * 空列表时由 CSS :empty::after 显示"回收站为空"。
   */
  private renderRecycleBinPage(): void {
    const listEl = document.getElementById('recycle-bin-list');
    if (!listEl) return;

    const end = this.recycleBinPage * MemoryPanelManager.MEMORY_PAGE_SIZE;
    const pageItems = this.allRecycleBinMemories.slice(0, end);

    // 清空容器（与 renderMemoryPage 统一使用 replaceChildren）
    listEl.replaceChildren();

    for (const mem of pageItems) {
      listEl.appendChild(this.createRecycleBinItem(mem));
    }

    // 还有更多回收站项时添加"加载更多"按钮
    if (this.allRecycleBinMemories.length > end) {
      const loadMoreBtn = createEl('button', 'memory-load-more btn-secondary', `加载更多（剩余 ${this.allRecycleBinMemories.length - end} 条）`);
      this.events.addEventListener(loadMoreBtn, 'click', () => {
        this.recycleBinPage++;
        this.renderRecycleBinPage();
      });
      listEl.appendChild(loadMoreBtn);
    }
  }

  /**
   * 创建单个回收站列表项 DOM 元素（renderRecycleBinPage 的辅助方法）
   *
   * 结构：header(名称 + 恢复/彻底删除按钮) + meta(来源 + 删除时间) + preview(内容预览)
   *
   * @param mem 回收站记忆项数据
   * @returns 完整的回收站项 DOM 元素
   */
  private createRecycleBinItem(mem: { id: string; name: string; source: string; contentPreview: string; deletedAt: string }): HTMLElement {
    const item = createEl('div', 'recycle-bin-item');

    // 头部：名称 + 操作按钮组
    const header = createEl('div', 'recycle-bin-item-header flex-between');

    const nameEl = createEl('div', 'recycle-bin-item-name text-truncate', mem.name); // textContent 防 XSS

    const actions = createEl('div', 'recycle-bin-item-actions flex-shrink-0');

    // 恢复按钮（绿色强调，对应 .health-action-btn 无 danger 类）
    const restoreBtn = createEl('button', 'health-action-btn', '恢复');
    restoreBtn.setAttribute('data-action', 'restore-memory');
    restoreBtn.setAttribute('data-memory-id', mem.id);
    restoreBtn.setAttribute('title', '恢复此记忆到活跃列表');

    // 彻底删除按钮（红色 danger 样式）
    const purgeBtn = createEl('button', 'health-action-btn danger', '彻底删除');
    purgeBtn.setAttribute('data-action', 'purge-memory');
    purgeBtn.setAttribute('data-memory-id', mem.id);
    purgeBtn.setAttribute('title', '永久删除此记忆，不可恢复');

    actions.append(restoreBtn, purgeBtn);
    header.append(nameEl, actions);

    // 元信息：来源 + 删除时间
    const meta = createEl('div', 'recycle-bin-item-meta');

    const sourceEl = createEl('span', 'recycle-bin-item-source', `来源: ${getSourceLabel(mem.source)}`);

    // 格式化删除时间为本地可读日期（复用 formatTimestamp：当天 HH:MM / 昨天 HH:MM / MM-DD HH:MM）
    const deletedAtEl = createEl('span', 'recycle-bin-item-deleted-at', `删除于: ${formatTimestamp(mem.deletedAt)}`);

    meta.append(sourceEl, deletedAtEl);

    // 内容预览
    const previewEl = createEl('div', 'recycle-bin-item-preview', mem.contentPreview); // textContent 防 XSS

    item.append(header, meta, previewEl);
    return item;
  }

  /**
   * 滚动到指定记忆项并高亮（恢复后跳转定位）
   *
   * 从回收站恢复记忆后调用：找到目标记忆卡片，平滑滚动到视图中央，
   * 添加 highlight-pulse 闪烁动画，动画结束后自动移除高亮类。
   * 如果目标元素不存在（如分页未加载），静默降级。
   *
   * @param id 记忆项 ID（对应 DOM 中的 data-id 属性）
   */
  scrollToMemory(id: string): void {
    if (!this.memoryListEl) return;

    // 通过 data-id 属性查找目标记忆卡片
    const target = this.memoryListEl.querySelector(`[data-id="${id}"]`);
    if (!(target instanceof HTMLElement)) return;

    // 平滑滚动到目标元素，居中显示
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // 添加高亮闪烁动画
    target.classList.add('highlight-pulse');

    // 动画结束后自动移除高亮类（CSS animation 时长 1.5s）
    target.addEventListener('animationend', () => {
      target.classList.remove('highlight-pulse');
    }, { once: true });
  }

  // ─── 子渲染器委托方法（InsightsRenderer / HealthDashboardRenderer / PartnerInsightsRenderer） ──

  /** 主题切换时重绘子渲染器 Canvas 图表 */
  repaintOnThemeChange(): void {
    this.partnerInsights.repaintOnThemeChange();
  }

  // ─── InsightsRenderer 委托 ──

  /** 显示洞察面板加载态（委托到 InsightsRenderer） */
  showInsightsLoading(): void {
    this.insights.showLoading();
  }

  /**
   * 渲染记忆洞察数据（委托到 InsightsRenderer）
   *
   * @param dashboard 仪表盘数据子集（total/bySource/conflictCount）
   * @param graph 关系图谱数据
   */
  renderInsights(
    dashboard: { total: number; bySource: Record<string, number>; conflictCount?: number },
    graph: RelationGraphData,
  ): void {
    this.insights.render(dashboard, graph);
  }

  /** 显示洞察面板加载失败状态（委托到 InsightsRenderer，带重试按钮） */
  showInsightsError(): void {
    this.insights.showError();
  }

  /** 注册重试加载洞察数据回调（委托到 InsightsRenderer） */
  onReloadInsights(cb: () => void): void {
    this.insights.onReloadInsights(cb);
  }

  // ─── HealthDashboardRenderer 委托 ──

  /** 显示健康度面板加载态（委托到 HealthDashboardRenderer） */
  showHealthLoading(): void {
    this.healthDashboard.showLoading();
  }

  /**
   * 渲染记忆健康度仪表盘数据（委托到 HealthDashboardRenderer）
   *
   * @param data 健康度数据
   */
  renderHealthDashboard(data: HealthDashboardPayload): void {
    this.healthDashboard.render(data);
  }

  /** 显示健康度面板加载失败状态（委托到 HealthDashboardRenderer） */
  showHealthError(): void {
    this.healthDashboard.showError();
  }

  /** 注册重试加载健康度数据回调（委托到 HealthDashboardRenderer） */
  onReloadHealth(cb: () => void): void {
    this.healthDashboard.onReloadHealth(cb);
  }

  // ─── CompletionStatsRenderer 委托（F2） ──

  /** 渲染补全统计面板（委托到 CompletionStatsRenderer，数据来自 localStorage） */
  renderCompletionStat(): void {
    this.completionStats.render();
  }

  /** 注册重置补全统计回调（委托到 CompletionStatsRenderer） */
  onResetCompletionStats(cb: () => void): void {
    this.completionStats.onResetStats(cb);
  }

  // ─── PartnerInsightsRenderer 委托 ──

  /**
   * 渲染伙伴洞察面板（委托到 PartnerInsightsRenderer）
   *
   * @param memories 全量记忆列表（用于统计和趋势图）
   */
  renderPartnerInsights(memories: Array<{
    id: string;
    name: string;
    source: string;
    contentPreview: string;
    createdAt?: string;
  }>): void {
    this.partnerInsights.render(memories);
  }

  /**
   * 注册伙伴洞察面板记忆点击回调（委托到 PartnerInsightsRenderer）
   */
  onPartnerMemoryClick(cb: (memoryId: string) => void): void {
    this.partnerInsights.onMemoryClick(cb);
  }

  // ─── 视图切换 / 时间线子系统上下文构建 ─────────────

  /**
   * 构建视图切换子系统的依赖注入容器
   *
   * 将 MemoryPanelManager 的视图状态字段（viewMode / previousViewMode /
   * activeAnalysisPanel / viewSwitchToken）通过 getter/setter 暴露给
   * memoryViewSwitcher helper，保持状态所有权在 MemoryPanelManager。
   *
   * 视图内容渲染（timeline / graph）通过回调委托回 manager，
   * 避免 helper 引入对时间线 / 图谱子系统的依赖。
   */
  private buildViewSwitcherContext(): MemoryViewSwitcherContext {
    return {
      memoryListEl: this.memoryListEl,
      getViewMode: () => this.viewMode,
      setViewMode: (mode) => { this.viewMode = mode; },
      getPreviousViewMode: () => this.previousViewMode,
      setPreviousViewMode: (mode) => { this.previousViewMode = mode; },
      getActiveAnalysisPanel: () => this.activeAnalysisPanel,
      setActiveAnalysisPanel: (panel) => { this.activeAnalysisPanel = panel; },
      getViewSwitchToken: () => this.viewSwitchToken,
      incrementViewSwitchToken: () => ++this.viewSwitchToken,
      onTimelineViewActivated: () => { this.renderTimeline(); },
      onGraphViewActivated: () => { this.activateGraphView(); },
      getMoreMenuActionCallback: () => this.moreMenuActionCallback,
    };
  }

  /**
   * 构建时间线视图子系统的依赖注入容器
   *
   * 将记忆列表缓存和搜索关键词通过 context 暴露给 memoryTimelineView helper，
   * 文本高亮通过回调复用 manager 的 highlightText 实现（避免逻辑重复）。
   */
  private buildTimelineContext(): MemoryTimelineContext {
    return {
      allMemories: this.allMemories,
      currentSearchQuery: this.currentSearchQuery,
      highlightText: (text, query) => this.highlightText(text, query),
    };
  }

  // ─── 图谱视图子系统上下文构建 ─────────────

  /**
   * 构建图谱视图子系统的依赖注入容器
   *
   * 将 MemoryPanelManager 的图谱状态字段和回调通过 getter/setter 暴露给
   * memoryGraphPanel 子模块，保持状态所有权在 MemoryPanelManager，
   * 同时让 helper 能以纯函数方式访问状态和注册回调。
   */
  private buildGraphPanelContext(): MemoryGraphPanelContext {
    return {
      host: this.host,
      getGraphRenderer: () => this.graphRenderer,
      setGraphRenderer: (renderer) => { this.graphRenderer = renderer; },
      getGraphDataCache: () => this.graphDataCache,
      setGraphDataCache: (data) => { this.graphDataCache = data; },
      getCachedHighlightedNodeIds: () => this.cachedHighlightedNodeIds,
      setCachedHighlightedNodeIds: (ids) => { this.cachedHighlightedNodeIds = ids; },
      getCachedSelectedNodeId: () => this.cachedSelectedNodeId,
      setSelectedNodeId: (id) => { this.cachedSelectedNodeId = id; },
      getGraphContextMenuCloseHandler: () => this.graphContextMenuCloseHandler,
      setGraphContextMenuCloseHandler: (handler) => { this.graphContextMenuCloseHandler = handler; },
      getGraphContextMenuKeyHandler: () => this.graphContextMenuKeyHandler,
      setGraphContextMenuKeyHandler: (handler) => { this.graphContextMenuKeyHandler = handler; },
      getMemoryClickCallback: () => this.memoryClickCallback,
      getGraphContextMenuCallback: () => this.graphContextMenuCallback,
      getRelationEditCallback: () => this.relationEditCallback,
      getRelationDeleteCallback: () => this.relationDeleteCallback,
      getRelationCreateCallback: () => this.relationCreateCallback,
    };
  }

  /**
   * 构建记忆详情子系统的依赖注入容器
   *
   * 将 MemoryPanelManager 的详情状态字段和回调通过 getter/setter 暴露给
   * memoryDetailPanel helper，保持状态所有权在 MemoryPanelManager。
   */
  private buildDetailPanelContext(): MemoryDetailPanelContext {
    return {
      host: this.host,
      events: this.events,
      getIsEditing: () => this.isEditing,
      setIsEditing: (editing) => { this.isEditing = editing; },
      getMemoryDetailModal: () => this.memoryDetailModal,
      getMemoryClickCallback: () => this.memoryClickCallback,
    };
  }
}
