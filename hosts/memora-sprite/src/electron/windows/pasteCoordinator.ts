/**
 * 自动粘贴协调器 —— 从 QuickInputWindow 抽离的 Phase 4 编排逻辑
 *
 * 职责：
 *   1. 管理 InputInjector 实例（懒创建）
 *   2. 捕获呼出浮窗前的前台窗口（show() 前调用）
 *   3. 尝试自动粘贴（优先 paste，失败降级返回 copy）
 *   4. 管理剪贴板三重保护抑制函数 + 自动粘贴开关
 *   5. 获取准确窗口标题（nut-js 编码 bug 绕过：PowerShell fallback）
 *
 * 设计原则（ADR-017 架构层）：
 *   - 从 QuickInputWindow 抽离，使 QuickInputWindow 仅负责窗口管理 + IPC 路由
 *   - PasteCoordinator 不依赖 BrowserWindow，可独立单元测试
 *   - 集成点：QuickInputWindow.show() 调用 capturePreviousWindow()，
 *     IPC CONFIRM handler 调用 attemptPaste()
 *
 * 集成点：
 *   - quickInputWindow.ts：show() 前调用 capturePreviousWindow()，CONFIRM handler 调用 attemptPaste()
 *   - main.ts：通过 QuickInputWindow.setSuppressNextChange() 间接注入
 */

import { load } from 'koffi';
import { getDefaultInputInjector, type InputInjector, type ActiveWindow, type PasteResult } from '../inputInjector.js';
import { logger } from 'memora';

// ── Win32 FFI：加载 user32.dll 并定义 GetWindowTextW API（零编译，毫秒级调用）──
//
// 为什么用 koffi FFI 替代 PowerShell Add-Type：
//   PowerShell Add-Type 每次启动新进程都需要编译 C# 代码（2-5 秒），在打包后的 Electron
//   环境下容易触发 ETIMEDOUT（spawnSync 超时）。koffi 是纯 JS FFI，直接调用 Win32 DLL，
//   零进程启动、零编译，执行时间 < 1ms。编码方面 GetWindowTextW 返回原生 UTF-16LE，
//   同样零编码损失，中文标题完美保留。
const user32 = load('user32.dll');
const GetWindowTextLengthW = user32.func('int GetWindowTextLengthW(int hWnd)');
const GetWindowTextW = user32.func('int GetWindowTextW(int hWnd, char16 *lpString, int nMaxCount)');
// 用于 recapture()：获取当前前台窗口 HWND 和桌面 HWND，零闪烁（无需 hide/show 浮窗）
const GetForegroundWindow = user32.func('int GetForegroundWindow()');
const GetShellWindow = user32.func('int GetShellWindow()');
// 用于 recapture() 构造合成 ActiveWindow：直接调用 SetForegroundWindow 绕过 nut-js 的
// getActiveWindow() 在浮窗 alwaysOnTop 时返回浮窗自身的 bug
const SetForegroundWindow = user32.func('bool SetForegroundWindow(int hWnd)');

/** 剪贴板三重保护抑制函数类型（由 clipboardHandler.suppressNextChange 注入） */
export type SuppressNextChange = () => void;

/**
 * 通过 koffi FFI 直接调用 Win32 GetWindowTextW 获取指定窗口的准确标题
 *
 * 根因修复（两层）：
 *   1. nut-js 底层调用 GetWindowTextA（ANSI 版本）→ GBK 字节被误作 UTF-8 → U+FFFD 乱码
 *   2. PowerShell Add-Type 每次新进程需编译 C#（2-5 秒）→ spawnSync ETIMEDOUT
 *
 * 此函数通过 koffi FFI 在 Node.js 进程内直接调用 GetWindowTextW，零进程启动、
 * 零编译开销（<1ms），零编码损失（UTF-16LE 原生），彻底消除上述两个根因。
 *
 * @param hwnd Win32 窗口句柄（来自 nut-js Window.windowHandle）
 * @returns 窗口标题，失败时返回 null
 */
function getWindowTitle(hwnd: number): string | null {
  try {
    // 先获取标题长度（避免固定大小缓冲区或多次重试）
    const length = GetWindowTextLengthW(hwnd) as number;
    if (length === 0) return null;
    // 分配 UTF-16LE 缓冲区：每个字符 2 字节，+1 留给 null 终止符
    const buf = Buffer.alloc((length + 1) * 2);
    // 调用 GetWindowTextW 写入缓冲（koffi 直接将 Buffer 指针传给 Win32 API）
    GetWindowTextW(hwnd, buf, length + 1);
    // 解码 UTF-16LE → JavaScript 字符串，去除尾随 null 字符
    const title = buf.toString('utf16le').replace(/\0+$/, '');
    return title || null;
  } catch (err) {
    logger.warn({ err }, 'GetWindowTextW 获取窗口标题失败');
    return null;
  }
}

/**
 * 检测标题是否为 nut-js 编码乱码（含 U+FFFD 替换字符）
 *
 * U+FFFD 是 UTF-8 解码器遇到非法字节序列时的替换字符。
 * 正常标题（含中文）不会包含此字符，出现即表示编码错误。
 */
function isGarbledTitle(title: string): boolean {
  return title.includes('\uFFFD');
}

/**
 * 静默降级包装器（ADR-017 枝叶层 2 次提取原则）
 *
 * 应用场景：pasteCoordinator 中两处异步操作（resolveAccurateTitle / getCapturedAppName）
 * 都需要"失败时静默降级返回 fallback + 记 warn 日志"模式，提取为泛型函数消除重复。
 *
 * 与 throw 抛错路径的区别：此函数用于"非致命失败"场景——
 * 标题解析失败仅影响 focus-bar 显示，不应阻断浮窗显示或自动粘贴流程。
 *
 * @param fn 待执行的异步操作
 * @param fallbackValue 失败时返回的降级值（通常为 null）
 * @param logMsg 日志消息（描述失败的操作，便于排查）
 * @returns fn 成功时的结果，或失败时的 fallbackValue
 */
async function withSilentFallback<T>(
  fn: () => Promise<T>,
  fallbackValue: T,
  logMsg: string,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    // 静默降级：仅记 warn 日志，不阻断调用方流程
    logger.warn({ error }, logMsg);
    return fallbackValue;
  }
}

/** 自动粘贴超时（ms）：超过此时间未完成则降级到 copy 模式 */
const PASTE_TIMEOUT_MS = 5000;

/**
 * 自动粘贴协调器
 *
 * 使用方式：
 *   1. QuickInputWindow 创建时内部创建 PasteCoordinator 实例
 *   2. show() 前调用 capturePreviousWindow() 捕获前台窗口
 *   3. IPC CONFIRM handler 中调用 attemptPaste() 尝试粘贴
 *   4. main.ts 通过 setSuppressNextChange() 注入三重保护抑制函数
 */
export class PasteCoordinator {
  /** InputInjector 实例（懒创建，首次 capturePreviousWindow 时初始化） */
  private inputInjector: InputInjector | null = null;
  /** 呼出浮窗前的前台窗口（用于自动粘贴恢复焦点） */
  private previousWindow: ActiveWindow | null = null;
  /** 剪贴板三重保护抑制函数（由 main.ts 注入） */
  private suppressNextChange: SuppressNextChange | null = null;
  /** 是否启用自动粘贴（默认 true，配置开关） */
  private autoPasteEnabled = true;
  /** PowerShell 获取的准确标题缓存（每次 capturePreviousWindow 时失效） */
  private cachedAccurateTitle: string | null = null;
  /** nut-js 捕获窗口的 Win32 HWND 句柄（用于绕过 GetForegroundWindow 竞态） */
  private cachedHwnd: number | null = null;

  /**
   * 预加载 InputInjector 单例（fire-and-forget）
   *
   * 在应用启动阶段调用，提前触发 nut-js 动态 import，
   * 避免首次快捷键唤起浮窗时因 import 耗时（~50-200ms）导致明显延迟。
   * 调用后 capturePreviousWindow 复用已加载的 InputInjector，首次 show() 仅需 ~50-100ms。
   */
  preloadInputInjector(): void {
    if (this.inputInjector) return;
    void getDefaultInputInjector().then((injector) => {
      this.inputInjector = injector;
    });
  }

  /**
   * 捕获当前前台窗口（show() 前调用）
   *
   * 必须在浮窗 create() 之前调用，否则浮窗自身会成为前台窗口。
   * 快速连续呼出场景：通过 HWND 比较排除浮窗自身（绕过 nut-js 标题编码 bug）。
   * nut-js 不可用时 previousWindow 为 null，paste 将降级到复制+Toast。
   *
   * 乱码修复时机：捕获窗口后立即 await title 并检测 U+FFFD 乱码，若乱码立即调用
   * PowerShell GetWindowTextW 获取准确标题。此时浮窗尚未 show()，前台窗口仍是目标
   * 中文软件，PowerShell 能拿到正确的 UTF-16 标题。若延迟到 getCapturedAppName() 才
   * 调用，浮窗已成为前台窗口，PowerShell 会返回浮窗自身标题而非目标窗口。
   *
   * 性能：非乱码场景零开销（仅一次 await title，nut-js 内部已缓存）；乱码场景额外
   * 100-200ms（PowerShell 启动开销），是修复中文标题的必要成本。
   *
   * @param floatWindowHwnd 浮窗的 Win32 窗口句柄（HWND），用于排除捕获到浮窗自身
   */
  async capturePreviousWindow(floatWindowHwnd?: number): Promise<void> {
    // 懒创建 InputInjector 单例（preloadInputInjector 已触发时直接复用）
    if (!this.inputInjector) {
      this.inputInjector = await getDefaultInputInjector();
    }
    // 捕获前台窗口（通过 HWND 排除浮窗自身，绕过 nut-js 标题编码 bug）
    const captured = await this.inputInjector.captureActiveWindow(floatWindowHwnd);
    // 若捕获到浮窗自身（返回 null），保持上一次的 previousWindow
    if (captured) {
      this.previousWindow = captured;
      // 缓存 HWND（用于绕过 GetForegroundWindow 竞态条件）
      this.cachedHwnd = captured.hwnd ?? null;
      // 立即检测 nut-js 标题是否乱码并尝试用 PowerShell 修复
      // 此时浮窗未 show()，前台窗口仍是目标中文软件（关键时序）
      this.cachedAccurateTitle = await this.resolveAccurateTitle(captured);
    }
  }

  /**
   * 解析窗口的准确标题（nut-js 乱码时通过 PowerShell 修复）
   *
   * 流程：
   *   1. await nut-js title（~0ms，nut-js 内部已缓存）
   *   2. 检测 U+FFFD 乱码字符
   *   3. 若乱码 → 调用 PowerShell GetWindowTextW 获取 UTF-16 准确标题
   *   4. 若非乱码 → 返回 null（使用 nut-js 标题即可）
   *
   * @param window nut-js 捕获的窗口
   * @returns 准确标题（乱码且 PS 成功时），null（非乱码或 PS 失败时，调用方用 nut-js 标题）
   */
  private async resolveAccurateTitle(window: ActiveWindow): Promise<string | null> {
    // 提取局部变量，便于在闭包中保持类型收窄（避免 this.cachedHwnd 在异步前后变化）
    const hwnd = this.cachedHwnd;
    return withSilentFallback(async () => {
      const nutJsTitle = await window.title;
      if (!isGarbledTitle(nutJsTitle)) return null;
      // nut-js 标题含 U+FFFD → 编码 bug 触发，用 PowerShell + HWND 修复
      // 直接传入 HWND 消除 GetForegroundWindow 竞态条件
      if (hwnd === null) return null;
      const accurateTitle = getWindowTitle(hwnd);
      if (accurateTitle) {
        logger.info({ nutJsTitle, accurateTitle }, 'nut-js 标题乱码，已通过 koffi FFI 修复');
        return accurateTitle;
      }
      // PowerShell 失败 → 返回 null，调用方降级使用 nut-js 乱码标题
      return null;
    }, null, 'resolveAccurateTitle failed');
  }

  /**
   * 尝试自动粘贴
   *
   * 条件不满足（未启用/未注入 suppressNextChange/nut-js 不可用）时
   * 返回降级结果，由调用方走 fallback 路径。
   *
   * 超时保护：若 paste 流程超过 PASTE_TIMEOUT_MS（5 秒）未完成，
   * 自动降级到 copy 模式，防止 paste 永久阻塞用户操作。
   *
   * @param text 要粘贴的文本
   * @param hideFloat 隐藏浮窗的回调（粘贴成功前调用）
   * @returns 粘贴结果（mode='paste' 成功，mode='copy' 需降级）
   */
  async attemptPaste(text: string, hideFloat: () => void): Promise<PasteResult> {
    if (!this.autoPasteEnabled || !this.inputInjector || !this.suppressNextChange) {
      return { success: false, mode: 'copy', reason: 'no_deps' };
    }

    // 超时保护：Promise.race 确保 paste 不会永久阻塞
    // 主要保护点：previousWindow.focus() 在目标窗口无响应时可能挂起
    const pastePromise = this.inputInjector.paste(
      text, this.previousWindow, hideFloat, this.suppressNextChange,
    );
    let timeoutId: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<PasteResult>((resolve) => {
      timeoutId = setTimeout(() => {
        logger.warn({ timeoutMs: PASTE_TIMEOUT_MS }, '自动粘贴超时，降级到 copy 模式');
        resolve({ success: false, mode: 'copy', reason: 'paste_failed' });
      }, PASTE_TIMEOUT_MS);
    });

    const result = await Promise.race([pastePromise, timeoutPromise]);
    // 清除未触发的超时定时器：paste 成功时 timeout 仍在后台运行，
    // Promise.race 不取消 loser，5 秒后 clearTimeout 已是 no-op（安全）
    clearTimeout(timeoutId!);
    return result;
  }

  /**
   * 注入剪贴板三重保护抑制函数
   *
   * 由 main.ts 在创建 QuickInputWindow 后调用，注入 clipboardHandler.suppressNextChange。
   * 自动粘贴流程中每次 clipboard.writeText 前后都需调用此函数抑制三重保护。
   *
   * @param fn 抑制函数（clipboardHandler.suppressNextChange 绑定实例）
   */
  setSuppressNextChange(fn: SuppressNextChange): void {
    this.suppressNextChange = fn;
  }

  /**
   * 设置自动粘贴开关
   *
   * @param enabled true=启用自动粘贴（默认），false=强制走复制+Toast 模式
   */
  setAutoPasteEnabled(enabled: boolean): void {
    this.autoPasteEnabled = enabled;
  }

  /**
   * 获取当前捕获窗口的完整标题（用于 focus-bar 显示）
   *
   * 优先使用缓存的 koffi 准确标题（capturePreviousWindow/recapture 时获取），
   * 缓存为空时降级使用 nut-js 标题。
   *
   * @returns 完整窗口标题（无捕获窗口时返回 null）
   */
  async getCapturedAppName(): Promise<string | null> {
    // 优先使用 koffi 缓存的完整标题（recapture/capturePreviousWindow 时已同步获取）
    if (this.cachedAccurateTitle) {
      return this.cachedAccurateTitle;
    }
    // 降级：缓存的标题不可用时，从 nut-js ActiveWindow 获取（可能含编码乱码）
    const win = this.previousWindow;
    if (!win) return null;
    return withSilentFallback(async () => {
      return await win.title;
    }, null, 'getCapturedAppName failed');
  }

  /**
   * 重新捕获前台窗口（浮窗已可见时调用，零闪烁）
   *
   * 与 capturePreviousWindow() 的区别：
   *   - capturePreviousWindow 在 show() 前调用，浮窗尚未创建，前台窗口就是目标
   *   - recapture() 在浮窗可见时调用，需用 koffi GetForegroundWindow 绕过浮窗自身
   *   - 零闪烁：不隐藏/显示浮窗，直接用 koffi 同步获取前台 HWND
   *
   * 关键修复：nut-js getActiveWindow() 在浮窗 alwaysOnTop 时返回浮窗自身，
   * 导致 captureActiveWindow 返回 null 进而 previousWindow 不更新。
   * 此方法用 koffi SetForegroundWindow 构造合成 ActiveWindow，彻底绕过此问题。
   *
   * 流程：
   *   1. koffi GetForegroundWindow() → 同步获取前台 HWND（<1ms）
   *   2. 排除浮窗自身、桌面、HWND 为 0
   *   3. koffi getWindowTitle() → 同步获取完整标题（<1ms）
   *   4. 更新 cachedHwnd 和 cachedAccurateTitle
   *   5. 用 koffi SetForegroundWindow 构造合成 ActiveWindow（paste 焦点恢复）
   *   6. 返回完整窗口标题供 IPC 推送
   *
   * @param floatHwnd 浮窗的 Win32 窗口句柄，用于排除浮窗自身
   * @returns 捕获成功时返回 { title }，失败（桌面/任务栏/浮窗自身）返回 null
   */
  async recapture(floatHwnd?: number): Promise<{ title: string | null } | null> {
    // 1. koffi 同步获取前台 HWND（零延迟，无需 hide/show 浮窗）
    const fgHwnd = GetForegroundWindow() as number;

    // 2. 排除无效窗口
    if (!fgHwnd) return null;
    if (floatHwnd !== undefined && fgHwnd === floatHwnd) return null; // 排除浮窗自身
    const desktopHwnd = GetShellWindow() as number;
    if (fgHwnd === desktopHwnd) return null; // 排除桌面

    // 3. koffi 获取完整窗口标题（零编码损失）
    const title = getWindowTitle(fgHwnd);
    if (!title) return null;

    // 4. 更新缓存（标题已确认有效，先更新确保 getCapturedAppName 可用）
    this.cachedHwnd = fgHwnd;
    this.cachedAccurateTitle = title;

    // 5. 用 koffi SetForegroundWindow 构造合成 ActiveWindow
    //    绕过 nut-js getActiveWindow() 在浮窗 alwaysOnTop 时返回浮窗自身的 bug
    //    确保 paste 流程中 previousWindow.focus() 能正确聚焦到目标窗口
    const syntheticWindow: ActiveWindow = {
      hwnd: fgHwnd,
      title: Promise.resolve(title),
      region: Promise.resolve({ left: 0, top: 0, width: 0, height: 0 }),
      focus: async () => {
        SetForegroundWindow(fgHwnd);
      },
    };
    this.previousWindow = syntheticWindow;

    return { title };
  }

  /**
   * 轮询检查前台窗口是否变化，变化时同步执行重捕获
   *
   * 与 recapture() 的区别：
   *   - recapture() 是 async，供 blur 事件/IPC 调用（触发时机已知）
   *   - checkAndRecapture() 是同步的，供 setInterval 轮询（无触发时机，需主动检测）
   *
   * 设计理由：blur 事件依赖浮窗焦点状态，在 alwaysOnTop 浮窗下焦点恢复不可靠，
   * 导致 blur 不触发 → 自动重捕获链断裂。轮询 GetForegroundWindow() 独立于焦点状态，
   * 零竞态，是 blur 事件的可靠性兜底。
   *
   * @param floatHwnd 浮窗 HWND（用于排除自身）
   * @returns 变化后的完整窗口标题，未变化或无效时返回 null
   */
  checkAndRecapture(floatHwnd: number): { title: string } | null {
    // 1. koffi 同步获取前台 HWND
    const fgHwnd = GetForegroundWindow() as number;

    // 2. 排除无效窗口
    if (!fgHwnd) return null;
    if (fgHwnd === floatHwnd) return null; // 排除浮窗自身
    if (fgHwnd === (GetShellWindow() as number)) return null; // 排除桌面

    // 3. 未变化：跳过（避免无效的 SetForegroundWindow 调用）
    if (fgHwnd === this.cachedHwnd) return null;

    // 4. koffi 获取完整窗口标题
    const title = getWindowTitle(fgHwnd);
    if (!title) return null;

    // 5. 更新缓存
    this.cachedHwnd = fgHwnd;
    this.cachedAccurateTitle = title;

    // 6. 构造合成 ActiveWindow（koffi SetForegroundWindow 绕过 nut-js bug）
    this.previousWindow = {
      hwnd: fgHwnd,
      title: Promise.resolve(title),
      region: Promise.resolve({ left: 0, top: 0, width: 0, height: 0 }),
      focus: async () => { SetForegroundWindow(fgHwnd); },
    };

    return { title };
  }

  /**
   * 清理所有内部引用（应用退出时由 QuickInputWindow.destroy() 调用）
   *
   * 置 null 所有持有外部资源引用的字段，防止：
   *   - inputInjector 持有 nut-js native 模块引用，阻碍 GC 回收
   *   - previousWindow 持有 nut-js ActiveWindow 对象
   *   - 回调引用链阻止 QuickInputWindow → PasteCoordinator → InputInjector 完整 GC
   */
  destroy(): void {
    this.inputInjector = null;
    this.previousWindow = null;
    this.suppressNextChange = null;
    this.cachedAccurateTitle = null;
    this.cachedHwnd = null;
  }
}
