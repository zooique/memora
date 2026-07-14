/**
 * 快速输入浮窗管理
 *
 * 职责（Phase 1-4）：
 *   1. 创建轻量浮窗（无边框、alwaysOnTop、失焦延迟关闭）
 *   2. 单例管理——多次呼出复用同一窗口，避免创建多个实例
 *   3. 失焦延迟关闭（200ms），给 Alt+Tab 切换留余量
 *   4. IPC 处理：确认输入（写剪贴板+关闭）和关闭（仅关闭）
 *   5. Phase 2：剪贴板感知预填（敏感检测 + 剪贴板文本预填输入框）
 *   6. Phase 4：自动粘贴（恢复焦点到原窗口 + 模拟 Ctrl+V + 恢复剪贴板）
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
 *   - inputInjector：Phase 4 自动粘贴（恢复焦点 + 模拟 Ctrl+V）
 */

import * as path from 'node:path';
import { BrowserWindow, ipcMain, clipboard, screen } from 'electron';
import { injectThemeScript } from './themeInjector.js';
import { IPC_CHANNELS, MAIN_TO_RENDERER_CHANNELS } from '../ipc/channels.js';
import { ELECTRON_DIR } from '../esmShim.js';
import { logger } from 'memora';
// 剪贴板敏感内容检测（复用 clipboardHandler 的 5 种正则模式）
import { isSensitive } from '../clipboardHandler.js';
// Phase 4：输入注入器（自动粘贴）
import { getDefaultInputInjector, type ActiveWindow, type InputInjector } from '../inputInjector.js';

/** 浮窗宽度（px）—— 足够单行输入 + 确认按钮 */
const QUICK_INPUT_WIDTH = 480;
/** 浮窗初始高度（px）—— textarea 1 行 + 底部栏 + 内边距 */
const QUICK_INPUT_HEIGHT = 72;
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

/** 剪贴板预填读取结果 */
interface ClipboardPrefillResult {
  /** 预填文本（null 表示不预填） */
  text: string | null;
  /** 剪贴板内容是否命中敏感模式（用于渲染进程自动进入流式模式） */
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
}

/**
 * 确认结果（Phase 4 扩展 mode 字段，排雷修正雷 4.1）
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
 * 剪贴板三重保护抑制函数类型（由 clipboardHandler.suppressNextChange 注入）
 *
 * 一次性抑制：每次 clipboard.writeText 前都需调用。
 */
type SuppressNextChange = () => void;

/**
 * 快速输入浮窗类
 *
 * 单例模式：create() 只在首次调用时创建窗口，后续 show() 复用。
 * 失焦延迟关闭：blur 事件后延迟 BLUR_CLOSE_DELAY_MS 关闭，
 * 若在延迟内窗口重新获得焦点则取消关闭。
 */
export class QuickInputWindow {
  /** BrowserWindow 单例（懒创建） */
  private win: BrowserWindow | null = null;
  /** 回调集合（由 main.ts 注入） */
  private callbacks: QuickInputWindowCallbacks;
  /** 失焦延迟关闭定时器 */
  private blurCloseTimer: ReturnType<typeof setTimeout> | null = null;
  /** IPC handler 是否已注册（防止重复注册） */
  private ipcRegistered = false;
  /** Phase 4：呼出浮窗前的前台窗口（用于自动粘贴恢复焦点） */
  private previousWindow: ActiveWindow | null = null;
  /** Phase 4：输入注入器实例（懒创建） */
  private inputInjector: InputInjector | null = null;
  /** Phase 4：剪贴板三重保护抑制函数（由 main.ts 注入） */
  private suppressNextChange: SuppressNextChange | null = null;
  /** Phase 4：是否启用自动粘贴（默认 true，配置开关） */
  private autoPasteEnabled = true;

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
        // 复用 preload.cjs（与 floatWindow / fullWindow 共用）
        preload: path.join(ELECTRON_DIR, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    // 主进程注入主题初始化脚本
    injectThemeScript(win.webContents);

    // 加载浮窗 HTML
    const htmlPath = path.join(ELECTRON_DIR, 'renderer', 'quick-input', 'quick-input.html');
    await win.loadFile(htmlPath);

    // 安全防护：拦截外部导航和弹窗
    win.webContents.on('will-navigate', (e, url) => {
      if (url !== win.webContents.getURL()) {
        e.preventDefault();
      }
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    // 失焦延迟关闭：给 Alt+Tab 切换留余量
    win.on('blur', () => {
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

    this.win = win;
    this.registerIpcHandlers();

    return win;
  }

  /**
   * 显示浮窗（单例复用）
   *
   * 若窗口尚未创建则先创建。显示时跟随鼠标光标位置弹出（右侧下方偏移），
   * 屏幕边缘溢出时自动回弹到左侧/顶部，聚焦输入框准备接收用户输入。
   *
   * Phase 4：show() 第一步先捕获前台窗口（必须在 create() 之前，
   * 否则浮窗自身会成为前台窗口），用于后续自动粘贴恢复焦点。
   */
  async show(): Promise<void> {
    // Phase 4：捕获前台窗口（必须在 create() 之前，排雷修正雷 5.2）
    await this.capturePreviousWindow();

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
        // 敏感内容不预填，但通知渲染进程进入流式模式
        return { text: null, isSensitive: true };
      }
      return { text: trimmed.slice(0, CLIPBOARD_PREFILL_MAX_LENGTH), isSensitive: false };
    } catch {
      // 剪贴板读取失败不阻断浮窗显示
      return { text: null, isSensitive: false };
    }
  }

  /**
   * Phase 4：捕获当前前台窗口（show() 第一行调用）
   *
   * 必须在 create() 之前调用，否则浮窗自身会成为前台窗口。
   * 快速连续呼出场景：若捕获的窗口标题等于浮窗标题，保持上一次的 previousWindow。
   * nut-js 不可用时 previousWindow 为 null，paste 将降级到复制+Toast。
   */
  private async capturePreviousWindow(): Promise<void> {
    // 懒创建 InputInjector 单例
    if (!this.inputInjector) {
      this.inputInjector = await getDefaultInputInjector();
    }
    // 捕获前台窗口（排除浮窗自身）
    const floatTitle = this.win?.getTitle();
    const captured = await this.inputInjector.captureActiveWindow(floatTitle);
    // 排雷修正雷 6.1：若捕获到浮窗自身（返回 null），保持上一次的 previousWindow
    if (captured) {
      this.previousWindow = captured;
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
    // 流式模式下跳过 hideFloat，窗口保持打开供连续输入
    ipcMain.handle(IPC_CHANNELS.QUICK_INPUT_CONFIRM, async (_event, text: string, streamMode?: boolean): Promise<QuickInputConfirmResult> => {
      try {
        // 参数校验：文本必须是字符串且非空
        if (typeof text !== 'string' || text.length === 0) {
          return { success: false, mode: 'copy' };
        }
        // 截断超长文本（防止恶意输入）
        const safeText = text.slice(0, 10000);

        // Phase 4：优先尝试自动粘贴（inputInjector 统一负责剪贴板操作）
        if (this.autoPasteEnabled && this.inputInjector && this.suppressNextChange) {
          // 流式模式：跳过 hideFloat，窗口保持打开
          const hideFloat = streamMode ? () => {} : () => this.hide();
          const pasteResult = await this.inputInjector.paste(
            safeText,
            this.previousWindow,
            hideFloat,
            this.suppressNextChange,
          );

          if (pasteResult.success && pasteResult.mode === 'paste') {
            // 粘贴成功：调用 onAfterConfirm 记忆沉淀（排雷修正雷 1.3：粘贴成功后才记）
            try {
              this.callbacks.onAfterConfirm?.(safeText);
            } catch (err) {
              logger.warn({ err }, '快速输入记忆沉淀失败（不影响粘贴结果）');
            }
            return { success: true, mode: 'paste', appName: pasteResult.appName };
          }

          // 降级日志（用于诊断降级原因）
          logger.debug({ reason: pasteResult.reason }, 'Phase 4 自动粘贴降级到复制模式');
        }

        // 降级路径 / Phase 3 兼容路径：走 onConfirm 写剪贴板
        const result = await this.callbacks.onConfirm?.(safeText) ?? { success: false };
        if (result.success) {
          // 流式模式不关闭窗口
          if (!streamMode) {
            this.hide();
          }
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

    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const workArea = display.workArea;
    const { x, y, width, height } = this.win.getBounds();

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

    // 仅在位置变化时才更新，避免不必要的重绘
    if (newX !== x || newY !== y) {
      this.win.setPosition(Math.round(newX), Math.round(newY));
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
   * 由 main.ts 在创建 QuickInputWindow 后调用，注入 clipboardHandler.suppressNextChange。
   * 自动粘贴流程中每次 clipboard.writeText 前后都需调用此函数抑制三重保护。
   *
   * @param suppressNextChange 抑制函数（clipboardHandler.suppressNextChange 绑定实例）
   */
  setSuppressNextChange(suppressNextChange: SuppressNextChange): void {
    this.suppressNextChange = suppressNextChange;
  }

  /**
   * Phase 4：设置自动粘贴开关
   *
   * @param enabled true=启用自动粘贴（默认），false=强制走复制+Toast 模式
   */
  setAutoPasteEnabled(enabled: boolean): void {
    this.autoPasteEnabled = enabled;
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
