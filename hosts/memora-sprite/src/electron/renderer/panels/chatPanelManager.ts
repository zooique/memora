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
 *
 * 提取自 ui.ts（P2-008：ui.ts 体积过大拆分），减少约 500 行。
 */

import { clearElement, formatTimestamp } from '../helpers/domHelpers.js';
import { renderMarkdown } from '../components/markdown.js';
import { reportError } from '../helpers/errorHelpers.js';
// 共享常量：时间换算与 Toast 时长，避免硬编码（对齐 sprite/constants.ts）
import { MS_PER_MINUTE, TOAST_SHORT_MS } from '../../../sprite/constants.js';
// QC-R2-12：工具调用卡片 DOM 逻辑提取到独立 helper
import { showToolStart as renderToolStart, updateToolResult as updateToolCardResult } from '../helpers/toolCallCard.js';
// QC-R2-12：消息装饰器（召回记忆 + 思考阶段 + 截断提示）提取到独立 helper
import {
  createRecallContainer as buildRecallContainer,
  renderMemoryRecall,
  showThinkingPhase as renderThinkingPhase,
  showTruncationNotice as renderTruncationNotice,
} from '../helpers/messageDecorations.js';
import type { EventTracker } from '../helpers/eventTracker.js';
import type { Message, ToastType } from '../types.js';

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
  /** 非系统消息计数 +1（appendMessage 中调用） */
  updateMessageCount(): void;
  /**
   * UX-FD-07 方案 B 直接设置消息计数（不累加）
   *
   * 用于会话历史加载后，根据加载的会话是否当天 main 设置今日消息数。
   */
  setMessageCount(count: number): void;
  /** 刷新消息计数显示 */
  refreshMessageCountDisplay(): void;
  /** 重置消息计数为 0（clearMessages 中调用） */
  resetMessageCount(): void;
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
   * UX-PP-02 流式渲染 RAF 节流状态
   * 避免高频 chunk 导致重复 Markdown 渲染，使用 requestAnimationFrame 合并
   */
  private _pendingRaF = false;
  /** P1-RAF-01 requestAnimationFrame 句柄，cleanup 时取消挂起的回调 */
  private _rafHandle: number | null = null;
  /** UX-PP-02 最新流式文本内容（RAF 回调中使用） */
  private _latestStreamText = '';
  /** UX-PP-02 最新流式消息 ID（RAF 回调中使用） */
  private _latestStreamMessageId = '';

  // ─── 回调引用 ──────────────────────────────────────────

  /** 召回记忆点击回调（跳转记忆详情） */
  /** 召回记忆点击回调：点击精灵消息内的召回标签时触发，跳转到记忆详情（传完整记忆ID） */
  private memoryRecallClickCallback: ((memoryId: string) => void) | null = null;
  /** 示例问题点击回调（填入输入框并触发发送） */
  private suggestionClickCallback: ((text: string) => void) | null = null;
  /** QC-11 加载更多按钮回调（事件委托模式） */
  private loadMoreCallback: (() => void) | null = null;
  /** UX-FD-07 方案 B 加载更早日期按钮回调（事件委托模式） */
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

    // QC-11 事件委托：在 messagesEl 上注册统一的 click 监听器，
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
            copyBtn.innerHTML = '<svg class="icon"><use href="#icon-check"/></svg>';
            copyBtn.classList.add('copied');
            window.setTimeout(() => {
              copyBtn.innerHTML = '<svg class="icon"><use href="#icon-copy"/></svg>';
              copyBtn.classList.remove('copied');
            }, 1000);
          },
          () => this.host.showToast('复制失败，请手动选择文本复制', 'error'),
        );
        return;
      }
      // UX-PP-11 代码块独立复制按钮：data-action="copy-code" data-content="..."
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
      // UX-FD-07 方案 B 加载更早日期按钮：data-action="load-earlier-day"
      const loadEarlierBtn = target.closest<HTMLElement>('[data-action="load-earlier-day"]');
      if (loadEarlierBtn && this.loadEarlierDayCallback) {
        loadEarlierBtn.setAttribute('disabled', '');
        loadEarlierBtn.textContent = '加载中...';
        this.loadEarlierDayCallback();
        return;
      }
      // UX-PP-05 错误重试按钮：data-action="retry"
      // 流式出错时在气泡内显示的重试按钮，触发 host 注入的 errorRetryCallback
      const retryBtn = target.closest<HTMLElement>('[data-action="retry"]');
      if (retryBtn) {
        // 禁用按钮防止重复点击
        retryBtn.setAttribute('disabled', '');
        retryBtn.textContent = '重试中...';
        // FD-FIX-RETRY-RECOVER：回调执行后恢复按钮状态
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
      const archiveBtn = target.closest<HTMLElement>('[data-action="archive"]');
      if (archiveBtn) {
        void this._handleArchiveClick(archiveBtn);
        return;
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
    // P1-RAF-01 取消挂起的 requestAnimationFrame，防止 cleanup 后访问已销毁 DOM
    if (this._rafHandle !== null) {
      cancelAnimationFrame(this._rafHandle);
      this._rafHandle = null;
      this._pendingRaF = false;
    }
    // 清除超时兜底定时器
    this._clearStreamSafetyTimer();
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
    this.events.addEventListener(this.messagesEl, 'scroll', () => {
      const distanceFromBottom = this.messagesEl.scrollHeight - this.messagesEl.scrollTop - this.messagesEl.clientHeight;
      const shouldShow = distanceFromBottom > this.messagesEl.clientHeight;
      btn.classList.toggle('hidden', !shouldShow);
    });

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

    // 更新消息计数（非系统消息）
    if (message.role !== 'system') {
      this.host.updateMessageCount();
    }

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
   * - 不计入消息计数（updateMessageCount 不调用）
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
   * UX-FD-07 构建消息 DOM 元素（纯函数，无副作用）
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

    if (message.role === 'system') {
      // 系统消息：简单文本，居中无头像
      el.textContent = message.content;
      return el;
    }

    // 用户/精灵消息：头像 + 气泡结构（分组模式下省略头像）
    if (!grouped) {
      const avatar = document.createElement('div');
      avatar.className = 'message-avatar';
      // 使用 SVG 图标替代 emoji，统一视觉风格（UX-FD-03 SVG图标精灵）
      const iconId = message.role === 'user' ? '#icon-person' : '#icon-fairy';
      avatar.innerHTML = `<svg class="icon"><use href="${iconId}"/></svg>`;
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

    // P3-FLOW-07 用户/精灵消息均添加复制按钮（hover 时显示）
    // 原仅精灵消息有复制按钮，用户消息需手动选择文本，体验不一致
    if (!message.streaming) {
      const copyBtn = document.createElement('button');
      copyBtn.className = 'message-copy-btn';
      copyBtn.title = '复制';
      // 使用 SVG 图标替代 emoji（UX-FD-03）
      copyBtn.innerHTML = '<svg class="icon"><use href="#icon-copy"/></svg>';
      // QC-11 使用 data-action 属性替代直接 addEventListener，由构造函数中的事件委托统一处理
      copyBtn.dataset.action = 'copy';
      copyBtn.dataset.content = message.content;
      metaRow.appendChild(copyBtn);
    }

    // 时间戳
    const timestamp = message.timestamp ?? new Date().toISOString();
    const timeEl = document.createElement('div');
    timeEl.className = 'message-time';
    // H3 剪枝：复用 domHelpers.formatTimestamp
    timeEl.textContent = formatTimestamp(timestamp);
    metaRow.appendChild(timeEl);

    contentWrapper.appendChild(metaRow);

    el.appendChild(contentWrapper);

    // 召回记忆提示（仅精灵消息）
    const memoryRecall = message.memoryRecall;
    if (message.role === 'assistant' && memoryRecall && memoryRecall.length > 0) {
      // QC-R2-12：委托到 messageDecorations helper 构建召回记忆容器
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

    // 每次收到新 chunk 重置超时兜底定时器（30 秒无新 chunk 则判定为卡死）
    this._resetStreamSafetyTimer();

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
      // P1-RAF-01 保存句柄，cleanup 时可取消挂起的回调
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

        // 安全清空并重新渲染 Markdown
        clearElement(latestBubble);
        latestBubble.appendChild(renderMarkdown(this._latestStreamText));

        // 重新追加保留元素（recall 和 tool-call 在前，cursor 在最后）
        if (latestRecall) latestBubble.appendChild(latestRecall);
        for (const tc of Array.from(latestToolCalls)) {
          latestBubble.appendChild(tc);
        }
        if (latestCursor) latestBubble.appendChild(latestCursor);

        // QC-FLOW-05：DOM 更新完成后再滚动，确保滚动位置准确
        // 原实现在 rAF 外调用 scrollToBottom，此时 DOM 尚未更新（还在等 rAF），
        // 滚动到的是旧高度位置，rAF 回调更新 DOM 后内容增高但已不再滚动，
        // 导致用户看到的位置不是最底部。
        this.host.scrollToBottom();
      });
    }
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

    // 修复 P1-A：rAF 还在 pending 时直接 cancel 会丢失最后一批 chunk
    // 必须先同步 flush 一次渲染，把 _latestStreamText 落到 DOM，再 cancel 后续 rAF
    // 否则最后一批 chunk 与 END 同事件循环到达时，rAF 还没触发就被 cancel，永久丢失
    if (this._rafHandle !== null && this._latestStreamMessageId === messageId) {
      const bubbleToFlush = el.querySelector('.message-bubble');
      if (bubbleToFlush && this._latestStreamText) {
        try {
          // 保留 cursor/recall/tool-call 元素（与正常 rAF 回调一致）
          const flushRecall = bubbleToFlush.querySelector('.memory-recall-container');
          const flushToolCalls = bubbleToFlush.querySelectorAll('.tool-call-card');
          clearElement(bubbleToFlush);
          bubbleToFlush.appendChild(renderMarkdown(this._latestStreamText));
          if (flushRecall) bubbleToFlush.appendChild(flushRecall);
          flushToolCalls.forEach((tc) => bubbleToFlush.appendChild(tc));
        } catch (err) {
          // 渲染异常时不阻塞收尾流程，保留旧 DOM
          reportError('finishStreamingMessage', err);
        }
      }
      cancelAnimationFrame(this._rafHandle);
      this._rafHandle = null;
      this._pendingRaF = false;
    }

    el.classList.remove('streaming');
    // 移除光标元素
    const cursor = el.querySelector('.cursor');
    if (cursor) cursor.remove();

    // 移除思考阶段指示器（如"正在归档"等），流式结束后不应继续显示
    const thinkingPhase = el.querySelector('.thinking-phase');
    if (thinkingPhase) thinkingPhase.remove();

    // 流式完成后添加复制按钮（从 bubble 提取最终文本）
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
   * QC-FLOW 为已完成的助手消息添加复制按钮
   *
   * 抽取为私有方法以复用：finishStreamingMessage（正常结束）和
   * markStreamingAborted（用户中断）都需要添加复制按钮，
   * 允许用户复制已生成的部分内容。
   *
   * @param el 消息 DOM 元素（.message 容器）
   */
  private _addCopyButtonToMessage(el: HTMLElement): void {
    const bubble = el.querySelector('.message-bubble');
    const contentWrapper = el.querySelector('.message-content');
    if (!bubble || !contentWrapper) return;

    // 避免重复添加（幂等保护）
    if (contentWrapper.querySelector('.message-copy-btn')) return;

    // 提取纯文本内容（排除 UI 元信息元素）
    // - memory-recall：召回记忆提示
    // - stream-aborted：中断标记（UX-PP-10）
    // - md-code-header：代码块头部（语言标签 + 复制按钮文本，UX-PP-11）
    // - stream-error：错误指示器（QC-FLOW 错误注入路径）
    // - thinking-phase：思考阶段指示器
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
    // 移除所有代码块头部（语言标签 + 复制按钮文本不应包含在复制内容中）
    clone.querySelectorAll('.md-code-header').forEach((h) => h.remove());
    const finalText = clone.textContent ?? '';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'message-copy-btn';
    copyBtn.title = '复制';
    // 使用 SVG 图标替代 emoji（UX-FD-03）
    copyBtn.innerHTML = '<svg class="icon"><use href="#icon-copy"/></svg>';
    // QC-11 使用 data-action 属性替代直接 addEventListener，由构造函数中的事件委托统一处理
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

    // 缺口 J：manual 模式下为 assistant 消息追加"归档"按钮
    // manual 模式内核跳过自动归档，用户需手动触发 profile facts + insight 归档
    if (el.classList.contains('assistant') && this.host.getArchiveMode() === 'manual') {
      this._addArchiveButtonToMessage(el, finalText, copyBtn, metaRow);
    }
  }

  /**
   * 为 assistant 消息追加"归档"按钮（缺口 J：manual 模式专用）
   *
   * 点击时查找前一条 user 消息内容作为 input，与 assistant 回复一起触发归档。
   * 归档完成后显示 toast 反馈归档条目数，并禁用按钮防止重复归档。
   *
   * @param el 当前 assistant 消息 DOM 元素
   * @param assistantContent 助手回复纯文本（已排除 UI 元信息）
   * @param copyBtn 复制按钮（用于确定插入位置）
   * @param metaRow 元信息行（按钮容器）
   */
  private _addArchiveButtonToMessage(
    el: HTMLElement,
    _assistantContent: string,
    copyBtn: HTMLButtonElement,
    metaRow: Element | null,
  ): void {
    // 幂等保护：已存在归档按钮则跳过
    if (el.querySelector('.message-archive-btn')) return;

    const archiveBtn = document.createElement('button');
    archiveBtn.className = 'message-archive-btn';
    archiveBtn.title = '归档到记忆（manual 模式）';
    archiveBtn.innerHTML = '<svg class="icon"><use href="#icon-bookmark"/></svg>';
    // QC-11 事件委托模式：通过 data-action 统一分发
    archiveBtn.dataset.action = 'archive';

    // 插入到复制按钮之后
    if (copyBtn.parentNode) {
      copyBtn.parentNode.insertBefore(archiveBtn, copyBtn.nextSibling);
    } else if (metaRow) {
      metaRow.appendChild(archiveBtn);
    }
  }

  /**
   * 处理归档按钮点击（缺口 J：manual 模式专用）
   *
   * 从 DOM 中查找当前 assistant 消息的前一条 user 消息内容作为输入，
   * 与 assistant 回复一起触发 host.archiveConversation。
   * 归档完成后显示 toast 反馈条目数，并禁用按钮防止重复归档。
   */
  private async _handleArchiveClick(archiveBtn: HTMLElement): Promise<void> {
    // 查找当前消息元素
    const messageEl = archiveBtn.closest<HTMLElement>('.message.assistant');
    if (!messageEl) return;

    // 向上查找前一条 user 消息（同一消息组或前一个消息组）
    const userMessageEl = this._findPreviousUserMessage(messageEl);
    if (!userMessageEl) {
      this.host.showToast('未找到配对的用户消息，无法归档', 'error');
      return;
    }

    // 提取 user 消息纯文本
    const userBubble = userMessageEl.querySelector('.message-bubble');
    const userInput = userBubble?.textContent ?? '';
    if (!userInput.trim()) {
      this.host.showToast('用户消息为空，无法归档', 'error');
      return;
    }

    // 提取 assistant 回复纯文本（已排除 UI 元信息，从 bubble 克隆提取）
    const assistantBubble = messageEl.querySelector('.message-bubble');
    if (!assistantBubble) return;
    const clone = assistantBubble.cloneNode(true);
    if (!(clone instanceof HTMLElement)) return;
    clone.querySelectorAll('.memory-recall, .stream-aborted, .stream-error, .thinking-phase, .md-code-header').forEach((node) => node.remove());
    const assistantContent = clone.textContent ?? '';

    // 禁用按钮，防止归档期间重复点击
    archiveBtn.setAttribute('disabled', '');
    archiveBtn.classList.add('archiving');

    try {
      const count = await this.host.archiveConversation(userInput, assistantContent);
      if (count > 0) {
        this.host.showToast(`已归档 ${count} 条记忆`, 'success', 2000);
        archiveBtn.classList.add('archived');
        archiveBtn.title = '已归档';
      } else {
        this.host.showToast('本轮对话无需归档（未提取到有价值信息）', 'info', 2000);
        archiveBtn.removeAttribute('disabled');
        archiveBtn.classList.remove('archiving');
      }
    } catch {
      this.host.showToast('归档失败，请重试', 'error');
      archiveBtn.removeAttribute('disabled');
      archiveBtn.classList.remove('archiving');
    }
  }

  /**
   * 从当前消息元素向上查找前一条 user 消息（缺口 J 辅助方法）
   *
   * 消息可能分组（.message-group）或独立（直接在 messagesEl 下），
   * 需要跨分组边界查找最近的 .message.user 元素。
   *
   * @param startEl 起始消息元素（通常是 assistant 消息）
   * @returns 最近的 user 消息元素，未找到返回 null
   */
  private _findPreviousUserMessage(startEl: HTMLElement): HTMLElement | null {
    // 使用 elementWalker 风格向前遍历：先在同组内找，再跨组找
    let current: Element | null = startEl;
    while (current) {
      // previousElementSibling 在同组内查找
      current = current.previousElementSibling;
      // 如果同级没找到，尝试跳出当前 group
      if (!current) {
        const group = startEl.closest('.message-group');
        if (group) {
          // 找前一个 group 的最后一个消息
          const prevGroup = group.previousElementSibling;
          if (prevGroup) {
            current = prevGroup.lastElementChild;
          }
        }
        if (!current) break;
      }
      // 检查当前元素是否为 user 消息
      if (current instanceof HTMLElement && current.classList.contains('message') && current.classList.contains('user')) {
        return current;
      }
    }
    return null;
  }

  /**
   * MS-12 设置流式消息的召回记忆摘要
   *
   * 委托到 messageDecorations.ts 的 renderMemoryRecall 纯函数（QC-R2-12 提取）。
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
        indicator.innerHTML = `<svg class="icon"><use href="#icon-gear"/></svg><span>正在回忆 ${memories.length} 条相关记忆...</span>`;
      }
    }
  }

  // ─── UX-P2-01 思考阶段指示器 ──────────────────────────────

  /**
   * UX-P2-01 显示思考阶段指示器
   *
   * 委托到 messageDecorations.ts 的 renderThinkingPhase 纯函数（QC-R2-12 提取）。
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

  // ─── OBS-02 上下文截断提示 ────────────────────────────────

  /**
   * OBS-02 在消息气泡顶部显示上下文截断提示条
   *
   * 委托到 messageDecorations.ts 的 renderTruncationNotice 纯函数（QC-R2-12 提取）。
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

  // ─── UX-P1-02 工具调用卡片 ────────────────────────────────

  /**
   * UX-P1-02 显示工具调用开始卡片
   *
   * 委托到 toolCallCard.ts 的 renderToolStart 纯函数（QC-R2-12 提取）。
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
   * UX-P1-02 更新工具调用结果
   *
   * 委托到 toolCallCard.ts 的 updateToolCardResult 纯函数（QC-R2-12 提取）。
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

    // UX-PP-04 首字节前的"正在思考"占位
    // 从 SPRITE_STREAM_START 到首个 chunk 之间，用户原本只看到空气泡+光标，
    // 对齐大厂对话体验：立即显示"⚙️ 正在思考..."占位，消除空白期感知。
    // showThinkingPhase 会复用此元素更新为"正在回忆/处理/归档..."（查找或创建模式）；
    // updateStreamingMessage / injectErrorToStreamingMessages 会移除此元素。
    const bubble = el.querySelector('.message-bubble');
    if (bubble) {
      const placeholder = document.createElement('div');
      placeholder.className = 'thinking-phase';
      // 使用 SVG 图标替代 emoji（UX-FD-03）
      placeholder.innerHTML = '<svg class="icon"><use href="#icon-gear"/></svg><span>正在思考...</span>';
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
    this.messagesEl.querySelectorAll('.message, .message-group, .date-separator, .milestone-banner').forEach((msg) => msg.remove());
    // UX-FD-07 移除加载更多按钮（切换会话时重置）
    this.hideLoadMore();
    this.streamingMessages.clear();
    this.host.setStreaming(false);
    this.host.updateSendButton();
    // UX-P2-05 清空消息时重置计数器，避免跨会话累加导致显示错误
    this.host.resetMessageCount();
    this.host.refreshMessageCountDisplay();
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

    // UX-FD-07 方案 B：历史消息加载不累加今日消息计数
    this.host.refreshMessageCountDisplay();
    // 非 prepend 模式才滚动到底部（prepend 模式已恢复滚动位置）
    if (!prepend) {
      this.host.forceScrollToBottom();
    }
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

    // QC-11 保存回调引用，由构造函数中的事件委托统一处理
    this.loadMoreCallback = onClick;

    const container = document.createElement('div');
    container.id = 'load-more-container';
    container.className = 'load-more-container';

    const btn = document.createElement('button');
    btn.className = 'load-more-btn';
    btn.textContent = `加载更多消息（剩余 ${remaining} 条）`;
    // QC-11 使用 data-action 属性替代直接 addEventListener，由构造函数中的事件委托统一处理
    btn.dataset.action = 'load-more';
    container.appendChild(btn);

    // 插入到消息区顶部
    this.messagesEl.insertBefore(container, this.messagesEl.firstChild);
  }

  /**
   * UX-FD-07 隐藏"加载更多"按钮
   *
   * 方案 B：同时适用于"加载更多"和"加载更早的对话"按钮（共用 #load-more-container）。
   */
  hideLoadMore(): void {
    const existing = this.messagesEl.querySelector('#load-more-container');
    if (existing) existing.remove();
  }

  /**
   * UX-FD-07 方案 B 显示"加载更早的对话"按钮
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
   * UX-PP-10 在流式消息气泡内嵌入中断标记
   *
   * 用户主动中断对话时，在原助手气泡底部嵌入中断标记，
   * 保留已生成的部分内容（对齐 Claude Code 的 partial response 保留理念）。
   * 替代旧的居中系统消息方案——居中消息与原气泡内容脱节，体验割裂。
   *
   * QC-FLOW-02 完整清理流式状态（从 streamingMessages 删除、重置 isStreaming、
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
    abortedDiv.textContent = `⏹ 已中断：${reason}（已保留上方生成内容）`;
    bubble.appendChild(abortedDiv);

    // 添加复制按钮，允许用户复制已生成的部分内容
    this._addCopyButtonToMessage(el);

    // 完整清理流式状态（QC-FLOW-02）
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

    // 取消挂起的 rAF 回调，防止错误注入后 rAF 重新渲染 Markdown 覆盖错误提示
    if (this._rafHandle !== null) {
      cancelAnimationFrame(this._rafHandle);
      this._rafHandle = null;
      this._pendingRaF = false;
    }

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

      // UX-PP-05 错误气泡内的"重试"按钮
      // 对齐大厂对话体验：错误文本下方直接提供重试按钮，与 Toast 重试形成双通道。
      // 通过 data-action="retry" 标识，由构造函数的事件委托统一处理（QC-11 模式）。
      const retryBtn = document.createElement('button');
      retryBtn.className = 'stream-error-retry';
      retryBtn.textContent = '重试';
      retryBtn.dataset.action = 'retry';
      bubble.appendChild(retryBtn);

      // 停止流式状态
      el.classList.remove('streaming');
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
   * UX-PP-05 注册错误重试回调
   *
   * 流式出错时，气泡内的"重试"按钮被点击后触发此回调。
   * 由 renderer.ts 注入 retryLastUserInput（重新发送上一条用户消息）。
   * UX-PP-13 后此为唯一重试通道（Toast 不再携带重试按钮）。
   *
   * @param cb 重试回调（无参数，由宿主自行获取 lastUserInput）
   */
  onErrorRetry(cb: () => void): void {
    this.errorRetryCallback = cb;
  }
}