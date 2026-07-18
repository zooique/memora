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

import { execSync } from 'node:child_process';
import { getDefaultInputInjector, type InputInjector, type ActiveWindow, type PasteResult } from '../inputInjector.js';
import { logger } from 'memora';

/** 剪贴板三重保护抑制函数类型（由 clipboardHandler.suppressNextChange 注入） */
export type SuppressNextChange = () => void;

/**
 * 通过 PowerShell 调用 Win32 API 获取前台窗口标题
 *
 * nut-js 的 GetWindowTextA → napi_create_string_utf8 路径存在 GBK→UTF-8 编码 bug，
 * 中文标题字节被错误解释为 UTF-8，产生不可逆的乱码（U+FFFD 替换字符）。
 * 此函数绕过 nut-js，直接通过 PowerShell 调用 GetWindowTextW（UTF-16 原生），无编码损失。
 *
 * 技术细节：
 *   - 用 -EncodedCommand (base64 UTF-16LE) 传递脚本，避免引号转义问题
 *   - PowerShell 返回 base64(UTF-16LE)，Node.js 解码，绕过 stdout 编码问题
 *
 * 性能：execSync 阻塞约 100-200ms（PowerShell 启动开销），仅在 nut-js 标题被检测为乱码时触发。
 *
 * @returns 窗口标题，失败时返回 null
 */
function getForegroundWindowTitleViaPS(): string | null {
  try {
    // PowerShell 脚本：Add-Type 定义 Win32 P/Invoke → 获取前台窗口句柄 → 获取标题 → base64 编码输出
    // 为什么用 base64：PowerShell 在 Electron 环境下 stdout 编码可能不是 UTF-8（OEM/cp437），
    // 中文直接输出会被破坏。base64 是纯 ASCII，无论 stdout 编码是什么都不会破坏。
    // Node.js 端用 Buffer.from(result, 'base64').toString('utf16le') 解码。
    const script = `Add-Type -Name W -Namespace C -MemberDefinition '[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();[DllImport("user32.dll")]public static extern int GetWindowText(IntPtr h,System.Text.StringBuilder t,int n);[DllImport("user32.dll")]public static extern int GetWindowTextLength(IntPtr h);'
$h=[C.W]::GetForegroundWindow()
$l=[C.W]::GetWindowTextLength($h)
$s=New-Object System.Text.StringBuilder($l+1)
[C.W]::GetWindowText($h,$s,$s.Capacity)
[Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($s.ToString()))`;
    // 用 -EncodedCommand 传递 base64(UTF-16LE) 编码的脚本，避免引号转义
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const result = execSync(
      `powershell -NoProfile -EncodedCommand ${encoded}`,
      { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    // PowerShell 返回 base64(UTF-16LE)，Node.js 解码
    const base64 = result.trim();
    if (!base64) return null;
    const title = Buffer.from(base64, 'base64').toString('utf16le');
    return title || null;
  } catch (err) {
    logger.warn({ err }, 'PowerShell 获取窗口标题失败');
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
   * 快速连续呼出场景：若捕获的窗口标题等于浮窗标题，保持上一次的 previousWindow。
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
   * @param floatTitle 浮窗窗口标题（用于排除捕获到浮窗自身）
   */
  async capturePreviousWindow(floatTitle?: string): Promise<void> {
    // 懒创建 InputInjector 单例（preloadInputInjector 已触发时直接复用）
    if (!this.inputInjector) {
      this.inputInjector = await getDefaultInputInjector();
    }
    // 捕获前台窗口（排除浮窗自身）
    const captured = await this.inputInjector.captureActiveWindow(floatTitle);
    // 若捕获到浮窗自身（返回 null），保持上一次的 previousWindow
    if (captured) {
      this.previousWindow = captured;
      // 立即检测 nut-js 标题是否乱码并尝试用 PowerShell 修复
      // 此时浮窗未 show()，PowerShell GetForegroundWindow 返回目标窗口（关键时序）
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
    try {
      const nutJsTitle = await window.title;
      if (!isGarbledTitle(nutJsTitle)) return null;
      // nut-js 标题含 U+FFFD → 编码 bug 触发，用 PowerShell 修复
      const psTitle = getForegroundWindowTitleViaPS();
      if (psTitle) {
        logger.info({ nutJsTitle, psTitle }, 'nut-js 标题乱码，已通过 PowerShell 修复');
        return psTitle;
      }
      // PowerShell 失败 → 返回 null，调用方降级使用 nut-js 乱码标题
      return null;
    } catch {
      return null;
    }
  }

  /**
   * 尝试自动粘贴
   *
   * 条件不满足（未启用/未注入 suppressNextChange/nut-js 不可用）时
   * 返回降级结果，由调用方走 fallback 路径。
   *
   * @param text 要粘贴的文本
   * @param hideFloat 隐藏浮窗的回调（粘贴成功前调用）
   * @returns 粘贴结果（mode='paste' 成功，mode='copy' 需降级）
   */
  async attemptPaste(text: string, hideFloat: () => void): Promise<PasteResult> {
    if (!this.autoPasteEnabled || !this.inputInjector || !this.suppressNextChange) {
      return { success: false, mode: 'copy', reason: 'no_deps' };
    }
    return this.inputInjector.paste(text, this.previousWindow, hideFloat, this.suppressNextChange);
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
   * 获取当前捕获窗口的应用名（用于 focus-bar 显示）
   *
   * 优先使用缓存的准确标题（capturePreviousWindow 时通过 PowerShell 获取），
   * 缓存为空时降级使用 nut-js 标题。
   * Windows 窗口标题格式通常为 "{文档名} - {应用名}"，取末段作为应用名。
   * 若格式不符（无 " - " 分隔符）则返回完整标题。
   *
   * @returns 应用名（无捕获窗口时返回 null）
   */
  async getCapturedAppName(): Promise<string | null> {
    if (!this.previousWindow) return null;
    try {
      // 优先使用 capturePreviousWindow 时缓存的准确标题（PS 修复后的 UTF-16 标题）
      // 缓存为 null 表示 nut-js 标题非乱码，直接用 nut-js 标题
      const title = this.cachedAccurateTitle ?? await this.previousWindow.title;

      // 窗口标题格式约定："{文档} - {应用名}"，取末段
      const parts = title.split(' - ');
      if (parts.length <= 1) return title;
      // noUncheckedIndexedAccess 下 parts[N] 推断为 string | undefined，提取局部变量后守卫
      const appName = parts[parts.length - 1];
      return appName ? appName.trim() : title;
    } catch {
      return null;
    }
  }
}
