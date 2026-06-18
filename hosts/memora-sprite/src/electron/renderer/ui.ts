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

// ─── 类型定义 ─────────────────────────────────────────────

/** 毫秒/分钟转换常量（用于配置表单的分钟 ↔ 毫秒换算） */
const MS_PER_MINUTE = 60_000;

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  streaming?: boolean;
  messageId?: string;
  /** 召回记忆提示（仅精灵消息可能携带，对齐 HTML 预览 §6.2 .memory-recall） */
  memoryRecall?: { name: string; score: number };
}

export interface UIState {
  currentPanel: string;
  unreadCount: number;
  isStreaming: boolean;
}

/** 记忆列表项（与 sprite.listMemories 返回值对齐） */
export interface MemoryListItem {
  id: string;
  name: string;
  source: string;
  score: number;
  contentPreview: string;
}

/** 记忆搜索结果（与 sprite.searchMemories 返回值对齐，含相似度） */
export interface MemorySearchHit {
  name: string;
  source: string;
  score: number;
  contentPreview: string;
  similarity?: number;
}

/** 记忆详情（与 sprite.showMemory 返回值对齐） */
export interface MemoryDetail {
  id: string;
  name: string;
  source: string;
  score: number;
  content: string;
  createdAt: string;
  accessedAt: string;
}

/** 角色列表项（与 sprite.listPersonas 返回值对齐） */
export interface PersonaItem {
  name: string;
  description: string;
  active: boolean;
}

/** 精灵配置（与 SpriteConfig 对齐，渲染进程用） */
export interface SpriteConfigForm {
  silentMode: boolean;
  proactiveThreshold: number;
  proactiveCooldownMs: number;
  triggerIntervalMs: number;
  fileWatcherEnabled: boolean;
  fileWatcherPaths: string[];
  fileWatcherDebounceMs: number;
  defaultPersona: string;
}

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
  private messagesEl: HTMLElement;
  private inputEl: HTMLTextAreaElement;
  private btnSend: HTMLButtonElement;
  private btnStop: HTMLButtonElement;
  private badge: HTMLElement;

  // 记忆面板元素
  private memoryListEl: HTMLElement;
  private memorySearchEl: HTMLInputElement;
  private memoryFilterSourceEl: HTMLSelectElement;
  private memoryDetailModal: HTMLElement;

  // 角色选择器元素
  private personaSelectorEl: HTMLElement;
  private personaDropdownEl: HTMLElement;
  private personaNameEl: HTMLElement;

  // 设置面板元素 - LLM 配置
  private cfgLlmPreset: HTMLSelectElement;
  private cfgLlmProvider: HTMLInputElement;
  private cfgLlmModel: HTMLInputElement;
  private cfgLlmBaseUrl: HTMLInputElement;
  private cfgLlmApiKey: HTMLInputElement;
  private cfgLlmTemperature: HTMLInputElement;

  // 设置面板元素 - Embedding 配置
  private cfgEmbEnabled: HTMLInputElement;
  private cfgEmbModel: HTMLInputElement;
  private cfgEmbBaseUrl: HTMLInputElement;
  private cfgEmbApiKey: HTMLInputElement;

  // 设置面板元素 - 精灵配置
  private cfgSilent: HTMLInputElement;
  private cfgThreshold: HTMLInputElement;
  private cfgCooldown: HTMLInputElement;
  private cfgInterval: HTMLInputElement;
  private cfgWatcherEnabled: HTMLInputElement;
  private cfgWatcherPaths: HTMLInputElement;
  private cfgWatcherDebounce: HTMLInputElement;
  private cfgDefaultPersona: HTMLInputElement;

  private state: UIState = {
    currentPanel: 'chat',
    unreadCount: 0,
    isStreaming: false,
  };

  private streamingMessages = new Map<string, HTMLElement>();
  private eventCleanupFunctions: Array<() => void> = [];

  /** LLM 预设（从主进程加载，避免硬编码） */
  private llmPresets: Record<string, { provider: string; model: string; baseUrl: string }> = {};

  constructor() {
    // 获取 DOM 元素引用
    this.messagesEl = document.getElementById('messages')!;
    this.inputEl = document.getElementById('input') as HTMLTextAreaElement;
    this.btnSend = document.getElementById('btn-send') as HTMLButtonElement;
    this.btnStop = document.getElementById('btn-stop') as HTMLButtonElement;
    this.badge = document.getElementById('badge')!;

    // 记忆面板
    this.memoryListEl = document.getElementById('memory-list')!;
    this.memorySearchEl = document.getElementById('memory-search') as HTMLInputElement;
    this.memoryFilterSourceEl = document.getElementById(
      'memory-filter-source',
    ) as HTMLSelectElement;
    this.memoryDetailModal = document.getElementById('memory-detail-modal')!;

    // 角色选择器
    this.personaSelectorEl = document.getElementById('persona-selector')!;
    this.personaDropdownEl = document.getElementById('persona-dropdown')!;
    this.personaNameEl = document.getElementById('persona-name')!;

    // 设置面板 - LLM 配置
    this.cfgLlmPreset = document.getElementById('cfg-llm-preset') as HTMLSelectElement;
    this.cfgLlmProvider = document.getElementById('cfg-llm-provider') as HTMLInputElement;
    this.cfgLlmModel = document.getElementById('cfg-llm-model') as HTMLInputElement;
    this.cfgLlmBaseUrl = document.getElementById('cfg-llm-base-url') as HTMLInputElement;
    this.cfgLlmApiKey = document.getElementById('cfg-llm-api-key') as HTMLInputElement;
    this.cfgLlmTemperature = document.getElementById('cfg-llm-temperature') as HTMLInputElement;

    // 设置面板 - Embedding 配置
    this.cfgEmbEnabled = document.getElementById('cfg-emb-enabled') as HTMLInputElement;
    this.cfgEmbModel = document.getElementById('cfg-emb-model') as HTMLInputElement;
    this.cfgEmbBaseUrl = document.getElementById('cfg-emb-base-url') as HTMLInputElement;
    this.cfgEmbApiKey = document.getElementById('cfg-emb-api-key') as HTMLInputElement;

    // 设置面板 - 精灵配置
    this.cfgSilent = document.getElementById('cfg-silent') as HTMLInputElement;
    this.cfgThreshold = document.getElementById('cfg-threshold') as HTMLInputElement;
    this.cfgCooldown = document.getElementById('cfg-cooldown') as HTMLInputElement;
    this.cfgInterval = document.getElementById('cfg-interval') as HTMLInputElement;
    this.cfgWatcherEnabled = document.getElementById('cfg-watcher-enabled') as HTMLInputElement;
    this.cfgWatcherPaths = document.getElementById('cfg-watcher-paths') as HTMLInputElement;
    this.cfgWatcherDebounce = document.getElementById('cfg-watcher-debounce') as HTMLInputElement;
    this.cfgDefaultPersona = document.getElementById('cfg-default-persona') as HTMLInputElement;

    // 初始化 UI
    this.initEventListeners();
    this.initMemoryPanelListeners();
    this.initPersonaSelectorListeners();
    this.initSettingsPanelListeners();
    this.initModalListeners();
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

    // 导航事件
    document.querySelectorAll<HTMLElement>('.nav-btn').forEach((btn) => {
      this.addEventListener(btn, 'click', this.handleNavClick.bind(this));
    });

    // 标题栏事件
    this.addEventListener(
      document.getElementById('btn-minimize')!,
      'click',
      this.handleMinimize.bind(this),
    );
    this.addEventListener(
      document.getElementById('btn-maximize')!,
      'click',
      this.handleMaximize.bind(this),
    );
    this.addEventListener(
      document.getElementById('btn-close')!,
      'click',
      this.handleClose.bind(this),
    );
  }

  /** 添加事件监听器并记录清理函数 */
  private addEventListener(element: HTMLElement, event: string, handler: EventListener): void {
    element.addEventListener(event, handler);
    this.eventCleanupFunctions.push(() => {
      element.removeEventListener(event, handler);
    });
  }

  /** 清理所有事件监听器 */
  cleanup(): void {
    this.eventCleanupFunctions.forEach((cleanup) => cleanup());
    this.eventCleanupFunctions = [];
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

    if (message.role === 'system') {
      // 系统消息：简单文本，居中无头像
      el.textContent = message.content;
    } else {
      // 用户/精灵消息：头像 + 气泡结构
      const avatar = document.createElement('div');
      avatar.className = 'message-avatar';
      avatar.textContent = message.role === 'user' ? '🧑' : '🧚';
      el.appendChild(avatar);

      const bubble = document.createElement('div');
      bubble.className = 'message-bubble';
      // 使用 textContent 安全设置文本（防 XSS）
      bubble.textContent = message.content;
      el.appendChild(bubble);

      // 召回记忆提示（仅精灵消息）
      if (message.role === 'assistant' && message.memoryRecall) {
        const recall = document.createElement('div');
        recall.className = 'memory-recall';
        recall.innerHTML = '<span>💡</span>';
        const recallText = document.createElement('span');
        recallText.textContent = `召回记忆：${message.memoryRecall.name}（score: ${message.memoryRecall.score.toFixed(2)}）`;
        recall.appendChild(recallText);
        // 点击跳转记忆面板（回调由 renderer.ts 注册）
        recall.addEventListener('click', () => {
          this.memoryRecallClickCallback?.(message.memoryRecall!.name);
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

    // 更新未读计数（完整窗口隐藏时）
    if (message.role === 'assistant' && document.hidden) {
      this.state.unreadCount++;
      this.updateBadge();
    }

    return el;
  }

  /**
   * 更新流式消息内容
   *
   * 消息结构为 message > message-bubble > [textNode, cursor]
   * 需要定位到 bubble 元素更新其文本节点，保留 cursor 元素。
   */
  updateStreamingMessage(messageId: string, text: string): void {
    const el = this.streamingMessages.get(messageId);
    if (!el) return;

    // 定位到气泡元素（assistant 消息结构：message > message-bubble）
    const bubble = el.querySelector('.message-bubble');
    if (!bubble) return;

    // 安全地更新文本内容，保留光标元素
    const textNode = bubble.firstChild;
    if (textNode && textNode.nodeType === Node.TEXT_NODE) {
      textNode.textContent = text;
    } else {
      // 如果没有文本节点，创建一个并插入到最前面（cursor 之前）
      const newTextNode = document.createTextNode(text);
      bubble.insertBefore(newTextNode, bubble.firstChild);
    }

    this.scrollToBottom();
  }

  /**
   * 完成流式消息
   *
   * 移除 streaming 类和光标元素。
   * 注意：原实现中的 `/【.*】$/` 正则无注释且语义不明，已移除——
   * 流式文本由主进程逐 chunk 拼接，不应在渲染层做尾部标记清理。
   */
  finishStreamingMessage(messageId: string): void {
    const el = this.streamingMessages.get(messageId);
    if (!el) return;

    el.classList.remove('streaming');
    // 移除光标元素
    const cursor = el.querySelector('.cursor');
    if (cursor) cursor.remove();
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

  /** 更新未读计数徽章 */
  private updateBadge(): void {
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

  /** 滚动到底部 */
  private scrollToBottom(): void {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  // ─── 事件处理器 ─────────────────────────────────────

  private handleInputKeydown(e: Event): void {
    const keyboardEvent = e as KeyboardEvent;
    if (keyboardEvent.key === 'Enter' && !keyboardEvent.shiftKey) {
      keyboardEvent.preventDefault();
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

  private handleNavClick(e: Event): void {
    const btn = e.currentTarget as HTMLElement;
    const panel = btn.dataset.panel;
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
  }

  // ─── 事件发射 ─────────────────────────────────────────

  private sendMessageCallback: (() => void) | null = null;
  private stopMessageCallback: (() => void) | null = null;

  /** 设置发送消息回调 */
  onSendMessage(callback: () => void): void {
    this.sendMessageCallback = callback;
  }

  /** 设置停止消息回调 */
  onStopMessage(callback: () => void): void {
    this.stopMessageCallback = callback;
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
    // 搜索框：输入时触发搜索（带防抖）
    let searchTimer: ReturnType<typeof setTimeout> | null = null;
    this.addEventListener(this.memorySearchEl, 'input', () => {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        this.memorySearchCallback?.(this.memorySearchEl.value.trim());
      }, 300);
    });

    // source 筛选变更
    this.addEventListener(this.memoryFilterSourceEl, 'change', () => {
      this.memoryFilterCallback?.(this.memoryFilterSourceEl.value);
    });

    // 添加按钮
    const btnAdd = document.getElementById('btn-add-memory') as HTMLButtonElement;
    this.addEventListener(btnAdd, 'click', () => {
      this.showModal('memory-add-modal');
    });

    // 添加确认按钮
    const btnAddConfirm = document.getElementById('btn-memory-add-confirm') as HTMLButtonElement;
    this.addEventListener(btnAddConfirm, 'click', () => {
      const data = this.getAddMemoryFormData();
      if (data) {
        this.memoryAddCallback?.(data);
      }
    });

    // 删除按钮
    const btnDelete = document.getElementById('btn-memory-delete') as HTMLButtonElement;
    this.addEventListener(btnDelete, 'click', () => {
      this.memoryDeleteCallback?.();
    });
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
    // 安全清空容器：while + removeChild 比 innerHTML = '' 更安全
    // （虽然 innerHTML = '' 清空时不解析 HTML，但保持一致性用 removeChild）
    while (this.memoryListEl.firstChild) {
      this.memoryListEl.removeChild(this.memoryListEl.firstChild);
    }

    if (memories.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = '暂无记忆';
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
      sourceTag.className = 'source-tag';
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
    const nameEl = document.getElementById('memory-detail-name')!;
    const sourceEl = document.getElementById('memory-detail-source')!;
    const scoreEl = document.getElementById('memory-detail-score')!;
    const createdEl = document.getElementById('memory-detail-created')!;
    const accessedEl = document.getElementById('memory-detail-accessed')!;
    const contentEl = document.getElementById('memory-detail-content')!;

    nameEl.textContent = memory.name;
    sourceEl.textContent = memory.source;
    scoreEl.textContent = memory.score.toFixed(2);
    createdEl.textContent = memory.createdAt;
    accessedEl.textContent = memory.accessedAt;
    contentEl.textContent = memory.content;

    // 记录当前查看的记忆 ID（供删除按钮使用）
    this.memoryDetailModal.dataset.memoryId = memory.id;
    this.showModal('memory-detail-modal');
  }

  /** 获取添加记忆表单数据 */
  private getAddMemoryFormData(): { source: string; name: string; content: string } | null {
    const source = (document.getElementById('memory-add-source') as HTMLInputElement).value.trim();
    const name = (document.getElementById('memory-add-name') as HTMLInputElement).value.trim();
    const content = (
      document.getElementById('memory-add-content') as HTMLTextAreaElement
    ).value.trim();

    if (!source || !name || !content) {
      return null;
    }
    return { source, name, content };
  }

  /** 清空添加记忆表单 */
  clearAddMemoryForm(): void {
    (document.getElementById('memory-add-source') as HTMLInputElement).value = '';
    (document.getElementById('memory-add-name') as HTMLInputElement).value = '';
    (document.getElementById('memory-add-content') as HTMLTextAreaElement).value = '';
  }

  /** 获取当前查看的记忆 ID（供删除使用） */
  getCurrentMemoryId(): string | null {
    return this.memoryDetailModal.dataset.memoryId ?? null;
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
    // 点击选择器切换下拉菜单
    this.addEventListener(this.personaSelectorEl, 'click', (e) => {
      e.stopPropagation();
      this.personaDropdownEl.classList.toggle('hidden');
    });

    // 点击页面其他区域关闭下拉菜单
    document.addEventListener('click', () => {
      this.personaDropdownEl.classList.add('hidden');
    });
  }

  /** 渲染角色下拉菜单 */
  renderPersonaDropdown(personas: PersonaItem[]): void {
    // 安全清空容器：与 renderMemoryList 保持一致，使用 removeChild 而非 innerHTML
    while (this.personaDropdownEl.firstChild) {
      this.personaDropdownEl.removeChild(this.personaDropdownEl.firstChild);
    }

    for (const p of personas) {
      const item = document.createElement('div');
      item.className = 'dropdown-item' + (p.active ? ' active' : '');
      item.textContent = p.name;
      item.title = p.description;

      item.addEventListener('click', (e) => {
        e.stopPropagation();
        this.personaSwitchCallback?.(p.name);
        this.personaDropdownEl.classList.add('hidden');
      });

      this.personaDropdownEl.appendChild(item);
    }

    // 更新角色计数
    const countEl = document.getElementById('persona-count');
    if (countEl) {
      countEl.textContent = String(personas.length);
    }
  }

  /** 更新当前角色显示 */
  updateActivePersona(name: string): void {
    this.personaNameEl.textContent = name;
  }

  // 角色切换回调
  private personaSwitchCallback: ((name: string) => void) | null = null;

  /** 召回记忆点击回调：点击精灵消息内的召回标签时触发，跳转到记忆详情 */
  private memoryRecallClickCallback: ((memoryName: string) => void) | null = null;

  onPersonaSwitch(cb: (name: string) => void): void {
    this.personaSwitchCallback = cb;
  }

  /** 注册召回记忆点击回调 */
  onMemoryRecallClick(cb: (memoryName: string) => void): void {
    this.memoryRecallClickCallback = cb;
  }

  // ─── 设置面板 ─────────────────────────────────────────

  /** 初始化设置面板事件监听 */
  private initSettingsPanelListeners(): void {
    const btnSave = document.getElementById('btn-settings-save') as HTMLButtonElement;
    const btnCancel = document.getElementById('btn-settings-cancel') as HTMLButtonElement;
    const btnLlmTest = document.getElementById('btn-llm-test') as HTMLButtonElement | null;

    // 保存按钮：同时收集精灵配置和 LLM 配置
    this.addEventListener(btnSave, 'click', () => {
      const spriteConfig = this.collectConfigFromForm();
      const llmConfig = this.collectLlmConfigFromForm();
      this.configSaveCallback?.(spriteConfig);
      this.llmConfigSaveCallback?.(llmConfig);
    });

    this.addEventListener(btnCancel, 'click', () => {
      this.configCancelCallback?.();
    });

    // LLM 预设切换：自动填充 provider/model/baseUrl
    this.addEventListener(this.cfgLlmPreset, 'change', () => {
      const presetKey = this.cfgLlmPreset.value;
      if (presetKey) {
        this.applyLlmPreset(presetKey);
      }
    });

    // LLM 连接测试按钮：调用主进程验证配置
    if (btnLlmTest) {
      this.addEventListener(btnLlmTest, 'click', () => {
        this.llmTestCallback?.();
      });
    }
  }

  /** 应用 LLM 预设到表单 */
  private applyLlmPreset(key: string): void {
    const preset = this.llmPresets[key];
    if (preset) {
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
      this.cfgLlmProvider.value = data.config.provider;
      this.cfgLlmModel.value = data.config.model;
      this.cfgLlmBaseUrl.value = data.config.baseUrl;
      this.cfgLlmApiKey.value = data.config.apiKey;
      this.cfgLlmTemperature.value = String(data.config.temperature);

      // 反向匹配预设
      const presetKey = Object.entries(data.presets).find(
        ([, p]) => p.provider === data.config?.provider && p.model === data.config.model,
      )?.[0];
      this.cfgLlmPreset.value = presetKey ?? '';
    }

    if (data.embedding) {
      this.cfgEmbEnabled.checked = true;
      this.cfgEmbModel.value = data.embedding.model;
      this.cfgEmbBaseUrl.value = data.embedding.baseUrl;
      this.cfgEmbApiKey.value = data.embedding.apiKey;
    } else {
      this.cfgEmbEnabled.checked = false;
    }
  }

  /** 收集表单中的 LLM 配置 */
  collectLlmConfigFromForm(): LlmConfigSavePayload {
    const llm: LlmConfigForm = {
      provider: this.cfgLlmProvider.value.trim(),
      model: this.cfgLlmModel.value.trim(),
      baseUrl: this.cfgLlmBaseUrl.value.trim(),
      apiKey: this.cfgLlmApiKey.value.trim(),
      temperature: parseFloat(this.cfgLlmTemperature.value) || 0.7,
    };

    let embedding: EmbeddingConfigForm | null = null;
    if (this.cfgEmbEnabled.checked) {
      embedding = {
        enabled: true,
        model: this.cfgEmbModel.value.trim(),
        baseUrl: this.cfgEmbBaseUrl.value.trim(),
        apiKey: this.cfgEmbApiKey.value.trim(),
      };
    }

    return { llm, embedding };
  }

  /** 加载配置到表单 */
  loadConfigToForm(config: SpriteConfigForm): void {
    this.cfgSilent.checked = config.silentMode;
    this.cfgThreshold.value = String(config.proactiveThreshold);
    this.cfgCooldown.value = String(Math.round(config.proactiveCooldownMs / MS_PER_MINUTE));
    this.cfgInterval.value = String(Math.round(config.triggerIntervalMs / MS_PER_MINUTE));
    this.cfgWatcherEnabled.checked = config.fileWatcherEnabled;
    this.cfgWatcherPaths.value = config.fileWatcherPaths.join(', ');
    this.cfgWatcherDebounce.value = String(config.fileWatcherDebounceMs);
    this.cfgDefaultPersona.value = config.defaultPersona;

    // 角色匹配模式（单选按钮）
    const modeRadio = document.querySelector(
      `input[name="persona-mode"][value="${this.currentPersonaMode}"]`,
    ) as HTMLInputElement | null;
    if (modeRadio) {
      modeRadio.checked = true;
    }
  }

  /** 当前角色匹配模式（由 renderer.ts 设置） */
  private currentPersonaMode: string = 'auto';

  /** 设置角色匹配模式（供 renderer.ts 调用） */
  setPersonaMode(mode: string): void {
    this.currentPersonaMode = mode;
    const radio = document.querySelector(
      `input[name="persona-mode"][value="${mode}"]`,
    ) as HTMLInputElement | null;
    if (radio) {
      radio.checked = true;
    }
  }

  /** 收集表单中的配置 */
  collectConfigFromForm(): SpriteConfigForm {
    const modeRadio = document.querySelector(
      'input[name="persona-mode"]:checked',
    ) as HTMLInputElement | null;
    this.currentPersonaMode = modeRadio?.value ?? 'auto';

    return {
      silentMode: this.cfgSilent.checked,
      proactiveThreshold: parseInt(this.cfgThreshold.value, 10) || 3,
      proactiveCooldownMs: (parseInt(this.cfgCooldown.value, 10) || 5) * MS_PER_MINUTE,
      triggerIntervalMs: (parseInt(this.cfgInterval.value, 10) || 60) * MS_PER_MINUTE,
      fileWatcherEnabled: this.cfgWatcherEnabled.checked,
      fileWatcherPaths: this.cfgWatcherPaths.value
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
      fileWatcherDebounceMs: parseInt(this.cfgWatcherDebounce.value, 10) || 1000,
      defaultPersona: this.cfgDefaultPersona.value.trim(),
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
      resultEl.textContent = `✗ 失败：${result.error ?? '未知错误'}`;
      resultEl.style.color = 'var(--red)';
    }
  }

  /** 收集表单中的 LLM 配置（供测试连接复用） */
  getLlmConfigFromForm(): { provider: string; model: string; baseUrl: string; apiKey: string } {
    return {
      provider: this.cfgLlmProvider.value.trim(),
      model: this.cfgLlmModel.value.trim(),
      baseUrl: this.cfgLlmBaseUrl.value.trim(),
      apiKey: this.cfgLlmApiKey.value.trim(),
    };
  }

  // ─── 弹窗管理 ─────────────────────────────────────────

  /** 初始化弹窗事件监听（关闭按钮、背景点击） */
  private initModalListeners(): void {
    // 所有带 data-modal 属性的关闭按钮
    document.querySelectorAll<HTMLElement>('[data-modal]').forEach((btn) => {
      const modalId = btn.dataset.modal;
      if (modalId) {
        btn.addEventListener('click', () => this.hideModal(modalId));
      }
    });

    // 点击弹窗背景关闭
    document.querySelectorAll<HTMLElement>('.modal').forEach((modal) => {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) {
          modal.classList.add('hidden');
        }
      });
    });
  }

  /** 显示弹窗 */
  showModal(modalId: string): void {
    document.getElementById(modalId)?.classList.remove('hidden');
  }

  /** 隐藏弹窗 */
  hideModal(modalId: string): void {
    document.getElementById(modalId)?.classList.add('hidden');
  }
}
