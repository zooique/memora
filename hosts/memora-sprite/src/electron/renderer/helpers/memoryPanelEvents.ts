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
// STEP9-IMPORTS-01 反向 type-only 引用：编译期擦除，禁止改为 value import（否则与 memoryPanelManager 形成运行时循环依赖）
import type { MemoryPanelHost } from '../panels/memoryPanelManager.js';
// 统一导航区块类型（rail 单一真相），type-only 引用避免运行时循环依赖
import type { MemorySection } from './memoryViewSwitcher.js';

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
 * 添加记忆 source 黑名单
 *
 * persona/skill/rule 三种类型有独立的设定模块入口（对话工具 create_persona/
 * create_skill/create_rule + 设置面板 CRUD），通过"添加记忆"创建会导致：
 *   1. 只写入 SQLite 不写入配置文件（非持久化，重启后靠 MemoryLoader 扫描）
 *   2. 不触发 personaWatcher 热重载，UI 不可见
 *   3. frontmatter 缺少 keywords/description 字段，关键词匹配不生效
 * 因此在表单校验层直接拒绝，引导用户走设定模块。
 */
const BLOCKED_SOURCES: ReadonlySet<string> = new Set(['persona', 'skill', 'rule']);

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
  /** 退出编辑模式，恢复原始内容（强制退出，无未保存提示） */
  exitEditMode(): void;
  /** 检查未保存修改并按需弹确认对话框后退出编辑模式（取消按钮/Esc 触发） */
  confirmExitEditMode(): Promise<void>;
  /**
   * 处理关闭请求（关闭按钮/backdrop 触发）
   * 编辑模式下：弹确认对话框，用户放弃修改后返回 true，保留修改返回 false
   * 非编辑模式：直接返回 true
   */
  handleCloseRequest(): Promise<boolean>;
  /** 读取编辑模式状态（capture phase 拦截关闭按钮/backdrop 时判断） */
  getIsEditing(): boolean;
  /** 保存编辑内容，通过回调通知宿主层 */
  saveEdit(): void;
  /** 切换分析面板（insights/health/completion-stats 互斥） */
  toggleAnalysisPanel(panel: 'insights' | 'health' | 'completion-stats'): void;
  /** 隐藏分析面板并恢复主视图 */
  hideAnalysisPanel(): void;
  /** 切换视图模式（list/timeline/graph） */
  switchView(mode: 'list' | 'timeline' | 'graph'): void;
  /** 设置当前激活区块（统一导航，rail 点击委托至此） */
  setSection(section: MemorySection): void;
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
  /** 回收站操作回调（恢复/彻底删除，Promise 用于事件委托层包装 loading） */
  getRecycleBinActionCallback(): ((action: 'restore' | 'purge', id: string) => Promise<void>) | null;
  /** 回收站批量操作回调（全部恢复/全部清空，Promise 用于事件委托层包装 loading） */
  getRecycleBinBatchActionCallback(): ((action: 'restore-all' | 'purge-all') => Promise<void>) | null;
  /** 更多菜单操作回调（insights/health/recycle-bin） */
  getMoreMenuActionCallback(): ((action: string) => void) | null;
  /** LLM 记忆治理回调（dedup/timeliness/conflicts，由 Controller 调用 IPC） */
  getLlmGovernanceCallback(): ((action: 'dedup' | 'timeliness' | 'conflicts') => Promise<void>) | null;
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
  initAnalysisPanelClose(ctx);
  initMemoryRail(ctx);
  initCleanupDialog(ctx);
  // 回收站列表事件委托（恢复/彻底删除按钮）
  initRecycleBinActions(ctx);
  // 回收站批量操作（全部恢复/全部清空）
  initRecycleBinBatchActions(ctx);
  // LLM 记忆治理（语义去重/时效性评估/冲突检测）
  initLlmGovernanceActions(ctx);
}

// ─── 10. LLM 记忆治理 ───────────────────────────────

/**
 * LLM 治理按钮事件绑定（语义去重/时效性评估/冲突检测）。
 *
 * 与清理按钮（initCleanupDialog）的差异：
 * - 清理：纯代码软删除，同步执行，需确认对话框
 * - LLM 治理：异步 LLM 调用（5-15 秒），无需确认（仅降级 score 不物理删除，
 *   用户可通过回收站 restore 恢复），直接执行 + loading 态 + toast 反馈
 *
 * 按钮点击期间禁用并显示 loading 文案，防止重复提交。
 * 失败由 Controller 内部 toast 反馈，此处不补 toast（避免重复）。
 */
function initLlmGovernanceActions(ctx: MemoryPanelEventContext): void {
  const bindLlmBtn = (btnId: string, action: 'dedup' | 'timeliness' | 'conflicts', loadingText: string): void => {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    ctx.events.addEventListener(btn, 'click', async () => {
      if (!(btn instanceof HTMLButtonElement)) return;
      if (btn.disabled) return;
      setButtonLoadingEl(btn, true, loadingText);
      try {
        await ctx.getLlmGovernanceCallback()?.(action);
      } catch (err) {
        // Controller 内部已 toast 反馈，此处仅记录日志兜底
        reportError('MemoryPanel llmGovernance', err);
      } finally {
        setButtonLoadingEl(btn, false);
      }
    });
  };

  bindLlmBtn('health-llm-dedup', 'dedup', '去重中…');
  bindLlmBtn('health-llm-timeliness', 'timeliness', '评估中…');
  bindLlmBtn('health-llm-conflicts', 'conflicts', '检测中…');
}

// ─── 1. 列表点击事件委托 ──────────────────────────────────

/**
 * 记忆列表事件委托：在 list 容器上注册统一 click 监听器，
 * 通过 data-action="view-memory" + data-memory-id 分发，
 * 替代动态列表项各自的 addEventListener，统一纳入 EventTracker 管理。
 *
 * 时间线视图项渲染在独立的 memory-timeline-container 中（与 memoryListEl 是同级 DOM 子树），
 * 需在两个容器上分别注册事件委托。
 */
function initListClickDelegation(ctx: MemoryPanelEventContext): void {
  // 时间线项同样标记 data-action="view-memory" + data-memory-id + tabindex="0" + role="button"
  const delegateTargets: HTMLElement[] = [];
  if (ctx.memoryListEl) delegateTargets.push(ctx.memoryListEl);
  const timelineEl = document.getElementById('memory-timeline-container');
  if (timelineEl) delegateTargets.push(timelineEl);

  for (const target of delegateTargets) {
    ctx.events.addEventListener(target, 'click', (e: Event) => {
      const item = (e.target as HTMLElement).closest<HTMLElement>('[data-action="view-memory"]');
      if (item) {
        const memoryId = item.dataset.memoryId ?? '';
        ctx.getMemoryClickCallback()?.(memoryId);
      }
    });
    // 键盘可访问性——Enter/Space 触发与 click 等效的查看动作
    // handler 签名用 Event（与 EventTracker 签名一致），内部断言为 KeyboardEvent 访问 key 属性
    ctx.events.addEventListener(target, 'keydown', (e: Event) => {
      const ke = e as KeyboardEvent;
      if (ke.key !== 'Enter' && ke.key !== ' ') return;
      const item = (ke.target as HTMLElement).closest<HTMLElement>('[data-action="view-memory"]');
      if (item) {
        ke.preventDefault();
        const memoryId = item.dataset.memoryId ?? '';
        ctx.getMemoryClickCallback()?.(memoryId);
      }
    });
  }
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
        // source 黑名单校验：persona/skill/rule 走设定模块，不允许通过添加记忆创建
        if (BLOCKED_SOURCES.has(data.source)) {
          showFieldError('memory-add-source', `${data.source} 请通过设定模块创建`);
          return;
        }
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
          // source 黑名单校验（与 btnAddConfirm 一致，防止 Ctrl+Enter 绕过）
          if (BLOCKED_SOURCES.has(data.source)) {
            showFieldError('memory-add-source', `${data.source} 请通过设定模块创建`);
            return;
          }
          clearFieldErrors([...MEMORY_ADD_FIELD_IDS]);
          ctx.getMemoryAddCallback()?.(data);
        } else {
          // Ctrl+Enter 提交校验失败时同样给出字段级反馈
          validateMemoryAddForm();
        }
      }
    }) as EventListener);
  }

  // 必填字段 blur 即时校验
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
 * 删除（带确认对话框）、编辑/保存/取消、讨论、关闭按钮守卫。
 *
 * 编辑模式守卫：
 *   关闭按钮（[data-modal="memory-detail-modal"]）和 backdrop 在编辑模式下
 *   不能直接 hideModal，否则用户未保存的修改会丢失。
 *   此处注册 capture phase click 监听器，在 modal.ts 的 click 监听器之前触发，
 *   编辑模式下阻止默认行为并弹确认对话框，由 handleCloseRequest 决定是否放行。
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

  // 编辑取消按钮：检查未保存修改后退出编辑模式（与 Esc 行为一致）
  const btnEditCancel = getOptionalElement('btn-memory-edit-cancel', 'button');
  if (btnEditCancel) {
    ctx.events.addEventListener(btnEditCancel, 'click', () => {
      void ctx.confirmExitEditMode();
    });
  }

  // 讨论按钮：关闭详情弹窗，切换到对话面板预填讨论提示
  const btnDiscuss = getOptionalElement('btn-memory-discuss', 'button');
  if (btnDiscuss) {
    ctx.events.addEventListener(btnDiscuss, 'click', async () => {
      // 讨论按钮会关闭详情弹窗，编辑模式下需先经过未保存提示
      const canClose = await ctx.handleCloseRequest();
      if (!canClose) return;
      const memoryName = ctx.memoryDetailModal?.dataset.memoryName ?? '';
      if (memoryName) {
        ctx.getMemoryDiscussCallback()?.(memoryName);
      }
    });
  }

  // ─── 编辑模式关闭守卫（capture phase 拦截关闭按钮 + backdrop） ───
  // modal.ts 的 initModalListeners 在 bubble phase 注册 click → hideModal，
  // 此处在 capture phase 先触发，编辑模式下 stopPropagation 阻止 hideModal，
  // 由 handleCloseRequest 决定是否放行。
  if (ctx.memoryDetailModal) {
    const modal = ctx.memoryDetailModal;

    // 拦截所有带 data-modal="memory-detail-modal" 的关闭按钮（头部 X + 底部"关闭"）
    const closeButtons = modal.querySelectorAll<HTMLElement>('[data-modal="memory-detail-modal"]');
    // Array.from 显式转换：当前 tsconfig 未启用 DOM.Iterable lib，NodeListOf 缺 Symbol.iterator
    for (const btn of Array.from(closeButtons)) {
      ctx.events.addEventListener(
        btn,
        'click',
        (async (e: Event) => {
          if (!ctx.getIsEditing()) return; // 非编辑模式放行，交给 modal.ts 处理
          e.preventDefault();
          e.stopPropagation();
          const canClose = await ctx.handleCloseRequest();
          if (canClose) {
            ctx.host.hideModal('memory-detail-modal');
          }
        }) as EventListener,
        true, // capture phase：在 modal.ts 之前触发
      );
    }

    // 拦截 backdrop 点击（modal.ts 在 bubble phase 注册 backdrop → hideModal）
    ctx.events.addEventListener(
      modal,
      'click',
      (async (e: Event) => {
        if (!ctx.getIsEditing()) return;
        if (e.target !== modal) return; // 仅 backdrop 触发（点击子元素不触发）
        e.preventDefault();
        e.stopPropagation();
        const canClose = await ctx.handleCloseRequest();
        if (canClose) {
          ctx.host.hideModal('memory-detail-modal');
        }
      }) as EventListener,
      true, // capture phase
    );

    // 拦截全局 Escape（modal.ts 在 document bubble phase 注册 Escape → hideModal）
    // 焦点在 textarea 时由 textarea 的 keydown 直接处理并 stopPropagation；
    // 焦点在其他元素（如保存/取消按钮）时，由本监听器在 capture phase 拦截。
    ctx.events.addEventListener(
      modal,
      'keydown',
      ((e: KeyboardEvent) => {
        if (e.key !== 'Escape') return;
        if (!ctx.getIsEditing()) return; // 非编辑模式放行，交给 modal.ts 全局 Escape
        e.preventDefault();
        e.stopPropagation();
        void ctx.handleCloseRequest().then((canClose) => {
          if (canClose) {
            ctx.host.hideModal('memory-detail-modal');
          }
        });
      }) as EventListener,
      true, // capture phase：在 modal.ts document bubble 之前触发
    );
  }
}

// ─── 5. 高级筛选栏（排序/时间范围） ────────

/**
 * 高级筛选按钮切换 + 排序/时间范围下拉变更。
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

// ─── 6. 更多菜单（统计洞察/健康度诊断/补全统计/回收站） ───────────────────

/**
 * 更多菜单（initMoreMenu）已废弃：统一导航 rail 取代头部 .view-switch 分段控件
 * 与 #memory-more-menu 更多菜单两套分散导航。菜单项动作改为 rail 项的
 * data-section / data-action 事件委托（见 initMemoryRail）。
 */

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
  // 补全统计面板关闭按钮：该按钮由 CompletionStatsRenderer 在面板打开时才动态注入 DOM，
  // init 阶段尚不存在，故在稳定容器 #completion-stats-bar 上做事件委托，
  // 命中 .panel-close-btn 即关闭面板（与列表点击委托同一手法）。
  const completionStatsBar = document.getElementById('completion-stats-bar');
  if (completionStatsBar) {
    ctx.events.addEventListener(completionStatsBar, 'click', (e: Event) => {
      const closeBtn = (e.target as HTMLElement).closest<HTMLElement>('.panel-close-btn');
      if (closeBtn) {
        ctx.hideAnalysisPanel();
      }
    });
  }
}

// ─── 8. 统一导航 rail（取代 .view-switch 分段控件 + 更多菜单） ─────

/**
 * 记忆面板统一导航 rail：事件委托处理所有区块切换。
 *
 * - [data-section] 项（list/timeline/graph/insights/health/completion-stats/partner-insights）
 *   委托到 ctx.setSection（统一导航单一入口）。数据视图额外触发 getViewSwitchCallback
 *   以保持图谱/时间线激活等上游通知（与原 view-switch 按钮行为一致）。
 * - [data-action="recycle-bin"] 项：触发 getMoreMenuActionCallback('recycle-bin') 打开回收站模态。
 */
function initMemoryRail(ctx: MemoryPanelEventContext): void {
  const rail = document.getElementById('memory-rail');
  if (!rail) return;

  ctx.events.addEventListener(rail, 'click', (e) => {
    const target = (e as Event).target as HTMLElement;
    const item = target.closest<HTMLElement>('.memory-rail-item');
    if (!item) return;

    const section = item.getAttribute('data-section');
    if (section) {
      ctx.setSection(section as MemorySection);
      // 数据视图额外触发上游通知（图谱/时间线激活等），与原 view-switch 行为一致
      if (section === 'list' || section === 'timeline' || section === 'graph') {
        ctx.getViewSwitchCallback()?.(section);
      }
      return;
    }

    const action = item.getAttribute('data-action');
    if (action === 'recycle-bin') {
      ctx.getMoreMenuActionCallback()?.('recycle-bin');
    }
  });
}

// ─── 9. 智能清理对话框 ─────────────────────────

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
 *
 * B7：异步操作期间禁用按钮 + 显示 loading 文案，防止用户在 IPC 往返期间重复点击。
 * 注意 callback 内部已 toast 反馈结果，此处不重复 toast；错误也由 callback 内部捕获。
 */
function initRecycleBinActions(ctx: MemoryPanelEventContext): void {
  const recycleBinList = document.getElementById('recycle-bin-list');
  if (!recycleBinList) return;

  ctx.events.addEventListener(recycleBinList, 'click', async (e: Event) => {
    const target = e.target as HTMLElement;
    // 优先匹配恢复按钮
    const restoreBtn = target.closest<HTMLElement>('[data-action="restore-memory"]');
    if (restoreBtn) {
      const id = restoreBtn.dataset.memoryId ?? '';
      if (id && restoreBtn instanceof HTMLButtonElement) {
        setButtonLoadingEl(restoreBtn, true, '恢复中…');
        try {
          await ctx.getRecycleBinActionCallback()?.('restore', id);
        } finally {
          setButtonLoadingEl(restoreBtn, false);
        }
      }
      return;
    }
    // 其次匹配彻底删除按钮
    const purgeBtn = target.closest<HTMLElement>('[data-action="purge-memory"]');
    if (purgeBtn) {
      const id = purgeBtn.dataset.memoryId ?? '';
      if (id && purgeBtn instanceof HTMLButtonElement) {
        setButtonLoadingEl(purgeBtn, true, '删除中…');
        try {
          await ctx.getRecycleBinActionCallback()?.('purge', id);
        } finally {
          setButtonLoadingEl(purgeBtn, false);
        }
      }
      return;
    }
  });
}

/**
 * 回收站批量操作事件：全部恢复 / 全部清空
 *
 * 通过 ID 选择器直接绑定按钮，操作前需二次确认（由 Controller 回调实现）。
 * B7：批量操作期间禁用按钮 + 显示 loading 文案，防止重复提交。
 */
function initRecycleBinBatchActions(ctx: MemoryPanelEventContext): void {
  const restoreAllBtn = document.getElementById('recycle-bin-restore-all');
  const purgeAllBtn = document.getElementById('recycle-bin-purge-all');

  if (restoreAllBtn && restoreAllBtn instanceof HTMLButtonElement) {
    ctx.events.addEventListener(restoreAllBtn, 'click', async () => {
      setButtonLoadingEl(restoreAllBtn, true, '恢复中…');
      try {
        await ctx.getRecycleBinBatchActionCallback()?.('restore-all');
      } finally {
        setButtonLoadingEl(restoreAllBtn, false);
      }
    });
  }
  if (purgeAllBtn && purgeAllBtn instanceof HTMLButtonElement) {
    ctx.events.addEventListener(purgeAllBtn, 'click', async () => {
      setButtonLoadingEl(purgeAllBtn, true, '清空中…');
      try {
        await ctx.getRecycleBinBatchActionCallback()?.('purge-all');
      } finally {
        setButtonLoadingEl(purgeAllBtn, false);
      }
    });
  }
}
