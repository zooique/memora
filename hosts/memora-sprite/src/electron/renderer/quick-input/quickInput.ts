/**
 * 快速输入浮窗渲染逻辑 — 用户交互入口
 *
 * 职责（Phase 1 + Phase 2 + Phase 3 + Phase 4）：
 *   1. 绑定输入框键盘事件：Enter 确认、Esc 关闭
 *   2. 绑定确认按钮点击事件
 *   3. 确认时调用 IPC（主进程 Phase 4 优先自动粘贴，降级写剪贴板）
 *   4. 窗口重新显示时处理剪贴板预填并聚焦
 *   5. Phase 2：接入补全管理器，输入时显示候选列表，Tab 回填
 *   6. Phase 3：确认成功后显示 Toast，延迟 800ms 后关闭
 *   7. Phase 4：等待期间显示"粘贴中..."loading，按 mode 显示不同 Toast
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
 *   - quickInputWindow.ts：主进程处理 IPC，Phase 4 自动粘贴优先
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
 *          onQuickInputShow / removeQuickInputShowListener（主进程 show() 时携带剪贴板预填文本，替代 focus 事件）
 */
export type QuickInputElectronAPI = Pick<
  ElectronAPI,
  | 'confirmQuickInput' | 'closeQuickInput'
  | 'searchMemories' | 'searchSessionMessages' | 'resizeQuickInput'
  | 'onQuickInputShow' | 'removeQuickInputShowListener'
>;

/**
 * 初始化快速输入浮窗交互
 *
 * 绑定 DOM 事件监听器，初始化补全管理器。
 * 在 DOMContentLoaded 后调用（script type=module 默认 defer，DOM 已就绪）。
 */
function initQuickInput(): void {
  // 入口契约校验：instanceof 确保运行时类型安全，不通过则报错退出（正视 bug，不掩盖）
  // reportError 双通道日志（console + 主进程 logger），让生产环境也可观测
  const inputEl = document.getElementById('quick-input-field');
  if (!(inputEl instanceof HTMLInputElement)) {
    reportError('QuickInput init', new Error('quick-input-field 元素缺失或类型错误'));
    return;
  }
  const confirmEl = document.getElementById('quick-input-confirm');
  if (!(confirmEl instanceof HTMLButtonElement)) {
    reportError('QuickInput init', new Error('quick-input-confirm 元素缺失或类型错误'));
    return;
  }
  // 候选列表容器可选（缺失时跳过补全能力，不阻断主流程）
  const completionList = document.getElementById('completion-list');

  const electronApi = (window as unknown as { electronAPI?: QuickInputElectronAPI }).electronAPI;
  if (!electronApi) {
    reportError('QuickInput init', new Error('electronAPI 未注入（preload 加载失败）'));
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

  /** Toast 显示时长（ms）—— 确认成功后展示"已复制"提示 */
  const TOAST_DURATION_MS = 800;
  /** Toast 自动关闭定时器句柄 —— 浮窗提前关闭时需清理，避免对已隐藏窗口发起无效 IPC */
  let toastCloseTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * 确认输入：调用 IPC（主进程 Phase 4 优先自动粘贴，降级写剪贴板）+ 显示 Toast + 延迟关闭
   *
   * Phase 3：主进程确认成功后不自动关闭，由本函数显示 Toast，延迟 TOAST_DURATION_MS 后关闭。
   * Phase 4：等待期间显示"粘贴中..."loading（主进程 paste 约 300ms），按 mode 显示不同 Toast。
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
    // Phase 4：等待期间显示"粘贴中..."loading（排雷修正雷 4.1：避免 300ms 无响应）
    showPastingToast();

    try {
      const result = await api.confirmQuickInput(text);
      if (result.success) {
        // Phase 4：按 mode 显示不同 Toast
        if (result.mode === 'paste') {
          showPastedToast(result.appName);
        } else {
          showCopyToast();
        }
        // 保存句柄：浮窗可能在 Toast 期间被 Esc/blur 提前关闭，需在关闭时清理避免无效 IPC
        toastCloseTimer = setTimeout(() => {
          toastCloseTimer = null;
          void api.closeQuickInput();
        }, TOAST_DURATION_MS);
      } else {
        // 失败时恢复 UI 状态，让用户可以修改后重试
        isSubmitting = false;
        confirmBtn.disabled = false;
        inputField.disabled = false;
        inputField.readOnly = false;
        inputField.classList.remove('copy-toast');
        inputField.value = text;  // 恢复用户输入的内容
        inputField.focus();
        inputField.select();
      }
    } catch (error) {
      reportError('QuickInput 确认', error);
      // 异常时恢复 UI 状态
      isSubmitting = false;
      confirmBtn.disabled = false;
      inputField.disabled = false;
      inputField.readOnly = false;
      inputField.classList.remove('copy-toast');
      inputField.value = text;
      inputField.focus();
    }
  }

  /**
   * Phase 4：显示"粘贴中..."loading 状态
   *
   * 主进程 paste 流程约 300ms（Esc 50ms + 粘贴 100ms + 剪贴板操作），
   * 期间输入框显示 loading 文案，避免用户看到浮窗卡住无响应。
   */
  function showPastingToast(): void {
    inputField.value = '粘贴中...';
    inputField.classList.add('copy-toast');
    inputField.disabled = false;
    inputField.readOnly = true;
  }

  /**
   * Phase 4：显示"已粘贴"Toast（自动粘贴成功）
   *
   * @param appName 粘贴目标应用名（可选，显示在 Toast 中让用户感知）
   */
  function showPastedToast(appName?: string): void {
    inputField.value = appName ? `✓ 已粘贴到 ${appName}` : '✓ 已粘贴';
    inputField.classList.add('copy-toast');
    inputField.disabled = false;
    inputField.readOnly = true;
  }

  /**
   * 显示"已复制"Toast（降级模式 / Phase 3 兼容）
   *
   * 将输入框值替换为"✓ 已复制，Ctrl+V 粘贴"并添加 toast 样式类，
   * 浮窗关闭时 onQuickInputShow 会清空内容和样式。
   */
  function showCopyToast(): void {
    inputField.value = '✓ 已复制，Ctrl+V 粘贴';
    inputField.classList.add('copy-toast');
    inputField.disabled = false;
    inputField.readOnly = true;
  }

  /**
   * 关闭浮窗：清理 Toast 定时器 + 调用 IPC 通知主进程隐藏窗口
   *
   * Toast 期间用户主动 Esc 关闭时，需先清理定时器，避免对已隐藏窗口发起无效 closeQuickInput IPC。
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
    // 列布局：基础高度 80px（body padding + 容器 padding + 输入行）+ 每个候选项约 38px（含分隔线）
    completion.onListChange((visible) => {
      if (visible) {
        const itemCount = completionList.querySelectorAll('.completion-item').length;
        const targetHeight = 80 + Math.min(itemCount, 5) * 38;
        void api.resizeQuickInput(targetHeight).catch((e: unknown) => reportError('QuickInput-resize', e));
      } else {
        // 隐藏时恢复基础高度
        void api.resizeQuickInput(80).catch((e: unknown) => reportError('QuickInput-resize', e));
      }
    });
    completion.init();
  }

  // 浮窗被主进程 show() 调用时处理剪贴板预填并聚焦
  // 替代 focus 事件：避免 Alt+Tab 切回浮窗时误清空已输入内容
  // Phase 2：主进程读取剪贴板并做敏感检测，非敏感内容预填输入框触发补全
  api.onQuickInputShow((payload) => {
    // 清除 Phase 3 的 Toast 状态（readOnly + copy-toast 类 + 残留定时器）
    if (toastCloseTimer !== null) {
      clearTimeout(toastCloseTimer);
      toastCloseTimer = null;
    }
    inputField.readOnly = false;
    inputField.classList.remove('copy-toast');
    const preset = payload?.clipboardText;
    if (preset) {
      // 剪贴板感知预填：非敏感内容预填输入框并全选，用户可直接覆盖或修改
      inputField.value = preset;
      inputField.select();
      // 触发 input 事件让补全管理器拉取候选（复用防抖机制）
      inputField.dispatchEvent(new Event('input'));
    } else {
      // 无剪贴板内容或敏感内容，保持空输入框
      inputField.value = '';
    }
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
