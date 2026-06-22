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
 */

import { renderMarkdown } from './markdown.js';
// 子模块导入（组合模式：UIManager 持有独立子模块实例）
import { getRequiredElement, getOptionalElement, clearElement } from './domHelpers.js';
import { EventTracker } from './eventTracker.js';
import { ToastManager } from './toast.js';
import type { ToastOptions } from './toast.js';
import { ModalManager } from './modal.js';
import { OnboardingManager } from './onboarding.js';
import { ThemeManager } from './themeManager.js';
import { ProactiveBanner } from './proactiveBanner.js';
import { SuggestionCardManager } from './suggestionCard.js';
import { ProfilePanelManager } from './profilePanelManager.js';
import { SettingsPanelManager } from './settingsPanelManager.js';
import type { SettingsPanelHost } from './settingsPanelManager.js';
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
} from './types.js';
// H1：配置建议 payload 类型（从 preload 导入，供 showSuggestion 代理方法使用）
import type { ConfigSuggestionPayload } from '../preload.js';

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

// ─── 工具函数 ───────────────────────────────────────────

/**
 * UX-PP-05 相对时间格式化
 *
 * 将日期字符串 YYYY-MM-DD 转换为人类可读的相对时间：
 * - 今天 → "今天"
 * - 昨天 → "昨天"
 * - 7 天内 → "3天前"
 * - 更早 → "06-15"（MM-DD 格式）
 */
function formatRelativeTime(dateStr: string): string {
  const today = new Date();
  // noUncheckedIndexedAccess: split+map 解构后元素为 number | undefined，提供默认值确保数值有效
  const parts = dateStr.split('-').map(Number);
  const y = parts[0] ?? 0;
  const m = parts[1] ?? 1;
  const d = parts[2] ?? 1;
  // 重置时间部分为 0:00:00 以正确计算天数差
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const targetStart = new Date(y, m - 1, d);
  const diffDays = Math.round((todayStart.getTime() - targetStart.getTime()) / 86400000);

  if (diffDays === 0) return '今天';
  if (diffDays === 1) return '昨天';
  if (diffDays < 7) return `${diffDays}天前`;
  // 超过 7 天显示 MM-DD
  return `${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * P3-FLOW-14 格式化记忆创建时间为相对时间
 *
 * 将 ISO 8601 时间字符串转换为人类可读的相对时间：
 * - 1 小时内 → "X 分钟前"
 * - 24 小时内 → "X 小时前"
 * - 7 天内 → "X 天前"
 * - 更早 → "MM-DD"（MM-DD 格式）
 *
 * @param isoTime ISO 8601 时间字符串
 * @returns 格式化后的相对时间文本
 */
function formatMemoryTime(isoTime: string): string {
  const date = new Date(isoTime);
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHour = Math.floor(diffMs / 3_600_000);
  const diffDay = Math.floor(diffMs / 86_400_000);

  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin} 分钟前`;
  if (diffHour < 24) return `${diffHour} 小时前`;
  if (diffDay < 7) return `${diffDay} 天前`;
  // 更早：返回 MM-DD 格式
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${m}-${d}`;
}

// ─── UI 管理器类 ─────────────────────────────────────────

export class UIManager {
  // ─── 静态常量 ───────────────────────────────────────────
  /** 判断"底部附近"的阈值（像素） */
  private static readonly SCROLL_BOTTOM_THRESHOLD = 100;

  /**
   * P3-FLOW-13 记忆列表分页每页大小
   * 50 条平衡了首屏渲染性能和用户浏览体验，超过时显示"加载更多"按钮
   */
  private static readonly MEMORY_PAGE_SIZE = 50;

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
  /** P2-008 设置面板管理器（独立管理设置面板 DOM 和事件，约 450 行提取） */
  private settingsPanelManager: SettingsPanelManager;

  // ─── 核心交互元素（必需，缺失时抛出） ──────────────────
  private messagesEl: HTMLElement;
  private inputEl: HTMLTextAreaElement;
  private btnSend: HTMLButtonElement;
  private btnStop: HTMLButtonElement;

  // ─── 可选元素（缺失时降级，不阻塞其他功能） ────────────
  /** 未读计数徽章（标题栏右上角，部分布局可能未提供该元素） */
  private badge: HTMLElement | null;
  /** FD-05 新建会话按钮（对话工具栏内，主动可见低频操作） */
  private btnNewSession: HTMLButtonElement | null;
  /** 最大化按钮（标题栏右侧，用于图标切换 □ ↔ ❐） */
  private btnMaximize: HTMLButtonElement | null;

  // 记忆面板元素
  private memoryListEl: HTMLElement | null;

  /** P3-FLOW-13 完整记忆列表缓存（供分页使用） */
  private allMemories: MemoryListItem[] = [];

  /** P3-FLOW-13 当前记忆列表页码（从 1 开始） */
  private memoryPage = 1;
  private memorySearchEl: HTMLInputElement | null;
  private memoryFilterSourceEl: HTMLSelectElement | null;
  private memoryDetailModal: HTMLElement | null;

  // 角色选择器元素
  private personaSelectorEl: HTMLElement | null;
  private personaDropdownEl: HTMLElement | null;
  private personaNameEl: HTMLElement | null;

  // P2-008 设置面板 DOM 元素已提取至 SettingsPanelManager

  private state: UIState = {
    currentPanel: 'chat',
    unreadCount: 0,
    isStreaming: false,
    // UX-P2-03 初始为 false，onAgentReady 回调中置 true
    isAgentReady: false,
  };

  private streamingMessages = new Map<string, HTMLElement>();
  /** UX-PP-02 流式 Markdown 渲染 rAF 节流标志（防止同一帧重复渲染） */
  private _pendingRaF = false;
  /** UX-PP-02 当前流式渲染的最新文本（rAF 回调中读取） */
  private _latestStreamText = '';
  /** UX-PP-02 当前流式消息 ID（rAF 回调中定位气泡） */
  private _latestStreamMessageId = '';
  /** 事件监听器跟踪器（统一管理事件监听器的注册与清理，避免内存泄漏） */
  private events = new EventTracker();

  // P2-008 settingsFormDirty / llmPresets / currentPersonaMode 已提取至 SettingsPanelManager

  // ─── UI 状态字段 ────────────────────────────────────────
  /** FD-A2 面板错误横幅重试回调映射（key: panelId，如 'settings'/'memory'/'chat'） */
  private panelErrorRetryCallbacks = new Map<string, () => void>();
  /** P2-008 currentPersonaMode 已提取至 SettingsPanelManager */
  /** 用户是否在底部附近（用于智能滚动：用户向上滚动时不强制滚到底部） */
  private isNearBottom = true;
  /** 记忆搜索防抖定时器（cleanup 时需清理，避免回调在 DOM 销毁后触发） */
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  /** 非系统消息计数（显示在对话工具栏副标题，P2-009：移至 state 字段区） */
  private messageCount = 0;

  constructor() {
    // ─── 核心交互元素：必需，缺失时抛出（UI 无法工作） ────
    this.messagesEl = getRequiredElement('messages', 'div');
    this.inputEl = getRequiredElement('input', 'textarea');
    this.btnSend = getRequiredElement('btn-send', 'button');
    this.btnStop = getRequiredElement('btn-stop', 'button');

    // ─── 可选元素：缺失时 warn 并降级，不阻塞其他功能 ──────
    this.badge = document.getElementById('badge');
    this.btnNewSession = getOptionalElement('btn-new-session', 'button');
    this.btnMaximize = getOptionalElement('btn-maximize', 'button');

    // 记忆面板
    this.memoryListEl = getOptionalElement('memory-list', 'div');
    this.memorySearchEl = getOptionalElement('memory-search', 'input');
    this.memoryFilterSourceEl = getOptionalElement('memory-filter-source', 'select');
    this.memoryDetailModal = getOptionalElement('memory-detail-modal', 'div');

    // 角色选择器
    this.personaSelectorEl = getOptionalElement('persona-selector', 'div');
    this.personaDropdownEl = getOptionalElement('persona-dropdown', 'div');
    this.personaNameEl = getOptionalElement('persona-name', 'span');

    // P2-008 设置面板 DOM 元素初始化已提取至 SettingsPanelManager
    this.settingsPanelManager = new SettingsPanelManager(this as SettingsPanelHost);

    // H1 初始化配置建议卡片容器（动态创建 #suggestion-container 或复用 HTML 预定义元素）
    this.suggestionCard.init();
    // H2 初始化用户画像面板（绑定刷新按钮事件）
    this.profilePanel.init();

    // 初始化 UI
    this.initEventListeners();
    this.initMemoryPanelListeners();
    this.initPersonaSelectorListeners();
    this.settingsPanelManager.initListeners(); // P2-008 委托到 SettingsPanelManager
    this.initPanelErrorRetryButtons(); // FD-A2 统一面板错误横幅重试按钮
    // 模态框监听器委托给 ModalManager（独立管理事件清理）
    this.modalManager.initModalListeners();
    this.initEmptyStateListeners();
    this.initScrollListener();
  }

  // ─── 事件监听器管理 ─────────────────────────────────────

  /** 初始化事件监听器 */
  private initEventListeners(): void {
    // 输入框事件
    this.events.addEventListener(this.inputEl, 'keydown', this.handleInputKeydown.bind(this));
    this.events.addEventListener(this.inputEl, 'input', this.handleInputChange.bind(this));

    // 按钮事件
    this.events.addEventListener(this.btnSend, 'click', this.handleSendClick.bind(this));
    this.events.addEventListener(this.btnStop, 'click', this.handleStopClick.bind(this));
    // FD-05 新建会话按钮：触发回调（由 renderer.ts 注册，调用主进程创建新会话）
    if (this.btnNewSession) {
      this.events.addEventListener(this.btnNewSession, 'click', this.handleNewSessionClick.bind(this));
    }

    // FD-A1 会话选择器：点击切换下拉菜单
    const sessionCurrent = document.getElementById('session-current');
    if (sessionCurrent) {
      this.events.addEventListener(sessionCurrent, 'click', () => this.toggleSessionDropdown());
    }
    // 点击其他区域关闭下拉
    this.events.addEventListener(document, 'click', (e) => {
      const selector = document.getElementById('session-selector');
      if (selector && !selector.contains(e.target as Node)) {
        this.closeSessionDropdown();
      }
    });

    // 导航事件
    document.querySelectorAll<HTMLElement>('.nav-btn').forEach((btn) => {
      this.events.addEventListener(btn, 'click', this.handleNavClick.bind(this));
    });

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
   * - Esc：关闭所有打开的弹窗
   * - Ctrl/Cmd + 1/2/3：切换面板（对话/记忆/设置）
   * - Ctrl/Cmd + N：新建会话
   */
  private handleGlobalKeydown(e: Event): void {
    if (!(e instanceof KeyboardEvent)) return;
    const isMod = e.ctrlKey || e.metaKey;

    // Esc：关闭所有打开的弹窗 + 下拉菜单
    if (e.key === 'Escape') {
      const openModals = document.querySelectorAll('.modal:not(.hidden)');
      if (openModals.length > 0) {
        openModals.forEach((modal) => modal.classList.add('hidden'));
        e.preventDefault();
      }
      // P2 修复：Esc 同时关闭展开的下拉菜单（会话/角色），符合通用交互习惯
      const openDropdowns = document.querySelectorAll('.dropdown:not(.hidden)');
      if (openDropdowns.length > 0) {
        openDropdowns.forEach((dropdown) => dropdown.classList.add('hidden'));
        e.preventDefault();
      }
      return;
    }

    // Ctrl/Cmd + 数字：切换面板
    if (isMod && ['1', '2', '3'].includes(e.key)) {
      const panelMap: Record<string, string> = {
        '1': 'chat',
        '2': 'memories',
        '3': 'settings',
      };
      const panel = panelMap[e.key];
      if (panel) {
        this.switchPanel(panel);
        e.preventDefault();
      }
      return;
    }

    // Ctrl/Cmd + N：新建会话
    if (isMod && e.key === 'n') {
      this.newSessionCallback?.();
      e.preventDefault();
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
  }

  /** 清理所有事件监听器和子模块资源 */
  cleanup(): void {
    // 清理所有事件监听器（通过 EventTracker 统一管理）
    this.events.cleanup();
    // 清理搜索防抖定时器，避免回调在 DOM 销毁后触发
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    // 委托子模块清理各自的资源（Toast 定时器、Modal 监听器、ProactiveBanner 监听器、SettingsPanel 监听器）
    this.toastManager.cleanup();
    this.modalManager.cleanup();
    this.proactiveBanner.cleanup();
    this.suggestionCard.cleanup(); // H1 清理配置建议卡片事件监听器和 DOM
    this.profilePanel.cleanup(); // H2 清理用户画像面板事件监听器
    this.settingsPanelManager.cleanup(); // P2-008 清理设置面板事件监听器
  }

  // ─── 消息渲染 ─────────────────────────────────────────

  /**
   * 添加消息到界面
   *
   * 结构对齐 docs/memora-sprite-preview.html §6.2：
   *   <div class="message [user|assistant|system]">
   *     <div class="message-avatar">🧚</div>  <!-- 仅 user/assistant -->
   *     <div class="message-bubble">
   *       {文本内容}
   *       <div class="memory-recall">...</div>  <!-- 仅精灵消息且有召回时 -->
   *     </div>
   *   </div>
   *
   * 系统消息保持简单结构（无头像无气泡），居中显示。
   */
  appendMessage(message: Message): HTMLElement {
    // 有消息时隐藏空状态引导（首次添加消息触发）
    this.hideEmptyState();

    const el = this.buildMessageElement(message);
    this.messagesEl.appendChild(el);
    this.scrollToBottom();

    // 更新消息计数（非系统消息，显示在对话工具栏副标题）
    if (message.role !== 'system') {
      this.updateMessageCount();
    }

    // 更新未读计数（完整窗口隐藏时）
    if (message.role === 'assistant' && document.hidden) {
      this.state.unreadCount++;
      this.updateBadge();
    }

    return el;
  }

  /**
   * UX-FD-07 构建消息 DOM 元素（纯函数，无副作用）
   *
   * 从 appendMessage 中提取 DOM 构建逻辑，供 appendMessages 批量插入复用。
   * 不处理 DOM 挂载、滚动、计数等副作用，仅返回完整元素。
   *
   * @param message 消息对象
   * @returns 完整的消息 DOM 元素
   */
  private buildMessageElement(message: Message): HTMLElement {
    const el = document.createElement('div');
    el.className = `message ${message.role}${message.streaming ? ' streaming' : ''}`;

    if (message.role === 'system') {
      // 系统消息：简单文本，居中无头像
      el.textContent = message.content;
      return el;
    }

    // 用户/精灵消息：头像 + 气泡结构
    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.textContent = message.role === 'user' ? '🧑' : '🧚';
    el.appendChild(avatar);

    // 消息内容容器（气泡 + 时间戳 + 操作按钮）
    const contentWrapper = document.createElement('div');
    contentWrapper.className = 'message-content';

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';

    if (message.role === 'assistant') {
      // 精灵消息：渲染 Markdown
      bubble.appendChild(renderMarkdown(message.content));
    } else {
      // 用户消息：使用 textContent（防 XSS）
      bubble.textContent = message.content;
    }
    contentWrapper.appendChild(bubble);

    // P3-FLOW-07 用户/精灵消息均添加复制按钮（hover 时显示）
    // 原仅精灵消息有复制按钮，用户消息需手动选择文本，体验不一致
    if (!message.streaming) {
      const copyBtn = document.createElement('button');
      copyBtn.className = 'message-copy-btn';
      copyBtn.title = '复制';
      copyBtn.textContent = '📋';
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(message.content);
          this.showToast('已复制到剪贴板', 'success', 2000);
        } catch {
          this.showToast('复制失败，请手动选择文本复制', 'error');
        }
      });
      contentWrapper.appendChild(copyBtn);
    }

    // 时间戳
    const timestamp = message.timestamp ?? new Date().toISOString();
    const timeEl = document.createElement('div');
    timeEl.className = 'message-time';
    timeEl.textContent = this.formatTimestamp(timestamp);
    contentWrapper.appendChild(timeEl);

    el.appendChild(contentWrapper);

    // 召回记忆提示（仅精灵消息）
    const memoryRecall = message.memoryRecall;
    if (message.role === 'assistant' && memoryRecall && memoryRecall.length > 0) {
      const recallContainer = this.createRecallContainer(memoryRecall);
      bubble.appendChild(recallContainer);
    }

    // 流式消息光标
    if (message.streaming) {
      const cursor = document.createElement('span');
      cursor.className = 'cursor';
      bubble.appendChild(cursor);
    }

    return el;
  }

  /**
   * 格式化时间戳显示
   *
   * - 当天：HH:MM
   * - 非当天：MM-DD HH:MM
   * - 解析失败：返回原始字符串
   */
  private formatTimestamp(isoString: string): string {
    try {
      const date = new Date(isoString);
      const now = new Date();
      const isToday = date.toDateString() === now.toDateString();

      const hh = String(date.getHours()).padStart(2, '0');
      const mm = String(date.getMinutes()).padStart(2, '0');
      const time = `${hh}:${mm}`;

      if (isToday) {
        return time;
      }
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${month}-${day} ${time}`;
    } catch {
      return isoString;
    }
  }

  /**
   * 更新流式消息内容
   *
   * 流式过程中每次 chunk 都重新渲染 Markdown（text 是累积的完整文本）。
   * 保留 cursor 元素和 memory-recall 元素，仅替换 Markdown 内容区域。
   *
   * 性能考虑：
   * - LLM 输出通常在几百到几千字，同步 DOM 渲染性能可接受
   * - 若后续发现卡顿，可加 requestAnimationFrame 节流
   */
  updateStreamingMessage(messageId: string, text: string): void {
    const el = this.streamingMessages.get(messageId);
    if (!el) return;

    // 定位到气泡元素（assistant 消息结构：message > message-bubble）
    const bubble = el.querySelector('.message-bubble');
    if (!bubble) return;

    // UX-PP-02 保留元素在 rAF 回调中重新查询，此处不再维护同步变量
    // 保留 cursor、memory-recall-container 和 tool-call 元素，在 rAF 回调中重新查询

    // UX-P2-01 移除思考阶段指示器（text chunk 到达意味着思考阶段结束）
    const thinkingIndicator = bubble.querySelector('.thinking-phase');
    if (thinkingIndicator) {
      thinkingIndicator.remove();
    }

    // UX-PP-02 使用 rAF 节流 Markdown 渲染，避免高频 chunk 导致重复渲染
    // 存储最新文本，rAF 回调中统一执行 clear + render + 保留元素追加
    this._latestStreamText = text;
    this._latestStreamMessageId = messageId;
    if (!this._pendingRaF) {
      this._pendingRaF = true;
      requestAnimationFrame(() => {
        this._pendingRaF = false;
        // 重新定位气泡（可能已被 finishStreamingMessage 处理）
        const latestEl = this.streamingMessages.get(this._latestStreamMessageId);
        const latestBubble = latestEl?.querySelector('.message-bubble');
        if (!latestBubble) return;

        // 重新查询保留元素（rAF 回调中 DOM 可能已变化）
        const latestCursor = latestBubble.querySelector('.cursor');
        const latestRecall = latestBubble.querySelector('.memory-recall-container');
        const latestToolCalls = latestBubble.querySelectorAll('.tool-call');

        // 安全清空并重新渲染 Markdown
        clearElement(latestBubble);
        latestBubble.appendChild(renderMarkdown(this._latestStreamText));

        // 重新追加保留元素（recall 和 tool-call 在前，cursor 在最后）
        if (latestRecall) latestBubble.appendChild(latestRecall);
        for (const tc of Array.from(latestToolCalls)) {
          latestBubble.appendChild(tc);
        }
        if (latestCursor) latestBubble.appendChild(latestCursor);
      });
    }

    this.scrollToBottom();
  }

  /**
   * 完成流式消息
   *
   * 移除 streaming 类和光标元素，添加复制按钮。
   * 流式文本由主进程逐 chunk 拼接，渲染层不做尾部标记清理。
   */
  finishStreamingMessage(messageId: string): void {
    const el = this.streamingMessages.get(messageId);
    if (!el) return;

    el.classList.remove('streaming');
    // 移除光标元素
    const cursor = el.querySelector('.cursor');
    if (cursor) cursor.remove();

    // 流式完成后添加复制按钮（从 bubble 提取最终文本）
    const bubble = el.querySelector('.message-bubble');
    const contentWrapper = el.querySelector('.message-content');
    if (bubble && contentWrapper) {
      // 提取纯文本内容（排除 memory-recall 提示）
      const clone = bubble.cloneNode(true);
      if (!(clone instanceof HTMLElement)) {
        throw new Error('[finishStreamingMessage] 复制的消息气泡不是 HTMLElement');
      }
      const recallInClone = clone.querySelector('.memory-recall');
      if (recallInClone) recallInClone.remove();
      const finalText = clone.textContent ?? '';

      const copyBtn = document.createElement('button');
      copyBtn.className = 'message-copy-btn';
      copyBtn.title = '复制';
      copyBtn.textContent = '📋';
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(finalText);
          this.showToast('已复制到剪贴板', 'success', 2000);
        } catch {
          this.showToast('复制失败，请手动选择文本复制', 'error');
        }
      });
      // 插入到时间戳之前（复制按钮在气泡右上角）
      const timeEl = contentWrapper.querySelector('.message-time');
      if (timeEl) {
        contentWrapper.insertBefore(copyBtn, timeEl);
      } else {
        contentWrapper.appendChild(copyBtn);
      }
    }

    this.streamingMessages.delete(messageId);
  }

  /**
   * MS-12 设置流式消息的召回记忆摘要
   *
   * 在 startStreaming 之后、text chunk 之前调用，
   * 将召回记忆摘要注入到消息气泡底部，用户可点击跳转记忆详情。
   *
   * @param messageId 流式消息 ID
   * @param memories 召回记忆摘要列表（name/score/source）
   */
  setMemoryRecall(messageId: string, memories: Array<{ name: string; score: number; source: string }>): void {
    const el = this.streamingMessages.get(messageId);
    if (!el) return;

    // 查找或创建召回记忆容器
    const bubble = el.querySelector('.message-bubble');
    if (!bubble) return;

    // 若已存在召回容器，先清空（避免重复追加）
    const existingContainer = bubble.querySelector('.memory-recall-container');
    if (existingContainer) {
      existingContainer.remove();
    }

    // 无召回记忆时不创建容器
    if (memories.length === 0) return;

    // 复用 createRecallContainer 统一构建逻辑
    const recallContainer = this.createRecallContainer(memories);
    // 插入到光标元素之前（若存在），否则追加到 bubble 末尾
    const cursor = bubble.querySelector('.cursor');
    if (cursor) {
      bubble.insertBefore(recallContainer, cursor);
    } else {
      bubble.appendChild(recallContainer);
    }
  }

  /**
   * MS-12 构建召回记忆容器（私有辅助方法）
   *
   * 统一 appendMessage 和 setMemoryRecall 的 DOM 构建逻辑，避免重复代码。
   * 每条召回记忆独立可点击，点击触发 memoryRecallClickCallback 跳转记忆详情。
   *
   * @param memories 召回记忆摘要列表
   * @returns 已填充的容器 DOM 元素
   */
  private createRecallContainer(memories: Array<{ name: string; score: number; source: string }>): HTMLDivElement {
    const recallContainer = document.createElement('div');
    recallContainer.className = 'memory-recall-container';
    for (const recall of memories) {
      const recallItem = document.createElement('div');
      recallItem.className = 'memory-recall';
      // UX-08：使用 createElement 替代 innerHTML，避免 XSS 风险
      const iconSpan = document.createElement('span');
      iconSpan.textContent = '💡';
      recallItem.appendChild(iconSpan);
      const recallText = document.createElement('span');
      recallText.textContent = `召回记忆：${recall.name}（score: ${recall.score.toFixed(2)}）`;
      recallItem.appendChild(recallText);
      // 闭包捕获当前 recall.name，避免循环变量引用问题
      const recallName = recall.name;
      recallItem.addEventListener('click', () => {
        this.memoryRecallClickCallback?.(recallName);
      });
      recallContainer.appendChild(recallItem);
    }
    return recallContainer;
  }

  // ─── UX-P2-01 思考阶段指示器 ──────────────────────────────

  /** 思考阶段中文映射 */
  private static readonly THINKING_PHASE_LABELS: Record<string, string> = {
    recalling: '正在回忆...',
    processing: '正在处理...',
    archiving: '正在归档...',
  };

  /**
   * UX-P2-01 显示思考阶段指示器
   *
   * 在消息气泡内显示"正在回忆.../处理.../归档..."提示，
   * 让用户在等待首个 text chunk 时知道精灵正在工作。
   * 当 text chunk 到达时，指示器会被 updateStreamingMessage 移除。
   *
   * @param messageId 流式消息 ID
   * @param phase 思考阶段（recalling/processing/archiving）
   */
  showThinkingPhase(messageId: string, phase: string): void {
    const el = this.streamingMessages.get(messageId);
    if (!el) return;

    const bubble = el.querySelector('.message-bubble');
    if (!bubble) return;

    // 查找或创建思考阶段指示器
    let indicator = bubble.querySelector('.thinking-phase') as HTMLDivElement | null;
    if (!indicator) {
      indicator = document.createElement('div');
      indicator.className = 'thinking-phase';
      bubble.appendChild(indicator);
    }

    // 更新阶段文案
    const label = UIManager.THINKING_PHASE_LABELS[phase] ?? phase;
    indicator.textContent = `⚙️ ${label}`;
  }

  // ─── UX-P1-02 工具调用卡片 ────────────────────────────────

  /**
   * UX-P1-02 显示工具调用开始卡片
   *
   * 在消息气泡内渲染工具调用卡片，显示工具名和参数，
   * 让用户感知精灵正在执行工具（如文件读取、记忆搜索等）。
   *
   * @param messageId 流式消息 ID
   * @param name 工具名称
   * @param args 工具参数（可选，JSON 字符串）
   */
  showToolStart(messageId: string, name: string, args?: string): void {
    const el = this.streamingMessages.get(messageId);
    if (!el) return;

    const bubble = el.querySelector('.message-bubble');
    if (!bubble) return;

    // 创建工具调用卡片
    const toolCard = document.createElement('div');
    toolCard.className = 'tool-call tool-call-running';
    toolCard.setAttribute('data-tool-name', name);

    // 工具图标 + 名称
    const header = document.createElement('div');
    header.className = 'tool-call-header';
    const icon = document.createElement('span');
    icon.textContent = '🔧';
    header.appendChild(icon);
    const nameSpan = document.createElement('span');
    nameSpan.className = 'tool-call-name';
    nameSpan.textContent = name;
    header.appendChild(nameSpan);
    const status = document.createElement('span');
    status.className = 'tool-call-status';
    status.textContent = '执行中...';
    header.appendChild(status);
    toolCard.appendChild(header);

    // 工具参数（若提供）
    if (args) {
      const argsDiv = document.createElement('div');
      argsDiv.className = 'tool-call-args';
      argsDiv.textContent = args;
      toolCard.appendChild(argsDiv);
    }

    // 插入到光标元素之前（若存在），否则追加到 bubble 末尾
    const cursor = bubble.querySelector('.cursor');
    if (cursor) {
      bubble.insertBefore(toolCard, cursor);
    } else {
      bubble.appendChild(toolCard);
    }
  }

  /**
   * UX-P1-02 更新工具调用结果
   *
   * 更新工具调用卡片状态为成功/失败，显示结果摘要。
   *
   * @param messageId 流式消息 ID
   * @param name 工具名称（用于定位对应卡片）
   * @param ok 是否成功
   * @param summary 结果摘要（可选）
   */
  updateToolResult(messageId: string, name: string, ok: boolean, summary?: string): void {
    const el = this.streamingMessages.get(messageId);
    if (!el) return;

    const bubble = el.querySelector('.message-bubble');
    if (!bubble) return;

    // 查找对应工具的卡片（按 data-tool-name 匹配，取最后一个未完成的）
    const cards = bubble.querySelectorAll(`.tool-call[data-tool-name="${name}"]`);
    let targetCard: Element | null = null;
    for (const card of Array.from(cards)) {
      if (card.classList.contains('tool-call-running')) {
        targetCard = card;
        break;
      }
    }
    if (!targetCard) return;

    // 更新卡片状态
    targetCard.classList.remove('tool-call-running');
    targetCard.classList.add(ok ? 'tool-call-success' : 'tool-call-failed');

    // 更新状态文本
    const status = targetCard.querySelector('.tool-call-status');
    if (status) {
      status.textContent = ok ? '✓ 成功' : '✗ 失败';
    }

    // 追加结果摘要
    if (summary) {
      const resultDiv = document.createElement('div');
      resultDiv.className = 'tool-call-result';
      resultDiv.textContent = summary;
      targetCard.appendChild(resultDiv);
    }
  }

  /** 开始流式输出 */
  startStreaming(messageId: string): void {
    const el = this.appendMessage({
      role: 'assistant',
      content: '',
      streaming: true,
      messageId,
    });

    this.streamingMessages.set(messageId, el);
    this.state.isStreaming = true;

    // 更新UI状态
    this.btnSend.disabled = true;
    this.btnStop.classList.remove('hidden');
  }

  /** 停止所有流式输出 */
  stopAllStreaming(): void {
    for (const el of this.streamingMessages.values()) {
      el.classList.remove('streaming');
      // 移除光标元素，保留文本内容
      const cursor = el.querySelector('.cursor');
      if (cursor) {
        cursor.remove();
      }
    }
    this.streamingMessages.clear();
    this.state.isStreaming = false;

    // 更新UI状态
    this.btnSend.disabled = false;
    this.btnStop.classList.add('hidden');
  }

  /**
   * FD-05 清空对话区消息
   *
   * 新会话创建后调用：清空当前对话区的所有消息显示，
   * 并重置流式状态。历史会话保留在 SessionStore 中，可通过会话切换找回。
   *
   * 使用 while + removeChild 模式（对齐 project_memory 工程约定）。
   */
  clearMessages(): void {
    // 只移除 .message 元素，保留 chat-empty-state（否则 showEmptyState 找不到元素）
    this.messagesEl.querySelectorAll('.message').forEach((msg) => msg.remove());
    // UX-FD-07 移除加载更多按钮（切换会话时重置）
    this.hideLoadMore();
    this.streamingMessages.clear();
    this.state.isStreaming = false;
    this.btnSend.disabled = false;
    this.btnStop.classList.add('hidden');
    // UX-P2-05 修复：清空消息时重置计数器，避免跨会话累加导致显示错误
    this.messageCount = 0;
    this.refreshMessageCountDisplay();
    // 清空后重新显示空状态引导
    this.showEmptyState();
    // 清空后重置滚动状态，确保新消息能自动滚动
    this.forceScrollToBottom();
  }

  /**
   * UX-FD-07 批量插入消息（DocumentFragment 优化）
   *
   * 一次性插入多条消息到 DOM，使用 DocumentFragment 批量操作，
   * 避免逐条 appendMessage 导致的大量回流和重绘。
   * 用于会话历史加载和会话切换时的消息渲染。
   *
   * @param messages 消息数组
   * @param prepend 是否插入到顶部（加载更多历史消息时使用）
   */
  appendMessages(messages: Message[], prepend: boolean = false): void {
    if (messages.length === 0) return;

    // 隐藏空状态引导
    this.hideEmptyState();

    const fragment = document.createDocumentFragment();
    for (const msg of messages) {
      const el = this.buildMessageElement(msg);
      fragment.appendChild(el);
    }

    if (prepend) {
      // 加载更多：插入到消息区顶部（在 load-more 按钮之后）
      const loadMore = this.messagesEl.querySelector('#load-more-container');
      if (loadMore) {
        loadMore.after(fragment);
      } else {
        this.messagesEl.insertBefore(fragment, this.messagesEl.firstChild);
      }
    } else {
      // 初始加载：追加到消息区末尾
      this.messagesEl.appendChild(fragment);
    }

    this.messageCount += messages.length;
    this.refreshMessageCountDisplay();
    this.forceScrollToBottom();
  }

  /**
   * UX-FD-07 显示"加载更多"按钮
   *
   * 在消息区顶部插入加载更多容器，包含按钮和剩余消息数提示。
   *
   * @param remaining 剩余消息数
   * @param onClick 点击回调
   */
  showLoadMore(remaining: number, onClick: () => void): void {
    // 移除旧按钮（避免重复）
    this.hideLoadMore();

    const container = document.createElement('div');
    container.id = 'load-more-container';
    container.className = 'load-more-container';

    const btn = document.createElement('button');
    btn.className = 'load-more-btn';
    btn.textContent = `加载更多消息（剩余 ${remaining} 条）`;
    btn.addEventListener('click', () => {
      btn.disabled = true;
      btn.textContent = '加载中...';
      onClick();
    });
    container.appendChild(btn);

    // 插入到消息区顶部
    this.messagesEl.insertBefore(container, this.messagesEl.firstChild);
  }

  /**
   * UX-FD-07 隐藏"加载更多"按钮
   */
  hideLoadMore(): void {
    const existing = this.messagesEl.querySelector('#load-more-container');
    if (existing) existing.remove();
  }

  /**
   * UX-PP-01 向流式消息气泡注入错误提示
   *
   * 当流式输出出错时（如网络中断、LLM 返回错误），
   * 将错误文本注入到所有活跃的流式消息气泡中，
   * 并停止流式状态。让用户直接在对话中看到出错原因，
   * 而非仅依赖 toast 通知。
   *
   * @param errorText 错误提示文本
   */
  injectErrorToStreamingMessages(errorText: string): void {
    // 无活跃流式消息时跳过
    if (this.streamingMessages.size === 0) return;

    for (const [, el] of this.streamingMessages) {
      const bubble = el.querySelector('.message-bubble');
      if (!bubble) continue;

      // 移除光标和思考指示器（流式已结束）
      const cursor = bubble.querySelector('.cursor');
      if (cursor) cursor.remove();
      const thinkingIndicator = bubble.querySelector('.thinking-phase');
      if (thinkingIndicator) thinkingIndicator.remove();

      // 添加错误指示器到气泡底部
      const errorDiv = document.createElement('div');
      errorDiv.className = 'stream-error';
      errorDiv.textContent = `⚠️ ${errorText}`;
      bubble.appendChild(errorDiv);

      // 停止流式状态
      el.classList.remove('streaming');
    }

    // 清理流式消息映射和 UI 状态
    this.streamingMessages.clear();
    this.state.isStreaming = false;
    this.btnSend.disabled = false;
    this.btnStop.classList.add('hidden');
  }

  // ─── 空状态引导 ─────────────────────────────────────────

  /** 示例问题点击回调（由 renderer.ts 注册，触发发送消息） */
  private suggestionClickCallback: ((text: string) => void) | null = null;

  /** 注册示例问题点击回调 */
  onSuggestionClick(callback: (text: string) => void): void {
    this.suggestionClickCallback = callback;
  }

  /**
   * 初始化空状态引导的事件监听
   *
   * 点击示例问题按钮时，将问题文本填入输入框并触发发送。
   * 对齐 user_rules "主动可见"：示例问题始终可见，引导新用户快速开始对话。
   */
  private initEmptyStateListeners(): void {
    const emptyState = document.getElementById('chat-empty-state');
    if (!emptyState) return;

    emptyState.querySelectorAll<HTMLElement>('.suggestion-btn').forEach((btn) => {
      const suggestion = btn.dataset.suggestion;
      if (suggestion) {
        this.events.addEventListener(btn, 'click', () => {
          // 将示例问题填入输入框并触发发送回调
          this.suggestionClickCallback?.(suggestion);
        });
      }
    });
  }

  /** 显示空状态引导（无消息时） */
  showEmptyState(): void {
    document.getElementById('chat-empty-state')?.classList.remove('hidden');
  }

  /** 隐藏空状态引导（有消息时） */
  hideEmptyState(): void {
    document.getElementById('chat-empty-state')?.classList.add('hidden');
  }

  /**
   * FD-08 设置按钮 loading 状态
   *
   * 异步操作进行中时禁用按钮并显示 loading 文本，防止用户重复点击。
   * 操作完成后恢复按钮原始状态。
   *
   * @param buttonId 按钮 DOM ID
   * @param loading 是否处于 loading 状态
   * @param loadingText loading 时显示的文本（可选，默认在原文本前加 "..."）
   */
  setButtonLoading(buttonId: string, loading: boolean, loadingText?: string): void {
    const el = document.getElementById(buttonId);
    if (!(el instanceof HTMLButtonElement)) return;

    if (loading) {
      // 保存原始文本到 dataset，用于恢复
      if (!el.dataset.originalText) {
        el.dataset.originalText = el.textContent ?? '';
      }
      el.disabled = true;
      el.textContent = loadingText ?? `${el.dataset.originalText}...`;
    } else {
      el.disabled = false;
      el.textContent = el.dataset.originalText ?? el.textContent ?? '';
      delete el.dataset.originalText;
    }
  }

  // ─── 面板管理 ─────────────────────────────────────────

  /** 切换面板 */
  switchPanel(panel: string): void {
    // 移除所有活动状态
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));

    // 激活目标面板
    const panelEl = document.getElementById(`panel-${panel}`);
    const navBtn = document.querySelector(`.nav-btn[data-panel="${panel}"]`);

    panelEl?.classList.add('active');
    navBtn?.classList.add('active');

    this.state.currentPanel = panel;

    // P2 修复：切换到对话面板时自动聚焦输入框，减少多余点击步骤
    if (panel === 'chat') {
      this.inputEl.focus();
    }
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
   * 此处仅做长度限制和首尾空白清理，不再移除合法的 `<>` 字符——
   * 用户可能输入代码片段、数学符号等合法内容，过度过滤会破坏体验。
   *
   * 真正的 XSS 防护由 textContent（而非 innerHTML）保证。
   */
  private sanitizeInput(input: string): string {
    const MAX_INPUT_LENGTH = 10000;
    const trimmed = input.trim();
    return trimmed.length > MAX_INPUT_LENGTH ? trimmed.substring(0, MAX_INPUT_LENGTH) : trimmed;
  }

  // ─── 未读计数 ─────────────────────────────────────────

  /** 更新未读计数徽章 */
  private updateBadge(): void {
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

  /**
   * 更新消息计数显示
   *
   * 在对话工具栏副标题显示"今日已交流 N 条消息"。
   * 会话历史加载时也会累加计数，确保初始显示正确。
   */
  private updateMessageCount(): void {
    this.messageCount++;
    this.refreshMessageCountDisplay();
  }

  /**
   * 刷新消息计数显示（不累加计数，仅更新 DOM）
   *
   * UX-P2-05 修复：clearMessages 重置计数后调用此方法更新显示，
   * 避免跨会话累加导致"今日已交流 N 条消息"数字错误。
   */
  private refreshMessageCountDisplay(): void {
    const countEl = document.getElementById('chat-message-count');
    if (countEl) {
      countEl.textContent = `今日已交流 ${this.messageCount} 条消息`;
    }
  }

  // ─── 滚动控制 ─────────────────────────────────────────

  /**
   * 智能滚动到底部
   *
   * 仅当用户已在底部附近时才自动滚动，避免用户向上查看历史时被强制拉回底部。
   * 流式输出和用户发送消息时会触发滚动。
   */
  private scrollToBottom(): void {
    if (!this.isNearBottom) return;
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  /**
   * 强制滚动到底部（用户主动操作时调用，如点击"新会话"）
   */
  private forceScrollToBottom(): void {
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

  private handleInputKeydown(e: Event): void {
    if (!(e instanceof KeyboardEvent)) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.emitSendMessage();
    }
  }

  private handleInputChange(): void {
    this.inputEl.style.height = 'auto';
    this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 120) + 'px';
  }

  private handleSendClick(): void {
    this.emitSendMessage();
  }

  private handleStopClick(): void {
    this.emitStopMessage();
  }

  /**
   * FD-05 新建会话按钮点击处理器
   *
   * 设计原则（对齐 user_rules "主动可见"）：
   * - 低频但重要的操作，按钮始终可见，不依赖 hover
   * - 触发回调由 renderer.ts 注册，调用主进程 session-new IPC
   * - 确认对话框防止误操作（清空当前对话区是不可逆的，但历史保留在 SessionStore）
   */
  private handleNewSessionClick(): void {
    this.newSessionCallback?.();
  }

  private handleNavClick(e: Event): void {
    const target = e.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    const panel = target.dataset.panel;
    if (panel) {
      this.switchPanel(panel);
    }
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
   * 根据窗口当前是否最大化切换按钮文字：
   * - 最大化时显示 "❐"（还原图标）
   * - 普通状态时显示 "□"（最大化图标）
   *
   * 仅当 btnMaximize 元素存在时执行（部分布局可能不提供标题栏）
   */
  updateMaximizeButton(maximized: boolean): void {
    if (!this.btnMaximize) return;
    this.btnMaximize.textContent = maximized ? '❐' : '□';
    this.btnMaximize.title = maximized ? '还原' : '最大化';
  }

  // ─── 主动提示 banner（代理到 ProactiveBanner） ──────────

  /**
   * 显示主动提示 banner（代理到 ProactiveBanner）
   *
   * 对齐 docs/memora-sprite-preview.html §6.6：
   * 顶部滑入蓝粉渐变 banner，提供"查看/稍后/静默 1 小时"三个操作。
   * 由 renderer.ts 在收到 proactivePrompt 事件时调用。
   */
  showProactiveBanner(text: string): void {
    this.proactiveBanner.showProactiveBanner(text);
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

  // ─── 事件发射 ─────────────────────────────────────────

  private sendMessageCallback: (() => void) | null = null;
  private stopMessageCallback: (() => void) | null = null;
  /** FD-05 新建会话回调（由 renderer.ts 注册） */
  private newSessionCallback: (() => void) | null = null;

  /** 设置发送消息回调 */
  onSendMessage(callback: () => void): void {
    this.sendMessageCallback = callback;
  }

  /** 设置停止消息回调 */
  onStopMessage(callback: () => void): void {
    this.stopMessageCallback = callback;
  }

  /** FD-05 注册新建会话回调 */
  onNewSession(callback: () => void): void {
    this.newSessionCallback = callback;
  }

  private emitSendMessage(): void {
    // UX-P2-02 流式输出中禁止发送（Enter 键和 Send 按钮共用此检查）
    if (this.state.isStreaming) {
      this.showToast('精灵正在回复中，请等待完成或点击停止', 'warning');
      return;
    }
    // UX-P2-03 Agent 未就绪时禁止发送（LLM 未配置会导致 IPC 失败）
    if (!this.state.isAgentReady) {
      this.showToast('Agent 未就绪，请先在设置面板配置 LLM', 'warning');
      return;
    }
    this.sendMessageCallback?.();
  }

  private emitStopMessage(): void {
    this.stopMessageCallback?.();
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

  // ─── 记忆面板 ─────────────────────────────────────────

  /** 初始化记忆面板事件监听 */
  private initMemoryPanelListeners(): void {
    // 记忆面板元素缺失时静默降级（不阻塞其他功能）
    if (!this.memorySearchEl || !this.memoryFilterSourceEl) return;

    // 搜索框：输入时触发搜索（带防抖）
    this.events.addEventListener(this.memorySearchEl, 'input', () => {
      if (this.searchTimer) clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => {
        this.memorySearchCallback?.(this.memorySearchEl!.value.trim());
      }, 300);
    });

    // source 筛选变更
    this.events.addEventListener(this.memoryFilterSourceEl, 'change', () => {
      this.memoryFilterCallback?.(this.memoryFilterSourceEl!.value);
    });

    // 添加按钮（可选）
    const btnAdd = getOptionalElement('btn-add-memory', 'button');
    if (btnAdd) {
      this.events.addEventListener(btnAdd, 'click', () => {
        this.showModal('memory-add-modal');
      });
    }

    // 添加确认按钮（可选）
    const btnAddConfirm = getOptionalElement('btn-memory-add-confirm', 'button');
    if (btnAddConfirm) {
      this.events.addEventListener(btnAddConfirm, 'click', () => {
        const data = this.getAddMemoryFormData();
        if (data) {
          this.memoryAddCallback?.(data);
        }
      });
    }

    // 删除按钮（可选，带确认对话框，防止误删不可恢复数据）
    const btnDelete = getOptionalElement('btn-memory-delete', 'button');
    if (btnDelete) {
      this.events.addEventListener(btnDelete, 'click', async () => {
        // 确认删除：记忆是持久化数据，删除后不可恢复，需二次确认
        const confirmed = await this.showConfirmDialog({
          title: '删除记忆',
          message: '确定要删除这条记忆吗？此操作不可撤销。',
          confirmText: '删除',
          danger: true,
        });
        if (!confirmed) return;
        this.memoryDeleteCallback?.();
      });
    }
  }

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
  renderMemoryList(memories: MemoryListItem[]): void {
    // 记忆面板元素缺失时静默降级
    if (!this.memoryListEl) return;

    // P3-FLOW-13 缓存完整列表供分页使用
    this.allMemories = memories;
    this.memoryPage = 1;

    // 安全清空容器（使用 clearElement 统一封装 while + removeChild 模式）
    clearElement(this.memoryListEl);

    if (memories.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = '暂无记忆';

      // 空状态引导：提供"添加第一条记忆"按钮，避免用户不知道下一步
      const hintBtn = document.createElement('button');
      // UX-P2-27 同时添加 .btn-secondary 类复用通用按钮样式
      hintBtn.className = 'empty-action-btn btn-secondary';
      hintBtn.textContent = '+ 添加第一条记忆';
      this.events.addEventListener(hintBtn, 'click', () => {
        this.showModal('memory-add-modal');
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
    const end = this.memoryPage * UIManager.MEMORY_PAGE_SIZE;
    const pageItems = this.allMemories.slice(start, end);

    // 清空容器（保留"加载更多"按钮的容器结构）
    clearElement(this.memoryListEl);

    for (const mem of pageItems) {
      const item = document.createElement('div');
      item.className = 'memory-item';
      item.dataset.id = mem.id;

      // 名称
      const nameEl = document.createElement('div');
      nameEl.className = 'name';
      nameEl.textContent = mem.name;
      item.appendChild(nameEl);

      // 元数据（source 标签 + score + P3-FLOW-14 创建时间）
      const metaEl = document.createElement('div');
      metaEl.className = 'meta';

      const sourceTag = document.createElement('span');
      // source 标签颜色区分：不同 source 类型用不同颜色，提升视觉识别度
      // 颜色映射：profile(绿)/insight(蓝)/guardrail(粉)/skill(黄)/rule(紫)/persona(青)/session(橙)
      sourceTag.className = `source-tag source-${this.getSourceColorClass(mem.source)}`;
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
        timeEl.textContent = formatMemoryTime(mem.createdAt);
        metaEl.appendChild(timeEl);
      }

      item.appendChild(metaEl);

      // 预览（2 行截断）
      const previewEl = document.createElement('div');
      previewEl.className = 'preview';
      previewEl.textContent = mem.contentPreview;
      item.appendChild(previewEl);

      // 点击查看详情
      item.addEventListener('click', () => {
        this.memoryClickCallback?.(mem.id);
      });

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

  /** 显示记忆详情 */
  showMemoryDetail(memory: MemoryDetail): void {
    if (!this.memoryDetailModal) return;

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
      sourceEl.className = `source-${this.getSourceColorClass(memory.source)}`;
    }
    if (scoreEl) scoreEl.textContent = memory.score.toFixed(2);
    if (createdEl) createdEl.textContent = memory.createdAt;
    if (accessedEl) accessedEl.textContent = memory.accessedAt;
    if (contentEl) contentEl.textContent = memory.content;

    // 记录当前查看的记忆 ID（供删除按钮使用）
    this.memoryDetailModal.dataset.memoryId = memory.id;
    this.showModal('memory-detail-modal');
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
   */
  private getSourceColorClass(source: string): string {
    const normalized = source.toLowerCase().trim();
    const knownSources = ['profile', 'insight', 'guardrail', 'skill', 'rule', 'persona', 'session'];
    return knownSources.includes(normalized) ? normalized : 'default';
  }

  /** 获取添加记忆表单数据 */
  private getAddMemoryFormData(): { source: string; name: string; content: string } | null {
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

  // 记忆面板回调
  private memorySearchCallback: ((query: string) => void) | null = null;
  private memoryFilterCallback: ((source: string) => void) | null = null;
  private memoryClickCallback: ((id: string) => void) | null = null;
  private memoryDeleteCallback: (() => void) | null = null;
  private memoryAddCallback:
    | ((data: { source: string; name: string; content: string }) => void)
    | null = null;

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

  // ─── 角色选择器 ─────────────────────────────────────────

  /** 初始化角色选择器事件监听 */
  private initPersonaSelectorListeners(): void {
    if (!this.personaSelectorEl || !this.personaDropdownEl) return;

    // 点击选择器切换下拉菜单
    this.events.addEventListener(this.personaSelectorEl, 'click', (e) => {
      e.stopPropagation();
      this.togglePersonaDropdown();
    });

    // UI-AR-01 键盘支持：Enter/Space 展开下拉，Escape 关闭
    this.events.addEventListener(this.personaSelectorEl, 'keydown', (e) => {
      const ke = e as KeyboardEvent;
      if (ke.key === 'Enter' || ke.key === ' ') {
        ke.preventDefault();
        this.togglePersonaDropdown();
      } else if (ke.key === 'Escape') {
        this.personaDropdownEl!.classList.add('hidden');
        this.personaSelectorEl!.focus();
      }
    });

    // UI-AR-01 键盘导航：在下拉菜单内用方向键移动焦点
    this.events.addEventListener(this.personaDropdownEl, 'keydown', (e) => {
      const ke = e as KeyboardEvent;
      const items = this.personaDropdownEl!.querySelectorAll<HTMLElement>('.dropdown-item');
      if (items.length === 0) return;

      const currentIdx = Array.from(items).findIndex(
        (item) => item === document.activeElement,
      );

      if (ke.key === 'ArrowDown') {
        ke.preventDefault();
        const nextIdx = currentIdx < 0 ? 0 : Math.min(currentIdx + 1, items.length - 1);
        const nextItem = items[nextIdx];
        if (nextItem) nextItem.focus();
      } else if (ke.key === 'ArrowUp') {
        ke.preventDefault();
        const prevIdx = currentIdx < 0 ? items.length - 1 : Math.max(currentIdx - 1, 0);
        const prevItem = items[prevIdx];
        if (prevItem) prevItem.focus();
      } else if (ke.key === 'Escape') {
        this.personaDropdownEl!.classList.add('hidden');
        this.personaSelectorEl!.focus();
      }
    });

    // 点击页面其他区域关闭下拉菜单（走统一清理机制）
    this.events.addEventListener(document, 'click', () => {
      this.personaDropdownEl?.classList.add('hidden');
    });
  }

  /** UI-AR-01 切换角色下拉菜单的显示/隐藏 */
  private togglePersonaDropdown(): void {
    if (!this.personaDropdownEl) return;
    const isHidden = this.personaDropdownEl.classList.contains('hidden');
    this.personaDropdownEl.classList.toggle('hidden');

    // 展开时聚焦第一个选项，方便键盘导航
    if (isHidden) {
      const firstItem = this.personaDropdownEl.querySelector<HTMLElement>('.dropdown-item');
      if (firstItem) {
        // 给 DOM 渲染时间，确保元素可见后再聚焦
        requestAnimationFrame(() => firstItem.focus());
      }
    }
  }

  /** 渲染角色下拉菜单 */
  renderPersonaDropdown(personas: PersonaItem[]): void {
    if (!this.personaDropdownEl) return;

    // 捕获局部引用，避免闭包中的 null 检查问题
    const dropdown = this.personaDropdownEl;

    // 安全清空容器（与 renderMemoryList 保持一致，使用 clearElement 封装）
    clearElement(dropdown);

    for (const p of personas) {
      const item = document.createElement('div');
      item.className = 'dropdown-item' + (p.active ? ' active' : '');
      // UX-04：角色名称作为主标题，描述作为副标题直接可见
      const nameEl = document.createElement('div');
      nameEl.className = 'dropdown-item-name';
      nameEl.textContent = p.name;
      const descEl = document.createElement('div');
      descEl.className = 'dropdown-item-desc';
      descEl.textContent = p.description;
      item.appendChild(nameEl);
      item.appendChild(descEl);
      item.title = p.description;
      // UI-AR-01 可聚焦但不参与 Tab 顺序（键盘导航用方向键）
      item.setAttribute('tabindex', '-1');
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', p.active ? 'true' : 'false');

      item.addEventListener('click', (e) => {
        e.stopPropagation();
        this.personaSwitchCallback?.(p.name);
        dropdown.classList.add('hidden');
      });

      dropdown.appendChild(item);
    }

    // 更新角色计数
    const countEl = document.getElementById('persona-count');
    if (countEl) {
      countEl.textContent = String(personas.length);
    }
  }

  /** 更新当前角色显示 */
  updateActivePersona(name: string): void {
    if (this.personaNameEl) {
      this.personaNameEl.textContent = name;
    }
  }

  /**
   * IX-07 更新角色匹配模式标签
   *
   * 在角色选择器旁显示当前模式（auto/manual），
   * 对齐 CLI /mode 查询能力，让 UI 用户也能一眼看到当前模式。
   *
   * @param mode 模式值：'auto' | 'manual'（其他值回退为 'auto'）
   */
  updatePersonaModeBadge(mode: string): void {
    const badge = document.getElementById('persona-mode-badge');
    if (!badge) return;

    const normalizedMode = mode === 'manual' ? 'manual' : 'auto';
    const label = normalizedMode === 'auto' ? '自动' : '手动';
    const title = normalizedMode === 'auto'
      ? '角色匹配模式：自动（根据上下文自动切换角色）'
      : '角色匹配模式：手动（仅手动切换角色，不自动匹配）';

    badge.textContent = label;
    badge.title = title;
    badge.classList.remove('auto', 'manual');
    badge.classList.add(normalizedMode);
  }

  // 角色切换回调
  private personaSwitchCallback: ((name: string) => void) | null = null;

  /** 召回记忆点击回调：点击精灵消息内的召回标签时触发，跳转到记忆详情 */
  private memoryRecallClickCallback: ((memoryName: string) => void) | null = null;

  onPersonaSwitch(cb: (name: string) => void): void {
    this.personaSwitchCallback = cb;
  }

  /** IX-07 注册角色匹配模式变更回调（P2-008 委托到 SettingsPanelManager） */
  onPersonaModeChange(cb: (mode: string) => void): void {
    this.settingsPanelManager.onPersonaModeChange(cb);
  }

  /**
   * ADR-SP-008 注册主题变更回调（代理到 ThemeManager）
   *
   * 当用户在设置面板切换主题时触发，renderer.ts 可借此执行额外同步逻辑。
   * 主题本身的持久化（localStorage）已在 setTheme 内完成，回调仅用于通知。
   *
   * @param cb 主题变更回调函数
   */
  onThemeChange(cb: (theme: 'light' | 'dark') => void): void {
    this.themeManager.onThemeChange(cb);
  }

  /**
   * ADR-SP-008 获取当前主题（代理到 ThemeManager）
   *
   * 通过读取 <html> 元素的 data-theme 属性判断当前主题，
   * 未设置（默认）视为浅色。
   *
   * @returns 当前主题（'light' | 'dark'）
   */
  getTheme(): 'light' | 'dark' {
    return this.themeManager.getTheme();
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

  /** 注册召回记忆点击回调 */
  onMemoryRecallClick(cb: (memoryName: string) => void): void {
    this.memoryRecallClickCallback = cb;
  }

  // ─── 设置面板（P2-008 已提取至 SettingsPanelManager） ──

  // P2-008 initSettingsTabListeners / initSettingsPanelListeners / initApiKeyToggle / resetSettingsFormDirty
  // 已提取至 SettingsPanelManager，initListeners 委托给 settingsPanelManager.initListeners()

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

  // ─── FD-A1 会话历史切换 ─────────────────────────────────────

  /** 会话切换回调（由 renderer.ts 注入） */
  private sessionSwitchCallback: ((sessionId: string) => void) | null = null;

  /** FD-09 会话删除回调（由 renderer.ts 注入） */
  private sessionDeleteCallback: ((sessionId: string) => void) | null = null;

  /** FD-09 会话重命名回调（由 renderer.ts 注入） */
  private sessionRenameCallback: ((sessionId: string) => void) | null = null;

  /** FD-08 当前会话 ID（renderSessionListItems 渲染高亮使用） */
  private sessionsCurrentId: string = '';

  /** FD-08 搜索框事件是否已绑定（仅首次绑定） */
  private sessionSearchBound: boolean = false;

  /** FD-A1 设置会话切换回调 */
  setSessionSwitchCallback(cb: (sessionId: string) => void): void {
    this.sessionSwitchCallback = cb;
  }

  /** FD-09 设置会话删除回调 */
  setSessionDeleteCallback(cb: (sessionId: string) => void): void {
    this.sessionDeleteCallback = cb;
  }

  /** FD-09 设置会话重命名回调 */
  setSessionRenameCallback(cb: (sessionId: string) => void): void {
    this.sessionRenameCallback = cb;
  }

  /**
   * FD-A1 更新会话列表 UI
   *
   * 从主进程获取会话列表后，填充下拉菜单。
   * 会话数 ≤ 1 时隐藏选择器（无需切换）。
   */
  updateSessionList(sessions: Array<{ id: string; date: string; name: string; preview?: string; messageCount?: number }>, currentSessionId: string): void {
    const selector = document.getElementById('session-selector');
    const list = document.getElementById('session-list');
    const currentName = document.getElementById('session-current-name');
    const searchInput = document.getElementById('session-search') as HTMLInputElement | null;
    if (!selector || !list || !currentName) return;

    // P1 修复：移除初始 hidden 类，使会话选择器可见
    // HTML 中 session-selector 初始带 hidden 类，此处首次加载时移除
    selector.classList.remove('hidden');

    // FD-08 存储当前会话 ID，供 renderSessionListItems 高亮使用
    this.sessionsCurrentId = currentSessionId;

    // UX-PP-06 仅一个会话时保留选择器但禁用下拉（避免 UI 消失导致用户困惑）
    if (sessions.length <= 1) {
      selector.classList.add('disabled');
      const sessionCurrent = document.getElementById('session-current');
      if (sessionCurrent) {
        sessionCurrent.setAttribute('aria-disabled', 'true');
      }
      // 仍然渲染当前会话信息（显示名称 + 日期）
      this.renderSessionListItems(sessions);
      return;
    }

    selector.classList.remove('disabled');
    const sessionCurrent = document.getElementById('session-current');
    if (sessionCurrent) {
      sessionCurrent.removeAttribute('aria-disabled');
    }

    // 找到当前会话
    const current = sessions.find(s => s.id === currentSessionId);
    currentName.textContent = current?.name ?? currentSessionId;

    // 清空搜索框并渲染全部会话
    if (searchInput) {
      searchInput.value = '';
      // FD-08 绑定搜索过滤事件（仅首次）
      if (!this.sessionSearchBound) {
        this.sessionSearchBound = true;
        searchInput.addEventListener('input', () => {
          this.filterSessionList(searchInput.value);
        });
      }
    }

    this.renderSessionListItems(sessions);
  }

  /**
   * FD-08 渲染会话列表项
   *
   * 按时间倒序渲染所有会话到 #session-list。
   */
  private renderSessionListItems(sessions: Array<{ id: string; date: string; name: string; preview?: string; messageCount?: number }>): void {
    const list = document.getElementById('session-list');
    if (!list) return;

    // 清空列表
    while (list.firstChild) {
      list.removeChild(list.firstChild);
    }

    const currentId = this.sessionsCurrentId ?? '';

    // 按时间倒序（最近在前）
    const sorted = [...sessions].reverse();
    for (const session of sorted) {
      const li = document.createElement('li');
      li.className = 'session-list-item';
      if (session.id === currentId) {
        li.classList.add('active');
      }
      li.dataset.sessionId = session.id;

      const nameSpan = document.createElement('span');
      nameSpan.className = 'session-list-item-name';
      nameSpan.textContent = session.name;
      li.appendChild(nameSpan);

      const dateSpan = document.createElement('span');
      dateSpan.className = 'session-list-item-date';
      // UX-PP-05 使用相对时间格式化（今天/昨天/3天前/MM-DD）
      dateSpan.textContent = formatRelativeTime(session.date);
      li.appendChild(dateSpan);

      // UX-PP-05 首条消息预览（仅在有内容时显示）
      if (session.preview) {
        const previewSpan = document.createElement('span');
        previewSpan.className = 'session-list-item-preview';
        previewSpan.textContent = session.preview;
        li.appendChild(previewSpan);
      }

      // P3-FLOW-04 消息数量徽章（仅当有消息时显示，避免空会话显示 0）
      if (typeof session.messageCount === 'number' && session.messageCount > 0) {
        const countSpan = document.createElement('span');
        countSpan.className = 'session-list-item-count';
        countSpan.textContent = String(session.messageCount);
        countSpan.title = `${session.messageCount} 条消息`;
        li.appendChild(countSpan);
      }

      // FD-09 删除按钮
      // P3-FLOW-05 当前会话也显示删除按钮（原仅非当前会话显示，导致用户无法删除当前会话）
      // 删除当前会话时由 sessionController 处理切换逻辑
      const delBtn = document.createElement('button');
      delBtn.className = 'session-list-item-del';
      delBtn.title = '删除会话';
      delBtn.textContent = '🗑';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.sessionDeleteCallback?.(session.id);
      });
      li.appendChild(delBtn);

      // FD-09 重命名按钮
      const renameBtn = document.createElement('button');
      renameBtn.className = 'session-list-item-rename';
      renameBtn.title = '重命名会话';
      renameBtn.textContent = '✏';
      renameBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.sessionRenameCallback?.(session.id);
      });
      li.appendChild(renameBtn);

      li.addEventListener('click', () => {
        this.toggleSessionDropdown();
        this.sessionSwitchCallback?.(session.id);
      });

      list.appendChild(li);
    }
  }

  /**
   * FD-08 过滤会话列表
   *
   * 根据搜索关键词过滤显示/隐藏会话列表项。
   * 匹配规则：会话名、日期或预览内容包含关键词（忽略大小写）。
   * P3-FLOW-03 扩展搜索范围：增加 preview 匹配，支持按消息内容关键词查找会话
   */
  private filterSessionList(query: string): void {
    const items = document.querySelectorAll('#session-list .session-list-item');
    const q = query.toLowerCase().trim();

    items.forEach((item) => {
      const el = item as HTMLElement;
      const name = (el.querySelector('.session-list-item-name') as HTMLElement | null)?.textContent ?? '';
      const date = (el.querySelector('.session-list-item-date') as HTMLElement | null)?.textContent ?? '';
      // P3-FLOW-03 增加预览内容匹配
      const preview = (el.querySelector('.session-list-item-preview') as HTMLElement | null)?.textContent ?? '';

      if (q === '' || name.toLowerCase().includes(q) || date.includes(q) || preview.toLowerCase().includes(q)) {
        el.style.display = '';
      } else {
        el.style.display = 'none';
      }
    });
  }

  /** FD-A1 切换会话下拉菜单的显示/隐藏（UX-PP-06 禁用状态下不响应） */
  toggleSessionDropdown(): void {
    const selector = document.getElementById('session-selector');
    if (selector?.classList.contains('disabled')) return;
    const dropdown = document.getElementById('session-dropdown');
    if (dropdown) {
      dropdown.classList.toggle('hidden');
    }
  }

  /** FD-A1 关闭会话下拉菜单 */
  closeSessionDropdown(): void {
    const dropdown = document.getElementById('session-dropdown');
    if (dropdown) {
      dropdown.classList.add('hidden');
    }
  }

  /** P2-008 加载 LLM 配置到表单（委托到 SettingsPanelManager） */
  loadLlmConfigToForm(data: {
    configured: boolean;
    config: LlmConfigForm | null;
    embedding: { model: string; baseUrl: string; apiKey: string } | null;
    presets: Record<string, { provider: string; model: string; baseUrl: string }>;
  }): void {
    this.settingsPanelManager.loadLlmConfigToForm(data);
  }

  /** P2-008 收集表单中的 LLM 配置（委托到 SettingsPanelManager） */
  collectLlmConfigFromForm(): LlmConfigSavePayload {
    return this.settingsPanelManager.collectLlmConfigFromForm();
  }

  /** P2-008 加载配置到表单（委托到 SettingsPanelManager） */
  loadConfigToForm(config: SpriteConfigForm): void {
    this.settingsPanelManager.loadConfigToForm(config);
  }

  /** P2-008 加载项目列表到专注项目下拉框（委托到 SettingsPanelManager） */
  loadProjectsToForm(projects: Array<{ name: string; path: string }>, selectedPath: string): void {
    this.settingsPanelManager.loadProjectsToForm(projects, selectedPath);
  }

  /** P2-008 设置角色匹配模式（委托到 SettingsPanelManager） */
  setPersonaMode(mode: string): void {
    this.settingsPanelManager.setPersonaMode(mode);
  }

  /** P2-008 收集表单中的配置（委托到 SettingsPanelManager） */
  collectConfigFromForm(): SpriteConfigForm {
    return this.settingsPanelManager.collectConfigFromForm();
  }

  /** P2-008 设置面板保存回调（委托到 SettingsPanelManager） */
  onConfigSave(cb: (config: SpriteConfigForm) => void): void {
    this.settingsPanelManager.onConfigSave(cb);
  }
  /** P2-008 设置面板取消回调（委托到 SettingsPanelManager） */
  onConfigCancel(cb: () => void): void {
    this.settingsPanelManager.onConfigCancel(cb);
  }
  /** P2-008 LLM 配置保存回调（委托到 SettingsPanelManager） */
  onLlmConfigSave(cb: (payload: LlmConfigSavePayload) => void): void {
    this.settingsPanelManager.onLlmConfigSave(cb);
  }
  /** P2-008 LLM 连接测试回调（委托到 SettingsPanelManager） */
  onLlmTest(cb: () => void): void {
    this.settingsPanelManager.onLlmTest(cb);
  }

  /** P2-008 显示 LLM 测试连接结果（委托到 SettingsPanelManager） */
  showLlmTestResult(result: { success: boolean; error: string | null }, elapsedMs?: number): void {
    this.settingsPanelManager.showLlmTestResult(result, elapsedMs);
  }

  /** P2-008 收集表单中的 LLM 配置（委托到 SettingsPanelManager） */
  getLlmConfigFromForm(): { provider: string; model: string; baseUrl: string; apiKey: string } {
    return this.settingsPanelManager.getLlmConfigFromForm();
  }

  /** P2-008 重置设置表单 dirty 标志（委托到 SettingsPanelManager） */
  resetSettingsFormDirty(): void {
    this.settingsPanelManager.resetFormDirty();
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
   * @param options.cancelText 取消按钮文本（默认"取消"）
   * @param options.danger 是否危险操作（true 时确认按钮为红色，如删除）
   */
  showConfirmDialog(options: {
    title?: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    danger?: boolean;
  }): Promise<boolean> {
    return this.modalManager.showConfirmDialog(options);
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
