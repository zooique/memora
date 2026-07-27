/**
 * 快速输入/剪贴板基础设施状态容器
 *
 * 封装阶段 2 初始化的 2 个字段：
 * - clipboardHandler（剪贴板三重保护轮询）
 * - quickInputWindow（快速输入浮窗 UI + 粘贴协调）
 *
 * 设计原则：
 * - 纯状态容器，不持有业务逻辑（业务逻辑仍在 main.ts）
 * - 字段公开暴露，IPC handler 和 main.ts 直接读写
 *
 * 集成点：
 * - main.ts 持有 quickInputService 实例并挂载到 appState.quickInputService
 * - clipboardHandler 的 CLIPBOARD_ANALYZE IPC 通过 appState.quickInputService.clipboardHandler 访问
 * - quickInputWindow 的 IPC handler 在 quickInputWindow.ts 内联注册（ADR-SP-017 例外）
 * - shortcutManager QUICK_INPUT handler 通过 appState.quickInputService.quickInputWindow 访问（跨 Service 外部依赖）
 */

import type { ClipboardHandler } from '../clipboardHandler.js';
import type { QuickInputWindow } from '../windows/quickInputWindow.js';

/**
 * 快速输入/剪贴板基础设施状态容器类
 *
 * 集中管理阶段 2 初始化的 2 个字段，避免分散在 appState 中。
 * 退出时通过 nullify() 集中切断引用，防止退出后定时器残留触发已销毁对象的方法。
 */
export class QuickInputService {
  /** 剪贴板处理器（三重保护轮询 + CLIPBOARD_ANALYZE），阶段 2 初始化 */
  clipboardHandler!: ClipboardHandler;
  /** 快速输入浮窗（Phase 1 骨架：懒创建，快捷键 Ctrl+Shift+C 触发显示），阶段 2 初始化 */
  quickInputWindow!: QuickInputWindow;

  /**
   * 清空所有引用（退出时调用）
   *
   * 切断所有字段引用，防止退出后定时器残留触发已销毁对象的方法。
   * clipboardHandler.stopPolling / quickInputWindow.destroy 由 before-quit 回调前置执行。
   */
  nullify(): void {
    this.clipboardHandler = null!;
    this.quickInputWindow = null!;
  }
}
