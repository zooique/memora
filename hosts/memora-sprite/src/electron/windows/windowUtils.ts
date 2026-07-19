/**
 * 窗口工具函数集
 *
 * 集中管理 BrowserWindow 的可用性判断和安全 IPC 发送，消除主进程多模块
 * 中重复的 `if (win && !win.isDestroyed())` 守卫模式（ADR-017 枝叶层 2 次提取）。
 *
 * 提取理由：
 *   - spriteEventBridge.ts / agentListeners.ts 中"完整窗口可见且未最小化"判断重复 2 次
 *   - main.ts / chatStreamHandler.ts / spriteEventBridge.ts 中"未销毁即发送"模式重复 5+ 次
 *   - 集中守卫逻辑便于后续统一调整（如增加 webContents.isDestroyed 检查）
 *
 * 使用约束：
 *   - 仅处理 BrowserWindow 通用守卫，不包含业务逻辑
 *   - 不替代 FloatWindow.send()（FloatWindow 内部已封装 win 字段访问）
 */

import type { BrowserWindow } from 'electron';

/**
 * 判断完整窗口是否可访问（已创建 + 未销毁 + 可见 + 未最小化）
 *
 * macOS 上最小化的窗口 isVisible 可能仍为 true，需同时检查 !isMinimized。
 * 用于判断渲染进程是否能立即收到 IPC 消息（不可见/最小化时消息会堆积）。
 *
 * 作为 type guard（`window is BrowserWindow`）：返回 true 时 TypeScript 自动 narrow
 * 入参类型，调用方在 if 分支内无需再做非空断言。
 *
 * @param window BrowserWindow 引用（可能为 null）
 * @returns true=窗口可访问，false=不可访问（应跳过 IPC 发送或走降级路径）
 */
export function isFullWindowAccessible(window: BrowserWindow | null): window is BrowserWindow {
  // 同时检查 isVisible 和 !isMinimized：macOS 上最小化的窗口 isVisible 可能仍为 true
  return !!(
    window &&
    !window.isDestroyed() &&
    window.isVisible() &&
    !window.isMinimized()
  );
}

/**
 * 安全地向窗口发送 IPC 消息（窗口销毁时静默跳过）
 *
 * 守卫顺序：null → isDestroyed → webContents.send
 * 调用方无需重复 `if (win && !win.isDestroyed())` 守卫，统一委托本函数。
 *
 * 注意：本函数不检查 isVisible / isMinimized，仅保证不抛异常。
 * 需要可见性过滤的场景请先用 isFullWindowAccessible 判断。
 *
 * @param window BrowserWindow 引用（可能为 null）
 * @param channel IPC 通道名
 * @param args 传递给渲染进程的参数
 */
export function safeSendToWindow(
  window: BrowserWindow | null,
  channel: string,
  ...args: unknown[]
): void {
  // null/销毁守卫：避免向已销毁窗口发送引发 "Object has been destroyed" 异常
  if (!window || window.isDestroyed()) return;
  window.webContents.send(channel, ...args);
}
