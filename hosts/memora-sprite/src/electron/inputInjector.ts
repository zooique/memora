/**
 * 输入注入器 —— Phase 4 自动粘贴核心模块
 *
 * 职责：
 *   1. 记录呼出浮窗前的前台窗口（getActiveWindow）
 *   2. 确认时恢复焦点到原窗口 + 模拟 Ctrl+V 粘贴
 *   3. 剪贴板内容恢复（不覆盖用户原剪贴板）
 *   4. 非文本剪贴板保护（图片/文件不破坏）
 *   5. 任何步骤失败降级到复制+Toast 模式
 *
 * 设计原则（ADR-017 枝叶层）：
 *   - 不提前抽象 backend 接口，只实现 Clipboard 策略（业界共识方案）
 *   - 依赖注入 NutJsDeps 便于测试 mock（nut-js 在测试环境无法真实模拟键盘事件）
 *   - 动态 import nut-js：避免测试时强制加载 native 模块
 *
 * 流程（9 步）：
 *   1. getActiveWindow（create 之前）
 *   2. 检测剪贴板格式 + 保存原内容 + 写入目标 + suppressNextChange
 *   3. 隐藏浮窗
 *   4. 恢复焦点
 *   5. Ctrl+V
 *   6. 延迟 100ms（按文本长度自适应 100/200/500ms，见 calculatePasteDelay）
 *   7. 恢复剪贴板 + suppressNextChange
 *   8. onAfterConfirm 记忆沉淀
 *   9. Toast + 关闭
 *
 * 注：原 v0 设计包含"第 5 步 Esc（IME 处理）"用于关闭 CJK 输入法候选窗口，
 * 但实际代码从未实现此步骤（审查发现注释与实现不一致）。当前流程不模拟 Esc，
 * 依赖用户在呼出浮窗前手动确认 IME 候选词；若未来出现 IME 拦截 Ctrl+V 的反馈，
 * 再评估是否补全 Esc 按键模拟（需在 NutJsDeps.Key 接口添加 Escape 字段）。
 *
 * 集成点：
 *   - quickInputWindow.ts：show() 前调用 captureActiveWindow()，CONFIRM handler 调用 paste()
 *   - clipboardHandler.ts：suppressNextChange() 实例方法注入
 */

import { clipboard } from 'electron';
import { execSync } from 'node:child_process';
// 类型导入（编译时擦除，不影响零 native 依赖运行时）：用于 getDefaultInputInjector 中的类型适配
import type { Key as NutJsKeyType } from '@nut-tree-fork/nut-js';
import { logger } from 'memora';

/**
 * nut-js 活跃窗口的最小接口抽象
 *
 * 从 nut-js 的 Window 类提取必要接口，避免直接依赖 native 类型，
 * 便于测试 mock（测试环境无需安装/加载 nut-js native 模块）。
 *
 * 注意：title/region 在 nut-js 中是返回 Promise 的 getter（Spike 验证确认）。
 */
export interface ActiveWindow {
  /** 窗口标题（Promise getter，需 await） */
  readonly title: Promise<string>;
  /** 窗口区域（Promise getter，需 await） */
  readonly region: Promise<{ left: number; top: number; width: number; height: number }>;
  /** 恢复焦点到该窗口 */
  focus: () => Promise<void>;
  /**
   * Win32 窗口句柄（HWND）
   *
   * nut-js Window 对象内部存储的原生窗口句柄。
   * 用于绕过 nut-js 的 GetWindowTextA 编码 bug：
   * 拿到 HWND 后可直接调用 GetWindowTextW 获取正确的 Unicode 标题。
   * 值为 undefined 时降级到 nut-js 标题（可能乱码）。
   */
  readonly hwnd?: number;
}

/**
 * nut-js 依赖的最小接口抽象
 *
 * 仅暴露 InputInjector 需要的 3 个 API：
 *   - getActiveWindow：获取前台窗口
 *   - keyboard.pressKey / releaseKey：模拟按键（Ctrl+V）
 *   - Key：按键枚举（LeftControl / V）
 */
export interface NutJsDeps {
  /** 获取当前前台窗口 */
  getActiveWindow: () => Promise<ActiveWindow>;
  /** 键盘模拟 API */
  keyboard: {
    pressKey: (...keys: NutJsKey[]) => Promise<void>;
    releaseKey: (...keys: NutJsKey[]) => Promise<void>;
  };
  /** 按键枚举（nut-js 的 Key 对象） */
  Key: {
    LeftControl: NutJsKey;
    V: NutJsKey;
  };
}

/** nut-js Key 类型（opaque，只需在 pressKey/releaseKey 间传递） */
export type NutJsKey = unknown;

/** 粘贴结果（含 mode 字段区分 paste / copy 降级） */
export interface PasteResult {
  /** 是否成功（无论 paste 还是 copy 降级，只要用户拿到文本就 true） */
  success: boolean;
  /** 成功模式：paste=自动粘贴成功，copy=降级到复制+Toast */
  mode: 'paste' | 'copy';
  /** 失败原因（降级时用于日志） */
  reason?: 'no_deps' | 'no_previous_window' | 'non_text_clipboard' | 'focus_failed' | 'paste_failed';
  /** 粘贴目标应用名（paste 模式下供 Toast 显示） */
  appName?: string;
  /** 异常信息（降级时用于日志） */
  error?: unknown;
}

/**
 * 根据文本长度计算粘贴延迟（ms）
 *
 * 短文本（<50 字符）：100ms（快速响应）
 * 中等文本（<200 字符）：200ms（平衡体验与可靠性）
 * 长文本（≥200 字符）：500ms（确保长文本粘贴完成）
 *
 * 之前固定 100ms 导致长文本粘贴被截断——剪贴板在粘贴完成前被恢复。
 */
function calculatePasteDelay(text: string): number {
  if (text.length < 50) return 100;
  if (text.length < 200) return 200;
  return 500;
}

/**
 * 通过 PowerShell SendInput 发送 Ctrl+V 到当前前台窗口
 *
 * 技术选型：
 *   - 用 PowerShell keybd_event 替代 nut-js keyboard：nut-js pressKey+releaseKey 耗时 611ms，
 *     PowerShell SendInput 仅 ~100ms（浮窗保持可见时无闪烁）
 *   - 用 -EncodedCommand 传递 base64(UTF-16LE) 脚本：避免引号转义问题
 *
 * @returns true=发送成功，false=PowerShell 调用失败（调用方降级到 nut-js keyboard）
 */
function sendCtrlVViaPS(): boolean {
  // PowerShell 脚本：Add-Type 定义 keybd_event P/Invoke → 模拟 Ctrl+V 按键
  // VK_CONTROL=0x11, VK_V=0x56, KEYEVENTF_KEYUP=0x0002
  const script = `Add-Type -Name W -Namespace C -MemberDefinition '[DllImport("user32.dll")]public static extern void keybd_event(byte bVk,byte bScan,uint dwFlags,UIntPtr dwExtraInfo);'
[C.W]::keybd_event(0x11,0,0,[UIntPtr]::Zero)
[C.W]::keybd_event(0x56,0,0,[UIntPtr]::Zero)
[C.W]::keybd_event(0x56,0,2,[UIntPtr]::Zero)
[C.W]::keybd_event(0x11,0,2,[UIntPtr]::Zero)`;
  // 用 -EncodedCommand 传递 base64(UTF-16LE) 编码的脚本，避免引号转义
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  try {
    execSync(`powershell -NoProfile -EncodedCommand ${encoded}`, {
      encoding: 'utf8',
      timeout: 2000,
      stdio: 'ignore',
    });
    return true;
  } catch (err) {
    logger.warn({ err }, 'PowerShell SendInput Ctrl+V 失败，将降级到 nut-js keyboard');
    return false;
  }
}

/**
 * 输入注入器
 *
 * 封装 nut-js 的窗口管理和键盘模拟，实现自动粘贴流程。
 * deps 为 null 时进入降级模式（所有 paste 调用直接返回 copy 降级）。
 */
export class InputInjector {
  /**
   * @param deps nut-js 依赖（null = 降级模式，测试或 nut-js 不可用时）
   */
  constructor(private readonly deps: NutJsDeps | null) {}

  /**
   * 捕获当前前台窗口（show() 前调用）
   *
   * 必须在浮窗 create() 之前调用，否则浮窗自身会成为前台窗口。
   * 快速连续呼出场景：若捕获的窗口标题等于浮窗标题，返回 null（保持上一次的窗口）。
   *
   * @param floatWindowTitle 浮窗标题（用于排除浮窗自身，可选）
   * @returns 活跃窗口或 null（nut-js 不可用或捕获失败）
   */
  async captureActiveWindow(floatWindowTitle?: string): Promise<ActiveWindow | null> {
    if (!this.deps) return null;
    try {
      const active = await this.deps.getActiveWindow();
      // 排除浮窗自身（快速连续呼出场景）
      if (floatWindowTitle) {
        const title = await active.title;
        if (title === floatWindowTitle) {
          return null;
        }
      }
      return active;
    } catch {
      // 捕获失败不阻断浮窗显示，降级到复制+Toast
      return null;
    }
  }

  /**
   * 模拟 Ctrl+V 粘贴文本到指定窗口
   *
   * 完整流程（5 步）：
   *   1. 检测剪贴板格式 + 保存原内容 + 写入目标 + suppressNextChange
   *   2. 恢复焦点到原前台窗口（previousWindow.focus）
   *   3. PowerShell SendInput 发送 Ctrl+V（失败降级到 nut-js keyboard）
   *   4. 延迟（按文本长度自适应 100/200/500ms）
   *   5. 恢复剪贴板 + suppressNextChange
   *
   * 实现要点：
   *   - 浮窗不 hide：hideFloat 为 no-op，浮窗保持可见支持流式输入
   *   - focus() 用 nut-js SetForegroundWindow：目标窗口获焦后即使被浮窗遮挡也能接收键盘事件
   *   - appName 由 pasteCoordinator.getCapturedAppName() 独立获取，paste 不返回
   *
   * @param text 要粘贴的文本
   * @param previousWindow 呼出浮窗前的前台窗口（null 则降级）
   * @param hideFloat 隐藏浮窗的回调（保留接口兼容，当前为 no-op，浮窗保持可见）
   * @param suppressNextChange 剪贴板三重保护抑制函数（一次性抑制，每次写入都需调用）
   * @returns PasteResult（mode='paste' 成功，mode='copy' 降级）
   */
  async paste(
    text: string,
    previousWindow: ActiveWindow | null,
    hideFloat: () => void,
    suppressNextChange: () => void,
  ): Promise<PasteResult> {
    // 边界 0：nut-js 不可用，降级
    if (!this.deps) {
      return { success: false, mode: 'copy', reason: 'no_deps' };
    }
    // 边界 1：无原窗口句柄，降级
    if (!previousWindow) {
      return { success: false, mode: 'copy', reason: 'no_previous_window' };
    }

    // 边界 3 前置：检测原剪贴板格式，非纯文本则降级（排雷修正雷 6.2）
    const formats = clipboard.availableFormats();
    if (formats.length === 0 || !formats.includes('text/plain')) {
      return { success: false, mode: 'copy', reason: 'non_text_clipboard' };
    }

    // 保存原剪贴板内容
    const originalClipboard = clipboard.readText();

    try {
      // 写入目标文本 + suppressNextChange（第一次调用，一次性抑制）
      clipboard.writeText(text);
      suppressNextChange();

      // hideFloat 保留接口兼容，当前为 no-op（浮窗保持可见，避免 hide/show 闪烁）
      hideFloat();

      // 步骤 2：恢复焦点到原前台窗口（SetForegroundWindow）
      // 即使浮窗 alwaysOnTop=true 挡在前面，目标窗口获焦后仍能接收键盘事件
      try {
        await previousWindow.focus();
      } catch (err) {
        return { success: false, mode: 'copy', reason: 'focus_failed', error: err };
      }

      // 步骤 3：PowerShell SendInput 发送 Ctrl+V
      // 绕过 nut-js keyboard（pressKey+releaseKey 耗时 611ms，PowerShell SendInput 仅 ~100ms）
      const sent = sendCtrlVViaPS();
      if (!sent) {
        // PowerShell 失败，降级到 nut-js keyboard（兼容非 Windows 环境）
        await this.deps.keyboard.pressKey(this.deps.Key.LeftControl, this.deps.Key.V);
        await this.deps.keyboard.releaseKey(this.deps.Key.LeftControl, this.deps.Key.V);
      }

      // 步骤 4：等待系统完成粘贴（根据文本长度动态调整延迟）
      const pasteDelay = calculatePasteDelay(text);
      await new Promise(resolve => setTimeout(resolve, pasteDelay));

      return { success: true, mode: 'paste' };
    } catch (err) {
      return { success: false, mode: 'copy', reason: 'paste_failed', error: err };
    } finally {
      // 边界 3：恢复原剪贴板内容（无论成功失败）
      // 排雷修正雷 1.1：suppressNextChange 是一次性抑制，恢复时需再次调用
      clipboard.writeText(originalClipboard);
      suppressNextChange();
    }
  }
}

/**
 * 单例 InputInjector（懒创建，动态 import nut-js）
 *
 * 动态 import 策略：
 *   - 生产环境：首次调用时动态 import @nut-tree-fork/nut-js，创建真实 InputInjector
 *   - 测试环境：可通过 setInputInjectorForTest() 注入 mock
 *   - nut-js 不可用：创建降级 InputInjector（deps=null，所有 paste 返回 copy 降级）
 */
let defaultInjector: InputInjector | null = null;

/**
 * 获取默认 InputInjector 单例
 *
 * 首次调用时动态 import nut-js。若 import 失败（native 模块不可用），
 * 创建降级 InputInjector（deps=null）。
 *
 * @returns InputInjector 实例
 */
export async function getDefaultInputInjector(): Promise<InputInjector> {
  if (defaultInjector) return defaultInjector;

  try {
    // 动态 import：避免测试环境强制加载 native 模块
    const nutJs = await import('@nut-tree-fork/nut-js');
    // 适配层：nut-js 实际 API 类型与 NutJsDeps 接口存在两处差异，需包装
    //   1. Window.focus() 返回 Promise<boolean>，接口要求 Promise<void>
    //   2. keyboard.pressKey/releaseKey 返回 Promise<KeyboardClass>（链式），接口要求 Promise<void>
    //      且参数 Key[] 与 NutJsKey(unknown) 不兼容（strictFunctionTypes 下逆变）
    defaultInjector = new InputInjector({
      getActiveWindow: async () => {
        const win = await nutJs.getActiveWindow();
        return {
          title: win.title,
          region: win.region,
          focus: async () => { await win.focus(); },
          // 提取 nut-js Window 内部的原生窗口句柄（HWND）
          // 用于绕过 GetWindowTextA 的 GBK→UTF-8 编码 bug
          hwnd: (win as unknown as { windowHandle?: number }).windowHandle,
        };
      },
      keyboard: {
        pressKey: (...keys: NutJsKey[]) =>
          nutJs.keyboard.pressKey(...(keys as NutJsKeyType[])).then(() => undefined),
        releaseKey: (...keys: NutJsKey[]) =>
          nutJs.keyboard.releaseKey(...(keys as NutJsKeyType[])).then(() => undefined),
      },
      Key: nutJs.Key,
    });
  } catch {
    // nut-js 不可用，降级模式
    defaultInjector = new InputInjector(null);
  }
  return defaultInjector;
}

/**
 * 测试用：注入 mock InputInjector（仅供测试调用）
 *
 * @param injector mock 实例或 null（重置为默认懒创建）
 */
export function setInputInjectorForTest(injector: InputInjector | null): void {
  defaultInjector = injector;
}
