/**
 * 输入注入器 —— Phase 4 自动粘贴核心模块
 *
 * 职责：
 *   1. 记录呼出浮窗前的前台窗口（getActiveWindow）
 *   2. 确认时恢复焦点到原窗口 + 模拟 Ctrl+V 粘贴
 *   3. 剪贴板恢复策略：成功路径【不】恢复（使剪贴板停留为提交文本，供下次唤起去重）；失败/降级路径恢复用户原剪贴板
 *   4. 非文本剪贴板保护（图片/文件不破坏）
 *   5. 任何步骤失败降级到复制+Toast 模式
 *
 * 设计原则：
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
 *   7. 失败路径恢复剪贴板 + suppressNextChange（成功路径不恢复，见 paste()）
 *   8. onAfterConfirm 记忆沉淀
 *   9. Toast + 关闭
 *
 * IME 处理说明：当前流程不模拟 Esc 按键关闭 CJK 输入法候选窗口，
 * 依赖用户在呼出浮窗前手动确认 IME 候选词；若未来出现 IME 拦截 Ctrl+V 的反馈，
 * 再评估是否补全 Esc 按键模拟（需在 NutJsDeps.Key 接口添加 Escape 字段）。
 *
 * 集成点：
 *   - pasteCoordinator.ts：capturePreviousWindow() 调用 captureActiveWindow(floatHwnd)，通过 HWND 排除浮窗自身
 *   - quickInputWindow.ts：show() 前提取 BrowserWindow HWND 传给 pasteCoordinator
 *   - clipboardHandler.ts：suppressNextChange() 实例方法注入
 */

import { clipboard } from 'electron';
import { load } from 'koffi';
// 类型导入（编译时擦除，不影响零 native 依赖运行时）：用于 getDefaultInputInjector 中的类型适配
import type { Key as NutJsKeyType } from '@nut-tree-fork/nut-js';
import { logger } from 'memora';

// ── Win32 FFI：加载 user32.dll 并定义 keybd_event（零进程启动，<1ms）──
// 与 pasteCoordinator.ts 共享同一 DLL，koffi 内部缓存确保只加载一次
// koffi 类型映射：Win32 BYTE→uint8, DWORD→uint32, ULONG_PTR→uintptr_t
const user32 = load('user32.dll');
const keybd_event = user32.func(
  'void keybd_event(uint8 bVk, uint8 bScan, uint32 dwFlags, uintptr_t dwExtraInfo)',
);

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
 * nut-js Window 的最小接口抽象
 *
 * 显式声明 windowHandle 字段，避免适配层用 `as unknown as { windowHandle?: number }`
 * 绕过类型检查（ADR-SP-018 §3）。
 *
 * nut-js Window 类内部存储的原生窗口句柄（HWND），用于：
 *   - 提取 HWND 后可调用 GetWindowTextW 获取正确 Unicode 标题（绕过 GetWindowTextA 编码 bug）
 *   - 提取 HWND 后可与浮窗 HWND 直接比较，消除 nut-js title 乱码导致的误识别
 *
 * 注意：title/region 在 nut-js 中是返回 Promise 的 getter（Spike 验证确认）。
 * 此接口仅在适配层（getDefaultInputInjector）用于类型断言，业务层使用 ActiveWindow。
 */
export interface NutJsWindow {
  /** 窗口标题（Promise getter，需 await） */
  readonly title: Promise<string>;
  /** 窗口区域（Promise getter，需 await） */
  readonly region: Promise<{ left: number; top: number; width: number; height: number }>;
  /** 恢复焦点到该窗口 */
  focus: () => Promise<unknown>;
  /**
   * Win32 窗口句柄（HWND）
   *
   * nut-js Window 对象内部存储的原生窗口句柄。
   * 用于绕过 nut-js 的 GetWindowTextA 编码 bug：
   * 拿到 HWND 后可直接调用 GetWindowTextW 获取正确的 Unicode 标题。
   * 值为 undefined 时降级到 nut-js 标题（可能乱码）。
   */
  readonly windowHandle?: number;
}

/**
 * nut-js 依赖的最小接口抽象
 *
 * 仅暴露 InputInjector 需要的 3 个 API：
 *   - getActiveWindow：获取前台窗口（返回 ActiveWindow，hwnd 已从 nut-js windowHandle 提取）
 *   - keyboard.pressKey / releaseKey：模拟按键（Ctrl+V）
 *   - Key：按键枚举（LeftControl / V）
 *
 * 设计说明（ADR-SP-018 §3）：
 *   - 适配层（getDefaultInputInjector）将 nut-js Window 转换为 ActiveWindow，
 *     从 NutJsWindow.windowHandle 提取 hwnd 字段，业务层统一使用 ActiveWindow.hwnd
 *   - NutJsWindow 接口仅在适配层使用，避免 as unknown as 双重类型转换
 */
export interface NutJsDeps {
  /** 获取当前前台窗口（返回 ActiveWindow，hwnd 已从 nut-js windowHandle 提取） */
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
 * 通过 koffi FFI 直接调用 Win32 keybd_event 发送 Ctrl+V
 *
 * 根因修复（与 getWindowTitle 同一模式）：
 *   旧方案用 PowerShell Add-Type 编译 C# keybd_event P/Invoke，
 *   每次 spawnSync 新进程编译 2-5 秒，打包 Electron 中频繁 ETIMEDOUT。
 *   koffi FFI 在 Node.js 进程内直接调用 user32.dll，零进程启动，<1ms。
 *
 * @returns true=发送成功，false=koffi 调用失败（调用方降级到 nut-js keyboard）
 */
function sendCtrlVViaFFI(): boolean {
  try {
    // VK_CONTROL=0x11, VK_V=0x56, KEYEVENTF_KEYUP=0x0002
    const VK_CONTROL = 0x11;
    const VK_V = 0x56;
    const KEYEVENTF_KEYUP = 0x0002;
    // 按下 Ctrl → 按下 V → 释放 V → 释放 Ctrl（dwExtraInfo=0，无额外信息）
    keybd_event(VK_CONTROL, 0, 0, 0);
    keybd_event(VK_V, 0, 0, 0);
    keybd_event(VK_V, 0, KEYEVENTF_KEYUP, 0);
    keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0);
    return true;
  } catch (err) {
    logger.warn({ err }, 'koffi keybd_event Ctrl+V 失败，将降级到 nut-js keyboard');
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
   * 快速连续呼出场景：通过 HWND 比较排除浮窗自身（绕过 nut-js GetWindowTextA 编码 bug）。
   *
   * ADR-SP-018：不再依赖 nut-js title 字符串比较，改用 HWND 直接比较。
   * nut-js 底层调用 GetWindowTextA（ANSI 版本），中文窗口标题会返回 U+FFFD 乱码，
   * 导致浮窗自身排除失效。HWND 是 Win32 原生句柄，零编码损失。
   *
   * @param floatWindowHwnd 浮窗的 Win32 窗口句柄（HWND），用于排除浮窗自身
   * @returns 活跃窗口或 null（nut-js 不可用或捕获失败）
   */
  async captureActiveWindow(floatWindowHwnd?: number): Promise<ActiveWindow | null> {
    if (!this.deps) return null;
    try {
      const active = await this.deps.getActiveWindow();
      // 排除浮窗自身：通过 HWND 直接比较（绕过 nut-js 标题编码 bug）
      if (floatWindowHwnd !== undefined && active.hwnd === floatWindowHwnd) {
        return null;
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
   *   3. koffi FFI keybd_event 发送 Ctrl+V（失败降级到 nut-js keyboard）
   *   4. 延迟（按文本长度自适应 100/200/500ms）
   *   5. 失败路径恢复剪贴板 + suppressNextChange；成功路径【不】恢复（见下方说明）
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

    // 保存原剪贴板内容（仅用于失败/降级路径恢复，保全用户原内容）
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
        // 焦点恢复失败：粘贴实际未发生，必须恢复用户原剪贴板（避免丢失），降级返回
        // 注意：此处是内层 return（不抛异常），不能依赖下方 catch 恢复，须显式恢复
        clipboard.writeText(originalClipboard);
        suppressNextChange();
        return { success: false, mode: 'copy', reason: 'focus_failed', error: err };
      }

      // 步骤 3：koffi FFI 直接发送 Ctrl+V（零进程启动，<1ms）
      // 绕过 nut-js keyboard（pressKey+releaseKey 耗时 611ms）
      const sent = sendCtrlVViaFFI();
      if (!sent) {
        // koffi 失败，降级到 nut-js keyboard（兼容非 Windows 环境）
        await this.deps.keyboard.pressKey(this.deps.Key.LeftControl, this.deps.Key.V);
        await this.deps.keyboard.releaseKey(this.deps.Key.LeftControl, this.deps.Key.V);
      }

      // 步骤 4：等待系统完成粘贴（根据文本长度动态调整延迟）
      const pasteDelay = calculatePasteDelay(text);
      await new Promise(resolve => setTimeout(resolve, pasteDelay));

      // 步骤 5（成功路径）：【刻意不恢复剪贴板】，使其停留为被提交文本。
      // 契约对齐：quickInput.ts handleShow 的「剪贴板智能预填去重」假设
      // 「提交成功后剪贴板 == 提交文本」——下次唤起时剪贴板==最近提交→跳过预填→显示历史。
      // 同时消除短文本 100ms 恢复竞态：目标应用读到的是被提交文本，而非被恢复的原始剪贴板。
      // 失败/降级路径仍在下方 catch 恢复用户原剪贴板，确保异常时用户内容不丢失。
      return { success: true, mode: 'paste' };
    } catch (err) {
      // 粘贴过程异常：恢复用户原剪贴板（仅异常路径），避免用户内容丢失
      clipboard.writeText(originalClipboard);
      suppressNextChange();
      return { success: false, mode: 'copy', reason: 'paste_failed', error: err };
    }
  }
}

/**
 * 单例 InputInjector（懒创建，动态 import nut-js）
 *
 * 动态 import 策略：
 *   - 生产环境：首次调用时动态 import @nut-tree-fork/nut-js，创建真实 InputInjector
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
    // 适配层：nut-js 实际 API 类型与 NutJsDeps 接口存在差异，需包装
    //   1. Window.focus() 返回 Promise<boolean>，ActiveWindow 要求 Promise<void>
    //   2. keyboard.pressKey/releaseKey 返回 Promise<KeyboardClass>（链式），接口要求 Promise<void>
    //      且参数 Key[] 与 NutJsKey(unknown) 不兼容（strictFunctionTypes 下逆变）
    //   3. nut-js Window 类未公开 windowHandle 类型，用 NutJsWindow 接口类型断言提取
    defaultInjector = new InputInjector({
      getActiveWindow: async () => {
        // cast nut-js Window 为 NutJsWindow，访问 windowHandle 字段提取 HWND
        const win = (await nutJs.getActiveWindow()) as unknown as NutJsWindow;
        // 转换 NutJsWindow → ActiveWindow，提取 windowHandle 为 hwnd 字段
        // focus 包装为 Promise<void>（nut-js 原返回 Promise<boolean>）
        return {
          title: win.title,
          region: win.region,
          focus: async () => { await win.focus(); },
          hwnd: win.windowHandle,
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

