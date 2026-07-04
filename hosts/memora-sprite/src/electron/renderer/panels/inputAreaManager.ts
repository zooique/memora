/**
 * 输入区域管理器
 *
 * QC-R2-05：从 UIManager 拆分（约 150 行），统一管理输入区域的 UI 联动。
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
  ) {}

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
}
