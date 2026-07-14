/**
 * 快速输入浮窗渲染逻辑 — 用户交互入口（Tab 双重确认模式）
 *
 * 职责：
 *   1. 绑定输入框键盘事件：Tab 确认、Esc 关闭（移除 Enter 确认）
 *   2. Tab 双重确认逻辑：
 *      - 第 1 击：选择候选项并回填到输入框
 *      - 第 2 击：确认并粘贴到目标应用（优先自动粘贴，降级写剪贴板）
 *   3. 窗口重新显示时处理剪贴板预填并聚焦
 *   4. 接入补全管理器，输入时显示候选列表
 *   5. 确认成功后显示 Toast，延迟关闭
 *
 * 设计原则：
 *   - 使用 Pick<ElectronAPI, ...> 提取子集（与 float.ts 范式一致）
 *   - Tab 是唯一确认按钮，Enter 用于换行
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
  const api: QuickInputElectronAPI = electronApi;

  /** 是否正在提交（防止重复确认） */
  let isSubmitting = false;
  /** 补全管理器实例 */
  let completion: QuickInputCompletion | null = null;

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
   * Tab 键处理逻辑（两种状态）
   *
   * 状态1：文本输入状态（无候选列表 或 有候选但未用方向键浏览）
   *   → Tab 直接确认粘贴（记录记忆 + 填入正文）
   *
   * 状态2：记忆选择状态（有候选列表且用户用方向键浏览过）
   *   → Tab 先回填选中的候选文本到输入框（可修改），清除候选列表
   *   → 修改完成后再次 Tab，进入状态1，直接确认粘贴
   *
   * 设计说明：
   *   - 在 keyup 阶段执行确认，而非 keydown。
   *   - 原因：若 keydown 阶段发送 IPC 并关闭浮窗，Tab 键的 keyup 事件会传播到原窗口
   *     （如微信），可能触发原窗口的快捷键（如最小化到托盘）。
   *   - 改为 keyup 后，整个 Tab 事件周期在浮窗内消化，不会泄漏到目标应用。
   */
  function handleTab(): void {
    if (isSubmitting) return;

    // 状态2：有候选列表且用户正在浏览（方向键导航过）
    // → Tab 先回填选中的候选文本到输入框，清除候选列表
    if (completion && completionList && !completionList.classList.contains('hidden') && completion.isNavigating()) {
      const selectedText = completion.getSelectedText();
      if (selectedText) {
        inputField.value = selectedText;
        inputField.focus();
      }
      // 清除候选列表，进入编辑状态
      completionList.classList.add('hidden');
      completion.clear();
      return;
    }

    // 状态1：文本输入状态（无候选列表 或 有候选但未浏览）
    // → Tab 直接确认粘贴
    void handleConfirm();
  }

  /** Tab 键已按下（keydown 中标记，keyup 中消费） */
  let tabPressed = false;

  // 输入框键盘事件：Tab 确认（keydown 标记 + keyup 执行）、Esc 关闭
  inputField.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Tab') {
      // keydown 阶段只阻止默认行为并标记，不在此处执行确认
      // 避免 keyup 事件泄漏到原窗口（如微信最小化问题）
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

  // 初始化补全管理器（候选列表容器存在时才启用补全）
  if (completionList instanceof HTMLElement) {
    completion = new QuickInputCompletion(inputField, completionList, api);
    // 候选列表显示/隐藏时，通知主进程调整窗口高度
    completion.onListChange((visible) => {
      if (visible) {
        const itemCount = completionList.querySelectorAll('.completion-item').length;
        const hasFooter = completionList.dataset.footer === 'true';
        const footerHeight = hasFooter ? 28 : 0;
        const targetHeight = 90 + Math.min(itemCount, 5) * 38 + footerHeight;
        void api.resizeQuickInput(targetHeight).catch((e: unknown) => reportError('QuickInput-resize', e));
      } else {
        void api.resizeQuickInput(90).catch((e: unknown) => reportError('QuickInput-resize', e));
      }
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
    }
    isSubmitting = false;
    inputField.disabled = false;
    inputField.focus();
  });

  inputField.focus();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initQuickInput);
} else {
  initQuickInput();
}