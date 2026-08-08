/**
 * 聊天面板管理器 — 消息渲染、流式输出、工具调用卡片、思考阶段指示器独立子模块
 *
 * 职责：
 * - 管理聊天消息的 DOM 构建与渲染（appendMessage / buildMessageElement / appendMessages）
 * - 管理流式输出状态（startStreaming / updateStreamingMessage / finishStreamingMessage / stopAllStreaming）
 * - 管理工具调用卡片（showToolStart / updateToolResult）
 * - 管理思考阶段指示器（showThinkingPhase）
 * - 管理召回记忆展示（setMemoryRecall，createRecallContainer 已下沉到 MessageBubbleComponent）
 * - 管理错误注入（injectErrorToStreamingMessages）
 * - 管理空状态引导（showEmptyState / hideEmptyState 保留；initEmptyStateListeners DOM 绑定下沉到 emptyState.ts）
 * - 管理加载更多按钮（showLoadMore / hideLoadMore，DOM 构建下沉到 loadMoreControls.ts）
 * - 管理加载更早日期按钮（showLoadEarlierDay，方案 B 时间流，DOM 构建下沉到 loadMoreControls.ts）
 * - 管理会话异步加载指示器（showSessionLoading / hideSessionLoading，复用 domHelpers 单一真理源）
 * - 管理消息区域清空（clearMessages）
 * - B1：对话区内联里程碑 banner（appendMilestoneBanner，DOM 构建下沉到 milestoneBanner.ts 组件）
 *
 * 设计原则：
 * - 遵循 SettingsPanelManager 的组合模式，UIManager 持有实例并委托
 * - 跨模块关注点（showToast / scrollToBottom / updateSendButton 等）通过 host 回调注入
 * - 自管理内部状态（流式消息映射、RAF 状态、回调引用），提供 cleanup() 清理
 */

import { formatDateKey, showPanelLoading, hidePanelLoading } from '../helpers/domHelpers.js';
import { setIcon, setIconWithLabel } from '../helpers/icon.js';
// MessageBubbleComponent（HEAL-17 Phase 2）：单条消息气泡组件，承接原 buildMessageElement 的 DOM 构建逻辑
import { MessageBubbleComponent } from '../components/feedback/messageBubbleComponent.js';
import { reportError } from '../helpers/errorHelpers.js';
// 共享常量：时间换算与 Toast 时长，避免硬编码（对齐 sprite/constants.ts）
import { MS_PER_MINUTE } from '../../../sprite/constants.js';
// 工具调用卡片 DOM 逻辑提取到独立 helper
import { showToolStart as renderToolStart, updateToolResult as updateToolCardResult } from '../helpers/toolCallCard.js';
// 流式渲染核心（RAF 节流 + Markdown 渲染 + 复制按钮）提取到独立子模块（panels/ 同层）
import {
  updateStreamingMessage as renderStreamingMessage,
  finishStreamingMessage as finishStreamingRender,
  addCopyButtonToMessage,
  cancelPendingRaf,
  type StreamingRendererContext,
} from './streamingRenderer.js';
// 流式输出安全兜底定时器（30s/90s 二级兜底）提取到独立 helper
import { StreamSafetyTimer } from '../helpers/streamSafetyTimer.js';
// 消息装饰器（召回记忆渲染 + 思考阶段 + 截断提示）提取到独立 helper
// 注：createRecallContainer 已下沉到 MessageBubbleComponent（HEAL-17 Phase 2）
import {
  renderMemoryRecall,
  showThinkingPhase as renderThinkingPhase,
  showTruncationNotice as renderTruncationNotice,
} from '../helpers/messageDecorations.js';
// 归档按钮逻辑（manual 模式专用）提取到独立 Manager
import { ArchiveButtonManager } from './archiveButtonManager.js';
// 启动摘要横幅逻辑提取到独立组件（纯展示函数，无状态依赖）
import { showStartupSummary as renderStartupSummary } from '../components/startupSummaryBanner.js';
// 里程碑 banner DOM 构建下沉到独立组件（HEAL-17-P4）
import { createMilestoneBanner } from '../components/milestoneBanner.js';
// 事件委托逻辑（click/contextmenu/keydown）提取到 helpers
// 消息操作（regenerate/forget）由 chatPanelEvents 内部调用 messageOperations，本模块不再直接引用
import { initChatPanelEvents } from '../helpers/chatPanelEvents.js';
// 加载更多/更早控件 DOM 构建下沉到独立 helper（HEAL-17-P4）
import { createLoadMoreContainer, createLoadEarlierDayContainer, removeLoadMoreControl } from '../helpers/loadMoreControls.js';
// 回到底部浮动按钮 / 空状态引导事件绑定下沉到独立 helper（HEAL-17-P4）
import { initScrollToBottomButton as initScrollToBottomButtonImpl } from '../helpers/scrollToBottomButton.js';
import { initEmptyStateListeners as initEmptyStateListenersImpl } from '../helpers/emptyState.js';
import type { EventTracker } from '../helpers/eventTracker.js';
import type { ConfirmDialogOptions, Message, ToastType } from '../types.js';

// ─── Host 接口（跨模块关注点注入） ────────────────────────

// ─── ChatPanelHost 拆分为 4 个窄接口（MIND2-D3） ─────────
//
// 设计原则（progressive-refactor-rules §6.1 契约接口同步）：
// - 按职责分组：消息渲染 / 流式控制 / 归档操作 / 对话框交互
// - ChatPanelHost 继承 4 个窄接口（向后兼容，现有调用方零改动）
// - 依赖方（helpers / sub-managers）按实际使用收窄 host 类型
//
// 删除死方法：updateBadge（零调用方，UIManager 内部 updateUnreadCount
// 直接调用 badgeManager.updateBadge，不经 host 接口暴露）。

/**
 * 消息渲染 + 反馈 + 跨面板高亮（ChatPanelHost 子接口）
 *
 * 涵盖：Toast 反馈、滚动控制、空状态切换、未读计数、跨面板导航高亮。
 * 调用方：ChatPanelManager（消息渲染）+ chatPanelEvents（复制反馈）
 */
export interface ChatRenderHost {
  /** 显示 toast 通知 */
  showToast(message: string, type?: ToastType, duration?: number): void;
  /** 自动滚动到底部（用户在底部附近时） */
  scrollToBottom(): void;
  /** 强制滚动到底部（无视用户位置） */
  forceScrollToBottom(): void;
  /** 显示空状态引导（无消息时） */
  showEmptyState(): void;
  /** 隐藏空状态引导（有消息时） */
  hideEmptyState(): void;
  /** 未读计数 +1（完整窗口隐藏时，新精灵消息到达） */
  updateUnreadCount(): void;
  /**
   * 给指定面板导航按钮添加 pulse 高亮（MIND2-D5：消除跨面板 DOM 耦合）
   *
   * 里程碑触发时让 dashboard 导航按钮高亮，提示用户有新成就可查看。
   * 委托给 PanelRouter.pulseNavButton，避免直接操作其他面板的 DOM。
   *
   * @param panel 目标面板名（如 'dashboard'）
   */
  pulseNavButton(panel: string): void;
}

/**
 * 流式状态机 + 按钮联动 + 兜底通知（ChatPanelHost 子接口）
 *
 * 涵盖：流式状态封装、按钮可见性切换、超时兜底主进程清理。
 * 调用方：ChatPanelManager（streamRenderCtx）+ StreamSafetyTimer + messageOperations（isStreaming 守卫）
 */
export interface ChatStreamControlHost {
  /**
   * 设置流式输出状态（UIManager 作为 state 的唯一持有者，通过 host 方法封装）
   *
   * @param streaming 是否正在流式输出
   */
  setStreaming(streaming: boolean): void;
  /**
   * 查询流式输出状态
   *
   * @returns 当前是否正在流式输出
   */
  isStreaming(): boolean;
  /** 更新发送/停止按钮状态 */
  updateSendButton(): void;
  /**
   * 流式输出超时兜底触发时通知宿主联动主进程清理
   *
   * 渲染进程 30s 无进展判定卡死后，仅重置 UI 状态不够——主进程 AbortController 仍可能泄漏，
   * 导致下次发送被竞态保护拒绝。宿主通过此回调通知主进程 abort 当前对话，联动清理。
   */
  onStreamStuck(): void;
}

/**
 * 归档操作契约（ChatPanelHost 子接口）
 *
 * 涵盖：归档模式查询、单轮归档（profile + insight）、批量归档、会话 ID 定位。
 * 调用方：ChatPanelManager（showArchiveButton）+ ArchiveButtonManager（getArchiveMode + archiveConversation + showToast）
 *
 * 注意：ArchiveButtonManager 已有独立的 ArchiveButtonHost 接口（3 方法子集），
 *      本接口保留 archiveSession + getCurrentSessionId 供 ChatPanelManager.showArchiveButton 使用。
 */
export interface ArchiveOperationHost {
  /**
   * 查询当前归档模式（manual 模式下显示"归档"按钮）
   *
   * @returns 当前 archiveMode（full / insights-only / manual）
   */
  getArchiveMode(): 'full' | 'insights-only' | 'manual';
  /**
   * 手动归档对话（profile facts + insight 一次性触发）
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
}

/**
 * 对话框交互（ChatPanelHost 子接口）
 *
 * 涵盖：忘记操作二次确认、重新生成上一条精灵消息。
 * 调用方：messageOperations（handleForget / handleRegenerate）
 */
export interface ChatDialogHost {
  /**
   * 显示确认对话框（用于"忘记"等需二次确认的操作）
   *
   * @param options 确认弹窗选项（标题/消息/按钮文案/danger 标记）
   * @returns 用户是否点击确认
   */
  showConfirmDialog(options: ConfirmDialogOptions): Promise<boolean>;
  /**
   * 重新生成上一条精灵消息（右键菜单"重新生成"触发）
   *
   * 通过宿主回调机制，由 renderer.ts 层实现实际的重新发送逻辑，
   * 避免 ChatPanelManager 直接访问 sessionController 或 electronAPI。
   *
   * @param userMessage 对应用户消息内容（从 DOM 中提取，用于重新发送）
   */
  regenerateLastMessage(userMessage: string): void;
}

/**
 * 聊天面板管理器需要的宿主能力（组合接口，向后兼容）
 *
 * MIND2-D3：拆分为 4 个窄接口（ChatRenderHost / ChatStreamControlHost /
 * ArchiveOperationHost / ChatDialogHost），本接口仅作组合出口，保持现有调用方零改动。
 *
 * 删除死方法：updateBadge（零调用方，UIManager 内部 updateUnreadCount
 * 直接调用 badgeManager.updateBadge，不经 host 接口暴露）。
 */
export interface ChatPanelHost extends ChatRenderHost, ChatStreamControlHost, ArchiveOperationHost, ChatDialogHost {}

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
   * 流式渲染上下文（RAF 节流状态 + 最新文本缓存 + 回调注入）
   *
   * 由 streamingRenderer.ts 的纯函数通过 context 注入模式读写：
   * - pendingRaf / rafHandle：RAF 节流控制（避免高频 chunk 重复渲染）
   * - latestStreamText / latestStreamMessageId：RAF 回调中使用的最新值
   * - streamingMessages：与 ChatPanelManager 共享引用的流式消息映射
   */
  private streamRenderCtx: StreamingRendererContext;

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
   * 流式输出安全兜底定时器（30s/90s 二级兜底）
   *
   * 当 isStreaming 卡在 true 时（SPRITE_STREAM_END 未到达），自动重置状态。
   * 每次收到新 chunk 时重置定时器，30 秒无新 chunk 则判定为卡死。
   * 提取到 helpers/streamSafetyTimer.ts（模式 D：自包含类，hooks 注入）。
   */
  private safetyTimer: StreamSafetyTimer;

  /** 归档按钮自动移除定时器（cleanup 时统一清理，避免回调在已销毁 DOM 上执行） */
  private archiveButtonTimer: ReturnType<typeof setTimeout> | null = null;

  /** 会话状态横幅元素（不中断工作模型，暂停时在消息区顶部显示提示），null 表示未创建 */
  private sessionStatusEl: HTMLElement | null = null;

  /** 澄清面板元素（P4 暂停询问，在消息区顶部展示问题列表），null 表示未创建 */
  private clarifyPanelEl: HTMLElement | null = null;

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

    // 流式渲染上下文（状态 + 回调注入，streamingRenderer.ts 纯函数通过此对象读写状态）
    // 回调用箭头函数捕获 this，运行时解析最新引用（safetyTimer 在下方赋值后即可被回调访问）
    this.streamRenderCtx = {
      streamingMessages: this.streamingMessages,
      pendingRaf: false,
      rafHandle: null,
      latestStreamText: '',
      latestStreamMessageId: '',
      scrollToBottom: () => this.host.scrollToBottom(),
      onSafetyTimerReset: () => this.safetyTimer.reset(),
      onSafetyTimerClear: () => this.safetyTimer.clear(),
      setStreaming: (streaming: boolean) => this.host.setStreaming(streaming),
      updateSendButton: () => this.host.updateSendButton(),
    };

    // 安全兜底定时器（hooks 注入：isStreaming 查询 + onStreamStuck 30s 通知 + 90s 本地清理）
    this.safetyTimer = new StreamSafetyTimer({
      isStreaming: () => this.host.isStreaming(),
      onStreamStuck: () => this.host.onStreamStuck(),
      onFallbackCleanup: () => this.handleStreamFallbackCleanup(),
    });

    // 事件委托初始化（click/contextmenu/keydown）提取到 helpers/chatPanelEvents.ts
    // 回调通过 getter 函数注入，确保运行时读取最新值（onXxx 注册晚于 constructor）
    initChatPanelEvents({
      messagesEl: this.messagesEl,
      events: this.events,
      host: this.host,
      archiveButtonManager: this.archiveButtonManager,
      getMemoryRecallClickCallback: () => this.memoryRecallClickCallback,
      getLoadMoreCallback: () => this.loadMoreCallback,
      getLoadEarlierDayCallback: () => this.loadEarlierDayCallback,
      getErrorRetryCallback: () => this.errorRetryCallback,
    });
  }

  // ─── 生命周期 ──────────────────────────────────────────

  /** 清理所有事件监听器和挂起的 RAF 回调 */
  cleanup(): void {
    // 取消挂起的 requestAnimationFrame，防止 cleanup 后访问已销毁 DOM
    cancelPendingRaf(this.streamRenderCtx);
    // 清除超时兜底定时器
    this.safetyTimer.clear();
    // 清除归档按钮自动移除定时器（避免回调在已销毁 DOM 上执行）
    if (this.archiveButtonTimer !== null) {
      clearTimeout(this.archiveButtonTimer);
      this.archiveButtonTimer = null;
    }
    // 归档按钮管理器清理（无事件监听器，空实现，保持统一生命周期接口）
    this.archiveButtonManager.cleanup();
    this.events.cleanup();
  }

  /** 回到底部浮动按钮（DOM 构建+事件绑定下沉到 scrollToBottomButton.ts） */
  initScrollToBottomButton(): void {
    initScrollToBottomButtonImpl(this.messagesEl, this.events);
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
    const dateStr = formatDateKey(msgDate); // YYYY-MM-DD（本地时区）
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
   * B1：对话区内联里程碑 banner（DOM 构建下沉到 milestoneBanner.ts 组件）
   *
   * 对齐 demo v3 `.milestone-banner` 设计：里程碑事件不再走顶部 #proactive-banner，
   * 而是作为对话流中的独立元素内联渲染，与消息同流，记录"对话中达成的成就"。
   * 关闭按钮通过事件委托（data-action="close-milestone"）处理。
   * 不参与消息分组（lastMessageRole 等状态不变）。
   *
   * @param text 里程碑文本（如"达成里程碑：首次完成 UI 布局重构方案"）
   */
  appendMilestoneBanner(text: string): void {
    // 有内容时隐藏空状态引导
    this.host.hideEmptyState();

    // DOM 构建下沉到 milestoneBanner.ts（纯展示函数，零行为变更）
    this.messagesEl.appendChild(createMilestoneBanner(text));

    // 滚动到底部，确保用户看到新里程碑
    this.host.scrollToBottom();

    // P1-3 用户体验打磨：里程碑触发时给 dashboard 导航按钮加 pulse 高亮，
    // 让用户知道仪表盘有新成就可查看（跨面板信息可见性）。
    // MIND2-D5：委托给 PanelRouter.pulseNavButton，消除跨面板 DOM 耦合
    this.host.pulseNavButton('dashboard');
  }

  /**
   * 构建消息 DOM 元素（薄委托，HEAL-17 Phase 2）
   *
   * 原内联 DOM 构建逻辑（~110 行）已下沉到 MessageBubbleComponent（components/messageBubbleComponent.ts）。
   * 本方法仅作为薄包装，返回 HTMLElement 供 appendMessage / appendMessages 使用。
   *
   * 设计理由（对齐 ui-engineering-mindset-rules §四.4 Manager 与 Component 边界）：
   *   - Manager 负责消息列表编排（分组 / 日期 / 滚动）
   *   - Component 负责单条消息 DOM 构建
   *   - Manager 通过 `component.build()` 获取 HTMLElement 后自行决定挂载位置（message-group / messagesEl）
   *
   * @param message 消息对象
   * @param grouped 是否为分组消息（连续同角色，省略头像）
   * @returns 完整的消息 DOM 元素（已构建但未挂载到真实容器，调用方自行 appendChild）
   */
  private buildMessageElement(message: Message, grouped: boolean = false): HTMLElement {
    /** 创建 Component 实例并构建 DOM（不挂载到真实容器，调用方自行 appendChild） */
    const component = new MessageBubbleComponent({ message, grouped });
    return component.build();
  }

  /**
   * 更新流式消息内容
   *
   * 委托到 panels/streamingRenderer.ts 的 updateStreamingMessage 纯函数。
   * RAF 节流 + 纯文本显示 + 安全定时器重置逻辑均由 streamingRenderer 通过
   * context 注入模式处理，本方法仅负责转发调用。
   *
   * 性能策略（CHAT-A01）：流式期间使用 textContent 纯文本显示，不调用 renderMarkdown。
   */
  updateStreamingMessage(messageId: string, text: string): void {
    renderStreamingMessage(this.streamRenderCtx, messageId, text);
  }

  /**
   * 完成流式消息
   *
   * 委托到 panels/streamingRenderer.ts 的 finishStreamingMessage 纯函数。
   * 取消挂起 rAF + 一次性 Markdown 渲染 + 复制按钮 + 状态重置均由 streamingRenderer
   * 通过 context 注入模式处理，本方法仅负责转发调用。
   *
   * 性能策略（CHAT-A02）：结束时一次性渲染完整 Markdown，避免与纯文本渲染竞争。
   */
  finishStreamingMessage(messageId: string): void {
    finishStreamingRender(this.streamRenderCtx, messageId);
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
    this.safetyTimer.reset();

    // bubble 由 createStreamingMessage() 保证存在（非 system 消息始终有 .message-bubble 子元素）
    const bubble = el.querySelector('.message-bubble')!;

    // 委托到 messageDecorations helper 渲染召回记忆容器
    renderMemoryRecall(bubble, memories);

    // Phase 3：更新思考阶段指示器，显示具体召回数量
    if (memories.length > 0) {
      const indicator = bubble.querySelector('.thinking-phase');
      if (indicator instanceof HTMLDivElement) {
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
    this.safetyTimer.reset();

    // bubble 由 createStreamingMessage() 保证存在（非 system 消息始终有 .message-bubble 子元素）
    const bubble = el.querySelector('.message-bubble')!;

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
    this.safetyTimer.reset();

    // bubble 由 createStreamingMessage() 保证存在（非 system 消息始终有 .message-bubble 子元素）
    const bubble = el.querySelector('.message-bubble')!;

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
    this.safetyTimer.reset();

    // bubble 由 createStreamingMessage() 保证存在（非 system 消息始终有 .message-bubble 子元素）
    const bubble = el.querySelector('.message-bubble')!;

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
    this.safetyTimer.reset();

    // bubble 由 createStreamingMessage() 保证存在（非 system 消息始终有 .message-bubble 子元素）
    const bubble = el.querySelector('.message-bubble')!;

    // 委托到 toolCallCard helper 更新卡片状态
    updateToolCardResult(bubble, toolCallId, name, ok, summary);
  }

  /**
   * 开始流式输出
   *
   * @param messageId 消息唯一 ID
   * @param persona 本轮 LLM 调用使用的角色内部名（可选，用于消息底部角色标签显示）
   */
  startStreaming(messageId: string, persona?: string): void {
    const el = this.appendMessage({
      role: 'assistant',
      content: '',
      streaming: true,
      messageId,
      persona,
    });

    this.streamingMessages.set(messageId, el);
    this.host.setStreaming(true);

    // 首字节前的"正在思考"占位
    // SPRITE_STREAM_START 到首个 chunk 之间立即显示"⚙️ 正在思考…"占位，消除空白期感知。
    // showThinkingPhase 会复用此元素更新为"正在回忆/处理/归档…"（查找或创建模式）；
    // updateStreamingMessage / injectErrorToStreamingMessages 会移除此元素。
    const bubble = el.querySelector('.message-bubble');
    if (bubble) {
      const placeholder = document.createElement('div');
      placeholder.className = 'thinking-phase';
      // 使用 SVG 图标替代 emoji
      setIconWithLabel(placeholder, 'icon-gear', '正在思考…');
      // 插入到光标之前（若存在），否则追加到气泡末尾
      const cursor = bubble.querySelector('.cursor');
      if (cursor) {
        bubble.insertBefore(placeholder, cursor);
      } else {
        bubble.appendChild(placeholder);
      }
    }

    // 启动超时兜底：30 秒无新 chunk 则自动重置（防止 SPRITE_STREAM_END 丢失导致 UI 卡死）
    this.safetyTimer.reset();

    // 更新按钮为停止姿态
    this.host.updateSendButton();
  }

  /** 停止所有流式输出 */
  stopAllStreaming(): void {
    // 取消挂起的 rAF 回调，防止 stop 后 rAF 重新渲染 Markdown 覆盖已停止状态
    cancelPendingRaf(this.streamRenderCtx);

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
    this.safetyTimer.clear();

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
    // 只移除消息、消息分组、日期分隔符、里程碑 banner、归档按钮元素，保留 chat-empty-state
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

      // 恢复滚动位置（新内容在顶部，向下偏移新增的高度）
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
   * 显示"加载更多"按钮（DOM 构建下沉到 loadMoreControls.ts，回调经事件委托分发）
   *
   * 在消息区顶部插入加载更多容器，包含按钮和剩余消息数提示。
   *
   * @param remaining 剩余消息数
   * @param onClick 点击回调（由 chatPanelEvents 事件委托经 data-action="load-more" 分发）
   */
  showLoadMore(remaining: number, onClick: () => void): void {
    // 移除旧按钮（避免重复）
    this.hideLoadMore();

    // 保存回调引用，由构造函数中的事件委托统一处理
    this.loadMoreCallback = onClick;

    // DOM 构建下沉到 loadMoreControls.ts（纯函数，零行为变更）
    this.messagesEl.insertBefore(createLoadMoreContainer(remaining), this.messagesEl.firstChild);
  }

  /**
   * 隐藏"加载更多/加载更早"容器（DOM 构建下沉到 loadMoreControls.ts）
   *
   * 方案 B：同时适用于"加载更多"和"加载更早的对话"按钮（共用 #load-more-container）。
   */
  hideLoadMore(): void {
    removeLoadMoreControl(this.messagesEl);
  }

  /**
   * 方案 B 显示"加载更早的对话"按钮（DOM 构建下沉到 loadMoreControls.ts）
   *
   * 在消息区顶部插入加载更早日期的容器，点击后加载前一天的对话。
   * 与 showLoadMore 共用 #load-more-container（互斥显示），通过 data-action 区分回调。
   *
   * @param onClick 点击回调（由 chatPanelEvents 事件委托经 data-action="load-earlier-day" 分发）
   */
  showLoadEarlierDay(onClick: () => void): void {
    // 移除旧按钮（避免重复，同时清除可能存在的"加载更多"按钮）
    this.hideLoadMore();

    // 保存回调引用，由构造函数中的事件委托统一处理
    this.loadEarlierDayCallback = onClick;

    // DOM 构建下沉到 loadMoreControls.ts（纯函数，零行为变更）
    this.messagesEl.insertBefore(createLoadEarlierDayContainer(), this.messagesEl.firstChild);
  }

  /**
   * 显示会话异步加载指示器
   *
   * 在消息区覆盖一层 loading 指示（spinner + 文案），
   * 用于 loadSessionHistory / switchSession / jumpToDate 等全量替换消息的异步加载期间，
   * 避免用户看到空白或旧内容残留而误以为卡死。
   *
   * 复用 domHelpers.showPanelLoading（项目 loading 指示器单一真理源 .panel-loading），
   * #messages 已 position:relative，覆盖层正确铺满消息区；调用方在加载完成后调 hideSessionLoading。
   */
  showSessionLoading(): void {
    showPanelLoading(this.messagesEl, '加载会话历史…');
  }

  /**
   * 移除会话异步加载指示器
   *
   * 与 showSessionLoading() 配对，加载成功或失败后调用。
   * 安全处理：消息区无 loading 层时静默返回（hidePanelLoading 内部保证）。
   */
  hideSessionLoading(): void {
    hidePanelLoading(this.messagesEl);
  }

  /**
   * 在流式消息气泡内嵌入中断标记
   *
   * 用户主动中断对话时，在助手气泡底部嵌入中断标记，
   * 保留已生成的部分内容（对齐 Claude Code 的 partial response 保留理念）。
   *
   * 完整清理流式状态（从 streamingMessages 删除、重置 isStreaming、
   * 更新发送按钮、清除安全定时器），与 finishStreamingMessage / injectErrorToStreamingMessages
   * 保持一致，确保 isStreaming 不泄漏、后续 SPRITE_STREAM_END 不会重复处理。
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
    cancelPendingRaf(this.streamRenderCtx);

    // bubble 由 createStreamingMessage() 保证存在（非 system 消息始终有 .message-bubble 子元素）
    const bubble = el.querySelector('.message-bubble')!;

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
        this.safetyTimer.clear();
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
    addCopyButtonToMessage(this.streamRenderCtx, el);

    // 完整清理流式状态
    el.classList.remove('streaming');
    this.streamingMessages.delete(messageId);

    // 所有流式消息都已完成时，重置 isStreaming 状态和按钮
    if (this.streamingMessages.size === 0) {
      this.host.setStreaming(false);
      this.safetyTimer.clear();
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
    cancelPendingRaf(this.streamRenderCtx);

    for (const [, el] of this.streamingMessages) {
      this.injectErrorToMessage(el, errorText);
    }

    // 清理流式消息映射和 UI 状态
    this.streamingMessages.clear();
    this.host.setStreaming(false);
    // 清除超时兜底定时器
    this.safetyTimer.clear();
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
    // bubble 由 createStreamingMessage() 保证存在（非 system 消息始终有 .message-bubble 子元素）
    const bubble = el.querySelector('.message-bubble')!;

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
   * 90s 二级兜底触发时的本地清理逻辑
   *
   * 由 StreamSafetyTimer 的 onFallbackCleanup hook 调用（构造函数中注入）。
   * 当 30s 主定时器通知主进程 onStreamStuck 后，主进程 60s 内未响应（总等待 90s），
   * 视为主进程完全失联，本地强制清理流式状态，防止 UI 永久锁死。
   *
   * 清理内容（与 markStreamingAborted 的 DOM 清理保持一致）：
   * - 取消挂起的 rAF 回调（防止后续 rAF 渲染覆盖清理结果）
   * - 移除每条 streaming 消息的 .streaming 类、cursor、thinking-phase
   * - 添加 copy 按钮（让用户能复制已生成的部分内容）
   * - 清空 streamingMessages 映射 + 重置 isStreaming + 更新发送按钮
   *
   * 90s 兜底为"全量重置"语义：clear() 后 Map 为空，后续若主进程延迟恢复
   * 并发送 aborted chunk，markStreamingAborted 会因 Map 为空走 early return
   * （不嵌入中断标记）——本地已接管清理，不再接受主进程的延迟响应。
   */
  private handleStreamFallbackCleanup(): void {
    reportError('chatPanelManager', '90s 兜底：主进程未响应 onStreamStuck，本地清理');
    // 取消挂起的 rAF 回调（防止后续 rAF 渲染覆盖清理结果）
    cancelPendingRaf(this.streamRenderCtx);
    // 清理每条 streaming 消息的 DOM 状态 + 添加 copy 按钮（与 markStreamingAborted 一致）
    for (const el of this.streamingMessages.values()) {
      el.classList.remove('streaming');
      const cursor = el.querySelector('.cursor');
      if (cursor) cursor.remove();
      const phase = el.querySelector('.thinking-phase');
      if (phase) phase.remove();
      // 补齐 copy 按钮，让用户能复制已生成的部分内容
      addCopyButtonToMessage(this.streamRenderCtx, el);
    }
    // 全量重置——clear() 后 Map 为空，markStreamingAborted 后续调用会 early return
    // 这是 90s 兜底的预期行为：本地已接管清理，不再接受主进程的延迟 aborted chunk
    this.streamingMessages.clear();
    this.host.setStreaming(false);
    this.host.updateSendButton();
  }

  // ─── 空状态引导 ─────────────────────────────────────────

  /**
   * 初始化空状态引导的事件监听（DOM 绑定下沉到 emptyState.ts）
   *
   * 点击示例问题按钮时，将问题文本填入输入框并触发发送。
   * 对齐 user_rules "主动可见"：示例问题始终可见，引导新用户快速开始对话。
   */
  initEmptyStateListeners(): void {
    initEmptyStateListenersImpl(this.events, () => this.suggestionClickCallback);
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
   * 委托到 components/startupSummaryBanner.ts 的纯函数实现。
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
    renderStartupSummary(summary);
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
    // 使用 EventTracker 统一管理事件监听器，避免内存泄漏
    this.events.addEventListener(btn, 'click', async () => {
      btn.disabled = true;
      btn.textContent = '归档中…';
      try {
        const count = await this.host.archiveSession(date, session);
        btn.textContent = `已归档 ${count} 条记忆`;
        this.host.showToast(`已归档 ${count} 条记忆`, 'success');
        // 1.5 秒后移除按钮（跟踪定时器，cleanup 时统一清理）
        this.archiveButtonTimer = setTimeout(() => {
          btn.remove();
          this.archiveButtonTimer = null;
        }, 1500);
      } catch (err) {
        reportError('ChatPanel', err);
        btn.disabled = false;
        btn.textContent = '归档失败，重试';
      }
    });

    this.messagesEl.insertBefore(btn, this.messagesEl.firstChild);
  }

  // ─── 会话状态横幅（不中断工作模型） ────────────────────

  /**
   * 更新会话状态横幅（暂停/恢复时在消息区顶部显示/隐藏提示）
   *
   * 暂停时：在消息区顶部插入一个提示横幅，告知用户会话已暂停。
   * 恢复时：移除横幅。
   * ERROR 态：显示错误提示（含恢复指引）。
   * 横幅创建后复用，不重复创建。
   *
   * @param status 会话状态：'running' | 'paused' | 'error'
   * @param reason 状态变更原因（可选，用于错误提示文案）
   */
  updateSessionStatus(status: string, reason?: string): void {
    if (status === 'running') {
      // 恢复运行态：移除状态横幅 + 清除可能残留的澄清面板（超时自动续跑后用户未手动关闭）
      if (this.sessionStatusEl) {
        this.sessionStatusEl.remove();
        this.sessionStatusEl = null;
      }
      this.hideClarifyPanel();
      return;
    }

    // PAUSED/ERROR 态：创建或更新横幅
    if (!this.sessionStatusEl) {
      this.sessionStatusEl = document.createElement('div');
      this.sessionStatusEl.className = 'session-status-banner';
      this.messagesEl.insertBefore(this.sessionStatusEl, this.messagesEl.firstChild);
    }

    if (status === 'paused') {
      this.sessionStatusEl.className = 'session-status-banner paused';
      this.sessionStatusEl.innerHTML = `
        <svg class="icon"><use href="#icon-pause"/></svg>
        <span>会话已暂停${reason ? `：${reason}` : ''}</span>
      `;
    } else if (status === 'error') {
      this.sessionStatusEl.className = 'session-status-banner error';
      this.sessionStatusEl.innerHTML = `
        <svg class="icon"><use href="#icon-warning"/></svg>
        <span>会话异常${reason ? `：${reason}` : ''}</span>
        <button class="session-status-recover-btn" data-action="recover-session">恢复</button>
      `;
      // 恢复按钮点击事件
      const recoverBtn = this.sessionStatusEl.querySelector('[data-action="recover-session"]');
      if (recoverBtn) {
        recoverBtn.addEventListener('click', () => {
          void window.electronAPI.recoverSession();
        });
      }
    }
  }

  // ─── 澄清面板（P4 暂停询问） ──────────────────────────

  /**
   * 展示澄清面板（P4 暂停询问）
   *
   * Agent 在 P1-P3 补全链无法填充槽位时，发射 needClarify 事件，
   * 主进程转发到渲染进程后调用此方法展示澄清问题。
   * 面板插入到消息区顶部，包含问题列表 + 选项按钮 + 文本输入 + 提交按钮。
   * 面板创建后复用，不重复创建（调用 hideClarifyPanel 移除）。
   *
   * @param questions 澄清问题数组（每个问题包含 slot/question/options）
   */
  showClarifyPanel(questions: Array<{ slot: string; question: string; options?: string[] }>): void {
    // 移除旧面板（避免重复创建）
    this.hideClarifyPanel();

    const panel = document.createElement('div');
    panel.className = 'clarify-panel';
    panel.id = 'clarify-panel';

    // 标题栏
    const header = document.createElement('div');
    header.className = 'clarify-panel-header';
    header.innerHTML = '<svg class="icon"><use href="#icon-question"/></svg><span>需要补充信息</span>';
    panel.appendChild(header);

    // 存储各问题的输入元素引用，提交时读取
    const inputMap: Map<string, HTMLTextAreaElement | HTMLInputElement> = new Map();

    // 遍历每个问题，构建问题卡片
    for (const q of questions) {
      const card = document.createElement('div');
      card.className = 'clarify-question-card';
      card.dataset.slot = q.slot;

      // 问题文本
      const questionText = document.createElement('div');
      questionText.className = 'clarify-question-text';
      questionText.textContent = q.question;
      card.appendChild(questionText);

      // 选项按钮（若有）
      if (q.options && q.options.length > 0) {
        const optionsRow = document.createElement('div');
        optionsRow.className = 'clarify-options-row';
        for (const opt of q.options) {
          const optBtn = document.createElement('button');
          optBtn.className = 'clarify-option-btn';
          optBtn.textContent = opt;
          optBtn.type = 'button';
          // 点击选项时填入输入框
          optBtn.addEventListener('click', () => {
            const input = inputMap.get(q.slot);
            if (input) {
              input.value = opt;
              input.focus();
            }
          });
          optionsRow.appendChild(optBtn);
        }
        card.appendChild(optionsRow);
      }

      // 文本输入框
      const input = document.createElement('textarea');
      input.className = 'clarify-answer-input';
      input.placeholder = '请输入…';
      input.rows = 2;
      card.appendChild(input);
      inputMap.set(q.slot, input);

      panel.appendChild(card);
    }

    // 提交按钮行
    const actionsRow = document.createElement('div');
    actionsRow.className = 'clarify-actions-row';

    const submitBtn = document.createElement('button');
    submitBtn.className = 'clarify-submit-btn';
    submitBtn.textContent = '提交回答';
    submitBtn.addEventListener('click', () => {
      // 收集所有问题的回答
      const answers: Array<{ slot: string; answer: string }> = [];
      for (const q of questions) {
        const input = inputMap.get(q.slot);
        const answer = input?.value.trim() ?? '';
        if (answer) {
          answers.push({ slot: q.slot, answer });
        }
      }
      if (answers.length === 0) return; // 无回答时忽略
      // 提交回答并关闭面板
      void window.electronAPI.sendClarifyAnswer(answers);
      this.hideClarifyPanel();
    });
    actionsRow.appendChild(submitBtn);

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'clarify-cancel-btn';
    cancelBtn.textContent = '取消';
    cancelBtn.addEventListener('click', () => {
      this.hideClarifyPanel();
    });
    actionsRow.appendChild(cancelBtn);

    panel.appendChild(actionsRow);

    // 插入到消息区顶部（在 sessionStatusBanner 之后，消息之前）
    if (this.sessionStatusEl) {
      this.sessionStatusEl.after(panel);
    } else {
      this.messagesEl.insertBefore(panel, this.messagesEl.firstChild);
    }

    this.clarifyPanelEl = panel;
  }

  /**
   * 隐藏澄清面板
   *
   * 用户提交回答或取消时调用，移除面板 DOM 元素并重置引用。
   */
  hideClarifyPanel(): void {
    if (this.clarifyPanelEl) {
      this.clarifyPanelEl.remove();
      this.clarifyPanelEl = null;
    }
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