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
 * - P2-008：聊天/记忆/角色/会话面板提取至独立 PanelManager，UIManager 仅做 facade 委托
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
import { SettingsPanelManager } from './panels/settingsPanelManager.js';
import type { SettingsPanelHost } from './panels/settingsPanelManager.js';
import { ChatPanelManager } from './panels/chatPanelManager.js';
import type { ChatPanelHost } from './panels/chatPanelManager.js';
import { MemoryPanelManager } from './panels/memoryPanelManager.js';
import type { MemoryPanelHost } from './panels/memoryPanelManager.js';
import { PersonaPanelManager } from './panels/personaPanelManager.js';
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

export class UIManager implements ChatPanelHost, MemoryPanelHost {
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
  /** P2-008 设置面板管理器（独立管理设置面板 DOM 和事件，约 450 行提取） */
  private settingsPanelManager: SettingsPanelManager;

  // ─── P2-008 面板管理器（聊天/记忆/角色/会话，约 1800 行提取） ──
  /** 聊天面板管理器（消息渲染、流式输出、思考指示器、工具调用卡片） */
  private chatPanel: ChatPanelManager;
  /** 记忆面板管理器（列表渲染、搜索过滤、详情弹窗） */
  private memoryPanel: MemoryPanelManager;
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
  /* btnNewSession 已移除 */
  /** 最大化按钮（标题栏右侧，用于图标切换 □ ↔ ❐） */
  private btnMaximize: HTMLButtonElement | null;

  // P2-008 设置面板 DOM 元素已提取至 SettingsPanelManager

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

  // P2-008 settingsFormDirty / llmPresets / currentPersonaMode 已提取至 SettingsPanelManager

  // ─── UI 状态字段 ────────────────────────────────────────
  /** FD-A2 面板错误横幅重试回调映射（key: panelId，如 'settings'/'memory'/'chat'） */
  private panelErrorRetryCallbacks = new Map<string, () => void>();
  /** P2-008 currentPersonaMode 已提取至 SettingsPanelManager */
  /** 用户是否在底部附近（用于智能滚动：用户向上滚动时不强制滚到底部） */
  private isNearBottom = true;
  /** 非系统消息计数（显示在对话工具栏副标题，P2-009：移至 state 字段区） */
  private messageCount = 0;

  constructor() {
    // ─── 核心交互元素：必需，缺失时抛出（UI 无法工作） ────
    this.messagesEl = getRequiredElement('messages', 'div');
    this.inputEl = getRequiredElement('input', 'textarea');
    this.btnSend = getRequiredElement('btn-send', 'button');

    // ─── 可选元素：缺失时 warn 并降级，不阻塞其他功能 ──────
    this.badge = document.getElementById('badge');
    // btnNewSession 已移除
    this.btnMaximize = getOptionalElement('btn-maximize', 'button');

    // P2-008 设置面板 DOM 元素初始化已提取至 SettingsPanelManager
    this.settingsPanelManager = new SettingsPanelManager(this as SettingsPanelHost);

    // H1 初始化配置建议卡片容器（动态创建 #suggestion-container 或复用 HTML 预定义元素）
    this.suggestionCard.init();
    // H2 初始化用户画像面板（绑定刷新按钮事件）
    this.profilePanel.init();

    // ─── P2-008 面板管理器初始化（提取自 ui.ts 约 1800 行） ───

    // P1-ET-01 每个面板持有独立的 EventTracker，避免 cleanup 时互相干扰
    // 聊天面板管理器
    this.chatPanel = new ChatPanelManager(
      this,
      this.messagesEl,
      new EventTracker(),
      this.state,
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

    // 角色选择器面板管理器
    this.personaPanel = new PersonaPanelManager(
      getOptionalElement('persona-selector', 'div'),
      getOptionalElement('persona-dropdown', 'div'),
      getOptionalElement('persona-name', 'span'),
      new EventTracker(),
    );

    // 会话历史面板管理器已移除（方案 B：时间流式 UI，不再需要会话切换下拉）

    // 初始化 UI
    this.initEventListeners();
    this.memoryPanel.initMemoryPanelListeners();
    this.personaPanel.initPersonaSelectorListeners();
    this.settingsPanelManager.initListeners(); // P2-008 委托到 SettingsPanelManager
    this.initPanelErrorRetryButtons(); // FD-A2 统一面板错误横幅重试按钮
    // 模态框监听器委托给 ModalManager（独立管理事件清理）
    this.modalManager.initModalListeners();
    this.chatPanel.initEmptyStateListeners();
    this.initScrollListener();
  }

  // ─── 事件监听器管理 ─────────────────────────────────────

  /** 初始化事件监听器 */
  private initEventListeners(): void {
    // 输入框事件
    this.events.addEventListener(this.inputEl, 'keydown', this.handleInputKeydown.bind(this));
    this.events.addEventListener(this.inputEl, 'input', this.handleInputChange.bind(this));

    // 按钮事件（发送按钮合并了停止功能，流式态时点击触发停止）
    this.events.addEventListener(this.btnSend, 'click', this.handleSendClick.bind(this));
    // FD-05 新建会话按钮：触发回调（由 renderer.ts 注册，调用主进程创建新会话）
    // 新建会话按钮已移除（会话按天自动存储）

    // FD-A1 会话选择器事件绑定已移除（方案 B：时间流式 UI，不再需要会话切换下拉）

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

    // Esc：关闭展开的下拉菜单（弹窗由 ModalManager 统一处理）
    // P1-ESC-01 移除弹窗关闭逻辑，避免与 ModalManager 的 Escape 处理冲突
    if (e.key === 'Escape') {
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
        void this.switchPanel(panel);
        e.preventDefault();
      }
      return;
    }

    // Ctrl/Cmd + N：新建会话
    // Ctrl+N 已移除（会话按天自动存储）

    // P2-FLOW-07 Ctrl/Cmd + .：停止生成（流式输出期间可用键盘快速中断）
    if (isMod && e.key === '.') {
      if (this.state.isStreaming) {
        this.emitStopMessage();
        e.preventDefault();
      }
      return;
    }

    // Ctrl/Cmd + /：显示快捷键帮助弹窗
    if (isMod && e.key === '/') {
      const modal = document.getElementById('shortcuts-modal');
      if (modal) {
        modal.classList.toggle('hidden');
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
    this.settingsPanelManager.cleanup(); // P2-008 清理设置面板事件监听器
    // P2-008 清理面板管理器
    this.chatPanel.cleanup();
    this.memoryPanel.cleanup(); // Q1 清理记忆面板防抖定时器
    this.personaPanel.cleanup();
    // sessionPanel.cleanup() 已移除（方案 B：时间流式 UI，不再需要会话切换下拉）
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
  setMemoryRecall(messageId: string, memories: Array<{ name: string; score: number; source: string }>): void { this.chatPanel.setMemoryRecall(messageId, memories); }
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
   * 此处仅做长度限制和首尾空白清理，保留合法的 `<>` 字符——
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
    }
  }

  private handleInputChange(): void {
    this.inputEl.style.height = 'auto';
    this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 120) + 'px';
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
  /* handleNewSessionClick 已移除 */

  private handleNavClick(e: Event): void {
    const target = e.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    const panel = target.dataset.panel;
    if (panel) {
      // switchPanel 为 async，void 显式忽略 Promise
      void this.switchPanel(panel);
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
  /* newSessionCallback 已移除 */

  /** 设置发送消息回调 */
  onSendMessage(callback: () => void): void {
    this.sendMessageCallback = callback;
  }

  /** 设置停止消息回调 */
  onStopMessage(callback: () => void): void {
    this.stopMessageCallback = callback;
  }

  private emitSendMessage(): void {
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

  /** 统一更新发送/停止按钮状态（空闲态发送 / 流式态停止） */
  updateSendButton(): void {
    if (this.state.isStreaming) {
      // 流式态：显示停止姿态
      this.btnSend.disabled = false;  // 不禁用，点击触发停止
      this.btnSend.classList.add('streaming');
      this.btnSend.textContent = '■';
      this.btnSend.title = '停止生成';
    } else {
      // 空闲态：显示发送姿态
      this.btnSend.disabled = false;
      this.btnSend.classList.remove('streaming');
      this.btnSend.textContent = '➤';
      this.btnSend.title = '发送（Enter）';
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
  renderMemoryList(memories: MemoryListItem[]): void { this.memoryPanel.renderMemoryList(memories); }
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

  // ─── 角色选择器 ─ 委托到 PersonaPanelManager ───────────────

  /** 渲染角色下拉菜单（委托到 PersonaPanelManager） */
  renderPersonaDropdown(personas: PersonaItem[]): void { this.personaPanel.renderPersonaDropdown(personas); }
  /** 更新当前角色显示（委托到 PersonaPanelManager） */
  updateActivePersona(name: string): void { this.personaPanel.updateActivePersona(name); }
  /** 更新角色匹配模式标签（委托到 PersonaPanelManager） */
  updatePersonaModeBadge(mode: string): void { this.personaPanel.updatePersonaModeBadge(mode); }
  /** 注册角色切换回调（委托到 PersonaPanelManager） */
  onPersonaSwitch(cb: (name: string) => void): void { this.personaPanel.onPersonaSwitch(cb); }
  /** 注册召回记忆点击回调（委托到 PersonaPanelManager + ChatPanelManager） */
  onMemoryRecallClick(cb: (memoryName: string) => void): void {
    this.personaPanel.onMemoryRecallClick(cb);
    this.chatPanel.setMemoryRecallClickCallback(cb);
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

  // ─── 会话历史 ─ 委托方法已移除（方案 B：时间流式 UI，不再需要会话切换下拉） ───

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
        const diffDays = Math.floor((today.getTime() - target.getTime()) / (24 * 60 * 60 * 1000));
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
    await this.switchPanel('memory');
    // 聚焦记忆搜索框（switchPanel 不会自动聚焦非 chat 面板的输入框）
    const searchInput = document.getElementById('memory-search') as HTMLInputElement | null;
    searchInput?.focus();
  }

  // ─── Phase 4.3 第二批：技能文件拖入安装 ──────────────────

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
      this.showToast(`已跳过 ${skipped} 个非 .md 文件`, 'info', 2000);
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
      this.showToast(msg, 'success', 3000);
      this.skillInstalledCallback?.();
    }
    if (lastError) {
      this.showToast(lastError, 'error', 4000);
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
        this.showToast(`${file.name}：${result.error}`, 'error', 4000);
        return false;
      }
      return true;
    } catch (err) {
      // 读取文件或 IPC 调用异常
      const errMsg = err instanceof Error ? err.message : String(err);
      this.showToast(`${file.name}：${errMsg}`, 'error', 4000);
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