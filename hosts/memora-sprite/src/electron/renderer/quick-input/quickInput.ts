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
  const inputField = document.getElementById('quick-input-field') as HTMLInputElement | null;
  const confirmBtn = document.getElementById('quick-input-confirm') as HTMLButtonElement | null;
  const completionList = document.getElementById('completion-list') as HTMLElement | null;

  if (!inputField || !confirmBtn) {
    console.error('[QuickInput] DOM 元素缺失，无法初始化');
    return;
  }

  // 获取 electronAPI（preload 注入），类型安全访问
  const api = (window as unknown as { electronAPI: QuickInputElectronAPI }).electronAPI;
  if (!api) {
    console.error('[QuickInput] electronAPI 未注入（preload 加载失败）');
    return;
  }

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
      console.error('[QuickInput] 关闭失败:', error);
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

  // Phase 2：初始化补全管理器（候选列表容器存在时）
  if (completionList) {
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
        void api.resizeQuickInput(targetHeight);
      } else {
        // 隐藏时恢复基础高度
        void api.resizeQuickInput(80);
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
