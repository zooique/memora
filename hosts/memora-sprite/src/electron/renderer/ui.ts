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
  SourceHealth,
} from './panels/dashboardPanelManager.js';
// Payload 类型直接从 ipcListeners（IPC 契约真理源）导入
import type {
  AffectPayload,
  RapportPayload,
  ContextPayload,
  PatternsPayload,
  PresencePayload,
} from './ipcListeners.js';
import { PersonaPanelManager } from './panels/personaPanelManager.js';
// CommandPaletteManager 纳入 UIManager 组合体系，统一生命周期管理
import { CommandPaletteManager } from './panels/commandPaletteManager.js';
// 面板错误横幅拆分为独立 Manager
import { PanelErrorBannerManager } from './panels/panelErrorBannerManager.js';
// 剪贴板三重保护 UI 联动拆分为独立 Manager
import { ClipboardManager } from './panels/clipboardManager.js';
// 日期导航拆分为独立 Manager
import { DateNavManager } from './panels/dateNavManager.js';
// 技能拖入安装拆分为独立 Manager
import { SkillDropManager } from './panels/skillDropManager.js';
// 感知面板控制器拆分（展开/收起 + 快照拉取 + 三块折叠区 + 推荐记忆点击）
import { PerceptionPanelController } from './panels/perceptionPanelController.js';
import type { PerceptionPanelHost } from './panels/perceptionPanelController.js';
// 输入区域管理器拆分（输入框事件 + 发送按钮状态 + ResizeObserver）
import { InputAreaManager } from './panels/inputAreaManager.js';
import type { InputAreaHost } from './panels/inputAreaManager.js';
// 精灵公共常量（Toast 时长已迁移至各 Manager；UIManager 不再直接使用时长常量）
// TOAST_*_MS 已迁移到 ClipboardManager / SkillDropManager
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
// 配置建议 payload 类型（从 preload 导入，供 showSuggestion 代理方法使用）
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

/**
 * P0-UI-8.1：渲染 UIManager 初始化失败错误提示到 document.body
 *
 * 在 UIManager 构造函数预检核心元素失败时调用，独立于 UIManager 自身，
 * 避免半初始化状态下访问 null 引发的二次错误。
 *
 * 显示内容：醒目红色错误卡片 + 错误信息 + 排查建议（HTML 与 TS 不同步、构建未刷新等）。
 * 错误仍然会 rethrow，让上层（renderer.ts DOMContentLoaded）的 catch 也能感知。
 *
 * @param err 构造函数抛出的错误（通常是 MemoraError INITIALIZATION_FAILED）
 */
function renderInitFailureToBody(err: unknown): void {
  // 提取错误信息（MemoraError 有 message 字段，普通 Error 同样）
  const errorMessage = err instanceof Error ? err.message : String(err);
  // 构建错误提示卡片（inline style 避免依赖 CSS 文件加载状态）
  const errorCard = document.createElement('div');
  errorCard.style.cssText = [
    'position:fixed', 'top:50%', 'left:50%', 'transform:translate(-50%,-50%)',
    'max-width:560px', 'width:90%', 'padding:24px 28px',
    'background:#fef2f2', 'border:1px solid #dc2626', 'border-radius:8px',
    'color:#7f1d1d', 'font-family:system-ui,sans-serif', 'font-size:14px',
    'line-height:1.6', 'box-shadow:0 8px 32px rgba(220,38,38,0.2)',
    'z-index:9999',
  ].join(';');
  // 标题
  const title = document.createElement('h2');
  title.textContent = 'UI 初始化失败';
  title.style.cssText = 'margin:0 0 12px 0;font-size:18px;color:#991b1b;';
  errorCard.appendChild(title);
  // 错误信息
  const msg = document.createElement('p');
  msg.textContent = errorMessage;
  msg.style.cssText = 'margin:0 0 16px 0;font-family:ui-monospace,monospace;background:#fee2e2;padding:8px 12px;border-radius:4px;word-break:break-all;';
  errorCard.appendChild(msg);
  // 排查建议
  const hints = document.createElement('p');
  hints.innerHTML = '<strong>可能原因：</strong><br>• HTML 元素 ID 缺失或拼写错误（开发阶段引入）<br>• 构建产物未刷新（请尝试重启开发服务器或重新构建）<br>• index.html 与 ui.ts 不同步（最近修改未生效）';
  hints.style.cssText = 'margin:0;font-size:13px;color:#7f1d1d;';
  errorCard.appendChild(hints);
  // 挂载到 body（清空已有错误卡片，避免重复）
  document.querySelectorAll('#ui-init-failure-card').forEach((el) => el.remove());
  errorCard.id = 'ui-init-failure-card';
  document.body.appendChild(errorCard);
}

// ─── UI 管理器类 ─────────────────────────────────────────

export class UIManager implements ChatPanelHost, MemoryPanelHost, DashboardPanelHost, PerceptionPanelHost {
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
  /** 配置建议卡片管理器（独立管理卡片显示/接受/拒绝，与 ProactiveBanner 同模式） */
  private suggestionCard = new SuggestionCardManager();
  /** 用户画像面板管理器（独立管理画像 tab 的加载/确认/拒绝） */
  private profilePanel = new ProfilePanelManager();
  /** 作品投影面板管理器（独立管理作品 tab 的加载/渲染/展开） */
  private workProjectionPanel = new WorkProjectionPanelManager();
  /** M2 审计日志面板管理器（独立管理审计 tab 的加载/渲染/清空） */
  private auditPanel = new AuditPanelManager();
  /** 设置面板管理器（独立管理设置面板 DOM 和事件） */
  private settingsPanelManager: SettingsPanelManager;
  /** 缺口 J：缓存当前 SpriteConfig（供 getArchiveMode 查询，避免异步 IPC 调用） */
  private currentConfig: SpriteConfigForm | null = null;

  // ─── 面板管理器（聊天/记忆/角色/会话） ──
  /** 聊天面板管理器（消息渲染、流式输出、思考指示器、工具调用卡片） */
  private chatPanel: ChatPanelManager;
  /** 记忆面板管理器（列表渲染、搜索过滤、详情弹窗） */
  private memoryPanel: MemoryPanelManager;
  /** 仪表盘面板管理器（感知系统 + 仪表盘渲染） */
  private dashboardPanel: DashboardPanelManager;
  /** 角色选择器面板管理器（下拉菜单、角色切换） */
  private personaPanel: PersonaPanelManager;
  /**
   * 快捷命令面板管理器（Ctrl+K）
   *
   * 纳入 UIManager 组合体系，与其他子管理器同模式：
   * 构造函数创建、cleanup() 统一清理全局 keydown 监听器（避免页面重载后累积）。
   */
  private commandPaletteManager: CommandPaletteManager;
  /**
   * 面板错误横幅管理器
   *
   * 统一管理 settings / memory / chat 三个面板的错误横幅。
   * UIManager 仅保留薄委托。
   */
  private panelErrorBannerManager: PanelErrorBannerManager;
  /**
   * 剪贴板三重保护面板管理器
   *
   * 统一管理"剪贴板三重保护"的 UI 联动。UIManager 仅保留薄委托。
   * 依赖注入 ToastManager / ModalManager 实例，与 UIManager 共享同一引用。
   */
  private clipboardManager: ClipboardManager;
  /**
   * 日期导航面板管理器
   *
   * 统一管理"日期导航"功能的 UI 联动。UIManager 仅保留薄委托。
   * 自包含 EventTracker，init() 绑定事件，cleanup() 统一清理。
   */
  private dateNavManager: DateNavManager;
  /**
   * 技能拖入安装面板管理器
   *
   * 统一管理"技能文件拖入安装"功能的 UI 联动。UIManager 仅保留薄委托。
   * 依赖注入 ToastManager 实例，与 UIManager 共享同一引用。
   */
  private skillDropManager: SkillDropManager;
  /** 感知面板控制器（展开/收起 + 快照拉取 + 三块折叠区 + 推荐记忆点击） */
  private perceptionPanelController: PerceptionPanelController;

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
  /** 输入区域管理器（输入框事件 + 发送按钮状态 + ResizeObserver） */
  private inputAreaManager: InputAreaManager;

  private state: UIState = {
    currentPanel: 'chat',
    unreadCount: 0,
    isStreaming: false,
    // 初始为 false，onAgentReady 回调中置 true
    isAgentReady: false,
  };

  /** 活跃的流式消息映射（messageId → DOM 元素），ChatPanelManager 共享引用 */
  private streamingMessages = new Map<string, HTMLElement>();
  /** 事件监听器跟踪器（统一管理事件监听器的注册与清理，避免内存泄漏） */
  private events = new EventTracker();

  // ─── UI 状态字段 ────────────────────────────────────────
  // panelErrorRetryCallbacks 已移至 PanelErrorBannerManager
  /** 用户是否在底部附近（用于智能滚动：用户向上滚动时不强制滚到底部） */
  private isNearBottom = true;
  /** 非系统消息计数（显示在对话工具栏副标题） */
  private messageCount = 0;

  constructor() {
    // P0-UI-8.1：核心元素预检——缺失时先渲染错误提示到 document.body，再 rethrow。
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

    this.settingsPanelManager = new SettingsPanelManager(this as SettingsPanelHost);

    // 初始化配置建议卡片容器（动态创建 #suggestion-container 或复用 HTML 预定义元素）
  this.suggestionCard.init();
  // 初始化用户画像面板（绑定刷新按钮事件）
  this.profilePanel.init();
  // 初始化作品投影面板（绑定刷新按钮事件）
  this.workProjectionPanel.init();
    // M2 初始化审计日志面板（绑定刷新/清空按钮事件）
    this.auditPanel.init();

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

    // 角色选择器面板管理器
    this.personaPanel = new PersonaPanelManager(
      getOptionalElement('persona-selector', 'div'),
      getOptionalElement('persona-dropdown', 'div'),
      getOptionalElement('persona-name', 'span'),
      new EventTracker(),
    );

    // 快捷命令面板管理器（与其他面板管理器同模式：构造函数创建 + init 调用）
    this.commandPaletteManager = new CommandPaletteManager();
    // 面板错误横幅管理器（自包含，无依赖，直接创建）
    this.panelErrorBannerManager = new PanelErrorBannerManager();
    // 剪贴板保护管理器（依赖注入 toastManager + modalManager，与 UIManager 共享同一引用）
    this.clipboardManager = new ClipboardManager(this.toastManager, this.modalManager);
    // 日期导航管理器（自包含，无依赖，直接创建）
    this.dateNavManager = new DateNavManager();
    // 技能拖入安装管理器（依赖注入 toastManager，与 UIManager 共享同一引用）
    this.skillDropManager = new SkillDropManager(this.toastManager);
    // 感知面板控制器（依赖注入 Host 接口，init 在事件绑定后调用）
    this.perceptionPanelController = new PerceptionPanelController(this);
    // 输入区域管理器（依赖注入 inputEl/btnSend + 独立 EventTracker + host 接口）
    this.inputAreaManager = new InputAreaManager(
      this.inputEl,
      this.btnSend,
      new EventTracker(),
      this as InputAreaHost,
    );

    // 初始化 UI
    this.initEventListeners();
    this.memoryPanel.initMemoryPanelListeners();
    this.personaPanel.initPersonaSelectorListeners();
    this.settingsPanelManager.initListeners();
    // init 需在 initEventListeners 之后（cmdk 按钮监听在 initEventListeners 中注册）
    this.commandPaletteManager.init();
    // 面板错误横幅重试按钮初始化（委托到 PanelErrorBannerManager）
    this.panelErrorBannerManager.init();
    // 日期导航事件初始化（委托到 DateNavManager）
    this.dateNavManager.init();
    // 感知面板事件初始化（委托到 PerceptionPanelController）
    this.perceptionPanelController.init();
    // 模态框监听器委托给 ModalManager（独立管理事件清理）
    this.modalManager.initModalListeners();
    this.chatPanel.initEmptyStateListeners();
    this.chatPanel.initScrollToBottomButton();
    this.initScrollListener();
    // 输入区域事件 + ResizeObserver 初始化（委托到 InputAreaManager）
    this.inputAreaManager.init();
  }

  // ─── 事件监听器管理 ─────────────────────────────────────

  /** 初始化事件监听器 */
  private initEventListeners(): void {
    // 输入框 keydown/input + 发送按钮 click 事件已委托到 InputAreaManager.init()
    // B2：停止生成按钮（流式态时可见，触发 emitStopMessage）
    this.events.addEventListener(this.btnStop, 'click', this.emitStopMessage.bind(this));

    // 感知面板相关事件（推荐记忆点击 + 状态条 + 关闭按钮 + 三块折叠区）
    // 已委托到 PerceptionPanelController.init()

    // 导航事件（侧边栏 .nav-btn 按钮，复用 switchPanel 逻辑）
    document.querySelectorAll<HTMLElement>('.nav-btn').forEach((btn) => {
      this.events.addEventListener(btn, 'click', this.handleNavClick.bind(this));
    });

    // 记忆面板已改为标准 .panel 显示在核心区（与设置面板对齐），不再需要遮罩层和关闭按钮

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

    // 会话分叉按钮（输入工具栏）：触发 forkSessionCallback（由 renderer.ts 注册调用 sessionController.forkSession）
    const btnForkSession = getOptionalElement('btn-fork-session', 'button');
    if (btnForkSession) {
      this.events.addEventListener(btnForkSession, 'click', () => {
        this.forkSessionCallback?.();
      });
    }

    // 标题栏命令面板入口按钮（Ctrl+K 的鼠标入口，与键盘快捷键等效）
    const btnCmdk = getOptionalElement('titlebar-cmdk', 'button');
    if (btnCmdk) {
      this.events.addEventListener(btnCmdk, 'click', () => {
        this.commandPaletteManager.open();
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

    // Esc：关闭感知面板/下拉菜单；设置或记忆面板激活时切回对话（弹窗由 ModalManager 统一处理）
    if (e.key === 'Escape') {
      // 优先关闭感知面板（感知面板打开时 Escape 关闭面板）
      const panel = document.getElementById('perception-panel');
      if (panel?.classList.contains('visible')) {
        this.perceptionPanelController.close();
        e.preventDefault();
        return;
      }
      // 设置或记忆面板激活时，Escape 切回对话面板
      if (this.state.currentPanel === 'settings' || this.state.currentPanel === 'memories') {
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

    // Ctrl/Cmd + 数字：切换面板（chat/memories/settings 均走 switchPanel 统一切换）
    if (isMod && ['1', '2', '3'].includes(e.key)) {
      const panelMap: Record<string, string> = {
        '1': 'chat',
        '2': 'memories',
        '3': 'settings',
      };
      const panel = panelMap[e.key];
      if (panel) {
        void this.switchPanel(panel);
        e.preventDefault();
      }
      return;
    }

    // Ctrl/Cmd + .：停止生成（流式输出期间可用键盘快速中断）
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
    this.personaPanel.cleanup();
    // 清理命令面板的全局 keydown 监听器，避免页面重载后累积
    this.commandPaletteManager.cleanup();
    // 清理面板错误横幅的重试按钮监听器和回调映射
    this.panelErrorBannerManager.cleanup();
    // 清理剪贴板保护管理器（空实现，保持统一生命周期接口）
    this.clipboardManager.cleanup();
    // 清理日期导航管理器的事件监听器和回调
    this.dateNavManager.cleanup();
    // 清理技能拖入安装管理器的回调引用
    this.skillDropManager.cleanup();
    // 清理感知面板控制器的事件监听器
    this.perceptionPanelController.cleanup();
    // 清理 ThemeManager 的系统主题变化监听器
    this.themeManager.cleanup();
  }

  /**
   * 打开命令面板（Ctrl+K 的程序化入口）
   *
   * 供 renderer.ts 在需要时调用（如未来扩展的其他入口按钮），
   * 当前 cmdk 按钮已内置在 initEventListeners 中。
   */
  openCommandPalette(): void {
    this.commandPaletteManager.open();
  }

  // ─── 聊天面板 ─ 委托到 ChatPanelManager ─────────────────

  /** 添加消息到界面（委托到 ChatPanelManager） */
  appendMessage(message: Message): HTMLElement { return this.chatPanel.appendMessage(message); }

  /**
   * B1：对话区内联里程碑 banner
   *
   * 委托到 ChatPanelManager.appendMilestoneBanner。
   * 里程碑事件不再走顶部 #proactive-banner，而是作为对话流中的独立元素内联渲染。
   *
   * @param text 里程碑文本（如"达成里程碑：首次完成 UI 布局重构方案"）
   */
  appendMilestoneBanner(text: string): void { this.chatPanel.appendMilestoneBanner(text); }
  /** 更新流式消息内容（委托到 ChatPanelManager） */
  updateStreamingMessage(messageId: string, text: string): void { this.chatPanel.updateStreamingMessage(messageId, text); }
  /** 完成流式消息（委托到 ChatPanelManager） */
  finishStreamingMessage(messageId: string): void { this.chatPanel.finishStreamingMessage(messageId); }
  /** 设置流式消息的召回记忆摘要（委托到 ChatPanelManager） */
  setMemoryRecall(messageId: string, memories: Array<{ id: string; name: string; score: number; source: string }>): void { this.chatPanel.setMemoryRecall(messageId, memories); }
  /** 显示思考阶段指示器（委托到 ChatPanelManager） */
  showThinkingPhase(messageId: string, phase: string): void { this.chatPanel.showThinkingPhase(messageId, phase); }
  /** 显示上下文截断提示条 */
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
  /** 显示"加载更早的对话"按钮（委托到 ChatPanelManager） */
  showLoadEarlierDay(onClick: () => void): void { this.chatPanel.showLoadEarlierDay(onClick); }
  /** 向流式消息气泡注入错误提示（委托到 ChatPanelManager） */
  injectErrorToStreamingMessages(errorText: string): void { this.chatPanel.injectErrorToStreamingMessages(errorText); }
  /** 在流式消息气泡内嵌入中断标记（委托到 ChatPanelManager） */
  markStreamingAborted(messageId: string, reason: string): void { this.chatPanel.markStreamingAborted(messageId, reason); }
  /** 显示空状态引导（委托到 ChatPanelManager） */
  showEmptyState(): void { this.chatPanel.showEmptyState(); }
  /** 隐藏空状态引导（委托到 ChatPanelManager） */
  hideEmptyState(): void { this.chatPanel.hideEmptyState(); }
  /** 缺口 J：查询当前归档模式（从缓存的 SpriteConfig 读取） */
  getArchiveMode(): 'full' | 'insights-only' | 'manual' {
    return this.currentConfig?.archiveMode ?? 'full';
  }
  /** 缺口 J：手动归档对话（调用 preload 暴露的 archiveProfileFacts + archiveInsight IPC） */
  async archiveConversation(input: string, assistantContent: string): Promise<number> {
    // 同时触发 profile facts + insight 归档，返回总条目数
    const [profileResult, insightResult] = await Promise.all([
      window.electronAPI.archiveProfileFacts(input),
      window.electronAPI.archiveInsight(input, assistantContent),
    ]);
    return profileResult.count + insightResult.count;
  }
  /** 注册示例问题点击回调（委托到 ChatPanelManager） */
  onSuggestionClick(cb: (text: string) => void): void { this.chatPanel.onSuggestionClick(cb); }
  /** 注册错误重试回调（委托到 ChatPanelManager） */
  onErrorRetry(cb: () => void): void { this.chatPanel.onErrorRetry(cb); }

  // ─── 消息计数（ChatPanelHost 回调：供 ChatPanelManager 调用） ──

  /** 更新消息计数（ChatPanelHost 回调：供 ChatPanelManager.appendMessage 调用） */
  updateMessageCount(): void {
    this.messageCount++;
    this.refreshMessageCountDisplay();
  }

  /**
   * 直接设置消息计数（不累加）
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
   * 切换前检查当前面板是否有未保存修改，
   * 有则弹出确认对话框，用户取消则中止切换。
   *
   * chat/memories/settings 三个面板均通过 .panel.active 控制显隐，
   * 替换核心区域内容。切换到 chat 自动聚焦输入框，切换到 memories 聚焦搜索框。
   */
  async switchPanel(panel: string): Promise<void> {
    // 当前在设置面板且有未保存修改时，确认后再切换
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

    // 记忆面板已改为标准 .panel，与 chat/settings 走统一的面板切换逻辑

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
      prevPanel?.setAttribute('aria-hidden', 'true');
      // 离开记忆面板时，关闭所有分析面板（统计洞察/健康度诊断），
      // 避免切回记忆时分析面板仍遮挡视图
      if (this.state.currentPanel === 'memories') {
        this.memoryPanel.dismissAnalysisPanels();
      }
    }

    this.state.currentPanel = panel;

    // 切换面板后重置滚动位置到顶部，避免新面板显示在中间位置
    // web模式下滚动容器是 documentElement/body，Electron模式下是 main-content
    requestAnimationFrame(() => {
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
      const mainContent = document.getElementById('main-content');
      if (mainContent) mainContent.scrollTop = 0;
      // 各面板自身也滚动到顶部
      panelEl?.scrollTo?.(0, 0);
    });

    // 切换到对话面板时自动聚焦输入框，减少多余点击步骤
    if (panel === 'chat') {
      this.inputEl.focus();
    }
    // 切换到记忆面板时聚焦搜索框
    if (panel === 'memories') {
      const searchInput = document.getElementById('memory-search') as HTMLInputElement | null;
      searchInput?.focus();
    }

    // 面板切换回调：通知外部控制器刷新数据
    this.panelSwitchCallback?.(panel);
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

  /** 强制滚动到底部（用户主动操作时调用，如点击发送按钮、切换会话后） */
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

  // ─── 事件处理器 ─

  /**
   * 侧边栏导航按钮点击处理器
   *
   * 点击侧边栏图标切换到对应面板（chat / memory / settings）。
   * 设计原则（对齐 user_rules "主动可见"）：
   * - 导航按钮始终可见，不依赖 hover
   * - 触发回调由 renderer.ts 注册，切换面板状态
   */

  private handleNavClick(e: Event): void {
    const target = e.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    const panel = target.dataset.panel;
    if (panel) {
      // 记忆面板已改为标准 .panel，与 chat/settings 统一走 switchPanel
      // switchPanel 为 async，void 显式忽略 Promise
      void this.switchPanel(panel);
    }
  }

  // togglePerceptionPanel / closePerceptionPanel 已迁移至 PerceptionPanelController

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

  // ─── 配置建议卡片（代理到 SuggestionCardManager） ────

  /**
   * 显示配置建议卡片（代理到 SuggestionCardManager）
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

  // ─── 用户画像面板（代理到 ProfilePanelManager） ──────

  /**
   * 加载用户画像数据（代理到 ProfilePanelManager）
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
   * 加载作品投影数据（代理到 WorkProjectionPanelManager）
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
   * 更新学习进度卡片
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
  /** 会话分叉回调（用户点击分叉按钮时触发，由 renderer.ts 注册调用 sessionController.forkSession） */
  private forkSessionCallback: (() => void) | null = null;

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

  /** 设置会话分叉回调（用户点击输入工具栏分叉按钮时触发） */
  onForkSession(callback: () => void): void {
    this.forkSessionCallback = callback;
  }

  // InputAreaHost 接口要求 public（inputAreaManager 通过 host.emitSendMessage() 调用）
  emitSendMessage(): void {
    // Agent 未就绪时禁止发送（LLM 未配置会导致 IPC 失败）
    if (!this.state.isAgentReady) {
      this.showToast('Agent 未就绪，请先在设置面板配置 LLM', 'warning');
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
   * B2：统一更新发送/停止按钮可见性
   *
   * 设计变更（对齐 demo v3 .btn-stop-float）：
   * - 流式态：显示 #btn-stop 浮动按钮，#btn-send 隐藏（避免误触发送）
   * - 空闲态：隐藏 #btn-stop，#btn-send 恢复发送姿态（空内容时弱化禁用）
   *
   * 取代旧版的"合并按钮"模式（流式态时改变 #btn-send 图标为停止方块），
   * 拆分语义更清晰，且与 demo v3 视觉设计一致。
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
      this.btnSend.innerHTML = '<svg class="icon"><use href="#icon-send"/></svg>';
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
      while (listEl.firstChild) {
        listEl.removeChild(listEl.firstChild);
      }
      const loadingDiv = document.createElement('div');
      loadingDiv.className = 'loading-state';
      loadingDiv.textContent = '加载记忆列表...';
      listEl.appendChild(loadingDiv);
    } else {
      // 错误态：复用 DashboardPanelManager 的 showMemoryListError（含重试按钮）
      this.dashboardPanel.showMemoryListError(listEl);
    }
  }
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
  /** 注册记忆编辑回调（委托到 MemoryPanelManager） */
  onMemoryEdit(cb: (id: string, content: string) => void): void { this.memoryPanel.onMemoryEdit(cb); }
  /** 注册记忆讨论回调（委托到 MemoryPanelManager） */
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
  /** 注册回收站操作回调（恢复/彻底删除，委托到 MemoryPanelManager） */
  onRecycleBinAction(cb: (action: 'restore' | 'purge', id: string) => void): void { this.memoryPanel.onRecycleBinAction(cb); }
  /** 渲染回收站列表（委托到 MemoryPanelManager） */
  renderRecycleBinList(memories: Array<{ id: string; name: string; source: string; contentPreview: string; deletedAt: string }>): void { this.memoryPanel.renderRecycleBinList(memories); }
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
  /** 注册图谱右键菜单操作回调（委托到 MemoryPanelManager） */
  onGraphContextMenuAction(cb: (action: string, nodeId: string) => void): void { this.memoryPanel.onGraphContextMenuAction(cb); }
  /** 注册关系编辑回调（委托到 MemoryPanelManager） */
  onRelationEdit(cb: (sourceId: string, targetId: string, type: string, weight: number) => void): void { this.memoryPanel.onRelationEdit(cb); }
  /** 注册关系删除回调（委托到 MemoryPanelManager） */
  onRelationDelete(cb: (sourceId: string, targetId: string, type: string) => void): void { this.memoryPanel.onRelationDelete(cb); }
  /** 注册关系创建回调（委托到 MemoryPanelManager） */
  onRelationCreate(cb: (sourceId: string, targetId: string, type: string, weight: number) => void): void { this.memoryPanel.onRelationCreate(cb); }
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
  /** 渲染记忆源健康诊断（委托到 DashboardPanelManager，消费内核 sourceHealth()） */
  renderSourceHealth(sourceHealth: SourceHealth | null): void {
    this.dashboardPanel.renderSourceHealth(sourceHealth);
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
  /** 渲染伙伴洞察面板（委托到 DashboardPanelManager） */
  renderPartnerInsights(memories: Array<{
    id: string; name: string; source: string; contentPreview: string; createdAt?: string;
  }>): void { this.dashboardPanel.renderPartnerInsights(memories); }
  /** 注册伙伴洞察面板记忆点击回调（委托到 DashboardPanelManager） */
  onPartnerMemoryClick(cb: (memoryId: string) => void): void { this.dashboardPanel.onMemoryClick(cb); }
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
  /** 更新主动提示统计展示（委托到 DashboardPanelManager，PerceptionPanelHost 接口要求） */
  updateProactiveStatsDisplay(stats: unknown): void {
    this.dashboardPanel.updateProactiveStatsDisplay(stats as Parameters<typeof this.dashboardPanel.updateProactiveStatsDisplay>[0]);
  }
  /** 更新在场状态展示（委托到 DashboardPanelManager） */
  updatePresenceDisplay(payload: PresencePayload): void {
    this.dashboardPanel.updatePresenceDisplay(payload);
  }
  /** 更新叙事摘要 DOM（委托到 DashboardPanelManager） */
  updateNarrative(): void { this.dashboardPanel.updateNarrative(); }
  /** 注册重试加载洞察数据回调（委托到 DashboardPanelManager） */
  onReloadInsights(cb: () => void): void { this.dashboardPanel.onReloadInsights(cb); }
  /** 注册重试加载健康度数据回调（委托到 DashboardPanelManager） */
  onReloadHealth(cb: () => void): void { this.dashboardPanel.onReloadHealth(cb); }
  /** 注册重试加载记忆列表回调（委托到 DashboardPanelManager） */
  onReloadMemoryList(cb: () => void): void { this.dashboardPanel.onReloadMemoryList(cb); }

  /**
   * 主题切换时重绘 Canvas 图表（委托到 DashboardPanelManager）
   *
   * Canvas 2D 不会自动响应 CSS 变量变化，主题切换后需主动重绘。
   * RelationGraph 有持续动画循环，主题切换会自动生效，无需处理。
   */
  repaintCanvasOnThemeChange(): void { this.dashboardPanel.repaintOnThemeChange(); }

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
  /** 触发召回记忆点击（委托到 PersonaPanelManager，供仪表盘推荐记忆点击复用） */
  triggerMemoryRecall(memoryId: string): void { this.personaPanel.triggerMemoryRecallClick(memoryId); }

  /** 注册角色匹配模式变更回调（委托到 SettingsPanelManager） */
  onPersonaModeChange(cb: (mode: string) => void): void {
    this.settingsPanelManager.onPersonaModeChange(cb);
  }
  /**
   * ADR-015 注册归档模式变更回调（委托到 SettingsPanelManager）
   *
   * radio change 时即时触发，由 settingsController 调用 updateConfig 持久化 + 应用到 Agent。
   * 与主题一样即时生效，不走保存按钮。
   *
   * @param cb 归档模式变更回调函数
   */
  onArchiveModeChange(cb: (mode: 'full' | 'insights-only' | 'manual') => void): void {
    this.settingsPanelManager.onArchiveModeChange(cb);
  }

  /**
   * ADR-SP-008 注册主题变更回调（代理到 ThemeManager）
   *
   * 当用户在设置面板切换主题时触发，renderer.ts 可借此执行额外同步逻辑。
   * 主题本身的持久化（localStorage）已在 setTheme 内完成，回调仅用于通知。
   *
   * source 参数区分"用户主动切换"与"系统主题变化"，
   * renderer.ts 据此决定是否持久化到 sprite.json。
   *
   * @param cb 主题变更回调函数
   */
  onThemeChange(cb: (theme: 'light' | 'dark', source: 'user' | 'system') => void): void {
    this.themeManager.onThemeChange(cb);
  }

  /**
   * 获取当前主题模式（代理到 ThemeManager）
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
   * 支持三态主题模式：light / dark / auto
   *
   * @param theme 当前主题模式
   */
  syncThemeRadios(theme: 'light' | 'dark' | 'auto'): void {
    this.themeManager.syncThemeRadios(theme);
  }

  // ─── 设置面板（委托到 SettingsPanelManager） ──

  // ─── 统一面板错误横幅（委托到 PanelErrorBannerManager） ───

  /** 显示面板错误横幅（委托到 PanelErrorBannerManager） */
  showPanelError(panelId: string, message: string, retryCallback?: () => void): void {
    this.panelErrorBannerManager.showPanelError(panelId, message, retryCallback);
  }

  /** 隐藏面板错误横幅（委托到 PanelErrorBannerManager） */
  hidePanelError(panelId: string): void {
    this.panelErrorBannerManager.hidePanelError(panelId);
  }

  /** 显示设置面板加载失败错误横幅（委托到 PanelErrorBannerManager） */
  showSettingsError(message: string, retryCallback?: () => void): void {
    this.panelErrorBannerManager.showPanelError('settings', message, retryCallback);
  }

  /** 隐藏设置面板加载失败错误横幅（委托到 PanelErrorBannerManager） */
  hideSettingsError(): void {
    this.panelErrorBannerManager.hidePanelError('settings');
  }

  // ─── 日期导航（委托到 DateNavManager） ───

  /** 注册日期导航跳转回调（委托到 DateNavManager） */
  onDateNavJump(cb: (date: string) => void): void {
    this.dateNavManager.onDateNavJump(cb);
  }

  /** 注册日期导航删除回调（委托到 DateNavManager） */
  onDateNavDelete(cb: (date: string) => void): void {
    this.dateNavManager.onDateNavDelete(cb);
  }

  /** 注册日期导航列表加载回调（委托到 DateNavManager） */
  onDateNavOpen(cb: () => void): void {
    this.dateNavManager.onDateNavOpen(cb);
  }

  /** 切换日期导航下拉的显示/隐藏（委托到 DateNavManager） */
  toggleDateNavDropdown(): void {
    this.dateNavManager.toggleDateNavDropdown();
  }

  /** 关闭日期导航下拉（委托到 DateNavManager） */
  closeDateNavDropdown(): void {
    this.dateNavManager.closeDateNavDropdown();
  }

  /**
   * 渲染日期列表到日期导航下拉（委托到 DateNavManager）
   *
   * @param dates 日期列表（每项包含日期、消息数、是否今天）
   * @param currentDate 当前查看的日期（用于高亮 active 项）
   */
  renderDateNavList(dates: Array<{ date: string; messageCount: number; isToday: boolean }>, currentDate: string): void {
    this.dateNavManager.renderDateNavList(dates, currentDate);
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
    // 缺口 J：缓存当前配置，供 getArchiveMode 同步查询
    this.currentConfig = config;
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

  /** 检查设置面板是否有未保存修改（供 beforeunload 保护使用） */
  isSettingsDirty(): boolean {
    return this.settingsPanelManager.isDirty();
  }

  /**
   * 更新 Agent 连接状态指示器（委托到 SettingsPanelManager）
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

  // ─── 剪贴板三重保护 UI 联动（委托到 ClipboardManager） ───

  /** 显示剪贴板变化 Toast（委托到 ClipboardManager） */
  showClipboardChangedToast(): void {
    this.clipboardManager.showClipboardChangedToast();
  }

  /** 显示剪贴板内容确认对话框（委托到 ClipboardManager） */
  async showClipboardConfirmDialog(content: string): Promise<void> {
    await this.clipboardManager.showClipboardConfirmDialog(content);
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
   * 切换到记忆面板（标准 .panel 切换）并聚焦搜索框，让用户立即开始搜索记忆。
   * 主进程已确保完整窗口可见，此处只需切换面板并聚焦搜索框。
   */
  async handleRecallMemoryTrigger(): Promise<void> {
    // 通过 switchPanel 走设置面板未保存修改检查，再切换到记忆面板
    await this.switchPanel('memories');
    // 选中已有文本，方便用户直接输入新搜索词替换
    const searchInput = document.getElementById('memory-search') as HTMLInputElement | null;
    if (searchInput) {
      // 选中已有文本，方便用户直接输入新搜索词替换
      // 不选中时用户需要手动删除或覆盖，降低操作效率
      searchInput.select();
    }
  }

  /**
   * 预填对话输入框
   *
   * 供记忆详情弹窗的「在对话中讨论」功能使用：
   * 将指定文本预填到对话输入框，用户可直接编辑或按 Enter 发送。
   * 仅在切换到对话面板后调用，输入框已由 switchPanel('chat') 自动聚焦。
   *
   * @param text 预填的文本内容
   */
  prefillChatInput(text: string): void {
    // 委托到 InputAreaManager（设置值 + 触发 input 事件调整高度）
    this.inputAreaManager.setValue(text);
  }

  // ─── 技能文件拖入安装（委托到 SkillDropManager） ───

  /** 注册技能安装成功回调（委托到 SkillDropManager） */
  onSkillInstalled(callback: () => void): void {
    this.skillDropManager.onSkillInstalled(callback);
  }

  /** 处理拖入的技能文件（委托到 SkillDropManager） */
  async handleSkillDrop(files: File[]): Promise<void> {
    await this.skillDropManager.handleSkillDrop(files);
  }

  /** 触发文件选择对话框（委托到 SkillDropManager） */
  handleSkillFileSelect(): void {
    this.skillDropManager.handleSkillFileSelect();
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

  // ─── Toast 通知（代理到 ToastManager） ──────────

  /**
   * 显示 Toast 通知（代理到 ToastManager）
   *
   * 设计原则：
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