/**
 * 输入区域管理器
 *
 * 从 UIManager 拆分，统一管理输入区域的 UI 联动。
 *
 * 职责：
 * - 输入框键盘事件处理（Enter 发送/停止、Esc 清空/失焦）
 * - 输入框内容变化处理（自适应高度 + 发送按钮视觉反馈）
 * - 发送按钮点击处理（触发发送回调）
 * - 输入区 ResizeObserver（动态更新 --input-area-height CSS 变量）
 * - 输入清理 + 长度限制
 *
 * 设计原则：
 * - 依赖注入：通过 InputAreaHost 接口注入 UIManager 的状态查询和回调，
 *   与 ChatPanelManager/ClipboardManager 同模式
 * - 自包含 EventTracker，init() 绑定事件，cleanup() 统一清理
 * - 不持有流式状态，通过 host.isStreaming() 查询
 * - Agent 就绪/空内容守卫保留在 UIManager.emitSendMessage 内部，
 *   InputAreaManager 仅负责 UI 联动，不重复守卫逻辑
 */

import type { EventTracker } from '../helpers/eventTracker.js';

/**
 * 输入区域宿主接口
 *
 * UIManager 实现此接口，向 InputAreaManager 提供状态查询和回调。
 * 与 ChatPanelHost/MemoryPanelHost 同模式。
 */
export interface InputAreaHost {
  /** 查询当前是否正在流式输出（决定 Enter 键触发发送还是停止） */
  isStreaming(): boolean;
  /** 触发发送消息（由输入框 Enter 或发送按钮点击触发，含 Agent 就绪/空内容守卫） */
  emitSendMessage(): void;
  /** 触发停止流式输出（由输入框 Enter 触发） */
  emitStopMessage(): void;
}

/** 输入内容最大长度（超出部分截断，防止超长输入撑爆 LLM 上下文） */
const MAX_INPUT_LENGTH = 10000;
/** 输入框自适应高度上限（像素，超出后滚动而非继续撑高） */
const MAX_INPUT_HEIGHT = 120;

/**
 * 输入区域管理器类
 *
 * 职责：输入框事件 + 发送按钮状态 + ResizeObserver + 输入清理
 * 依赖：InputAreaHost（状态查询 + 回调）+ EventTracker（事件清理）
 * 生命周期：init() 绑定事件 + 启动 observer，cleanup() 清理
 */
export class InputAreaManager {
  /** 输入区 ResizeObserver（监听 #input-area 高度变化），null 表示元素缺失或环境不支持 */
  private resizeObserver: ResizeObserver | null = null;

  /** Provider 选择器 DOM 元素 */
  private providerSelector: HTMLElement | null = null;
  private providerNameEl: HTMLElement | null = null;
  private providerDropdown: HTMLElement | null = null;
  /** Token 用量指示器 DOM 引用 */
  private tokenUsageEl: HTMLElement | null = null;
  private tokenUsageText: HTMLElement | null = null;
  private tokenUsageFill: HTMLElement | null = null;
  /** 上下文窗口大小（token 数，不同模型不同，默认 32K） */
  private static readonly DEFAULT_CONTEXT_TOKENS = 32768;

  /**
   * 构造函数：注入 DOM 元素 + 事件跟踪器 + 宿主接口
   *
   * @param inputEl 输入框元素（textarea）
   * @param btnSend 发送按钮元素
   * @param events 事件跟踪器（独立实例，cleanup 时统一清理）
   * @param host 宿主接口（提供流式状态查询 + 发送/停止回调）
   */
  constructor(
    private readonly inputEl: HTMLTextAreaElement,
    private readonly btnSend: HTMLButtonElement,
    private readonly events: EventTracker,
    private readonly host: InputAreaHost,
  ) {
    // 延迟获取 Provider 选择器 DOM（可能尚未渲染到 DOM 中）
    this.providerSelector = document.getElementById('provider-selector');
    this.providerNameEl = document.getElementById('provider-name');
    this.providerDropdown = document.getElementById('provider-dropdown');
    // Token 用量指示器
    this.tokenUsageEl = document.getElementById('token-usage');
    this.tokenUsageText = document.getElementById('token-usage-text');
    this.tokenUsageFill = document.getElementById('token-usage-fill');
  }

  /**
   * 初始化：绑定事件 + 启动 ResizeObserver
   *
   * 在 UIManager 构造函数末尾调用（initEventListeners 之后）。
   */
  init(): void {
    // 输入框事件
    this.events.addEventListener(this.inputEl, 'keydown', this.handleKeydown.bind(this));
    this.events.addEventListener(this.inputEl, 'input', this.handleInputChange.bind(this));

    // 初始化输入框高度和发送按钮状态（构造时 textarea 可能已有默认值）
    this.handleInputChange();

    // 发送按钮点击（停止按钮由 UIManager 直接绑定 emitStopMessage，不在此管理）
    this.events.addEventListener(this.btnSend, 'click', this.handleClick.bind(this));

    // 启动输入区 ResizeObserver
    this.initResizeObserver();

    // 初始化 Provider 选择器
    this.initProviderSelector();
  }

  /**
   * 清理：断开 ResizeObserver + 清理事件监听器
   *
   * 由 UIManager.cleanup() 调用。
   */
  cleanup(): void {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    this.events.cleanup();
  }

  /**
   * 获取输入框值（已 trim + 长度限制）
   *
   * 不清空输入框，仅读取和清理。
   * 由 UIManager.getUserInput() 调用（清空逻辑由调用方处理）。
   *
   * @returns 清理后的文本，空输入返回空字符串
   */
  getValue(): string {
    const trimmed = this.inputEl.value.trim();
    return trimmed.length > MAX_INPUT_LENGTH
      ? trimmed.substring(0, MAX_INPUT_LENGTH)
      : trimmed;
  }

  /**
   * 清空输入框并重置高度/按钮状态
   *
   * 由 UIManager.getUserInput() 在获取输入后调用。
   */
  clearInput(): void {
    this.inputEl.value = '';
    this.handleInputChange();
  }

  /**
   * 预填输入框内容
   *
   * 由 UIManager.prefillChatInput() 调用，用于"在对话中讨论"功能。
   * 设置值后触发 input 事件，让 handleInputChange 调整高度。
   *
   * @param text 预填的文本内容
   */
  setValue(text: string): void {
    this.inputEl.value = text;
    // 触发 input 事件，让 handleInputChange 感知内容变化（调整高度 + 更新按钮状态）
    this.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /**
   * 刷新发送按钮状态（空闲态下根据输入内容更新 disabled/empty 类）
   *
   * 由 UIManager.updateSendButton() 在流式态 → 空闲态切换时调用。
   * 流式态下此方法无效（由 host.isStreaming() 守卫）。
   */
  refreshSendButtonState(): void {
    if (this.host.isStreaming()) return; // 流式态由 UIManager.updateSendButton 处理
    const hasContent = this.inputEl.value.trim().length > 0;
    this.btnSend.disabled = !hasContent;
    this.btnSend.classList.toggle('empty', !hasContent);
  }

  /**
   * 输入框键盘事件处理
   *
   * - Enter（非 Shift）：发送消息或停止流式输出
   * - Escape：清空输入（有内容时）或失焦（无内容时），交互参考终端/聊天应用惯例
   */
  private handleKeydown(e: Event): void {
    if (!(e instanceof KeyboardEvent)) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      // B2：流式态时 Enter 触发停止（键盘快捷键，对齐 #btn-stop 鼠标点击），空闲态触发发送
      if (this.host.isStreaming()) {
        this.host.emitStopMessage();
      } else {
        this.host.emitSendMessage();
      }
    } else if (e.key === 'Escape') {
      // Esc：有内容则清空，无内容则失焦
      if (this.inputEl.value.trim().length > 0) {
        this.inputEl.value = '';
        this.handleInputChange();
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
    this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, MAX_INPUT_HEIGHT) + 'px';
    this.refreshSendButtonState();
  }

  /**
   * 发送按钮点击处理
   *
   * 直接触发发送回调（Agent 就绪/空内容守卫在 UIManager.emitSendMessage 内部）。
   */
  private handleClick(): void {
    this.host.emitSendMessage();
  }

  /**
   * 初始化输入区 ResizeObserver
   *
   * 监听 #input-area 高度变化，动态更新 :root 的 --input-area-height CSS 变量。
   * 替代原静态 140px，避免 textarea 多行撑高时遮挡最后一条消息。
   *
   * 设计要点：
   * - 使用 ResizeObserver 而非 input 事件，覆盖所有高度变化来源（窗口缩放、内容变化、主题切换）
   * - 写入 documentElement.style 确保所有引用 --input-area-height 的样式（chat.css:958, chat.css:1867）同步更新
   * - 元素缺失或环境不支持（jsdom 测试）时静默降级（保持原静态 140px 回退值）
   */
  private initResizeObserver(): void {
    const inputArea = document.getElementById('input-area');
    if (!inputArea) return;
    // 防御性检查：ResizeObserver 是浏览器 API，jsdom 测试环境不提供
    // 缺失时静默降级（保持原静态 140px 回退值），不阻断初始化
    if (typeof ResizeObserver === 'undefined') return;
    this.resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        // 获取输入区实际高度（含 padding + border）
        const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
        if (height > 0) {
          // 更新 CSS 变量，chat.css 中 padding-bottom 和浮动按钮 bottom 都引用此变量
          document.documentElement.style.setProperty('--input-area-height', `${Math.ceil(height)}px`);
        }
      }
    });
    this.resizeObserver.observe(inputArea);
  }

  // ─── Provider 选择器 ────────────────────────────────────

  /**
   * 初始化 Provider 选择器
   *
   * 加载 Provider 列表，渲染下拉菜单，绑定切换事件。
   */
  private async initProviderSelector(): Promise<void> {
    if (!this.providerSelector || !this.providerDropdown) return;

    // 点击 provider 按钮切换下拉
    this.events.addEventListener(this.providerSelector, 'click', (e) => {
      e.stopPropagation();
      this.providerDropdown!.classList.toggle('hidden');
    });

    // 点击页面其他区域关闭下拉
    this.events.addEventListener(document, 'click', () => {
      this.providerDropdown?.classList.add('hidden');
    });

    // 加载并渲染 Provider 列表
    await this.loadProviderSelector();
  }

  /**
   * 加载 Provider 选择器内容
   *
   * 从主进程获取 Provider 列表，更新当前显示名称和下拉菜单。
   */
  async loadProviderSelector(): Promise<void> {
    if (!this.providerNameEl || !this.providerDropdown) return;

    try {
      const data = await window.electronAPI.listLlmProviders();
      const { active, providers } = data;

      if (providers.length === 0) {
        this.providerNameEl.textContent = '未配置';
        this.providerSelector?.classList.remove('configured');
        this.providerDropdown.innerHTML = '<div class="dropdown-item" style="color:var(--text-3);font-size:var(--font-xs)">请在设置中添加 API</div>';
        return;
      }

      // 更新当前显示名称
      const activeProvider = providers.find((p) => p.key === active) ?? providers[0]!;
      this.providerNameEl.textContent = activeProvider.name;
      this.providerSelector?.classList.add('configured');

      // 渲染下拉菜单
      this.providerDropdown.innerHTML = providers
        .map((p) => {
          const isActive = p.key === active;
          return `<div class="dropdown-item${isActive ? ' active' : ''}" data-provider-key="${p.key}">${p.name}</div>`;
        })
        .join('');

      // 绑定下拉项点击事件
      this.providerDropdown.querySelectorAll('.dropdown-item').forEach((item) => {
        this.events.addEventListener(item as HTMLElement, 'click', async () => {
          const key = (item as HTMLElement).dataset.providerKey;
          if (key) {
            await window.electronAPI.setActiveLlmProvider(key);
            this.providerDropdown!.classList.add('hidden');
            await this.loadProviderSelector();
          }
        });
      });
    } catch {
      this.providerNameEl.textContent = '加载失败';
    }
  }

  /**
   * 刷新 Token 用量指示器
   *
   * 消费内核 agent.getMetrics()（通过 getDashboard IPC），
   * 显示当前对话累计输入/输出 token 数 + 进度条。
   * 流式结束后由外部调用（renderer.ts 的 SPRITE_STREAM_END 处理）。
   */
  async refreshTokenUsage(): Promise<void> {
    if (!this.tokenUsageText || !this.tokenUsageFill) return;

    try {
      const dashboard = await window.electronAPI.getDashboard();
      const metrics = dashboard?.metrics;
      if (!metrics?.llm) {
        this.tokenUsageText.textContent = '--';
        this.tokenUsageFill.style.width = '0%';
        return;
      }

      const { totalInputTokens, totalOutputTokens } = metrics.llm;
      const total = totalInputTokens + totalOutputTokens;

      // 格式化数字（< 1K 显示原值，>= 1K 显示 X.XK）
      const formatTokens = (n: number): string => {
        if (n < 1000) return String(n);
        return `${(n / 1000).toFixed(1)}K`;
      };

      this.tokenUsageText.textContent = `${formatTokens(total)} tokens`;

      // 进度条：基于上下文窗口大小计算填充比例（截断到 100%）
      const ratio = Math.min(total / InputAreaManager.DEFAULT_CONTEXT_TOKENS, 1);
      this.tokenUsageFill.style.width = `${Math.round(ratio * 100)}%`;

      // 缺口 C：hover 时展示输入/输出 token 分解（CSS ::after tooltip，与侧边栏风格统一）
      const windowK = formatTokens(InputAreaManager.DEFAULT_CONTEXT_TOKENS);
      if (this.tokenUsageEl) {
        this.tokenUsageEl.setAttribute(
          'data-tooltip',
          `输入 ${formatTokens(totalInputTokens)} / 输出 ${formatTokens(totalOutputTokens)} / 窗口 ${windowK}`
        );
      }
    } catch {
      this.tokenUsageText.textContent = '--';
    }
  }
}
