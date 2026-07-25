/**
 * 快速输入浮窗管理
 *
 * 职责：
 *   1. 创建轻量浮窗（无边框、alwaysOnTop、失焦延迟关闭）
 *   2. 单例管理——多次呼出复用同一窗口，避免创建多个实例
 *   3. 失焦延迟关闭（200ms），给 Alt+Tab 切换留余量
 *   4. IPC 路由：确认输入（委托 PasteCoordinator + 降级写剪贴板）和关闭（仅关闭）
 *   5. 剪贴板感知预填（敏感检测 + 剪贴板文本预填输入框）
 *
 * 设计原则：
 *   - 独立于 tray/full 二态状态机，不参与 WindowStateManager.transition
 *   - 复用 preload.cjs（与 floatWindow / fullWindow 共用同一 preload）
 *   - 失焦不立即关闭，避免用户切换窗口查看内容时浮窗消失
 *
 * 集成点：
 *   - main.ts：快捷键 Ctrl+Shift+C 触发 show()
 *   - main.ts：IPC QUICK_INPUT_CONFIRM / QUICK_INPUT_CLOSE 处理
 *   - clipboardHandler：确认写入前调用 suppressNextChange() 抑制三重保护
 *   - pasteCoordinator：Phase 4 自动粘贴编排（恢复焦点 + 模拟 Ctrl+V）
 */

import * as path from 'node:path';
import { BrowserWindow, ipcMain, clipboard, screen } from 'electron';
import { injectThemeScript } from './themeInjector.js';
import { applyWindowSecurity } from './windowSecurity.js';
import { IPC_CHANNELS, MAIN_TO_RENDERER_CHANNELS } from '../ipc/channels.js';
import { ELECTRON_DIR } from '../esmShim.js';
import { logger } from 'memora';
// 剪贴板敏感内容检测（直接从 shared/sensitivePatterns.ts 导入，下沉后真理源在 shared 层）
import { isSensitive } from '../../shared/sensitivePatterns.js';
// Phase 4：自动粘贴协调器（从本类抽离的粘贴流程编排）
import { PasteCoordinator, type SuppressNextChange } from './pasteCoordinator.js';
// PasteResult 类型用于 CONFIRM handler 中 pasteResult 变量声明（attemptPaste 返回类型）
import type { PasteResult } from '../inputInjector.js';

/** 浮窗宽度（px）—— 足够单行输入 + 确认按钮 */
const QUICK_INPUT_WIDTH = 480;
/** 浮窗最小宽度（px）—— 保留基本输入体验 */
const QUICK_INPUT_MIN_WIDTH = 360;
/** 浮窗最大宽度（px）—— 避免过度拉伸 */
const QUICK_INPUT_MAX_WIDTH = 720;
/** 浮窗初始高度（px）—— focus-bar 28px + textarea 1行 + padding + footer，与 INITIAL_BASE_HEIGHT 对齐 */
const QUICK_INPUT_HEIGHT = 104;
/** 浮窗最大高度（px）—— 输入区 + 候选列表(最多 5 项×38px) + footer，与 CSS max-height:200px 对齐 */
const QUICK_INPUT_MAX_HEIGHT = 400;
/** 浮窗手动 resize 最大高度（px）—— 比自动最大高度多 50%，给用户更大空间 */
const QUICK_INPUT_RESIZE_MAX_HEIGHT = 600;
/** 失焦延迟关闭时长（ms）—— 给 Alt+Tab 切换留余量 */
const BLUR_CLOSE_DELAY_MS = 200;
/** 光标跟随偏移量（px）—— 浮窗相对鼠标位置的偏移 */
const CURSOR_OFFSET_PX = 16;
/** 剪贴板预填文本最大长度（防止超长文本撑爆输入框） */
const CLIPBOARD_PREFILL_MAX_LENGTH = 200;
/** 剪贴板预填触发补全的最小字符数（与补全管理器 MIN_QUERY_LENGTH 对齐） */
const CLIPBOARD_PREFILL_MIN_LENGTH = 2;
/** 确认/润色文本最大长度（防止恶意输入耗尽 LLM token / 触发速率限制） */
const MAX_CONFIRM_TEXT_LENGTH = 10000;

/** 剪贴板预填读取结果 */
interface ClipboardPrefillResult {
  /** 预填文本（null 表示不预填） */
  text: string | null;
  /** 剪贴板内容是否命中敏感模式（用于渲染进程自动进入常驻模式） */
  isSensitive: boolean;
}

/** 快速输入浮窗回调（由 main.ts 注入） */
export interface QuickInputWindowCallbacks {
  /**
   * 确认输入文本（主进程写入剪贴板 + 关闭浮窗）
   *
   * Phase 4：自动粘贴成功时此回调不调用（由 inputInjector.paste 接管剪贴板操作）。
   * 降级或未启用自动粘贴时走此回调（写剪贴板 + suppressNextChange）。
   *
   * @param text 用户确认的文本
   * @returns success 表示写入成功
   */
  onConfirm?: (text: string) => Promise<{ success: boolean }>;
  /**
   * 确认成功后异步回调（用于记忆沉淀，不阻塞关闭浮窗）
   *
   * 在 onConfirm 返回 success=true 后触发，或 Phase 4 paste 成功后触发。
   * 此回调内的错误不影响复制成功（用户已拿到剪贴板内容），
   * 仅记日志。浮窗此时可能已隐藏，但主进程仍在运行可完成写入。
   *
   * @param text 用户确认的文本（与 onConfirm 收到的一致）
   */
  onAfterConfirm?: (text: string) => void;
  /** 关闭浮窗（Esc / 取消触发，不写入剪贴板） */
  onClose?: () => void;
  /**
   * LLM 润色文本（由 main.ts 注入，调用 agent.polish?.polish()）
   *
   * 润色期间渲染进程显示 loading 状态，失败时返回错误信息供 Toast 展示。
   *
   * @param text 待润色的原始文本
   * @returns 润色结果 { polished: string; changed: boolean }
   */
  onPolish?: (text: string) => Promise<{ polished: string; changed: boolean }>;
}

/**
 * 确认结果
 *
 * mode='paste'：自动粘贴成功，渲染进程显示"已粘贴到 [应用名]"
 * mode='copy'：降级到复制+Toast，渲染进程显示"已复制，Ctrl+V 粘贴"
 */
export interface QuickInputConfirmResult {
  /** 是否成功（无论 paste 还是 copy 降级，只要用户拿到文本就 true） */
  success: boolean;
  /** 成功模式 */
  mode: 'paste' | 'copy';
  /** 粘贴目标应用名（paste 模式下供 Toast 显示） */
  appName?: string;
}

/**
 * 快速输入浮窗类
 *
 * 单例模式：create() 只在首次调用时创建窗口，后续 show() 复用。
 * 失焦延迟关闭：blur 事件后延迟 BLUR_CLOSE_DELAY_MS 关闭，
 * 若在延迟内窗口重新获得焦点则取消关闭。
 *
 * 职责：
 *   1. 窗口管理（创建/显示/隐藏/销毁/定位/失焦关闭）
 *   2. IPC 路由（CONFIRM/CLOSE/RESIZE 三通道）
 *   3. 剪贴板预填感知（敏感检测 + 文本预填）
 *   自动粘贴流程编排已抽离至 PasteCoordinator
 */
export class QuickInputWindow {
  /** BrowserWindow 单例（懒创建） */
  private win: BrowserWindow | null = null;
  /** 回调集合（由 main.ts 注入） */
  private callbacks: QuickInputWindowCallbacks;
  /** 失焦延迟关闭定时器 */
  private blurCloseTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * 常驻模式开关
   *
   * true=持久钉住浮窗，blur 不关闭
   * false=default 模式，blur 触发 200ms 延迟关闭
   *
   * 由渲染进程通过 QUICK_INPUT_SET_PINNED_MODE IPC 切换
   */
  private pinnedMode = false;
  /** IPC handler 是否已注册（防止重复注册） */
  private ipcRegistered = false;
  /** paste 流程进行中标记
   *
   * 根因修复（Tab 提交闪烁）：
   *   paste 流程耗时 200-600ms（PowerShell SendInput ~100ms + pasteDelay 100-500ms），
   *   超过 blur 关闭延迟 200ms。default 模式下 paste 期间浮窗 blur → scheduleBlurClose
   *   定时器触发 hide → paste 完成后 focus 重新 show，视觉上闪烁。
   *   此标记在 paste 期间设为 true，blur 事件检查此标记跳过 scheduleBlurClose。
   *
   * 与 pinnedMode 的区别：
   *   - pinnedMode 是用户态偏好（持久抑制 blur close）
   *   - pasteInProgress 是流程态标志（仅在 paste 期间临时抑制，paste 完成立即清除）
   */
  private pasteInProgress = false;
  /**
   * 重捕获进行中标记
   *
   * 防止手动重捕获（RECAPTURE_TARGET IPC）与 blur 自动重捕获并发。
   * blur 事件处理器检查此标记，手动重捕获期间跳过自动重捕获。
   */
  private recaptureInProgress = false;
  /**
   * blur 自动重捕获防抖定时器（仅 pinned 模式下生效）
   *
   * 浮窗失焦后延迟 200ms 执行重捕获。若在延迟内浮窗恢复焦点（用户点击回来），
   * 定时器被取消，避免误触发。仅在 pinnedMode=true 且 pasteInProgress=false 时启动。
   */
  private recaptureDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * 前台窗口轮询定时器（pinned 模式下持续检测前台窗口变化）
   *
   * blur 事件依赖浮窗自身焦点状态，在 alwaysOnTop 浮窗下 paste 后 win.focus() 恢复焦点
   * 不可靠，导致 blur 不触发 → 自动重捕获链断裂。轮询 GetForegroundWindow() 独立于
   * 焦点状态，每 300ms 检查一次，作为 blur 事件的可靠性兜底。
   */
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * 用户是否手动 resize 过窗口（本次 show 生命周期内）
   *
   * 设为 true 后，渲染进程的 QUICK_INPUT_RESIZE（候选列表显示/隐藏触发的动态高度调整）
   * 将被跳过，保护用户自主设定的尺寸不被覆盖。
   * 每次 show() 时重置为 false，让自动高度调整重新生效。
   */
  private userResized = false;
  /**
   * 程序化 resize 跳过标记
   *
   * Electron 的 resize 事件不区分用户拖拽和 setSize() 调用。
   * 此标记在程序化 setSize() 前设为 true，resize 事件处理器检查此标记跳过 userResized 设置。
   */
  private skipResizeFlag = false;
  /** Phase 4：自动粘贴协调器（封装 InputInjector + 前台窗口捕获 + 剪贴板保护） */
  private pasteCoordinator = new PasteCoordinator();

  constructor(callbacks: QuickInputWindowCallbacks = {}) {
    this.callbacks = callbacks;
  }

  /**
   * 创建浮窗（懒创建，仅首次调用时执行）
   *
   * 窗口属性：
   * - frame: false（无边框，纯输入框）
   * - alwaysOnTop: true（始终置顶）
   * - skipTaskbar: true（不在任务栏显示）
   * - resizable: true（用户可手动拖拽边缘调整尺寸，min/max 约束范围）
   * - show: false（创建时不显示，由 show() 控制）
   */
  private async create(): Promise<BrowserWindow> {
    const win = new BrowserWindow({
      width: QUICK_INPUT_WIDTH,
      height: QUICK_INPUT_HEIGHT,
      minWidth: QUICK_INPUT_MIN_WIDTH,
      maxWidth: QUICK_INPUT_MAX_WIDTH,
      minHeight: QUICK_INPUT_HEIGHT,
      maxHeight: QUICK_INPUT_RESIZE_MAX_HEIGHT,
      frame: false,
      resizable: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      // 浅色主题背景色（对齐完整窗口，避免启动闪烁）
      backgroundColor: '#f0f0f2',
      webPreferences: {
        // 最小化 preload：preloadQuickInput.cjs 仅暴露 9 个 API（ADR-SP-017 §1）
        preload: path.join(ELECTRON_DIR, 'preloadQuickInput.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    // 先赋值 this.win + 注册 IPC handlers，再 loadFile
    // 原因：渲染进程 init() 在 loadFile 时执行，会发送 setPinnedMode 等 IPC
    // 若 IPC handler 还未注册，IPC 丢失，导致渲染进程 UI 与主进程状态不一致
    this.win = win;
    this.registerIpcHandlers();

    // 主进程注入主题初始化脚本
    injectThemeScript(win.webContents);

    // 加载浮窗 HTML（渲染进程 init() 在此执行，此时 IPC handlers 已就绪）
    const htmlPath = path.join(ELECTRON_DIR, 'renderer', 'quick-input', 'quick-input.html');
    await win.loadFile(htmlPath);

    // 安全防护：拦截外部导航和弹窗（applyWindowSecurity 集中维护，ADR-017 枝叶层 2 次提取）
    applyWindowSecurity(win);

    // 失焦延迟关闭：给 Alt+Tab 切换留余量（pinned 模式 / paste 期间不关闭）
    // paste 期间抑制 blur close 是为了防止 default 模式下 paste 流程触发的 blur 事件
    // 启动 hide 定时器（paste 耗时 200-600ms > blur 延迟 200ms），导致 hide→show 闪烁
    // pinned 模式：启动自动重捕获防抖定时器，用户切到其他窗口后自动更新粘贴目标
    win.on('blur', () => {
      if (this.pasteInProgress) return;
      if (this.pinnedMode) {
        // pinned 模式：自动重捕获（不关闭浮窗，仅更新粘贴目标）
        // 手动重捕获进行中时跳过，避免并发
        if (this.recaptureInProgress) return;
        this.scheduleAutoRecapture();
        return;
      }
      this.scheduleBlurClose();
    });
    win.on('focus', () => {
      this.cancelBlurClose();
      // pinned 模式下 focus 恢复时取消防抖定时器（用户点击回了浮窗，不需重捕获）
      this.cancelAutoRecapture();
    });
    // 手动 resize 检测：用户拖拽窗口边缘时，框架自动触发 resize 事件
    // 程序化 setSize() 调用前通过 skipResizeFlag 跳过，避免误判
    win.on('resize', () => {
      if (this.skipResizeFlag) {
        this.skipResizeFlag = false;
        return;
      }
      this.userResized = true;
    });
    // 关闭时清理资源
    win.on('closed', () => {
      this.win = null;
      this.cancelBlurClose();
    });

    return win;
  }

  /**
   * 显示浮窗（单例复用）
   *
   * 若窗口尚未创建则先创建。显示时跟随鼠标光标位置弹出（右侧下方偏移），
   * 屏幕边缘溢出时自动回弹到左侧/顶部，聚焦输入框准备接收用户输入。
   *
   * show() 第一步先捕获前台窗口（必须在 create() 之前，
   * 否则浮窗自身会成为前台窗口），用于后续自动粘贴恢复焦点。
   */
  async show(): Promise<void> {
    // 捕获前台窗口（必须在 create()/show() 之前，否则浮窗自身会成为前台窗口）
    // 若浮窗已存在且可见（pinned 模式连续呼出场景），先隐藏再捕获，避免误捕浮窗自身
    const existingWin = this.win;
    const wasVisible = existingWin && !existingWin.isDestroyed() && existingWin.isVisible();
    if (wasVisible && existingWin) {
      existingWin.hide();
      // hide() 后 Windows 需要时间切换前台窗口，等待 50ms 确保 capturePreviousWindow 捕获到正确窗口
      // 不加延迟时 nut-js 可能仍返回浮窗自身（Windows 前台窗口切换是异步的）
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    // 提取浮窗的 Win32 HWND 用于排除浮窗自身（绕过 nut-js GetWindowTextA 编码 bug）
    // ADR-SP-018：不再依赖窗口标题字符串比较，改用 HWND 直接比较
    const floatHwnd = existingWin
      ? Number(existingWin.getNativeWindowHandle().readBigUInt64LE(0))
      : undefined;
    await this.pasteCoordinator.capturePreviousWindow(floatHwnd);

    if (!this.isWinAlive()) {
      await this.create();
    }

    const win = this.win!;
    // 跟随鼠标光标定位：默认在鼠标右下方偏移 CURSOR_OFFSET_PX
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const workArea = display.workArea;
    const { width, height } = win.getBounds();

    // 默认偏移：鼠标右侧 + 下方各 CURSOR_OFFSET_PX
    let x = cursor.x + CURSOR_OFFSET_PX;
    let y = cursor.y + CURSOR_OFFSET_PX;
    // 边缘溢出回弹：右侧溢出则改到鼠标左侧，底部溢出则贴工作区底部
    if (x + width > workArea.x + workArea.width) {
      x = cursor.x - width - CURSOR_OFFSET_PX;
    }
    if (y + height > workArea.y + workArea.height) {
      y = workArea.y + workArea.height - height - CURSOR_OFFSET_PX;
    }
    // 确保不超出工作区左边界（负坐标回弹到工作区左边）
    if (x < workArea.x) {
      x = workArea.x;
    }
    if (y < workArea.y) {
      y = workArea.y;
    }
    win.setPosition(Math.round(x), Math.round(y));

    this.cancelBlurClose();
    // 重置手动 resize 标记 + 恢复初始尺寸，让自动高度调整重新生效
    this.userResized = false;
    this.skipResizeFlag = true;
    win.setSize(QUICK_INPUT_WIDTH, QUICK_INPUT_HEIGHT, true);
    win.show();
    win.focus();
    // 通知渲染进程：携带剪贴板预填文本 + 敏感标记，替代 focus 事件避免 Alt+Tab 切回误清空
    const prefill = this.readClipboardForPrefill();
    win.webContents.send(MAIN_TO_RENDERER_CHANNELS.QUICK_INPUT_SHOW, { clipboardText: prefill.text, isSensitive: prefill.isSensitive });
    // 通知渲染进程当前聚焦应用名（联动 focus-bar 显示 + Tab 启用）
    const appName = await this.pasteCoordinator.getCapturedAppName();
    this.notifyFocusChange(appName);
  }

  /**
   * 在指定位置显示浮窗（STEP-4 交互重构：浮球单击入口）
   *
   * 与 show() 的区别：
   *   - 不使用光标位置，改用传入的锚点坐标（浮球下方）
   *   - excludeHwnd 用于排除浮球窗口自身（浮球单击后成为前台窗口）
   *   - 其余逻辑（创建、捕获、预填、focus-bar 通知）与 show() 完全一致
   *
   * @param anchorX 弹窗锚点 x 坐标（屏幕坐标）
   * @param anchorY 弹窗锚点 y 坐标（屏幕坐标，取浮球底部）
   * @param excludeHwnd 需从前台窗口捕获中排除的 HWND（浮球窗口）
   */
  async showAtPosition(anchorX: number, anchorY: number, excludeHwnd?: number): Promise<void> {
    // 若浮窗已存在且可见，先隐藏再捕获（与 show() 一致的时序）
    const existingWin = this.win;
    const wasVisible = existingWin && !existingWin.isDestroyed() && existingWin.isVisible();
    if (wasVisible && existingWin) {
      existingWin.hide();
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    // 使用传入的 excludeHwnd 排除不应捕获的窗口（浮球自身）
    await this.pasteCoordinator.capturePreviousWindow(excludeHwnd);

    if (!this.isWinAlive()) {
      await this.create();
    }

    const win = this.win!;
    const { width, height } = win.getBounds();
    const display = screen.getDisplayNearestPoint({ x: anchorX, y: anchorY });
    const workArea = display.workArea;

    // 默认在锚点下方偏移（浮球顶部 + 浮球高度 + 偏移量 = 浮球下方 16px）
    let x = anchorX;
    let y = anchorY;
    // 边缘溢出回弹：右侧溢出则改到浮球左侧，底部溢出则贴工作区底部
    if (x + width > workArea.x + workArea.width) {
      x = anchorX - width - CURSOR_OFFSET_PX;
    }
    if (y + height > workArea.y + workArea.height) {
      y = workArea.y + workArea.height - height - CURSOR_OFFSET_PX;
    }
    if (x < workArea.x) x = workArea.x;
    if (y < workArea.y) y = workArea.y;
    win.setPosition(Math.round(x), Math.round(y));

    this.cancelBlurClose();
    this.userResized = false;
    this.skipResizeFlag = true;
    win.setSize(QUICK_INPUT_WIDTH, QUICK_INPUT_HEIGHT, true);
    win.show();
    win.focus();
    const prefill = this.readClipboardForPrefill();
    win.webContents.send(MAIN_TO_RENDERER_CHANNELS.QUICK_INPUT_SHOW, { clipboardText: prefill.text, isSensitive: prefill.isSensitive });
    const appName = await this.pasteCoordinator.getCapturedAppName();
    this.notifyFocusChange(appName);
  }

  /**
   * 通知渲染进程聚焦变化（主→渲染 IPC）
   *
   * appName=null 表示浮窗失去焦点（用户切走），渲染进程显示"无聚焦"+ 禁用 Tab
   * appName=string 表示浮窗获得焦点，渲染进程显示"聚焦：{应用名}"+ 激活 Tab
   */
  private notifyFocusChange(appName: string | null): void {
    if (this.isWinAlive()) {
      this.win!.webContents.send(MAIN_TO_RENDERER_CHANNELS.QUICK_INPUT_FOCUS_CHANGE, appName);
    }
  }

  /**
   * 判断窗口是否存活（非 null 且未销毁）
   *
   * ADR-017 枝叶层 2 次提取原则：本类中 8+ 处使用此守卫模式，提取为方法消除重复。
   *
   * 调用方约定：
   *   - early return：if (!this.isWinAlive()) return;
   *   - 正向判断后访问：if (this.isWinAlive()) { this.win!.method(); }
   *     （TypeScript 无法通过方法返回值收窄 this.win 类型，需显式 `!` 非空断言）
   *
   * @returns true 表示窗口可用，false 表示未创建或已销毁
   */
  private isWinAlive(): boolean {
    return this.win !== null && !this.win.isDestroyed();
  }

  /**
   * 包装 IPC handler 逻辑，统一 try/catch + logger.error + 降级返回
   *
   * ADR-017 枝叶层 2 次提取原则：本类中 RESIZE / MOVE_QUICK_INPUT / POLISH 三处
   * 使用相同的 try/catch + logger.error 模式，提取为通用包装器消除重复。
   *
   * 设计取舍：
   *   - CONFIRM handler 未使用此包装器——其内部有嵌套 try/catch（onAfterConfirm）+
   *     多分支降级逻辑，包装后反而降低可读性，保留独立 try/catch 结构
   *   - fallback 通过 closure 捕获，支持各 handler 特定的降级返回值
   *
   * @param msg 错误日志描述（用于排查）
   * @param fallback 失败时返回的降级值（通过 closure 捕获上下文）
   * @param fn 待包装的操作（同步或异步）
   * @returns fn 成功时的结果，或失败时的 fallback
   */
  private async wrapIpcHandler<T>(
    msg: string,
    fallback: T,
    fn: () => T | Promise<T>,
  ): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      logger.error({ error }, msg);
      return fallback;
    }
  }

  /**
   * 读取剪贴板内容并做敏感检测，返回预填文本 + 敏感标记
   *
   * 敏感内容（token/信用卡/密码/私钥/AWS key）：text=null（不预填），isSensitive=true（通知渲染进程自动进入持久模式）。
   * 过短内容（< 2 字符）：text=null，isSensitive=false。
   * 超长内容截断到 200 字符。
   *
   * @returns 预填结果（text + isSensitive）
   */
  private readClipboardForPrefill(): ClipboardPrefillResult {
    try {
      const raw = clipboard.readText();
      const trimmed = raw.trim();
      if (trimmed.length < CLIPBOARD_PREFILL_MIN_LENGTH) {
        return { text: null, isSensitive: false };
      }
      const sensitiveResult = isSensitive(trimmed);
      if (sensitiveResult.sensitive) {
        // 敏感内容不预填，但通知渲染进程进入常驻模式
        return { text: null, isSensitive: true };
      }
      return { text: trimmed.slice(0, CLIPBOARD_PREFILL_MAX_LENGTH), isSensitive: false };
    } catch (error) {
      // 剪贴板读取失败不阻断浮窗显示，记录 warn 便于排查
      logger.warn({ error }, 'readClipboardForPrefill failed');
      return { text: null, isSensitive: false };
    }
  }

  /**
   * 隐藏浮窗（不销毁，复用单例）
   *
   * 清空输入框内容（由渲染进程在 close 事件中处理）。
   */
  hide(): void {
    if (this.isWinAlive()) {
      this.win!.hide();
    }
    this.cancelBlurClose();
    this.stopPolling(); // 隐藏时停止轮询，避免后台空转
  }

  /**
   * 注册 IPC 处理器（仅注册一次）
   *
   * - QUICK_INPUT_CONFIRM：渲染进程发送确认文本，主进程写入剪贴板 + 关闭浮窗
   * - QUICK_INPUT_CLOSE：渲染进程请求关闭（Esc / 取消按钮）
   */
  private registerIpcHandlers(): void {
    if (this.ipcRegistered) return;
    this.ipcRegistered = true;

    // 确认输入：Phase 4 优先自动粘贴，降级走 onConfirm 写剪贴板
    // 两种模式统一重聚焦支持流式输入（_pinnedMode 保留接口兼容，不再影响焦点行为）
    ipcMain.handle(IPC_CHANNELS.QUICK_INPUT_CONFIRM, async (_event, text: string, _pinnedMode?: boolean): Promise<QuickInputConfirmResult> => {
      try {
        // 参数校验：文本必须是字符串且非空
        if (typeof text !== 'string' || text.length === 0) {
          return { success: false, mode: 'copy' };
        }
        // 截断超长文本（防止恶意输入）
        const safeText = text.slice(0, MAX_CONFIRM_TEXT_LENGTH);

        // paste 期间的处理策略：浮窗保持可见（no-op hideFloat）
        // PowerShell SendInput 发送 Ctrl+V 到目标窗口，浮窗保持 alwaysOnTop=true，
        // 目标窗口通过 SetForegroundWindow 获焦后接收键盘事件（焦点 ≠ z-order）
        const hideFloat = () => { /* no-op：浮窗保持可见，避免 hide/show 闪烁 */ };
        // 标记 paste 进行中：抑制 blur 触发的 scheduleBlurClose，防止 default 模式下
        // paste 耗时 > 200ms 触发 hide → paste 完成后 focus 重新 show 导致视觉闪烁
        this.pasteInProgress = true;
        let pasteResult: PasteResult;
        try {
          pasteResult = await this.pasteCoordinator.attemptPaste(safeText, hideFloat);
        } finally {
          // finally 块确保即使 paste 抛错也清除标记 + 取消可能已调度的 blur 定时器
          this.pasteInProgress = false;
          this.cancelBlurClose();
        }
        // paste 完成：浮窗保持可见，按模式恢复焦点 + 置顶
        if (this.isWinAlive()) {
          // pinned 模式强制恢复置顶：paste 期间目标窗口 SetForegroundWindow 可能
          // 影响 z-order（特别是目标窗口本身是 alwaysOnTop 或系统调整 z-order 时），
          // pinned 模式必须保证浮窗视觉置顶，否则出现"加锁未置顶"bug
          if (this.pinnedMode) {
            this.win!.setAlwaysOnTop(true);
          }
          // 两种模式统一重聚焦浮窗支持流式连续输入（锁定模式 = 流式输入的升级版）
          this.win!.focus();
        }

        if (pasteResult.success && pasteResult.mode === 'paste') {
          // 粘贴成功：调用 onAfterConfirm 记忆沉淀（仅在粘贴成功后才记）
          try {
            this.callbacks.onAfterConfirm?.(safeText);
          } catch (err) {
            logger.warn({ err }, '快速输入记忆沉淀失败（不影响粘贴结果）');
          }
          return { success: true, mode: 'paste', appName: pasteResult.appName };
        }

        // 降级日志（用于诊断降级原因）
        if (pasteResult.reason) {
          logger.debug({ reason: pasteResult.reason }, 'Phase 4 自动粘贴降级到复制模式');
        }

        // 降级路径 / Phase 3 兼容路径：走 onConfirm 写剪贴板
        const result = await this.callbacks.onConfirm?.(safeText) ?? { success: false };
        if (result.success) {
          // copy 降级时浮窗 show + Toast 显示"已复制，Ctrl+V 粘贴"，
          // 用户切到原窗口 Ctrl+V 时浮窗 blur 200ms 后自动关闭
          // 异步沉淀记忆（不阻塞，错误隔离）
          try {
            this.callbacks.onAfterConfirm?.(safeText);
          } catch (err) {
            logger.warn({ err }, '快速输入记忆沉淀失败（不影响复制结果）');
          }
        }
        return { success: result.success, mode: 'copy' };
      } catch (error) {
        logger.error({ error }, '快速输入确认失败');
        return { success: false, mode: 'copy' };
      }
    });

    // 关闭浮窗：不写入剪贴板
    ipcMain.handle(IPC_CHANNELS.QUICK_INPUT_CLOSE, async () => {
      this.hide();
      this.callbacks.onClose?.();
      return undefined;
    });

    // 调整浮窗高度：候选列表显示/隐藏时由渲染进程触发
    ipcMain.handle(IPC_CHANNELS.QUICK_INPUT_RESIZE, async (_event, height: number) => {
      return this.wrapIpcHandler('调整浮窗高度失败', undefined, () => {
        if (!this.isWinAlive()) return;
        // 用户手动 resize 后跳过自动高度调整，保护用户设定的尺寸
        if (this.userResized) return;
        // 参数校验：高度必须是合理范围内的正整数
        if (typeof height !== 'number' || height < QUICK_INPUT_HEIGHT || height > QUICK_INPUT_MAX_HEIGHT) {
          return;
        }
        const { width } = this.win!.getBounds();
        this.skipResizeFlag = true;
        this.win!.setSize(width, Math.round(height), true);
        // resize 后检查位置，防止溢出屏幕边缘
        this.keepWindowInWorkArea();
      });
    });

    // 拖动浮窗位置：focus-bar 顶部标题栏可拖，dx/dy 增量移动（与 float 一致的 PointerEvent 模式）
    // 不持久化位置：每次唤起仍在光标跟随位置显示，拖动仅本次会话生效
    ipcMain.on(IPC_CHANNELS.MOVE_QUICK_INPUT, (_event, dx: number, dy: number) => {
      // ipcMain.on 无返回值，用 void 显式忽略 wrapIpcHandler 返回的 Promise
      void this.wrapIpcHandler('拖动浮窗位置失败', undefined, () => {
        if (!this.isWinAlive()) return;
        // 参数校验：增量必须是有限数字
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
        const [currentX, currentY] = this.win!.getPosition() as [number, number];
        const newX = currentX + Math.round(dx);
        const newY = currentY + Math.round(dy);
        // 先 clamp 到工作区再 setPosition，避免窗口短暂超出边缘再被拉回导致视觉挤压
        const clamped = this.clampPositionToWorkArea(newX, newY);
        this.win!.setPosition(clamped.x, clamped.y);
      });
    });

    // LLM 润色文本：渲染进程请求润色，主进程调用 onPolish 回调（main.ts 注入 agent.polish?.polish()）
    // 润色期间渲染进程显示 loading 状态，失败时返回错误信息供 Toast 展示
    ipcMain.handle(IPC_CHANNELS.QUICK_INPUT_POLISH, async (_event, text: string) => {
      // fallback 通过 closure 捕获 text，润色失败时返回原文（降级，不阻塞用户操作）
      return this.wrapIpcHandler(
        'LLM 润色文本失败',
        { polished: typeof text === 'string' ? text : '', changed: false },
        async () => {
          // 参数校验：文本必须是字符串且非空
          if (typeof text !== 'string' || text.length === 0) {
            return { polished: '', changed: false };
          }
          // 截断超长文本（防止耗尽 LLM token / 触发速率限制，与 CONFIRM 对齐 10000 字符上限）
          const safeText = text.slice(0, MAX_CONFIRM_TEXT_LENGTH);
          if (!this.callbacks.onPolish) {
            return { polished: safeText, changed: false };
          }
          return await this.callbacks.onPolish(safeText);
        },
      );
    });

    // 切换常驻模式：渲染进程通知主进程抑制/恢复 blur 关闭
    // pinned 模式下强制 alwaysOnTop=true（防止系统事件重置置顶）
    ipcMain.handle(IPC_CHANNELS.QUICK_INPUT_SET_PINNED_MODE, (_event, pinned: boolean) => {
      this.pinnedMode = typeof pinned === 'boolean' ? pinned : false;
      if (this.isWinAlive() && this.pinnedMode) {
        this.win!.setAlwaysOnTop(true);
        // pinned 模式启动轮询：blur 事件可能不可靠，轮询作为兜底
        this.startPolling();
      } else {
        // 退出 pinned 模式时停止轮询
        this.stopPolling();
      }
      return { success: true };
    });

    // 手动重捕获前台窗口（聚焦栏点击触发）
    // 流程：设置 recaptureInProgress → 调用 PasteCoordinator.recapture() → 推送 IPC → 清除标记
    ipcMain.handle(IPC_CHANNELS.RECAPTURE_TARGET, async () => {
      // 防止与 blur 自动重捕获并发
      this.recaptureInProgress = true;
      try {
        const floatHwnd = this.getFloatHwnd();
        const result = await this.pasteCoordinator.recapture(floatHwnd);
        if (result && this.isWinAlive()) {
          this.win!.webContents.send(MAIN_TO_RENDERER_CHANNELS.QUICK_INPUT_FOCUS_CHANGE, result.title);
        }
        return result;
      } finally {
        this.recaptureInProgress = false;
      }
    });
  }

  /**
   * 将目标位置 clamp 到当前窗口所在显示器的工作区内
   *
   * 使用 getDisplayMatching（基于窗口 bounds）而非 getDisplayNearestPoint（基于光标），
   * 避免拖动时光标快速移动到相邻显示器导致用错误的 workArea 修正。
   *
   * @param x 目标 x 坐标
   * @param y 目标 y 坐标
   * @returns clamp 后的 {x, y}（已取整）
   */
  private clampPositionToWorkArea(x: number, y: number): { x: number; y: number } {
    if (!this.win) return { x, y };
    const { width, height } = this.win.getBounds();
    // 基于窗口 bounds 匹配显示器，避免光标在边缘时匹配到相邻显示器
    const display = screen.getDisplayMatching({ x, y, width, height });
    const workArea = display.workArea;

    let newX = x;
    let newY = y;

    // 右侧溢出：贴右边界
    if (newX + width > workArea.x + workArea.width) {
      newX = workArea.x + workArea.width - width;
    }
    // 底部溢出：贴底边界
    if (newY + height > workArea.y + workArea.height) {
      newY = workArea.y + workArea.height - height;
    }
    // 左侧溢出：贴左边界
    if (newX < workArea.x) {
      newX = workArea.x;
    }
    // 顶部溢出：贴顶边界
    if (newY < workArea.y) {
      newY = workArea.y;
    }

    return { x: Math.round(newX), y: Math.round(newY) };
  }

  /**
   * 确保窗口始终在工作区内，防止溢出屏幕边缘
   *
   * 场景：
   *   1. resize 后高度增加，可能超出屏幕底部
   *   2. textarea 自动高度调整后，浮窗变高可能超出边缘
   */
  private keepWindowInWorkArea(): void {
    if (!this.isWinAlive()) return;
    const { x, y } = this.win!.getBounds();
    const clamped = this.clampPositionToWorkArea(x, y);
    // 仅在位置变化时才更新，避免不必要的重绘
    if (clamped.x !== x || clamped.y !== y) {
      this.win!.setPosition(clamped.x, clamped.y);
    }
  }

  /**
   * 调度失焦延迟关闭
   *
   * 失焦后延迟 BLUR_CLOSE_DELAY_MS 关闭，若期间窗口重新获得焦点则取消。
   */
  private scheduleBlurClose(): void {
    this.cancelBlurClose();
    this.blurCloseTimer = setTimeout(() => {
      this.hide();
    }, BLUR_CLOSE_DELAY_MS);
  }

  /**
   * 取消失焦延迟关闭
   */
  private cancelBlurClose(): void {
    if (this.blurCloseTimer) {
      clearTimeout(this.blurCloseTimer);
      this.blurCloseTimer = null;
    }
  }

  /**
   * 启动 blur 自动重捕获防抖定时器（仅 pinned 模式下调用）
   *
   * 浮窗失焦后延迟 200ms 执行重捕获。若在延迟内 focus 恢复，
   * cancelAutoRecapture() 会清除定时器。
   */
  private scheduleAutoRecapture(): void {
    this.cancelAutoRecapture();
    this.recaptureDebounceTimer = setTimeout(() => {
      this.recaptureDebounceTimer = null;
      void this.autoRecapture();
    }, BLUR_CLOSE_DELAY_MS);
  }

  /**
   * 取消 blur 自动重捕获防抖定时器
   */
  private cancelAutoRecapture(): void {
    if (this.recaptureDebounceTimer) {
      clearTimeout(this.recaptureDebounceTimer);
      this.recaptureDebounceTimer = null;
    }
  }

  /**
   * 启动前台窗口轮询（pinned 模式专用）
   *
   * 每 300ms 通过 koffi GetForegroundWindow() 检查前台窗口是否变化。
   * 变化时执行同步重捕获并推送更新。独立于浮窗焦点状态，blur 事件不可靠时的兜底机制。
   */
  private startPolling(): void {
    this.stopPolling(); // 防止重复启动
    this.pollingTimer = setInterval(() => {
      void this.pollAndRecapture();
    }, 300);
  }

  /**
   * 停止前台窗口轮询
   */
  private stopPolling(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
  }

  /**
   * 轮询回调：检查前台窗口变化并推送更新
   */
  private async pollAndRecapture(): Promise<void> {
    if (!this.isWinAlive() || this.pasteInProgress || this.recaptureInProgress) return;
    const floatHwnd = this.getFloatHwnd();
    if (floatHwnd === undefined) return;
    // 同步检查 + 重捕获（koffi 调用均在同步路径，无 async 开销）
    const result = this.pasteCoordinator.checkAndRecapture(floatHwnd);
    if (result && this.isWinAlive()) {
      this.win!.webContents.send(MAIN_TO_RENDERER_CHANNELS.QUICK_INPUT_FOCUS_CHANGE, result.title);
    }
  }

  /**
   * 执行自动重捕获（blur 防抖到期后调用）
   *
   * 委托 PasteCoordinator.recapture() 获取前台窗口，
   * 成功时通过 IPC 推送新应用名到渲染进程更新聚焦栏。
   */
  private async autoRecapture(): Promise<void> {
    // 双重检查：防抖期间 pasteInProgress 可能已变为 true
    if (this.pasteInProgress || !this.isWinAlive()) return;

    const floatHwnd = this.getFloatHwnd();
    const result = await this.pasteCoordinator.recapture(floatHwnd);
    if (result && this.isWinAlive()) {
      this.win!.webContents.send(MAIN_TO_RENDERER_CHANNELS.QUICK_INPUT_FOCUS_CHANGE, result.title);
    }
  }

  /**
   * 获取浮窗的 Win32 HWND（用于 recapture 排除浮窗自身）
   */
  private getFloatHwnd(): number | undefined {
    if (!this.isWinAlive()) return undefined;
    try {
      return Number(this.win!.getNativeWindowHandle().readBigUInt64LE(0));
    } catch {
      return undefined;
    }
  }

  /**
   * 更新回调集合
   */
  updateCallbacks(callbacks: QuickInputWindowCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  /**
   * Phase 4：注入剪贴板三重保护抑制函数
   *
   * 由 main.ts 在创建 QuickInputWindow 后调用，委托至 PasteCoordinator。
   * 自动粘贴流程中每次 clipboard.writeText 前后都需调用此函数抑制三重保护。
   *
   * @param suppressNextChange 抑制函数（clipboardHandler.suppressNextChange 绑定实例）
   */
  setSuppressNextChange(suppressNextChange: SuppressNextChange): void {
    this.pasteCoordinator.setSuppressNextChange(suppressNextChange);
  }

  /**
   * Phase 4：设置自动粘贴开关
   *
   * @param enabled true=启用自动粘贴（默认），false=强制走复制+Toast 模式
   */
  setAutoPasteEnabled(enabled: boolean): void {
    this.pasteCoordinator.setAutoPasteEnabled(enabled);
  }

  /**
   * 预加载 InputInjector 单例（fire-and-forget）
   *
   * 在应用启动阶段调用，提前触发 nut-js 动态 import，
   * 消除首次快捷键唤起浮窗时的 nut-js 加载延迟（~50-200ms）。
   */
  preloadInputInjector(): void {
    this.pasteCoordinator.preloadInputInjector();
  }

  /**
   * 销毁窗口并清理资源
   *
   * 应用退出时调用，清理 IPC 监听器、定时器和 PasteCoordinator 内部引用。
   */
  destroy(): void {
    this.cancelBlurClose();
    this.stopPolling(); // 销毁时停止轮询，释放定时器资源
    if (this.ipcRegistered) {
      ipcMain.removeHandler(IPC_CHANNELS.QUICK_INPUT_CONFIRM);
      ipcMain.removeHandler(IPC_CHANNELS.QUICK_INPUT_CLOSE);
      ipcMain.removeHandler(IPC_CHANNELS.QUICK_INPUT_RESIZE);
      ipcMain.removeAllListeners(IPC_CHANNELS.MOVE_QUICK_INPUT);
      ipcMain.removeAllListeners(IPC_CHANNELS.QUICK_INPUT_POLISH);
      ipcMain.removeHandler(IPC_CHANNELS.QUICK_INPUT_SET_PINNED_MODE);
      ipcMain.removeHandler(IPC_CHANNELS.RECAPTURE_TARGET);
      this.ipcRegistered = false;
    }
    if (this.isWinAlive()) {
      this.win!.destroy();
    }
    this.win = null;
    // 清理 PasteCoordinator 内部引用（nut-js native 模块引用 + 回调链），
    // 防止 GC 回收链路阻断：QuickInputWindow → PasteCoordinator → InputInjector → nut-js
    this.pasteCoordinator.destroy();
  }

  /** 窗口是否可见 */
  isVisible(): boolean {
    return this.win?.isVisible() ?? false;
  }
}

/**
 * 默认的确认回调实现：写入剪贴板（带抑制三重保护）
 *
 * 供 main.ts 使用，注入 clipboardHandler 实例后即可工作。
 * 写入前调用 suppressNextChange()，避免程序性写入触发 CLIPBOARD_CHANGED 干扰。
 *
 * @param clipboardHandler 剪贴板处理器实例（用于抑制三重保护）
 * @returns onConfirm 回调函数
 */
export function createDefaultConfirmCallback(
  clipboardHandler: { suppressNextChange: () => void } | null,
): (text: string) => Promise<{ success: boolean }> {
  return async (text: string) => {
    try {
      // 抑制三重保护：程序性写入剪贴板不应触发 CLIPBOARD_CHANGED
      clipboardHandler?.suppressNextChange();
      clipboard.writeText(text);
      logger.debug({ textLength: text.length }, '快速输入已写入剪贴板');
      return { success: true };
    } catch (error) {
      logger.error({ error }, '写入剪贴板失败');
      return { success: false };
    }
  };
}
