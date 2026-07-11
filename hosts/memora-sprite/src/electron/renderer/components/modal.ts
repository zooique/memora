/**
 * 模态框管理模块
 *
 * 职责：
 * - 通用模态框显示/隐藏（showModal/hideModal）
 * - 通用确认弹窗（showConfirmDialog，替代 window.confirm）
 * - 全局模态框事件监听（关闭按钮、背景点击、Escape 键）
 * - 焦点管理（弹窗打开前保存焦点，关闭时恢复）
 *
 * 设计原则：
 * - 独立于 UIManager，通过组合方式持有
 * - 事件监听器纳入跟踪集合，cleanup 时统一清理
 * - 确认弹窗支持并发保护，避免监听器叠加
 */

import { EventTracker } from '../helpers/eventTracker.js';
import { getOptionalElement } from '../helpers/domHelpers.js';
import { showFieldError, clearFieldErrors } from '../helpers/formValidation.js';
import type { ConfirmDialogOptions } from '../types.js';

/**
 * 模态框管理器
 *
 * 独立管理模态框的显示、隐藏和事件监听，UIManager 通过组合持有。
 */
export class ModalManager {
  /**
   * 弹窗焦点栈（支持嵌套弹窗）
   *
   * 嵌套弹窗场景：原 previousFocusEl 是单例字段，内层弹窗的
   * pushFocus 会覆盖外层保存的焦点，导致关闭外层时恢复到内层已隐藏的元素。
   * 采用栈结构，每个弹窗关闭时只 pop 自己对应的焦点，栈自然平衡。
   *
   * 元素类型为 (HTMLElement | null)：document.activeElement 在无焦点时为 null，
   * 栈中保留 null 条目以保证 pop 时栈深度正确（即使焦点无法恢复也不破坏栈平衡）。
   */
  private previousFocusStack: (HTMLElement | null)[] = [];

  /** 当前活跃的确认弹窗清理函数（防止并发调用时监听器叠加） */
  private activeConfirmCleanup: (() => void) | null = null;

  /** 事件监听器跟踪器（统一管理事件监听器的注册与清理，避免内存泄漏） */
  private events = new EventTracker();

  /** 焦点陷阱清理函数栈（支持嵌套弹窗，每个活跃模态对应一个清理函数） */
  private focusTrapCleanups: (() => void)[] = [];

  /**
   * 为指定模态元素启用焦点陷阱（focus trap）
   *
   * 模态打开后，Tab/Shift+Tab 焦点被限制在模态内部循环，不会逃逸到背景元素。
   * 使用 keydown 监听器拦截 Tab 键，在首/末可聚焦元素之间循环。
   *
   * @param modal 需要启用焦点陷阱的模态元素
   */
  private enableFocusTrap(modal: HTMLElement): void {
    // 可聚焦元素选择器（与 showModal 的 firstFocusable 保持一致）
    const focusableSelector =
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

    const onKeydown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      // 每次实时查询可聚焦元素（模态内容可能动态变化）
      const focusables = modal.querySelectorAll<HTMLElement>(focusableSelector);
      if (focusables.length === 0) {
        // 无可聚焦元素时阻止 Tab 逃逸
        e.preventDefault();
        return;
      }
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const activeEl = document.activeElement;

      if (e.shiftKey) {
        // Shift+Tab：从首元素跳到末元素
        if (activeEl === first || !modal.contains(activeEl)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        // Tab：从末元素跳到首元素
        if (activeEl === last || !modal.contains(activeEl)) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    modal.addEventListener('keydown', onKeydown);
    // 记录清理函数，hideModal 时调用
    this.focusTrapCleanups.push(() => {
      modal.removeEventListener('keydown', onKeydown);
    });
  }

  /**
   * 禁用最顶层模态的焦点陷阱（关闭模态时调用）
   */
  private disableTopFocusTrap(): void {
    const cleanup = this.focusTrapCleanups.pop();
    if (cleanup) cleanup();
  }

  /**
   * 保存当前焦点到栈顶（在打开弹窗前调用）
   *
   * 使用栈结构支持嵌套弹窗：A 弹窗 push 焦点 X，B 弹窗 push 焦点 Y，
   * 关闭 B 恢复 Y，关闭 A 恢复 X。
   */
  private pushFocus(): void {
    this.previousFocusStack.push(document.activeElement as HTMLElement | null);
  }

  /**
   * 从栈顶弹出焦点并恢复（在关闭弹窗时调用）
   *
   * 若栈为空或栈顶元素不可聚焦，静默跳过（防御性编程）。
   */
  private popFocus(): void {
    const el = this.previousFocusStack.pop();
    if (el && typeof el.focus === 'function') {
      el.focus();
    }
  }

  /** 初始化弹窗事件监听（关闭按钮、背景点击、Escape 键） */
  initModalListeners(): void {
    // 所有带 data-modal 属性的关闭按钮
    document.querySelectorAll<HTMLElement>('[data-modal]').forEach((btn) => {
      const modalId = btn.dataset.modal;
      if (modalId) {
        this.events.addEventListener(btn, 'click', () => this.hideModal(modalId));
      }
    });

    // 点击弹窗背景关闭（统一使用 hideModal，避免与 showConfirmDialog 冲突）
    document.querySelectorAll<HTMLElement>('.modal').forEach((modal) => {
      this.events.addEventListener(modal, 'click', (e) => {
        if (e.target === modal) {
          this.hideModal(modal.id);
        }
      });
    });

    // 全局 Escape 键关闭弹窗
    // 排除 #confirm-modal 和 #prompt-modal——两者均注册了独立的 onKeydown
    // 处理 Escape（含 e.preventDefault），若全局监听同时触发会导致 onCancel 被调用两次，
    // 造成 resolve 重复或监听器叠加。
    this.events.addEventListener(document, 'keydown', (e: Event) => {
      if ((e as KeyboardEvent).key !== 'Escape') return;
      // 查找当前可见的弹窗（排除有独立 Escape 处理的 confirm/prompt 弹窗）
      const visibleModals = document.querySelectorAll<HTMLElement>(
        '.modal:not(.hidden):not(#confirm-modal):not(#prompt-modal)',
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

    // 保存当前焦点元素到栈，关闭弹窗时恢复
    // 使用栈结构支持嵌套弹窗
    this.pushFocus();

    modal.classList.remove('hidden');
    // aria-modal="true" 动态设置：通知屏幕阅读器进入对话框模式（限制虚拟光标到对话框内）
    // 与 HTML 中静态的 role="dialog" 配合，确保所有模态框（含未来新增）都正确声明语义
    modal.setAttribute('aria-modal', 'true');

    // 启用焦点陷阱：Tab/Shift+Tab 限制在模态内循环
    this.enableFocusTrap(modal);

    // 将焦点移到弹窗内第一个可交互元素
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
    // 移除 aria-modal，避免屏幕阅读器误判隐藏的对话框仍为活跃状态
    modal.removeAttribute('aria-modal');

    // 禁用此模态的焦点陷阱
    this.disableTopFocusTrap();

    // 恢复焦点到触发弹窗的元素（从栈顶弹出）
    // 使用栈结构，嵌套弹窗场景下恢复到正确的触发元素
    this.popFocus();
  }

  /**
   * 显示通用确认弹窗（替代 window.confirm）
   *
   * 返回 Promise，异步等待用户选择：
   * - true：用户点击确认按钮
   * - false：用户点击取消按钮、关闭按钮或背景
   *
   * @param options.title 弹窗标题（默认"确认"）
   * @param options.message 确认消息文本（纯文本，走 textContent 防 XSS）
   * @param options.messageNodes 确认消息 DOM 节点数组（优先于 message，用于富文本展示）
   * @param options.confirmText 确认按钮文本（默认"确定"）
   * @param options.cancelText 取消按钮文本（默认"取消"）
   * @param options.danger 是否危险操作（true 时确认按钮为红色，如删除）
   */
  showConfirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
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
      // 移除 html 选项，统一走 textContent 或 DOM 节点构建，杜绝 XSS 风险点
      messageEl.replaceChildren();
      if (options.messageNodes && options.messageNodes.length > 0) {
        // 调用方通过 createElement + textContent 构建节点，天然防 XSS
        messageEl.append(...options.messageNodes);
      } else {
        messageEl.textContent = options.message;
      }
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

      // 键盘支持：Escape 取消，Enter 确认
      const onKeydown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          onOk(e);
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
        // 禁用焦点陷阱
        this.disableTopFocusTrap();
        // 恢复焦点到触发弹窗的元素（从栈顶弹出）
        this.popFocus();
      };
      const onOk = (e: Event) => { e.stopPropagation(); cleanup(); resolve(true); };
      const onCancel = (e?: Event) => { e?.stopPropagation(); cleanup(); resolve(false); };

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

      // 启用焦点陷阱：Tab/Shift+Tab 限制在确认弹窗内循环
      this.enableFocusTrap(modal);

      // 保存当前焦点到栈 + 将焦点移到确认弹窗
      // 使用栈结构支持嵌套弹窗
      // 危险操作：焦点放在取消按钮上（防止误操作）；普通操作：焦点放在确认按钮上
      this.pushFocus();
      if (options.danger) {
        btnCancel.focus();
      } else {
        btnOk.focus();
      }
    });
  }

  /** 清理所有事件监听器（UIManager.cleanup 时调用） */
  cleanup(): void {
    // 清理所有事件监听器（通过 EventTracker 统一管理）
    this.events.cleanup();
    // 清理活跃的确认弹窗（防止 cleanup 后仍有未完成的 Promise）
    if (this.activeConfirmCleanup) {
      this.activeConfirmCleanup();
      this.activeConfirmCleanup = null;
    }

    // 清理活跃的输入弹窗（防止 cleanup 后仍有未完成的 Promise）
    if (this.activePromptCleanup) {
      this.activePromptCleanup();
      this.activePromptCleanup = null;
    }
  }

  /**
   * Q10 显示写入确认弹窗（构建 DOM 节点并委托到 showConfirmDialog）
   *
   * 在此构建 DOM 节点并委托到 showConfirmDialog，保持 UIManager 门面层纯委托。
   * 使用 createElement + textContent 构建 DOM 节点，从 API 层面杜绝 XSS 风险。
   * 调用方无需也无法传入原始 HTML。
   *
   * @param info 写入确认请求载荷（来自主进程 WRITE_CONFIRMATION 推送）
   * @returns 用户是否确认写入
   */
  async showWriteConfirmation(info: {
    tool: string;
    targetPath: string;
    description?: string;
    /** 文件当前内容预览（null 表示新文件，undefined 表示未提供） */
    beforeContent?: string | null;
    /** 写入后内容预览（undefined 表示未提供） */
    afterContent?: string;
  }): Promise<boolean> {
    // 使用 DOM API 构建富文本消息，所有动态值通过 textContent 设置天然防 XSS
    const container = document.createElement('div');
    container.className = 'write-confirm-info';

    // 工具行
    const toolP = document.createElement('p');
    const toolLabel = document.createElement('strong');
    toolLabel.textContent = '工具：';
    toolP.appendChild(toolLabel);
    toolP.appendChild(document.createTextNode(info.tool));
    container.appendChild(toolP);

    // 路径行
    const pathP = document.createElement('p');
    const pathLabel = document.createElement('strong');
    pathLabel.textContent = '路径：';
    pathP.appendChild(pathLabel);
    const codeEl = document.createElement('code');
    codeEl.textContent = info.targetPath;
    pathP.appendChild(codeEl);
    container.appendChild(pathP);

    // 描述行（可选）
    if (info.description) {
      const descP = document.createElement('p');
      descP.textContent = info.description;
      container.appendChild(descP);
    }

    // 变更内容预览（可选，仅当携带 beforeContent/afterContent 时展示）
    // 使用 <details> 折叠区，默认折叠避免弹窗过高
    if (info.beforeContent !== undefined || info.afterContent !== undefined) {
      const diffSection = document.createElement('details');
      diffSection.className = 'write-confirm-diff';

      const summary = document.createElement('summary');
      summary.textContent = '查看变更内容';
      diffSection.appendChild(summary);

      // 变更前内容（null 表示新文件，无原有内容）
      if (info.beforeContent !== undefined) {
        const beforeLabel = document.createElement('p');
        beforeLabel.className = 'write-confirm-diff-label';
        beforeLabel.textContent = info.beforeContent === null ? '变更前（新文件）' : '变更前';
        diffSection.appendChild(beforeLabel);

        if (info.beforeContent !== null) {
          const beforePre = document.createElement('pre');
          beforePre.className = 'write-confirm-diff-content';
          beforePre.textContent = info.beforeContent;
          diffSection.appendChild(beforePre);
        }
      }

      // 变更后内容
      if (info.afterContent !== undefined) {
        const afterLabel = document.createElement('p');
        afterLabel.className = 'write-confirm-diff-label';
        afterLabel.textContent = '变更后';
        diffSection.appendChild(afterLabel);

        const afterPre = document.createElement('pre');
        afterPre.className = 'write-confirm-diff-content';
        afterPre.textContent = info.afterContent;
        diffSection.appendChild(afterPre);
      }

      container.appendChild(diffSection);
    }

    return this.showConfirmDialog({
      title: '确认写入操作',
      message: '', // messageNodes 优先，message 仅作 fallback 文本
      messageNodes: [container],
      confirmText: '允许写入',
      cancelText: '取消',
    });
  }

  /**
   * 显示通用输入弹窗（替代 window.prompt）
   *
   * 返回 Promise，异步等待用户输入：
   * - string：用户输入的内容（已 trim）
   * - null：用户点击取消、关闭按钮或背景
   *
   * @param options.title 弹窗标题（默认"输入"）
   * @param options.message 提示消息文本
   * @param options.defaultValue 输入框默认值（可选）
   * @param options.placeholder 输入框占位文本（可选）
   * @param options.maxLength 输入最大长度（默认 100）
   * @param options.required 是否必填（默认 true，空值视为取消）
   */
  showInputDialog(options: {
    title?: string;
    message: string;
    defaultValue?: string;
    placeholder?: string;
    maxLength?: number;
    required?: boolean;
  }): Promise<string | null> {
    return new Promise((resolve) => {
      const modal = document.getElementById('prompt-modal');
      const titleEl = document.getElementById('prompt-title');
      const messageEl = document.getElementById('prompt-message');
      const inputEl = getOptionalElement('prompt-input', 'input');
      // 错误容器存在性检查（实际读写由 formValidation.ts 公共函数完成）
      const errorElExists = document.getElementById('prompt-input-error') !== null;
      const btnOk = document.getElementById('btn-prompt-ok');
      const btnCancel = document.getElementById('btn-prompt-cancel');
      if (!modal || !titleEl || !messageEl || !inputEl || !errorElExists || !btnOk || !btnCancel) {
        // 元素缺失时回退为 window.prompt（防御性编程）
        const fallback = window.prompt(options.message, options.defaultValue ?? '');
        resolve(fallback?.trim() || null);
        return;
      }

      // 设置弹窗内容
      titleEl.textContent = options.title ?? '输入';
      messageEl.textContent = options.message;
      inputEl.value = options.defaultValue ?? '';
      inputEl.placeholder = options.placeholder ?? '';
      inputEl.maxLength = options.maxLength ?? 100;
      // 清空上次的错误状态（aria-invalid + 错误文本）
      clearFieldErrors(['prompt-input']);
      const isRequired = options.required ?? true;

      // 并发保护：若已有活跃弹窗，先取消旧的
      if (this.activePromptCleanup) {
        this.activePromptCleanup();
        this.activePromptCleanup = null;
      }

      let resolved = false;

      // 键盘支持：Escape 取消，Enter 确认
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
        this.activePromptCleanup = null;
        // 禁用焦点陷阱
        this.disableTopFocusTrap();
        // 恢复焦点到触发弹窗的元素（从栈顶弹出）
        this.popFocus();
      };

      const onOk = () => {
        const value = inputEl.value.trim();
        // 必填校验：空值通过公共 showFieldError 标记 aria-invalid + 显示错误文本
        if (isRequired && !value) {
          showFieldError('prompt-input', '输入不能为空').focus();
          return;
        }
        cleanup();
        resolve(value || null);
      };

      const onCancel = () => { cleanup(); resolve(null); };

      // 注册活跃清理函数，供下次并发调用时取消旧弹窗
      this.activePromptCleanup = () => { cleanup(); resolve(null); };

      // 注册监听器
      btnOk.addEventListener('click', onOk);
      btnCancel.addEventListener('click', onCancel);
      modal.addEventListener('keydown', onKeydown);
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

      // 启用焦点陷阱：Tab/Shift+Tab 限制在输入弹窗内循环
      this.enableFocusTrap(modal);

      // 保存当前焦点到栈，将焦点移到输入框并选中全部文本（方便快速替换）
      // 使用栈结构支持嵌套弹窗
      this.pushFocus();
      inputEl.focus();
      inputEl.select();
    });
  }

  /** 当前活跃的输入弹窗清理函数（防止并发调用时监听器叠加） */
  private activePromptCleanup: (() => void) | null = null;
}
