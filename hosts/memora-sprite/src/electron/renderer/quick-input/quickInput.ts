/**
 * 快速输入浮窗渲染逻辑 — 用户交互入口（三键分工模式）
 *
 * 职责：
 *   1. 绑定输入框键盘事件：Tab 提交、Esc 关闭、Enter 换行
 *   2. Tab 单一提交：将输入框内容粘贴到目标应用（优先自动粘贴，降级写剪贴板）
 *   3. 窗口重新显示时处理剪贴板预填并聚焦
 *   4. 接入补全管理器，输入时显示候选列表
 *   5. 确认成功后显示 Toast，延迟关闭
 *
 * 三键分工：
 *   - ↑↓：在候选列表中导航选择（由 quickInputCompletion.ts 处理）
 *   - ←→：将选中候选项填充到输入框（由 quickInputCompletion.ts 处理）
 *   - Tab：提交输入框内容（本文件处理）
 *
 * 设计原则：
 *   - 使用 Pick<ElectronAPI, ...> 提取子集（与 float.ts 范式一致）
 *   - Tab 是唯一提交按钮，Enter 用于换行
 *   - 确认期间禁用输入框，防止重复触发
 *   - 补全管理器独立封装在 quickInputCompletion.ts，保持职责单一
 *
 * 集成点：
 *   - quick-input.html：通过 <script type="module"> 加载
 *   - preload.ts：暴露 confirmQuickInput / closeQuickInput / searchMemories / searchSessionMessages
 *   - quickInputWindow.ts：主进程处理 IPC，自动粘贴优先
 *   - quickInputCompletion.ts：补全候选管理器
 */
import type { ElectronAPI } from '../../preload.js';
import '../types.js';
import { reportError } from '../helpers/errorHelpers.js';
import { QuickInputCompletion } from './quickInputCompletion.js';

/**
 * 快速输入浮窗所需的 ElectronAPI 子集
 */
export type QuickInputElectronAPI = Pick<
  ElectronAPI,
  | 'confirmQuickInput' | 'closeQuickInput'
  | 'searchMemories' | 'searchSessionMessages' | 'resizeQuickInput'
  | 'onQuickInputShow' | 'removeQuickInputShowListener'
>;

/**
 * 初始化快速输入浮窗交互
 */
function initQuickInput(): void {
  const inputEl = document.getElementById('quick-input-field');
  if (!(inputEl instanceof HTMLTextAreaElement)) {
    reportError('QuickInput init', new Error('quick-input-field 元素缺失或类型错误（应为 textarea）'));
    return;
  }
  const completionList = document.getElementById('completion-list');

  const electronApi = (window as unknown as { electronAPI?: QuickInputElectronAPI }).electronAPI;
  if (!electronApi) {
    reportError('QuickInput init', new Error('electronAPI 未注入（preload 加载失败）'));
    return;
  }

  const inputField: HTMLTextAreaElement = inputEl;
  const counterEl = document.querySelector('.quick-input-counter');
  const api: QuickInputElectronAPI = electronApi;

  /** 是否正在提交（防止重复确认） */
  let isSubmitting = false;
  /** 补全管理器实例 */
  let completion: QuickInputCompletion | null = null;
  /** 当前输入区基础高度（不含候选列表） */
  let baseInputHeight = 72;

  /** Toast 显示时长（ms） */
  const TOAST_DURATION_MS = 800;
  /** Toast 自动关闭定时器句柄 */
  let toastCloseTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * 确认输入：调用 IPC（主进程优先自动粘贴，降级写剪贴板）+ 显示 Toast + 延迟关闭
   */
  async function handleConfirm(): Promise<void> {
    if (isSubmitting) return;
    const text = inputField.value;
    if (!text.trim()) {
      await api.closeQuickInput();
      return;
    }

    isSubmitting = true;
    inputField.disabled = true;
    showPastingToast();

    try {
      const result = await api.confirmQuickInput(text);
      if (result.success) {
        if (result.mode === 'paste') {
          showPastedToast(result.appName);
        } else {
          showCopyToast();
        }
        toastCloseTimer = setTimeout(() => {
          toastCloseTimer = null;
          void api.closeQuickInput();
        }, TOAST_DURATION_MS);
      } else {
        isSubmitting = false;
        inputField.disabled = false;
        inputField.readOnly = false;
        inputField.classList.remove('copy-toast');
        inputField.value = text;
        inputField.focus();
      }
    } catch (error) {
      reportError('QuickInput 确认', error);
      isSubmitting = false;
      inputField.disabled = false;
      inputField.readOnly = false;
      inputField.classList.remove('copy-toast');
      inputField.value = text;
      inputField.focus();
    }
  }

  /**
   * 显示"粘贴中..."loading 状态
   */
  function showPastingToast(): void {
    inputField.value = '粘贴中...';
    inputField.classList.add('copy-toast');
    inputField.disabled = false;
    inputField.readOnly = true;
  }

  /**
   * 显示"已粘贴"Toast（自动粘贴成功）
   */
  function showPastedToast(appName?: string): void {
    inputField.value = appName ? `✓ 已粘贴到 ${appName}` : '✓ 已粘贴';
    inputField.classList.add('copy-toast');
    inputField.disabled = false;
    inputField.readOnly = true;
  }

  /**
   * 显示"已复制"Toast（降级模式）
   */
  function showCopyToast(): void {
    inputField.value = '✓ 已复制，Ctrl+V 粘贴';
    inputField.classList.add('copy-toast');
    inputField.disabled = false;
    inputField.readOnly = true;
  }

  /**
   * 自动调整 textarea 高度（随内容增长，最多 5 行）
   *
   * 实现原理：先将高度重置为 auto，再设置为 scrollHeight，
   * 这样 textarea 会恰好包裹内容，不会出现多余空白。
   */
  function autoResize(): void {
    const prevHeight = inputField.offsetHeight;
    inputField.style.height = 'auto';
    inputField.style.height = `${inputField.scrollHeight}px`;
    const newHeight = inputField.offsetHeight;

    // 高度变化时，更新基础高度并通知主进程调整窗口
    if (newHeight !== prevHeight) {
      // 基础高度 = textarea高度 + 上下padding + 底部栏高度 + 容器padding
      baseInputHeight = newHeight + 36;
      resizeWindow();
    }
  }

  /**
   * 更新字符计数显示
   */
  function updateCounter(): void {
    if (counterEl instanceof HTMLElement) {
      counterEl.textContent = `${inputField.value.length} 字`;
    }
  }

  /**
   * 根据当前状态调整窗口高度
   *
   * 考虑两种情况：
   *   - 无候选列表：高度 = 基础输入区高度
   *   - 有候选列表：高度 = 基础输入区高度 + 候选列表高度
   */
  function resizeWindow(): void {
    if (completionList && !completionList.classList.contains('hidden')) {
      const itemCount = completionList.querySelectorAll('.completion-item').length;
      const hasFooter = completionList.dataset.footer === 'true';
      const footerHeight = hasFooter ? 28 : 0;
      const targetHeight = baseInputHeight + Math.min(itemCount, 5) * 38 + footerHeight;
      void api.resizeQuickInput(targetHeight).catch((e: unknown) => reportError('QuickInput-resize', e));
    } else {
      void api.resizeQuickInput(baseInputHeight).catch((e: unknown) => reportError('QuickInput-resize', e));
    }
  }

  /**
   * 关闭浮窗：清理 Toast 定时器 + 调用 IPC 通知主进程隐藏窗口
   */
  async function handleClose(): Promise<void> {
    if (toastCloseTimer !== null) {
      clearTimeout(toastCloseTimer);
      toastCloseTimer = null;
    }
    try {
      await api.closeQuickInput();
    } catch (error) {
      reportError('QuickInput', error);
    }
  }

  /**
   * Tab 键处理：直接提交输入框内容
   *
   * Tab 是唯一的提交按钮，功能简单明确。
   * 候选项的填充由 ←→ 方向键完成（见 quickInputCompletion.ts）。
   *
   * 在 keyup 阶段执行确认，避免 Tab 的 keyup 事件泄漏到原窗口（如微信）。
   */
  function handleTab(): void {
    if (isSubmitting) return;
    void handleConfirm();
  }

  /** Tab 键已按下（keydown 中标记，keyup 中消费） */
  let tabPressed = false;

  // 输入框键盘事件：Tab 提交（keydown 标记 + keyup 执行）、Esc 关闭
  inputField.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      tabPressed = true;
    } else if (e.key === 'Escape') {
      e.preventDefault();
      void handleClose();
    }
  });

  // Tab 确认在 keyup 阶段执行，确保事件不泄漏到原窗口
  inputField.addEventListener('keyup', (e: KeyboardEvent) => {
    if (e.key === 'Tab' && tabPressed) {
      tabPressed = false;
      handleTab();
    }
  });

  // 输入时自动调整高度 + 更新字符计数
  inputField.addEventListener('input', () => {
    autoResize();
    updateCounter();
  });

  // 初始化补全管理器（候选列表容器存在时才启用补全）
  if (completionList instanceof HTMLElement) {
    completion = new QuickInputCompletion(inputField, completionList, api);
    // ←→ 填充选中项到输入框：覆盖现有内容 + 聚焦 + 调整高度/计数
    completion.onSelect((text) => {
      inputField.value = text;
      inputField.focus();
      // 光标移到末尾，方便用户继续编辑或直接 Tab 提交
      const len = inputField.value.length;
      inputField.setSelectionRange(len, len);
      autoResize();
      updateCounter();
    });
    // 候选列表显示/隐藏时，通知主进程调整窗口高度
    completion.onListChange(() => {
      resizeWindow();
    });
    completion.init();
  }

  // 浮窗被主进程 show() 调用时处理剪贴板预填并聚焦
  api.onQuickInputShow((payload) => {
    if (toastCloseTimer !== null) {
      clearTimeout(toastCloseTimer);
      toastCloseTimer = null;
    }
    inputField.readOnly = false;
    inputField.classList.remove('copy-toast');
    tabPressed = false;

    const preset = payload?.clipboardText;
    if (preset) {
      inputField.value = preset;
      inputField.select();
      inputField.dispatchEvent(new Event('input'));
    } else {
      inputField.value = '';
      // 清空后重置高度
      inputField.style.height = 'auto';
      updateCounter();
      baseInputHeight = 72;
      resizeWindow();
    }
    isSubmitting = false;
    inputField.disabled = false;
    inputField.focus();
  });

  inputField.focus();
  // 初始化：更新字符计数 + 调整初始高度
  updateCounter();
  autoResize();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initQuickInput);
} else {
  initQuickInput();
}