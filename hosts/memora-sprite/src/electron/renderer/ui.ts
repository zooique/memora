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
 * - 薄委托方法群通过 mixin 模式注入（ADR-SP-015 §4），物理隔离到 helpers/ui-delegations/
 */

// 子模块导入（组合模式：UIManager 持有独立子模块实例）
import { getRequiredElement, getOptionalElement, formatDateKey } from './helpers/domHelpers.js';
import { setIcon } from './helpers/icon.js';
import { EventTracker } from './helpers/eventTracker.js';
// UI 初始化失败错误卡片（独立于 UIManager，避免半初始化状态二次错误）
import { renderInitFailureToBody } from './helpers/initFailureCard.js';
// 滚动控制拆分为独立 Controller（消息列表滚动 + rAF 节流）
import { ScrollController } from './helpers/scrollController.js';
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
import { PerceptionPanelManager } from './panels/perceptionPanelManager.js';
import type { PerceptionPanelHost } from './panels/perceptionPanelManager.js';
import { SpriteStatusPopover } from './panels/spriteStatusPopover.js';
import type { ProactiveStats } from '../../shared/spriteStats.js';
// Payload 类型直接从 ipcListeners（IPC 契约真理源）导入
import type {
  AffectPayload,
  RapportPayload,
  ContextPayload,
} from './ipcListeners.js';
import { PersonaPanelManager } from './panels/personaPanelManager.js';
// CommandPaletteManager 纳入 UIManager 组合体系，统一生命周期管理
import { CommandPaletteManager } from './panels/commandPaletteManager.js';
// 面板错误横幅拆分为独立 Manager
import { PanelErrorBannerManager } from './panels/panelErrorBannerManager.js';
// 剪贴板三重保护 UI 联动拆分为独立 Manager（数据/状态层）
import { ClipboardManager } from './panels/clipboardManager.js';
// 剪贴板待处理面板管理器（UI 渲染层）
import { ClipboardPanelManager } from './panels/clipboardPanelManager.js';
import type { ClipboardPanelHost } from './panels/clipboardPanelManager.js';
// 日期导航拆分为独立 Manager
import { DateNavManager } from './panels/dateNavManager.js';
// 对话内容搜索拆分为独立 Manager（跨会话关键词检索）
import { SearchMessagesManager } from './panels/searchMessagesManager.js';
// 技能拖入安装拆分为独立 Manager
import { SkillDropManager } from './panels/skillDropManager.js';
// 输入区域管理器拆分（输入框事件 + 发送按钮状态 + ResizeObserver）
import { InputAreaManager } from './panels/inputAreaManager.js';
import type { InputAreaHost } from './panels/inputAreaManager.js';
// 面板路由器拆分（面板切换 + 导航 + 键盘快捷键 + 窗口控制）
import { PanelRouter } from './panels/panelRouter.js';
import type { PanelRouterHost } from './panels/panelRouter.js';
// 未读徽章拆分为独立 Manager（纯 DOM 渲染，不持有业务状态）
import { BadgeManager } from './panels/badgeManager.js';
// 类型导入（仅用于类型注解，不引入运行时依赖）
import type {
  UIState,
  SpriteConfigForm,
} from './types.js';
// M1：写入确认 payload 类型（从 preload 导入，供 showWriteConfirmation 方法使用）
import type { WriteConfirmationPayload } from '../preload.js';
// Mixin 工具函数 + 6 个委托群（ADR-SP-015 §4 纯透传委托，物理隔离到 helpers/ui-delegations/）
import { applyMixins } from './helpers/applyMixins.js';
import { chatDelegations } from './helpers/ui-delegations/chatDelegations.js';
import type { ChatDelegations } from './helpers/ui-delegations/chatDelegations.js';
import { memoryDelegations } from './helpers/ui-delegations/memoryDelegations.js';
import type { MemoryDelegations } from './helpers/ui-delegations/memoryDelegations.js';
import { dashboardDelegations } from './helpers/ui-delegations/dashboardDelegations.js';
import type { DashboardDelegations } from './helpers/ui-delegations/dashboardDelegations.js';
import { personaThemeDelegations } from './helpers/ui-delegations/personaThemeDelegations.js';
import type { PersonaThemeDelegations } from './helpers/ui-delegations/personaThemeDelegations.js';
import { settingsModalDelegations } from './helpers/ui-delegations/settingsModalDelegations.js';
import type { SettingsModalDelegations } from './helpers/ui-delegations/settingsModalDelegations.js';
import { miscDelegations } from './helpers/ui-delegations/miscDelegations.js';
import type { MiscDelegations } from './helpers/ui-delegations/miscDelegations.js';

// 重新导出，保持 ui.ts 的公共 API 不变（其他模块从 ui.ts 导入这些类型）
export type {
  MemoryListItem,
  MemorySearchHit,
  MemoryDetail,
  SpriteConfigForm,
  Message,
  UIState,
  PersonaItem,
  ToastType,
} from './types.js';

// ─── 工具函数（formatTimeAgo、setButtonLoading）见 domHelpers.ts ───
// renderInitFailureToBody 已提取到 helpers/initFailureCard.ts

// ─── UI 管理器类 ─────────────────────────────────────────

export class UIManager implements ChatPanelHost, MemoryPanelHost, DashboardPanelHost, PanelRouterHost {
  // ─── 组合子模块（独立管理器，UIManager 代理公共 API） ──
  // 字段为 public：mixin 委托方法（helpers/ui-delegations/）需通过 this.xxx 访问
  /** Toast 通知管理器（独立管理定时器和清理） */
  toastManager = new ToastManager();
  /** 模态框管理器（独立管理焦点恢复和并发保护） */
  modalManager = new ModalManager();
  /** 多步骤引导管理器（基于 Provider 配置存在性判定是否显示） */
  onboardingManager = new OnboardingManager();
  /** 主题管理器（独立管理主题切换和持久化） */
  themeManager = new ThemeManager();
  /** 主动提示横幅管理器（独立管理横幅按钮事件） */
  proactiveBanner = new ProactiveBanner();
  /** 配置建议卡片管理器（独立管理卡片显示/接受/拒绝，与 ProactiveBanner 同模式） */
  suggestionCard = new SuggestionCardManager();
  /** 用户画像面板管理器（独立管理画像 tab 的加载/确认/拒绝） */
  profilePanel = new ProfilePanelManager();
  /** 作品投影面板管理器（独立管理作品 tab 的加载/渲染/展开） */
  workProjectionPanel = new WorkProjectionPanelManager();
  /** M2 审计日志面板管理器（独立管理审计 tab 的加载/渲染/清空） */
  auditPanel = new AuditPanelManager();
  /** 设置面板管理器（独立管理设置面板 DOM 和事件） */
  settingsPanelManager: SettingsPanelManager;
  /** 缓存当前 SpriteConfig（供 getArchiveMode 查询，避免异步 IPC 调用） */
  private currentConfig: SpriteConfigForm | null = null;

  // ─── 面板管理器（聊天/记忆/角色/会话） ──
  /** 聊天面板管理器（消息渲染、流式输出、思考指示器、工具调用卡片） */
  chatPanel: ChatPanelManager;
  /** 记忆面板管理器（列表渲染、搜索过滤、详情弹窗） */
  memoryPanel: MemoryPanelManager;
  /** 仪表盘面板管理器（感知系统 + 仪表盘渲染） */
  dashboardPanel: DashboardPanelManager;
  /** 感知面板管理器（独立感知面板，完整版感知数据展示 + 叙事摘要） */
  perceptionPanel: PerceptionPanelManager;
  /** 精灵状态浮层（hover 弹出轻量感知摘要，与 PerceptionPanelManager 共享数据源） */
  spriteStatusPopover: SpriteStatusPopover;
  /** 角色选择器面板管理器（下拉菜单、角色切换） */
  personaPanel: PersonaPanelManager;
  /**
   * 快捷命令面板管理器（Ctrl+K）
   *
   * 纳入 UIManager 组合体系，与其他子管理器同模式：
   * 构造函数创建、cleanup() 统一清理全局 keydown 监听器（避免页面重载后累积）。
   */
  commandPaletteManager: CommandPaletteManager;
  /**
   * 面板错误横幅管理器
   *
   * 统一管理 settings / memory / chat 三个面板的错误横幅。
   * UIManager 仅保留薄委托。
   */
  panelErrorBannerManager: PanelErrorBannerManager;
  /**
   * 剪贴板三重保护面板管理器
   *
   * 统一管理"剪贴板三重保护"的 UI 联动。UIManager 仅保留薄委托。
   * 依赖注入 ToastManager / ModalManager 实例，与 UIManager 共享同一引用。
   */
  clipboardManager: ClipboardManager;
  /**
   * 剪贴板待处理面板管理器（UI 渲染层）
   *
   * 与 ClipboardManager 解耦：
   * - ClipboardManager 持有数据/状态（pendingItems、stale 标记、敏感警告）
   * - ClipboardPanelManager 负责 UI 渲染（列表、角标、引导气泡、归档/忽略按钮）
   * 单向依赖：PanelManager 依赖 Manager，Manager 通过 onChange 回调通知 PanelManager 刷新。
   * UIManager 作为 host 提供 showToast / showConfirmDialog，与 ClipboardPanelHost 接口对齐。
   */
  clipboardPanelManager: ClipboardPanelManager;
  /**
   * 日期导航面板管理器
   *
   * 统一管理"日期导航"功能的 UI 联动。UIManager 仅保留薄委托。
   * 自包含 EventTracker，init() 绑定事件，cleanup() 统一清理。
   */
  dateNavManager: DateNavManager;
  /**
   * 对话内容搜索管理器
   *
   * 统一管理"跨会话关键词检索"功能的 UI 联动。UIManager 仅保留薄委托。
   * 自包含 EventTracker，init() 绑定事件，cleanup() 统一清理。
   */
  searchMessagesManager: SearchMessagesManager;
  /**
   * 技能拖入安装面板管理器
   *
   * 统一管理"技能文件拖入安装"功能的 UI 联动。UIManager 仅保留薄委托。
   * 依赖注入 ToastManager 实例，与 UIManager 共享同一引用。
   */
  skillDropManager: SkillDropManager;
  /** 面板路由器（面板切换 + 导航 + 键盘快捷键 + 窗口控制） */
  panelRouter: PanelRouter;
  /** 未读徽章管理器（纯 DOM 渲染，不持有业务状态） */
  badgeManager: BadgeManager;
  /** 滚动控制器（消息列表滚动 + rAF 节流） */
  scrollController: ScrollController;
  /** 输入区域管理器（输入框事件 + 发送按钮状态 + ResizeObserver） */
  inputAreaManager: InputAreaManager;

  // ─── 核心交互元素（必需，缺失时抛出） ──────────────────
  private messagesEl: HTMLElement;
  private inputEl: HTMLTextAreaElement;
  private btnSend: HTMLButtonElement;
  /** B2：停止生成浮动按钮（独立于发送按钮，流式态时可见，对齐 demo v3 .btn-stop-float） */
  private btnStop: HTMLButtonElement;

  // ─── 可选元素（缺失时降级，不阻塞其他功能） ────────────
  /** 未读计数徽章（标题栏右上角，部分布局可能未提供该元素） */
  private badge: HTMLElement | null;
  /** 最大化按钮（标题栏右侧，用于图标切换 □ ↔ ❐） */
  private btnMaximize: HTMLButtonElement | null;
  /** 聊天面板 Agent 状态指示器（输入区上方，门面体验：让用户看到初始化进度） */
  private chatAgentStatusEl: HTMLElement | null;

  private state: UIState = {
    currentPanel: 'chat',
    unreadCount: 0,
    isStreaming: false,
    // 初始为 false，onAgentReady 回调中置 true
    isAgentReady: false,
    // 初始为 false，首次 listLlmProviders 返回非空列表时置 true
    hasProviders: false,
  };

  /** 活跃的流式消息映射（messageId → DOM 元素），ChatPanelManager 共享引用 */
  private streamingMessages = new Map<string, HTMLElement>();
  /** 事件监听器跟踪器（统一管理事件监听器的注册与清理，避免内存泄漏） */
  private events = new EventTracker();

  // ─── UI 状态字段 ────────────────────────────────────────
  // panelErrorRetryCallbacks 已移至 PanelErrorBannerManager
  // isNearBottom 已移至 ScrollController

  constructor() {
    // 核心元素预检——缺失时先渲染错误提示到 document.body，再 rethrow。
    // 保留 fast-fail 设计意图（不进入半初始化状态），同时避免用户看到空白无提示。
    try {
      // ─── 核心交互元素：必需，缺失时抛出（UI 无法工作） ────
      this.messagesEl = getRequiredElement('messages', 'div');
      this.inputEl = getRequiredElement('input', 'textarea');
      this.btnSend = getRequiredElement('btn-send', 'button');
      // B2：停止生成按钮（独立元素，流式态时通过 .visible 类显示）
      this.btnStop = getRequiredElement('btn-stop', 'button');
    } catch (err) {
      // 渲染初始化失败错误提示到 document.body（独立于 UIManager 自身，避免半初始化状态）
      renderInitFailureToBody(err);
      throw err;
    }

    // ─── 可选元素：缺失时 warn 并降级，不阻塞其他功能 ──────
    this.badge = document.getElementById('badge');
    this.btnMaximize = getOptionalElement('btn-maximize', 'button');
    // 聊天面板 Agent 状态指示器（缺失时降级，不影响其他功能）
    this.chatAgentStatusEl = document.getElementById('chat-agent-status');
    // 初始化指示器状态
    this.updateChatAgentStatus();
    // 注入 Agent 就绪状态查询函数，供 onboarding step 4 完成消息感知初始化进度
    this.onboardingManager.setAgentReadyProvider(() => this.isAgentReady());
    // 注入确认弹窗函数，供 onboarding 步骤 2 跳过时弹二次确认避免误触丢失输入
    this.onboardingManager.setConfirmDialog((options) => this.showConfirmDialog(options));

    // 未读徽章管理器（纯 DOM 渲染，badge 可为 null）
    this.badgeManager = new BadgeManager(this.badge);
    // 滚动控制器（独立管理消息列表滚动 + rAF 节流）
    this.scrollController = new ScrollController(this.messagesEl);

    this.settingsPanelManager = new SettingsPanelManager(this as SettingsPanelHost);

    // 初始化配置建议卡片容器（动态创建 #suggestion-container 或复用 HTML 预定义元素）
  // 注入 showToast 用于操作失败时给用户可见反馈
  this.suggestionCard.init((msg, type) => this.showToast(msg, type));
  // 初始化用户画像面板（绑定刷新按钮事件，注入确认对话框用于删除已确认画像的二次确认）
  this.profilePanel.init((opts) => this.showConfirmDialog(opts));
  // 初始化作品投影面板（绑定刷新按钮事件）
  this.workProjectionPanel.init();
    // M2 初始化审计日志面板（绑定刷新/清空按钮事件，注入确认对话框用于清空二次确认）
    this.auditPanel.init((opts) => this.showConfirmDialog(opts));

    // ─── 面板管理器初始化 ───

    // 每个面板持有独立的 EventTracker，避免 cleanup 时互相干扰
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

    // 感知面板管理器（独立感知面板，完整版感知数据展示）
    this.perceptionPanel = new PerceptionPanelManager(this as PerceptionPanelHost);

    // 精灵状态浮层（hover 弹出轻量感知摘要）
    this.spriteStatusPopover = new SpriteStatusPopover();

    // 角色选择器面板管理器
    this.personaPanel = new PersonaPanelManager(
      getOptionalElement('persona-selector', 'button'),
      getOptionalElement('persona-dropdown', 'div'),
      getOptionalElement('persona-name', 'span'),
      new EventTracker(),
    );

    // 快捷命令面板管理器（与其他面板管理器同模式：构造函数创建 + init 调用）
    this.commandPaletteManager = new CommandPaletteManager(this);
    // 面板错误横幅管理器（自包含，无依赖，直接创建）
    this.panelErrorBannerManager = new PanelErrorBannerManager();
    // 剪贴板保护管理器（依赖注入 toastManager + modalManager，与 UIManager 共享同一引用）
    this.clipboardManager = new ClipboardManager(this.toastManager, this.modalManager);
    // 剪贴板待处理面板管理器：依赖 clipboardManager 数据层 + UIManager 作为 host 提供弹窗/Toast
    this.clipboardPanelManager = new ClipboardPanelManager(
      this.clipboardManager,
      this as ClipboardPanelHost,
      new EventTracker(),
    );
    // 日期导航管理器（自包含，无依赖，直接创建）
    this.dateNavManager = new DateNavManager();
    // 对话内容搜索管理器（自包含，无依赖，直接创建）
    this.searchMessagesManager = new SearchMessagesManager();
    // 技能拖入安装管理器（依赖注入 toastManager，与 UIManager 共享同一引用）
    this.skillDropManager = new SkillDropManager(this.toastManager);
    // 输入区域管理器（依赖注入 inputEl/btnSend + 独立 EventTracker + host 接口）
    this.inputAreaManager = new InputAreaManager(
      this.inputEl,
      this.btnSend,
      new EventTracker(),
      this as InputAreaHost,
    );

    // 面板路由器（面板切换 + 导航 + 键盘快捷键 + 窗口控制）
    this.panelRouter = new PanelRouter(this);

    // 初始化 UI
    this.initEventListeners();
    this.memoryPanel.initMemoryPanelListeners();
    this.personaPanel.initPersonaSelectorListeners();
    this.settingsPanelManager.initListeners();
    // init 需在 initEventListeners 之后（cmdk 按钮监听在 initEventListeners 中注册）
    this.commandPaletteManager.init();
    // 面板错误横幅重试按钮初始化（委托到 PanelErrorBannerManager）
    this.panelErrorBannerManager.init();
    // 剪贴板待处理面板初始化（委托到 ClipboardPanelManager：绑定批量操作 + 引导气泡 + 注入 onChange + 首次渲染）
    this.clipboardPanelManager.init();
    // 精灵状态条点击：切换到仪表盘面板（替代旧的感知面板 overlay）
    this.initSpriteStatusBarClick();
    // 日期导航事件初始化（委托到 DateNavManager）
    this.dateNavManager.init();
    // 对话内容搜索事件初始化（委托到 SearchMessagesManager）
    this.searchMessagesManager.init();
    // 模态框监听器委托给 ModalManager（独立管理事件清理）
    this.modalManager.initModalListeners();
    this.chatPanel.initEmptyStateListeners();
    this.chatPanel.initScrollToBottomButton();
    this.scrollController.initListener();
    // 输入区域事件 + ResizeObserver 初始化（委托到 InputAreaManager）
    this.inputAreaManager.init();
  }

  // ─── 事件监听器管理 ─────────────────────────────────────

  /** 初始化事件监听器（非路由事件） */
  private initEventListeners(): void {
    // 输入框 keydown/input + 发送按钮 click 事件已委托到 InputAreaManager.init()
    // B2：停止生成按钮（流式态时可见，触发 emitStopMessage）
    this.events.addEventListener(this.btnStop, 'click', this.emitStopMessage.bind(this));

    // 导航事件、窗口控制按钮、全局键盘快捷键 → 委托到 PanelRouter.init()
    this.panelRouter.init();

    // 输入区平铺工具按钮：添加记忆
    const btnInputAddMemory = getOptionalElement('btn-input-add-memory', 'button');
    if (btnInputAddMemory) {
      this.events.addEventListener(btnInputAddMemory, 'click', () => {
        this.showModal('memory-add-modal');
      });
    }

    // 标题栏命令面板入口按钮（Ctrl+K 的鼠标入口）
    const btnCmdk = getOptionalElement('titlebar-cmdk', 'button');
    if (btnCmdk) {
      this.events.addEventListener(btnCmdk, 'click', () => {
        this.commandPaletteManager.open();
      });
    }
  }

  /** 清理所有事件监听器和子模块资源 */
  cleanup(): void {
    // 清理所有事件监听器（通过 EventTracker 统一管理）
    this.events.cleanup();
    // 输入区域管理器清理（ResizeObserver + 事件监听器，委托到 InputAreaManager）
    this.inputAreaManager.cleanup();
    // 委托子模块清理各自的资源（Toast 定时器、Modal 监听器、ProactiveBanner 监听器、SettingsPanel 监听器）
    this.toastManager.cleanup();
    this.modalManager.cleanup();
    this.proactiveBanner.cleanup();
    this.suggestionCard.cleanup(); // 清理配置建议卡片事件监听器和 DOM
    this.profilePanel.cleanup(); // 清理用户画像面板事件监听器
    this.workProjectionPanel.cleanup(); // 清理作品投影面板事件监听器
    this.auditPanel.cleanup(); // M2 清理审计日志面板事件监听器
    this.settingsPanelManager.cleanup();
    // 清理面板管理器
    this.chatPanel.cleanup();
    this.memoryPanel.cleanup(); // Q1 清理记忆面板防抖定时器
    this.dashboardPanel.cleanup(); // 清理仪表盘脉冲定时器与重试按钮事件
    this.perceptionPanel.cleanup(); // 清理感知面板资源
    this.spriteStatusPopover.cleanup(); // 清理精灵状态浮层 hover 事件和定时器
    this.personaPanel.cleanup();
    // 清理命令面板的全局 keydown 监听器，避免页面重载后累积
    this.commandPaletteManager.cleanup();
    // 清理面板错误横幅的重试按钮监听器和回调映射
    this.panelErrorBannerManager.cleanup();
    // 清理剪贴板待处理面板管理器（移除 DOM 事件 + onChange 回调引用）
    this.clipboardPanelManager.cleanup();
    // 清理剪贴板保护管理器（清空 pendingItems + 移除 onChange 引用）
    this.clipboardManager.cleanup();
    // 清理日期导航管理器的事件监听器和回调
    this.dateNavManager.cleanup();
    // 清理对话内容搜索管理器的事件监听器、防抖定时器和回调
    this.searchMessagesManager.cleanup();
    // 清理技能拖入安装管理器的回调引用
    this.skillDropManager.cleanup();
    // 清理面板路由器的事件监听器
    this.panelRouter.cleanup();
    // 清理滚动控制器的 rAF 请求 + scroll 事件监听器
    this.scrollController.dispose();
    // 清理 ThemeManager 的系统主题变化监听器
    this.themeManager.cleanup();
  }

  // ─── 聊天面板（含业务逻辑的方法，纯透传委托见 chatDelegations） ──

  /** 查询当前归档模式（从缓存的 SpriteConfig 读取） */
  getArchiveMode(): 'full' | 'insights-only' | 'manual' {
    return this.currentConfig?.archiveMode ?? 'full';
  }
  /** 一键归档：批量归档当前会话（委托 preload 调用 agent.archiveSessionContent） */
  async archiveSession(date: string, session: string): Promise<number> {
    const result = await window.electronAPI.archiveSession(date, session);
    return result.archivedCount;
  }
  /** 获取当前会话 ID（由 renderer.ts 注入 sessionController.getCurrentSessionId） */
  private _getCurrentSessionId: (() => string) | null = null;
  setCurrentSessionIdProvider(fn: () => string): void { this._getCurrentSessionId = fn; }
  getCurrentSessionId(): string {
    return this._getCurrentSessionId?.() ?? formatDateKey(new Date()) + '-main';
  }
  /** 手动归档对话（调用 preload 暴露的 archiveProfileFacts + archiveInsight IPC） */
  async archiveConversation(input: string, assistantContent: string): Promise<number> {
    // 同时触发 profile facts + insight 归档，返回总条目数
    const [profileResult, insightResult] = await Promise.all([
      window.electronAPI.archiveProfileFacts(input),
      window.electronAPI.archiveInsight(input, assistantContent),
    ]);
    return profileResult.count + insightResult.count;
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
    // fire-and-forget：主进程清理是 best-effort，渲染进程已自行重置 isStreaming
    // Web 模式下 abortChat 走 HTTP，网络错误可能 reject，追加 catch 防止 unhandled rejection
    void window.electronAPI.abortChat().catch(() => {
      // 中断失败非关键：渲染进程已自行重置 isStreaming，主进程清理失败不影响用户体验
    });
  }

  /**
   * 重新生成上一条精灵消息（ChatPanelHost 回调：右键菜单"重新生成"触发）
   *
   * 将用户消息内容填入输入框并触发发送，复用现有 sendMessageCallback 链路。
   *
   * @param userMessage 用户消息内容（从 DOM 中提取，用于重新发送）
   */
  regenerateLastMessage(userMessage: string): void {
    if (!this.state.isAgentReady) {
      this.showToast('精灵未就绪，请先在设置面板配置 LLM', 'warning');
      void this.switchPanel('settings');
      return;
    }
    if (this.state.isStreaming) {
      this.showToast('精灵正在回复中，请等待完成或点击停止', 'warning');
      return;
    }
    // 预填用户消息内容（自动调整输入框高度）
    this.inputAreaManager.setValue(userMessage);
    this.sendMessageCallback?.();
  }

  // setButtonLoading 见 domHelpers.ts，UIManager 不持有此方法

  // ─── 面板管理 ─────────────────────────────────────────

  /**
   * 切换面板（委托到 PanelRouter）
   *
   * chat/memories/settings 三个面板均通过 .panel.active 控制显隐。
   */
  async switchPanel(panel: string): Promise<void> {
    await this.panelRouter.switchPanel(panel);
  }

  /** 添加精灵状态条点击：切换到感知面板（状态条数据来自感知系统，跳转应去感知面板） */
  initSpriteStatusBarClick(): void {
    const spriteStatusBar = document.getElementById('sprite-status-bar');
    if (spriteStatusBar) {
      this.events.addEventListener(spriteStatusBar, 'click', () => {
        this.panelRouter.switchPanel('perception');
      });
    }
  }

  /**
   * 更新精灵状态条文字与脉冲点颜色（PerceptionPanelHost 接口实现）
   *
   * 精灵状态条 (#sprite-status-text-bar / #sprite-status-dot-bar) 位于对话面板顶栏，
   * 是跨面板共享元素：数据来自感知系统，DOM 在对话面板。
   * 由 PerceptionPanelManager 通过 Host 接口调用，避免感知面板直接写对话面板 DOM。
   *
   * @param text 状态条文字（如"基调：温暖（较高）"或叙事摘要）
   * @param dotColor 脉冲点颜色（仅 affectDisplay 更新时传入，叙事覆盖时 undefined）
   */
  updateSpriteStatus(text: string, dotColor?: string): void {
    const statusTextBar = document.getElementById('sprite-status-text-bar');
    if (statusTextBar) {
      statusTextBar.textContent = text;
    }
    if (dotColor !== undefined) {
      const statusDotBar = document.getElementById('sprite-status-dot-bar');
      if (statusDotBar) {
        statusDotBar.style.background = dotColor;
      }
    }
  }

  // ─── 输入处理（委托到 InputAreaManager） ────

  /**
   * 获取并清理用户输入（委托到 InputAreaManager）
   *
   * 返回 trim + 长度限制后的文本，同时清空输入框。
   * 空输入返回 null。
   */
  getUserInput(): string | null {
    const text = this.inputAreaManager.getValue();
    if (!text) return null;
    this.inputAreaManager.clearInput();
    return text;
  }

  // ─── 未读计数（委托到 BadgeManager） ──────────────────

  /** 更新未读徽章显示（ChatPanelHost 回调） */
  updateBadge(): void {
    this.badgeManager.updateBadge(this.state.unreadCount);
  }

  /** 清除未读计数 */
  clearUnreadCount(): void {
    this.state.unreadCount = 0;
    this.badgeManager.clear();
  }

  /**
   * 设置未读计数（由主进程同步）
   *
   * 用于浮动窗口与完整窗口的未读计数同步：
   * 主进程在浮动窗口收到新消息时推送权威计数到完整窗口。
   */
  setUnreadCount(count: number): void {
    this.state.unreadCount = Math.max(0, count);
    this.badgeManager.setCount(this.state.unreadCount);
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

  /** 获取面板切换回调（PanelRouterHost 接口） */
  getPanelSwitchCallback(): ((panel: string) => void) | null {
    return this.panelSwitchCallback;
  }

  // InputAreaHost 接口要求 public（inputAreaManager 通过 host.emitSendMessage() 调用）
  emitSendMessage(): void {
    // Agent 未就绪时区分两种场景：
    // - 已配置 Provider 但未就绪 → 正在初始化，仅 Toast 提示，不切面板（避免门面体验断点）
    // - 未配置 Provider → 引导用户去设置面板配置
    if (!this.state.isAgentReady) {
      if (this.state.hasProviders) {
        this.showToast('精灵正在初始化中，请稍候片刻...', 'warning');
      } else {
        this.showToast('请先配置 AI 服务商后才能开始对话', 'warning');
        void this.switchPanel('settings');
      }
      return;
    }
    // 空内容不发送
    if (this.inputEl.value.trim().length === 0) return;
    this.sendMessageCallback?.();
  }

  // InputAreaHost 接口要求 public（inputAreaManager 通过 host.emitStopMessage() 调用）
  emitStopMessage(): void {
    this.stopMessageCallback?.();
  }

  /**
   * 跳转到设置面板（InputAreaHost 接口）
   *
   * 由 Provider 选择器空状态提示项点击触发，
   * 帮助用户快速到达 LLM 配置入口，符合"主动可见"原则。
   */
  switchToSettings(): void {
    void this.switchPanel('settings');
  }

  /**
   * B2：统一更新发送/停止按钮可见性
   *
   * 设计变更（对齐 demo v3 .btn-stop-float）：
   * - 流式态：显示 #btn-stop 浮动按钮，#btn-send 隐藏（避免误触发送）
   * - 空闲态：隐藏 #btn-stop，#btn-send 恢复发送姿态（空内容时弱化禁用）
   *
   * 拆分为独立按钮，语义更清晰，且与 demo v3 视觉设计一致。
   */
  updateSendButton(): void {
    if (this.state.isStreaming) {
      // 流式态：显示停止浮动按钮，禁用发送按钮（避免流式中误触发送）
      this.btnStop.classList.add('visible');
      this.btnSend.disabled = true;
      this.btnSend.classList.add('hidden');
    } else {
      // 空闲态：隐藏停止按钮，恢复发送按钮
      this.btnStop.classList.remove('visible');
      this.btnSend.classList.remove('hidden');
      // 恢复发送图标（防御性：避免被其他逻辑污染）
      setIcon(this.btnSend, 'icon-send');
      this.btnSend.title = '发送（Enter）';
      // 委托到 InputAreaManager 刷新发送按钮状态（空态弱化）
      this.inputAreaManager.refreshSendButtonState();
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
    // 流式态时通过 inline style 强制显示停止按钮
    // 兜底机制——即使 updateSendButton 因状态机异常未被调用，
    // setStreaming(true) 也会覆盖 CSS 的 display:none，确保用户始终能中断流式输出
    this.btnStop.style.display = streaming ? 'flex' : '';
  }

  /**
   * 设置 Agent 就绪状态
   *
   * 由 renderer.ts 在 onAgentReady 回调中调用，
   * 设置为 true 后用户才能发送消息。同时联动聊天面板状态指示器。
   */
  setAgentReady(ready: boolean): void {
    this.state.isAgentReady = ready;
    this.updateChatAgentStatus();
  }

  /**
   * 设置是否已配置 Provider
   *
   * 由 renderer.ts 在 listLlmProviders 返回后调用，
   * 用于区分"未配置"与"初始化中"两种未就绪场景。同时联动聊天面板状态指示器。
   */
  setHasProviders(has: boolean): void {
    this.state.hasProviders = has;
    this.updateChatAgentStatus();
  }

  /**
   * 更新聊天面板 Agent 状态指示器
   *
   * 根据 isAgentReady + hasProviders 组合显示三种状态：
   * - 就绪（ready）：Agent 已就绪——**隐藏**（稳态噪音，"精灵已就绪"零信息量）
   * - 初始化中（unknown）：已配置 Provider 但未就绪——**显示**"正在初始化..."（过渡态反馈，秒级）
   * - 未配置（error）：未配置任何 Provider——**隐藏**（由 onboarding 流程接管，项目硬约束：
   *   "Onboarding must appear whenever no LLM API configuration exists"）
   *
   * 设计：仅 unknown 态显示。ready 是稳态（99% 时间），error 由 onboarding 接管，
   * 两者隐藏可消除视觉噪音且避免首屏闪烁（HTML 初始即 hidden，UIManager 构造时
   * 同步 initial state 后仍保持 hidden，直到 setHasProviders(true) 触发 unknown 显示）。
   */
  private updateChatAgentStatus(): void {
    const indicator = this.chatAgentStatusEl;
    if (!indicator) return;
    indicator.classList.remove('ready', 'error', 'unknown');
    const textEl = indicator.querySelector('.agent-status-text');
    if (!this.state.isAgentReady && this.state.hasProviders) {
      // 唯一显示场景：过渡态，已配 Provider 但 Agent 还在初始化
      indicator.classList.remove('hidden');
      indicator.classList.add('unknown');
      if (textEl) textEl.textContent = '正在初始化...';
    } else {
      // ready 稳态 / error 异常态：均隐藏（error 由 onboarding 接管）
      indicator.classList.add('hidden');
    }
  }

  /**
   * 查询 Agent 是否就绪
   *
   * 供外部回调（如 onSuggestionClick）做发送前守卫，
   * 与 isStreaming() 同模式，避免外部直接访问 state。
   */
  isAgentReady(): boolean {
    return this.state.isAgentReady;
  }

  /** 获取当前面板 */
  getCurrentPanel(): string {
    return this.state.currentPanel;
  }

  /** 设置当前面板（PanelRouterHost 接口） */
  setCurrentPanel(panel: string): void {
    this.state.currentPanel = panel;
  }

  /** 获取输入框元素（PanelRouterHost 接口） */
  getInputEl(): HTMLTextAreaElement {
    return this.inputEl;
  }

  /** 获取停止按钮元素（PanelRouterHost 接口） */
  getBtnStop(): HTMLButtonElement {
    return this.btnStop;
  }

  /** 获取最大化按钮元素（PanelRouterHost 接口） */
  getBtnMaximize(): HTMLButtonElement | null {
    return this.btnMaximize;
  }

  // ─── 记忆面板（含业务逻辑的方法，纯透传委托见 memoryDelegations） ──

  /**
   * 获取当前记忆搜索参数
   *
   * 通过 UIManager 门面读取，避免控制器直接访问 DOM（分层原则）。
   * DOM 元素缺失时返回默认值，兼容测试环境。
   */
  getMemorySearchParams(): { query: string; source: string; sort: string; timeRange: string } {
    const searchEl = document.getElementById('memory-search');
    const sourceEl = document.getElementById('memory-filter-source');
    const sortEl = document.getElementById('memory-sort-order');
    const timeEl = document.getElementById('memory-time-range');
    return {
      query: (searchEl instanceof HTMLInputElement ? searchEl.value : '').trim(),
      source: sourceEl instanceof HTMLSelectElement ? sourceEl.value : '',
      sort: sortEl instanceof HTMLSelectElement ? sortEl.value : 'relevance',
      timeRange: timeEl instanceof HTMLSelectElement ? timeEl.value : '',
    };
  }

  /**
   * 触发记忆搜索框 input 事件（排序/时间范围变更时重新搜索）
   *
   * 控制器不直接操作 DOM，通过此门面方法委托 UIManager 触发搜索框的 input 事件，
   * 让已注册的 onMemorySearch 回调重新执行搜索逻辑。
   */
  triggerMemorySearchInput(): void {
    const searchEl = document.getElementById('memory-search');
    if (searchEl instanceof HTMLInputElement && searchEl.value.trim()) {
      searchEl.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  /**
   * 读取记忆详情弹窗的 dataset（source/name）
   *
   * 编辑记忆时需要从详情弹窗的 dataset 获取 source 和 name 字段。
   * 控制器不直接访问 DOM，通过此门面方法委托 UIManager 读取。
   *
   * @param key dataset 键名（memorySource / memoryName）
   * @returns dataset 值，不存在时返回空字符串
   */
  getMemoryDetailMeta(key: 'memorySource' | 'memoryName'): string {
    const detailModal = document.getElementById('memory-detail-modal');
    return detailModal?.dataset[key] ?? '';
  }

  /**
   * 显示记忆列表加载/错误状态
   *
   * 控制器不直接传递 DOM 元素给 UIManager，通过此门面方法委托 UIManager
   * 在内部查找 #memory-list 元素并显示对应状态。
   *
   * @param state 状态类型（loading / error）
   */
  setMemoryListState(state: 'loading' | 'error'): void {
    const listEl = document.getElementById('memory-list');
    if (!listEl) return;
    if (state === 'loading') {
      // 加载态：清空列表 + 显示加载提示
      listEl.replaceChildren();
      const loadingDiv = document.createElement('div');
      loadingDiv.className = 'loading-state';
      loadingDiv.textContent = '加载记忆列表…';
      listEl.appendChild(loadingDiv);
    } else {
      // 错误态：复用 DashboardPanelManager 的 showMemoryListError（含重试按钮）
      this.dashboardPanel.showMemoryListError(listEl);
    }
  }

  // ─── 仪表盘/感知面板（含业务逻辑的方法，纯透传委托见 dashboardDelegations） ──

  /**
   * 设置面板内 tab 切换回调（实现 SettingsPanelHost.onSettingsTabSwitch）
   *
   * 由 SettingsPanelManager 在 tab 切换时调用，
   * 根据目标 tab 刷新对应 PanelManager 的数据：
   * - profile → 刷新用户画像 + 作品投影（作品 tab 已合并）
   * - audit → 刷新审计日志
   * - skill → 刷新技能列表（通过 loadDashboard 间接刷新）
   */
  onSettingsTabSwitch(tab: string): void {
    switch (tab) {
      case 'profile':
        // 作品 tab 已合并到画像与作品 tab，切换时同时刷新画像和作品数据
        void this.profilePanel.load();
        void this.workProjectionPanel.load();
        break;
      case 'audit':
        void this.auditPanel.load();
        break;
      // skill tab 的数据由 loadDashboard → renderSkills 驱动（委托到 settingsPanel），无需单独加载
      default:
        break;
    }
  }

  /**
   * 从感知快照一次性渲染所有感知数据（委托到 PerceptionPanelManager）
   *
   * 首次加载时调用，确保感知面板显示真实数据而非占位值。
   */
  renderPerceptionSnapshot(snapshot: {
    affect?: { warmth: number; playfulness: number; directness: number; initiative: number };
    rapport?: { trust: number; familiarity: number; level: string; description: string };
    context?: { rhythm: string; coherence: string; depth: string; dominantSource: string | null; description: string };
    patterns?: Array<{ type: string; summary: string; confidence: number; suggestion?: string }>;
    proactiveStats?: ProactiveStats;
    presence?: { state: 'present' | 'away'; awayDurationMs?: number };
  }): void {
    this.perceptionPanel.renderPerceptionSnapshot(snapshot);
    // 同步更新精灵状态浮层：首次加载/切换面板时 popover 也需初始化数据，
    // 否则 hover 状态条时摘要为空（popover 仅缓存 affect/rapport/context 三类）
    if (snapshot.affect) this.spriteStatusPopover.updateAffect(snapshot.affect as AffectPayload);
    if (snapshot.rapport) this.spriteStatusPopover.updateRapport(snapshot.rapport as RapportPayload);
    if (snapshot.context) this.spriteStatusPopover.updateContext(snapshot.context as ContextPayload);
  }
  /** 更新主动提示统计展示（委托到 PerceptionPanelManager） */
  updateProactiveStatsDisplay(stats: unknown): void {
    const typedStats = stats as Parameters<typeof this.perceptionPanel.updateProactiveStatsDisplay>[0];
    this.perceptionPanel.updateProactiveStatsDisplay(typedStats);
  }

  // ─── 设置面板（含业务逻辑的方法，纯透传委托见 settingsModalDelegations） ──

  /** 加载配置到表单（委托到 SettingsPanelManager） */
  loadConfigToForm(config: SpriteConfigForm): void {
    // 缓存当前配置，供 getArchiveMode 同步查询
    this.currentConfig = config;
    this.settingsPanelManager.loadConfigToForm(config);
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
}

// ─── Mixin 类型合并 + 运行时注入 ─────────────────────────
// interface 声明合并：UIManager 获得 6 个委托群的方法签名类型
// applyMixins：将 6 个委托群的实现方法复制到 UIManager.prototype
// 注意：interface 必须与 class 同为 exported，否则触发 TS2395
export interface UIManager extends ChatDelegations, MemoryDelegations, DashboardDelegations, PersonaThemeDelegations, SettingsModalDelegations, MiscDelegations {}

applyMixins(UIManager, [
  chatDelegations,
  memoryDelegations,
  dashboardDelegations,
  personaThemeDelegations,
  settingsModalDelegations,
  miscDelegations,
]);
