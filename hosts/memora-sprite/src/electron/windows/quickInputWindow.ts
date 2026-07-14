/**
 * 快速输入浮窗管理
 *
 * 职责（Phase 1 骨架）：
 *   1. 创建轻量浮窗（无边框、alwaysOnTop、失焦延迟关闭）
 *   2. 单例管理——多次呼出复用同一窗口，避免创建多个实例
 *   3. 失焦延迟关闭（200ms），给 Alt+Tab 切换留余量
 *   4. IPC 处理：确认输入（写剪贴板+关闭）和关闭（仅关闭）
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
 */

import * as path from 'node:path';
import { BrowserWindow, ipcMain, clipboard, screen } from 'electron';
import { injectThemeScript } from './themeInjector.js';
import { IPC_CHANNELS, MAIN_TO_RENDERER_CHANNELS } from '../ipc/channels.js';
import { ELECTRON_DIR } from '../esmShim.js';
import { logger } from 'memora';
// 剪贴板敏感内容检测（复用 clipboardHandler 的 5 种正则模式）
import { isSensitive } from '../clipboardHandler.js';

/** 浮窗宽度（px）—— 足够单行输入 + 确认按钮 */
const QUICK_INPUT_WIDTH = 480;
/** 浮窗高度（px）—— 单行输入框 + 内边距 */
const QUICK_INPUT_HEIGHT = 80;
/** 失焦延迟关闭时长（ms）—— 给 Alt+Tab 切换留余量 */
const BLUR_CLOSE_DELAY_MS = 200;
/** 光标跟随偏移量（px）—— 浮窗相对鼠标位置的偏移 */
const CURSOR_OFFSET_PX = 16;
/** 剪贴板预填文本最大长度（防止超长文本撑爆输入框） */
const CLIPBOARD_PREFILL_MAX_LENGTH = 200;
/** 剪贴板预填触发补全的最小字符数（与补全管理器 MIN_QUERY_LENGTH 对齐） */
const CLIPBOARD_PREFILL_MIN_LENGTH = 2;

/** 快速输入浮窗回调（由 main.ts 注入） */
export interface QuickInputWindowCallbacks {
  /**
   * 确认输入文本（主进程写入剪贴板 + 关闭浮窗）
   *
   * @param text 用户确认的文本
   * @returns success 表示写入成功
   */
  onConfirm?: (text: string) => Promise<{ success: boolean }>;
  /**
   * 确认成功后异步回调（用于记忆沉淀，不阻塞关闭浮窗）
   *
   * 在 onConfirm 返回 success=true 后触发。
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
   */
  async show(): Promise<void> {
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
    // 通知渲染进程：携带剪贴板预填文本（敏感内容过滤后），替代 focus 事件避免 Alt+Tab 切回误清空
    const clipboardText = this.readClipboardForPrefill();
    win.webContents.send(MAIN_TO_RENDERER_CHANNELS.QUICK_INPUT_SHOW, { clipboardText });
  }

  /**
   * 读取剪贴板内容并做敏感检测，返回可用于预填的安全文本
   *
   * 敏感内容（token/信用卡/密码/私钥/AWS key）返回 null，不预填。
   * 过短内容（< 2 字符）返回 null，不触发补全。
   * 超长内容截断到 200 字符。
   *
   * @returns 预填文本或 null
   */
  private readClipboardForPrefill(): string | null {
    try {
      const raw = clipboard.readText();
      const trimmed = raw.trim();
      if (trimmed.length < CLIPBOARD_PREFILL_MIN_LENGTH) return null;
      // 敏感内容检测：命中 5 种正则模式之一则不预填
      if (isSensitive(trimmed).sensitive) return null;
      return trimmed.slice(0, CLIPBOARD_PREFILL_MAX_LENGTH);
    } catch {
      // 剪贴板读取失败不阻断浮窗显示
      return null;
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

    // 确认输入：写入剪贴板 + 关闭浮窗 + 异步记忆沉淀
    ipcMain.handle(IPC_CHANNELS.QUICK_INPUT_CONFIRM, async (_event, text: string) => {
      try {
        // 参数校验：文本必须是字符串且非空
        if (typeof text !== 'string' || text.length === 0) {
          return { success: false };
        }
        // 截断超长文本（防止恶意输入）
        const safeText = text.slice(0, 10000);
        const result = await this.callbacks.onConfirm?.(safeText) ?? { success: false };
        if (result.success) {
          // 先关闭浮窗，再异步沉淀记忆（不阻塞用户）
          this.hide();
          // 记忆沉淀失败不影响复制成功（错误隔离）
          try {
            this.callbacks.onAfterConfirm?.(safeText);
          } catch (err) {
            logger.warn({ err }, '快速输入记忆沉淀失败（不影响复制结果）');
          }
        }
        return result;
      } catch (error) {
        logger.error({ error }, '快速输入确认失败');
        return { success: false };
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
        if (typeof height !== 'number' || height < QUICK_INPUT_HEIGHT || height > 400) {
          return;
        }
        const { width } = this.win.getBounds();
        this.win.setSize(width, Math.round(height), true);
      } catch (error) {
        logger.error({ error }, '调整浮窗高度失败');
      }
      return undefined;
    });
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
