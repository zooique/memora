/**
 * 自动粘贴协调器 —— 从 QuickInputWindow 抽离的 Phase 4 编排逻辑
 *
 * 职责：
 *   1. 管理 InputInjector 实例（懒创建）
 *   2. 捕获呼出浮窗前的前台窗口（show() 前调用）
 *   3. 尝试自动粘贴（优先 paste，失败降级返回 copy）
 *   4. 管理剪贴板三重保护抑制函数 + 自动粘贴开关
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

import { getDefaultInputInjector, type InputInjector, type ActiveWindow, type PasteResult } from '../inputInjector.js';

/** 剪贴板三重保护抑制函数类型（由 clipboardHandler.suppressNextChange 注入） */
export type SuppressNextChange = () => void;

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
   * 获取当前捕获窗口的应用名
   *
   * ActiveWindow 接口当前仅暴露 title（窗口标题），无 appName 字段。
   * v1 实现：返回窗口标题末段（多数 Windows 窗口标题格式为 "{文档名} - {应用名}"，
   * 取末段应用名；若格式不符则返回完整标题）。
   * v2 规划：inputInjector 升级时增加 getProcessName 能力，返回真实应用名。
   *
   * @returns 应用名（无捕获窗口时返回 null）
   */
  async getCapturedAppName(): Promise<string | null> {
    if (!this.previousWindow) return null;
    try {
      const title = await this.previousWindow.title;
      // 窗口标题格式约定："{文档} - {应用名}"，取末段
      const parts = title.split(' - ');
      return parts.length > 1 ? parts[parts.length - 1].trim() : title;
    } catch {
      return null;
    }
  }
}
