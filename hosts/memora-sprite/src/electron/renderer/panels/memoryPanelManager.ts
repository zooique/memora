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

import { getOptionalElement, clearElement, formatTimeAgo, formatTimestamp } from '../helpers/domHelpers.js';
import type { EventTracker } from '../helpers/eventTracker.js';
import type { MemoryListItem, MemoryDetail, ConfirmDialogOptions, ToastType } from '../types.js';
import { RelationGraphRenderer } from '../components/relationGraph.js';
import type { RelationGraphData } from '../components/relationGraph.js';
// AUTO-HEALTH-05：事件监听器注册逻辑提取到独立 helper（降低本文件体量）
import { initMemoryPanelListeners as initMemoryPanelListenersImpl } from '../helpers/memoryPanelEvents.js';
import type { MemoryPanelEventContext } from '../helpers/memoryPanelEvents.js';

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
  /** 打开分析面板（统计洞察/健康度诊断）前的视图模式，关闭时恢复 */
  private previousViewMode: 'list' | 'timeline' | 'graph' = 'list';
  /** 当前激活的分析面板：null 表示无，'insights' / 'health' */
  private activeAnalysisPanel: 'insights' | 'health' | null = null;
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
// ─── 清理对话框状态 ────────────────────────────────────
  /** 待清理的记忆 ID 列表（确认对话框中使用） */
  private pendingCleanupIds: string[] = [];
  /** P2-UI-3.2：视图切换令牌，防止快速切换时 setTimeout 回调竞态导致空白 */
  private viewSwitchToken = 0;

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
    // AUTO-HEALTH-05：事件监听器注册逻辑提取到 helpers/memoryPanelEvents.ts
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
      getViewSwitchCallback: () => this.viewSwitchCallback,
      // 回收站操作回调读取器
      getRecycleBinActionCallback: () => this.recycleBinActionCallback,
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
  /** 脉冲感知面板中的叙事摘要 */
  pulseNarrativeCard(): void {
    const narrativeEl = document.getElementById('perception-narrative-text');
    if (!narrativeEl) return;

    // 添加短暂高亮效果
    narrativeEl.classList.add('narrative-pulse');
    setTimeout(() => narrativeEl.classList.remove('narrative-pulse'), 1500);
  }

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
      // 同时添加 .btn-secondary 类复用通用按钮样式
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
    if (!container) return;

    // 无记忆数据时显示空状态
    if (!this.allMemories || this.allMemories.length === 0) {
      while (container.firstChild) {
        container.removeChild(container.firstChild);
      }
      const empty = document.createElement('div');
      empty.className = 'timeline-empty';
      empty.innerHTML = `
        <span class="empty-icon">⏳</span>
        <span class="empty-title">暂无时间线数据</span>
        <span class="empty-subtitle">开始对话后，记忆将按时间自动组织</span>
      `;
      container.appendChild(empty);
      return;
    }

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
    const relationsEl = document.getElementById('memory-detail-relations');
    const relationsListEl = document.getElementById('memory-relations-list');

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

    // 渲染关联记忆列表
    if (relationsEl && relationsListEl) {
      if (memory.relations.length > 0) {
        relationsEl.classList.remove('hidden');
        // 使用 clearElement 替代 innerHTML=''，遵循统一 DOM 操作模式
        clearElement(relationsListEl);
        for (const rel of memory.relations) {
          const item = document.createElement('div');
          item.className = `relation-item relation-type-${rel.type}`;
          item.dataset.memoryId = rel.targetId;
          item.setAttribute('tabindex', '0');
          item.setAttribute('role', 'button');

          const typeTag = document.createElement('span');
          typeTag.className = `relation-type-tag relation-type-${rel.type}`;
          typeTag.textContent = rel.type;

          const nameSpan = document.createElement('span');
          nameSpan.className = 'relation-target-name';
          nameSpan.textContent = rel.targetName;

          const weightSpan = document.createElement('span');
          weightSpan.className = 'relation-weight';
          weightSpan.textContent = `w:${rel.weight.toFixed(2)}`;

          item.appendChild(typeTag);
          item.appendChild(nameSpan);
          item.appendChild(weightSpan);

          // 点击关联记忆 → 触发 memoryClickCallback 查看该记忆详情
          const openRelation = () => {
            if (this.memoryClickCallback) {
              this.memoryClickCallback(rel.targetId);
            }
          };
          item.addEventListener('click', openRelation);
          item.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              openRelation();
            }
          });

          relationsListEl.appendChild(item);
        }
      } else {
        relationsEl.classList.add('hidden');
      }
    }

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
   * 隐藏所有视图容器（list/timeline/graph）
   *
   * 当激活 insights 或 health 显示类型时调用，
   * 确保显示类型互斥切换，避免平铺污染。
   */
  private hideAllDisplayViews(): void {
    const listEl = this.memoryListEl;
    const graphEl = document.getElementById('memory-graph-container');
    const timelineEl = document.getElementById('memory-timeline-container');
    if (listEl) listEl.classList.add('hidden');
    if (graphEl) graphEl.classList.add('hidden');
    if (timelineEl) timelineEl.classList.add('hidden');
  }

  /**
   * 轻量隐藏分析面板（不恢复视图）
   *
   * 供 switchView() 调用——切换视图时只需要关闭分析面板UI，
   * 不需要恢复 previousViewMode（因为 switchView 本身会切换到新视图）。
   * X按钮和菜单项toggle请使用 hideAnalysisPanel()（会恢复之前的视图）。
   */
  private hideInsightsAndHealth(): void {
    const insightsBar = document.getElementById('memory-insights-bar');
    const healthBar = document.getElementById('memory-health-bar');
    const partnerInsights = document.getElementById('partner-insights');
    if (insightsBar) insightsBar.classList.add('hidden');
    if (healthBar) healthBar.classList.add('hidden');
    if (partnerInsights) partnerInsights.classList.add('hidden');
    this.activeAnalysisPanel = null;
    this.updateAnalysisMenuItemsActive();
  }

  /**
   * 显示指定视图容器
   *
   * @param mode 要显示的视图模式
   */
  private showDisplayView(mode: 'list' | 'timeline' | 'graph'): void {
    const listEl = this.memoryListEl;
    const graphEl = document.getElementById('memory-graph-container');
    const timelineEl = document.getElementById('memory-timeline-container');
    if (listEl) listEl.classList.toggle('hidden', mode !== 'list');
    if (graphEl) graphEl.classList.toggle('hidden', mode !== 'graph');
    if (timelineEl) timelineEl.classList.toggle('hidden', mode !== 'timeline');
  }

  /**
   * 更新分析面板菜单项的激活状态
   *
   * 打开分析面板时高亮对应菜单项，关闭时取消高亮。
   */
  private updateAnalysisMenuItemsActive(): void {
    const moreMenu = document.getElementById('memory-more-menu');
    if (!moreMenu) return;
    const items = moreMenu.querySelectorAll('.more-menu-item');
    items.forEach((item) => {
      const action = item.getAttribute('data-action');
      const isActive = action === this.activeAnalysisPanel;
      item.classList.toggle('active', isActive);
    });
  }

  /**
   * 切换分析面板（统计洞察 / 健康度诊断）
   *
   * - 如果点击的是当前已激活的面板，则关闭它并恢复之前的视图
   * - 如果点击的是不同面板，则切换到新面板（互斥）
   * - 首次打开时记录当前视图模式，关闭时恢复
   *
   * @param panel 目标面板：'insights' 或 'health'
   */
  toggleAnalysisPanel(panel: 'insights' | 'health'): void {
    const insightsBar = document.getElementById('memory-insights-bar');
    const healthBar = document.getElementById('memory-health-bar');
    const partnerInsights = document.getElementById('partner-insights');
    const targetBar = panel === 'insights' ? insightsBar : healthBar;
    const otherBar = panel === 'insights' ? healthBar : insightsBar;

    if (!targetBar) return;

    const isAlreadyActive = this.activeAnalysisPanel === panel;

    if (isAlreadyActive) {
      // 再次点击当前面板 → 关闭
      this.hideAnalysisPanel();
      return;
    }

    // 打开新面板：记录当前视图（如果之前没有激活的面板）
    if (this.activeAnalysisPanel === null) {
      this.previousViewMode = this.viewMode;
    }

    // 隐藏主视图和另一个面板
    this.hideAllDisplayViews();
    if (otherBar) otherBar.classList.add('hidden');
    // 打开health时隐藏partner-insights（它是insights的子内容）
    if (panel === 'health' && partnerInsights) {
      partnerInsights.classList.add('hidden');
    }

    // 显示目标面板
    targetBar.classList.remove('hidden');
    this.activeAnalysisPanel = panel;

    // 更新菜单项高亮
    this.updateAnalysisMenuItemsActive();

    // 触发数据加载回调
    this.moreMenuActionCallback?.(panel);
  }

  /**
   * 隐藏分析面板并恢复主视图
   *
   * 点击关闭按钮、再次点击菜单项、或切换视图时调用。
   * 恢复打开分析面板前的视图模式。
   */
  hideAnalysisPanel(): void {
    const insightsBar = document.getElementById('memory-insights-bar');
    const healthBar = document.getElementById('memory-health-bar');
    const partnerInsights = document.getElementById('partner-insights');
    if (insightsBar) insightsBar.classList.add('hidden');
    if (healthBar) healthBar.classList.add('hidden');
    if (partnerInsights) partnerInsights.classList.add('hidden');

    // 恢复之前的主视图
    if (this.activeAnalysisPanel !== null) {
      this.showDisplayView(this.previousViewMode);
      this.viewMode = this.previousViewMode;
      this.activeAnalysisPanel = null;

      // 同步视图切换按钮状态
      const listBtn = document.getElementById('btn-list-view');
      const timelineBtn = document.getElementById('btn-timeline-view');
      const graphBtn = document.getElementById('btn-graph-view');
      if (listBtn) {
        listBtn.classList.toggle('active', this.viewMode === 'list');
        listBtn.setAttribute('aria-selected', String(this.viewMode === 'list'));
      }
      if (timelineBtn) {
        timelineBtn.classList.toggle('active', this.viewMode === 'timeline');
        timelineBtn.setAttribute('aria-selected', String(this.viewMode === 'timeline'));
      }
      if (graphBtn) {
        graphBtn.classList.toggle('active', this.viewMode === 'graph');
        graphBtn.setAttribute('aria-selected', String(this.viewMode === 'graph'));
      }
    }

    // 更新菜单项高亮
    this.updateAnalysisMenuItemsActive();
  }

  /**
   * 切换面板时关闭分析面板（公开方法，供 UI 层在离开记忆面板时调用）
   *
   * 只隐藏 DOM 元素和重置状态，不恢复视图——因为面板本身将被隐藏，
   * 下次进入记忆面板时默认显示列表视图。
   */
  dismissAnalysisPanels(): void {
    const insightsBar = document.getElementById('memory-insights-bar');
    const healthBar = document.getElementById('memory-health-bar');
    const partnerInsights = document.getElementById('partner-insights');
    if (insightsBar) insightsBar.classList.add('hidden');
    if (healthBar) healthBar.classList.add('hidden');
    if (partnerInsights) partnerInsights.classList.add('hidden');
    // 重置内部状态：下次打开时重新记录 previousViewMode
    this.activeAnalysisPanel = null;
    this.viewMode = 'list';
    this.updateAnalysisMenuItemsActive();
    // 同步视图按钮状态到列表
    const listBtn = document.getElementById('btn-list-view');
    const timelineBtn = document.getElementById('btn-timeline-view');
    const graphBtn = document.getElementById('btn-graph-view');
    if (listBtn) { listBtn.classList.add('active'); listBtn.setAttribute('aria-selected', 'true'); }
    if (timelineBtn) { timelineBtn.classList.remove('active'); timelineBtn.setAttribute('aria-selected', 'false'); }
    if (graphBtn) { graphBtn.classList.remove('active'); graphBtn.setAttribute('aria-selected', 'false'); }
  }

  /**
   * 更新更多菜单中视图切换项的 active 状态
   *
   * 切换视图时，标记当前视图对应的菜单项为 active，
   * 让用户通过菜单直观感知当前所处视图模式。
   *
   * @param mode 当前视图模式
   */
  private updateViewMenuItemsActive(mode: 'list' | 'timeline' | 'graph'): void {
    const moreMenu = document.getElementById('memory-more-menu');
    if (!moreMenu) return;
    const items = moreMenu.querySelectorAll('.more-menu-item');
    items.forEach((item) => {
      const action = item.getAttribute('data-action');
      // 仅视图切换项参与 active 标记（advanced-search/insights/health 不参与）
      const isActive = action === `view-${mode}`;
      item.classList.toggle('active', isActive);
    });
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
    // P2-UI-3.2：递增视图切换令牌，过期 setTimeout 回调会被忽略
    const token = ++this.viewSwitchToken;

    // 切换视图时隐藏 insights/health，避免显示类型平铺污染
    this.hideInsightsAndHealth();
    // 同步更多菜单中视图切换项的 active 状态
    this.updateViewMenuItemsActive(mode);

    // B2: 切换列表、时间线和图谱容器的可见性，统一用 .hidden 类
    const listEl = this.memoryListEl;
    const graphEl = document.getElementById('memory-graph-container');
    const timelineEl = document.getElementById('memory-timeline-container');

    // 视图切换过渡动画：先退出旧视图，再进入新视图
    const allViews = [listEl, graphEl, timelineEl].filter(Boolean) as HTMLElement[];

    // 当前可见的视图 → 添加退出动画
    const currentView = allViews.find(v => !v.classList.contains('hidden'));
    if (currentView) {
      currentView.classList.add('memory-view-exit');
    }

    // 延迟切换视图（等待退出动画完成）
    const TRANSITION_DURATION = 150; // 与 CSS --transition-base (0.15s) 一致
    setTimeout(() => {
      // P2-UI-3.2：令牌检查——若期间有新 switchView 调用，本回调作废
      if (token !== this.viewSwitchToken) return;
      // 移除所有视图的退出态
      allViews.forEach(v => v.classList.remove('memory-view-exit'));

      if (mode === 'list') {
        if (listEl) {
          listEl.classList.remove('hidden');
          listEl.classList.add('memory-view-enter');
        }
        if (graphEl) graphEl.classList.add('hidden');
        if (timelineEl) timelineEl.classList.add('hidden');
      } else if (mode === 'timeline') {
        if (listEl) listEl.classList.add('hidden');
        if (graphEl) graphEl.classList.add('hidden');
        if (timelineEl) {
          timelineEl.classList.remove('hidden');
          timelineEl.classList.add('memory-view-enter');
          this.renderTimeline();
        }
      } else {
        if (listEl) listEl.classList.add('hidden');
        if (timelineEl) timelineEl.classList.add('hidden');
        if (graphEl) {
          graphEl.classList.remove('hidden');
          graphEl.classList.add('memory-view-enter');
          this.updateGraphEmptyState();
          this.initGraphRenderer();
          if (this.graphDataCache) {
            this.graphRenderer?.loadData(this.graphDataCache);
            this.applyCachedGraphState();
          }
        }
      }

      // 动画完成后移除进入类
      setTimeout(() => {
        // P2-UI-3.2：内层回调同样检查令牌
        if (token !== this.viewSwitchToken) return;
        allViews.forEach(v => v.classList.remove('memory-view-enter'));
      }, TRANSITION_DURATION);
    }, TRANSITION_DURATION);
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
   * 更新图谱空状态提示的可见性
   *
   * 规则：
   * - 无缓存数据 或 节点数为 0 → 显示空状态
   * - 有数据（nodes > 0）→ 隐藏空状态
   */
  private updateGraphEmptyState(): void {
    const emptyEl = document.getElementById('memory-graph-empty');
    if (!emptyEl) return;
    const hasData = this.graphDataCache !== null && this.graphDataCache.nodes.length > 0;
    emptyEl.classList.toggle('hidden', hasData);
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

    // 节点右键菜单回调：显示上下文菜单
    this.graphRenderer.setOnNodeContextMenu((nodeId: string, x: number, y: number) => {
      this.showGraphContextMenu(nodeId, x, y);
    });

    // 边点击回调：打开关系编辑弹窗
    this.graphRenderer.setOnEdgeClick((sourceId: string, targetId: string, type: string, weight: number) => {
      this.showRelationEditDialog(sourceId, targetId, type, weight);
    });

    // 手动连线创建回调：打开关系创建弹窗
    this.graphRenderer.setOnConnectionCreate((sourceId: string, targetId: string) => {
      this.showRelationCreateDialog(sourceId, targetId);
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

  // ─── 回收站列表渲染 ───────────────────────────────

  /**
   * 渲染回收站列表
   *
   * 每项结构：header(名称 + 操作按钮) + meta(来源 + 删除时间) + preview(内容预览)
   * 操作按钮通过 data-action + data-memory-id 委托，由 initRecycleBinActions 统一处理
   *
   * @param memories 回收站记忆列表项（已由控制器截断 contentPreview）
   */
  renderRecycleBinList(memories: Array<{ id: string; name: string; source: string; contentPreview: string; deletedAt: string }>): void {
    const listEl = document.getElementById('recycle-bin-list');
    if (!listEl) return;
    // 统一使用 replaceChildren 清空（遵循渲染器统一操作模式，不直接操作 innerHTML）
    listEl.replaceChildren();

    if (memories.length === 0) {
      // 空状态由 CSS :empty::after 显示"回收站为空"，无需额外 DOM
      return;
    }

    for (const mem of memories) {
      const item = document.createElement('div');
      item.className = 'recycle-bin-item';

      // 头部：名称 + 操作按钮组
      const header = document.createElement('div');
      header.className = 'recycle-bin-item-header';

      const nameEl = document.createElement('div');
      nameEl.className = 'recycle-bin-item-name';
      nameEl.textContent = mem.name; // textContent 防 XSS

      const actions = document.createElement('div');
      actions.className = 'recycle-bin-item-actions';

      // 恢复按钮（绿色强调，对应 .health-action-btn 无 danger 类）
      const restoreBtn = document.createElement('button');
      restoreBtn.className = 'health-action-btn';
      restoreBtn.textContent = '恢复';
      restoreBtn.setAttribute('data-action', 'restore-memory');
      restoreBtn.setAttribute('data-memory-id', mem.id);
      restoreBtn.setAttribute('title', '恢复此记忆到活跃列表');

      // 彻底删除按钮（红色 danger 样式）
      const purgeBtn = document.createElement('button');
      purgeBtn.className = 'health-action-btn danger';
      purgeBtn.textContent = '彻底删除';
      purgeBtn.setAttribute('data-action', 'purge-memory');
      purgeBtn.setAttribute('data-memory-id', mem.id);
      purgeBtn.setAttribute('title', '永久删除此记忆，不可恢复');

      actions.append(restoreBtn, purgeBtn);
      header.append(nameEl, actions);

      // 元信息：来源 + 删除时间
      const meta = document.createElement('div');
      meta.className = 'recycle-bin-item-meta';

      const sourceEl = document.createElement('span');
      sourceEl.className = 'recycle-bin-item-source';
      sourceEl.textContent = `来源: ${mem.source}`;

      const deletedAtEl = document.createElement('span');
      deletedAtEl.className = 'recycle-bin-item-deleted-at';
      // 格式化删除时间为本地可读日期（复用 formatTimestamp：当天 HH:MM / 昨天 HH:MM / MM-DD HH:MM）
      deletedAtEl.textContent = `删除于: ${formatTimestamp(mem.deletedAt)}`;

      meta.append(sourceEl, deletedAtEl);

      // 内容预览
      const previewEl = document.createElement('div');
      previewEl.className = 'recycle-bin-item-preview';
      previewEl.textContent = mem.contentPreview; // textContent 防 XSS

      item.append(header, meta, previewEl);
      listEl.append(item);
    }
  }

  // ─── 图谱上下文菜单 ─────────────────────────────────────────

  /**
   * 显示节点右键上下文菜单
   *
   * 菜单选项：聚焦子图 / 查看详情 / 创建连线 / 复制 ID
   *
   * @param nodeId 被右键的节点 ID
   * @param x 菜单显示位置（屏幕 X）
   * @param y 菜单显示位置（屏幕 Y）
   */
  private showGraphContextMenu(nodeId: string, x: number, y: number): void {
    // 隐藏已有的菜单
    this.hideGraphContextMenu();

    const menu = document.getElementById('graph-context-menu');
    if (!menu) return;
// 绑定菜单项点击事件
    const focusItem = menu.querySelector('[data-action="focus-subgraph"]');
    const detailItem = menu.querySelector('[data-action="view-detail"]');
    const connectItem = menu.querySelector('[data-action="connect-from"]');
    const copyItem = menu.querySelector('[data-action="copy-id"]');

    const handler = (action: string) => {
      this.hideGraphContextMenu();
      this.graphContextMenuCallback?.(action, nodeId);
    };

    if (focusItem) focusItem.addEventListener('click', () => handler('focus-subgraph'), { once: true });
    if (detailItem) detailItem.addEventListener('click', () => handler('view-detail'), { once: true });
    if (connectItem) connectItem.addEventListener('click', () => handler('connect-from'), { once: true });
    if (copyItem) copyItem.addEventListener('click', () => handler('copy-id'), { once: true });

    // 定位菜单（避免超出视口）
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.classList.remove('hidden');

    // 点击菜单外部关闭
    const closeHandler = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) {
        this.hideGraphContextMenu();
        document.removeEventListener('click', closeHandler);
      }
    };
    setTimeout(() => document.addEventListener('click', closeHandler), 0);
  }

  /** 隐藏图谱上下文菜单 */
  private hideGraphContextMenu(): void {
    const menu = document.getElementById('graph-context-menu');
    if (menu) {
      menu.classList.add('hidden');
    }
  }

  // ─── 关系编辑弹窗 ──────────────────────────────────────────

  /**
   * 显示关系编辑弹窗（点击已有边 → 编辑/删除）
   *
   * @param sourceId 关系起点
   * @param targetId 关系终点
   * @param type 当前关系类型
   * @param weight 当前权重
   */
  private showRelationEditDialog(sourceId: string, targetId: string, type: string, weight: number): void {
    const dialog = document.getElementById('relation-edit-dialog');
    if (!dialog) return;

    // P0-UI-6.1：重置 UI 状态（防御性，处理 Escape 走 modal.ts hideModal 路径留下的残留）
    const deleteBtnReset = dialog.querySelector('#relation-edit-delete') as HTMLElement | null;
    const titleElReset = dialog.querySelector('.relation-edit-title') as HTMLElement | null;
    if (deleteBtnReset) deleteBtnReset.classList.remove('hidden');
    if (titleElReset) titleElReset.textContent = '编辑关系';

    // 填充当前值
    const typeSelect = dialog.querySelector('#relation-edit-type') as HTMLSelectElement | null;
    const weightInput = dialog.querySelector('#relation-edit-weight') as HTMLInputElement | null;
    const weightValue = dialog.querySelector('#relation-edit-weight-value') as HTMLElement | null;

    if (typeSelect) typeSelect.value = type;
    if (weightInput) {
      weightInput.value = String(weight);
      if (weightValue) weightValue.textContent = String(Math.round(weight * 100));
    }

    // 绑定保存
    const saveBtn = dialog.querySelector('#relation-edit-save') as HTMLElement | null;
    if (saveBtn) {
      saveBtn.onclick = () => {
        const newType = typeSelect?.value || type;
        const newWeight = weightInput ? parseFloat(weightInput.value) : weight;
        this.relationEditCallback?.(sourceId, targetId, newType, newWeight);
        this.hideRelationEditDialog();
      };
    }

    // 绑定删除
    const deleteBtn = dialog.querySelector('#relation-edit-delete') as HTMLElement | null;
    if (deleteBtn) {
      deleteBtn.onclick = () => {
        this.relationDeleteCallback?.(sourceId, targetId, type);
        this.hideRelationEditDialog();
      };
    }

    // 绑定取消
    const cancelBtn = dialog.querySelector('#relation-edit-cancel') as HTMLElement | null;
    if (cancelBtn) {
      cancelBtn.onclick = () => this.hideRelationEditDialog();
    }

    // P0-UI-6.1：背景遮罩点击关闭（与 .modal 类的 Escape 监听配套）
    const overlay = dialog.querySelector('.relation-edit-dialog-overlay') as HTMLElement | null;
    if (overlay) {
      overlay.onclick = () => this.hideRelationEditDialog();
    }

    // 权重滑块联动
    if (weightInput && weightValue) {
      weightInput.oninput = () => {
        weightValue.textContent = String(Math.round(parseFloat(weightInput.value) * 100));
      };
    }

    dialog.classList.remove('hidden');
  }

  /**
   * 显示关系创建弹窗（Ctrl+拖拽连线 → 创建新关系）
   *
   * @param sourceId 连线起点节点 ID
   * @param targetId 连线终点节点 ID
   */
  private showRelationCreateDialog(sourceId: string, targetId: string): void {
    const dialog = document.getElementById('relation-edit-dialog');
    if (!dialog) return;

    // 重置为默认值
    const typeSelect = dialog.querySelector('#relation-edit-type') as HTMLSelectElement | null;
    const weightInput = dialog.querySelector('#relation-edit-weight') as HTMLInputElement | null;
    const weightValue = dialog.querySelector('#relation-edit-weight-value') as HTMLElement | null;
    const deleteBtn = dialog.querySelector('#relation-edit-delete') as HTMLElement | null;
    const titleEl = dialog.querySelector('.relation-edit-title') as HTMLElement | null;

    // 创建模式下隐藏删除按钮，标题改为"创建关系"
    if (deleteBtn) deleteBtn.classList.add('hidden');
    if (titleEl) titleEl.textContent = '创建关系';
    if (typeSelect) typeSelect.value = 'related';
    if (weightInput) {
      weightInput.value = '0.5';
      if (weightValue) weightValue.textContent = '50';
    }

    // 绑定保存
    const saveBtn = dialog.querySelector('#relation-edit-save') as HTMLElement | null;
    if (saveBtn) {
      saveBtn.onclick = () => {
        const newType = typeSelect?.value || 'related';
        const newWeight = weightInput ? parseFloat(weightInput.value) : 0.5;
        this.relationCreateCallback?.(sourceId, targetId, newType, newWeight);
        this.hideRelationEditDialog();
      };
    }

    // 绑定取消
    const cancelBtn = dialog.querySelector('#relation-edit-cancel') as HTMLElement | null;
    if (cancelBtn) {
      cancelBtn.onclick = () => this.hideRelationEditDialog();
    }

    // P0-UI-6.1：背景遮罩点击关闭（与 .modal 类的 Escape 监听配套）
    const overlay = dialog.querySelector('.relation-edit-dialog-overlay') as HTMLElement | null;
    if (overlay) {
      overlay.onclick = () => this.hideRelationEditDialog();
    }

    // 权重滑块联动
    if (weightInput && weightValue) {
      weightInput.oninput = () => {
        weightValue.textContent = String(Math.round(parseFloat(weightInput.value) * 100));
      };
    }

    dialog.classList.remove('hidden');
  }

  /** 隐藏关系编辑弹窗，恢复默认状态 */
  private hideRelationEditDialog(): void {
    const dialog = document.getElementById('relation-edit-dialog');
    if (!dialog) return;
    dialog.classList.add('hidden');

    // 恢复默认 UI（删除按钮、标题）
    const deleteBtn = dialog.querySelector('#relation-edit-delete') as HTMLElement | null;
    const titleEl = dialog.querySelector('.relation-edit-title') as HTMLElement | null;
    if (deleteBtn) deleteBtn.classList.remove('hidden');
    if (titleEl) titleEl.textContent = '编辑关系';
  }
}