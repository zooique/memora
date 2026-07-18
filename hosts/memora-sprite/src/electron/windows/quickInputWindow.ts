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
 *   - main.ts：快捷键 Ctrl+Shift+I 触发 show()
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
// 剪贴板敏感内容检测（复用 clipboardHandler 的 5 种正则模式）
import { isSensitive } from '../clipboardHandler.js';
// Phase 4：自动粘贴协调器（从本类抽离的粘贴流程编排）
import { PasteCoordinator, type SuppressNextChange } from './pasteCoordinator.js';

/** 浮窗宽度（px）—— 足够单行输入 + 确认按钮 */
const QUICK_INPUT_WIDTH = 480;
/** 浮窗初始高度（px）—— focus-bar 28px + textarea 1行 + padding + footer，与 INITIAL_BASE_HEIGHT 对齐 */
const QUICK_INPUT_HEIGHT = 104;
/** 浮窗最大高度（px）—— 输入区 + 候选列表(最多 5 项×38px) + footer，与 CSS max-height:200px 对齐 */
const QUICK_INPUT_MAX_HEIGHT = 400;
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
   * - resizable: false（固定尺寸）
   * - show: false（创建时不显示，由 show() 控制）
   */
  private async create(): Promise<BrowserWindow> {
    const win = new BrowserWindow({
      width: QUICK_INPUT_WIDTH,
      height: QUICK_INPUT_HEIGHT,
      frame: false,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      // 浅色主题背景色（对齐完整窗口，避免启动闪烁）
      backgroundColor: '#f0f0f2',
      webPreferences: {
        // 最小化 preload：preload-quick-input.cjs 仅暴露 9 个 API（ADR-SP-017 §1）
        preload: path.join(ELECTRON_DIR, 'preload-quick-input.cjs'),
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

    // 失焦延迟关闭：给 Alt+Tab 切换留余量（pinned 模式不关闭）
    win.on('blur', () => {
      if (this.pinnedMode) return;
      this.scheduleBlurClose();
    });
    win.on('focus', () => {
      this.cancelBlurClose();
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
    await this.pasteCoordinator.capturePreviousWindow(existingWin?.getTitle());

    if (!this.win || this.win.isDestroyed()) {
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
   * 通知渲染进程聚焦变化（主→渲染 IPC）
   *
   * appName=null 表示浮窗失去焦点（用户切走），渲染进程显示"无聚焦"+ 禁用 Tab
   * appName=string 表示浮窗获得焦点，渲染进程显示"聚焦：{应用名}"+ 激活 Tab
   */
  private notifyFocusChange(appName: string | null): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send(MAIN_TO_RENDERER_CHANNELS.QUICK_INPUT_FOCUS_CHANGE, appName);
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
    } catch {
      // 剪贴板读取失败不阻断浮窗显示
      return { text: null, isSensitive: false };
    }
  }

  /**
   * 隐藏浮窗（不销毁，复用单例）
   *
   * 清空输入框内容（由渲染进程在 close 事件中处理）。
   */
  hide(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.hide();
    }
    this.cancelBlurClose();
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
    // 渲染进程传入 pinnedMode：pinned 模式下 paste 期间不 hide 而是临时取消置顶，避免 hide+show 闪烁
    ipcMain.handle(IPC_CHANNELS.QUICK_INPUT_CONFIRM, async (_event, text: string, pinnedMode?: boolean): Promise<QuickInputConfirmResult> => {
      try {
        // 参数校验：文本必须是字符串且非空
        if (typeof text !== 'string' || text.length === 0) {
          return { success: false, mode: 'copy' };
        }
        // pinnedMode 类型校验：防御非布尔 truthy 值
        const safePinnedMode = typeof pinnedMode === 'boolean' ? pinnedMode : false;
        // 截断超长文本（防止恶意输入）
        const safeText = text.slice(0, MAX_CONFIRM_TEXT_LENGTH);

        // paste 期间的处理策略（统一两种模式：临时取消置顶，不 hide 浮窗，支持流式连续输入）
        // - default 模式 + pinned 模式：setAlwaysOnTop(false)，避免遮挡原窗口粘贴结果
        //   不用 hide() 是因为路线图闭环 7 F1 设计——流式模式只要不改变聚焦浮窗就应始终存在
        //   paste 完成后恢复置顶 + show() 重显 + 按模式恢复焦点
        const hideFloat = () => {
          if (this.win && !this.win.isDestroyed()) {
            this.win.setAlwaysOnTop(false);
          }
        };
        const pasteResult = await this.pasteCoordinator.attemptPaste(safeText, hideFloat);
        this.cancelBlurClose();
        // paste 完成：恢复置顶 + 重显浮窗（路线图闭环 7 F1：流式模式浮窗始终可见）
        if (this.win && !this.win.isDestroyed()) {
          this.win.setAlwaysOnTop(true);
          this.win.show();
          // default 模式恢复焦点支持连续输入；pinned 模式不抢焦点（保持钉住语义）
          if (!safePinnedMode) {
            this.win.focus();
          }
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
          // 降级路径同样不 hide 浮窗（路线图闭环 7 F1：浮窗始终可见支持流式输入）
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
      try {
        if (!this.win || this.win.isDestroyed()) return;
        // 参数校验：高度必须是合理范围内的正整数
        if (typeof height !== 'number' || height < QUICK_INPUT_HEIGHT || height > QUICK_INPUT_MAX_HEIGHT) {
          return;
        }
        const { width } = this.win.getBounds();
        this.win.setSize(width, Math.round(height), true);
        // resize 后检查位置，防止溢出屏幕边缘
        this.keepWindowInWorkArea();
      } catch (error) {
        logger.error({ error }, '调整浮窗高度失败');
      }
      return undefined;
    });

    // 拖动浮窗位置：footer 区域可拖，dx/dy 增量移动（与 float 一致的 PointerEvent 模式）
    // 不持久化位置：每次唤起仍在光标跟随位置显示，拖动仅本次会话生效
    ipcMain.on(IPC_CHANNELS.MOVE_QUICK_INPUT, (_event, dx: number, dy: number) => {
      try {
        if (!this.win || this.win.isDestroyed()) return;
        // 参数校验：增量必须是有限数字
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
        const [currentX, currentY] = this.win.getPosition() as [number, number];
        const newX = currentX + Math.round(dx);
        const newY = currentY + Math.round(dy);
        // 先 clamp 到工作区再 setPosition，避免窗口短暂超出边缘再被拉回导致视觉挤压
        const clamped = this.clampPositionToWorkArea(newX, newY);
        this.win.setPosition(clamped.x, clamped.y);
      } catch (error) {
        logger.error({ error }, '拖动浮窗位置失败');
      }
    });

    // LLM 润色文本：渲染进程请求润色，主进程调用 onPolish 回调（main.ts 注入 agent.polish?.polish()）
    // 润色期间渲染进程显示 loading 状态，失败时返回错误信息供 Toast 展示
    ipcMain.handle(IPC_CHANNELS.QUICK_INPUT_POLISH, async (_event, text: string) => {
      try {
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
      } catch (error) {
        logger.error({ error }, 'LLM 润色文本失败');
        // 润色失败时返回原文（降级，不阻塞用户操作）
        return { polished: typeof text === 'string' ? text : '', changed: false };
      }
    });

    // 切换常驻模式：渲染进程通知主进程抑制/恢复 blur 关闭
    ipcMain.handle(IPC_CHANNELS.QUICK_INPUT_SET_PINNED_MODE, (_event, pinned: boolean) => {
      this.pinnedMode = typeof pinned === 'boolean' ? pinned : false;
      return { success: true };
    });

    // 设置浮窗 alwaysOnTop：pinned 模式下图钉按钮触发
    // 取消置顶时同步设置 skipTaskbar=false，让浮窗出现在任务栏，避免被遮挡后无法切回
    // 恢复置顶时同步设置 skipTaskbar=true，回到轻量浮窗状态
    ipcMain.handle(IPC_CHANNELS.QUICK_INPUT_SET_ALWAYS_ON_TOP, (_event, value: boolean) => {
      if (typeof value !== 'boolean') return { success: false };
      if (this.win && !this.win.isDestroyed()) {
        this.win.setAlwaysOnTop(value);
        // alwaysOnTop=false 时浮窗可被遮挡，需要任务栏可见以便切回
        // alwaysOnTop=true 时浮窗始终置顶，任务栏可见性无意义且破坏轻量感
        this.win.setSkipTaskbar(!value);
      }
      return { success: true };
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
    if (!this.win || this.win.isDestroyed()) return;
    const { x, y } = this.win.getBounds();
    const clamped = this.clampPositionToWorkArea(x, y);
    // 仅在位置变化时才更新，避免不必要的重绘
    if (clamped.x !== x || clamped.y !== y) {
      this.win.setPosition(clamped.x, clamped.y);
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
   * 应用退出时调用，清理 IPC 监听器和定时器。
   */
  destroy(): void {
    this.cancelBlurClose();
    if (this.ipcRegistered) {
      ipcMain.removeHandler(IPC_CHANNELS.QUICK_INPUT_CONFIRM);
      ipcMain.removeHandler(IPC_CHANNELS.QUICK_INPUT_CLOSE);
      ipcMain.removeHandler(IPC_CHANNELS.QUICK_INPUT_RESIZE);
      ipcMain.removeAllListeners(IPC_CHANNELS.MOVE_QUICK_INPUT);
      ipcMain.removeAllListeners(IPC_CHANNELS.QUICK_INPUT_POLISH);
      ipcMain.removeHandler(IPC_CHANNELS.QUICK_INPUT_SET_PINNED_MODE);
      ipcMain.removeHandler(IPC_CHANNELS.QUICK_INPUT_SET_ALWAYS_ON_TOP);
      this.ipcRegistered = false;
    }
    if (this.win && !this.win.isDestroyed()) {
      this.win.destroy();
    }
    this.win = null;
  }

  /** 窗口是否可见 */
  isVisible(): boolean {
    return this.win?.isVisible() ?? false;
  }
}

/**
 * 创建快速输入浮窗的工厂函数
 *
 * 供 main.ts 调用，注入 clipboardHandler 用于抑制三重保护。
 *
 * @param callbacks 回调集合（onConfirm 负责写入剪贴板 + 抑制三重保护）
 * @returns QuickInputWindow 实例
 */
export function createQuickInputWindow(callbacks: QuickInputWindowCallbacks): QuickInputWindow {
  return new QuickInputWindow(callbacks);
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
