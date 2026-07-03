/**
 * 归档按钮管理器（QC-R2-12 从 chatPanelManager.ts 拆分）
 *
 * 职责：
 * - 在 manual 归档模式下为已完成的 assistant 消息追加"归档"按钮
 * - 处理归档按钮点击：查找前一条 user 消息 → 提取文本 → 触发归档 → 反馈结果
 *
 * 提取原因：
 *   chatPanelManager.ts 1576 行超标（QC-R2-12），归档按钮相关逻辑
 *   _addArchiveButtonToMessage / _handleArchiveClick / _findPreviousUserMessage
 *   约 130 行是 manual 模式专用子功能，与核心消息渲染/流式输出逻辑耦合度低，
 *   提取为独立 Manager 降低 chatPanelManager 体量。
 *
 * 设计原则：
 * - 遵循 ClipboardManager / InputAreaManager 同模式：Host 接口注入 + 独立生命周期
 * - 不持有事件监听器（按钮点击通过 chatPanelManager 事件委托统一分发，
 *   data-action="archive" 触发后调用 handleClick），无需 EventTracker
 * - 提供空 cleanup() 与其他 Manager 保持统一生命周期接口
 */

import type { ToastType } from '../types.js';

// ─── Host 接口（跨模块关注点注入） ────────────────────────

/**
 * 归档按钮管理器需要的宿主能力（跨模块关注点，由 UIManager/ChatPanelManager 注入）
 *
 * 复用 ChatPanelHost 中已定义的方法，避免重复声明归档相关契约。
 */
export interface ArchiveButtonHost {
  /**
   * 查询当前归档模式（manual 模式下才渲染归档按钮）
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
  /** 显示 toast 通知 */
  showToast(message: string, type?: ToastType, duration?: number): void;
}

// ─── 归档按钮管理器类 ─────────────────────────────────────

/**
 * 归档按钮管理器类
 *
 * 职责：manual 模式下为 assistant 消息渲染归档按钮 + 处理点击归档
 * 依赖：ArchiveButtonHost（getArchiveMode / archiveConversation / showToast）
 * 生命周期：无事件监听器，cleanup() 为空实现
 */
export class ArchiveButtonManager {
  /**
   * 构造函数：注入宿主能力
   *
   * @param host 宿主能力注入（归档模式查询 + 归档触发 + toast 反馈）
   */
  constructor(
    /** 宿主能力引用（归档模式查询 + 归档触发 + toast 反馈） */
    private readonly host: ArchiveButtonHost,
  ) {}

  /**
   * 为 assistant 消息追加"归档"按钮（manual 模式专用）
   *
   * 由 ChatPanelManager._addCopyButtonToMessage 在消息完成后调用，
   * 仅当 archiveMode === 'manual' 时才实际渲染按钮。
   * 按钮通过 data-action="archive" 标识，点击事件由 chatPanelManager
   * 构造函数中的事件委托统一分发到 handleClick。
   *
   * @param el 当前 assistant 消息 DOM 元素（.message.assistant）
   * @param copyBtn 已添加的复制按钮（用于确定归档按钮插入位置——紧随其后）
   * @param metaRow 元信息行（按钮容器，copyBtn 父节点失效时的兜底插入点）
   */
  maybeAddArchiveButton(
    el: HTMLElement,
    copyBtn: HTMLButtonElement,
    metaRow: Element | null,
  ): void {
    // 仅 manual 模式才渲染归档按钮
    if (this.host.getArchiveMode() !== 'manual') return;
    // 仅 assistant 消息才渲染
    if (!el.classList.contains('assistant')) return;

    // 幂等保护：已存在归档按钮则跳过
    if (el.querySelector('.message-archive-btn')) return;

    // 构建归档按钮 DOM
    const archiveBtn = document.createElement('button');
    archiveBtn.className = 'message-archive-btn';
    archiveBtn.title = '归档到记忆（manual 模式）';
    archiveBtn.innerHTML = '<svg class="icon"><use href="#icon-bookmark"/></svg>';
    // 事件委托模式：通过 data-action 统一分发到 handleClick
    archiveBtn.dataset.action = 'archive';

    // 插入到复制按钮之后（保持视觉顺序：复制 → 归档）
    if (copyBtn.parentNode) {
      copyBtn.parentNode.insertBefore(archiveBtn, copyBtn.nextSibling);
    } else if (metaRow) {
      // 兜底：copyBtn 父节点失效时追加到 metaRow
      metaRow.appendChild(archiveBtn);
    }
  }

  /**
   * 处理归档按钮点击（manual 模式专用）
   *
   * 从 DOM 中查找当前 assistant 消息的前一条 user 消息内容作为输入，
   * 与 assistant 回复一起触发 host.archiveConversation。
   * 归档完成后显示 toast 反馈条目数，并禁用按钮防止重复归档。
   *
   * 由 chatPanelManager 构造函数中的事件委托调用：
   *   data-action="archive" → handleClick(archiveBtn)
   *
   * @param archiveBtn 被点击的归档按钮元素
   */
  async handleClick(archiveBtn: HTMLElement): Promise<void> {
    // 查找当前消息元素（.message.assistant）
    const messageEl = archiveBtn.closest<HTMLElement>('.message.assistant');
    if (!messageEl) return;

    // 向上查找前一条 user 消息（同一消息组或前一个消息组）
    const userMessageEl = this.findPreviousUserMessage(messageEl);
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
    // 移除 UI 元信息元素，避免污染归档内容
    clone.querySelectorAll(
      '.memory-recall, .stream-aborted, .stream-error, .thinking-phase, .md-code-header',
    ).forEach((node) => node.remove());
    const assistantContent = clone.textContent ?? '';

    // 禁用按钮，防止归档期间重复点击
    archiveBtn.setAttribute('disabled', '');
    archiveBtn.classList.add('archiving');

    try {
      // 触发归档（profile facts + insight 一次性提取）
      const count = await this.host.archiveConversation(userInput, assistantContent);
      if (count > 0) {
        this.host.showToast(`已归档 ${count} 条记忆`, 'success', 2000);
        archiveBtn.classList.add('archived');
        archiveBtn.title = '已归档';
      } else {
        // 未提取到有价值信息，恢复按钮允许重试
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
   * 从当前消息元素向上查找前一条 user 消息（辅助方法）
   *
   * 消息可能分组（.message-group）或独立（直接在 messagesEl 下），
   * 需要跨分组边界查找最近的 .message.user 元素。
   *
   * @param startEl 起始消息元素（通常是 assistant 消息）
   * @returns 最近的 user 消息元素，未找到返回 null
   */
  private findPreviousUserMessage(startEl: HTMLElement): HTMLElement | null {
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
      if (
        current instanceof HTMLElement &&
        current.classList.contains('message') &&
        current.classList.contains('user')
      ) {
        return current;
      }
    }
    return null;
  }

  /**
   * 清理资源
   *
   * ArchiveButtonManager 不持有事件监听器，无需实际清理。
   * 提供空实现以与其他 Manager 保持统一的生命周期接口。
   */
  cleanup(): void {
    // 无需清理——按钮事件由 chatPanelManager 事件委托统一管理
  }
}
