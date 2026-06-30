/**
 * UI 管理器 — 渲染进程 UI 门面
 *
 * 职责：
 * - 消息渲染和更新
 * - 面板切换
 * - 表单处理
 * - 用户界面状态管理
 *
 * 设计原则：
 * - 通过组合方式持有独立子模块（Toast/Modal/Onboarding/Theme/ProactiveBanner）
 * - 业务逻辑与 UI 操作分离
 * - 提供清晰的 API 供其他模块调用
 * - 子模块公共 API 通过 UIManager 代理，保持向后兼容
 * - 聊天/记忆/角色/会话面板委托至独立 PanelManager，UIManager 仅做 facade
 */

// 子模块导入（组合模式：UIManager 持有独立子模块实例）
import { getRequiredElement, getOptionalElement } from './helpers/domHelpers.js';
import { EventTracker } from './helpers/eventTracker.js';
import { ToastManager } from './components/toast.js';
import { ModalManager } from './components/modal.js';
import { OnboardingManager } from './components/onboarding.js';
import { ThemeManager } from './components/themeManager.js';
import { ProactiveBanner } from './components/proactiveBanner.js';
import { SuggestionCardManager } from './components/suggestionCard.js';
import { ProfilePanelManager } from './panels/profilePanelManager.js';
import { WorkProjectionPanelManager } from './panels/workProjectionPanelManager.js';
import { AuditPanelManager } from './panels/auditPanelManager.js';
import { SettingsPanelManager } from './panels/settingsPanelManager.js';
import type { SettingsPanelHost } from './panels/settingsPanelManager.js';
import { ChatPanelManager } from './panels/chatPanelManager.js';
import type { ChatPanelHost } from './panels/chatPanelManager.js';
import { MemoryPanelManager } from './panels/memoryPanelManager.js';
import type { MemoryPanelHost } from './panels/memoryPanelManager.js';
import { DashboardPanelManager } from './panels/dashboardPanelManager.js';
import type { DashboardPanelHost } from './panels/dashboardPanelManager.js';
import type {
  DashboardViewModel,
  AgentMetrics,
} from './panels/dashboardPanelManager.js';
// P2-5：Payload 类型直接从 ipcListeners（IPC 契约真理源）导入，消除中转
import type {
  AffectPayload,
  RapportPayload,
  ContextPayload,
  PatternsPayload,
} from './ipcListeners.js';
import { PersonaPanelManager } from './panels/personaPanelManager.js';
// 精灵公共常量（时间常量、Toast 时长，跨进程共享 DRY）
import { MS_PER_DAY, TOAST_SHORT_MS, TOAST_NORMAL_MS, TOAST_LONG_MS } from '../../sprite/constants.js';
// 类型导入（仅用于类型注解，不引入运行时依赖）
import type {
  Message,
  UIState,
  PersonaItem,
  LlmConfigForm,
  LlmConfigSavePayload,
  MemoryListItem,
  MemoryDetail,
  SpriteConfigForm,
  ToastType,
  ToastOptions,
  ConfirmDialogOptions,
} from './types.js';
// H1：配置建议 payload 类型（从 preload 导入，供 showSuggestion 代理方法使用）
import type { ConfigSuggestionPayload } from '../preload.js';
// M1：写入确认 payload 类型（从 preload 导入，供 showWriteConfirmation 方法使用）
import type { WriteConfirmationPayload } from '../preload.js';
// 健康度仪表盘 payload 类型（从 preload 导入，供 renderHealthDashboard 代理方法使用）
import type { HealthDashboardPayload } from '../preload.js';
// 对话回顾数据 payload 类型（从 preload 导入，供 renderReviewData 代理方法使用）
import type { ReviewDataPayload } from '../preload.js';
// 图谱数据类型（供 MemoryPanelManager 委托方法使用）
import type { RelationGraphData } from './components/relationGraph.js';

// 重新导出，保持 ui.ts 的公共 API 不变（其他模块从 ui.ts 导入这些类型）
export type {
  MemoryListItem,
  MemorySearchHit,
  MemoryDetail,
  SpriteConfigForm,
  Message,
  UIState,
  PersonaItem,
  LlmConfigForm,
  LlmConfigSavePayload,
  ToastType,
} from './types.js';

// ─── 工具函数（formatTimeAgo、setButtonLoading）见 domHelpers.ts ───

// ─── UI 管理器类 ─────────────────────────────────────────

export class UIManager implements ChatPanelHost, MemoryPanelHost, DashboardPanelHost {
  // ─── 静态常量 ───────────────────────────────────────────
  /** 判断"底部附近"的阈值（像素） */
  private static readonly SCROLL_BOTTOM_THRESHOLD = 100;

  // ─── 组合子模块（独立管理器，UIManager 代理公共 API） ──
  /** Toast 通知管理器（独立管理定时器和清理） */
  private toastManager = new ToastManager();
  /** 模态框管理器（独立管理焦点恢复和并发保护） */
  private modalManager = new ModalManager();
  /** 三态首次引导管理器（独立管理 localStorage 标记） */
  private onboardingManager = new OnboardingManager();
  /** 主题管理器（独立管理主题切换和持久化） */
  private themeManager = new ThemeManager();
  /** 主动提示横幅管理器（独立管理横幅按钮事件） */
  private proactiveBanner = new ProactiveBanner();
  /** H1 配置建议卡片管理器（独立管理卡片显示/接受/拒绝，与 ProactiveBanner 同模式） */
  private suggestionCard = new SuggestionCardManager();
  /** H2 用户画像面板管理器（独立管理画像 tab 的加载/确认/拒绝） */
  private profilePanel = new ProfilePanelManager();
  /** H3 作品投影面板管理器（独立管理作品 tab 的加载/渲染/展开） */
  private workProjectionPanel = new WorkProjectionPanelManager();
  /** M2 审计日志面板管理器（独立管理审计 tab 的加载/渲染/清空） */
  private auditPanel = new AuditPanelManager();
  /** 设置面板管理器（独立管理设置面板 DOM 和事件） */
  private settingsPanelManager: SettingsPanelManager;

  // ─── 面板管理器（聊天/记忆/角色/会话） ──
  /** 聊天面板管理器（消息渲染、流式输出、思考指示器、工具调用卡片） */
  private chatPanel: ChatPanelManager;
  /** 记忆面板管理器（列表渲染、搜索过滤、详情弹窗） */
  private memoryPanel: MemoryPanelManager;
  /** 仪表盘面板管理器（感知系统 + 仪表盘渲染） */
  private dashboardPanel: DashboardPanelManager;
  /** 角色选择器面板管理器（下拉菜单、角色切换） */
  private personaPanel: PersonaPanelManager;

  // ─── 核心交互元素（必需，缺失时抛出） ──────────────────
  private messagesEl: HTMLElement;
  private inputEl: HTMLTextAreaElement;
  private btnSend: HTMLButtonElement;

  // ─── 可选元素（缺失时降级，不阻塞其他功能） ────────────
  /** 未读计数徽章（标题栏右上角，部分布局可能未提供该元素） */
  private badge: HTMLElement | null;
  /** FD-05 新建会话按钮（对话工具栏内，主动可见低频操作） */
  /** 最大化按钮（标题栏右侧，用于图标切换 □ ↔ ❐） */
  private btnMaximize: HTMLButtonElement | null;

  private state: UIState = {
    currentPanel: 'chat',
    unreadCount: 0,
    isStreaming: false,
    // UX-P2-03 初始为 false，onAgentReady 回调中置 true
    isAgentReady: false,
  };

  /** 活跃的流式消息映射（messageId → DOM 元素），ChatPanelManager 共享引用 */
  private streamingMessages = new Map<string, HTMLElement>();
  /** 事件监听器跟踪器（统一管理事件监听器的注册与清理，避免内存泄漏） */
  private events = new EventTracker();

  // ─── UI 状态字段 ────────────────────────────────────────
  /** FD-A2 面板错误横幅重试回调映射（key: panelId，如 'settings'/'memory'/'chat'） */
  private panelErrorRetryCallbacks = new Map<string, () => void>();
  /** 用户是否在底部附近（用于智能滚动：用户向上滚动时不强制滚到底部） */
  private isNearBottom = true;
  /** 非系统消息计数（显示在对话工具栏副标题，P2-009：移至 state 字段区） */
  private messageCount = 0;
  /** 记忆抽屉是否打开（抽屉是右侧覆盖层，不替换对话面板） */
  private isMemoryDrawerOpen = false;

  constructor() {
    // ─── 核心交互元素：必需，缺失时抛出（UI 无法工作） ────
    this.messagesEl = getRequiredElement('messages', 'div');
    this.inputEl = getRequiredElement('input', 'textarea');
    this.btnSend = getRequiredElement('btn-send', 'button');

    // ─── 可选元素：缺失时 warn 并降级，不阻塞其他功能 ──────
    this.badge = document.getElementById('badge');
    this.btnMaximize = getOptionalElement('btn-maximize', 'button');

    this.settingsPanelManager = new SettingsPanelManager(this as SettingsPanelHost);

    // H1 初始化配置建议卡片容器（动态创建 #suggestion-container 或复用 HTML 预定义元素）
    this.suggestionCard.init();
    // H2 初始化用户画像面板（绑定刷新按钮事件）
    this.profilePanel.init();
    // H3 初始化作品投影面板（绑定刷新按钮事件）
    this.workProjectionPanel.init();
    // M2 初始化审计日志面板（绑定刷新/清空按钮事件）
    this.auditPanel.init();

    // ─── 面板管理器初始化 ───

    // P1-ET-01 每个面板持有独立的 EventTracker，避免 cleanup 时互相干扰
    // 聊天面板管理器
    // 通过 host.setStreaming/isStreaming 封装流式状态
    this.chatPanel = new ChatPanelManager(
      this,
      this.messagesEl,
      new EventTracker(),
      this.streamingMessages,
    );

    // 记忆面板管理器
    this.memoryPanel = new MemoryPanelManager(
      this,
      getOptionalElement('memory-list', 'div'),
      getOptionalElement('memory-search', 'input'),
      getOptionalElement('memory-filter-source', 'select'),
      getOptionalElement('memory-detail-modal', 'div'),
      new EventTracker(),
    );

    // 仪表盘面板管理器（感知系统 + 仪表盘渲染）
    this.dashboardPanel = new DashboardPanelManager(new EventTracker());

    // 角色选择器面板管理器
    this.personaPanel = new PersonaPanelManager(
      getOptionalElement('persona-selector', 'div'),
      getOptionalElement('persona-dropdown', 'div'),
      getOptionalElement('persona-name', 'span'),
      new EventTracker(),
    );

    // 初始化 UI
    this.initEventListeners();
    this.memoryPanel.initMemoryPanelListeners();
    this.personaPanel.initPersonaSelectorListeners();
    this.settingsPanelManager.initListeners();
    this.initPanelErrorRetryButtons(); // FD-A2 统一面板错误横幅重试按钮
    // 模态框监听器委托给 ModalManager（独立管理事件清理）
    this.modalManager.initModalListeners();
    this.chatPanel.initEmptyStateListeners();
    this.chatPanel.initScrollToBottomButton();
    this.initScrollListener();
  }

  // ─── 事件监听器管理 ─────────────────────────────────────

  /** 初始化事件监听器 */
  private initEventListeners(): void {
    // 输入框事件
    this.events.addEventListener(this.inputEl, 'keydown', this.handleInputKeydown.bind(this));
    this.events.addEventListener(this.inputEl, 'input', this.handleInputChange.bind(this));

    // 初始化输入框高度和发送按钮状态
    this.handleInputChange();

    // 按钮事件（发送按钮合并了停止功能，流式态时点击触发停止）
    this.events.addEventListener(this.btnSend, 'click', this.handleSendClick.bind(this));
    // FD-05 新建会话按钮：触发回调（由 renderer.ts 注册，调用主进程创建新会话）

    // UX-FD-07 日期导航按钮：点击切换下拉显示/隐藏
    const dateNavBtn = document.getElementById('date-nav-btn');
    if (dateNavBtn) {
      this.events.addEventListener(dateNavBtn, 'click', (e) => {
        e.stopPropagation();
        this.toggleDateNavDropdown();
      });
    }
    // 日期导航列表项点击：触发跳转回调
    const dateNavList = document.getElementById('date-nav-list');
    if (dateNavList) {
      this.events.addEventListener(dateNavList, 'click', (e) => {
        const target = e.target as HTMLElement;
        const item = target.closest<HTMLElement>('[data-action="jump-to-date"]');
        if (item && this.dateNavJumpCallback) {
          const date = item.dataset.date ?? '';
          if (date) {
            this.closeDateNavDropdown();
            this.dateNavJumpCallback(date);
          }
        }
      });
    }
    // 点击其他区域关闭日期导航下拉
    this.events.addEventListener(document, 'click', (e) => {
      const navigator = document.getElementById('date-navigator');
      if (navigator && !navigator.contains(e.target as Node)) {
        this.closeDateNavDropdown();
      }
    });

    // FD-ADD-REC-CLICK 仪表盘推荐记忆点击：事件委托，复用 triggerMemoryRecall 跳转到记忆面板显示详情
    const recList = document.getElementById('recommendation-list');
    if (recList) {
      this.events.addEventListener(recList, 'click', (e) => {
        const target = e.target as HTMLElement;
        const item = target.closest<HTMLElement>('[data-action="view-recommendation"]');
        if (item) {
          const memoryId = item.dataset.memoryId ?? '';
          if (memoryId) {
            this.triggerMemoryRecall(memoryId);
          }
        }
      });
    }

    // 精灵状态条点击事件（展开/收起感知面板）
    const spriteStatusBar = document.getElementById('sprite-status-bar');
    if (spriteStatusBar) {
      this.events.addEventListener(spriteStatusBar, 'click', this.togglePerceptionPanel.bind(this));
      // 键盘可访问性：Enter/Space 触发展开/收起
      this.events.addEventListener(spriteStatusBar, 'keydown', (e: Event) => {
        if (e instanceof KeyboardEvent && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          this.togglePerceptionPanel();
        }
      });
    }

    // 侧边栏角色头像点击（展开工具栏角色选择器）
    const sidebarAvatar = document.getElementById('sidebar-persona-avatar');
    if (sidebarAvatar) {
      this.events.addEventListener(sidebarAvatar as HTMLElement, 'click', () => {
        // 打开工具栏中的角色选择器
        const selector = document.getElementById('persona-selector');
        if (selector) {
          selector.click();
        }
      });
      this.events.addEventListener(sidebarAvatar as HTMLElement, 'keydown', (e: Event) => {
        if (e instanceof KeyboardEvent && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          const selector = document.getElementById('persona-selector');
          if (selector) selector.click();
        }
      });
    }

    // 感知面板关闭按钮
    const panelClose = document.querySelector('.perception-panel-close');
    if (panelClose) {
      this.events.addEventListener(panelClose as HTMLElement, 'click', this.closePerceptionPanel.bind(this));
    }

    // 运行指标折叠/展开
    const metricsToggle = document.getElementById('perception-metrics-toggle');
    if (metricsToggle) {
      this.events.addEventListener(metricsToggle, 'click', () => {
        const grid = document.getElementById('perception-metrics-grid');
        const arrow = document.getElementById('perception-metrics-arrow');
        if (grid) grid.classList.toggle('hidden');
        if (arrow) arrow.classList.toggle('expanded');
      });
    }

    // 导航事件（侧边栏 .nav-btn 按钮，复用 switchPanel 逻辑）
    document.querySelectorAll<HTMLElement>('.nav-btn').forEach((btn) => {
      this.events.addEventListener(btn, 'click', this.handleNavClick.bind(this));
    });

    // 记忆抽屉关闭交互：遮罩层点击关闭 + 关闭按钮点击关闭
    const drawerOverlay = document.getElementById('memory-drawer-overlay');
    if (drawerOverlay) {
      this.events.addEventListener(drawerOverlay, 'click', () => this.closeMemoryDrawer());
    }
    const drawerCloseBtn = document.getElementById('btn-memory-drawer-close');
    if (drawerCloseBtn) {
      this.events.addEventListener(drawerCloseBtn, 'click', () => this.closeMemoryDrawer());
    }

    // 标题栏按钮（可选，部分布局可能不提供）
    const btnMinimize = getOptionalElement('btn-minimize', 'button');
    const btnClose = getOptionalElement('btn-close', 'button');
    if (btnMinimize) {
      this.events.addEventListener(btnMinimize, 'click', this.handleMinimize.bind(this));
    }
    if (this.btnMaximize) {
      this.events.addEventListener(this.btnMaximize, 'click', this.handleMaximize.bind(this));
    }
    if (btnClose) {
      this.events.addEventListener(btnClose, 'click', this.handleClose.bind(this));
    }

    // 窗口状态变更监听（最大化按钮图标切换）
    window.electronAPI.onWindowStateChanged((msg) => {
      this.updateMaximizeButton(msg.maximized);
    });

    // 全局键盘快捷键
    this.events.addEventListener(document, 'keydown', this.handleGlobalKeydown.bind(this));

    // 快速添加记忆按钮（输入工具栏）：打开记忆添加弹窗
    const btnAddMemoryQuick = getOptionalElement('btn-add-memory-quick', 'button');
    if (btnAddMemoryQuick) {
      this.events.addEventListener(btnAddMemoryQuick, 'click', () => {
        this.showModal('memory-add-modal');
      });
    }
  }

  /**
   * 全局键盘快捷键处理
   *
   * - Esc：关闭展开的下拉菜单（弹窗由 ModalManager 统一处理，见 modal.ts）
   * - Ctrl/Cmd + 1/2/3：切换面板（对话/记忆/设置）
   * - Ctrl/Cmd + .：停止生成（仅流式输出期间）
   * - Ctrl/Cmd + /：显示快捷键帮助弹窗
   */
  private handleGlobalKeydown(e: Event): void {
    if (!(e instanceof KeyboardEvent)) return;
    const isMod = e.ctrlKey || e.metaKey;

    // Esc：关闭感知面板/记忆抽屉/下拉菜单；设置面板激活时切回对话（弹窗由 ModalManager 统一处理）
    if (e.key === 'Escape') {
      // 优先关闭感知面板（感知面板打开时 Escape 关闭面板）
      const panel = document.getElementById('perception-panel');
      if (panel?.classList.contains('visible')) {
        this.closePerceptionPanel();
        e.preventDefault();
        return;
      }
      // 优先关闭记忆抽屉（抽屉打开时 Escape 关闭抽屉）
      if (this.isMemoryDrawerOpen) {
        this.closeMemoryDrawer();
        e.preventDefault();
        return;
      }
      // 设置面板激活时，Escape 切回对话面板
      if (this.state.currentPanel === 'settings') {
        void this.switchPanel('chat');
        e.preventDefault();
        return;
      }
      const openDropdowns = document.querySelectorAll('.dropdown:not(.hidden)');
      if (openDropdowns.length > 0) {
        openDropdowns.forEach((dropdown) => dropdown.classList.add('hidden'));
        e.preventDefault();
      }
      return;
    }

    // Ctrl/Cmd + 数字：切换面板（Ctrl+2 toggle记忆抽屉，Ctrl+3 走switchPanel切换设置面板）
    if (isMod && ['1', '2', '3'].includes(e.key)) {
      const panelMap: Record<string, string> = {
        '1': 'chat',
        '2': 'memories',
        '3': 'settings',
      };
      const panel = panelMap[e.key];
      if (panel) {
        // memories 特殊处理：toggle 抽屉；chat/settings 走 switchPanel 标准面板切换
        if (panel === 'memories') {
          this.toggleMemoryDrawer();
        } else {
          void this.switchPanel(panel);
        }
        e.preventDefault();
      }
      return;
    }

    // P2-FLOW-07 Ctrl/Cmd + .：停止生成（流式输出期间可用键盘快速中断）
    if (isMod && e.key === '.') {
      if (this.state.isStreaming) {
        this.emitStopMessage();
        e.preventDefault();
      }
      return;
    }

    // Ctrl/Cmd + /：显示快捷键帮助弹窗
    // KBD-CONVERGE-P1：走统一 showModal/hideModal 路径，获得 UI-AR-02 焦点保存/恢复
    if (isMod && e.key === '/') {
      const modal = document.getElementById('shortcuts-modal');
      if (modal) {
        if (modal.classList.contains('hidden')) {
          this.showModal('shortcuts-modal');
        } else {
          this.hideModal('shortcuts-modal');
        }
        e.preventDefault();
      }
      return;
    }
  }

  /** 清理所有事件监听器和子模块资源 */
  cleanup(): void {
    // 清理所有事件监听器（通过 EventTracker 统一管理）
    this.events.cleanup();
    // 委托子模块清理各自的资源（Toast 定时器、Modal 监听器、ProactiveBanner 监听器、SettingsPanel 监听器）
    this.toastManager.cleanup();
    this.modalManager.cleanup();
    this.proactiveBanner.cleanup();
    this.suggestionCard.cleanup(); // H1 清理配置建议卡片事件监听器和 DOM
    this.profilePanel.cleanup(); // H2 清理用户画像面板事件监听器
    this.workProjectionPanel.cleanup(); // H3 清理作品投影面板事件监听器
    this.auditPanel.cleanup(); // M2 清理审计日志面板事件监听器
    this.settingsPanelManager.cleanup();
    // 清理面板管理器
    this.chatPanel.cleanup();
    this.memoryPanel.cleanup(); // Q1 清理记忆面板防抖定时器
    this.dashboardPanel.cleanup(); // 清理仪表盘脉冲定时器与重试按钮事件
    this.personaPanel.cleanup();
    // P2-6 清理 ThemeManager 的系统主题变化监听器
    this.themeManager.cleanup();
  }

  // ─── 聊天面板 ─ 委托到 ChatPanelManager ─────────────────

  /** 添加消息到界面（委托到 ChatPanelManager） */
  appendMessage(message: Message): HTMLElement { return this.chatPanel.appendMessage(message); }
  /** 更新流式消息内容（委托到 ChatPanelManager） */
  updateStreamingMessage(messageId: string, text: string): void { this.chatPanel.updateStreamingMessage(messageId, text); }
  /** 完成流式消息（委托到 ChatPanelManager） */
  finishStreamingMessage(messageId: string): void { this.chatPanel.finishStreamingMessage(messageId); }
  /** 设置流式消息的召回记忆摘要（委托到 ChatPanelManager） */
  setMemoryRecall(messageId: string, memories: Array<{ id: string; name: string; score: number; source: string }>): void { this.chatPanel.setMemoryRecall(messageId, memories); }
  /** 显示思考阶段指示器（委托到 ChatPanelManager） */
  showThinkingPhase(messageId: string, phase: string): void { this.chatPanel.showThinkingPhase(messageId, phase); }
  /** OBS-02 显示上下文截断提示条 */
  showTruncationNotice(messageId: string, count: number): void { this.chatPanel.showTruncationNotice(messageId, count); }
  /** 显示工具调用开始卡片（委托到 ChatPanelManager） */
  showToolStart(messageId: string, toolCallId: string, name: string, args?: string): void { this.chatPanel.showToolStart(messageId, toolCallId, name, args); }
  /** 更新工具调用结果（委托到 ChatPanelManager） */
  updateToolResult(messageId: string, toolCallId: string, name: string, ok: boolean, summary?: string): void { this.chatPanel.updateToolResult(messageId, toolCallId, name, ok, summary); }
  /** 开始流式输出（委托到 ChatPanelManager） */
  startStreaming(messageId: string): void { this.chatPanel.startStreaming(messageId); }
  /** 停止所有流式输出（委托到 ChatPanelManager） */
  stopAllStreaming(): void { this.chatPanel.stopAllStreaming(); }
  /** 清空对话区消息（委托到 ChatPanelManager） */
  clearMessages(): void { this.chatPanel.clearMessages(); }
  /** 批量插入消息（委托到 ChatPanelManager） */
  appendMessages(messages: Message[], prepend?: boolean): void { this.chatPanel.appendMessages(messages, prepend); }
  /** 显示"加载更多"按钮（委托到 ChatPanelManager） */
  showLoadMore(remaining: number, onClick: () => void): void { this.chatPanel.showLoadMore(remaining, onClick); }
  /** 隐藏"加载更多"按钮（委托到 ChatPanelManager） */
  hideLoadMore(): void { this.chatPanel.hideLoadMore(); }
  /** UX-FD-07 方案 B 显示"加载更早的对话"按钮（委托到 ChatPanelManager） */
  showLoadEarlierDay(onClick: () => void): void { this.chatPanel.showLoadEarlierDay(onClick); }
  /** 向流式消息气泡注入错误提示（委托到 ChatPanelManager） */
  injectErrorToStreamingMessages(errorText: string): void { this.chatPanel.injectErrorToStreamingMessages(errorText); }
  /** UX-PP-10 在流式消息气泡内嵌入中断标记（委托到 ChatPanelManager） */
  markStreamingAborted(messageId: string, reason: string): void { this.chatPanel.markStreamingAborted(messageId, reason); }
  /** 显示空状态引导（委托到 ChatPanelManager） */
  showEmptyState(): void { this.chatPanel.showEmptyState(); }
  /** 隐藏空状态引导（委托到 ChatPanelManager） */
  hideEmptyState(): void { this.chatPanel.hideEmptyState(); }
  /** 注册示例问题点击回调（委托到 ChatPanelManager） */
  onSuggestionClick(cb: (text: string) => void): void { this.chatPanel.onSuggestionClick(cb); }
  /** UX-PP-05 注册错误重试回调（委托到 ChatPanelManager） */
  onErrorRetry(cb: () => void): void { this.chatPanel.onErrorRetry(cb); }

  // ─── 消息计数（ChatPanelHost 回调：供 ChatPanelManager 调用） ──

  /** 更新消息计数（ChatPanelHost 回调：供 ChatPanelManager.appendMessage 调用） */
  updateMessageCount(): void {
    this.messageCount++;
    this.refreshMessageCountDisplay();
  }

  /**
   * UX-FD-07 方案 B 直接设置消息计数（不累加）
   *
   * 用于会话历史加载后，根据加载的会话是否当天 main 设置今日消息数。
   * 加载昨天对话时设为 0（今天还没对话），加载今天 main 时设为该会话的消息数。
   */
  setMessageCount(count: number): void {
    this.messageCount = count;
    this.refreshMessageCountDisplay();
  }

  /** 刷新消息计数显示（不累加计数，仅更新 DOM） */
  refreshMessageCountDisplay(): void {
    const countEl = document.getElementById('chat-message-count');
    if (countEl) {
      countEl.textContent = `今日已交流 ${this.messageCount} 条消息`;
    }
  }

  /** 重置消息计数为 0（ChatPanelHost 回调：供 ChatPanelManager.clearMessages 调用） */
  resetMessageCount(): void {
    this.messageCount = 0;
  }

  /** 未读计数 +1（ChatPanelHost 回调：完整窗口隐藏时新精灵消息到达） */
  updateUnreadCount(): void {
    this.state.unreadCount++;
    this.updateBadge();
  }

  /**
   * 流式输出超时兜底联动主进程清理
   *
   * ChatPanelManager 的 30s 无进展定时器触发时调用，
   * 通知主进程 abort 当前对话并清理 AbortController，避免下次发送被竞态保护拒绝。
   * fire-and-forget：主进程清理是 best-effort，渲染进程已自行重置 isStreaming。
   */
  onStreamStuck(): void {
    // 通知主进程中断当前对话（清理 AbortController + 发送 SPRITE_STREAM_END）
    void window.electronAPI.abortChat();
  }

  // setButtonLoading 见 domHelpers.ts，UIManager 不持有此方法

  // ─── 面板管理 ─────────────────────────────────────────

  /**
   * 切换面板
   *
   * P2-FLOW-06：切换前检查当前面板是否有未保存修改，
   * 有则弹出确认对话框，用户取消则中止切换。
   *
   * - chat/settings：标准面板切换（.panel.active 控制显隐，替换核心区域内容）
   * - memories：打开右侧记忆抽屉（对话面板保持可见，抽屉是覆盖层）
   */
  async switchPanel(panel: string): Promise<void> {
    // P2-FLOW-06：当前在设置面板且有未保存修改时，确认后再切换
    if (this.state.currentPanel === 'settings' && this.settingsPanelManager.isDirty()) {
      const confirmed = await this.showConfirmDialog({
        title: '离开设置',
        message: '有未保存的修改，离开后将丢失。确定要离开吗？',
        confirmText: '离开',
        danger: true,
      });
      if (!confirmed) return;
      // 用户选择离开，重置 dirty 状态避免后续切换重复提示
      this.settingsPanelManager.resetFormDirty();
    }

    // 记忆抽屉独立处理：不切换面板，而是打开抽屉（对话面板保持可见）
    if (panel === 'memories') {
      this.openMemoryDrawer();
      return;
    }

    // 关闭记忆抽屉（切换到 chat/settings 面板时）
    this.closeMemoryDrawer();

    // 移除所有面板活动状态
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));

    // 激活目标面板
    const panelEl = document.getElementById(`panel-${panel}`);
    const navBtn = document.querySelector(`.nav-btn[data-panel="${panel}"]`);

    panelEl?.classList.add('active');
    panelEl?.setAttribute('aria-hidden', 'false');
    navBtn?.classList.add('active');

    // 将之前激活的面板设为 aria-hidden=true
    if (this.state.currentPanel && this.state.currentPanel !== panel) {
      const prevPanel = document.getElementById(`panel-${this.state.currentPanel}`);
      if (prevPanel && !prevPanel.classList.contains('drawer')) {
        prevPanel.setAttribute('aria-hidden', 'true');
      }
    }

    this.state.currentPanel = panel;

    // 切换到对话面板时自动聚焦输入框，减少多余点击步骤
    if (panel === 'chat') {
      this.inputEl.focus();
    }

    // 面板切换回调：通知外部控制器刷新数据
    this.panelSwitchCallback?.(panel);
  }

  /**
   * 切换记忆抽屉打开/关闭状态
   *
   * 记忆抽屉是覆盖在对话右侧的独立层，不替换对话面板。
   * 打开时对话面板保持可见，关闭时回到纯对话视图。
   */
  toggleMemoryDrawer(): void {
    if (this.isMemoryDrawerOpen) {
      this.closeMemoryDrawer();
    } else {
      this.openMemoryDrawer();
    }
  }

  /**
   * 打开记忆抽屉
   *
   * 移除抽屉和遮罩的 hidden 类，激活记忆导航按钮，
   * 通知外部控制器加载记忆数据。
   */
  openMemoryDrawer(): void {
    const drawer = document.getElementById('panel-memories');
    const overlay = document.getElementById('memory-drawer-overlay');
    if (!drawer || !overlay) return;

    drawer.classList.remove('hidden');
    drawer.setAttribute('aria-hidden', 'false');
    overlay.classList.remove('hidden');

    // 激活记忆导航按钮，取消对话导航按钮（视觉上表示当前焦点在记忆）
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
    const memNavBtn = document.querySelector('.nav-btn[data-panel="memories"]');
    memNavBtn?.classList.add('active');

    this.isMemoryDrawerOpen = true;
    // currentPanel 标记为 memories，保持语义一致（外部代码依赖此状态）
    // 注意：对话 .panel.active 仍保持可见，抽屉是覆盖层
    this.state.currentPanel = 'memories';

    // 聚焦记忆搜索框，方便用户立即搜索
    const searchInput = document.getElementById('memory-search') as HTMLInputElement | null;
    searchInput?.focus();

    // 通知外部控制器加载记忆数据
    this.panelSwitchCallback?.('memories');
  }

  /**
   * 关闭记忆抽屉
   *
   * 添加 hidden 类（CSS 触发滑出动画），取消记忆导航按钮激活态，
   * 恢复对话导航按钮激活态。
   */
  closeMemoryDrawer(): void {
    const drawer = document.getElementById('panel-memories');
    const overlay = document.getElementById('memory-drawer-overlay');
    if (!drawer || !overlay) return;

    // 仅在抽屉打开时处理，避免重复操作
    if (!this.isMemoryDrawerOpen) return;

    drawer.classList.add('hidden');
    drawer.setAttribute('aria-hidden', 'true');
    overlay.classList.add('hidden');

    // 取消记忆导航按钮激活态，恢复对话面板
    const memNavBtn = document.querySelector('.nav-btn[data-panel="memories"]');
    memNavBtn?.classList.remove('active');

    // 关闭抽屉后恢复对话面板：移除所有面板的 .active，激活 chat 面板
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    const chatPanel = document.getElementById('panel-chat');
    chatPanel?.classList.add('active');
    chatPanel?.setAttribute('aria-hidden', 'false');
    const chatNavBtn = document.querySelector('.nav-btn[data-panel="chat"]');
    chatNavBtn?.classList.add('active');

    this.isMemoryDrawerOpen = false;
    this.state.currentPanel = 'chat';
  }

  // ─── 输入处理 ─────────────────────────────────────────

  /** 获取并清理用户输入 */
  getUserInput(): string | null {
    const rawText = this.inputEl.value.trim();
    if (!rawText) return null;

    // 验证并清理用户输入
    const text = this.sanitizeInput(rawText);
    if (!text) return null;

    // 清空输入框
    this.inputEl.value = '';
    this.inputEl.style.height = 'auto';

    return text;
  }

  /**
   * 验证并清理用户输入
   *
   * 设计原则：渲染层使用 textContent 设置消息内容，已天然防 XSS。
   * 此处仅做长度限制和首尾空白清理，保留合法的 `<>` 字符——
 * 用户可能输入代码片段、数学符号等合法内容，过度过滤会破坏体验。
   *
   * 真正的 XSS 防护由 textContent 保证（不使用 innerHTML）。
   */
  private sanitizeInput(input: string): string {
    const MAX_INPUT_LENGTH = 10000;
    const trimmed = input.trim();
    return trimmed.length > MAX_INPUT_LENGTH ? trimmed.substring(0, MAX_INPUT_LENGTH) : trimmed;
  }

  // ─── 未读计数 ─────────────────────────────────────────

  /** 更新未读徽章显示（ChatPanelHost 回调） */
  updateBadge(): void {
    // 若当前布局未提供 badge 元素则静默跳过，避免初始化崩溃
    if (!this.badge) return;

    if (this.state.unreadCount > 0) {
      this.badge.textContent = this.state.unreadCount > 99 ? '99+' : String(this.state.unreadCount);
      this.badge.classList.add('visible');
    } else {
      this.badge.classList.remove('visible');
    }
  }

  /** 清除未读计数 */
  clearUnreadCount(): void {
    this.state.unreadCount = 0;
    this.updateBadge();
  }

  /**
   * 设置未读计数（由主进程同步）
   *
   * 用于浮动窗口与完整窗口的未读计数同步：
   * 主进程在浮动窗口收到新消息时推送权威计数到完整窗口。
   */
  setUnreadCount(count: number): void {
    this.state.unreadCount = Math.max(0, count);
    this.updateBadge();
  }

  // ─── 滚动控制 ─────────────────────────────────────────

  /** 智能滚动到底部（仅当用户在底部附近时才滚动，避免打断历史查看） */
  scrollToBottom(): void {
    if (!this.isNearBottom) return;
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  /** 强制滚动到底部（用户主动操作时调用，如点击"新会话"） */
  forceScrollToBottom(): void {
    this.isNearBottom = true;
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  /**
   * 监听消息区滚动，更新 isNearBottom 状态
   */
  private initScrollListener(): void {
    this.events.addEventListener(this.messagesEl, 'scroll', () => {
      const { scrollTop, scrollHeight, clientHeight } = this.messagesEl;
      this.isNearBottom = scrollHeight - scrollTop - clientHeight < UIManager.SCROLL_BOTTOM_THRESHOLD;
    });
  }

  // ─── 事件处理器 ─────────────────────────────────────

  /**
   * 输入框键盘事件处理
   *
   * - Enter（非 Shift）：发送消息或停止流式输出
   * - Escape：清空输入（有内容时）或失焦（无内容时），交互参考终端/聊天应用惯例
   */
  private handleInputKeydown(e: Event): void {
    if (!(e instanceof KeyboardEvent)) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      // 合并按钮逻辑：流式态时 Enter 触发停止，空闲态时触发发送
      if (this.state.isStreaming) {
        this.emitStopMessage();
      } else {
        this.emitSendMessage();
      }
    } else if (e.key === 'Escape') {
      // Esc：有内容则清空，无内容则失焦
      if (this.inputEl.value.trim().length > 0) {
        this.inputEl.value = '';
        this.handleInputChange();
        this.updateSendButtonState();
      } else {
        this.inputEl.blur();
      }
    }
  }

  /**
   * 输入框内容变化处理
   *
   * - 自适应高度：根据 scrollHeight 动态调整，最大 120px
   * - 更新发送按钮视觉状态（空态弱化）
   */
  private handleInputChange(): void {
    this.inputEl.style.height = 'auto';
    this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 120) + 'px';
    this.updateSendButtonState();
  }

  /**
   * 根据输入内容和流式状态更新发送按钮视觉反馈
   *
   * - 流式态：始终可用（红色停止按钮）
   * - 空闲态+有内容：可用（蓝色发送按钮）
   * - 空闲态+无内容：弱化（灰色不可点击）
   */
  private updateSendButtonState(): void {
    if (this.state.isStreaming) return; // 流式态由 updateSendButton 处理
    const hasContent = this.inputEl.value.trim().length > 0;
    this.btnSend.disabled = !hasContent;
    this.btnSend.classList.toggle('empty', !hasContent);
  }

  private handleSendClick(): void {
    // 合并按钮：流式态时点击触发停止，空闲态时触发发送
    if (this.state.isStreaming) {
      this.emitStopMessage();
    } else {
      this.emitSendMessage();
    }
  }

  /**
   * FD-05 新建会话按钮点击处理器
   *
   * 设计原则（对齐 user_rules "主动可见"）：
   * - 低频但重要的操作，按钮始终可见，不依赖 hover
   * - 触发回调由 renderer.ts 注册，调用主进程 session-new IPC
   * - 确认对话框防止误操作（清空当前对话区是不可逆的，但历史保留在 SessionStore）
   */

  private handleNavClick(e: Event): void {
    const target = e.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    const panel = target.dataset.panel;
    if (panel) {
      // memories 特殊处理：toggle 抽屉；chat/settings 走 switchPanel 标准面板切换
      if (panel === 'memories') {
        this.toggleMemoryDrawer();
      } else {
        // switchPanel 为 async，void 显式忽略 Promise
        void this.switchPanel(panel);
      }
    }
  }

  /**
   * 切换感知面板的展开/收起状态
   * 点击精灵状态条触发，overlay 方式显示在消息区顶部
   */
  private togglePerceptionPanel(): void {
    const panel = document.getElementById('perception-panel');
    if (!panel) return;

    if (panel.classList.contains('visible')) {
      // 关闭面板（先播放动画再隐藏）
      panel.classList.add('hiding');
      panel.classList.remove('visible');
      setTimeout(() => {
        panel.classList.add('hidden');
        panel.classList.remove('hiding');
      }, 150);
    } else {
      // 打开面板
      panel.classList.remove('hidden', 'hiding');
      panel.classList.add('visible');
    }
  }

  /**
   * 关闭感知面板
   */
  private closePerceptionPanel(): void {
    const panel = document.getElementById('perception-panel');
    if (!panel) return;
    panel.classList.add('hiding');
    panel.classList.remove('visible');
    setTimeout(() => {
      panel.classList.add('hidden');
      panel.classList.remove('hiding');
    }, 150);
  }

  private handleMinimize(): void {
    window.electronAPI.windowMinimize();
  }

  private handleMaximize(): void {
    window.electronAPI.windowMaximize();
  }

  private handleClose(): void {
    window.electronAPI.windowClose();
  }

  /**
   * 更新最大化按钮图标
   *
   * 根据窗口当前是否最大化切换 SVG 图标：
   * - 最大化时显示还原图标（icon-restore）
   * - 普通状态时显示最大化图标（icon-maximize）
   *
   * 仅当 btnMaximize 元素存在时执行（部分布局可能不提供标题栏）
   */
  updateMaximizeButton(maximized: boolean): void {
    if (!this.btnMaximize) return;
    const iconId = maximized ? '#icon-restore' : '#icon-maximize';
    this.btnMaximize.innerHTML = `<svg class="icon"><use href="${iconId}"/></svg>`;
    this.btnMaximize.title = maximized ? '还原' : '最大化';
  }

  // ─── 主动提示 banner（代理到 ProactiveBanner） ──────────

  /**
   * 显示主动提示 banner（代理到 ProactiveBanner）
   *
   * 对齐设计契约 §6.6：
   * 顶部滑入蓝粉渐变 banner，提供"查看/稍后/静默 1 小时"三个操作。
   * 里程碑事件使用金色渐变庆祝样式。
   * 由 ipcListeners.ts 在收到 proactivePrompt 事件时调用。
   *
   * @param text 提示文本
   * @param isMilestone 是否为里程碑事件
   */
  showProactiveBanner(text: string, isMilestone = false): void {
    this.proactiveBanner.showProactiveBanner(text, isMilestone);
  }

  /**
   * 隐藏主动提示 banner（代理到 ProactiveBanner）
   *
   * 用户点击任意操作按钮后调用，或切换面板时调用。
   */
  hideProactiveBanner(): void {
    this.proactiveBanner.hideProactiveBanner();
  }

  /**
   * 初始化主动提示 banner 按钮事件（代理到 ProactiveBanner）
   *
   * 三个按钮的语义：
   * - 查看：切换到对话面板（banner 已在对话面板内，仅隐藏 banner）
   * - 稍后：隐藏 banner，等待下次触发
   * - 静默 1 小时：通知主进程进入静默模式
   *
   * 由 renderer.ts 调用以注册回调。
   */
  initProactiveBannerButtons(handlers: {
    onView: () => void;
    onLater: () => void;
    onSilent: () => void;
    onDisable?: () => void;
  }): void {
    this.proactiveBanner.initProactiveBannerButtons(handlers);
  }

  // ─── H1 配置建议卡片（代理到 SuggestionCardManager） ────

  /**
   * H1 显示配置建议卡片（代理到 SuggestionCardManager）
   *
   * 由 ipcListeners.ts 在收到 SUGGESTION_PUSH 事件时调用。
   * 卡片插入位置：#proactive-banner 之后、#messages 之前（顶部提示区）。
   * 同时最多显示 3 条建议（FIFO：超出时移除最早的）。
   *
   * @param suggestion 来自 AutoConfigRefiner 的配置建议
   */
  showSuggestion(suggestion: ConfigSuggestionPayload): void {
    this.suggestionCard.showSuggestion(suggestion);
  }

  // ─── H2 用户画像面板（代理到 ProfilePanelManager） ──────

  /**
   * H2 加载用户画像数据（代理到 ProfilePanelManager）
   *
   * 由 settingsController.ts 在以下场景调用：
   * - 设置面板初始化时预加载
   * - 切换到"画像"tab 时刷新
   * - 用户点击"刷新"按钮时（由 ProfilePanelManager 内部处理）
   *
   * 加载完成后渲染到 #profile-pending-list 和 #profile-confirmed-list。
   */
  async loadUserProfile(): Promise<void> {
    await this.profilePanel.load();
  }

  /**
   * H3 加载作品投影数据（代理到 WorkProjectionPanelManager）
   *
   * 由 settingsController.ts 在以下场景调用：
   * - 应用启动时预加载
   * - 切换到"作品"tab 时刷新
   * - 用户点击"刷新"按钮时（由 WorkProjectionPanelManager 内部处理）
   *
   * 加载完成后渲染到 #work-projection-list。
   */
  async loadWorkProjections(): Promise<void> {
    await this.workProjectionPanel.load();
  }

  /**
   * M2 加载审计日志数据（代理到 AuditPanelManager）
   *
   * 由 settingsController.ts 在以下场景调用：
   * - 应用启动时预加载
   * - 切换到"审计"tab 时刷新
   * - 用户点击"刷新"按钮时（由 AuditPanelManager 内部处理）
   *
   * 加载完成后渲染到 #audit-list。
   */
  async loadAuditLog(): Promise<void> {
    await this.auditPanel.load();
  }

  /**
   * M2 设置面板内 tab 切换回调（实现 SettingsPanelHost.onSettingsTabSwitch）
   *
   * 由 SettingsPanelManager 在 tab 切换时调用，
   * 根据目标 tab 刷新对应 PanelManager 的数据：
   * - profile → 刷新用户画像
   * - work → 刷新作品投影
   * - audit → 刷新审计日志
   * - skill → 刷新技能列表（通过 loadDashboard 间接刷新）
   */
  onSettingsTabSwitch(tab: string): void {
    switch (tab) {
      case 'profile':
        void this.profilePanel.load();
        break;
      case 'work':
        void this.workProjectionPanel.load();
        break;
      case 'audit':
        void this.auditPanel.load();
        break;
      // skill tab 的数据由 loadDashboard → renderSkills 驱动，无需单独加载
      default:
        break;
    }
  }

  /**
   * H3 更新学习进度卡片
   *
   * 聚合侧边栏"学习进度"卡片的四项指标：
   * - 建议数：来自配置建议卡片（suggestionCard）
   * - 画像数：来自用户画像面板（profilePanel）
   * - 作品数：来自作品投影面板（workProjectionPanel）
   * - 洞察数：来自仪表盘已有的洞察计数
   *
   * 在以下场景调用：
   * - 仪表盘加载完成后
   * - 画像加载完成后
   * - 作品投影加载完成后
   * - 配置建议推送后
   */
  updateLearningProgress(): void {
    const section = document.getElementById('learning-progress');
    if (!section) return;

    // 聚合各数据源的计数（使用已有的 DOM 元素值作为数据源）
    const suggestions = parseInt(document.getElementById('suggestion-count')?.textContent ?? '0', 10) || 0;
    const profile = this.getProfileCount();
    const works = parseInt(document.getElementById('work-projection-count')?.textContent ?? '0', 10) || 0;
    const insights = parseInt(document.getElementById('insight-count')?.textContent ?? '0', 10) || 0;

    // 更新四项指标
    const setVal = (id: string, val: number) => {
      const el = document.getElementById(id);
      if (el) el.textContent = String(val);
    };
    setVal('learn-suggestions', suggestions);
    setVal('learn-profile', profile);
    setVal('learn-works', works);
    setVal('learn-insights', insights);

    // 有数据时显示卡片，无数据时隐藏
    const hasData = suggestions > 0 || profile > 0 || works > 0 || insights > 0;
    section.classList.toggle('hidden', !hasData);
  }

  /**
   * 获取已确认画像条目数
   *
   * 从 #profile-confirmed-count 元素读取（由 ProfilePanelManager 渲染时更新）。
   * 兜底返回 0。
   */
  private getProfileCount(): number {
    const el = document.getElementById('profile-confirmed-count');
    return el ? (parseInt(el.textContent ?? '0', 10) || 0) : 0;
  }

  // ─── 事件发射 ─────────────────────────────────────────

  private sendMessageCallback: (() => void) | null = null;
  private stopMessageCallback: (() => void) | null = null;
  /** 面板切换回调（panel 为切换到的目标面板名） */
  private panelSwitchCallback: ((panel: string) => void) | null = null;

  /** 设置发送消息回调 */
  onSendMessage(callback: () => void): void {
    this.sendMessageCallback = callback;
  }

  /** 设置停止消息回调 */
  onStopMessage(callback: () => void): void {
    this.stopMessageCallback = callback;
  }

  /** 设置面板切换回调（切换到指定面板时触发数据刷新） */
  onPanelSwitch(callback: (panel: string) => void): void {
    this.panelSwitchCallback = callback;
  }

  private emitSendMessage(): void {
    // UX-P2-03 Agent 未就绪时禁止发送（LLM 未配置会导致 IPC 失败）
    if (!this.state.isAgentReady) {
      this.showToast('Agent 未就绪，请先在设置面板配置 LLM', 'warning');
      return;
    }
    // 空内容不发送
    if (this.inputEl.value.trim().length === 0) return;
    this.sendMessageCallback?.();
  }

  private emitStopMessage(): void {
    this.stopMessageCallback?.();
  }

  /**
   * 统一更新发送/停止按钮状态（空闲态发送 / 流式态停止）
   *
   * - 流式态：红色停止按钮，始终可用
   * - 空闲态：发送图标，空内容时弱化禁用
   */
  updateSendButton(): void {
    if (this.state.isStreaming) {
      // 流式态：显示停止姿态（红色方块图标）
      this.btnSend.disabled = false;
      this.btnSend.classList.add('streaming');
      this.btnSend.classList.remove('empty');
      this.btnSend.innerHTML = '<svg class="icon"><use href="#icon-stop"/></svg>';
      this.btnSend.title = '停止生成';
    } else {
      // 空闲态：显示发送姿态（纸飞机图标），空内容时弱化
      this.btnSend.classList.remove('streaming');
      this.btnSend.innerHTML = '<svg class="icon"><use href="#icon-send"/></svg>';
      this.btnSend.title = '发送（Enter）';
      this.updateSendButtonState();
    }
  }

  // ─── 状态查询 ─────────────────────────────────────────

  /** 获取当前状态 */
  getState(): UIState {
    return { ...this.state };
  }

  /** 是否正在流式输出 */
  isStreaming(): boolean {
    return this.state.isStreaming;
  }

  /**
   * 设置流式输出状态
   *
   * 替代 ChatPanelManager 通过共享 state 引用直接修改 isStreaming 的"友元类反模式"。
   * UIManager 作为 state 的唯一持有者，通过此方法封装状态变更。
   *
   * @param streaming 是否正在流式输出
   */
  setStreaming(streaming: boolean): void {
    this.state.isStreaming = streaming;
  }

  /**
   * UX-P2-03 设置 Agent 就绪状态
   *
   * 由 renderer.ts 在 onAgentReady 回调中调用，
   * 设置为 true 后用户才能发送消息。
   */
  setAgentReady(ready: boolean): void {
    this.state.isAgentReady = ready;
  }

  /** 获取当前面板 */
  getCurrentPanel(): string {
    return this.state.currentPanel;
  }

  // ─── 记忆面板 ─ 委托到 MemoryPanelManager ─────────────────

  /** 渲染记忆列表（委托到 MemoryPanelManager） */
  renderMemoryList(memories: MemoryListItem[], searchQuery?: string): void { this.memoryPanel.renderMemoryList(memories, searchQuery); }
  /** 显示记忆详情（委托到 MemoryPanelManager） */
  showMemoryDetail(memory: MemoryDetail): void { this.memoryPanel.showMemoryDetail(memory); }
  /** 清空添加记忆表单（委托到 MemoryPanelManager） */
  clearAddMemoryForm(): void { this.memoryPanel.clearAddMemoryForm(); }
  /** 获取添加记忆表单数据（空字段返回 null，委托到 MemoryPanelManager） */
  getAddMemoryFormData(): { source: string; name: string; content: string } | null {
    return this.memoryPanel.getAddMemoryFormData();
  }
  /** 获取当前查看的记忆 ID（委托到 MemoryPanelManager） */
  getCurrentMemoryId(): string | null { return this.memoryPanel.getCurrentMemoryId(); }
  /** 注册记忆搜索回调（委托到 MemoryPanelManager） */
  onMemorySearch(cb: (query: string) => void): void { this.memoryPanel.onMemorySearch(cb); }
  /** 注册记忆 source 筛选回调（委托到 MemoryPanelManager） */
  onMemoryFilter(cb: (source: string) => void): void { this.memoryPanel.onMemoryFilter(cb); }
  /** 注册记忆点击回调（委托到 MemoryPanelManager） */
  onMemoryClick(cb: (id: string) => void): void { this.memoryPanel.onMemoryClick(cb); }
  /** 注册记忆删除回调（委托到 MemoryPanelManager） */
  onMemoryDelete(cb: () => void): void { this.memoryPanel.onMemoryDelete(cb); }
  /** 注册记忆添加回调（委托到 MemoryPanelManager） */
  onMemoryAdd(cb: (data: { source: string; name: string; content: string }) => void): void { this.memoryPanel.onMemoryAdd(cb); }
  /** P2-FLOW-08 注册记忆编辑回调（委托到 MemoryPanelManager） */
  onMemoryEdit(cb: (id: string, content: string) => void): void { this.memoryPanel.onMemoryEdit(cb); }
  /** FD-ADD-MEMORY-DISCUSS 注册记忆讨论回调（委托到 MemoryPanelManager） */
  onMemoryDiscuss(cb: (memoryName: string) => void): void { this.memoryPanel.onMemoryDiscuss(cb); }
  /** 加载图谱数据到渲染器（委托到 MemoryPanelManager） */
  loadGraphData(data: RelationGraphData): void { this.memoryPanel.loadGraphData(data); }
  /** 切换记忆视图模式（委托到 MemoryPanelManager） */
  switchMemoryView(mode: 'list' | 'timeline' | 'graph'): void { this.memoryPanel.switchView(mode); }
  /** 检查是否有图谱数据（委托到 MemoryPanelManager） */
  hasGraphData(): boolean { return this.memoryPanel.hasGraphData(); }
  /** 设置图谱高亮节点（搜索联动，委托到 MemoryPanelManager） */
  highlightGraphNodes(nodeIds: string[] | null): void { this.memoryPanel.highlightGraphNodes(nodeIds); }
  /** 设置图谱选中节点（列表/详情联动，委托到 MemoryPanelManager） */
  selectGraphNode(nodeId: string | null): void { this.memoryPanel.selectGraphNode(nodeId); }
  /** 清除图谱所有高亮和选中（委托到 MemoryPanelManager） */
  clearGraphHighlights(): void { this.memoryPanel.clearGraphHighlights(); }
  /** 注册更多菜单项点击回调（委托到 MemoryPanelManager） */
  onMoreMenuAction(cb: (action: string) => void): void { this.memoryPanel.onMoreMenuAction(cb); }
  /** 注册排序变更回调（委托到 MemoryPanelManager） */
  onSortChange(cb: () => void): void { this.memoryPanel.onSortChange(cb); }
  /** 注册时间范围变更回调（委托到 MemoryPanelManager） */
  onTimeRangeChange(cb: () => void): void { this.memoryPanel.onTimeRangeChange(cb); }
  /** 注册清理请求回调（委托到 MemoryPanelManager） */
  onCleanupRequest(cb: (type: 'duplicates' | 'stale' | 'all') => string[]): void { this.memoryPanel.onCleanupRequest(cb); }
  /** 注册清理确认回调（委托到 MemoryPanelManager） */
  onCleanupConfirm(cb: (ids: string[]) => Promise<void>): void { this.memoryPanel.onCleanupConfirm(cb); }
  /** 注册视图切换回调（委托到 MemoryPanelManager） */
  onViewSwitch(cb: (mode: 'list' | 'timeline' | 'graph') => void): void { this.memoryPanel.onViewSwitch(cb); }
  /** 触发叙事卡片脉冲（委托到 MemoryPanelManager） */
  pulseNarrativeCard(): void { this.memoryPanel.pulseNarrativeCard(); }

  // ─── 仪表盘面板 ─ 委托到 DashboardPanelManager ───────────

  /** 渲染仪表盘统计数据（委托到 DashboardPanelManager） */
  renderDashboardStats(data: DashboardViewModel): void {
    this.dashboardPanel.renderDashboardStats(data);
  }
  /** 渲染 Agent 运行时指标（委托到 DashboardPanelManager） */
  renderAgentMetrics(metrics: AgentMetrics | null): void {
    this.dashboardPanel.renderAgentMetrics(metrics);
  }
  /** 渲染已加载技能列表（委托到 DashboardPanelManager） */
  renderSkills(skills: Array<{ name: string; keywords: string[]; description: string; layer: string }>): void {
    this.dashboardPanel.renderSkills(skills);
  }
  /** 渲染里程碑成就展示（委托到 DashboardPanelManager） */
  renderMilestones(data: { total: number; bySource: Record<string, number> }): void {
    this.dashboardPanel.renderMilestones(data);
  }
  /** 渲染对话回顾数据（委托到 DashboardPanelManager） */
  renderReviewData(data: ReviewDataPayload): void {
    this.dashboardPanel.renderReviewData(data);
  }
  /** 显示洞察面板加载态（委托到 DashboardPanelManager） */
  showInsightsLoading(): void { this.dashboardPanel.showInsightsLoading(); }
  /** 渲染记忆洞察数据（委托到 DashboardPanelManager） */
  renderInsights(
    dashboard: { total: number; bySource: Record<string, number>; conflictCount?: number },
    graph: RelationGraphData,
  ): void { this.dashboardPanel.renderInsights(dashboard, graph); }
  /** 显示洞察面板加载失败状态（委托到 DashboardPanelManager） */
  showInsightsError(): void { this.dashboardPanel.showInsightsError(); }
  /** 显示健康度面板加载态（委托到 DashboardPanelManager） */
  showHealthLoading(): void { this.dashboardPanel.showHealthLoading(); }
  /** 渲染记忆健康度仪表盘（委托到 DashboardPanelManager） */
  renderHealthDashboard(data: HealthDashboardPayload): void { this.dashboardPanel.renderHealthDashboard(data); }
  /** 显示健康度面板加载失败状态（委托到 DashboardPanelManager） */
  showHealthError(): void { this.dashboardPanel.showHealthError(); }
  /** 显示记忆列表加载失败状态（委托到 DashboardPanelManager） */
  showMemoryListError(listEl: HTMLElement): void { this.dashboardPanel.showMemoryListError(listEl); }
  /** 仪表盘计数 +1 并触发脉冲动画（委托到 DashboardPanelManager） */
  pulseCounter(id: string): void { this.dashboardPanel.pulseCounter(id); }
  /** 更新情感基调展示（委托到 DashboardPanelManager） */
  updateAffectDisplay(affect: AffectPayload): void {
    this.dashboardPanel.updateAffectDisplay(affect);
  }
  /** 更新默契度展示（委托到 DashboardPanelManager） */
  updateRapportDisplay(rapport: RapportPayload): void {
    this.dashboardPanel.updateRapportDisplay(rapport);
  }
  /** 更新对话上下文展示（委托到 DashboardPanelManager） */
  updateContextDisplay(context: ContextPayload): void {
    this.dashboardPanel.updateContextDisplay(context);
  }
  /** 更新模式洞察面板（委托到 DashboardPanelManager） */
  updatePatternsDisplay(payload: PatternsPayload): void {
    this.dashboardPanel.updatePatternsDisplay(payload);
  }
  /** 更新叙事摘要 DOM（委托到 DashboardPanelManager） */
  updateNarrative(): void { this.dashboardPanel.updateNarrative(); }
  /** 注册重试加载洞察数据回调（委托到 DashboardPanelManager） */
  onReloadInsights(cb: () => void): void { this.dashboardPanel.onReloadInsights(cb); }
  /** 注册重试加载健康度数据回调（委托到 DashboardPanelManager） */
  onReloadHealth(cb: () => void): void { this.dashboardPanel.onReloadHealth(cb); }
  /** 注册重试加载记忆列表回调（委托到 DashboardPanelManager） */
  onReloadMemoryList(cb: () => void): void { this.dashboardPanel.onReloadMemoryList(cb); }

  // ─── 角色选择器 ─ 委托到 PersonaPanelManager ───────────────

  /** 渲染角色下拉菜单（委托到 PersonaPanelManager） */
  renderPersonaDropdown(personas: PersonaItem[]): void { this.personaPanel.renderPersonaDropdown(personas); }
  /** 更新当前角色显示（委托到 PersonaPanelManager） */
  updateActivePersona(name: string): void { this.personaPanel.updateActivePersona(name); }
  /** 更新角色匹配模式标签（委托到 PersonaPanelManager） */
  updatePersonaModeBadge(mode: string): void { this.personaPanel.updatePersonaModeBadge(mode); }
  /** 注册角色切换回调（委托到 PersonaPanelManager） */
  onPersonaSwitch(cb: (name: string) => void): void { this.personaPanel.onPersonaSwitch(cb); }
  /** 注册召回记忆点击回调（委托到 PersonaPanelManager + ChatPanelManager，传完整记忆ID） */
  onMemoryRecallClick(cb: (memoryId: string) => void): void {
    this.personaPanel.onMemoryRecallClick(cb);
    this.chatPanel.setMemoryRecallClickCallback(cb);
  }
  /** FD-ADD-REC-CLICK 触发召回记忆点击（委托到 PersonaPanelManager，供仪表盘推荐记忆点击复用） */
  triggerMemoryRecall(memoryId: string): void { this.personaPanel.triggerMemoryRecallClick(memoryId); }

  /** IX-07 注册角色匹配模式变更回调（委托到 SettingsPanelManager） */
  onPersonaModeChange(cb: (mode: string) => void): void {
    this.settingsPanelManager.onPersonaModeChange(cb);
  }

  /**
   * ADR-SP-008 注册主题变更回调（代理到 ThemeManager）
   *
   * 当用户在设置面板切换主题时触发，renderer.ts 可借此执行额外同步逻辑。
   * 主题本身的持久化（localStorage）已在 setTheme 内完成，回调仅用于通知。
   *
   * QC-THEME-01：source 参数区分"用户主动切换"与"系统主题变化"，
   * renderer.ts 据此决定是否持久化到 sprite.json。
   *
   * @param cb 主题变更回调函数
   */
  onThemeChange(cb: (theme: 'light' | 'dark', source: 'user' | 'system') => void): void {
    this.themeManager.onThemeChange(cb);
  }

  /**
   * P3-FLOW-12 获取当前主题模式（代理到 ThemeManager）
   *
   * @returns 当前主题模式（'light' | 'dark' | 'auto'）
   */
  getThemeMode(): 'light' | 'dark' | 'auto' {
    return this.themeManager.getThemeMode();
  }

  /**
   * ADR-SP-008 设置主题（代理到 ThemeManager）
   *
   * 1. 设置 <html> 元素的 data-theme 属性（触发 CSS 变量切换）
   * 2. 持久化到 localStorage（key: 'memora-theme'）
   * 3. 同步设置面板单选按钮状态
   * 4. 触发 themeChangeCallback 通知 renderer.ts
   *
   * @param theme 目标主题
   */
  setTheme(theme: 'light' | 'dark' | 'auto'): void {
    this.themeManager.setTheme(theme);
  }

  /**
   * ADR-SP-008 同步设置面板主题单选按钮状态（代理到 ThemeManager）
   *
   * 在外部修改主题后（如初始化加载），调用此方法确保单选按钮选中状态与实际主题一致。
   * P3-FLOW-12 支持三态主题模式：light / dark / auto
   *
   * @param theme 当前主题模式
   */
  syncThemeRadios(theme: 'light' | 'dark' | 'auto'): void {
    this.themeManager.syncThemeRadios(theme);
  }

  // ─── 设置面板（委托到 SettingsPanelManager） ──

  // ─── FD-A2 统一面板错误横幅 ───────────────────────────────

  /**
   * FD-A2 初始化所有面板错误横幅的重试按钮
   *
   * 统一为 settings / memory / chat 三个面板绑定重试按钮点击事件，
   * 从 panelErrorRetryCallbacks Map 中查找对应的重试回调。
   * 按钮缺失时静默跳过（对应面板可能未提供错误横幅）。
   */
  private initPanelErrorRetryButtons(): void {
    const panelIds = ['settings', 'memory', 'chat'];
    for (const panelId of panelIds) {
      const retryBtn = document.getElementById(`${panelId}-error-retry`);
      if (retryBtn) {
        this.events.addEventListener(retryBtn, 'click', () => {
          const callback = this.panelErrorRetryCallbacks.get(panelId);
          if (callback) {
            callback();
          }
        });
      }
    }
  }

  /**
   * FD-A2 显示面板错误横幅（通用方法）
   *
   * 根据 panelId 查找对应的错误横幅元素并显示错误信息。
   * 可选传入重试回调，点击重试按钮时触发。
   *
   * @param panelId 面板标识（如 'settings' / 'memory' / 'chat'）
   * @param message 错误提示文本
   * @param retryCallback 重试回调（可选，点击重试按钮时触发）
   */
  showPanelError(panelId: string, message: string, retryCallback?: () => void): void {
    const errorEl = document.getElementById(`${panelId}-error`);
    const msgEl = document.getElementById(`${panelId}-error-msg`);
    if (errorEl && msgEl) {
      msgEl.textContent = message;
      errorEl.classList.remove('hidden');
    }
    if (retryCallback) {
      this.panelErrorRetryCallbacks.set(panelId, retryCallback);
    }
  }

  /**
   * FD-A2 隐藏面板错误横幅（通用方法）
   *
   * 隐藏对应面板的错误横幅并清除重试回调。
   *
   * @param panelId 面板标识
   */
  hidePanelError(panelId: string): void {
    const errorEl = document.getElementById(`${panelId}-error`);
    if (errorEl) {
      errorEl.classList.add('hidden');
    }
    this.panelErrorRetryCallbacks.delete(panelId);
  }

  /** FD-A2 显示设置面板加载失败错误横幅（委托到 showPanelError） */
  showSettingsError(message: string, retryCallback?: () => void): void {
    this.showPanelError('settings', message, retryCallback);
  }

  /** FD-A2 隐藏设置面板加载失败错误横幅（委托到 hidePanelError） */
  hideSettingsError(): void {
    this.hidePanelError('settings');
  }

  // ─── UX-FD-07 日期导航 ────────────────────────────────

  /** 日期导航跳转回调（由 renderer.ts 注册，调用 sessionController.jumpToDate） */
  private dateNavJumpCallback: ((date: string) => void) | null = null;
  /** 日期导航列表加载回调（下拉打开时触发，由 renderer.ts 注册） */
  private dateNavLoadCallback: (() => void) | null = null;

  /** 注册日期导航跳转回调 */
  onDateNavJump(cb: (date: string) => void): void {
    this.dateNavJumpCallback = cb;
  }

  /** 注册日期导航列表加载回调（下拉打开时触发） */
  onDateNavOpen(cb: () => void): void {
    this.dateNavLoadCallback = cb;
  }

  /** 切换日期导航下拉的显示/隐藏 */
  toggleDateNavDropdown(): void {
    const dropdown = document.getElementById('date-nav-dropdown');
    if (dropdown) {
      const wasHidden = dropdown.classList.contains('hidden');
      dropdown.classList.toggle('hidden');
      // 下拉打开时触发列表加载（确保数据最新）
      if (wasHidden && this.dateNavLoadCallback) {
        this.dateNavLoadCallback();
      }
    }
  }

  /** 关闭日期导航下拉 */
  closeDateNavDropdown(): void {
    const dropdown = document.getElementById('date-nav-dropdown');
    if (dropdown) {
      dropdown.classList.add('hidden');
    }
  }

  /**
   * 渲染日期列表到日期导航下拉
   *
   * @param dates 日期列表（每项包含日期、消息数、是否今天）
   * @param currentDate 当前查看的日期（用于高亮 active 项）
   */
  renderDateNavList(dates: Array<{ date: string; messageCount: number; isToday: boolean }>, currentDate: string): void {
    const list = document.getElementById('date-nav-list');
    if (!list) return;

    // 清空旧列表
    while (list.firstChild) {
      list.removeChild(list.firstChild);
    }

    if (dates.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'date-nav-empty';
      empty.textContent = '暂无历史对话';
      list.appendChild(empty);
      return;
    }

    for (const item of dates) {
      const li = document.createElement('li');
      li.className = 'date-nav-item';
      if (item.date === currentDate) {
        li.classList.add('active');
      }
      // data-action="jump-to-date" data-date="YYYY-MM-DD"
      li.dataset.action = 'jump-to-date';
      li.dataset.date = item.date;

      const dateEl = document.createElement('span');
      dateEl.className = 'date-nav-item-date';
      // 今天显示"今天"，昨天显示"昨天"，其他显示完整日期
      if (item.isToday) {
        dateEl.textContent = '今天';
      } else {
        // 简单的相对日期显示
        const today = new Date();
        const target = new Date(item.date);
        const diffDays = Math.floor((today.getTime() - target.getTime()) / MS_PER_DAY);
        if (diffDays === 1) {
          dateEl.textContent = '昨天';
        } else if (diffDays === 2) {
          dateEl.textContent = '前天';
        } else {
          dateEl.textContent = item.date;
        }
      }

      const countEl = document.createElement('span');
      countEl.className = 'date-nav-item-count';
      countEl.textContent = `${item.messageCount} 条`;

      li.appendChild(dateEl);
      li.appendChild(countEl);
      list.appendChild(li);
    }
  }

  /** 加载 LLM 配置到表单（委托到 SettingsPanelManager） */
  loadLlmConfigToForm(data: {
    configured: boolean;
    config: LlmConfigForm | null;
    embedding: { model: string; baseUrl: string; apiKey: string } | null;
    presets: Record<string, { provider: string; model: string; baseUrl: string }>;
  }): void {
    this.settingsPanelManager.loadLlmConfigToForm(data);
  }

  /** 收集表单中的 LLM 配置（委托到 SettingsPanelManager） */
  collectLlmConfigFromForm(): LlmConfigSavePayload {
    return this.settingsPanelManager.collectLlmConfigFromForm();
  }

  /** 加载配置到表单（委托到 SettingsPanelManager） */
  loadConfigToForm(config: SpriteConfigForm): void {
    this.settingsPanelManager.loadConfigToForm(config);
  }

  /** 加载项目列表到专注项目下拉框（委托到 SettingsPanelManager） */
  loadProjectsToForm(projects: Array<{ name: string; path: string }>, selectedPath: string): void {
    this.settingsPanelManager.loadProjectsToForm(projects, selectedPath);
  }

  /** 设置角色匹配模式（委托到 SettingsPanelManager） */
  setPersonaMode(mode: string): void {
    this.settingsPanelManager.setPersonaMode(mode);
  }

  /** 收集表单中的配置（委托到 SettingsPanelManager） */
  collectConfigFromForm(): SpriteConfigForm {
    return this.settingsPanelManager.collectConfigFromForm();
  }

  /** 设置面板保存回调（委托到 SettingsPanelManager） */
  onConfigSave(cb: (config: SpriteConfigForm) => void): void {
    this.settingsPanelManager.onConfigSave(cb);
  }
  /** 设置面板取消回调（委托到 SettingsPanelManager） */
  onConfigCancel(cb: () => void): void {
    this.settingsPanelManager.onConfigCancel(cb);
  }
  /** LLM 配置保存回调（委托到 SettingsPanelManager） */
  onLlmConfigSave(cb: (payload: LlmConfigSavePayload) => void): void {
    this.settingsPanelManager.onLlmConfigSave(cb);
  }
  /** LLM 连接测试回调（委托到 SettingsPanelManager） */
  onLlmTest(cb: () => void): void {
    this.settingsPanelManager.onLlmTest(cb);
  }

  /** 显示 LLM 测试连接结果（委托到 SettingsPanelManager） */
  showLlmTestResult(result: { success: boolean; error: string | null }, elapsedMs?: number): void {
    this.settingsPanelManager.showLlmTestResult(result, elapsedMs);
  }

  /** 收集表单中的 LLM 配置（委托到 SettingsPanelManager） */
  getLlmConfigFromForm(): { provider: string; model: string; baseUrl: string; apiKey: string } {
    return this.settingsPanelManager.getLlmConfigFromForm();
  }

  /** 重置设置表单 dirty 标志（委托到 SettingsPanelManager） */
  resetSettingsFormDirty(): void {
    this.settingsPanelManager.resetFormDirty();
  }

  /** UI-AUDIT-P0-2.3 检查设置面板是否有未保存修改（供 beforeunload 保护使用） */
  isSettingsDirty(): boolean {
    return this.settingsPanelManager.isDirty();
  }

  /**
   * P3-FLOW-10 更新 Agent 连接状态指示器（委托到 SettingsPanelManager）
   *
   * @param status Agent 连接状态（ready/error/unknown）
   * @param message 可选的状态描述文本
   */
  updateAgentStatusIndicator(status: 'ready' | 'error' | 'unknown', message?: string): void {
    this.settingsPanelManager.updateAgentStatusIndicator(status, message);
  }

  // ─── 弹窗管理（代理到 ModalManager） ──────────────────

  /** 显示弹窗（代理到 ModalManager） */
  showModal(modalId: string): void {
    this.modalManager.showModal(modalId);
  }

  /** 隐藏弹窗（代理到 ModalManager） */
  hideModal(modalId: string): void {
    this.modalManager.hideModal(modalId);
  }

  /**
   * 显示通用确认弹窗（代理到 ModalManager，替代 window.confirm）
   *
   * 返回 Promise，异步等待用户选择：
   * - true：用户点击确认按钮
   * - false：用户点击取消按钮、关闭按钮或背景
   *
   * @param options.title 弹窗标题（默认"确认"）
   * @param options.message 确认消息文本
   * @param options.confirmText 确认按钮文本（默认"确定"）
   * @param options.messageNodes 确认消息 DOM 节点数组（优先于 message，用于富文本展示）
   * @param options.cancelText 取消按钮文本（默认"取消"）
   * @param options.danger 是否危险操作（true 时确认按钮为红色，如删除）
   */
  showConfirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
    return this.modalManager.showConfirmDialog(options);
  }

  /**
   * M1：显示写入确认弹窗
   *
   * 当 Agent 工具尝试写入文件时，SecurityGuard 通过 IPC 推送写入确认请求。
   * 此方法在渲染进程展示确认对话框，显示文件路径、工具名和描述信息，
   * 用户确认后通过 responseWriteConfirmation 将结果传回主进程。
   *
   * @param info 写入确认请求载荷（来自主进程 WRITE_CONFIRMATION 推送）
   */
  async showWriteConfirmation(info: WriteConfirmationPayload): Promise<void> {
    // 委托到 ModalManager.showWriteConfirmation，门面层纯委托
    const confirmed = await this.modalManager.showWriteConfirmation(info);
    // 将用户决策传回主进程
    await window.electronAPI.responseWriteConfirmation(info.requestId, confirmed);
  }

  // ─── Phase 3.1：剪贴板三重保护 UI 联动 ──────────────────

  /**
   * 显示剪贴板变化 Toast（带"分析"按钮）
   *
   * 被动检测到剪贴板变化时调用，显示 info Toast 提示用户。
   * 用户点击"分析"按钮后触发主动分析（读取内容 + 敏感检测 + 护栏检查）。
   * 不自动消失，让用户有时间决定是否分析。
   */
  showClipboardChangedToast(): void {
    this.toastManager.showToast('剪贴板有新内容', 'info', 0, {
      actionLabel: '分析',
      onAction: () => {
        // 用户点击"分析"按钮，调用主进程读取并检测剪贴板内容
        void window.electronAPI.clipboardAnalyze();
      },
    });
  }

  /**
   * 显示剪贴板内容确认对话框
   *
   * 内容通过敏感检测和护栏检查后调用，展示内容预览供用户确认。
   * 用户确认后通过 MEMORIES_ADD 通道写入记忆。
   *
   * @param content 剪贴板内容（已通过检测）
   */
  async showClipboardConfirmDialog(content: string): Promise<void> {
    // 构建内容预览 DOM（防 XSS，使用 textContent）
    const container = document.createElement('div');
    container.className = 'write-confirm-info';

    const contentP = document.createElement('p');
    const contentLabel = document.createElement('strong');
    contentLabel.textContent = '内容：';
    contentP.appendChild(contentLabel);
    // 截断过长内容，避免对话框过大
    const preview = content.length > 200 ? content.slice(0, 200) + '...' : content;
    const codeEl = document.createElement('code');
    codeEl.textContent = preview;
    contentP.appendChild(codeEl);
    container.appendChild(contentP);

    const confirmed = await this.modalManager.showConfirmDialog({
      title: '将剪贴板内容存为记忆？',
      message: '',
      messageNodes: [container],
      confirmText: '存为记忆',
      cancelText: '取消',
    });

    if (confirmed) {
      // 用户确认后，通过 MEMORIES_ADD 写入记忆
      await window.electronAPI.addMemory({
        content,
        source: 'clipboard',
        name: `剪贴板记忆 ${new Date().toLocaleString()}`,
      });
      this.showToast('已存为记忆', 'success');
    }
  }

  // ─── Phase 3.3 第二批：全局快捷键触发处理 ──────────────

  /**
   * 处理 quick-record 快捷键触发
   *
   * 用户按下 Ctrl+Shift+M 时调用。
   * 切换到对话面板并聚焦输入框，让用户立即开始输入。
   * 主进程已确保完整窗口可见，此处只需聚焦输入框。
   */
  async handleQuickRecordTrigger(): Promise<void> {
    await this.switchPanel('chat');
    // switchPanel 已自动聚焦输入框，此处无需重复
  }

  /**
   * 处理 recall-memory 快捷键触发
   *
   * 用户按下 Ctrl+Shift+R 时调用。
   * 切换到记忆面板并聚焦搜索框，让用户立即开始搜索记忆。
   * 主进程已确保完整窗口可见，此处只需切换面板并聚焦搜索框。
   */
  async handleRecallMemoryTrigger(): Promise<void> {
    // 通过 switchPanel 走设置面板未保存修改检查，再打开抽屉
    await this.switchPanel('memories');
    // 选中已有文本，方便用户直接输入新搜索词替换
    const searchInput = document.getElementById('memory-search') as HTMLInputElement | null;
    if (searchInput) {
      // FD-ADD-RECALL-FOCUS：选中已有文本，方便用户直接输入新搜索词替换
      // 不选中时用户需要手动删除或覆盖，降低操作效率
      searchInput.select();
    }
  }

  /**
   * FD-ADD-MEMORY-DISCUSS 预填对话输入框
   *
   * 供记忆详情弹窗的「在对话中讨论」功能使用：
   * 将指定文本预填到对话输入框，用户可直接编辑或按 Enter 发送。
   * 仅在切换到对话面板后调用，输入框已由 switchPanel('chat') 自动聚焦。
   *
   * @param text 预填的文本内容
   */
  prefillChatInput(text: string): void {
    this.inputEl.value = text;
    // 触发 input 事件，让 chatPanelManager 感知内容变化（如自动调整高度）
    this.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // ─── 技能文件拖入安装 ──────────────────

  /** 技能安装成功回调（由 renderer.ts 注册，用于刷新技能列表） */
  private skillInstalledCallback: (() => void) | null = null;

  /**
   * 注册技能安装成功回调
   *
   * 安装成功后调用，renderer.ts 在此回调中刷新技能列表（loadDashboard）。
   * 与 onSendMessage 同模式，保持回调注册风格一致。
   */
  onSkillInstalled(callback: () => void): void {
    this.skillInstalledCallback = callback;
  }

  /**
   * 处理拖入的技能文件
   *
   * 由 dropzone 的 drop 事件触发。校验文件类型后调用 installSkillFile。
   * 多文件场景下逐个安装，任一失败不中断后续文件。
   *
   * @param files 拖入的文件列表
   */
  async handleSkillDrop(files: File[]): Promise<void> {
    if (!files || files.length === 0) return;

    // 过滤非 .md 文件（拖入多文件时可能混入其他类型）
    const mdFiles = files.filter((f) => f.name.toLowerCase().endsWith('.md'));
    if (mdFiles.length === 0) {
      this.showToast('仅支持 .md 技能文件', 'warning');
      this.flashDropzoneError();
      return;
    }
    if (mdFiles.length < files.length) {
      // 部分文件被跳过，提示用户
      const skipped = files.length - mdFiles.length;
      this.showToast(`已跳过 ${skipped} 个非 .md 文件`, 'info', TOAST_SHORT_MS);
    }

    // 逐个安装（避免并发写入冲突）
    let successCount = 0;
    let lastError = '';
    for (const file of mdFiles) {
      const ok = await this.installSkillFile(file);
      if (ok) {
        successCount++;
      } else {
        lastError = lastError || '部分文件安装失败';
      }
    }

    // 汇总反馈
    if (successCount > 0) {
      const msg = successCount === 1
        ? '技能安装成功'
        : `${successCount} 个技能安装成功`;
      this.showToast(msg, 'success', TOAST_NORMAL_MS);
      this.skillInstalledCallback?.();
    }
    if (lastError) {
      this.showToast(lastError, 'error', TOAST_LONG_MS);
      this.flashDropzoneError();
    }
  }

  /**
   * 触发文件选择对话框
   *
   * 由 dropzone 的 click 事件触发。打开隐藏的 <input type="file">，
   * 用户选择文件后由 change 事件处理（在 renderer.ts 中注册）。
   */
  handleSkillFileSelect(): void {
    const fileInput = document.getElementById('skill-file-input') as HTMLInputElement | null;
    fileInput?.click();
  }

  /**
   * 安装单个技能文件
   *
   * 内部方法，执行实际的文件读取 + IPC 调用 + 状态反馈。
   * 安装期间添加 .is-installing 类禁用 dropzone，避免重复触发。
   *
   * @param file 待安装的 .md 文件
   * @returns 是否安装成功
   */
  private async installSkillFile(file: File): Promise<boolean> {
    const dropzone = document.getElementById('skill-dropzone');
    if (!dropzone) return false;

    // 安装中态：降低透明度 + 禁用指针
    dropzone.classList.add('is-installing');
    try {
      // 读取文件内容（FileReader 同步读取为文本）
      const content = await this.readFileAsText(file);
      // 调用主进程 IPC 安装（校验 + 写入 configDir/skills/）
      const result = await window.electronAPI.installSkill(file.name, content);
      if (!result.success) {
        // 校验失败或写入失败，显示具体错误
        this.showToast(`${file.name}：${result.error}`, 'error', TOAST_LONG_MS);
        return false;
      }
      return true;
    } catch (err) {
      // 读取文件或 IPC 调用异常
      const errMsg = err instanceof Error ? err.message : String(err);
      this.showToast(`${file.name}：${errMsg}`, 'error', TOAST_LONG_MS);
      return false;
    } finally {
      // 无论成功失败，移除安装中态
      dropzone.classList.remove('is-installing');
    }
  }

  /**
   * 读取 File 为文本（Promise 包装 FileReader）
   *
   * @param file 待读取的文件
   * @returns 文件文本内容
   */
  private readFileAsText(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const text = reader.result;
        if (typeof text === 'string') {
          resolve(text);
        } else {
          reject(new Error('文件内容非文本'));
        }
      };
      reader.onerror = () => reject(reader.error || new Error('文件读取失败'));
      reader.readAsText(file);
    });
  }

  /**
   * 短暂闪烁 dropzone 错误态
   *
   * 添加 .is-error 类触发抖动动画，400ms 后移除。
   * 与 CSS @keyframes skill-dropzone-shake 时长一致。
   */
  private flashDropzoneError(): void {
    const dropzone = document.getElementById('skill-dropzone');
    if (!dropzone) return;
    dropzone.classList.add('is-error');
    // 动画结束后移除类（与 CSS animation 时长一致）
    window.setTimeout(() => {
      dropzone.classList.remove('is-error');
    }, 400);
  }

  /**
   * 显示通用输入弹窗（替代 window.prompt）
   *
   * 代理到 ModalManager.showInputDialog，提供一致的视觉体验。
   *
   * @returns 用户输入的内容（已 trim），取消时返回 null
   */
  showInputDialog(options: {
    title?: string;
    message: string;
    defaultValue?: string;
    placeholder?: string;
    maxLength?: number;
    required?: boolean;
  }): Promise<string | null> {
    return this.modalManager.showInputDialog(options);
  }

  // ─── 三态首次引导（代理到 OnboardingManager） ──────────

  /**
   * 检查是否需要显示三态首次引导（代理到 OnboardingManager）
   *
   * 使用 localStorage 标记，首次使用（未标记）时返回 true。
   * 老用户（已标记）不再显示，避免重复打扰。
   */
  shouldShowOnboarding(): boolean {
    return this.onboardingManager.shouldShowOnboarding();
  }

  /**
   * 显示三态首次引导弹窗（代理到 OnboardingManager）
   *
   * 介绍三态窗口模型（完整/浮动/托盘）+ 快捷键。
   * 用户点击"开始使用"或关闭弹窗后标记为已见过。
   */
  showOnboardingDialog(): void {
    this.onboardingManager.showOnboardingDialog();
  }

  // ─── IX-06 Toast 通知（代理到 ToastManager） ──────────

  /**
   * 显示 Toast 通知（代理到 ToastManager）
   *
   * IX-06 设计原则：
   * - 独立于对话历史（#messages），避免污染上下文
   * - 操作反馈（保存成功/失败/警告）走 toast，对话内容走 #messages
   * - error 类型不自动消失，需用户手动关闭，确保错误被看到
   * - 同时最多显示 5 条，超出时移除最早的，避免堆积
   *
   * @param message 通知文本
   * @param type 通知类型（默认 info）
   * @param duration 自动消失时长（毫秒），0 表示不自动消失；默认按类型决定
   */
  showToast(message: string, type: ToastType = 'info', duration?: number, options?: ToastOptions): void {
    this.toastManager.showToast(message, type, duration, options);
  }
}