/**
 * 快速输入浮窗渲染逻辑 — 用户交互入口
 *
 * 职责（Phase 1 + Phase 2）：
 *   1. 绑定输入框键盘事件：Enter 确认、Esc 关闭
 *   2. 绑定确认按钮点击事件
 *   3. 确认时调用 IPC 写入剪贴板（主进程抑制三重保护）
 *   4. 窗口重新显示时清空输入框并聚焦
 *   5. Phase 2：接入补全管理器，输入时显示候选列表，Tab 回填
 *
 * 设计原则：
 *   - 使用 Pick<ElectronAPI, ...> 提取子集（与 float.ts 范式一致）
 *   - 确认期间禁用按钮，防止重复提交
 *   - 错误处理通过 IPC 返回值判断，不弹窗（浮窗场景不适合 toast）
 *   - 补全管理器独立封装在 quickInputCompletion.ts，保持职责单一
 *
 * 集成点：
 *   - quick-input.html：通过 <script type="module"> 加载
 *   - preload.ts：暴露 confirmQuickInput / closeQuickInput / searchMemories / searchSessionMessages
 *   - quickInputWindow.ts：主进程处理 IPC 并写入剪贴板
 *   - quickInputCompletion.ts：补全候选管理器（Phase 2）
 */
import type { ElectronAPI } from '../../preload.js';
// 导入 types.js 确保 window.electronAPI 全局声明加载（独立入口需显式导入）
import '../types.js';
// 渲染进程统一日志入口（替代散落的 console.error/warn）
import { reportError } from '../helpers/errorHelpers.js';
// Phase 2：补全管理器
import { QuickInputCompletion } from './quickInputCompletion.js';

/**
 * 快速输入浮窗所需的 ElectronAPI 子集
 *
 * Phase 1：confirmQuickInput / closeQuickInput（确认 + 关闭）
 * Phase 2：searchMemories / searchSessionMessages（补全候选搜索）+ resizeQuickInput（调整高度）
 */
export type QuickInputElectronAPI = Pick<
  ElectronAPI,
  'confirmQuickInput' | 'closeQuickInput' | 'searchMemories' | 'searchSessionMessages' | 'resizeQuickInput'
>;

/**
 * 初始化快速输入浮窗交互
 *
 * 绑定 DOM 事件监听器，初始化补全管理器。
 * 在 DOMContentLoaded 后调用（script type=module 默认 defer，DOM 已就绪）。
 */
function initQuickInput(): void {
  // 入口契约校验：instanceof 确保运行时类型安全，不通过则报错退出（正视 bug，不掩盖）
  const inputEl = document.getElementById('quick-input-field');
  if (!(inputEl instanceof HTMLInputElement)) {
    console.error('[QuickInput] quick-input-field 元素缺失或类型错误');
    return;
  }
  const confirmEl = document.getElementById('quick-input-confirm');
  if (!(confirmEl instanceof HTMLButtonElement)) {
    console.error('[QuickInput] quick-input-confirm 元素缺失或类型错误');
    return;
  }
  // 候选列表容器可选（缺失时跳过补全能力，不阻断主流程）
  const completionList = document.getElementById('completion-list');

  const electronApi = (window as unknown as { electronAPI?: QuickInputElectronAPI }).electronAPI;
  if (!electronApi) {
    console.error('[QuickInput] electronAPI 未注入（preload 加载失败）');
    return;
  }

  // 显式类型标注的 const，确保 async 闭包内类型不回退
  // （TS 限制：async function 闭包不保留 instanceof / null 窄化，需通过显式标注固化类型）
  const inputField: HTMLInputElement = inputEl;
  const confirmBtn: HTMLButtonElement = confirmEl;
  const api: QuickInputElectronAPI = electronApi;

  /** 是否正在提交（防止重复确认） */
  let isSubmitting = false;
  /** 补全管理器实例（Phase 2） */
  let completion: QuickInputCompletion | null = null;

  /**
   * 确认输入：调用 IPC 写入剪贴板 + 关闭浮窗
   *
   * 提交期间禁用输入框和按钮，防止重复触发。
   * 失败时恢复 UI 状态，让用户可以重试。
   */
  async function handleConfirm(): Promise<void> {
    // inputField/confirmBtn 已在入口 instanceof 校验，const 闭包内保留窄化，无需重复检查
    if (isSubmitting) return;
    const text = inputField.value;
    // 空内容不处理（包括纯空白）
    if (!text.trim()) {
      // 空内容直接关闭，不写入剪贴板
      await api.closeQuickInput();
      return;
    }

    isSubmitting = true;
    confirmBtn.disabled = true;
    inputField.disabled = true;

    try {
      const result = await api.confirmQuickInput(text);
      // 成功时主进程会关闭浮窗，不需要手动处理
      // 失败时恢复 UI 状态，让用户可以修改后重试
      if (!result.success) {
        isSubmitting = false;
        confirmBtn.disabled = false;
        inputField.disabled = false;
        inputField.focus();
        // 简短提示（利用 placeholder 临时展示错误，不引入额外 UI）
        inputField.select();
      }
    } catch (error) {
      console.error('[QuickInput] 确认失败:', error);
      // 异常时恢复 UI 状态
      isSubmitting = false;
      confirmBtn.disabled = false;
      inputField.disabled = false;
      inputField.focus();
    }
  }

  /**
   * 关闭浮窗：调用 IPC 通知主进程隐藏窗口
   */
  async function handleClose(): Promise<void> {
    try {
      await api.closeQuickInput();
    } catch (error) {
      reportError('QuickInput', error);
    }
  }

  // 输入框键盘事件：Enter 确认、Esc 关闭
  // 注意：↓↑ Tab 由补全管理器处理，这里只处理 Enter/Esc
  inputField.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void handleConfirm();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      void handleClose();
    }
  });

  // 确认按钮点击事件
  confirmBtn.addEventListener('click', () => {
    void handleConfirm();
  });

  // Phase 2：初始化补全管理器（候选列表容器存在时才启用补全）
  if (completionList instanceof HTMLElement) {
    completion = new QuickInputCompletion(inputField, completionList, api);
    // Tab 选择候选项时，回填到输入框并聚焦
    completion.onSelect((text) => {
      inputField.value = text;
      inputField.focus();
      // 将光标移到末尾
      inputField.setSelectionRange(inputField.value.length, inputField.value.length);
    });
    // 候选列表显示/隐藏时，通知主进程调整窗口高度
    // 基础高度 80px + 每个候选项约 40px，最大 240px（受 CSS max-height 限制）
    completion.onListChange((visible) => {
      if (visible) {
        const itemCount = completionList.querySelectorAll('.completion-item').length;
        const targetHeight = 80 + Math.min(itemCount, 5) * 40;
        void api.resizeQuickInput(targetHeight).catch((e: unknown) => reportError('QuickInput-resize', e));
      } else {
        // 隐藏时恢复基础高度
        void api.resizeQuickInput(80).catch((e: unknown) => reportError('QuickInput-resize', e));
      }
    });
    completion.init();
  }

  // 窗口重新获得焦点时清空输入框并聚焦（每次呼出都是干净状态）
  // 主进程 show() 后窗口会获得焦点，触发此事件
  window.addEventListener('focus', () => {
    inputField.value = '';
    isSubmitting = false;
    confirmBtn.disabled = false;
    inputField.disabled = false;
    inputField.focus();
  });

  // 初始聚焦（首次加载）
  inputField.focus();
}

// DOMContentLoaded 后初始化（module 脚本默认 defer，但加保护更安全）
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initQuickInput);
} else {
  initQuickInput();
}
