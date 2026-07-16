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
 *   - Tab：提交输入框内容（本文件 QuickInputController.handleTab 处理）
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
 *
 * 浮窗交互逻辑封装在 QuickInputController 类中，各方法可独立测试。
 */
import type { ElectronAPI } from '../../preload.js';
import '../types.js';
import { reportError } from '../helpers/errorHelpers.js';
// safeStorage 统一 localStorage 读写（ADR-017 枝叶层 2 次提取，字符串场景）
import { safeGet, safeSet } from '../helpers/safeStorage.js';
import { QuickInputCompletion } from './quickInputCompletion.js';

/**
 * 快速输入浮窗所需的 ElectronAPI 子集
 */
export type QuickInputElectronAPI = Pick<
  ElectronAPI,
  | 'confirmQuickInput' | 'closeQuickInput'
  | 'searchMemories' | 'searchSessionMessages' | 'resizeQuickInput'
  | 'moveQuickInput' | 'polishQuickInput'
  | 'onQuickInputShow' | 'removeQuickInputShowListener'
  | 'boostMemory'
>;

/** 流式模式 Toast 显示时长（ms），比普通模式短，快速恢复输入状态 */
const STREAM_TOAST_MS = 500;
/** 普通模式 Toast 显示时长（ms），延迟关闭窗口 */
const TOAST_DURATION_MS = 800;
/** 输入区初始基础高度（px），与 CSS 对齐 */
const INITIAL_BASE_HEIGHT = 72;
/** 候选项最大高度基数（px），用于 resizeWindow 计算 */
const ITEM_HEIGHT_PX = 38;
/** footer 区域高度（px），用于 resizeWindow 计算 */
const FOOTER_HEIGHT_PX = 28;
/** 候选列表最大显示条数（与补全管理器 MAX_CANDIDATES 对齐） */
const MAX_VISIBLE_ITEMS = 5;
/** 紧凑态最小高度（px），与 CSS .quick-input-field min-height 对齐 */
const COMPACT_MIN_HEIGHT = 36;
/** 展开态最小高度（px），与 CSS .quick-input-field.expanded min-height 对齐 */
const EXPANDED_MIN_HEIGHT = 120;
/** localStorage key：持久化展开状态（'1' = 展开，'0' = 紧凑） */
const STORAGE_KEY_EXPAND = 'memora-quick-input-expanded';
/** 拖动阈值（px）：移动超过此距离才认为是拖动而非点击（与 float.ts 对齐） */
const DRAG_THRESHOLD_PX = 3;

/**
 * 快速输入浮窗控制器
 *
 * 封装浮窗交互的完整状态 + 行为：
 *   - 输入框键盘事件处理（Tab 提交、Esc 关闭）
 *   - 流式模式切换 + 剪贴板敏感自动检测
 *   - 确认流程（IPC 调用 + Toast 反馈 + 延迟关闭）
 *   - 自动调整高度 + 字符计数
 *   - 补全管理器生命周期管理
 *
 * 使用方式：
 *   1. 构造时传入 DOM 元素 + API
 *   2. 调用 init() 绑定事件监听器 + 初始化补全管理器
 *   3. 窗口销毁前调用 cleanup() 清理资源
 */
class QuickInputController {
  // ── DOM 元素 ──
  /** 输入框（textarea） */
  private readonly inputField: HTMLTextAreaElement;
  /** 候选列表容器（可能为 null：DOM 中不存在时） */
  private readonly completionList: HTMLElement | null;
  /** 流式模式切换按钮（可能为 null：DOM 中不存在时） */
  private readonly streamToggle: HTMLElement | null;
  /** 展开高度切换按钮（可能为 null：DOM 中不存在时） */
  private readonly expandToggle: HTMLElement | null;
  /** 润色按钮（可能为 null：DOM 中不存在时） */
  private readonly polishToggle: HTMLElement | null;
  /** footer 区域（拖动把手，可能为 null：DOM 中不存在时） */
  private readonly footerEl: HTMLElement | null;
  /** 字符计数显示元素（可能为 null） */
  private readonly counterEl: HTMLElement | null;
  /** ElectronAPI 子集 */
  private readonly api: QuickInputElectronAPI;

  // ── 运行时状态 ──
  /** 是否正在提交（防止重复确认） */
  private isSubmitting = false;
  /** 补全管理器实例（init 时创建，cleanup 时销毁） */
  private completion: QuickInputCompletion | null = null;
  /** 当前输入区基础高度（不含候选列表，随 autoResize 动态变化） */
  private baseInputHeight = INITIAL_BASE_HEIGHT;
  /** Toast 自动关闭定时器句柄 */
  private toastCloseTimer: ReturnType<typeof setTimeout> | null = null;
  /** 流式模式开关（粘贴后保持窗口打开供连续输入） */
  private streamMode = false;
  /** 展开模式开关（true 时 textarea 使用更大的 min-height，状态持久化到 localStorage） */
  private expandMode = false;
  /** Tab 键已按下标记（keydown 中标记，keyup 中消费，防止事件泄漏） */
  private tabPressed = false;
  /** 润色中标记（防止重复点击，loading 期间禁用输入框） */
  private isPolishing = false;
  /** resize IPC 防抖定时器（避免输入时频繁 setSize 导致窗口闪烁） */
  private resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  // ── 拖动状态（footer 把手拖动浮窗，参考 float.ts PointerEvent + setPointerCapture 模式） ──
  /** 当前捕获的指针 ID（null 表示未拖动） */
  private dragPointerId: number | null = null;
  /** 拖动累计位移起点（screen 坐标系，用于计算总位移判断是否超过阈值） */
  private dragStartX = 0;
  private dragStartY = 0;
  /** 上一次 pointermove 的 screen 坐标（用于计算增量位移，逐帧推送 IPC） */
  private dragLastX = 0;
  private dragLastY = 0;

  /**
   * @param inputField 输入框 textarea 元素
   * @param completionList 候选列表容器（可能为 null）
   * @param streamToggle 流式模式切换按钮（可能为 null）
   * @param expandToggle 展开高度切换按钮（可能为 null）
   * @param polishToggle 润色按钮（可能为 null）
   * @param footerEl footer 区域（拖动把手，可能为 null）
   * @param counterEl 字符计数元素（可能为 null）
   * @param api ElectronAPI 子集
   */
  constructor(
    inputField: HTMLTextAreaElement,
    completionList: HTMLElement | null,
    streamToggle: HTMLElement | null,
    expandToggle: HTMLElement | null,
    polishToggle: HTMLElement | null,
    footerEl: HTMLElement | null,
    counterEl: HTMLElement | null,
    api: QuickInputElectronAPI,
  ) {
    this.inputField = inputField;
    this.completionList = completionList;
    this.streamToggle = streamToggle;
    this.expandToggle = expandToggle;
    this.polishToggle = polishToggle;
    this.footerEl = footerEl;
    this.counterEl = counterEl;
    this.api = api;
  }

  /**
   * 初始化：绑定事件监听器 + 创建补全管理器 + 初次布局
   *
   * 调用时机：DOM 元素已就绪后（DOMContentLoaded 或之后）
   */
  init(): void {
    this.bindKeyboardEvents();
    this.bindStreamToggle();
    this.bindExpandToggle();
    this.bindPolishToggle();
    this.bindDrag();
    this.initCompletion();
    this.bindShowHandler();
    this.initialLayout();
    this.bindBeforeUnload();
  }

  /**
   * 绑定输入框键盘事件（Tab 提交、Esc 关闭、input 自动调整）
   */
  private bindKeyboardEvents(): void {
    // Tab 键：keydown 阻止默认行为（防止焦点跳转），keyup 触发提交
    this.inputField.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        this.tabPressed = true;
      } else if (e.key === 'Escape') {
        e.preventDefault();
        void this.handleClose();
      }
    });

    // Tab 确认在 keyup 阶段执行，确保事件不泄漏到原窗口
    this.inputField.addEventListener('keyup', (e: KeyboardEvent) => {
      if (e.key === 'Tab' && this.tabPressed) {
        this.tabPressed = false;
        this.handleTab();
      }
    });

    // 输入时自动调整高度 + 更新字符计数
    this.inputField.addEventListener('input', () => {
      this.autoResize();
      this.updateCounter();
    });
  }

  /**
   * 绑定流式模式切换按钮点击事件
   */
  private bindStreamToggle(): void {
    if (this.streamToggle instanceof HTMLElement) {
      this.streamToggle.addEventListener('click', () => this.toggleStreamMode());
    }
  }

  /**
   * 绑定展开高度切换按钮点击事件
   */
  private bindExpandToggle(): void {
    if (this.expandToggle instanceof HTMLElement) {
      this.expandToggle.addEventListener('click', () => this.toggleExpand());
    }
  }

  /**
   * 绑定润色按钮点击事件
   *
   * 点击后调用 LLM 润色当前输入框文本（isPolishing 防重复点击），
   * 润色期间显示 loading 状态（按钮动画 + 输入框禁用），
   * 成功后替换输入框内容，失败时 Toast 提示（不替换原文）。
   */
  private bindPolishToggle(): void {
    if (this.polishToggle instanceof HTMLElement) {
      this.polishToggle.addEventListener('click', () => void this.handlePolish());
    }
  }

  /**
   * 执行 LLM 润色：调用 IPC → 替换输入框内容
   *
   * 流程：
   *   1. 校验：非空文本 + 非润色中 + 非提交中
   *   2. 进入 loading 状态（按钮旋转动画 + 输入框禁用）
   *   3. 调用 api.polishQuickInput(text)
   *   4. 成功：替换输入框文本 + 输入事件触发 autoResize
   *   5. 失败：恢复原文 + Toast 显示错误
   *   6. 退出 loading 状态
   */
  private async handlePolish(): Promise<void> {
    if (this.isPolishing || this.isSubmitting) return;
    const text = this.inputField.value.trim();
    if (!text) return;

    this.isPolishing = true;
    this.inputField.disabled = true;
    this.polishToggle?.classList.add('loading');

    try {
      const result = await this.api.polishQuickInput(text);
      // 返回值类型校验：防御异常结构导致 textarea.value 被赋 "[object Object]"
      if (result.changed && typeof result.polished === 'string' && result.polished) {
        this.inputField.value = result.polished;
        this.inputField.dispatchEvent(new Event('input'));
      } else {
        // 润色无变化：短暂闪烁提示
        this.showPolishNoChange();
      }
    } catch (error) {
      reportError('QuickInput 润色', error);
      this.showPolishError();
    } finally {
      this.isPolishing = false;
      this.inputField.disabled = false;
      this.polishToggle?.classList.remove('loading');
      this.inputField.focus();
    }
  }

  /**
   * 润色无变化：短暂闪烁 polish-toggle 提示用户
   */
  private showPolishNoChange(): void {
    this.polishToggle?.classList.add('no-change');
    setTimeout(() => {
      this.polishToggle?.classList.remove('no-change');
    }, 500);
  }

  /**
   * 润色失败：在输入框内短暂显示错误提示
   */
  private showPolishError(): void {
    const original = this.inputField.value;
    this.inputField.value = '润色失败，请重试';
    this.inputField.classList.add('copy-toast');
    setTimeout(() => {
      this.inputField.value = original;
      this.inputField.classList.remove('copy-toast');
      this.inputField.dispatchEvent(new Event('input'));
    }, 800);
  }

  /**
   * 绑定 footer 拖动事件（PointerEvent + setPointerCapture 模式，参考 float.ts）
   *
   * 交互流程：
   *   - pointerdown：记录起点 + setPointerCapture（后续 pointermove/pointerup 即使鼠标移出窗口也能持续触发）
   *   - pointermove：3px 阈值判断 → 计算 screen 增量 → 调用 IPC moveQuickInput 逐帧推送
   *   - pointerup：releasePointerCapture + 清理状态
   *
   * 交互按钮防护：pointerdown 落在 .expand-toggle / .stream-toggle 上时不启动拖动，
   * 让按钮的 click 事件正常触发。
   *
   * 位置不持久化：每次唤起仍在光标跟随位置显示，拖动仅本次会话生效（由主进程负责）。
   */
  private bindDrag(): void {
    if (!(this.footerEl instanceof HTMLElement)) return;
    const footer = this.footerEl;

    // pointerdown：记录起点 + 捕获指针，使后续 pointermove/pointerup 即使鼠标移出窗口也能触发
    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      // 交互按钮（展开/流式切换/润色）上的 pointerdown 不启动拖动，让按钮 click 正常触发
      const target = e.target as Element | null;
      if (target?.closest('.expand-toggle, .stream-toggle, .polish-toggle')) return;
      this.dragPointerId = e.pointerId;
      this.dragStartX = e.screenX;
      this.dragStartY = e.screenY;
      this.dragLastX = e.screenX;
      this.dragLastY = e.screenY;
      footer.setPointerCapture(e.pointerId);
    };

    // pointermove：超过阈值后逐帧推送 IPC 增量（与 float.ts 一致，避免单击误判为拖动）
    const onPointerMove = (e: PointerEvent) => {
      if (this.dragPointerId !== e.pointerId) return;
      if (e.buttons !== 1) return;
      const totalDx = e.screenX - this.dragStartX;
      const totalDy = e.screenY - this.dragStartY;
      // 首次超过阈值后才开始发送移动（避免单击误判为拖动）
      if (Math.abs(totalDx) <= DRAG_THRESHOLD_PX && Math.abs(totalDy) <= DRAG_THRESHOLD_PX) return;
      const moveDx = e.screenX - this.dragLastX;
      const moveDy = e.screenY - this.dragLastY;
      if (moveDx !== 0 || moveDy !== 0) {
        this.api.moveQuickInput(moveDx, moveDy);
      }
      this.dragLastX = e.screenX;
      this.dragLastY = e.screenY;
    };

    // pointerup：释放指针捕获 + 清理拖动状态
    const onPointerUp = (e: PointerEvent) => {
      if (this.dragPointerId !== e.pointerId) return;
      if (footer.hasPointerCapture(e.pointerId)) {
        footer.releasePointerCapture(e.pointerId);
      }
      this.dragPointerId = null;
    };

    footer.addEventListener('pointerdown', onPointerDown);
    footer.addEventListener('pointermove', onPointerMove);
    footer.addEventListener('pointerup', onPointerUp);
  }

  /**
   * 初始化补全管理器：创建实例 + 绑定 onSelect / onListChange 回调
   */
  private initCompletion(): void {
    if (!(this.completionList instanceof HTMLElement)) return;
    this.completion = new QuickInputCompletion(this.inputField, this.completionList, this.api);
    // 候选项被选中（←→/Click）时填充到输入框
    this.completion.onSelect((text) => {
      this.inputField.value = text;
      this.inputField.focus();
      const len = this.inputField.value.length;
      this.inputField.setSelectionRange(len, len);
      this.autoResize();
      this.updateCounter();
    });
    // 候选列表变化时调整窗口高度
    this.completion.onListChange(() => {
      this.resizeWindow();
    });
    this.completion.init();
  }

  /**
   * 绑定浮窗显示事件（主进程 show() 时触发，处理剪贴板预填 + 敏感检测）
   */
  private bindShowHandler(): void {
    this.api.onQuickInputShow((payload) => {
      this.handleShow(payload);
    });
  }

  /**
   * 处理浮窗显示事件
   *
   * @param payload 主进程传入的剪贴板预填文本 + 敏感标记
   */
  private handleShow(payload: { clipboardText?: string | null; isSensitive?: boolean } | null): void {
    if (this.toastCloseTimer !== null) {
      clearTimeout(this.toastCloseTimer);
      this.toastCloseTimer = null;
    }
    this.inputField.readOnly = false;
    this.inputField.classList.remove('copy-toast');
    this.tabPressed = false;

    // 自动检测：剪贴板内容命中 isSensitive() 时自动进入流式模式
    if (payload?.isSensitive) {
      this.streamMode = true;
      this.updateStreamToggle();
    }

    const preset = payload?.clipboardText;
    if (preset) {
      this.inputField.value = preset;
      this.inputField.select();
      this.inputField.dispatchEvent(new Event('input'));
    } else {
      this.inputField.value = '';
      this.inputField.style.height = 'auto';
      this.updateCounter();
      this.baseInputHeight = INITIAL_BASE_HEIGHT;
      this.resizeWindow();
    }
    this.isSubmitting = false;
    this.inputField.disabled = false;
    this.inputField.focus();
  }

  /**
   * 初次布局：聚焦输入框 + 计数 + 恢复展开状态 + 高度调整 + 流式按钮初始化
   */
  private initialLayout(): void {
    this.inputField.focus();
    this.updateCounter();
    this.restoreExpandState();
    this.autoResize();
    this.updateStreamToggle();
  }

  /**
   * 从 localStorage 恢复展开状态（跨会话持久化）
   *
   * 读取 STORAGE_KEY_EXPAND，'1' 视为展开态。恢复后同步更新 UI 类和 resizeWindow。
   * localStorage 不可用或无记录时默认为紧凑态（expandMode = false）。
   */
  private restoreExpandState(): void {
    // safeGet 内部已 try-catch localStorage 不可用场景，降级返回默认值 '0'
    const stored = safeGet(STORAGE_KEY_EXPAND, '0');
    if (stored === '1') {
      this.expandMode = true;
      this.inputField.classList.add('expanded');
      this.updateExpandToggle();
    }
  }

  /**
   * 更新展开按钮视觉状态（.active 类 + title 提示）
   */
  private updateExpandToggle(): void {
    if (!(this.expandToggle instanceof HTMLElement)) return;
    if (this.expandMode) {
      this.expandToggle.classList.add('active');
      this.expandToggle.title = '收起输入框（点击恢复紧凑高度）';
    } else {
      this.expandToggle.classList.remove('active');
      this.expandToggle.title = '展开输入框（点击切换高度）';
    }
  }

  /**
   * 切换展开模式（手动切换 textarea 高度档位）
   *
   * 切换 expandMode → 同步 UI（expanded 类 + .active 类）→ 持久化到 localStorage → 触发 autoResize 重算高度。
   */
  private toggleExpand(): void {
    this.expandMode = !this.expandMode;
    if (this.expandMode) {
      this.inputField.classList.add('expanded');
    } else {
      this.inputField.classList.remove('expanded');
    }
    this.updateExpandToggle();
    // safeSet 内部已 try-catch，localStorage 不可用时仅本次会话生效，不持久化
    safeSet(STORAGE_KEY_EXPAND, this.expandMode ? '1' : '0');
    // 收起动作强制紧凑 min-height，避免内容多时 scrollHeight 撑大导致"无法收回"；
    // 展开动作随内容增长（传 false 走默认 scrollHeight 计算）
    this.autoResize(!this.expandMode);
  }

  /**
   * 绑定窗口销毁前清理事件
   */
  private bindBeforeUnload(): void {
    window.addEventListener('beforeunload', () => {
      this.cleanup();
    });
  }

  // ── 流式模式 ──

  /**
   * 更新流式模式切换按钮视觉状态
   *
   * 通过切换 SVG <use href> 在 lock/unlock icon 间切换（与主窗口 icon 系统对齐）。
   */
  private updateStreamToggle(): void {
    if (!(this.streamToggle instanceof HTMLElement)) return;
    const useEl = this.streamToggle.querySelector('use');
    if (useEl) {
      useEl.setAttribute('href', this.streamMode ? '#icon-lock' : '#icon-unlock');
    }
    if (this.streamMode) {
      this.streamToggle.classList.add('active');
      this.streamToggle.title = '流式模式开启：粘贴后保持窗口打开（点击切换）';
    } else {
      this.streamToggle.classList.remove('active');
      this.streamToggle.title = '流式模式关闭：粘贴后关闭窗口（点击切换）';
    }
  }

  /**
   * 切换流式模式（手动覆盖自动检测）
   */
  private toggleStreamMode(): void {
    this.streamMode = !this.streamMode;
    this.updateStreamToggle();
  }

  // ── 确认流程 ──

  /**
   * 确认输入：调用 IPC（主进程优先自动粘贴，降级写剪贴板）+ 显示 Toast
   *
   * 流式模式下：粘贴成功后短暂 Toast → 清空输入 → 聚焦等待下次输入（不关闭窗口）。
   * 普通模式下：粘贴成功后 Toast → 延迟关闭窗口。
   */
  private async handleConfirm(): Promise<void> {
    if (this.isSubmitting) return;
    const text = this.inputField.value;
    if (!text.trim()) {
      await this.api.closeQuickInput();
      return;
    }

    this.isSubmitting = true;
    this.inputField.disabled = true;
    this.showPastingToast();

    try {
      const result = await this.api.confirmQuickInput(text, this.streamMode);
      if (result.success) {
        if (this.streamMode) {
          // 流式模式：短暂 Toast → 清空输入 → 聚焦等待
          if (result.mode === 'paste') {
            this.showPastedToast(result.appName);
          } else {
            this.showCopyToast();
          }
          this.toastCloseTimer = setTimeout(() => {
            this.toastCloseTimer = null;
            this.resetInputForNext();
          }, STREAM_TOAST_MS);
        } else {
          // 普通模式：Toast → 延迟关闭
          if (result.mode === 'paste') {
            this.showPastedToast(result.appName);
          } else {
            this.showCopyToast();
          }
          this.toastCloseTimer = setTimeout(() => {
            this.toastCloseTimer = null;
            void this.api.closeQuickInput();
          }, TOAST_DURATION_MS);
        }
      } else {
        this.resetInputState(text);
      }
    } catch (error) {
      reportError('QuickInput 确认', error);
      this.resetInputState(text);
    }
  }

  /**
   * 流式模式下重置输入框，准备下一次输入
   */
  private resetInputForNext(): void {
    this.isSubmitting = false;
    this.inputField.disabled = false;
    this.inputField.readOnly = false;
    this.inputField.classList.remove('copy-toast');
    this.inputField.value = '';
    this.inputField.style.height = 'auto';
    this.updateCounter();
    this.baseInputHeight = INITIAL_BASE_HEIGHT;
    this.resizeWindow();
    this.inputField.focus();
  }

  /**
   * 重置输入框状态（确认失败时恢复原文本）
   *
   * @param text 要恢复的原始文本
   */
  private resetInputState(text: string): void {
    this.isSubmitting = false;
    this.inputField.disabled = false;
    this.inputField.readOnly = false;
    this.inputField.classList.remove('copy-toast');
    this.inputField.value = text;
    this.inputField.focus();
  }

  // ── Toast 显示 ──

  /**
   * 显示"粘贴中..."loading 状态
   */
  private showPastingToast(): void {
    this.inputField.value = '粘贴中...';
    this.inputField.classList.add('copy-toast');
    this.inputField.disabled = false;
    this.inputField.readOnly = true;
  }

  /**
   * 显示"已粘贴"Toast（自动粘贴成功）
   *
   * @param appName 粘贴目标应用名（供 Toast 显示）
   */
  private showPastedToast(appName?: string): void {
    this.inputField.value = appName ? `✓ 已粘贴到 ${appName}` : '✓ 已粘贴';
    this.inputField.classList.add('copy-toast');
    this.inputField.disabled = false;
    this.inputField.readOnly = true;
  }

  /**
   * 显示"已复制"Toast（降级模式）
   */
  private showCopyToast(): void {
    this.inputField.value = '✓ 已复制，Ctrl+V 粘贴';
    this.inputField.classList.add('copy-toast');
    this.inputField.disabled = false;
    this.inputField.readOnly = true;
  }

  // ── 布局调整 ──

  /**
   * 自动调整 textarea 高度
   *
   * @param forceMinHeight true=强制使用当前模式的 min-height（用于收起动作，内容超出时滚动）；
   *                       false=随内容增长（用于输入事件和展开动作）
   */
  private autoResize(forceMinHeight = false): void {
    const prevHeight = this.inputField.offsetHeight;
    this.inputField.style.height = 'auto';
    // 最小高度根据展开模式动态选择（与 CSS .expanded min-height 对齐）
    const minHeight = this.expandMode ? EXPANDED_MIN_HEIGHT : COMPACT_MIN_HEIGHT;
    // 收起动作强制 min-height，避免内容多时 scrollHeight 撑大导致无法收回；
    // 其他场景（输入/展开）随内容增长，由 CSS max-height 限制上限
    const newHeight = forceMinHeight ? minHeight : Math.max(this.inputField.scrollHeight, minHeight);
    this.inputField.style.height = `${newHeight}px`;

    if (this.inputField.offsetHeight !== prevHeight) {
      // 重新计算窗口基础高度：测量 .quick-input-area 的 offsetHeight（已含 textarea + gap + footer），
      // 加上 container 上下 padding（var(--space-2) × 2 = 16px）。
      // 取代原 `actualHeight + 36` 魔法数字估算，避免 footer/padding 漏算导致窗口高度偏差。
      const inputArea = this.inputField.parentElement;
      if (inputArea instanceof HTMLElement) {
        this.baseInputHeight = inputArea.offsetHeight + 16;
      }
      this.resizeWindow();
    }
  }

  /**
   * 更新字符计数显示
   */
  private updateCounter(): void {
    if (this.counterEl instanceof HTMLElement) {
      this.counterEl.textContent = `${this.inputField.value.length} 字`;
    }
  }

  /**
   * 根据当前状态调整窗口高度（输入区 + 候选列表）
   *
   * 防抖 50ms：避免输入时每次按键都触发 IPC → setSize 导致窗口闪烁。
   * 候选列表显示/隐藏时 50ms 延迟可接受，消除闪烁收益远大于微小延迟。
   */
  private resizeWindow(): void {
    if (this.resizeDebounceTimer) {
      clearTimeout(this.resizeDebounceTimer);
    }
    this.resizeDebounceTimer = setTimeout(() => {
      this.resizeDebounceTimer = null;
      if (this.completionList && !this.completionList.classList.contains('hidden')) {
        const itemCount = this.completionList.querySelectorAll('.completion-item').length;
        const hasFooter = this.completionList.dataset.footer === 'true';
        const footerHeight = hasFooter ? FOOTER_HEIGHT_PX : 0;
        const targetHeight = this.baseInputHeight + Math.min(itemCount, MAX_VISIBLE_ITEMS) * ITEM_HEIGHT_PX + footerHeight;
        void this.api.resizeQuickInput(targetHeight).catch((e: unknown) => reportError('QuickInput-resize', e));
      } else {
        void this.api.resizeQuickInput(this.baseInputHeight).catch((e: unknown) => reportError('QuickInput-resize', e));
      }
    }, 50);
  }

  // ── 关闭 / Tab 处理 ──

  /**
   * 关闭浮窗：清理 Toast 定时器 + 调用 IPC 通知主进程隐藏窗口
   */
  private async handleClose(): Promise<void> {
    if (this.toastCloseTimer !== null) {
      clearTimeout(this.toastCloseTimer);
      this.toastCloseTimer = null;
    }
    try {
      await this.api.closeQuickInput();
    } catch (error) {
      reportError('QuickInput', error);
    }
  }

  /**
   * Tab 键处理：直接提交输入框内容
   */
  private handleTab(): void {
    if (this.isSubmitting) return;
    void this.handleConfirm();
  }

  // ── 生命周期 ──

  /**
   * 清理资源：销毁补全管理器（移除事件监听器 + 清空定时器）
   *
   * 窗口销毁前调用（beforeunload）
   */
  cleanup(): void {
    this.completion?.cleanup();
  }
}

/**
 * 初始化快速输入浮窗交互（工厂函数）
 *
 * 校验 DOM 元素后创建 QuickInputController 实例并启动。
 * 校验失败时 reportError 并降级（不创建控制器）。
 */
function initQuickInput(): void {
  const inputEl = document.getElementById('quick-input-field');
  if (!(inputEl instanceof HTMLTextAreaElement)) {
    reportError('QuickInput init', new Error('quick-input-field 元素缺失或类型错误（应为 textarea）'));
    return;
  }
  const completionList = document.getElementById('completion-list');
  const streamToggle = document.getElementById('stream-toggle');
  const expandToggle = document.getElementById('expand-toggle');
  const polishToggle = document.getElementById('polish-toggle');
  const footerEl = document.getElementById('quick-input-footer');
  const counterEl = document.querySelector('.quick-input-counter');

  const electronApi = (window as unknown as { electronAPI?: QuickInputElectronAPI }).electronAPI;
  if (!electronApi) {
    reportError('QuickInput init', new Error('electronAPI 未注入（preload 加载失败）'));
    return;
  }

  // 创建控制器并初始化
  const controller = new QuickInputController(
    inputEl,
    completionList,
    streamToggle,
    expandToggle instanceof HTMLElement ? expandToggle : null,
    polishToggle instanceof HTMLElement ? polishToggle : null,
    footerEl instanceof HTMLElement ? footerEl : null,
    counterEl instanceof HTMLElement ? counterEl : null,
    electronApi,
  );
  controller.init();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initQuickInput);
} else {
  initQuickInput();
}
