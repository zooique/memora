/**
 * 快速输入浮窗渲染逻辑 — 用户交互入口（三键分工 + 流式模式）
 *
 * 职责：
 *   1. 绑定输入框键盘事件：Tab 提交、Esc 关闭、Enter 换行
 *   2. Tab 单一提交：将输入框内容粘贴到目标应用（优先自动粘贴，降级写剪贴板）
 *   3. 窗口重新显示时处理剪贴板预填 + 敏感自动检测并聚焦
 *   4. 接入补全管理器，输入时显示候选列表
 *   5. 确认成功后显示 Toast，延迟关闭
 *   6. 流式模式：粘贴成功后窗口保持打开，清空输入等待下次输入
 *
 * 三键分工：
 *   - ↑↓：在候选列表中导航选择（由 quickInputCompletion.ts 处理）
 *   - ←→：将选中候选项填充到输入框（由 quickInputCompletion.ts 处理）
 *   - Tab：提交输入框内容（本文件处理）
 *
 * 流式模式：
 *   - 自动检测：剪贴板内容命中 isSensitive() 时自动启用
 *   - 手动切换：footer 栏切换按钮（🔒/🔓）覆盖自动检测
 *   - 流式模式下 Tab 提交后：粘贴成功 → 短暂 Toast → 清空输入 → 聚焦等待
 *   - Esc 始终关闭窗口（流式模式也不例外）
 *
 * 集成点：
 *   - quick-input.html：通过 <script type="module"> 加载
 *   - preload.ts：暴露 confirmQuickInput / closeQuickInput / searchMemories / searchSessionMessages
 *   - quickInputWindow.ts：主进程处理 IPC，自动粘贴优先（流式模式跳过 hideFloat）
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

/** 流式模式 Toast 显示时长（ms），比普通模式短，快速恢复输入状态 */
const STREAM_TOAST_MS = 500;

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
  const streamToggle = document.getElementById('stream-toggle');

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

  /** 流式模式：粘贴成功后窗口保持打开，供连续输入 */
  let streamMode = false;

  /**
   * 更新流式模式切换按钮视觉状态
   */
  function updateStreamToggle(): void {
    if (!(streamToggle instanceof HTMLElement)) return;
    if (streamMode) {
      streamToggle.textContent = '🔒';
      streamToggle.classList.add('active');
      streamToggle.title = '流式模式开启：粘贴后保持窗口打开（点击切换）';
    } else {
      streamToggle.textContent = '🔓';
      streamToggle.classList.remove('active');
      streamToggle.title = '流式模式关闭：粘贴后关闭窗口（点击切换）';
    }
  }

  /**
   * 切换流式模式（手动覆盖自动检测）
   */
  function toggleStreamMode(): void {
    streamMode = !streamMode;
    updateStreamToggle();
  }

  /**
   * 确认输入：调用 IPC（主进程优先自动粘贴，降级写剪贴板）+ 显示 Toast
   *
   * 流式模式下：粘贴成功后短暂 Toast → 清空输入 → 聚焦等待下次输入（不关闭窗口）。
   * 普通模式下：粘贴成功后 Toast → 延迟关闭窗口。
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
      const result = await api.confirmQuickInput(text, streamMode);
      if (result.success) {
        if (streamMode) {
          // 流式模式：短暂 Toast → 清空输入 → 聚焦等待
          if (result.mode === 'paste') {
            showPastedToast(result.appName);
          } else {
            showCopyToast();
          }
          toastCloseTimer = setTimeout(() => {
            toastCloseTimer = null;
            resetInputForNext();
          }, STREAM_TOAST_MS);
        } else {
          // 普通模式：Toast → 延迟关闭
          if (result.mode === 'paste') {
            showPastedToast(result.appName);
          } else {
            showCopyToast();
          }
          toastCloseTimer = setTimeout(() => {
            toastCloseTimer = null;
            void api.closeQuickInput();
          }, TOAST_DURATION_MS);
        }
      } else {
        resetInputState(text);
      }
    } catch (error) {
      reportError('QuickInput 确认', error);
      resetInputState(text);
    }
  }

  /**
   * 流式模式下重置输入框，准备下一次输入
   */
  function resetInputForNext(): void {
    isSubmitting = false;
    inputField.disabled = false;
    inputField.readOnly = false;
    inputField.classList.remove('copy-toast');
    inputField.value = '';
    inputField.style.height = 'auto';
    updateCounter();
    baseInputHeight = 72;
    resizeWindow();
    inputField.focus();
  }

  /**
   * 重置输入框状态（确认失败时恢复原文本）
   */
  function resetInputState(text: string): void {
    isSubmitting = false;
    inputField.disabled = false;
    inputField.readOnly = false;
    inputField.classList.remove('copy-toast');
    inputField.value = text;
    inputField.focus();
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
   */
  function autoResize(): void {
    const prevHeight = inputField.offsetHeight;
    inputField.style.height = 'auto';
    inputField.style.height = `${inputField.scrollHeight}px`;
    const newHeight = inputField.offsetHeight;

    if (newHeight !== prevHeight) {
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
   */
  function handleTab(): void {
    if (isSubmitting) return;
    void handleConfirm();
  }

  /** Tab 键已按下（keydown 中标记，keyup 中消费） */
  let tabPressed = false;

  // 输入框键盘事件：Tab 提交、Esc 关闭
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

  // 流式模式切换按钮
  if (streamToggle instanceof HTMLElement) {
    streamToggle.addEventListener('click', toggleStreamMode);
  }

  // 初始化补全管理器
  if (completionList instanceof HTMLElement) {
    completion = new QuickInputCompletion(inputField, completionList, api);
    completion.onSelect((text) => {
      inputField.value = text;
      inputField.focus();
      const len = inputField.value.length;
      inputField.setSelectionRange(len, len);
      autoResize();
      updateCounter();
    });
    completion.onListChange(() => {
      resizeWindow();
    });
    completion.init();
  }

  // 浮窗被主进程 show() 调用时处理剪贴板预填 + 敏感自动检测
  api.onQuickInputShow((payload) => {
    if (toastCloseTimer !== null) {
      clearTimeout(toastCloseTimer);
      toastCloseTimer = null;
    }
    inputField.readOnly = false;
    inputField.classList.remove('copy-toast');
    tabPressed = false;

    // 自动检测：剪贴板内容命中 isSensitive() 时自动进入流式模式
    if (payload?.isSensitive) {
      streamMode = true;
      updateStreamToggle();
    }

    const preset = payload?.clipboardText;
    if (preset) {
      inputField.value = preset;
      inputField.select();
      inputField.dispatchEvent(new Event('input'));
    } else {
      inputField.value = '';
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
  updateCounter();
  autoResize();
  updateStreamToggle();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initQuickInput);
} else {
  initQuickInput();
}
