/**
 * UI 模块 — 处理所有 DOM 操作
 *
 * 职责：
 * - 消息渲染和更新
 * - 面板切换
 * - 表单处理
 * - 用户界面状态管理
 *
 * 设计原则：
 * - 所有 DOM 操作集中在此模块
 * - 业务逻辑与 UI 操作分离
 * - 提供清晰的 API 供其他模块调用
 */

import type { ElectronAPI, MemoryListItem, MemorySearchHit, MemoryDetail, SpriteConfigForm } from '../preload.js';
import { renderMarkdown } from './markdown.js';
/** 从精灵零依赖常量模块导入，避免把 spriteConfig.ts 中的 Node.js 内置模块（node:fs/path）带入渲染进程 */
import { MS_PER_MINUTE } from '../../sprite/constants.js';

// 重新导出，保持 ui.ts 的公共 API 不变（其他模块从 ui.ts 导入这些类型）
export type { MemoryListItem, MemorySearchHit, MemoryDetail, SpriteConfigForm };

// 扩展全局 Window 类型，消除 TS 编译错误（electronAPI 由 preload.ts 通过 contextBridge 注入）
declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

/**
 * 获取必需的 DOM 元素，若缺失或标签名不匹配则抛出明确错误
 *
 * 在初始化阶段即发现 HTML 与 TS 不同步问题，避免运行时静默失败。
 *
 * **仅用于核心交互元素**（消息区、输入框、发送按钮、停止按钮）。
 * 非核心元素请使用 `getOptionalElement`，避免单个面板缺失导致整个 UI 崩溃。
 *
 * @param id 元素 id
 * @param tagName 期望的 HTML 标签名
 * @returns 类型安全的 DOM 元素
 */
function getRequiredElement<T extends keyof HTMLElementTagNameMap>(
  id: string,
  tagName: T,
): HTMLElementTagNameMap[T] {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`[UIManager] 必需的 DOM 元素 #${id} 未找到，UI 无法初始化`);
  }
  // 运行时标签名校验：使用 tagName 字符串比较（兼容 JSDOM 等无 DOM 构造函数的环境）
  if (el.tagName.toLowerCase() !== tagName) {
    throw new Error(
      `[UIManager] DOM 元素 #${id} 类型不匹配，期望 <${tagName}>，实际 <${el.tagName.toLowerCase()}>`,
    );
  }
  return el as HTMLElementTagNameMap[T];
}

/**
 * 获取可选的 DOM 元素，缺失时 warn 并返回 null（不阻塞其他功能）
 *
 * 当 HTML 与 TS 不同步时，缺失的功能降级而非整个 UI 崩溃。
 *
 * @param id 元素 id
 * @param tagName 期望的 HTML 标签名
 * @returns 类型安全的 DOM 元素或 null
 */
function getOptionalElement<T extends keyof HTMLElementTagNameMap>(
  id: string,
  tagName: T,
): HTMLElementTagNameMap[T] | null {
  const el = document.getElementById(id);
  if (!el) {
    console.warn(`[UIManager] 可选的 DOM 元素 #${id} 未找到，相关功能将降级`);
    return null;
  }
  // 运行时标签名校验
  if (el.tagName.toLowerCase() !== tagName) {
    console.warn(
      `[UIManager] DOM 元素 #${id} 类型不匹配，期望 <${tagName}>，实际 <${el.tagName.toLowerCase()}>，相关功能将降级`,
    );
    return null;
  }
  return el as HTMLElementTagNameMap[T];
}

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  streaming?: boolean;
  messageId?: string;
  /** 消息时间戳（ISO 字符串，可选）。未提供时使用当前时间。 */
  timestamp?: string;
  /** 召回记忆提示（仅精灵消息可能携带，对齐 HTML 预览 §6.2 .memory-recall） */
  memoryRecall?: { name: string; score: number };
}

export interface UIState {
  currentPanel: string;
  unreadCount: number;
  isStreaming: boolean;
}

/** 记忆列表项（与 sprite.listMemories 返回值对齐） */
// MemoryListItem 已从 preload.ts 导入并重新导出

/** 记忆搜索结果（与 sprite.searchMemories 返回值对齐，含相似度） */
// MemorySearchHit 已从 preload.ts 导入并重新导出

/** 记忆详情（与 sprite.showMemory 返回值对齐） */
// MemoryDetail 已从 preload.ts 导入并重新导出

/** 角色列表项（与 sprite.listPersonas 返回值对齐） */
export interface PersonaItem {
  name: string;
  description: string;
  active: boolean;
}

/** 精灵配置（与 SpriteConfig 对齐，渲染进程用） */
// SpriteConfigForm 已从 preload.ts 导入并重新导出

/** LLM 配置表单数据 */
export interface LlmConfigForm {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  temperature: number;
}

/** Embedding 配置表单数据 */
export interface EmbeddingConfigForm {
  enabled: boolean;
  model: string;
  baseUrl: string;
  apiKey: string;
}

/** LLM 配置保存回调参数（包含 LLM + Embedding） */
export interface LlmConfigSavePayload {
  llm: LlmConfigForm;
  embedding: EmbeddingConfigForm | null;
}

// ─── UI 管理器类 ─────────────────────────────────────────

export class UIManager {
  // ─── 静态常量 ───────────────────────────────────────────
  /** 判断"底部附近"的阈值（像素） */
  private static readonly SCROLL_BOTTOM_THRESHOLD = 100;
  /** localStorage 键名：标记是否已显示过三态引导 */
  private static readonly ONBOARDING_SEEN_KEY = 'memora-onboarding-seen';
  /** Toast 类型与图标映射 */
  private static readonly TOAST_ICONS: Record<ToastType, string> = {
    success: '✓',
    error: '✗',
    warning: '⚠',
    info: 'ℹ',
  };
  /** Toast 默认自动消失时长（毫秒），error 类型不自动消失 */
  private static readonly TOAST_DEFAULT_DURATION = 4000;

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
  private memorySearchEl: HTMLInputElement | null;
  private memoryFilterSourceEl: HTMLSelectElement | null;
  private memoryDetailModal: HTMLElement | null;

  // 角色选择器元素
  private personaSelectorEl: HTMLElement | null;
  private personaDropdownEl: HTMLElement | null;
  private personaNameEl: HTMLElement | null;

  // 设置面板元素 - LLM 配置
  private cfgLlmPreset: HTMLSelectElement | null;
  private cfgLlmProvider: HTMLInputElement | null;
  private cfgLlmModel: HTMLInputElement | null;
  private cfgLlmBaseUrl: HTMLInputElement | null;
  private cfgLlmApiKey: HTMLInputElement | null;
  private cfgLlmTemperature: HTMLInputElement | null;

  // 设置面板元素 - Embedding 配置
  private cfgEmbEnabled: HTMLInputElement | null;
  private cfgEmbModel: HTMLInputElement | null;
  private cfgEmbBaseUrl: HTMLInputElement | null;
  private cfgEmbApiKey: HTMLInputElement | null;

  // 设置面板元素 - 精灵配置
  private cfgSilent: HTMLInputElement | null;
  private cfgThreshold: HTMLInputElement | null;
  private cfgCooldown: HTMLInputElement | null;
  private cfgInterval: HTMLInputElement | null;
  private cfgWatcherEnabled: HTMLInputElement | null;
  private cfgWatcherPaths: HTMLInputElement | null;
  private cfgWatcherDebounce: HTMLInputElement | null;
  private cfgDefaultPersona: HTMLInputElement | null;
  /** FD-04 项目模式：专注项目选择下拉框 */
  private cfgFocusProject: HTMLSelectElement | null;

  private state: UIState = {
    currentPanel: 'chat',
    unreadCount: 0,
    isStreaming: false,
  };

  private streamingMessages = new Map<string, HTMLElement>();
  private eventCleanupFunctions: Array<() => void> = [];

  /** LLM 预设（从主进程加载，避免硬编码） */
  private llmPresets: Record<string, { provider: string; model: string; baseUrl: string }> = {};

  // ─── UI 状态字段 ────────────────────────────────────────
  /** FD-07 设置表单是否有未保存修改（dirty 标志） */
  private settingsFormDirty = false;
  /** 当前角色匹配模式（由 renderer.ts 设置） */
  private currentPersonaMode: string = 'auto';
  /** UI-AR-02 弹窗打开前的焦点元素（供关闭时恢复） */
  private previousFocusEl: HTMLElement | null = null;
  /** 用户是否在底部附近（用于智能滚动：用户向上滚动时不强制滚到底部） */
  private isNearBottom = true;
  /** 记忆搜索防抖定时器（cleanup 时需清理，避免回调在 DOM 销毁后触发） */
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

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

    // 设置面板 - LLM 配置
    this.cfgLlmPreset = getOptionalElement('cfg-llm-preset', 'select');
    this.cfgLlmProvider = getOptionalElement('cfg-llm-provider', 'input');
    this.cfgLlmModel = getOptionalElement('cfg-llm-model', 'input');
    this.cfgLlmBaseUrl = getOptionalElement('cfg-llm-base-url', 'input');
    this.cfgLlmApiKey = getOptionalElement('cfg-llm-api-key', 'input');
    this.cfgLlmTemperature = getOptionalElement('cfg-llm-temperature', 'input');

    // 设置面板 - Embedding 配置
    this.cfgEmbEnabled = getOptionalElement('cfg-emb-enabled', 'input');
    this.cfgEmbModel = getOptionalElement('cfg-emb-model', 'input');
    this.cfgEmbBaseUrl = getOptionalElement('cfg-emb-base-url', 'input');
    this.cfgEmbApiKey = getOptionalElement('cfg-emb-api-key', 'input');

    // 设置面板 - 精灵配置
    this.cfgSilent = getOptionalElement('cfg-silent', 'input');
    this.cfgThreshold = getOptionalElement('cfg-threshold', 'input');
    this.cfgCooldown = getOptionalElement('cfg-cooldown', 'input');
    this.cfgInterval = getOptionalElement('cfg-interval', 'input');
    this.cfgWatcherEnabled = getOptionalElement('cfg-watcher-enabled', 'input');
    this.cfgWatcherPaths = getOptionalElement('cfg-watcher-paths', 'input');
    this.cfgWatcherDebounce = getOptionalElement('cfg-watcher-debounce', 'input');
    this.cfgDefaultPersona = getOptionalElement('cfg-default-persona', 'input');
    this.cfgFocusProject = getOptionalElement('cfg-focus-project', 'select');

    // 初始化 UI
    this.initEventListeners();
    this.initMemoryPanelListeners();
    this.initPersonaSelectorListeners();
    this.initSettingsPanelListeners();
    this.initModalListeners();
    this.initEmptyStateListeners();
    this.initScrollListener();
  }

  // ─── 事件监听器管理 ─────────────────────────────────────

  /** 初始化事件监听器 */
  private initEventListeners(): void {
    // 输入框事件
    this.addEventListener(this.inputEl, 'keydown', this.handleInputKeydown.bind(this));
    this.addEventListener(this.inputEl, 'input', this.handleInputChange.bind(this));

    // 按钮事件
    this.addEventListener(this.btnSend, 'click', this.handleSendClick.bind(this));
    this.addEventListener(this.btnStop, 'click', this.handleStopClick.bind(this));
    // FD-05 新建会话按钮：触发回调（由 renderer.ts 注册，调用主进程创建新会话）
    if (this.btnNewSession) {
      this.addEventListener(this.btnNewSession, 'click', this.handleNewSessionClick.bind(this));
    }

    // 导航事件
    document.querySelectorAll<HTMLElement>('.nav-btn').forEach((btn) => {
      this.addEventListener(btn, 'click', this.handleNavClick.bind(this));
    });

    // 标题栏按钮（可选，部分布局可能不提供）
    const btnMinimize = getOptionalElement('btn-minimize', 'button');
    const btnClose = getOptionalElement('btn-close', 'button');
    if (btnMinimize) {
      this.addEventListener(btnMinimize, 'click', this.handleMinimize.bind(this));
    }
    if (this.btnMaximize) {
      this.addEventListener(this.btnMaximize, 'click', this.handleMaximize.bind(this));
    }
    if (btnClose) {
      this.addEventListener(btnClose, 'click', this.handleClose.bind(this));
    }

    // 窗口状态变更监听（最大化按钮图标切换）
    window.electronAPI.onWindowStateChanged((msg) => {
      this.updateMaximizeButton(msg.maximized);
    });

    // 全局键盘快捷键
    this.addEventListener(document, 'keydown', this.handleGlobalKeydown.bind(this));

    // 快速添加记忆按钮（输入工具栏）：打开记忆添加弹窗
    const btnAddMemoryQuick = getOptionalElement('btn-add-memory-quick', 'button');
    if (btnAddMemoryQuick) {
      this.addEventListener(btnAddMemoryQuick, 'click', () => {
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

    // Esc：关闭所有打开的弹窗
    if (e.key === 'Escape') {
      const openModals = document.querySelectorAll('.modal:not(.hidden)');
      if (openModals.length > 0) {
        openModals.forEach((modal) => modal.classList.add('hidden'));
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
  }

  /** 添加事件监听器并记录清理函数 */
  private addEventListener(element: HTMLElement | Document, event: string, handler: EventListener): void {
    element.addEventListener(event, handler);
    this.eventCleanupFunctions.push(() => {
      element.removeEventListener(event, handler);
    });
  }

  /** 清理所有事件监听器 */
  cleanup(): void {
    this.eventCleanupFunctions.forEach((cleanup) => cleanup());
    this.eventCleanupFunctions = [];
    // 清理搜索防抖定时器，避免回调在 DOM 销毁后触发
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
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
    const el = document.createElement('div');
    el.className = `message ${message.role}${message.streaming ? ' streaming' : ''}`;

    // 有消息时隐藏空状态引导（首次添加消息触发）
    this.hideEmptyState();

    if (message.role === 'system') {
      // 系统消息：简单文本，居中无头像（系统消息为纯文本，不渲染 Markdown）
      el.textContent = message.content;
    } else {
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
        // 精灵消息：渲染 Markdown（代码块/列表/表格/标题/加粗/链接等）
        // LLM 输出经常包含 Markdown 格式，纯文本显示会丢失结构
        bubble.appendChild(renderMarkdown(message.content));
      } else {
        // 用户消息：使用 textContent（用户输入不应被 Markdown 渲染，保持原样 + 防 XSS）
        bubble.textContent = message.content;
      }
      contentWrapper.appendChild(bubble);

      // 精灵消息：添加复制按钮（hover 时显示，点击复制原始内容）
      if (message.role === 'assistant' && !message.streaming) {
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

      // 时间戳（用户/精灵消息显示时间，对齐聊天应用习惯）
      const timestamp = message.timestamp ?? new Date().toISOString();
      const timeEl = document.createElement('div');
      timeEl.className = 'message-time';
      timeEl.textContent = this.formatTimestamp(timestamp);
      contentWrapper.appendChild(timeEl);

      el.appendChild(contentWrapper);

      // 召回记忆提示（仅精灵消息）
      const memoryRecall = message.memoryRecall;
      if (message.role === 'assistant' && memoryRecall) {
        const recall = document.createElement('div');
        recall.className = 'memory-recall';
        // UX-08：使用 createElement 替代 innerHTML，避免 XSS 风险
        const iconSpan = document.createElement('span');
        iconSpan.textContent = '💡';
        recall.appendChild(iconSpan);
        const recallText = document.createElement('span');
        recallText.textContent = `召回记忆：${memoryRecall.name}（score: ${memoryRecall.score.toFixed(2)}）`;
        recall.appendChild(recallText);
        // 点击跳转记忆面板（回调由 renderer.ts 注册）
        recall.addEventListener('click', () => {
          this.memoryRecallClickCallback?.(memoryRecall.name);
        });
        bubble.appendChild(recall);
      }

      // 为流式消息添加光标元素
      if (message.streaming) {
        const cursor = document.createElement('span');
        cursor.className = 'cursor';
        bubble.appendChild(cursor);
      }
    }

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

    // 保留 cursor 和 memory-recall 元素，移除其他内容
    const cursor = bubble.querySelector('.cursor');
    const recall = bubble.querySelector('.memory-recall');
    const preserved: Element[] = [];
    if (recall) preserved.push(recall);

    // 安全清空 bubble（保留 cursor 和 recall）
    this.clearElement(bubble);

    // 重新渲染 Markdown 内容
    bubble.appendChild(renderMarkdown(text));

    // 重新追加保留的元素（recall 在前，cursor 在最后）
    for (const node of preserved) {
      bubble.appendChild(node);
    }
    if (cursor) {
      bubble.appendChild(cursor);
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
    this.streamingMessages.clear();
    this.state.isStreaming = false;
    this.btnSend.disabled = false;
    this.btnStop.classList.add('hidden');
    // 清空后重新显示空状态引导
    this.showEmptyState();
    // 清空后重置滚动状态，确保新消息能自动滚动
    this.forceScrollToBottom();
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
        this.addEventListener(btn, 'click', () => {
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

  /**
   * 安全清空 DOM 容器
   *
   * 使用 while + removeChild 模式（对齐 project_memory 工程约定），
   * 避免 innerHTML = '' 可能带来的事件监听器残留和 XSS 一致性问题。
   */
  private clearElement(el: Element): void {
    while (el.firstChild) {
      el.removeChild(el.firstChild);
    }
  }

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

  /** 非系统消息计数（显示在对话工具栏副标题） */
  private messageCount = 0;

  /**
   * 更新消息计数显示
   *
   * 在对话工具栏副标题显示"今日已交流 N 条消息"。
   * 会话历史加载时也会累加计数，确保初始显示正确。
   */
  private updateMessageCount(): void {
    this.messageCount++;
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
    this.addEventListener(this.messagesEl, 'scroll', () => {
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

  // ─── 主动提示 banner ──────────────────────────────────

  /**
   * 显示主动提示 banner
   *
   * 对齐 docs/memora-sprite-preview.html §6.6：
   * 顶部滑入蓝粉渐变 banner，提供"查看/稍后/静默 1 小时"三个操作。
   * 由 renderer.ts 在收到 proactivePrompt 事件时调用。
   */
  showProactiveBanner(text: string): void {
    const banner = document.getElementById('proactive-banner');
    const textEl = document.getElementById('proactive-banner-text');
    if (!banner || !textEl) return;

    textEl.textContent = text;
    banner.classList.remove('hidden');
  }

  /**
   * 隐藏主动提示 banner
   *
   * 用户点击任意操作按钮后调用，或切换面板时调用。
   */
  hideProactiveBanner(): void {
    const banner = document.getElementById('proactive-banner');
    if (!banner) return;
    banner.classList.add('hidden');
  }

  /**
   * 初始化主动提示 banner 按钮事件
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
  }): void {
    const banner = document.getElementById('proactive-banner');
    if (!banner) return;

    banner.querySelectorAll<HTMLElement>('.banner-btn').forEach((btn) => {
      const action = btn.dataset.action;
      this.addEventListener(btn, 'click', () => {
        this.hideProactiveBanner();
        if (action === 'view') handlers.onView();
        else if (action === 'later') handlers.onLater();
        else if (action === 'silent') handlers.onSilent();
      });
    });

    // UI-UX-02 关闭按钮：直接隐藏 banner，不触发任何回调
    const closeBtn = banner.querySelector<HTMLElement>('.banner-close');
    if (closeBtn) {
      this.addEventListener(closeBtn, 'click', () => {
        this.hideProactiveBanner();
      });
    }
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
    this.addEventListener(this.memorySearchEl, 'input', () => {
      if (this.searchTimer) clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => {
        this.memorySearchCallback?.(this.memorySearchEl!.value.trim());
      }, 300);
    });

    // source 筛选变更
    this.addEventListener(this.memoryFilterSourceEl, 'change', () => {
      this.memoryFilterCallback?.(this.memoryFilterSourceEl!.value);
    });

    // 添加按钮（可选）
    const btnAdd = getOptionalElement('btn-add-memory', 'button');
    if (btnAdd) {
      this.addEventListener(btnAdd, 'click', () => {
        this.showModal('memory-add-modal');
      });
    }

    // 添加确认按钮（可选）
    const btnAddConfirm = getOptionalElement('btn-memory-add-confirm', 'button');
    if (btnAddConfirm) {
      this.addEventListener(btnAddConfirm, 'click', () => {
        const data = this.getAddMemoryFormData();
        if (data) {
          this.memoryAddCallback?.(data);
        }
      });
    }

    // 删除按钮（可选，带确认对话框，防止误删不可恢复数据）
    const btnDelete = getOptionalElement('btn-memory-delete', 'button');
    if (btnDelete) {
      this.addEventListener(btnDelete, 'click', async () => {
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

    // 安全清空容器（使用 clearElement 统一封装 while + removeChild 模式）
    this.clearElement(this.memoryListEl);

    if (memories.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = '暂无记忆';

      // 空状态引导：提供"添加第一条记忆"按钮，避免用户不知道下一步
      const hintBtn = document.createElement('button');
      hintBtn.className = 'empty-action-btn';
      hintBtn.textContent = '+ 添加第一条记忆';
      this.addEventListener(hintBtn, 'click', () => {
        this.showModal('memory-add-modal');
      });
      empty.appendChild(hintBtn);

      this.memoryListEl.appendChild(empty);
      return;
    }

    for (const mem of memories) {
      const item = document.createElement('div');
      item.className = 'memory-item';
      item.dataset.id = mem.id;

      // 名称
      const nameEl = document.createElement('div');
      nameEl.className = 'name';
      nameEl.textContent = mem.name;
      item.appendChild(nameEl);

      // 元数据（source 标签 + score）
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
    this.addEventListener(this.personaSelectorEl, 'click', (e) => {
      e.stopPropagation();
      this.togglePersonaDropdown();
    });

    // UI-AR-01 键盘支持：Enter/Space 展开下拉，Escape 关闭
    this.addEventListener(this.personaSelectorEl, 'keydown', (e) => {
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
    this.addEventListener(this.personaDropdownEl, 'keydown', (e) => {
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
    this.addEventListener(document, 'click', () => {
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
    this.clearElement(dropdown);

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
  /** IX-07 角色匹配模式变更回调（由 renderer.ts 注册，调用主进程持久化） */
  private personaModeChangeCallback: ((mode: string) => void) | null = null;

  /** ADR-SP-008 主题变更回调（由 renderer.ts 注册，用于同步单选按钮状态等） */
  private themeChangeCallback: ((theme: 'light' | 'dark') => void) | null = null;

  /** 召回记忆点击回调：点击精灵消息内的召回标签时触发，跳转到记忆详情 */
  private memoryRecallClickCallback: ((memoryName: string) => void) | null = null;

  onPersonaSwitch(cb: (name: string) => void): void {
    this.personaSwitchCallback = cb;
  }

  /** IX-07 注册角色匹配模式变更回调 */
  onPersonaModeChange(cb: (mode: string) => void): void {
    this.personaModeChangeCallback = cb;
  }

  /**
   * ADR-SP-008 注册主题变更回调
   *
   * 当用户在设置面板切换主题时触发，renderer.ts 可借此执行额外同步逻辑。
   * 主题本身的持久化（localStorage）已在 setTheme 内完成，回调仅用于通知。
   *
   * @param cb 主题变更回调函数
   */
  onThemeChange(cb: (theme: 'light' | 'dark') => void): void {
    this.themeChangeCallback = cb;
  }

  /**
   * ADR-SP-008 获取当前主题
   *
   * 通过读取 <html> 元素的 data-theme 属性判断当前主题，
   * 未设置（默认）视为浅色。
   *
   * @returns 当前主题（'light' | 'dark'）
   */
  getTheme(): 'light' | 'dark' {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }

  /**
   * ADR-SP-008 设置主题
   *
   * 1. 设置 <html> 元素的 data-theme 属性（触发 CSS 变量切换）
   * 2. 持久化到 localStorage（key: 'memora-theme'）
   * 3. 同步设置面板单选按钮状态
   * 4. 触发 themeChangeCallback 通知 renderer.ts
   *
   * @param theme 目标主题
   */
  setTheme(theme: 'light' | 'dark'): void {
    if (theme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      // 浅色为默认，移除属性即可
      document.documentElement.removeAttribute('data-theme');
    }
    try {
      localStorage.setItem('memora-theme', theme);
    } catch {
      // localStorage 不可用时静默降级（如隐私模式）
    }
    this.syncThemeRadios(theme);
    this.themeChangeCallback?.(theme);
  }

  /**
   * ADR-SP-008 同步设置面板主题单选按钮状态
   *
   * 在外部修改主题后（如初始化加载），调用此方法确保单选按钮选中状态与实际主题一致。
   *
   * @param theme 当前主题
   */
  syncThemeRadios(theme: 'light' | 'dark'): void {
    const radios = document.querySelectorAll<HTMLInputElement>('input[name="theme-mode"]');
    radios.forEach((radio) => {
      radio.checked = radio.value === theme;
    });
  }

  /** 注册召回记忆点击回调 */
  onMemoryRecallClick(cb: (memoryName: string) => void): void {
    this.memoryRecallClickCallback = cb;
  }

  // ─── 设置面板 ─────────────────────────────────────────

  /**
   * UI-UX-01 初始化设置面板 tab 切换
   *
   * 点击 tab 按钮时切换对应的内容区显示，
   * 保持 tab 按钮的 active 状态同步。
   */
  private initSettingsTabListeners(): void {
    const tabButtons = document.querySelectorAll<HTMLElement>('.settings-tab');
    const tabContents = document.querySelectorAll<HTMLElement>('.settings-tab-content');

    tabButtons.forEach((btn) => {
      this.addEventListener(btn, 'click', () => {
        const targetTab = btn.dataset.settingsTab;
        if (!targetTab) return;

        // 切换 tab 按钮 active 状态
        tabButtons.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');

        // 切换内容区显示
        tabContents.forEach((content) => {
          if (content.dataset.settingsTab === targetTab) {
            content.classList.add('active');
          } else {
            content.classList.remove('active');
          }
        });
      });
    });
  }

  /** 初始化设置面板事件监听 */
  private initSettingsPanelListeners(): void {
    // UI-UX-01 设置面板 tab 切换
    this.initSettingsTabListeners();

    const btnSave = getOptionalElement('btn-settings-save', 'button');
    const btnCancel = getOptionalElement('btn-settings-cancel', 'button');
    const btnLlmTest = document.getElementById('btn-llm-test');

    // 设置面板核心元素缺失时静默降级
    if (!btnSave && !btnCancel) return;

    // API Key 显示/隐藏切换：LLM + Embedding
    this.initApiKeyToggle('btn-toggle-llm-key', 'cfg-llm-api-key');
    this.initApiKeyToggle('btn-toggle-emb-key', 'cfg-emb-api-key');

    // FD-07 监听设置面板所有表单元素的变更，标记 dirty
    const settingsPanel = document.getElementById('panel-settings');
    if (settingsPanel) {
      this.addEventListener(settingsPanel, 'input', () => {
        this.settingsFormDirty = true;
      });
      this.addEventListener(settingsPanel, 'change', () => {
        this.settingsFormDirty = true;
      });
    }

    // 保存按钮：同时收集精灵配置和 LLM 配置
    if (btnSave) {
      this.addEventListener(btnSave, 'click', () => {
        const spriteConfig = this.collectConfigFromForm();
        const llmConfig = this.collectLlmConfigFromForm();
        // FD-07 保存后清除 dirty 标志
        this.settingsFormDirty = false;
        this.configSaveCallback?.(spriteConfig);
        this.llmConfigSaveCallback?.(llmConfig);
      });
    }

    // FD-07 取消按钮：有未保存修改时确认，避免误点丢失修改
    if (btnCancel) {
      this.addEventListener(btnCancel, 'click', async () => {
        if (this.settingsFormDirty) {
          const confirmed = await this.showConfirmDialog({
            title: '放弃修改',
            message: '有未保存的修改，确定要放弃吗？',
            confirmText: '放弃',
            danger: true,
          });
          if (!confirmed) {
            return;
          }
        }
        this.settingsFormDirty = false;
        this.configCancelCallback?.();
      });
    }

    // LLM 预设切换：自动填充 provider/model/baseUrl
    if (this.cfgLlmPreset) {
      this.addEventListener(this.cfgLlmPreset, 'change', () => {
        const presetKey = this.cfgLlmPreset!.value;
        if (presetKey) {
          this.applyLlmPreset(presetKey);
        }
      });
    }

    // LLM 连接测试按钮：调用主进程验证配置
    if (btnLlmTest) {
      this.addEventListener(btnLlmTest, 'click', () => {
        this.llmTestCallback?.();
      });
    }

    // FD-04 项目模式单选按钮：切换时启用/禁用专注项目下拉框
    const projectModeRadios = document.querySelectorAll<HTMLInputElement>('input[name="project-mode"]');
    projectModeRadios.forEach((radio) => {
      this.addEventListener(radio, 'change', () => {
        if (this.cfgFocusProject) {
          this.cfgFocusProject.disabled = radio.value !== 'focus';
        }
      });
    });

    // IX-07 角色匹配模式单选按钮：切换时实时更新标签 + 触发回调持久化
    const personaModeRadios = document.querySelectorAll<HTMLInputElement>('input[name="persona-mode"]');
    personaModeRadios.forEach((radio) => {
      this.addEventListener(radio, 'change', () => {
        const selectedMode = radio.value;
        this.currentPersonaMode = selectedMode;
        this.updatePersonaModeBadge(selectedMode);
        this.personaModeChangeCallback?.(selectedMode);
      });
    });

    // ADR-SP-008 主题切换单选按钮：切换时立即应用主题（无需等待保存按钮）
    const themeRadios = document.querySelectorAll<HTMLInputElement>('input[name="theme-mode"]');
    themeRadios.forEach((radio) => {
      this.addEventListener(radio, 'change', () => {
        if (radio.checked) {
          this.setTheme(radio.value === 'dark' ? 'dark' : 'light');
        }
      });
    });
  }

  /**
   * 初始化 API Key 显示/隐藏切换
   *
   * 点击眼睛图标在 password 和 text 之间切换输入框类型，
   * 方便用户确认输入的 Key 是否正确。
   *
   * @param toggleBtnId 切换按钮 ID
   * @param inputId 输入框 ID
   */
  private initApiKeyToggle(toggleBtnId: string, inputId: string): void {
    const btn = document.getElementById(toggleBtnId);
    const input = document.getElementById(inputId);
    if (!(btn instanceof HTMLButtonElement) || !(input instanceof HTMLInputElement)) return;

    this.addEventListener(btn, 'click', () => {
      if (input.type === 'password') {
        input.type = 'text';
        btn.textContent = '🙈';
        btn.title = '隐藏 API Key';
      } else {
        input.type = 'password';
        btn.textContent = '👁';
        btn.title = '显示 API Key';
      }
    });
  }

  /**
   * FD-07 重置 dirty 标志
   *
   * 在 loadConfigToForm / loadLlmConfigToForm 后由 renderer.ts 调用，
   * 因为程序化设置表单值会触发 input/change 事件，需要重置 dirty 标志
   * 以避免"取消"按钮误判为有修改。
   */
  resetSettingsFormDirty(): void {
    this.settingsFormDirty = false;
  }

  /** 应用 LLM 预设到表单 */
  private applyLlmPreset(key: string): void {
    const preset = this.llmPresets[key];
    if (preset && this.cfgLlmProvider && this.cfgLlmModel && this.cfgLlmBaseUrl) {
      this.cfgLlmProvider.value = preset.provider;
      this.cfgLlmModel.value = preset.model;
      this.cfgLlmBaseUrl.value = preset.baseUrl;
    }
  }

  /** 加载 LLM 配置到表单 */
  loadLlmConfigToForm(data: {
    configured: boolean;
    config: LlmConfigForm | null;
    /** 主进程返回的 embedding（无 enabled 字段，由 configured 推断） */
    embedding: { model: string; baseUrl: string; apiKey: string } | null;
    presets: Record<string, { provider: string; model: string; baseUrl: string }>;
  }): void {
    // 保存预设供 applyLlmPreset 使用（避免硬编码）
    this.llmPresets = data.presets ?? {};

    if (data.config) {
      if (this.cfgLlmProvider) this.cfgLlmProvider.value = data.config.provider;
      if (this.cfgLlmModel) this.cfgLlmModel.value = data.config.model;
      if (this.cfgLlmBaseUrl) this.cfgLlmBaseUrl.value = data.config.baseUrl;
      if (this.cfgLlmApiKey) this.cfgLlmApiKey.value = data.config.apiKey;
      if (this.cfgLlmTemperature) this.cfgLlmTemperature.value = String(data.config.temperature);

      // 反向匹配预设
      if (this.cfgLlmPreset) {
        const presetKey = Object.entries(data.presets).find(
          ([, p]) => p.provider === data.config?.provider && p.model === data.config.model,
        )?.[0];
        this.cfgLlmPreset.value = presetKey ?? '';
      }
    }

    if (data.embedding) {
      if (this.cfgEmbEnabled) this.cfgEmbEnabled.checked = true;
      if (this.cfgEmbModel) this.cfgEmbModel.value = data.embedding.model;
      if (this.cfgEmbBaseUrl) this.cfgEmbBaseUrl.value = data.embedding.baseUrl;
      if (this.cfgEmbApiKey) this.cfgEmbApiKey.value = data.embedding.apiKey;
    } else {
      if (this.cfgEmbEnabled) this.cfgEmbEnabled.checked = false;
    }
  }

  /** 收集表单中的 LLM 配置 */
  collectLlmConfigFromForm(): LlmConfigSavePayload {
    const llm: LlmConfigForm = {
      provider: this.cfgLlmProvider?.value.trim() ?? '',
      model: this.cfgLlmModel?.value.trim() ?? '',
      baseUrl: this.cfgLlmBaseUrl?.value.trim() ?? '',
      apiKey: this.cfgLlmApiKey?.value.trim() ?? '',
      temperature: parseFloat(this.cfgLlmTemperature?.value ?? '0.7') || 0.7,
    };

    let embedding: EmbeddingConfigForm | null = null;
    if (this.cfgEmbEnabled?.checked) {
      embedding = {
        enabled: true,
        model: this.cfgEmbModel?.value.trim() ?? '',
        baseUrl: this.cfgEmbBaseUrl?.value.trim() ?? '',
        apiKey: this.cfgEmbApiKey?.value.trim() ?? '',
      };
    }

    return { llm, embedding };
  }

  /** 加载配置到表单 */
  loadConfigToForm(config: SpriteConfigForm): void {
    if (this.cfgSilent) this.cfgSilent.checked = config.silentMode;
    if (this.cfgThreshold) this.cfgThreshold.value = String(config.proactiveThreshold);
    if (this.cfgCooldown) this.cfgCooldown.value = String(Math.round(config.proactiveCooldownMs / MS_PER_MINUTE));
    if (this.cfgInterval) this.cfgInterval.value = String(Math.round(config.triggerIntervalMs / MS_PER_MINUTE));
    if (this.cfgWatcherEnabled) this.cfgWatcherEnabled.checked = config.fileWatcherEnabled;
    if (this.cfgWatcherPaths) this.cfgWatcherPaths.value = config.fileWatcherPaths.join(', ');
    if (this.cfgWatcherDebounce) this.cfgWatcherDebounce.value = String(config.fileWatcherDebounceMs);
    if (this.cfgDefaultPersona) this.cfgDefaultPersona.value = config.defaultPersona;

    // 角色匹配模式（单选按钮）
    const modeRadio = document.querySelector<HTMLInputElement>(
      `input[name="persona-mode"][value="${this.currentPersonaMode}"]`,
    );
    if (modeRadio) {
      modeRadio.checked = true;
    }

    // FD-04 项目模式（单选按钮 + 专注项目下拉框）
    const projectModeRadio = document.querySelector<HTMLInputElement>(
      `input[name="project-mode"][value="${config.projectMode}"]`,
    );
    if (projectModeRadio) {
      projectModeRadio.checked = true;
    }
    if (this.cfgFocusProject) {
      this.cfgFocusProject.disabled = config.projectMode !== 'focus';
    }
    // 专注项目路径在 loadProjects 后由 renderer.ts 设置选中项
  }

  /** FD-04 加载项目列表到专注项目下拉框 */
  loadProjectsToForm(projects: Array<{ name: string; path: string }>, selectedPath: string): void {
    if (!this.cfgFocusProject) return;

    // 保留第一个占位选项
    while (this.cfgFocusProject.options.length > 1) {
      this.cfgFocusProject.remove(1);
    }
    for (const p of projects) {
      const opt = document.createElement('option');
      opt.value = p.path;
      opt.textContent = `${p.name} (${p.path})`;
      this.cfgFocusProject.appendChild(opt);
    }
    this.cfgFocusProject.value = selectedPath;
  }

  /** 设置角色匹配模式（供 renderer.ts 调用） */
  setPersonaMode(mode: string): void {
    this.currentPersonaMode = mode;
    const radio = document.querySelector<HTMLInputElement>(
      `input[name="persona-mode"][value="${mode}"]`,
    );
    if (radio) {
      radio.checked = true;
    }
  }

  /** 收集表单中的配置 */
  collectConfigFromForm(): SpriteConfigForm {
    const modeRadio = document.querySelector<HTMLInputElement>(
      'input[name="persona-mode"]:checked',
    );
    this.currentPersonaMode = modeRadio?.value ?? 'auto';

    // FD-04 收集项目模式
    const projectModeRadio = document.querySelector<HTMLInputElement>(
      'input[name="project-mode"]:checked',
    );
    const projectMode = projectModeRadio?.value === 'focus' ? 'focus' : 'smart';

    return {
      silentMode: this.cfgSilent?.checked ?? false,
      proactiveThreshold: parseInt(this.cfgThreshold?.value ?? '3', 10) || 3,
      proactiveCooldownMs: (parseInt(this.cfgCooldown?.value ?? '5', 10) || 5) * MS_PER_MINUTE,
      triggerIntervalMs: (parseInt(this.cfgInterval?.value ?? '60', 10) || 60) * MS_PER_MINUTE,
      fileWatcherEnabled: this.cfgWatcherEnabled?.checked ?? false,
      fileWatcherPaths: this.cfgWatcherPaths?.value
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0) ?? [],
      fileWatcherDebounceMs: parseInt(this.cfgWatcherDebounce?.value ?? '1000', 10) || 1000,
      defaultPersona: this.cfgDefaultPersona?.value.trim() ?? '',
      projectMode,
      focusProjectPath: projectMode === 'focus' ? (this.cfgFocusProject?.value ?? '') : '',
    };
  }

  // 设置面板回调
  private configSaveCallback: ((config: SpriteConfigForm) => void) | null = null;
  private configCancelCallback: (() => void) | null = null;
  private llmConfigSaveCallback: ((payload: LlmConfigSavePayload) => void) | null = null;
  /** LLM 连接测试回调：由 renderer.ts 注册，调用主进程 testLlmConfig */
  private llmTestCallback: (() => void) | null = null;

  onConfigSave(cb: (config: SpriteConfigForm) => void): void {
    this.configSaveCallback = cb;
  }
  onConfigCancel(cb: () => void): void {
    this.configCancelCallback = cb;
  }
  onLlmConfigSave(cb: (payload: LlmConfigSavePayload) => void): void {
    this.llmConfigSaveCallback = cb;
  }
  /** 注册 LLM 连接测试回调 */
  onLlmTest(cb: () => void): void {
    this.llmTestCallback = cb;
  }

  /**
   * 显示 LLM 测试连接结果
   *
   * @param result 测试结果（success + error）
   * @param elapsedMs 测试耗时（毫秒），用于展示响应速度
   */
  showLlmTestResult(result: { success: boolean; error: string | null }, elapsedMs?: number): void {
    const resultEl = document.getElementById('llm-test-result');
    if (!resultEl) return;

    if (result.success) {
      const timeHint = elapsedMs !== undefined ? `（${elapsedMs}ms）` : '';
      resultEl.textContent = `✓ 连接成功${timeHint}`;
      resultEl.style.color = 'var(--green)';
    } else {
      // 失败时补充排查建议，引导用户修复而非仅显示错误
      const hint = '\n排查建议：检查 API Key 是否正确 / baseUrl 是否可达 / model 名称是否支持';
      resultEl.textContent = `✗ 失败：${result.error ?? '未知错误'}${hint}`;
      resultEl.style.color = 'var(--red)';
    }
  }

  /** 收集表单中的 LLM 配置（供测试连接复用） */
  getLlmConfigFromForm(): { provider: string; model: string; baseUrl: string; apiKey: string } {
    return {
      provider: this.cfgLlmProvider?.value.trim() ?? '',
      model: this.cfgLlmModel?.value.trim() ?? '',
      baseUrl: this.cfgLlmBaseUrl?.value.trim() ?? '',
      apiKey: this.cfgLlmApiKey?.value.trim() ?? '',
    };
  }

  // ─── 弹窗管理 ─────────────────────────────────────────

  /** 初始化弹窗事件监听（关闭按钮、背景点击、Escape 键） */
  private initModalListeners(): void {
    // 所有带 data-modal 属性的关闭按钮
    document.querySelectorAll<HTMLElement>('[data-modal]').forEach((btn) => {
      const modalId = btn.dataset.modal;
      if (modalId) {
        this.addEventListener(btn, 'click', () => this.hideModal(modalId));
      }
    });

    // 点击弹窗背景关闭（统一使用 hideModal，避免与 showConfirmDialog 冲突）
    document.querySelectorAll<HTMLElement>('.modal').forEach((modal) => {
      this.addEventListener(modal, 'click', (e) => {
        if (e.target === modal) {
          this.hideModal(modal.id);
        }
      });
    });

    // UI-AR-01 全局 Escape 键关闭弹窗
    this.addEventListener(document, 'keydown', (e: Event) => {
      if ((e as KeyboardEvent).key !== 'Escape') return;
      // 查找当前可见的弹窗（排除 confirm 弹窗，它有独立处理）
      const visibleModals = document.querySelectorAll<HTMLElement>(
        '.modal:not(.hidden):not(#confirm-modal)',
      );
      // 关闭最上层弹窗
      if (visibleModals.length > 0) {
        const topModal = visibleModals[visibleModals.length - 1];
        if (topModal) {
          this.hideModal(topModal.id);
        }
      }
    });
  }

  /** 显示弹窗 */
  showModal(modalId: string): void {
    const modal = document.getElementById(modalId);
    if (!modal) return;

    // UI-AR-02 保存当前焦点元素，关闭弹窗时恢复
    this.previousFocusEl = document.activeElement as HTMLElement | null;

    modal.classList.remove('hidden');

    // UI-AR-02 将焦点移到弹窗内第一个可交互元素
    const firstFocusable = modal.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (firstFocusable) {
      firstFocusable.focus();
    }
  }

  /** 隐藏弹窗 */
  hideModal(modalId: string): void {
    const modal = document.getElementById(modalId);
    if (!modal) return;

    modal.classList.add('hidden');

    // UI-AR-02 恢复焦点到触发弹窗的元素
    if (this.previousFocusEl && typeof this.previousFocusEl.focus === 'function') {
      this.previousFocusEl.focus();
      this.previousFocusEl = null;
    }
  }

  /** 当前活跃的确认弹窗清理函数（防止并发调用时监听器叠加） */
  private activeConfirmCleanup: (() => void) | null = null;

  /**
   * 显示通用确认弹窗（替代 window.confirm）
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
    return new Promise((resolve) => {
      const modal = document.getElementById('confirm-modal');
      const titleEl = document.getElementById('confirm-title');
      const messageEl = document.getElementById('confirm-message');
      const btnOk = document.getElementById('btn-confirm-ok');
      const btnCancel = document.getElementById('btn-confirm-cancel');
      if (!modal || !titleEl || !messageEl || !btnOk || !btnCancel) {
        // 元素缺失时回退为 window.confirm（防御性编程）
        resolve(window.confirm(options.message));
        return;
      }

      // 设置弹窗内容
      titleEl.textContent = options.title ?? '确认';
      messageEl.textContent = options.message;
      btnOk.textContent = options.confirmText ?? '确定';
      btnCancel.textContent = options.cancelText ?? '取消';

      // 危险操作：确认按钮使用红色样式
      btnOk.className = options.danger ? 'btn-danger' : 'btn-primary';

      // 并发保护：若已有活跃弹窗，先取消旧的（resolve false），避免监听器叠加
      if (this.activeConfirmCleanup) {
        this.activeConfirmCleanup();
        this.activeConfirmCleanup = null;
      }

      // 清理函数：移除所有临时监听器
      let resolved = false;

      // UI-AR-01 键盘支持：Escape 取消，Enter 确认
      const onKeydown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          onOk();
        }
      };

      const cleanup = () => {
        if (resolved) return;
        resolved = true;
        modal.classList.add('hidden');
        btnOk.removeEventListener('click', onOk);
        btnCancel.removeEventListener('click', onCancel);
        modal.removeEventListener('click', onBackdrop);
        modal.removeEventListener('keydown', onKeydown);
        const closeBtn = modal.querySelector('.modal-close');
        if (closeBtn) closeBtn.removeEventListener('click', onCancel);
        this.activeConfirmCleanup = null;
      };
      const onOk = () => { cleanup(); resolve(true); };
      const onCancel = () => { cleanup(); resolve(false); };

      // 注册活跃清理函数，供下次并发调用时取消旧弹窗
      this.activeConfirmCleanup = () => { cleanup(); resolve(false); };

      // 注册监听器
      btnOk.addEventListener('click', onOk);
      btnCancel.addEventListener('click', onCancel);
      modal.addEventListener('keydown', onKeydown);
      // 使用 stopPropagation 防止 initModalListeners 的全局 backdrop 处理器也触发
      const onBackdrop = (e: MouseEvent) => {
        if (e.target === modal) {
          e.stopPropagation();
          onCancel();
        }
      };
      modal.addEventListener('click', onBackdrop);
      const closeBtn = modal.querySelector('.modal-close');
      if (closeBtn) closeBtn.addEventListener('click', onCancel);

      // 显示弹窗
      modal.classList.remove('hidden');

      // UI-AR-02 保存当前焦点 + 将焦点移到确认弹窗
      // 危险操作：焦点放在取消按钮上（防止误操作）；普通操作：焦点放在确认按钮上
      this.previousFocusEl = document.activeElement as HTMLElement | null;
      if (options.danger) {
        btnCancel.focus();
      } else {
        btnOk.focus();
      }
    });
  }

  // ─── 三态首次引导 ─────────────────────────────────────

  /**
   * 检查是否需要显示三态首次引导
   *
   * 使用 localStorage 标记，首次使用（未标记）时返回 true。
   * 老用户（已标记）不再显示，避免重复打扰。
   */
  shouldShowOnboarding(): boolean {
    return localStorage.getItem(UIManager.ONBOARDING_SEEN_KEY) !== '1';
  }

  /**
   * 显示三态首次引导弹窗
   *
   * 介绍三态窗口模型（完整/浮动/托盘）+ 快捷键。
   * 用户点击"开始使用"或关闭弹窗后标记为已见过。
   */
  showOnboardingDialog(): void {
    const modal = document.getElementById('onboarding-modal');
    const btnOk = document.getElementById('btn-onboarding-ok');
    if (!modal || !btnOk) return;

    // 标记已见过引导（无论用户点击确定还是关闭）
    const markSeen = () => {
      localStorage.setItem(UIManager.ONBOARDING_SEEN_KEY, '1');
    };

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      markSeen();
      modal.classList.add('hidden');
      btnOk.removeEventListener('click', onOk);
      modal.removeEventListener('click', onBackdrop);
      const closeBtn = modal.querySelector('.modal-close');
      if (closeBtn) closeBtn.removeEventListener('click', onClose);
    };

    const onOk = () => close();
    const onClose = () => close();
    const onBackdrop = (e: MouseEvent) => {
      if (e.target === modal) close();
    };

    btnOk.addEventListener('click', onOk);
    modal.addEventListener('click', onBackdrop);
    const closeBtn = modal.querySelector('.modal-close');
    if (closeBtn) closeBtn.addEventListener('click', onClose);

    // 显示弹窗
    modal.classList.remove('hidden');
  }

  // ─── IX-06 Toast 通知 ─────────────────────────────────

  /**
   * 显示 Toast 通知
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
  showToast(message: string, type: ToastType = 'info', duration?: number): void {
    const container = document.getElementById('toast-container');
    if (!container) return;

    // 限制最多 5 条，移除最早的（FIFO）
    while (container.children.length >= 5) {
      container.firstChild?.remove();
    }

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');

    // 图标
    const icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.textContent = UIManager.TOAST_ICONS[type];
    toast.appendChild(icon);

    // 内容
    const content = document.createElement('div');
    content.className = 'toast-content';
    content.textContent = message;
    toast.appendChild(content);

    // 关闭按钮
    const closeBtn = document.createElement('button');
    closeBtn.className = 'toast-close';
    closeBtn.textContent = '✕';
    closeBtn.title = '关闭';
    closeBtn.addEventListener('click', () => this.removeToast(toast));
    toast.appendChild(closeBtn);

    container.appendChild(toast);

    // 自动消失（error 默认不消失，需用户手动关闭）
    const autoDuration = duration ?? (type === 'error' ? 0 : UIManager.TOAST_DEFAULT_DURATION);
    if (autoDuration > 0) {
      setTimeout(() => this.removeToast(toast), autoDuration);
    }
  }

  /** 移除 Toast（带离场动画） */
  private removeToast(toast: HTMLElement): void {
    if (!toast.parentElement) return;
    toast.classList.add('leaving');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
  }
}

// ─── IX-06 Toast 类型定义 ─────────────────────────────────

/** Toast 通知类型 */
export type ToastType = 'success' | 'error' | 'warning' | 'info';
