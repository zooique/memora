/**
 * 快速输入浮窗渲染逻辑 — 用户交互入口（三键分工 + 常驻模式 + 聚焦提示栏）
 *
 * 职责：
 *   1. 绑定输入框键盘事件：Tab 提交、Esc 关闭、Ctrl+L 切换常驻、Enter 换行
 *   2. Tab 单一提交：将输入框内容粘贴到目标应用（优先自动粘贴，降级写剪贴板）
 *   3. 窗口重新显示时处理剪贴板预填 + 敏感自动检测并聚焦
 *   4. 接入补全管理器，输入时显示候选列表
 *   5. 确认成功后显示 Toast，重置输入框等待下次输入（连续输入）+ 持久化最近提交历史
 *   6. 顶部聚焦提示栏：显示当前聚焦应用名 / 无聚焦（联动 Tab 启用/禁用）
 *   7. 常驻模式（pinnedMode）：持久钉住浮窗，blur 不关闭；图钉按钮或 Ctrl+L 快捷键可切换
 *
 * 三键分工：
 *   - ↑↓：在候选列表中导航选择（由 quickInputCompletion.ts 处理）
 *   - ←→：将选中候选项填充到输入框（由 quickInputCompletion.ts 处理）
 *   - Tab：提交输入框内容（本文件 QuickInputController.handleTab 处理，无聚焦时禁用）
 *
 * 快捷键：
 *   - Ctrl+L（或 Cmd+L）：切换常驻模式（与图钉按钮等价，键盘流不中断）
 *
 * 模式语义：
 *   - default 模式（pinnedMode=false）：Tab 提交后窗口不自动关闭，blur 时 200ms 延迟关闭
 *   - pinned 模式（pinnedMode=true）：持久钉住，blur 不关闭；顶部显示图钉按钮可切换置顶
 *   - 自动检测：剪贴板内容命中 isSensitive() 时自动启用 pinned 模式（敏感内容更安全）
 *   - 手动切换：footer 栏切换按钮（🔒/🔓）覆盖自动检测
 *   - Esc 始终关闭窗口（pinned 模式也不例外）
 *
 * 集成点：
 *   - quick-input.html：通过 <script type="module"> 加载
 *   - preload.ts：暴露 confirmQuickInput / closeQuickInput / searchMemories / searchSessionMessages
 *   - quickInputWindow.ts：主进程处理 IPC，自动粘贴优先（pinned 模式持久 suppressBlurClose）
 *   - quickInputCompletion.ts：补全候选管理器
 *
 * 浮窗交互逻辑封装在 QuickInputController 类中，各方法可独立测试。
 */
import type { ElectronAPI } from '../../preload.js';
import '../types.js';
import { reportError } from '../helpers/errorHelpers.js';
// formatErrorMessage 错误文案真理源（UX-14：替代 "润色失败，请重试" 等模板化文案）
import { formatErrorMessage } from '../../../shared/errorMessages.js';
import { TOAST_SHORT_MS } from '../../../sprite/constants.js';
// safeStorage 统一 localStorage 读写（ADR-017，字符串场景）
import { safeGet, safeSet, safeGetJSON, safeSetJSON } from '../helpers/safeStorage.js';
import { QuickInputCompletion } from './quickInputCompletion.js';
import type { CompletionItem } from './quickInputCompletion.js';
import { fetchMemoryContent } from '../helpers/completionHelpers.js';

/**
 * 快速输入浮窗所需的 ElectronAPI 子集
 */
export type QuickInputElectronAPI = Pick<
  ElectronAPI,
  | 'confirmQuickInput' | 'closeQuickInput'
  | 'searchMemories' | 'searchSessionMessages' | 'resizeQuickInput'
  | 'moveQuickInput' | 'polishQuickInput'
  | 'onQuickInputShow' | 'removeQuickInputShowListener'
  | 'boostMemory' | 'showMemory'
  | 'setPinnedMode' | 'onFocusChange'
> & {
  /** 手动重捕获前台窗口（聚焦栏点击触发，仅 quick-input 浮窗可用） */
  recaptureTarget: () => Promise<{ title: string | null } | null>;
};

/** Toast 显示时长——对齐主窗 TOAST_SHORT_MS（2s），避免跨窗口体验不可预测 */
const TOAST_DURATION_MS = TOAST_SHORT_MS;
/** 输入区初始基础高度（px），与 CSS 对齐（textarea min-height 36px + padding 16px + footer ~20px + focus-bar 28px+4px margin ≈ 104px） */
const INITIAL_BASE_HEIGHT = 104;
/** 候选项高度基数（px），用于 resizeWindow 计算。
 *  与 CSS 对齐：padding 8px*2 + font-size 12px * line-height 1.5 = 34px（UX-QI-19 校准） */
const ITEM_HEIGHT_PX = 34;
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
/** 常驻模式 localStorage 键（跨会话持久化手动切换的用户偏好） */
const STORAGE_KEY_PINNED = 'memora-quick-input-pinned';
/** 最近提交历史 localStorage 键（跨会话持久化，补全回退候选源） */
const STORAGE_KEY_RECENT = 'memora-quick-input-recent';
/** 最近提交历史最大条目数（超出时淘汰最旧条目，LRU 语义） */
const MAX_RECENT_ENTRIES = 10;
/** 最近提交历史回退显示的最大条目数（补全列表容量限制，与 MAX_CANDIDATES 对齐） */
const MAX_RECENT_FALLBACK_ITEMS = 5;
/** 拖动阈值（px）：移动超过此距离才认为是拖动而非点击（与 float.ts 对齐） */
const DRAG_THRESHOLD_PX = 3;

/**
 * 快速输入浮窗控制器
 *
 * 封装浮窗交互的完整状态 + 行为：
 *   - 输入框键盘事件处理（Tab 提交、Esc 关闭）
 *   - 常驻模式切换 + 剪贴板敏感自动检测
 *   - 确认流程（IPC 调用 + Toast 反馈 + 延迟关闭）
 *   - 自动调整高度 + 字符计数
 *   - 补全管理器生命周期管理
 *
 * 使用方式：
 *   1. 构造时传入 DOM 元素 + API
 *   2. 调用 init() 绑定事件监听器 + 初始化补全管理器
 *   3. 窗口销毁前调用 cleanup() 清理资源
 */

/** QuickInputController 构造参数（工厂函数一次性校验后传入，所有字段非空） */
interface QuickInputControllerOptions {
  /** 输入框 textarea 元素 */
  inputField: HTMLTextAreaElement;
  /** 候选列表容器 */
  completionList: HTMLElement;
  /** 常驻模式切换按钮（footer 内的 🔒/🔓 按钮） */
  pinnedToggle: HTMLElement;
  /** 展开高度切换按钮 */
  expandToggle: HTMLElement;
  /** 润色按钮 */
  polishToggle: HTMLElement;
  /** 顶部聚焦提示栏（拖动把手：语义等价于窗口标题栏） */
  focusBarEl: HTMLElement;
  /** 字符计数元素 */
  counterEl: HTMLElement;
  /** 顶部聚焦提示栏应用名元素 */
  focusAppNameEl: HTMLElement;
  /** 顶部关闭按钮（始终显示，pinned 模式下作为显式关闭入口） */
  closeBtnEl: HTMLElement;
  /** ElectronAPI 子集 */
  api: QuickInputElectronAPI;
}

export class QuickInputController {
  // ── DOM 元素 ──
  /** 输入框（textarea） */
  private readonly inputField: HTMLTextAreaElement;
  /** 候选列表容器 */
  private readonly completionList: HTMLElement;
  /** 常驻模式切换按钮（footer 内的 🔒/🔓 按钮） */
  private readonly pinnedToggle: HTMLElement;
  /** 展开高度切换按钮 */
  private readonly expandToggle: HTMLElement;
  /** 润色按钮 */
  private readonly polishToggle: HTMLElement;
  /** 顶部聚焦提示栏（拖动把手） */
  private readonly focusBarEl: HTMLElement;
  /** 字符计数显示元素 */
  private readonly counterEl: HTMLElement;
  /** 顶部聚焦提示栏应用名元素 */
  private readonly focusAppNameEl: HTMLElement;
  /** 顶部关闭按钮（始终显示） */
  private readonly closeBtnEl: HTMLElement;
  /** ElectronAPI 子集 */
  private readonly api: QuickInputElectronAPI;

  // ── 运行时状态 ──
  /** 是否正在提交（防止重复确认） */
  private isSubmitting = false;
  /** 提交代次计数器：每次提交递增，防止过期 IPC 响应污染状态（竞态防护） */
  private submitGeneration = 0;
  /**
   * 正在进行的记忆候选填充 Promise（fillFromMemory 异步期间持有）
   *
   * 协调异步填充与同步提交：用户按 ←→ 选择记忆候选后可能立即按 Tab，
   * 此时 showMemory IPC 尚未返回，inputField.value 还是旧内容（剪贴板预填/查询词）。
   * handleConfirm 开头 await 此 Promise，确保读到填充后的内容。
   * fillFromMemory 无论 IPC 成功或失败都会调 fillText（成功用全量内容，失败降级截断预览），
   * 故 await 完成后 value 一定是记忆内容。
   */
  private pendingFillPromise: Promise<void> | null = null;
  /** 补全管理器实例（init 时创建，cleanup 时销毁） */
  private completion: QuickInputCompletion | null = null;
  /** 当前输入区基础高度（不含候选列表，随 autoResize 动态变化） */
  private baseInputHeight = INITIAL_BASE_HEIGHT;
  /** Toast 自动关闭定时器句柄 */
  private toastCloseTimer: ReturnType<typeof setTimeout> | null = null;
  /** 常驻模式开关（true=持久钉住浮窗，blur 不关闭；false=default 模式，blur 时延迟关闭） */
  private pinnedMode = false;
  /** Tab 是否激活（无聚焦时禁用，避免盲粘） */
  private tabEnabled = true;
  /** 展开模式开关（true 时 textarea 使用更大的 min-height，状态持久化到 localStorage） */
  private expandMode = false;
  /** Tab 键已按下标记（keydown 中标记，keyup 中消费，防止事件泄漏） */
  private tabPressed = false;
  /** 润色中标记（防止重复点击，loading 期间禁用输入框） */
  private isPolishing = false;
  /** resize IPC 防抖定时器（避免输入时频繁 setSize 导致窗口闪烁） */
  private resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** 聚焦栏点击防抖定时器（防止快速双击触发两次重捕获） */
  private recaptureClickTimer: ReturnType<typeof setTimeout> | null = null;
  // ── 拖动状态（focus-bar 顶部标题栏拖动浮窗，参考 float.ts PointerEvent + setPointerCapture 模式） ──
  /** 当前捕获的指针 ID（null 表示未拖动） */
  private dragPointerId: number | null = null;
  /** 拖动累计位移起点（screen 坐标系，用于计算总位移判断是否超过阈值） */
  private dragStartX = 0;
  private dragStartY = 0;
  /** 上一次 pointermove 的 screen 坐标（用于计算增量位移，逐帧推送 IPC） */
  private dragLastX = 0;
  private dragLastY = 0;
  /** 拖动事件处理器引用（用于 cleanup 时移除监听器） */
  private dragHandlers: {
    pointerdown: (e: PointerEvent) => void;
    pointermove: (e: PointerEvent) => void;
    pointerup: (e: PointerEvent) => void;
  } | null = null;

  /**
   * @param options 构造参数对象（工厂函数已校验，所有 DOM 字段非空）
   */
  constructor(options: QuickInputControllerOptions) {
    this.inputField = options.inputField;
    this.completionList = options.completionList;
    this.pinnedToggle = options.pinnedToggle;
    this.expandToggle = options.expandToggle;
    this.polishToggle = options.polishToggle;
    this.focusBarEl = options.focusBarEl;
    this.counterEl = options.counterEl;
    this.focusAppNameEl = options.focusAppNameEl;
    this.closeBtnEl = options.closeBtnEl;
    this.api = options.api;
  }

  /**
   * 初始化：绑定事件监听器 + 创建补全管理器 + 初次布局
   *
   * 调用时机：DOM 元素已就绪后（DOMContentLoaded 或之后）
   */
  init(): void {
    this.bindKeyboardEvents();
    this.bindPinnedToggle();
    this.bindExpandToggle();
    this.bindPolishToggle();
    this.bindDrag();
    this.bindFocusBarClick();
    this.bindCloseButton();
    this.bindFocusChangeHandler();
    this.initCompletion();
    this.bindShowHandler();
    this.initialLayout();
    this.bindBeforeUnload();
  }

  /**
   * 绑定输入框键盘事件（Tab 提交、Esc 关闭、Ctrl+L 切换常驻、input 自动调整）
   */
  private bindKeyboardEvents(): void {
    // Tab 键：keydown 阻止默认行为（防止焦点跳转），keyup 触发提交
    this.inputField.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        this.tabPressed = true;
      } else if (e.key === 'Escape') {
        e.preventDefault();
        // FUNC-3：提交中（isSubmitting）禁用 Esc 关闭
        // paste 不可逆是技术限制，关闭窗口会让用户失去"粘贴中..."Toast 反馈
        // 提交完成后（isSubmitting=false）自动恢复 Esc 关闭能力
        if (this.isSubmitting) return;
        void this.handleClose();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'l' || e.key === 'L')) {
        // Ctrl+L / Cmd+L 切换常驻模式（与图钉按钮等价，键盘流不中断）
        // 参考 commandPaletteManager.ts:674 的 Mod 键判断模式，兼容 Windows(Ctrl) 与 macOS(Cmd)
        e.preventDefault();
        this.togglePinnedMode();
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
   * 绑定常驻模式切换按钮（footer 内 🔒/🔓）点击事件
   */
  private bindPinnedToggle(): void {
    this.pinnedToggle.addEventListener('click', () => this.togglePinnedMode());
  }

  /**
   * 绑定顶部关闭按钮（始终显示，pinned 模式下作为显式关闭入口）
   */
  private bindCloseButton(): void {
    this.closeBtnEl.addEventListener('click', () => {
      void this.handleClose();
    });
  }

  /**
   * 绑定聚焦变化 IPC 事件（主进程通过 blur/focus 通知渲染进程）
   *
   * appName=null 表示浮窗失去焦点（用户切走），此时禁用 Tab 避免盲粘
   * appName=string 表示浮窗获得焦点，恢复 Tab + 更新提示栏
   */
  private bindFocusChangeHandler(): void {
    this.api.onFocusChange((appName: string | null) => {
      this.updateFocusIndicator(appName);
    });
  }

  /**
   * 更新顶部聚焦提示栏
   *
   * @param appName 应用名（null 表示无聚焦，浮窗已 blur）
   */
  private updateFocusIndicator(appName: string | null): void {
    if (appName) {
      this.focusAppNameEl.textContent = `聚焦：${appName}`;
      this.focusAppNameEl.parentElement?.classList.remove('no-focus');
      this.setTabEnabled(true);
    } else {
      this.focusAppNameEl.textContent = '无聚焦';
      this.focusAppNameEl.parentElement?.classList.add('no-focus');
      this.setTabEnabled(false);
    }
  }

  /**
   * 启用/禁用 Tab 提交
   *
   * @param enabled true=允许 Tab 提交；false=禁用 Tab（无聚焦时避免盲粘）
   */
  private setTabEnabled(enabled: boolean): void {
    this.tabEnabled = enabled;
    // 视觉反馈：禁用时输入框边框弱化
    this.inputField.classList.toggle('tab-disabled', !enabled);
  }

  /**
   * 绑定展开高度切换按钮点击事件
   */
  private bindExpandToggle(): void {
    this.expandToggle.addEventListener('click', () => this.toggleExpand());
  }

  /**
   * 绑定润色按钮点击事件
   *
   * 点击后调用 LLM 润色当前输入框文本（isPolishing 防重复点击），
   * 润色期间显示 loading 状态（按钮动画 + 输入框禁用），
   * 成功后替换输入框内容，失败时 Toast 提示（不替换原文）。
   */
  private bindPolishToggle(): void {
    this.polishToggle.addEventListener('click', () => void this.handlePolish());
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
    this.polishToggle.classList.add('loading');
    /* UX-QI-20：通知屏幕阅读器正在处理（视觉已有旋转图标，ARIA 补齐无障碍反馈） */
    this.polishToggle.setAttribute('aria-busy', 'true');

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
      this.showPolishError(error);
    } finally {
      this.isPolishing = false;
      this.unlockInput();
      this.polishToggle.classList.remove('loading');
      this.polishToggle.removeAttribute('aria-busy');
      this.inputField.focus();
    }
  }

  /**
   * 润色无变化：短暂闪烁 polish-toggle 提示用户
   */
  private showPolishNoChange(): void {
    this.polishToggle.classList.add('no-change');
    setTimeout(() => {
      this.polishToggle.classList.remove('no-change');
    }, 500);
  }

  /**
   * 润色失败：在输入框内短暂显示错误提示（UX-14：用 formatErrorMessage 替代模板化"请重试"）
   *
   * @param error 润色异常对象，用于分类映射生成中文文案
   */
  private showPolishError(error: unknown): void {
    const original = this.inputField.value;
    this.inputField.value = formatErrorMessage('润色', error);
    this.inputField.classList.add('copy-toast');
    setTimeout(() => {
      this.inputField.value = original;
      this.inputField.classList.remove('copy-toast');
      this.inputField.dispatchEvent(new Event('input'));
    }, 800);
  }

  /**
   * 绑定顶部聚焦栏拖动（替代原 footer 拖动）
   *
   * 拖动把手从 footer 迁移到 focus-bar 顶部，原因：
   *   - focus-bar 语义等价于窗口标题栏（含"聚焦：应用名"+ 关闭按钮）
   *   - footer 同时承载 5 种交互元素（提示文本/润色/展开/常驻/计数），拖动冲突严重
   *   - focus-bar 仅排斥关闭按钮，大幅减少冲突
   *
   * 交互流程：
   *   - pointerdown：记录起点 + setPointerCapture（后续 pointermove/pointerup 即使鼠标移出窗口也能持续触发）
   *   - pointermove：3px 阈值判断 → 计算 screen 增量 → 调用 IPC moveQuickInput 逐帧推送
   *   - pointerup：releasePointerCapture + 清理状态
   *
   * 交互按钮防护：pointerdown 落在 #close-btn 上时不启动拖动，
   * 让关闭按钮的 click 事件正常触发。
   *
   * 位置不持久化：每次唤起仍在光标跟随位置显示，拖动仅本次会话生效（由主进程负责）。
   */
  private bindDrag(): void {
    const handle = this.focusBarEl;

    // pointerdown：记录起点 + 捕获指针，使后续 pointermove/pointerup 即使鼠标移出窗口也能触发
    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      // 关闭按钮上的 pointerdown 不启动拖动，让按钮 click 正常触发
      const target = e.target as Element | null;
      if (target?.closest('#close-btn')) return;
      this.dragPointerId = e.pointerId;
      this.dragStartX = e.screenX;
      this.dragStartY = e.screenY;
      this.dragLastX = e.screenX;
      this.dragLastY = e.screenY;
      handle.setPointerCapture(e.pointerId);
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
      if (handle.hasPointerCapture(e.pointerId)) {
        handle.releasePointerCapture(e.pointerId);
      }
      this.dragPointerId = null;
    };

    // 保存处理器引用，供 cleanup 时移除
    this.dragHandlers = {
      pointerdown: onPointerDown,
      pointermove: onPointerMove,
      pointerup: onPointerUp,
    };
    handle.addEventListener('pointerdown', onPointerDown);
    handle.addEventListener('pointermove', onPointerMove);
    handle.addEventListener('pointerup', onPointerUp);
  }

  /**
   * 绑定聚焦栏点击事件（手动重捕获入口）
   *
   * 点击聚焦栏（focus-bar）触发手动重捕获，调用 recaptureTarget IPC 获取当前前台窗口。
   * 点击不触发拖动（drag 通过 pointerdown/move 检测，>3px 阈值才激活）。
   * 关闭按钮上的点击不触发重捕获（与 drag 的防护逻辑一致）。
   *
   * 防抖：300ms leading-edge 模式——首次点击立即触发，300ms 内后续点击被忽略。
   */
  private bindFocusBarClick(): void {
    this.focusBarEl.addEventListener('click', (e: MouseEvent) => {
      // 关闭按钮上的点击不触发重捕获
      const target = e.target as Element | null;
      if (target?.closest('#close-btn')) return;
      // 防抖：leading edge 模式，300ms 内重复点击被忽略
      if (this.recaptureClickTimer) return;
      this.recaptureClickTimer = setTimeout(() => {
        this.recaptureClickTimer = null;
      }, 300);
      // 触发手动重捕获
      void this.handleRecapture();
    });
  }

  /**
   * 执行手动重捕获：调用 IPC → 更新聚焦栏
   *
   * 失败时保持上一次值，不显示错误提示（静默降级）。
   */
  private async handleRecapture(): Promise<void> {
    try {
      const result = await this.api.recaptureTarget();
      if (result?.title) {
        // 复用 updateFocusIndicator 确保格式 + tabEnabled + no-focus class 一致
        this.updateFocusIndicator(result.title);
      }
    } catch {
      // 静默降级：聚焦栏保持上一次值
    }
  }

  /**
   * 初始化补全管理器：创建实例 + 绑定 onSelect / onListChange 回调
   *
   * onSelect 填充策略（预览与填充分离）：
   *   - 对话候选：fullText 已在搜索结果中（m.content 完整原文），同步填充
   *   - 记忆候选：contentPreview 已被内核截断，通过 showMemory IPC 回库查全量后异步填充
   *   - 回库查询失败时降级使用截断预览 text，保证不阻塞输入
   */
  private initCompletion(): void {
    this.completion = new QuickInputCompletion(this.inputField, this.completionList, this.api);
    // 候选项被选中（←→/Click）时填充到输入框
    this.completion.onSelect((item: CompletionItem) => {
      // 抑制填充文本触发的 input 事件 → 补全搜索（避免候选列表闪烁）
      this.completion?.suppressNextSearch();
      // 对话候选：fullText 已有完整原文，直接同步填充
      if (item.fullText) {
        this.fillText(item.fullText);
        this.completion?.clear();
        return;
      }
      // 记忆候选：fullText 为空，需通过 showMemory IPC 回库查全量内容
      if (item.memoryId) {
        this.fillFromMemory(item);
        return;
      }
      // 降级：无 fullText 也无 memoryId（不应发生），使用截断预览
      this.fillText(item.text);
      this.completion?.clear();
    });
    // 候选列表变化时调整窗口高度
    this.completion.onListChange(() => {
      this.resizeWindow();
    });
    // 注入最近提交历史回退提供者（优先级链：匹配候选为空时回退到历史，历史也为空则显示占位）
    this.completion.onRecentFallback((currentQuery: string) => {
      return this.getRecentSubmissionsForCompletion(currentQuery);
    });
    this.completion.init();
  }

  /**
   * 将文本填充到输入框（同步操作）
   *
   * 集中管理填充后的 UI 更新：设置 value → 聚焦 → 光标移到末尾 → 滚动到底部 → 更新高度/计数 → 触发 input 事件。
   *
   * dispatch input 事件与 inputAreaManager.fillCompletionText 对齐：
   *   - 让 suppressNextInput 标志被立即消费（onSelect 回调中 suppressNextSearch 设置），
   *     避免标志悬挂到下一次 input 事件（如 resetInputForNext 的 dispatch）导致历史候选不显示
   *   - 让下游处理器（autoResize/updateCounter 已在此处手动调用，input 事件为补全搜索的统一入口）自行响应
   */
  private fillText(text: string): void {
    this.inputField.value = text;
    this.inputField.focus();
    const len = this.inputField.value.length;
    this.inputField.setSelectionRange(len, len);
    // UX-QI-25：填充长文本后滚动到底部，保证光标在可视区域内
    this.inputField.scrollTop = this.inputField.scrollHeight;
    this.autoResize();
    this.updateCounter();
    // 触发 input 事件：消费 suppressNextInput 标志，避免悬挂
    this.inputField.dispatchEvent(new Event('input'));
  }

  /**
   * 异步从数据库获取记忆全量内容后填充（记忆候选专用）
   *
   * 委托 fetchMemoryContent 公共函数，消除与 inputAreaManager 的重复逻辑。
   * 回库查询期间候选列表保持可见（不提前清除），填充完成后调用 clear() 隐藏。
   *
   * 同步入口存储进行中的 Promise 到 pendingFillPromise，供 handleConfirm 协调：
   * 用户按 ←→ 选择记忆候选后可能立即按 Tab，此时 showMemory IPC 尚未返回，
   * handleConfirm 开头 await pendingFillPromise 确保读到填充后的 value。
   */
  private fillFromMemory(item: CompletionItem): void {
    this.pendingFillPromise = this.executeFillFromMemory(item);
  }

  /**
   * fillFromMemory 的异步执行体（实际发起 IPC + 填充 + 清理）
   *
   * finally 中清理 pendingFillPromise 引用，避免 handleConfirm 永远 await 已完成的 Promise。
   * fetchMemoryContent 无论 IPC 成功或失败都会调 fillText（成功用全量内容，失败降级截断预览），
   * 故此 Promise resolve 后 inputField.value 一定是记忆内容。
   */
  private async executeFillFromMemory(item: CompletionItem): Promise<void> {
    try {
      await fetchMemoryContent(item, this.api.showMemory, this.fillText.bind(this), 'QuickInput:showMemory');
    } finally {
      this.completion?.clear();
      this.pendingFillPromise = null;
    }
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
    // 递增提交代次，使之前的 IPC 响应失效（防止窗口重新显示时过期响应污染状态）
    this.submitGeneration++;
    if (this.toastCloseTimer !== null) {
      clearTimeout(this.toastCloseTimer);
      this.toastCloseTimer = null;
    }
    this.unlockInput();
    this.inputField.classList.remove('copy-toast');
    this.tabPressed = false;

    // 自动检测：剪贴板内容命中 isSensitive() 时自动进入常驻模式（敏感内容更安全）
    if (payload?.isSensitive) {
      this.pinnedMode = true;
      this.updatePinnedToggle();
      void this.api.setPinnedMode(true);
    }

    const preset = payload?.clipboardText;
    if (preset) {
      // 剪贴板智能预填去重：若剪贴板内容与最近一次提交相同，跳过预填避免重复
      // 场景：用户刚 Tab 提交了文本 A，剪贴板仍是 A，再次呼出浮窗时不必预填 A（用户已提交过）
      const recent = this.loadRecentSubmissions();
      const isDuplicateOfLastSubmission = recent.length > 0 && recent[0] === preset;
      if (isDuplicateOfLastSubmission) {
        // 跳过预填，走空输入分支（清空输入框 + 显示最近提交历史）
        this.inputField.value = '';
        this.inputField.style.height = 'auto';
        this.updateCounter();
        this.baseInputHeight = INITIAL_BASE_HEIGHT;
        this.completion?.clear();
        this.resizeWindow();
        // 空输入时显示最近提交历史（与 resetInputForNext 保持一致）
        this.inputField.dispatchEvent(new Event('input'));
      } else {
        this.inputField.value = preset;
        this.inputField.select();
        this.inputField.dispatchEvent(new Event('input'));
      }
    } else {
      this.inputField.value = '';
      this.inputField.style.height = 'auto';
      this.updateCounter();
      this.baseInputHeight = INITIAL_BASE_HEIGHT;
      // 显式清空补全列表，避免依赖上次关闭时的异步清理
      this.completion?.clear();
      this.resizeWindow();
      // 统一 dispatch input 事件，让所有下游处理器（补全/计数器/高度）自行响应
      this.inputField.dispatchEvent(new Event('input'));
    }
    this.isSubmitting = false;
    this.inputField.disabled = false;
    this.inputField.focus();
  }

  /**
   * 初次布局：聚焦输入框 + 计数 + 恢复展开状态 + 恢复常驻模式 + 高度调整
   */
  private initialLayout(): void {
    this.inputField.focus();
    this.updateCounter();
    this.restoreExpandState();
    this.restorePinnedState();
    this.autoResize();
    this.updatePinnedToggle();
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
   * 从 localStorage 恢复常驻模式（跨会话持久化，仅手动切换）
   *
   * 注意：handleShow 中的 isSensitive 自动检测会覆盖此值（仅本次会话），不持久化。
   * localStorage 不可用或无记录时默认为 default 模式（pinnedMode = false）。
   */
  private restorePinnedState(): void {
    const stored = safeGet(STORAGE_KEY_PINNED, '0');
    if (stored === '1') {
      this.pinnedMode = true;
      this.updatePinnedToggle();
      // 通知主进程持久抑制 blur
      void this.api.setPinnedMode(true);
    }
  }

  /**
   * 更新展开按钮视觉状态（.active 类 + aria-pressed + title 提示）
   */
  private updateExpandToggle(): void {
    if (this.expandMode) {
      this.expandToggle.classList.add('active');
      this.expandToggle.setAttribute('aria-pressed', 'true');
      this.expandToggle.title = '收起输入框（点击恢复紧凑高度）';
    } else {
      this.expandToggle.classList.remove('active');
      this.expandToggle.setAttribute('aria-pressed', 'false');
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

  // ── 常驻模式 ──

  /**
   * 更新常驻模式切换按钮视觉状态
   *
   * 通过切换 SVG <use href> 在 lock/unlock icon 间切换（与主窗口 icon 系统对齐）。
   * 🔒 = 常驻模式开启（持久钉住），🔓 = default 模式（blur 时延迟关闭）
   */
  private updatePinnedToggle(): void {
    const useEl = this.pinnedToggle.querySelector('use');
    if (useEl) {
      useEl.setAttribute('href', this.pinnedMode ? '#icon-lock' : '#icon-unlock');
    }
    if (this.pinnedMode) {
      this.pinnedToggle.classList.add('active');
      this.pinnedToggle.setAttribute('aria-pressed', 'true');
      this.pinnedToggle.title = '常驻模式开启：浮窗持久钉住（点击切换）';
    } else {
      this.pinnedToggle.classList.remove('active');
      this.pinnedToggle.setAttribute('aria-pressed', 'false');
      this.pinnedToggle.title = '常驻模式关闭：失焦后关闭窗口（点击切换）';
    }
  }

  /**
   * 切换常驻模式（手动覆盖自动检测）
   *
   * 手动切换持久化到 localStorage，跨会话保留用户偏好。
   * 注意：handleShow 中的 isSensitive 自动检测不持久化，仅本次会话生效。
   *
   * 浮窗永远 alwaysOnTop=true + skipTaskbar=true，pinnedMode 仅控制 blur 是否关闭 + alwaysOnTop 强制恢复。
   */
  private togglePinnedMode(): void {
    this.pinnedMode = !this.pinnedMode;
    safeSet(STORAGE_KEY_PINNED, this.pinnedMode ? '1' : '0');
    this.updatePinnedToggle();
    // 通知主进程切换 pinned 状态（持久 suppressBlurClose 开关）
    void this.api.setPinnedMode(this.pinnedMode);
  }

  // ── 确认流程 ──

  /**
   * 解锁输入框，恢复为可编辑状态
   *
   * 集中管理 disabled/readOnly 的复原逻辑，避免各方法中分散重置导致遗漏。
   * 注意：仅复原锁状态，不清空 Toast 内容（由调用方负责）。
   */
  private unlockInput(): void {
    this.inputField.disabled = false;
    this.inputField.readOnly = false;
  }

  /**
   * 确认提交成功后调度 Toast 展示 + 重置输入框
   *
   * 所有模式统一走"短 Toast + resetInputForNext"路径（连续输入）。
   * 关闭由 blur（default 模式）或 Esc/关闭按钮（pinned 模式）触发，不由 Toast 定时关闭。
   */
  private scheduleSuccessToast(result: { mode: 'paste' | 'copy'; appName?: string }): void {
    if (result.mode === 'paste') {
      this.showPastedToast(result.appName);
    } else {
      this.showCopyToast();
    }
    this.scheduleToast(() => this.resetInputForNext());
  }

  /**
   * 确认输入：调用 IPC（主进程优先自动粘贴，降级写剪贴板）+ 显示 Toast
   *
   * 提交成功后统一清空输入等待下次输入（连续输入）。
   * 关闭由 blur（default 模式）或 Esc/关闭按钮（pinned 模式）触发。
   */
  private async handleConfirm(): Promise<void> {
    if (this.isSubmitting) return;
    // 等待正在进行的记忆候选填充完成，避免读到填充前的旧 value
    // 场景：用户按 ←→ 选择记忆候选后立即按 Tab，fillFromMemory 的 showMemory IPC 尚未返回
    // await 后 inputField.value 一定是记忆内容（完整内容或降级截断预览）
    if (this.pendingFillPromise) {
      await this.pendingFillPromise;
    }
    const text = this.inputField.value;
    if (!text.trim()) {
      await this.api.closeQuickInput();
      return;
    }

    // 递增提交代次，标记本次请求的世代；IPC 返回后若代次不匹配则忽略过期响应
    const currentGen = ++this.submitGeneration;
    this.isSubmitting = true;
    this.inputField.disabled = true;
    // 提交时立即清空补全列表，避免候选遮挡 Toast
    this.completion?.clear();
    this.showPastingToast();

    try {
      const result = await this.api.confirmQuickInput(text, this.pinnedMode);
      // 竞态防护：若期间窗口被重新 show() 或开始了新提交，代次已变化，忽略过期响应
      if (currentGen !== this.submitGeneration) return;
      if (result.success) {
        // 持久化最近提交文本（用于补全回退候选 + 剪贴板智能预填去重）
        // 提交成功后才记录，失败/异常不污染历史
        this.recordRecentSubmission(text);
        // 统一显示 Toast 反馈（paste 完成后浮窗重显，Toast 可见）
        // default 模式 + pinned 模式 + copy 降级均显示 Toast，差异仅在主进程焦点处理
        this.scheduleSuccessToast(result);
      } else {
        // 失败分支：显示错误 Toast
        // result.success=false 但无 error 对象，按两段式静态文案（UX-14）
        this.showErrorToast('✗ 粘贴失败，请稍后重试');
        this.scheduleToast(() => this.resetInputState(text));
      }
    } catch (error) {
      // 竞态防护：仅在代次匹配时才处理错误（避免覆盖新状态）
      if (currentGen !== this.submitGeneration) return;
      reportError('QuickInput 确认', error);
      // 异常分支：显示错误 Toast
      // UX-14：用 formatErrorMessage 分类映射替代模板化"请重试"
      this.showErrorToast(`✗ ${formatErrorMessage('提交', error)}`);
      this.scheduleToast(() => this.resetInputState(text));
    }
  }

  /**
   * 重置输入框，准备下一次输入（所有模式统一行为）
   */
  private resetInputForNext(): void {
    this.isSubmitting = false;
    this.unlockInput();
    this.inputField.classList.remove('copy-toast', 'error');
    this.inputField.value = '';
    this.inputField.style.height = 'auto';
    this.updateCounter();
    this.baseInputHeight = INITIAL_BASE_HEIGHT;
    // 清空补全列表，确保下次输入从干净状态开始
    this.completion?.clear();
    this.resizeWindow();
    this.inputField.focus();
    // 空输入时显示最近提交历史（核心场景：Tab 提交后直接用方向键选择复用）
    // dispatch input 事件触发 handleInput 空查询分支，立即显示历史候选
    this.inputField.dispatchEvent(new Event('input'));
  }

  /**
   * 记录最近提交文本到 localStorage
   *
   * 用途：
   *   1. 补全候选回退源——记忆/对话匹配为空时，显示最近提交历史供快速复用
   *   2. 剪贴板智能预填去重——主进程读取此历史，若剪贴板内容与最近提交相同则跳过预填
   *
   * LRU 语义：新文本插入头部，相同文本去重（只保留最新），超出 MAX_RECENT_ENTRIES 淘汰尾部。
   * 仅在提交成功后调用（handleConfirm 的 result.success 分支），失败/异常不污染历史。
   *
   * @param text 本次提交成功的文本（已 trim 校验非空）
   */
  private recordRecentSubmission(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const recent = this.loadRecentSubmissions();
    // 去重：移除已存在的相同文本（大小写敏感，避免语义不同的同形文本被误删）
    const filtered = recent.filter((t) => t !== trimmed);
    // 插入头部（最近提交在前）
    filtered.unshift(trimmed);
    // 淘汰超限条目
    if (filtered.length > MAX_RECENT_ENTRIES) {
      filtered.length = MAX_RECENT_ENTRIES;
    }
    safeSetJSON(STORAGE_KEY_RECENT, filtered);
  }

  /**
   * 加载最近提交历史
   *
   * @returns 历史文本数组（按时间倒序，最近在前）；localStorage 不可用或损坏时返回空数组
   */
  private loadRecentSubmissions(): string[] {
    const raw = safeGetJSON<unknown>(STORAGE_KEY_RECENT, []);
    if (!Array.isArray(raw)) return [];
    // 过滤非字符串项（防御 JSON 损坏/手动篡改），保证类型安全
    return raw.filter((t): t is string => typeof t === 'string');
  }

  /**
   * 获取最近提交历史作为补全回退候选
   *
   * 供 QuickInputCompletion 在记忆/对话匹配为空时回退使用。
   * 按时间倒序取前 MAX_RECENT_FALLBACK_ITEMS 条，过滤掉与当前查询完全相同的文本
   *（用户已经输入了就不必再作为候选）。
   *
   * @param currentQuery 当前输入框查询文本（用于排除完全相同的候选）
   * @returns 历史候选文本数组（最近在前）
   */
  getRecentSubmissionsForCompletion(currentQuery: string): string[] {
    const query = currentQuery.trim();
    return this.loadRecentSubmissions()
      .filter((t) => t !== query)
      .slice(0, MAX_RECENT_FALLBACK_ITEMS);
  }

  /**
   * 重置输入框状态（确认失败时恢复原文本）
   *
   * @param text 要恢复的原始文本
   */
  private resetInputState(text: string): void {
    this.isSubmitting = false;
    this.unlockInput();
    this.inputField.classList.remove('copy-toast', 'error');
    this.inputField.value = text;
    // 恢复原文后清空补全列表，让 input 事件重新触发候选生成
    this.completion?.clear();
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

  /**
   * 显示错误 Toast（提交失败/粘贴失败时反馈用户）
   *
   * 使用 .copy-toast.error 变体（红色），与成功 Toast 形成 ✓/✗ 视觉对比。
   *
   * @param message 错误提示文案
   */
  private showErrorToast(message: string): void {
    this.inputField.value = message;
    this.inputField.classList.add('copy-toast', 'error');
    this.inputField.disabled = false;
    this.inputField.readOnly = true;
  }

  /**
   * 统一 Toast 定时关闭逻辑（3 处使用：成功/失败/异常）
   *
   * @param onClose Toast 到期后的回调（恢复输入状态/清空输入等）
   */
  private scheduleToast(onClose: () => void): void {
    this.toastCloseTimer = setTimeout(() => {
      this.toastCloseTimer = null;
      onClose();
    }, TOAST_DURATION_MS);
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
      // 重新计算窗口基础高度：
      // - .quick-input-area 的 offsetHeight 已含 textarea + gap + footer
      // - 额外加上 focus-bar 的高度（含 margin-bottom）——focus-bar 作为卡片头部在 container 内部
      // - 再加上 container 的上下 padding（var(--space-2) × 2 = 16px）
      // 通过 DOM 实际测量替代固定数值，避免 CSS 调整后偏移量失准
      const inputArea = this.inputField.parentElement;
      if (inputArea instanceof HTMLElement) {
        const container = inputArea.parentElement;
        const focusBar = container?.querySelector('#focus-bar');
        const focusBarHeight = focusBar instanceof HTMLElement ? focusBar.offsetHeight : 0;
        // focus-bar 的 margin-bottom（var(--space-1) = 4px）通过 offsetHeight 无法获取，
        // 用 getComputedStyle 读取实际 margin-bottom 值
        let focusBarMarginBottom = 0;
        if (focusBar instanceof HTMLElement) {
          focusBarMarginBottom = parseInt(getComputedStyle(focusBar).marginBottom, 10) || 0;
        }
        // container 上下 padding = var(--space-2) × 2
        const containerVerticalPadding = container instanceof HTMLElement
          ? (parseInt(getComputedStyle(container).paddingTop, 10) || 0)
            + (parseInt(getComputedStyle(container).paddingBottom, 10) || 0)
          : 16;
        this.baseInputHeight = inputArea.offsetHeight + focusBarHeight + focusBarMarginBottom + containerVerticalPadding;
      }
      this.resizeWindow();
    }
  }

  /**
   * 更新字符计数显示
   */
  private updateCounter(): void {
    this.counterEl.textContent = `${this.inputField.value.length} 字`;
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
      if (!this.completionList.classList.contains('hidden')) {
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
    // 递增提交代次，使飞行中的 IPC 响应失效（ESC 关闭期间过期响应不污染状态）
    this.submitGeneration++;
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
   *
   * 无聚焦时禁用 Tab（避免盲粘到错误目标）：tabEnabled 由聚焦提示栏联动控制，
   * 浮窗 blur → tabEnabled=false，浮窗 focus → tabEnabled=true。
   */
  private handleTab(): void {
    if (this.isSubmitting) return;
    if (!this.tabEnabled) return;
    void this.handleConfirm();
  }

  // ── 生命周期 ──

  /**
   * 清理资源：销毁补全管理器（移除事件监听器 + 清空定时器）
   *
   * 窗口销毁前调用（beforeunload）
   */
  cleanup(): void {
    // 移除拖动事件监听器（防止窗口销毁后事件泄漏）
    if (this.dragHandlers) {
      this.focusBarEl.removeEventListener('pointerdown', this.dragHandlers.pointerdown);
      this.focusBarEl.removeEventListener('pointermove', this.dragHandlers.pointermove);
      this.focusBarEl.removeEventListener('pointerup', this.dragHandlers.pointerup);
      this.dragHandlers = null;
    }
    // 清除聚焦栏点击防抖定时器
    if (this.recaptureClickTimer) {
      clearTimeout(this.recaptureClickTimer);
      this.recaptureClickTimer = null;
    }
    this.completion?.cleanup();
  }
}

/**
 * 初始化快速输入浮窗交互（工厂函数）
 *
 * 校验所有 DOM 元素后创建 QuickInputController 实例。
 * 校验失败时 reportError 并降级（不创建控制器）。
 * 校验通过后所有 DOM 字段非空，控制器内部无需重复 null 检查。
 */
function initQuickInput(): void {
  const inputEl = document.getElementById('quick-input-field');
  if (!(inputEl instanceof HTMLTextAreaElement)) {
    reportError('QuickInput init', new Error('quick-input-field 元素缺失或类型错误（应为 textarea）'));
    return;
  }
  const completionList = document.getElementById('completion-list');
  if (!(completionList instanceof HTMLElement)) {
    reportError('QuickInput init', new Error('completion-list 元素缺失'));
    return;
  }
  // footer 内的常驻模式切换按钮
  const pinnedToggle = document.getElementById('pinned-toggle');
  if (!(pinnedToggle instanceof HTMLElement)) {
    reportError('QuickInput init', new Error('pinned-toggle 元素缺失'));
    return;
  }
  const expandToggle = document.getElementById('expand-toggle');
  if (!(expandToggle instanceof HTMLElement)) {
    reportError('QuickInput init', new Error('expand-toggle 元素缺失'));
    return;
  }
  const polishToggle = document.getElementById('polish-toggle');
  if (!(polishToggle instanceof HTMLElement)) {
    reportError('QuickInput init', new Error('polish-toggle 元素缺失'));
    return;
  }
  // 顶部聚焦提示栏（拖动把手）
  const focusBarEl = document.getElementById('focus-bar');
  if (!(focusBarEl instanceof HTMLElement)) {
    reportError('QuickInput init', new Error('focus-bar 元素缺失'));
    return;
  }
  const counterEl = document.querySelector('.quick-input-counter');
  if (!(counterEl instanceof HTMLElement)) {
    reportError('QuickInput init', new Error('.quick-input-counter 元素缺失'));
    return;
  }
  // 顶部聚焦提示栏元素
  const focusAppNameEl = document.getElementById('focus-app-name');
  if (!(focusAppNameEl instanceof HTMLElement)) {
    reportError('QuickInput init', new Error('focus-app-name 元素缺失'));
    return;
  }
  const closeBtnEl = document.getElementById('close-btn');
  if (!(closeBtnEl instanceof HTMLElement)) {
    reportError('QuickInput init', new Error('close-btn 元素缺失'));
    return;
  }

  const electronApi = (window as unknown as { electronAPI?: QuickInputElectronAPI }).electronAPI;
  if (!electronApi) {
    reportError('QuickInput init', new Error('electronAPI 未注入（preload 加载失败）'));
    return;
  }

  const controller = new QuickInputController({
    inputField: inputEl,
    completionList,
    pinnedToggle,
    expandToggle,
    polishToggle,
    focusBarEl,
    counterEl,
    focusAppNameEl,
    closeBtnEl,
    api: electronApi,
  });
  controller.init();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initQuickInput);
} else {
  initQuickInput();
}
