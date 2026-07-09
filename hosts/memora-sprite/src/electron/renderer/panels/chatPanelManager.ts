/**
 * 聊天面板管理器 — 消息渲染、流式输出、工具调用卡片、思考阶段指示器独立子模块
 *
 * 职责：
 * - 管理聊天消息的 DOM 构建与渲染（appendMessage / buildMessageElement / appendMessages）
 * - 管理流式输出状态（startStreaming / updateStreamingMessage / finishStreamingMessage / stopAllStreaming）
 * - 管理工具调用卡片（showToolStart / updateToolResult）
 * - 管理思考阶段指示器（showThinkingPhase）
 * - 管理召回记忆展示（setMemoryRecall / createRecallContainer）
 * - 管理错误注入（injectErrorToStreamingMessages）
 * - 管理空状态引导（showEmptyState / hideEmptyState / initEmptyStateListeners / onSuggestionClick）
 * - 管理加载更多按钮（showLoadMore / hideLoadMore）
 * - 管理加载更早日期按钮（showLoadEarlierDay，方案 B 时间流）
 * - 管理消息区域清空（clearMessages）
 * - B1：对话区内联里程碑 banner（appendMilestoneBanner，对齐 demo v3）
 *
 * 设计原则：
 * - 遵循 SettingsPanelManager 的组合模式，UIManager 持有实例并委托
 * - 跨模块关注点（showToast / scrollToBottom / updateSendButton 等）通过 host 回调注入
 * - 自管理内部状态（流式消息映射、RAF 状态、回调引用），提供 cleanup() 清理
 */

import { clearElement, formatTimestamp } from '../helpers/domHelpers.js';
import { setIcon, setIconWithLabel } from '../helpers/icon.js';
import { renderMarkdown } from '../components/markdown.js';
import { reportError } from '../helpers/errorHelpers.js';
// 共享常量：时间换算与 Toast 时长，避免硬编码（对齐 sprite/constants.ts）
import { MS_PER_MINUTE, TOAST_SHORT_MS } from '../../../sprite/constants.js';
// 工具调用卡片 DOM 逻辑提取到独立 helper
import { showToolStart as renderToolStart, updateToolResult as updateToolCardResult } from '../helpers/toolCallCard.js';
// 消息装饰器（召回记忆 + 思考阶段 + 截断提示）提取到独立 helper
import {
  createRecallContainer as buildRecallContainer,
  renderMemoryRecall,
  showThinkingPhase as renderThinkingPhase,
  showTruncationNotice as renderTruncationNotice,
} from '../helpers/messageDecorations.js';
// 归档按钮逻辑（manual 模式专用）提取到独立 Manager
import { ArchiveButtonManager } from './archiveButtonManager.js';
import type { EventTracker } from '../helpers/eventTracker.js';
import type { ConfirmDialogOptions, Message, ToastType } from '../types.js';

// ─── Host 接口（跨模块关注点注入） ────────────────────────

/** 聊天面板管理器需要的宿主能力（跨模块关注点，由 UIManager 注入） */
export interface ChatPanelHost {
  /** 显示 toast 通知 */
  showToast(message: string, type?: ToastType, duration?: number): void;
  /** 自动滚动到底部（用户在底部附近时） */
  scrollToBottom(): void;
  /** 强制滚动到底部（无视用户位置） */
  forceScrollToBottom(): void;
  /** 更新发送/停止按钮状态 */
  updateSendButton(): void;
  /**
   * FOUNDATION-SEAL Phase 2：设置流式输出状态
   *
   * 替代原"友元类反模式"——ChatPanelManager 通过共享 state 引用直接修改 isStreaming。
   * 现改为通过 host 方法封装，UIManager 作为 state 的唯一持有者。
   *
   * @param streaming 是否正在流式输出
   */
  setStreaming(streaming: boolean): void;
  /**
   * FOUNDATION-SEAL Phase 2：查询流式输出状态
   *
   * @returns 当前是否正在流式输出
   */
  isStreaming(): boolean;
  /** 更新未读标记（完整窗口隐藏时，新精灵消息到达） */
  updateBadge(): void;
  /** 显示空状态引导（无消息时） */
  showEmptyState(): void;
  /**
   * 缺口 J：查询当前归档模式（manual 模式下显示"归档"按钮）
   *
   * @returns 当前 archiveMode（full / insights-only / manual）
   */
  getArchiveMode(): 'full' | 'insights-only' | 'manual';
  /**
   * 缺口 J：手动归档对话（profile facts + insight 一次性触发）
   *
   * @param input 用户输入
   * @param assistantContent 助手回复
   * @returns 归档总条目数（profile + insight）
   */
  archiveConversation(input: string, assistantContent: string): Promise<number>;
  /** 一键归档：批量归档当前会话 */
  archiveSession(date: string, session: string): Promise<number>;
  /** 获取当前会话 ID（格式：YYYY-MM-DD-sessionName） */
  getCurrentSessionId(): string;
  /** 隐藏空状态引导（有消息时） */
  hideEmptyState(): void;
  /** 未读计数 +1（完整窗口隐藏时，新精灵消息到达） */
  updateUnreadCount(): void;
  /**
   * 流式输出超时兜底触发时通知宿主联动主进程清理
   *
   * 渲染进程 30s 无进展判定卡死后，仅重置 UI 状态不够——主进程 AbortController 仍可能泄漏，
   * 导致下次发送被竞态保护拒绝。宿主通过此回调通知主进程 abort 当前对话，联动清理。
   */
  onStreamStuck(): void;
  /**
   * 重新生成上一条精灵消息（右键菜单"重新生成"触发）
   *
   * 通过宿主回调机制，由 renderer.ts 层实现实际的重新发送逻辑，
   * 避免 ChatPanelManager 直接访问 sessionController 或 electronAPI。
   *
   * @param userMessage 对应用户消息内容（从 DOM 中提取，用于重新发送）
   */
  regenerateLastMessage(userMessage: string): void;
  /**
   * 显示确认对话框（用于"忘记"等需二次确认的操作）
   *
   * @param options 确认弹窗选项（标题/消息/按钮文案/danger 标记）
   * @returns 用户是否点击确认
   */
  showConfirmDialog(options: ConfirmDialogOptions): Promise<boolean>;
}

// ─── 聊天面板管理器类 ─────────────────────────────────────

export class ChatPanelManager {
  // ─── DOM 引用（构造函数注入） ──────────────────────────

  /** 消息容器元素 */
  private messagesEl: HTMLElement;

  // ─── 共享状态引用（由 UIManager 传入，引用共享） ────────

  /** 活跃的流式消息映射（messageId → DOM 元素） */
  private streamingMessages: Map<string, HTMLElement>;

  // ─── 内部状态 ──────────────────────────────────────────

  /**
   * 流式渲染 RAF 节流状态
   * 避免高频 chunk 导致重复 Markdown 渲染，使用 requestAnimationFrame 合并
   */
  private _pendingRaF = false;
  /** requestAnimationFrame 句柄，cleanup 时取消挂起的回调 */
  private _rafHandle: number | null = null;
  /** 最新流式文本内容（RAF 回调中使用） */
  private _latestStreamText = '';
  /** 最新流式消息 ID（RAF 回调中使用） */
  private _latestStreamMessageId = '';

  // ─── 回调引用 ──────────────────────────────────────────

  /** 召回记忆点击回调（跳转记忆详情） */
  /** 召回记忆点击回调：点击精灵消息内的召回标签时触发，跳转到记忆详情（传完整记忆ID） */
  private memoryRecallClickCallback: ((memoryId: string) => void) | null = null;
  /** 示例问题点击回调（填入输入框并触发发送） */
  private suggestionClickCallback: ((text: string) => void) | null = null;
  /** 加载更多按钮回调（事件委托模式） */
  private loadMoreCallback: (() => void) | null = null;
  /** 加载更早日期按钮回调（事件委托模式） */
  private loadEarlierDayCallback: (() => void) | null = null;
  /** 错误重试回调（重新发送上一条用户消息） */
  private errorRetryCallback: (() => void) | null = null;

  // ─── Phase 1：消息分组与日期分隔 ──────────────────────────

  /** 同一角色消息分组时间窗口（毫秒），超过此间隔则开始新分组 */
  private static readonly GROUP_TIME_WINDOW_MS = 2 * MS_PER_MINUTE; // 2 分钟

  /** 上一条消息的角色（用于分组：同角色连续消息合并） */
  private lastMessageRole: string | null = null;

  /** 上一条消息的时间戳（毫秒，用于分组时间窗口判断） */
  private lastMessageTime = 0;

  /** 上一条消息的日期字符串（YYYY-MM-DD，用于插入日期分隔符） */
  private lastMessageDate = '';

  /** 中文星期映射 */
  private static readonly WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  // ─── 安全兜底 ──────────────────────────────────────────

  /**
   * 流式输出超时兜底定时器
   *
   * 当 isStreaming 卡在 true 时（SPRITE_STREAM_END 未到达），自动重置状态。
   * 每次收到新 chunk 时重置定时器，30 秒无新 chunk 则判定为卡死。
   */
  private _streamSafetyTimer: ReturnType<typeof setTimeout> | null = null;

  /** 90s 二级兜底定时器（30s 主定时器触发 onStreamStuck 后启动，防止主进程未响应时 UI 永久锁死） */
  private _streamSafetyFallbackTimer: ReturnType<typeof setTimeout> | null = null;

  // ─── 事件清理 ──────────────────────────────────────────

  /** 事件监听器跟踪器（统一管理事件监听器的注册与清理，避免内存泄漏） */
  private events: EventTracker;

  // ─── 子管理器 ──────────────────────────

  /**
   * 归档按钮管理器（manual 模式专用）
   *
   * 从 UIManager 拆分，统一管理"归档到记忆"按钮的渲染与点击处理。
   * 原先 _addArchiveButtonToMessage / _handleArchiveClick / _findPreviousUserMessage
   * 三个私有方法内联在 ChatPanelManager 中（约 130 行），拆分后 ChatPanelManager
   * 仅保留薄委托（maybeAddArchiveButton + handleClick）。
   * 通过 host 接口注入 getArchiveMode / archiveConversation / showToast 能力。
   */
  private archiveButtonManager: ArchiveButtonManager;

  // ─── 构造函数 ──────────────────────────────────────────

  /**
   * @param host 宿主能力注入（跨模块关注点回调，含 setStreaming/isStreaming 状态封装）
   * @param messagesEl 消息容器 DOM 元素
   * @param events 事件跟踪器（复用外部实例，共享生命周期）
   * @param streamingMessages 共享流式消息映射引用
   */
  constructor(
    private host: ChatPanelHost,
    messagesEl: HTMLElement,
    events: EventTracker,
    streamingMessages: Map<string, HTMLElement>,
  ) {
    this.messagesEl = messagesEl;
    this.events = events;
    this.streamingMessages = streamingMessages;

    // 归档按钮管理器（注入 host 能力，复用 ChatPanelHost 中已定义的归档契约）
    this.archiveButtonManager = new ArchiveButtonManager(this.host);

    // 事件委托：在 messagesEl 上注册统一的 click 监听器，
    // 通过 data-action 属性分发，替代动态元素各自的 addEventListener，
    // 统一纳入 EventTracker 管理，消除监听器泄漏风险
    this.events.addEventListener(this.messagesEl, 'click', (e: Event) => {
      const target = e.target as HTMLElement;
      // 复制按钮：data-action="copy" data-content="..."
      const copyBtn = target.closest<HTMLElement>('[data-action="copy"]');
      if (copyBtn) {
        const content = copyBtn.dataset.content ?? '';
        navigator.clipboard.writeText(content).then(
          () => {
            this.host.showToast('已复制到剪贴板', 'success', 1500);
            // 短暂内联反馈：切换为勾选图标，1s 后恢复复制图标
            setIcon(copyBtn, 'icon-check');
            copyBtn.classList.add('copied');
            window.setTimeout(() => {
              setIcon(copyBtn, 'icon-copy');
              copyBtn.classList.remove('copied');
            }, 1000);
          },
          () => this.host.showToast('复制失败，请手动选择文本复制', 'error'),
        );
        return;
      }
      // 代码块独立复制按钮：data-action="copy-code" data-content="..."
      // 与消息级复制按钮（data-action="copy"）区分，复用同一剪贴板逻辑
      const copyCodeBtn = target.closest<HTMLElement>('[data-action="copy-code"]');
      if (copyCodeBtn) {
        const content = copyCodeBtn.dataset.content ?? '';
        navigator.clipboard.writeText(content).then(
          () => {
            this.host.showToast('已复制代码', 'success', TOAST_SHORT_MS);
            // 短暂反馈：按钮文本切换为"已复制"，1.2s 后恢复
            const originalText = copyCodeBtn.textContent;
            copyCodeBtn.textContent = '已复制';
            copyCodeBtn.classList.add('copied');
            window.setTimeout(() => {
              copyCodeBtn.textContent = originalText;
              copyCodeBtn.classList.remove('copied');
            }, 1200);
          },
          () => this.host.showToast('复制失败，请手动选择代码复制', 'error'),
        );
        return;
      }
      // 截断提示关闭按钮：data-action="dismiss-truncation"
      // 用户已知晓截断后可主动关闭，关闭后本轮不再恢复（避免反复打扰）
      const dismissTruncation = target.closest<HTMLElement>('[data-action="dismiss-truncation"]');
      if (dismissTruncation) {
        const notice = dismissTruncation.closest<HTMLElement>('.truncation-notice');
        notice?.remove();
        return;
      }
      // 召回记忆折叠按钮：data-action="toggle-recall"
      const toggleRecall = target.closest<HTMLElement>('[data-action="toggle-recall"]');
      if (toggleRecall) {
        const container = toggleRecall.closest<HTMLElement>('.memory-recall-container');
        if (container) {
          container.classList.toggle('expanded');
          const isExpanded = container.classList.contains('expanded');
          toggleRecall.setAttribute('aria-expanded', isExpanded.toString());
        }
        return;
      }
      // 召回记忆项：data-action="recall" data-memory-id="..."
      const recallItem = target.closest<HTMLElement>('[data-action="recall"]');
      if (recallItem) {
        const memoryId = recallItem.dataset.memoryId ?? '';
        if (memoryId) {
          this.memoryRecallClickCallback?.(memoryId);
        }
        return;
      }
      // 工具调用折叠头：data-action="toggle-collapse"
      const collapseHeader = target.closest<HTMLElement>('[data-action="toggle-collapse"]');
      if (collapseHeader) {
        const card = collapseHeader.closest<HTMLElement>('.tool-call-card');
        card?.classList.toggle('collapsed');
        return;
      }
      // 加载更多按钮：data-action="load-more"
      const loadMoreBtn = target.closest<HTMLElement>('[data-action="load-more"]');
      if (loadMoreBtn && this.loadMoreCallback) {
        loadMoreBtn.setAttribute('disabled', '');
        loadMoreBtn.textContent = '加载中...';
        this.loadMoreCallback();
        return;
      }
      // 加载更早日期按钮：data-action="load-earlier-day"
      const loadEarlierBtn = target.closest<HTMLElement>('[data-action="load-earlier-day"]');
      if (loadEarlierBtn && this.loadEarlierDayCallback) {
        loadEarlierBtn.setAttribute('disabled', '');
        loadEarlierBtn.textContent = '加载中...';
        this.loadEarlierDayCallback();
        return;
      }
      // 错误重试按钮：data-action="retry"
      // 流式出错时在气泡内显示的重试按钮，触发 host 注入的 errorRetryCallback
      const retryBtn = target.closest<HTMLElement>('[data-action="retry"]');
      if (retryBtn) {
        // 禁用按钮防止重复点击
        retryBtn.setAttribute('disabled', '');
        retryBtn.textContent = '重试中...';
        // 回调执行后恢复按钮状态
        // errorRetryCallback 可能在 isStreaming() 检查时提前返回（toast 提示），
        // 此时按钮必须恢复，否则用户无法再次点击重试
        void (async () => {
          try {
            await this.errorRetryCallback?.();
          } catch {
            // 错误处理由 errorRetryCallback 内部负责（如 toast 提示），
            // 此处仅需恢复按钮状态，吞掉 rejection 避免 unhandled rejection
          } finally {
            retryBtn.removeAttribute('disabled');
            retryBtn.textContent = '重试';
          }
        })();
        return;
      }
      // B1：里程碑 banner 关闭按钮：data-action="close-milestone"
      // 点击后移除整个 .milestone-banner 元素（内联渲染，无需调用 ProactiveBanner.hideProactiveBanner）
      const milestoneCloseBtn = target.closest<HTMLElement>('[data-action="close-milestone"]');
      if (milestoneCloseBtn) {
        const banner = milestoneCloseBtn.closest<HTMLElement>('.milestone-banner');
        banner?.remove();
        return;
      }
      // 缺口 J：归档按钮 data-action="archive"（manual 模式下触发手动归档）
    // 委托到 ArchiveButtonManager.handleClick
    const archiveBtn = target.closest<HTMLElement>('[data-action="archive"]');
    if (archiveBtn) {
      void this.archiveButtonManager.handleClick(archiveBtn);
      return;
    }
  });

  // 右键菜单：消息气泡上右键触发上下文菜单
  this.events.addEventListener(this.messagesEl, 'contextmenu', (e: Event) => {
    const me = e as MouseEvent;
    const target = e.target as HTMLElement;
    const messageEl = target.closest<HTMLElement>('.message');
    if (!messageEl || messageEl.classList.contains('system')) {
      return;
    }

    e.preventDefault();

    const menu = document.getElementById('message-context-menu');
    if (!menu) return;

    const messageRole = messageEl.classList.contains('user') ? 'user' : 'assistant';
    const bubble = messageEl.querySelector('.message-bubble');
    const content = bubble?.textContent ?? '';
    const messageId = messageEl.dataset.messageId ?? '';

    menu.dataset.role = messageRole;
    menu.dataset.content = content;
    menu.dataset.messageId = messageId;

    const regenerateBtn = menu.querySelector<HTMLElement>('[data-action="regenerate"]');
    const forgetBtn = menu.querySelector<HTMLElement>('[data-action="forget"]');

    if (regenerateBtn) {
      regenerateBtn.setAttribute('aria-disabled', messageRole === 'user' ? 'true' : 'false');
    }
    if (forgetBtn) {
      forgetBtn.setAttribute('aria-disabled', messageId ? 'false' : 'true');
    }

    const rect = menu.getBoundingClientRect();
    let x = me.clientX;
    let y = me.clientY;

    if (x + rect.width > window.innerWidth) {
      x = window.innerWidth - rect.width - 8;
    }
    if (y + rect.height > window.innerHeight) {
      y = window.innerHeight - rect.height - 8;
    }

    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.classList.remove('hidden');
  });

  // 点击外部关闭右键菜单
  this.events.addEventListener(document, 'click', () => {
    const menu = document.getElementById('message-context-menu');
    if (menu && !menu.classList.contains('hidden')) {
      menu.classList.add('hidden');
    }
  });

  // 右键菜单项点击处理
  this.events.addEventListener(document, 'click', (e: Event) => {
    const target = e.target as HTMLElement;
    const menuItem = target.closest<HTMLElement>('.context-menu-item');
    if (!menuItem) return;

    const menu = document.getElementById('message-context-menu');
    if (!menu) return;

    const action = menuItem.dataset.action;
    const content = menu.dataset.content ?? '';
    const role = menu.dataset.role ?? '';
    const messageId = menu.dataset.messageId ?? '';

    menu.classList.add('hidden');

    switch (action) {
      case 'copy':
        navigator.clipboard.writeText(content).then(
          () => this.host.showToast('已复制到剪贴板', 'success', TOAST_SHORT_MS),
          () => this.host.showToast('复制失败', 'error'),
        );
        break;
      case 'regenerate':
        if (role === 'assistant') {
          const messageEl = messageId ? this.messagesEl.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`) : null;
          if (messageEl) {
            this._handleRegenerate(messageEl);
          }
        }
        break;
      case 'forget':
        if (messageId) {
          const messageEl = this.messagesEl.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`);
          if (messageEl) {
            // fire-and-forget：_handleForget 内部弹确认弹窗，无需等待
            void this._handleForget(messageId, messageEl);
          }
        }
        break;
    }
  });

    // 键盘可访问性：在 messagesEl 上注册 keydown 委托，
    // 处理 Enter/Space 键触发 data-action="recall" 和 data-action="toggle-collapse" 元素
    this.events.addEventListener(this.messagesEl, 'keydown', (e: Event) => {
      const ke = e as KeyboardEvent;
      // 仅处理 Enter 和 Space 键
      if (ke.key !== 'Enter' && ke.key !== ' ') return;
      const target = ke.target as HTMLElement;
      // 召回记忆项
      const recallItem = target.closest<HTMLElement>('[data-action="recall"]');
      if (recallItem) {
        ke.preventDefault(); // 防止 Space 滚动页面
        const memoryId = recallItem.dataset.memoryId ?? '';
        if (memoryId) {
          this.memoryRecallClickCallback?.(memoryId);
        }
        return;
      }
      // 召回记忆折叠按钮
      const toggleRecall = target.closest<HTMLElement>('[data-action="toggle-recall"]');
      if (toggleRecall) {
        ke.preventDefault(); // 防止 Space 滚动页面
        const container = toggleRecall.closest<HTMLElement>('.memory-recall-container');
        if (container) {
          container.classList.toggle('expanded');
          const isExpanded = container.classList.contains('expanded');
          toggleRecall.setAttribute('aria-expanded', isExpanded.toString());
        }
        return;
      }
      // 工具调用折叠头
      const collapseHeader = target.closest<HTMLElement>('[data-action="toggle-collapse"]');
      if (collapseHeader) {
        ke.preventDefault(); // 防止 Space 滚动页面
        const card = collapseHeader.closest<HTMLElement>('.tool-call-card');
        card?.classList.toggle('collapsed');
        return;
      }
    });
  }

  // ─── 生命周期 ──────────────────────────────────────────

  /** 清理所有事件监听器和挂起的 RAF 回调 */
  cleanup(): void {
    // 取消挂起的 requestAnimationFrame，防止 cleanup 后访问已销毁 DOM
    if (this._rafHandle !== null) {
      cancelAnimationFrame(this._rafHandle);
      this._rafHandle = null;
      this._pendingRaF = false;
    }
    // 清除超时兜底定时器
    this._clearStreamSafetyTimer();
    // 归档按钮管理器清理（无事件监听器，空实现，保持统一生命周期接口）
    this.archiveButtonManager.cleanup();
    this.events.cleanup();
  }

  /**
   * Phase 2：初始化回到底部浮动按钮
   *
   * 监听 messagesEl 的滚动事件，当用户向上滚动超过一屏时显示按钮。
   * 点击按钮平滑滚动回消息区底部。
   */
  initScrollToBottomButton(): void {
    const btn = document.getElementById('scroll-to-bottom-btn');
    if (!btn) return;

    // 滚动监听：距离底部超过一屏时显示按钮
    // CHAT-A05 优化：rAF 节流避免高频 scroll 事件触发强制 reflow
    let scrollRafPending = false;
    this.events.addEventListener(this.messagesEl, 'scroll', () => {
      if (scrollRafPending) return;
      scrollRafPending = true;
      requestAnimationFrame(() => {
        scrollRafPending = false;
        const distanceFromBottom = this.messagesEl.scrollHeight - this.messagesEl.scrollTop - this.messagesEl.clientHeight;
        const shouldShow = distanceFromBottom > this.messagesEl.clientHeight;
        btn.classList.toggle('hidden', !shouldShow);
      });
    }, { passive: true });

    // 点击回到底部
    this.events.addEventListener(btn, 'click', () => {
      this.messagesEl.scrollTo({ top: this.messagesEl.scrollHeight, behavior: 'smooth' });
    });
  }

  // ─── 消息渲染 ─────────────────────────────────────────

  /**
   * 格式化日期分隔符文本（Phase 1：微信/QQ 式时间流）
   *
   * 格式：YYYY年M月D日 周X
   */
  private formatDateSeparator(date: Date): string {
    const y = date.getFullYear();
    const m = date.getMonth() + 1;
    const d = date.getDate();
    const w = ChatPanelManager.WEEKDAY_NAMES[date.getDay()]!;
    return `${y}年${m}月${d}日 ${w}`;
  }

  /**
   * 在消息区插入日期分隔符（Phase 1：微信/QQ 式时间流）
   *
   * 当消息日期发生变化时，在消息之间插入日期标签。
   * 样式：居中灰色小字，上下有分隔线效果。
   */
  private insertDateSeparator(date: Date): void {
    const separator = document.createElement('div');
    separator.className = 'date-separator';
    separator.textContent = this.formatDateSeparator(date);
    this.messagesEl.appendChild(separator);
  }

  /**
   * 判断新消息是否应与上一条消息合并（Phase 1：消息分组）
   *
   * 合并条件：同一角色、时间间隔在 GROUP_TIME_WINDOW_MS 内。
   *
   * @param role 新消息角色
   * @param timestamp 新消息时间戳（ISO 字符串）
   */
  private shouldGroupWithPrevious(role: string, timestamp: string): boolean {
    if (this.lastMessageRole !== role) return false;
    const newTime = new Date(timestamp).getTime();
    if (this.lastMessageTime === 0) return false;
    return (newTime - this.lastMessageTime) < ChatPanelManager.GROUP_TIME_WINDOW_MS;
  }

  /**
   * 添加消息到界面
   *
   * 结构对齐设计契约 §6.2：
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
    this.host.hideEmptyState();

    // Phase 1：日期变化时插入日期分隔符
    // 防御无效时间戳导致 toISOString 抛 RangeError（降级为当前时间）
    const rawDate = new Date(message.timestamp ?? Date.now());
    const msgDate = isNaN(rawDate.getTime()) ? new Date() : rawDate;
    const dateStr = msgDate.toISOString().slice(0, 10); // YYYY-MM-DD
    if (this.lastMessageDate && dateStr !== this.lastMessageDate) {
      this.insertDateSeparator(msgDate);
    }

    // Phase 1：消息分组——同角色连续消息合并，隐藏头像
    const shouldGroup = message.role !== 'system' && this.shouldGroupWithPrevious(message.role, message.timestamp ?? new Date().toISOString());

    const el = this.buildMessageElement(message, shouldGroup);

    // 分组消息追加到上一个消息组内（而非独立消息元素）
    if (shouldGroup && message.role !== 'system') {
      const lastMessage = this.messagesEl.lastElementChild;
      if (lastMessage?.classList.contains('message-group')) {
        lastMessage.appendChild(el);
      } else {
        // 兜底：如果上一个不是 message-group，正常追加
        this.messagesEl.appendChild(el);
      }
    } else if (message.role !== 'system') {
      // 非分组消息：创建 message-group 容器包裹消息元素
      const group = document.createElement('div');
      group.className = 'message-group';
      group.appendChild(el);
      this.messagesEl.appendChild(group);
    } else {
      // 系统消息直接追加
      this.messagesEl.appendChild(el);
    }

    this.host.scrollToBottom();

    // 更新未读计数
    if (message.role === 'assistant' && document.hidden) {
      this.host.updateUnreadCount();
    }

    // Phase 1：更新分组状态
    if (message.role !== 'system') {
      this.lastMessageRole = message.role;
      this.lastMessageTime = new Date(message.timestamp ?? Date.now()).getTime();
      this.lastMessageDate = dateStr;
    }

    return el;
  }

  /**
   * B1：对话区内联里程碑 banner
   *
   * 对齐 demo v3 `.milestone-banner` 设计：里程碑事件不再走顶部 #proactive-banner，
   * 而是作为对话流中的独立元素内联渲染，与消息同流，记录"对话中达成的成就"。
   *
   * DOM 结构：
   *   <div class="milestone-banner">
   *     <svg class="milestone-icon">…奖杯图标…</svg>
   *     <span class="milestone-text">{text}</span>
   *     <button class="milestone-close" data-action="close-milestone">
   *       <svg class="icon">…关闭图标…</svg>
   *     </button>
   *   </div>
   *
   * 设计要点：
   * - align-self: center 使其居中显示（不与用户/精灵消息对齐到某一侧）
   * - 不参与消息分组（lastMessageRole 等状态不变）
   * - 关闭按钮通过事件委托（messagesEl click 监听器，data-action="close-milestone"）
   *
   * @param text 里程碑文本（如"达成里程碑：首次完成 UI 布局重构方案"）
   */
  appendMilestoneBanner(text: string): void {
    // 有内容时隐藏空状态引导
    this.host.hideEmptyState();

    // 构建里程碑 banner DOM
    const banner = document.createElement('div');
    banner.className = 'milestone-banner';
    banner.setAttribute('role', 'status');
    banner.setAttribute('aria-live', 'polite');

    // 奖杯图标（复用 #icon-trophy symbol，与顶部 banner 一致）
    banner.innerHTML = `
      <svg class="milestone-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><use href="#icon-trophy"/></svg>
      <span class="milestone-text"></span>
      <button class="milestone-close" data-action="close-milestone" type="button" aria-label="关闭里程碑提示">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><use href="#icon-close"/></svg>
      </button>
    `;
    // 使用 textContent 设置文本，避免 XSS
    const textEl = banner.querySelector<HTMLElement>('.milestone-text');
    if (textEl) textEl.textContent = text;

    // 追加到消息区末尾（不参与分组，作为独立元素）
    this.messagesEl.appendChild(banner);

    // 滚动到底部，确保用户看到新里程碑
    this.host.scrollToBottom();
  }

  /**
   * 构建消息 DOM 元素（纯函数，无副作用）
   *
   * 从 appendMessage 中提取 DOM 构建逻辑，供 appendMessages 批量插入复用。
   * 不处理 DOM 挂载、滚动、计数等副作用，仅返回完整元素。
   *
   * Phase 1：分组模式下省略头像（同角色连续消息合并显示）。
   *
   * @param message 消息对象
   * @param grouped 是否为分组消息（连续同角色，省略头像）
   * @returns 完整的消息 DOM 元素
   */
  private buildMessageElement(message: Message, grouped: boolean = false): HTMLElement {
    const el = document.createElement('div');
    el.className = `message ${message.role}${message.streaming ? ' streaming' : ''}${grouped ? ' grouped' : ''}`;
    if (message.messageId) {
      el.dataset.messageId = message.messageId;
    }

    if (message.role === 'system') {
      // 系统消息：简单文本，居中无头像
      el.textContent = message.content;
      return el;
    }

    // 用户/精灵消息：头像 + 气泡结构（分组模式下省略头像）
    if (!grouped) {
      const avatar = document.createElement('div');
      avatar.className = 'message-avatar';
      // 使用 SVG 图标替代 emoji，统一视觉风格
      const iconId = message.role === 'user' ? 'icon-person' : 'icon-fairy';
      setIcon(avatar, iconId);
      el.appendChild(avatar);
    }

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

    // 元信息行：复制按钮 + 时间戳同行显示
    const metaRow = document.createElement('div');
    metaRow.className = 'message-meta';

    // 用户/精灵消息均添加复制按钮（hover 时显示）
    // 原仅精灵消息有复制按钮，用户消息需手动选择文本，体验不一致
    if (!message.streaming) {
      const copyBtn = document.createElement('button');
      copyBtn.className = 'message-copy-btn';
      copyBtn.title = '复制';
      // 使用 SVG 图标替代 emoji
      setIcon(copyBtn, 'icon-copy');
      // 使用 data-action 属性替代直接 addEventListener，由构造函数中的事件委托统一处理
      copyBtn.dataset.action = 'copy';
      copyBtn.dataset.content = message.content;
      metaRow.appendChild(copyBtn);
    }

    // 时间戳
    const timestamp = message.timestamp ?? new Date().toISOString();
    const timeEl = document.createElement('div');
    timeEl.className = 'message-time';
    // 剪枝：复用 domHelpers.formatTimestamp
    timeEl.textContent = formatTimestamp(timestamp);
    metaRow.appendChild(timeEl);

    contentWrapper.appendChild(metaRow);

    el.appendChild(contentWrapper);

    // 召回记忆提示（仅精灵消息）
    const memoryRecall = message.memoryRecall;
    if (message.role === 'assistant' && memoryRecall && memoryRecall.length > 0) {
      // 委托到 messageDecorations helper 构建召回记忆容器
      const recallContainer = buildRecallContainer(memoryRecall);
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
   * 更新流式消息内容
   *
   * 性能优化策略（CHAT-A01）：
   * 流式期间使用 textContent 纯文本显示 + 光标，不调用 renderMarkdown。
   * 原因：每次 chunk 对累积完整文本做全量 Markdown 渲染是 O(n²) 复杂度，
   * 复杂问答（5000+字、N 个 chunk）会直接卡死 UI。
   * 流式结束后由 finishStreamingMessage 一次性渲染完整 Markdown。
   *
   * 保留 cursor 元素和 memory-recall 元素。
   */
  updateStreamingMessage(messageId: string, text: string): void {
    const el = this.streamingMessages.get(messageId);
    if (!el) return;

    // 每次收到新 chunk 重置超时兜底定时器（30 秒无新 chunk 则判定为卡死）
    this._resetStreamSafetyTimer();

    // 定位到气泡元素（assistant 消息结构：message > message-bubble）
    const bubble = el.querySelector('.message-bubble');
    if (!bubble) return;

    // 移除思考阶段指示器（text chunk 到达意味着思考阶段结束）
    const thinkingIndicator = bubble.querySelector('.thinking-phase');
    if (thinkingIndicator) {
      thinkingIndicator.remove();
    }

    // 存储最新文本，rAF 回调中统一执行纯文本更新
    this._latestStreamText = text;
    this._latestStreamMessageId = messageId;
    if (!this._pendingRaF) {
      this._pendingRaF = true;
      // 保存句柄，cleanup 时可取消挂起的回调
      this._rafHandle = requestAnimationFrame(() => {
        this._pendingRaF = false;
        this._rafHandle = null;
        // 重新定位气泡（可能已被 finishStreamingMessage 处理）
        const latestEl = this.streamingMessages.get(this._latestStreamMessageId);
        const latestBubble = latestEl?.querySelector('.message-bubble');
        if (!latestBubble) return;

        // 重新查询保留元素（rAF 回调中 DOM 可能已变化）
        const latestCursor = latestBubble.querySelector('.cursor');
        const latestRecall = latestBubble.querySelector('.memory-recall-container');
        const latestToolCalls = latestBubble.querySelectorAll('.tool-call-card');
        // 截断提示需跨 chunk 保留（用户需持续可见截断状态）
        const latestTruncation = latestBubble.querySelector('.truncation-notice');

        // 流式期间使用纯文本显示（O(1) 操作），不调用 renderMarkdown
        // 创建一个临时容器存放纯文本，避免破坏保留元素
        const textContainer = document.createElement('div');
        textContainer.className = 'streaming-text';
        textContainer.textContent = this._latestStreamText;
        // 白空格保留：代码块等格式在流式期间需要正确的换行显示
        textContainer.style.whiteSpace = 'pre-wrap';

        clearElement(latestBubble);
        // 截断提示在 bubble 顶部（文本之前）
        if (latestTruncation) latestBubble.appendChild(latestTruncation);
        latestBubble.appendChild(textContainer);

        // 重新追加保留元素（recall 和 tool-call 在文本后，cursor 在最后）
        if (latestRecall) latestBubble.appendChild(latestRecall);
        for (const tc of Array.from(latestToolCalls)) {
          latestBubble.appendChild(tc);
        }
        // 光标始终在文本末尾
        if (latestCursor) {
          textContainer.appendChild(latestCursor);
        }

        // DOM 更新完成后再滚动，确保滚动位置准确
        this.host.scrollToBottom();
      });
    }
  }

  /**
   * 完成流式消息
   *
   * 性能优化策略（CHAT-A02）：
   * 流式期间使用纯文本显示，结束时一次性渲染完整 Markdown。
   * 如果 rAF 还在 pending，取消它（避免纯文本和 Markdown 两次渲染竞争），
   * 然后同步执行一次完整 Markdown 渲染。
   *
   * 移除 streaming 类和光标元素，添加复制按钮。
   */
  finishStreamingMessage(messageId: string): void {
    const el = this.streamingMessages.get(messageId);
    if (!el) return;

    // 取消挂起的 rAF（无论是否 pending），避免纯文本渲染与最终 Markdown 渲染竞争
    if (this._rafHandle !== null) {
      cancelAnimationFrame(this._rafHandle);
      this._rafHandle = null;
      this._pendingRaF = false;
    }

    const bubble = el.querySelector('.message-bubble');
    if (bubble && this._latestStreamText) {
      try {
        // 保留 recall/tool-call/truncation 元素
        const flushRecall = bubble.querySelector('.memory-recall-container');
        const flushToolCalls = bubble.querySelectorAll('.tool-call-card');
        const flushTruncation = bubble.querySelector('.truncation-notice');

        // 一次性渲染完整 Markdown（从纯文本切换到格式化输出）
        clearElement(bubble);
        // 截断提示在 bubble 顶部（Markdown 之前）
        if (flushTruncation) bubble.appendChild(flushTruncation);
        bubble.appendChild(renderMarkdown(this._latestStreamText));

        // 重新追加保留元素
        if (flushRecall) bubble.appendChild(flushRecall);
        flushToolCalls.forEach((tc) => bubble.appendChild(tc));
      } catch (err) {
        // 渲染异常时不阻塞收尾流程，保留旧 DOM
        reportError('finishStreamingMessage', err);
      }
    }

    el.classList.remove('streaming');
    // 移除光标元素
    const cursor = el.querySelector('.cursor');
    if (cursor) cursor.remove();

    // 移除思考阶段指示器（如"正在归档"等），流式结束后不应继续显示
    const thinkingPhase = el.querySelector('.thinking-phase');
    if (thinkingPhase) thinkingPhase.remove();

    // 流式完成后添加复制按钮（复用缓存的文本，无需 cloneNode）
    this._addCopyButtonToMessage(el);

    this.streamingMessages.delete(messageId);

    // 所有流式消息都已完成时，重置 isStreaming 状态和按钮
    if (this.streamingMessages.size === 0) {
      this.host.setStreaming(false);
      // 清除超时兜底定时器（正常结束）
      this._clearStreamSafetyTimer();
      this.host.updateSendButton();
    }
  }

  /**
   * 为已完成的助手消息添加复制按钮
   *
   * 性能优化（CHAT-A04）：
   * 原实现使用 cloneNode(true) 深克隆整个气泡 + textContent 全树遍历提取文本，
   * 长消息（DOM 节点上千）各为 O(n)。
   * 改为优先复用 _latestStreamText（流式期间缓存的累积文本），避免 DOM 反向提取。
   *
   * @param el 消息 DOM 元素（.message 容器）
   */
  private _addCopyButtonToMessage(el: HTMLElement): void {
    const bubble = el.querySelector('.message-bubble');
    const contentWrapper = el.querySelector('.message-content');
    if (!bubble || !contentWrapper) return;

    // 避免重复添加（幂等保护）
    if (contentWrapper.querySelector('.message-copy-btn')) return;

    // 优先复用流式期间缓存的文本（O(1)），避免 cloneNode + textContent 的 O(n) 操作
    // 仅在缓存不可用时回退到 DOM 提取（如非流式消息的历史加载场景）
    let finalText: string;
    if (this._latestStreamText && this._latestStreamMessageId) {
      finalText = this._latestStreamText;
    } else {
      // 回退路径：从 DOM 提取纯文本（排除 UI 元信息元素）
      const clone = bubble.cloneNode(true);
      if (!(clone instanceof HTMLElement)) return;
      const recallInClone = clone.querySelector('.memory-recall');
      if (recallInClone) recallInClone.remove();
      const abortedInClone = clone.querySelector('.stream-aborted');
      if (abortedInClone) abortedInClone.remove();
      const errorInClone = clone.querySelector('.stream-error');
      if (errorInClone) errorInClone.remove();
      const thinkingInClone = clone.querySelector('.thinking-phase');
      if (thinkingInClone) thinkingInClone.remove();
      clone.querySelectorAll('.md-code-header').forEach((h) => h.remove());
      finalText = clone.textContent ?? '';
    }

    const copyBtn = document.createElement('button');
    copyBtn.className = 'message-copy-btn';
    copyBtn.title = '复制';
    // 使用 SVG 图标替代 emoji
    setIcon(copyBtn, 'icon-copy');
    // 使用 data-action 属性替代直接 addEventListener，由构造函数中的事件委托统一处理
    copyBtn.dataset.action = 'copy';
    copyBtn.dataset.content = finalText;

    // 查找或创建 metaRow，将复制按钮插入到时间戳之前
    let metaRow = contentWrapper.querySelector('.message-meta');
    const timeEl = contentWrapper.querySelector('.message-time');
    if (metaRow) {
      // metaRow 已存在，插入到时间戳之前
      if (timeEl) {
        metaRow.insertBefore(copyBtn, timeEl);
      } else {
        metaRow.appendChild(copyBtn);
      }
    } else if (timeEl && timeEl.parentNode) {
      // metaRow 不存在（旧结构），创建并包裹时间戳
      metaRow = document.createElement('div');
      metaRow.className = 'message-meta';
      metaRow.appendChild(copyBtn);
      timeEl.parentNode.insertBefore(metaRow, timeEl);
      metaRow.appendChild(timeEl);
    } else {
      contentWrapper.appendChild(copyBtn);
    }
  }

  /**
   * 处理重新生成操作（右键菜单"重新生成"触发）
   *
   * 找到当前精灵消息对应的上一条用户消息，删除精灵消息，
   * 然后用用户消息内容重新发送。支持任意位置的重新生成，
   * 而非只能重新生成最后一条。
   *
   * @param messageEl 被右键点击的精灵消息 DOM 元素
   */
  private _handleRegenerate(messageEl: HTMLElement): void {
    if (this.host.isStreaming()) {
      this.host.showToast('精灵正在回复中，请等待完成或点击停止', 'warning');
      return;
    }

    const userMessageEl = this._findPreviousUserMessage(messageEl);
    if (!userMessageEl) {
      this.host.showToast('找不到对应的用户消息', 'error');
      return;
    }

    const userBubble = userMessageEl.querySelector('.message-bubble');
    const userContent = userBubble?.textContent ?? '';
    if (!userContent.trim()) {
      this.host.showToast('用户消息内容为空', 'error');
      return;
    }

    messageEl.remove();
    this.host.regenerateLastMessage(userContent);
  }

  /**
   * 查找指定精灵消息的上一条用户消息（跨 message-group 遍历）
   *
   * Phase 1 消息分组后，user 和 assistant 分属不同 .message-group 容器，
   * previousElementSibling 仅在同一 group 内遍历无法跨 group。
   * 修复：先跳到父 group，再跨 group 向前遍历，在每个 group 内取最后一条 user。
   *
   * @param assistantMessageEl 精灵消息元素
   * @returns 上一条用户消息元素，找不到返回 null
   */
  private _findPreviousUserMessage(assistantMessageEl: HTMLElement): HTMLElement | null {
    // 跳到所属 group（或自身就是顶层消息时直接遍历）
    let searchFrom: HTMLElement = assistantMessageEl;
    const ownGroup = assistantMessageEl.closest('.message-group') as HTMLElement | null;
    if (ownGroup) searchFrom = ownGroup;

    let prev = searchFrom.previousElementSibling as HTMLElement | null;
    while (prev) {
      // 在 prev 中查找 user 消息（group 内可能有多条，取最后一条）
      const userMsgs = prev.querySelectorAll('.message.user');
      if (userMsgs.length > 0) {
        return userMsgs[userMsgs.length - 1] as HTMLElement;
      }
      // 兜底：prev 本身就是 .message.user（非 group 场景）
      if (prev.classList.contains('message') && prev.classList.contains('user')) {
        return prev;
      }
      prev = prev.previousElementSibling as HTMLElement | null;
    }
    return null;
  }

  /**
   * 查找指定用户消息的下一条精灵消息（跨 message-group 遍历）
   *
   * 与 _findPreviousUserMessage 对称，用于"忘记"操作删除 user 时找对应 assistant。
   *
   * @param userMessageEl 用户消息元素
   * @returns 下一条精灵消息元素，找不到返回 null
   */
  private _findNextAssistantMessage(userMessageEl: HTMLElement): HTMLElement | null {
    let searchFrom: HTMLElement = userMessageEl;
    const ownGroup = userMessageEl.closest('.message-group') as HTMLElement | null;
    if (ownGroup) searchFrom = ownGroup;

    let next = searchFrom.nextElementSibling as HTMLElement | null;
    while (next) {
      const assistantMsgs = next.querySelectorAll('.message.assistant');
      if (assistantMsgs.length > 0) {
        return assistantMsgs[0] as HTMLElement;
      }
      if (next.classList.contains('message') && next.classList.contains('assistant')) {
        return next;
      }
      next = next.nextElementSibling as HTMLElement | null;
    }
    return null;
  }

  /**
   * 删除消息元素并清理空的 message-group 容器
   *
   * 消息删除后 group 可能变空，需移除空容器避免 DOM 残留影响后续遍历。
   */
  private _removeMessageAndCleanupGroup(messageEl: HTMLElement): void {
    const group = messageEl.closest('.message-group');
    messageEl.remove();
    if (group && group.children.length === 0) {
      group.remove();
    }
  }

  /**
   * 处理忘记操作（右键菜单"忘记"触发）
   *
   * 从 UI 中移除消息对（用户消息 + 对应的精灵回复）。
   * 注意：这是 UI 层的软删除，刷新或重启后消息会重新出现，
   * 符合"忘记"的语义——暂时从视野中移除，而非永久删除。
   *
   * 操作前弹二次确认弹窗，避免误触；toast 文案明确告知"刷新后可恢复"，
   * 消除用户对数据丢失的焦虑。
   *
   * 如果右键的是精灵消息：删除精灵消息 + 上一条用户消息
   * 如果右键的是用户消息：删除用户消息 + 下一条精灵消息
   *
   * @param messageId 消息 ID（当前未使用，未来持久化时使用）
   * @param messageEl 被右键点击的消息 DOM 元素
   */
  private async _handleForget(_messageId: string, messageEl: HTMLElement): Promise<void> {
    // 二次确认：避免误触移除消息对（虽是软删除，但会同时移除用户输入+精灵回复）
    const confirmed = await this.host.showConfirmDialog({
      title: '忘记此条对话',
      message: '将这条对话（你的消息和精灵的回复）从当前视野中移除，刷新后可恢复。',
      confirmText: '忘记',
      cancelText: '取消',
      danger: true,
    });
    if (!confirmed) return;

    const isUser = messageEl.classList.contains('user');
    const isAssistant = messageEl.classList.contains('assistant');

    if (isUser) {
      // 用户消息：删除当前用户消息 + 下一条精灵消息（跨 group 查找）
      const nextAssistant = this._findNextAssistantMessage(messageEl);
      if (nextAssistant) {
        this._removeMessageAndCleanupGroup(nextAssistant);
      }
      this._removeMessageAndCleanupGroup(messageEl);
    } else if (isAssistant) {
      // 精灵消息：删除上一条用户消息 + 当前精灵消息（跨 group 查找）
      const prevUser = this._findPreviousUserMessage(messageEl);
      if (prevUser) {
        this._removeMessageAndCleanupGroup(prevUser);
      }
      this._removeMessageAndCleanupGroup(messageEl);
    }

    this.host.showToast('已从本次对话移除，刷新后可恢复', 'success', TOAST_SHORT_MS);
  }

  /**
   * 设置流式消息的召回记忆摘要
   *
   * 委托到 messageDecorations.ts 的 renderMemoryRecall 纯函数。
   * 本方法仅负责查找消息元素 + 重置安全定时器。
   *
   * Phase 3：同时更新思考阶段指示器，显示具体召回数量。
   *
   * @param messageId 流式消息 ID
   * @param memories 召回记忆摘要列表（name/score/source）
   */
  setMemoryRecall(messageId: string, memories: Array<{ id: string; name: string; score: number; source: string }>): void {
    const el = this.streamingMessages.get(messageId);
    if (!el) return;
    this._resetStreamSafetyTimer();

    const bubble = el.querySelector('.message-bubble');
    if (!bubble) return;

    // 委托到 messageDecorations helper 渲染召回记忆容器
    renderMemoryRecall(bubble, memories);

    // Phase 3：更新思考阶段指示器，显示具体召回数量
    if (memories.length > 0) {
      const indicator = bubble.querySelector('.thinking-phase') as HTMLDivElement | null;
      if (indicator) {
        setIconWithLabel(indicator, 'icon-gear', `正在回忆 ${memories.length} 条相关记忆...`);
      }
    }
  }

  // ─── 思考阶段指示器 ──────────────────────────────

  /**
   * 显示思考阶段指示器
   *
   * 委托到 messageDecorations.ts 的 renderThinkingPhase 纯函数。
   * 本方法仅负责查找消息元素 + 重置安全定时器。
   *
   * @param messageId 流式消息 ID
   * @param phase 思考阶段（recalling/processing/archiving）
   */
  showThinkingPhase(messageId: string, phase: string): void {
    const el = this.streamingMessages.get(messageId);
    if (!el) return;
    this._resetStreamSafetyTimer();

    const bubble = el.querySelector('.message-bubble');
    if (!bubble) return;

    // 委托到 messageDecorations helper 渲染思考阶段指示器
    renderThinkingPhase(bubble, phase);
  }

  // ─── 上下文截断提示 ────────────────────────────────

  /**
   * 在消息气泡顶部显示上下文截断提示条
   *
   * 委托到 messageDecorations.ts 的 renderTruncationNotice 纯函数。
   * 本方法仅负责查找消息元素 + 重置安全定时器。
   *
   * @param messageId 流式消息 ID
   * @param count 本次对话中发生的截断次数
   */
  showTruncationNotice(messageId: string, count: number): void {
    const el = this.streamingMessages.get(messageId);
    if (!el) return;
    this._resetStreamSafetyTimer();

    const bubble = el.querySelector('.message-bubble');
    if (!bubble) return;

    // 委托到 messageDecorations helper 渲染截断提示条
    renderTruncationNotice(bubble, count);
  }

  // ─── 工具调用卡片 ────────────────────────────────

  /**
   * 显示工具调用开始卡片
   *
   * 委托到 toolCallCard.ts 的 renderToolStart 纯函数。
   * 本方法仅负责查找消息元素 + 重置安全定时器。
   *
   * @param messageId 流式消息 ID
   * @param toolCallId 工具调用 ID
   * @param name 工具名称
   * @param args 工具参数（可选，JSON 字符串）
   */
  showToolStart(messageId: string, toolCallId: string, name: string, args?: string): void {
    const el = this.streamingMessages.get(messageId);
    if (!el) return;
    this._resetStreamSafetyTimer();

    const bubble = el.querySelector('.message-bubble');
    if (!bubble) return;

    // 委托到 toolCallCard helper 渲染卡片 DOM
    renderToolStart(bubble, toolCallId, name, args);
  }

  /**
   * 更新工具调用结果
   *
   * 委托到 toolCallCard.ts 的 updateToolCardResult 纯函数。
   * 本方法仅负责查找消息元素 + 重置安全定时器。
   *
   * @param messageId 流式消息 ID
   * @param toolCallId 工具调用 ID（用于精确定位对应卡片）
   * @param ok 是否成功
   * @param summary 结果摘要（可选）
   */
  updateToolResult(messageId: string, toolCallId: string, name: string, ok: boolean, summary?: string): void {
    const el = this.streamingMessages.get(messageId);
    if (!el) return;
    this._resetStreamSafetyTimer();

    const bubble = el.querySelector('.message-bubble');
    if (!bubble) return;

    // 委托到 toolCallCard helper 更新卡片状态
    updateToolCardResult(bubble, toolCallId, name, ok, summary);
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
    this.host.setStreaming(true);

    // 首字节前的"正在思考"占位
    // 从 SPRITE_STREAM_START 到首个 chunk 之间，用户原本只看到空气泡+光标，
    // 对齐大厂对话体验：立即显示"⚙️ 正在思考..."占位，消除空白期感知。
    // showThinkingPhase 会复用此元素更新为"正在回忆/处理/归档..."（查找或创建模式）；
    // updateStreamingMessage / injectErrorToStreamingMessages 会移除此元素。
    const bubble = el.querySelector('.message-bubble');
    if (bubble) {
      const placeholder = document.createElement('div');
      placeholder.className = 'thinking-phase';
      // 使用 SVG 图标替代 emoji
      setIconWithLabel(placeholder, 'icon-gear', '正在思考...');
      // 插入到光标之前（若存在），否则追加到气泡末尾
      const cursor = bubble.querySelector('.cursor');
      if (cursor) {
        bubble.insertBefore(placeholder, cursor);
      } else {
        bubble.appendChild(placeholder);
      }
    }

    // 启动超时兜底：30 秒无新 chunk 则自动重置（防止 SPRITE_STREAM_END 丢失导致 UI 卡死）
    this._resetStreamSafetyTimer();

    // 更新按钮为停止姿态
    this.host.updateSendButton();
  }

  /** 停止所有流式输出 */
  stopAllStreaming(): void {
    // 取消挂起的 rAF 回调，防止 stop 后 rAF 重新渲染 Markdown 覆盖已停止状态
    if (this._rafHandle !== null) {
      cancelAnimationFrame(this._rafHandle);
      this._rafHandle = null;
      this._pendingRaF = false;
    }

    for (const el of this.streamingMessages.values()) {
      el.classList.remove('streaming');
      // 移除光标元素，保留文本内容
      const cursor = el.querySelector('.cursor');
      if (cursor) {
        cursor.remove();
      }
    }
    this.streamingMessages.clear();
    this.host.setStreaming(false);
    // 清除超时兜底定时器（手动停止）
    this._clearStreamSafetyTimer();

    // 更新按钮为发送姿态
    this.host.updateSendButton();
  }

  /**
   * 清空对话区消息
   *
   * 会话切换/删除/重新加载时调用：清空当前对话区的所有消息显示，
   * 并重置流式状态。历史会话保留在 SessionStore 中，可通过日期导航找回。
   *
   * 使用 while + removeChild 模式（对齐 project_memory 工程约定）。
   */
  clearMessages(): void {
    // 只移除 .message 和 .message-group 和 .date-separator 和 .milestone-banner 元素，保留 chat-empty-state
    // B1：新增 .milestone-banner 选择器，避免清空会话时里程碑 banner 残留
    // 新增 .archive-session-btn 选择器，避免清空会话时归档按钮残留
    this.messagesEl.querySelectorAll('.message, .message-group, .date-separator, .milestone-banner, .archive-session-btn').forEach((msg) => msg.remove());
    // 移除加载更多按钮（切换会话时重置）
    this.hideLoadMore();
    this.streamingMessages.clear();
    this.host.setStreaming(false);
    this.host.updateSendButton();
    // 清空后重新显示空状态引导
    this.host.showEmptyState();
    // 清空后重置滚动状态，确保新消息能自动滚动
    this.host.forceScrollToBottom();
    // Phase 1：重置分组状态
    this.lastMessageRole = null;
    this.lastMessageTime = 0;
    this.lastMessageDate = '';
  }

  /**
   * 批量插入消息（DocumentFragment 优化）
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
    this.host.hideEmptyState();

    const fragment = document.createDocumentFragment();
    for (const msg of messages) {
      const el = this.buildMessageElement(msg);
      fragment.appendChild(el);
    }

    if (prepend) {
      // Phase 2：保存当前滚动位置，加载完成后恢复（避免跳到顶部）
      const prevScrollHeight = this.messagesEl.scrollHeight;
      const prevScrollTop = this.messagesEl.scrollTop;

      // 加载更多：插入到消息区顶部（在 load-more 按钮之后）
      const loadMore = this.messagesEl.querySelector('#load-more-container');
      if (loadMore) {
        loadMore.after(fragment);
      } else {
        this.messagesEl.insertBefore(fragment, this.messagesEl.firstChild);
      }

      // Phase 2：恢复滚动位置（新内容在顶部，向下偏移新增的高度）
      const newScrollHeight = this.messagesEl.scrollHeight;
      const addedHeight = newScrollHeight - prevScrollHeight;
      this.messagesEl.scrollTop = prevScrollTop + addedHeight;
    } else {
      // 初始加载：追加到消息区末尾
      this.messagesEl.appendChild(fragment);
    }

    // 非 prepend 模式才滚动到底部（prepend 模式已恢复滚动位置）
    if (!prepend) {
      this.host.forceScrollToBottom();
    }
  }

  /**
   * 显示"加载更多"按钮
   *
   * 在消息区顶部插入加载更多容器，包含按钮和剩余消息数提示。
   *
   * @param remaining 剩余消息数
   * @param onClick 点击回调
   */
  showLoadMore(remaining: number, onClick: () => void): void {
    // 移除旧按钮（避免重复）
    this.hideLoadMore();

    // 保存回调引用，由构造函数中的事件委托统一处理
    this.loadMoreCallback = onClick;

    const container = document.createElement('div');
    container.id = 'load-more-container';
    container.className = 'load-more-container';

    const btn = document.createElement('button');
    btn.className = 'load-more-btn';
    btn.textContent = `加载更多消息（剩余 ${remaining} 条）`;
    // 使用 data-action 属性替代直接 addEventListener，由构造函数中的事件委托统一处理
    btn.dataset.action = 'load-more';
    container.appendChild(btn);

    // 插入到消息区顶部
    this.messagesEl.insertBefore(container, this.messagesEl.firstChild);
  }

  /**
   * 隐藏"加载更多"按钮
   *
   * 方案 B：同时适用于"加载更多"和"加载更早的对话"按钮（共用 #load-more-container）。
   */
  hideLoadMore(): void {
    const existing = this.messagesEl.querySelector('#load-more-container');
    if (existing) existing.remove();
  }

  /**
   * 方案 B 显示"加载更早的对话"按钮
   *
   * 在消息区顶部插入加载更早日期的容器，点击后加载前一天的对话。
   * 与 showLoadMore 共用 #load-more-container（互斥显示），通过 data-action 区分回调。
   *
   * @param onClick 点击回调
   */
  showLoadEarlierDay(onClick: () => void): void {
    // 移除旧按钮（避免重复，同时清除可能存在的"加载更多"按钮）
    this.hideLoadMore();

    // 保存回调引用，由构造函数中的事件委托统一处理
    this.loadEarlierDayCallback = onClick;

    const container = document.createElement('div');
    container.id = 'load-more-container';
    container.className = 'load-more-container';

    const btn = document.createElement('button');
    btn.className = 'load-more-btn';
    btn.textContent = '加载更早的对话';
    // 使用 data-action 区分回调（与 load-more 区分）
    btn.dataset.action = 'load-earlier-day';
    container.appendChild(btn);

    // 插入到消息区顶部
    this.messagesEl.insertBefore(container, this.messagesEl.firstChild);
  }

  /**
   * 在流式消息气泡内嵌入中断标记
   *
   * 用户主动中断对话时，在原助手气泡底部嵌入中断标记，
   * 保留已生成的部分内容（对齐 Claude Code 的 partial response 保留理念）。
   * 替代旧的居中系统消息方案——居中消息与原气泡内容脱节，体验割裂。
   *
   * 完整清理流式状态（从 streamingMessages 删除、重置 isStreaming、
   * 更新发送按钮、清除安全定时器），与 finishStreamingMessage / injectErrorToStreamingMessages
   * 保持一致。原实现只移除了 streaming 类但未清理 Map 和状态，导致 isStreaming 泄漏、
   * 用户无法发送新消息、后续 SPRITE_STREAM_END 到达时 finishStreamingMessage 重复处理。
   *
   * 中断标记视觉上弱化（灰色 + 虚线边框），与错误指示器（红色）区分：
   * 中断是用户主动行为，不应表现为错误。
   *
   * @param messageId 流式消息 ID
   * @param reason 中断原因（如"用户手动停止"）
   */
  markStreamingAborted(messageId: string, reason: string): void {
    const el = this.streamingMessages.get(messageId);
    if (!el) return;

    // 取消挂起的 rAF 回调，防止中断后 rAF 重新渲染 Markdown 覆盖中断标记
    if (this._rafHandle !== null) {
      cancelAnimationFrame(this._rafHandle);
      this._rafHandle = null;
      this._pendingRaF = false;
    }

    const bubble = el.querySelector('.message-bubble');
    if (!bubble) return;

    // 移除光标和思考指示器（流式已结束）
    const cursor = bubble.querySelector('.cursor');
    if (cursor) cursor.remove();
    const thinkingIndicator = bubble.querySelector('.thinking-phase');
    if (thinkingIndicator) thinkingIndicator.remove();

    // 幂等保护：避免重复嵌入中断标记（aborted chunk 和 catch 块可能都触发）
    if (bubble.querySelector('.stream-aborted')) {
      // 已嵌入过，仍需确保流式状态被清理（之前的调用可能未完成清理）
      this.streamingMessages.delete(messageId);
      if (this.streamingMessages.size === 0) {
        this.host.setStreaming(false);
        this._clearStreamSafetyTimer();
        this.host.updateSendButton();
      }
      return;
    }

    // 嵌入中断标记到气泡底部
    const abortedDiv = document.createElement('div');
    abortedDiv.className = 'stream-aborted';
    // SVG 图标 + 文本（使用 createTextNode 避免 reason 中潜在特殊字符的 XSS 风险）
    setIcon(abortedDiv, 'icon-stop');
    abortedDiv.appendChild(document.createTextNode(` 已中断：${reason}（已保留上方生成内容）`));
    bubble.appendChild(abortedDiv);

    // 添加复制按钮，允许用户复制已生成的部分内容
    this._addCopyButtonToMessage(el);

    // 完整清理流式状态
    el.classList.remove('streaming');
    this.streamingMessages.delete(messageId);

    // 所有流式消息都已完成时，重置 isStreaming 状态和按钮
    if (this.streamingMessages.size === 0) {
      this.host.setStreaming(false);
      this._clearStreamSafetyTimer();
      this.host.updateSendButton();
    }

    // 中断标记嵌入后滚动到底部，确保用户看到中断状态
    this.host.scrollToBottom();
  }

  /**
   * 向流式消息气泡注入错误提示
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

    // 取消挂起的 rAF 回调，防止错误注入后 rAF 重新渲染 Markdown 覆盖错误提示
    if (this._rafHandle !== null) {
      cancelAnimationFrame(this._rafHandle);
      this._rafHandle = null;
      this._pendingRaF = false;
    }

    for (const [, el] of this.streamingMessages) {
      this.injectErrorToMessage(el, errorText);
    }

    // 清理流式消息映射和 UI 状态
    this.streamingMessages.clear();
    this.host.setStreaming(false);
    // 清除超时兜底定时器
    this._clearStreamSafetyTimer();
    this.host.updateSendButton();
    // 错误注入后滚动到底部，确保用户看到错误提示和重试按钮
    this.host.scrollToBottom();
  }

  /**
   * 向单个消息元素注入错误指示器（injectErrorToStreamingMessages 的辅助方法）
   *
   * 移除光标和思考指示器，在气泡底部添加错误提示和重试按钮。
   *
   * @param el 消息容器元素
   * @param errorText 错误提示文本
   */
  private injectErrorToMessage(el: HTMLElement, errorText: string): void {
    const bubble = el.querySelector('.message-bubble');
    if (!bubble) return;

    // 移除光标和思考指示器（流式已结束）
    const cursor = bubble.querySelector('.cursor');
    if (cursor) cursor.remove();
    const thinkingIndicator = bubble.querySelector('.thinking-phase');
    if (thinkingIndicator) thinkingIndicator.remove();

    // 添加错误指示器到气泡底部
    const errorDiv = document.createElement('div');
    errorDiv.className = 'stream-error';
    // SVG 图标 + 文本（使用 createTextNode 避免 errorText 中潜在特殊字符的 XSS 风险）
    setIcon(errorDiv, 'icon-warning');
    errorDiv.appendChild(document.createTextNode(` ${errorText}`));
    bubble.appendChild(errorDiv);

    // 错误气泡内的"重试"按钮
    const retryBtn = document.createElement('button');
    retryBtn.className = 'stream-error-retry';
    retryBtn.textContent = '重试';
    retryBtn.dataset.action = 'retry';
    bubble.appendChild(retryBtn);

    // 停止流式状态
    el.classList.remove('streaming');
  }

  // ─── 安全兜底定时器 ─────────────────────────────────────

  /**
   * 重置流式输出超时兜底定时器
   *
   * 每次收到新 chunk 时调用，30 秒无新 chunk 则自动重置 isStreaming。
   * 防止 SPRITE_STREAM_END 丢失导致 UI 永远卡在"回答中"状态。
   */
  private _resetStreamSafetyTimer(): void {
    this._clearStreamSafetyTimer();
    // 30s 是"无新 chunk 兜底"：通知主进程疑似卡死，主进程决定是否真中断
    // 修复 P1-B：原实现 onStreamStuck 后立即本地清场（streamingMessages.clear + isStreaming=false），
    // 导致主进程后续 chunk 与 END 因 Map 已空而静默早退（if (!el) return）——视觉冻结无日志
    // 现改为：30s 仅通知主进程，本地不清理状态，等待主进程的 END/ABORTED 驱动清理
    this._streamSafetyTimer = setTimeout(() => {
      if (this.host.isStreaming()) {
        this.host.onStreamStuck();
        // 90s 二级兜底（远大于主进程 60s）：若主进程未响应才本地清理
        // 防止主进程完全失联时 UI 永久锁死
        this._streamSafetyFallbackTimer = setTimeout(() => {
          if (!this.host.isStreaming()) return;
          // 清理 fallback timer 自身引用（已触发，置 null 让 _clearStreamSafetyTimer 不再尝试 clearTimeout）
          this._streamSafetyFallbackTimer = null;
          reportError('chatPanelManager', '90s 兜底：主进程未响应 onStreamStuck，本地清理');
          // 补齐 rAF 取消与 DOM 清理（原 30s 路径漏掉，导致 .streaming 类残留）
          if (this._rafHandle !== null) {
            cancelAnimationFrame(this._rafHandle);
            this._rafHandle = null;
            this._pendingRaF = false;
          }
          // 清理每条 streaming 消息的 DOM 状态 + 添加 copy 按钮（与 markStreamingAborted 一致）
          for (const el of this.streamingMessages.values()) {
            el.classList.remove('streaming');
            const cursor = el.querySelector('.cursor');
            if (cursor) cursor.remove();
            const phase = el.querySelector('.thinking-phase');
            if (phase) phase.remove();
            // 翠幕天罗 P2：补齐 copy 按钮，让用户能复制已生成的部分内容
            this._addCopyButtonToMessage(el);
          }
          // 注意：不在此处 delete streamingMessages，留给 markStreamingAborted 走完整嵌入流程
          this.streamingMessages.clear();
          this.host.setStreaming(false);
          this.host.updateSendButton();
        }, 60_000); // 60s 后触发 = 总等待 30+60=90s
      }
    }, 30_000);
  }

  /** 清除超时兜底定时器 */
  private _clearStreamSafetyTimer(): void {
    if (this._streamSafetyTimer !== null) {
      clearTimeout(this._streamSafetyTimer);
      this._streamSafetyTimer = null;
    }
    // 清理二级兜底定时器（修复 P1-B 引入的 fallback timer）
    if (this._streamSafetyFallbackTimer !== null) {
      clearTimeout(this._streamSafetyFallbackTimer);
      this._streamSafetyFallbackTimer = null;
    }
  }

  // ─── 空状态引导 ─────────────────────────────────────────

  /**
   * 初始化空状态引导的事件监听
   *
   * 点击示例问题按钮时，将问题文本填入输入框并触发发送。
   * 对齐 user_rules "主动可见"：示例问题始终可见，引导新用户快速开始对话。
   */
  initEmptyStateListeners(): void {
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

  // ─── 启动摘要横幅 ──────────

  /**
   * 在对话区顶部展示启动摘要横幅
   *
   * 聚合记忆/洞察/感知/衰减/健康数据，以横幅形态告知用户精灵当前状态。
   * 横幅位于 proactive-banner 下方、消息区上方，可关闭（本次会话内不再显示）。
   *
   * 布局：左侧精灵图标 + 中间内容区（标题 + 横向数据网格）+ 右侧关闭按钮
   *
   * @param summary 启动摘要数据（来自 Sprite.getStartupSummary()）
   */
  showStartupSummary(summary: {
    totalMemories: number;
    totalInsights: number;
    skillCount: number;
    decay: { runCount: number; totalDecayedCount: number } | null;
    perception: { warmth: number; rapportLevel: string; rapportDescription: string } | null;
    healthStatus: 'healthy' | 'warning' | 'critical' | null;
  }): void {
    // 空状态时摘要无意义（无数据可展示）
    if (summary.totalMemories === 0 && summary.totalInsights === 0) return;

    // 获取横幅元素
    const banner = document.getElementById('startup-banner');
    const gridEl = document.getElementById('startup-banner-grid');
    if (!banner || !gridEl) return;

    // 避免重复展示（本次会话仅展示一次）
    if (!banner.classList.contains('hidden')) return;

    // 清空网格内容
    gridEl.innerHTML = '';

    // 记忆总数
    gridEl.appendChild(this._buildSummaryItem('记忆', String(summary.totalMemories)));
    // 洞察总数
    gridEl.appendChild(this._buildSummaryItem('洞察', String(summary.totalInsights)));
    // 技能数
    gridEl.appendChild(this._buildSummaryItem('技能', `${summary.skillCount} 个`));
    // 衰减统计
    if (summary.decay && summary.decay.totalDecayedCount > 0) {
      gridEl.appendChild(this._buildSummaryItem('衰减', `${summary.decay.totalDecayedCount} 条`));
    } else {
      gridEl.appendChild(this._buildSummaryItem('衰减', '—'));
    }
    // 感知：温暖度
    if (summary.perception) {
      gridEl.appendChild(this._buildSummaryItem('温暖度', `${Math.round(summary.perception.warmth * 100)}%`));
      gridEl.appendChild(this._buildSummaryItem('默契度', summary.perception.rapportDescription));
    }
    // 健康状态
    if (summary.healthStatus) {
      const healthItem = this._buildSummaryItem('健康', '');
      const badge = document.createElement('span');
      badge.className = `startup-banner-badge ${summary.healthStatus}`;
      badge.textContent = summary.healthStatus === 'healthy' ? '良好' : summary.healthStatus === 'warning' ? '警告' : '严重';
      healthItem.appendChild(badge);
      gridEl.appendChild(healthItem);
    }

    // 绑定关闭按钮事件
    const closeBtn = banner.querySelector('.startup-banner-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        banner.classList.add('hidden');
      });
    }

    // 显示横幅（移除 hidden 类，触发 slideDown 动画）
    banner.classList.remove('hidden');
  }

  /**
   * 显示"一键归档当前对话"按钮
   *
   * 在消息区顶部插入归档按钮，仅在 manual 或 insights-only 模式下显示。
   * 点击后调用 agent.archiveSessionContent 批量归档当前会话的全部记忆。
   */
  showArchiveButton(): void {
    // 仅非 full 模式显示归档按钮
    const mode = this.host.getArchiveMode();
    if (mode === 'full') return;

    // 移除已存在的归档按钮（避免重复）
    this.messagesEl.querySelector('.archive-session-btn')?.remove();

    const sessionId = this.host.getCurrentSessionId();
    // 会话 ID 格式：YYYY-MM-DD-sessionName
    const lastDash = sessionId.lastIndexOf('-');
    const date = sessionId.slice(0, lastDash);
    const session = sessionId.slice(lastDash + 1);

    const btn = document.createElement('button');
    btn.className = 'archive-session-btn';
    btn.textContent = '归档当前对话';
    btn.title = '一键归档当前会话的全部记忆';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = '归档中...';
      try {
        const count = await this.host.archiveSession(date, session);
        btn.textContent = `已归档 ${count} 条记忆`;
        this.host.showToast(`已归档 ${count} 条记忆`, 'success');
        // 1.5 秒后移除按钮
        setTimeout(() => btn.remove(), 1500);
      } catch {
        btn.disabled = false;
        btn.textContent = '归档失败，重试';
      }
    });

    this.messagesEl.insertBefore(btn, this.messagesEl.firstChild);
  }

  /**
   * 构建启动摘要卡片中的单个数据项
   *
   * @param label 标签文本
   * @param value 值文本
   * @returns 数据项 DOM 元素
   */
  private _buildSummaryItem(label: string, value: string): HTMLElement {
    const item = document.createElement('div');
    item.className = 'startup-banner-item';
    item.innerHTML = `<span>${label}</span><span class="startup-banner-value">${value}</span>`;
    return item;
  }

  // ─── 回调注册 ───────────────────────────────────────────

  /** 注册示例问题点击回调 */
  onSuggestionClick(callback: (text: string) => void): void {
    this.suggestionClickCallback = callback;
  }

  /** 注册召回记忆点击回调（跳转记忆详情，传完整记忆ID） */
  setMemoryRecallClickCallback(cb: (memoryId: string) => void): void {
    this.memoryRecallClickCallback = cb;
  }

  /**
   * 注册错误重试回调
   *
   * 流式出错时，气泡内的"重试"按钮被点击后触发此回调。
   * 由 renderer.ts 注入 retryLastUserInput（重新发送上一条用户消息）。
   * 此为唯一重试通道（Toast 不再携带重试按钮）。
   *
   * @param cb 重试回调（无参数，由宿主自行获取 lastUserInput）
   */
  onErrorRetry(cb: () => void): void {
    this.errorRetryCallback = cb;
  }
}