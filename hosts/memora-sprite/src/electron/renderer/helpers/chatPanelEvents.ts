/**
 * 聊天面板事件监听器初始化辅助（从 chatPanelManager.ts 提取）
 *
 * 职责：
 *   将聊天面板 constructor 中内联的事件委托逻辑集中到本模块，降低 chatPanelManager.ts 体量。
 *   涵盖：
 *   - click 委托（13 个 data-action 分支：copy/copy-code/dismiss-truncation/
 *     toggle-recall/recall/toggle-collapse/load-more/load-earlier-day/retry/
 *     close-milestone/archive）
 *   - contextmenu 委托（消息气泡右键菜单定位 + 状态设置）
 *   - document click（关闭右键菜单 + 菜单项分发：copy/regenerate/forget）
 *   - keydown 委托（键盘可访问性：Enter/Space 触发 recall/toggle-collapse）
 *
 * 提取原因：
 *   chatPanelManager.ts 超阈值 1500 行（F-LINE-1），constructor 293 行（17%）
 *   内联 4 个事件委托逻辑，属典型的胖构造函数反模式。
 *   复用 HC-24 的 memoryPanelEvents.ts 同构提取模式。
 *
 * 设计：
 *   - 纯函数模块，不持有状态，所有依赖通过 ChatPanelEventContext 注入
 *   - 回调通过 getter 函数读取（运行时获取最新值，因为 onXxx 注册晚于 init 调用）
 *   - 所有事件监听器纳入 EventTracker 统一管理，避免内存泄漏
 *   - 消息操作（regenerate/forget）委托到 helpers/messageOperations.ts
 */

import { setIcon } from './icon.js';
import { reportError } from './errorHelpers.js';
import { handleRegenerate, handleForget } from './messageOperations.js';
import { TOAST_SHORT_MS } from '../../../sprite/constants.js';
import type { EventTracker } from './eventTracker.js';
// 类型仅导入：运行时不会产生循环依赖（type-only 在编译期擦除）
import type { ChatPanelHost } from '../panels/chatPanelManager.js';

// ─── 上下文接口（依赖注入容器） ────────────────────────────

/**
 * 聊天面板事件初始化所需的上下文
 *
 * 由 ChatPanelManager constructor 构建并传入。
 * 设计为接口而非直接传入 manager 实例，避免运行时循环依赖并便于独立测试。
 */
export interface ChatPanelEventContext {
  /** 消息容器 DOM 元素（click/contextmenu/keydown 委托的根元素） */
  readonly messagesEl: HTMLElement;
  /** 事件跟踪器（统一管理监听器注册与清理） */
  readonly events: EventTracker;
  /** 宿主能力（提供 showToast + 消息操作所需的 host 回调） */
  readonly host: ChatPanelHost;
  /** 归档按钮管理器（处理 data-action="archive" 委托） */
  readonly archiveButtonManager: {
    handleClick(btn: HTMLElement): Promise<void>;
  };
  // ─── 回调 getter（运行时读取最新值，因为 onXxx 注册晚于 init 调用） ───
  /** 召回记忆点击回调 getter */
  getMemoryRecallClickCallback(): ((memoryId: string) => void) | null;
  /** 加载更多按钮回调 getter */
  getLoadMoreCallback(): (() => void) | null;
  /** 加载更早日期按钮回调 getter */
  getLoadEarlierDayCallback(): (() => void) | null;
  /** 错误重试回调 getter */
  getErrorRetryCallback(): (() => void) | null;
}

/**
 * 显示消息右键菜单（鼠标右键 + 键盘 Shift+F10 共用）
 *
 * 提取为独立函数，供 contextmenu 事件和 keydown（Shift+F10/Menu 键）复用。
 * 根据消息角色设置菜单项可用性，并定位到指定坐标（超出视口时自动调整）。
 *
 * @param messageEl 被操作的消息元素（.message.user 或 .message.assistant）
 * @param x 菜单显示位置（屏幕 X）
 * @param y 菜单显示位置（屏幕 Y）
 */
function showMessageContextMenu(messageEl: HTMLElement, x: number, y: number): void {
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
  let menuX = x;
  let menuY = y;

  if (menuX + rect.width > window.innerWidth) {
    menuX = window.innerWidth - rect.width - 8;
  }
  if (menuY + rect.height > window.innerHeight) {
    menuY = window.innerHeight - rect.height - 8;
  }

  menu.style.left = `${menuX}px`;
  menu.style.top = `${menuY}px`;
  menu.classList.remove('hidden');
}

/**
 * 初始化聊天面板事件监听器
 *
 * 注册 4 类事件委托：
 * 1. messagesEl click：13 个 data-action 分发
 * 2. messagesEl contextmenu：右键菜单定位 + 状态设置
 * 3. document click：关闭右键菜单 + 菜单项分发（copy/regenerate/forget）
 * 4. messagesEl keydown：键盘可访问性（Enter/Space 触发 recall/toggle-collapse，
 *    Shift+F10/Menu 键触发右键菜单）
 *
 * @param ctx 事件初始化上下文
 */
export function initChatPanelEvents(ctx: ChatPanelEventContext): void {
  const { messagesEl, events, host, archiveButtonManager } = ctx;

  // ─── 1. click 委托：13 个 data-action 分发 ─────────────────
  events.addEventListener(messagesEl, 'click', (e: Event) => {
    const target = e.target as HTMLElement;
    // 复制按钮：data-action="copy" data-content="..."
    const copyBtn = target.closest<HTMLElement>('[data-action="copy"]');
    if (copyBtn) {
      const content = copyBtn.dataset.content ?? '';
      navigator.clipboard.writeText(content).then(
        () => {
          host.showToast('已复制到剪贴板', 'success', 1500);
          // 短暂内联反馈：切换为勾选图标，1s 后恢复复制图标
          setIcon(copyBtn, 'icon-check');
          copyBtn.classList.add('copied');
          window.setTimeout(() => {
            setIcon(copyBtn, 'icon-copy');
            copyBtn.classList.remove('copied');
          }, 1000);
        },
        () => host.showToast('复制失败，请手动选择文本复制', 'error'),
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
          host.showToast('已复制代码', 'success', TOAST_SHORT_MS);
          // 短暂反馈：按钮文本切换为"已复制"，1.2s 后恢复
          const originalText = copyCodeBtn.textContent;
          copyCodeBtn.textContent = '已复制';
          copyCodeBtn.classList.add('copied');
          window.setTimeout(() => {
            copyCodeBtn.textContent = originalText;
            copyCodeBtn.classList.remove('copied');
          }, 1200);
        },
        () => host.showToast('复制失败，请手动选择代码复制', 'error'),
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
        ctx.getMemoryRecallClickCallback()?.(memoryId);
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
    const loadMoreCallback = ctx.getLoadMoreCallback();
    if (loadMoreBtn && loadMoreCallback) {
      loadMoreBtn.setAttribute('disabled', '');
      loadMoreBtn.textContent = '加载中...';
      loadMoreCallback();
      return;
    }
    // 加载更早日期按钮：data-action="load-earlier-day"
    const loadEarlierBtn = target.closest<HTMLElement>('[data-action="load-earlier-day"]');
    const loadEarlierDayCallback = ctx.getLoadEarlierDayCallback();
    if (loadEarlierBtn && loadEarlierDayCallback) {
      loadEarlierBtn.setAttribute('disabled', '');
      loadEarlierBtn.textContent = '加载中...';
      loadEarlierDayCallback();
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
          await ctx.getErrorRetryCallback()?.();
        } catch (err) {
          // 错误处理由 errorRetryCallback 内部负责（如 toast 提示），
          // 此处仅需恢复按钮状态，吞掉 rejection 避免 unhandled rejection
          // 补充 warn 日志兜底，防止回调未处理时异常被完全吞没
          reportError('ChatPanel errorRetryCallback', err);
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
    // 归档按钮 data-action="archive"（manual 模式下触发手动归档）
    // 委托到 ArchiveButtonManager.handleClick
    const archiveBtn = target.closest<HTMLElement>('[data-action="archive"]');
    if (archiveBtn) {
      void archiveButtonManager.handleClick(archiveBtn);
      return;
    }
  });

  // ─── 2. contextmenu 委托：消息气泡右键菜单定位 + 状态设置 ───
  events.addEventListener(messagesEl, 'contextmenu', (e: Event) => {
    const me = e as MouseEvent;
    const target = e.target as HTMLElement;
    const messageEl = target.closest<HTMLElement>('.message');
    if (!messageEl || messageEl.classList.contains('system')) {
      return;
    }

    e.preventDefault();
    showMessageContextMenu(messageEl, me.clientX, me.clientY);
  });

  // ─── 3. document click：关闭右键菜单 + 菜单项分发 ─────────
  events.addEventListener(document, 'click', () => {
    const menu = document.getElementById('message-context-menu');
    if (menu && !menu.classList.contains('hidden')) {
      menu.classList.add('hidden');
    }
  });

  // 右键菜单项点击处理
  events.addEventListener(document, 'click', (e: Event) => {
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
          () => host.showToast('已复制到剪贴板', 'success', TOAST_SHORT_MS),
          () => host.showToast('复制失败', 'error'),
        );
        break;
      case 'regenerate':
        if (role === 'assistant') {
          const messageEl = messageId
            ? messagesEl.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`)
            : null;
          if (messageEl) {
            handleRegenerate({ host }, messageEl);
          }
        }
        break;
      case 'forget':
        if (messageId) {
          const messageEl = messagesEl.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`);
          if (messageEl) {
            // fire-and-forget：handleForget 内部弹确认弹窗，无需等待
            void handleForget({ host }, messageId, messageEl);
          }
        }
        break;
    }
  });

  // ─── 4. keydown 委托：键盘可访问性（Shift+F10 触发右键菜单） ───
  events.addEventListener(messagesEl, 'keydown', (e: Event) => {
    const ke = e as KeyboardEvent;
    const target = ke.target as HTMLElement;

    // Shift+F10 或 ContextMenu 键触发右键菜单（键盘用户等价操作）
    if ((ke.shiftKey && ke.key === 'F10') || ke.key === 'ContextMenu') {
      const messageEl = target.closest<HTMLElement>('.message');
      if (messageEl && !messageEl.classList.contains('system')) {
        ke.preventDefault();
        // 键盘触发时无鼠标坐标，用消息元素的几何中心定位菜单
        const rect = messageEl.getBoundingClientRect();
        showMessageContextMenu(messageEl, rect.left, rect.bottom);
      }
      return;
    }

    // recall / toggle-recall / toggle-collapse 均已使用原生 <button>，
    // Enter/Space 由原生 click 自动触发，无需手动处理（click 委托统一分发）
  });
}
