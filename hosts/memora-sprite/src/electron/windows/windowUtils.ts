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
 *
 * 使用场景：仅用于"需要用户交互"的请求-响应场景（如写入确认对话框）。
 * 窗口不可见时用户无法看到对话框，应快速失败而非等待超时。
 *
 * 不适用场景：单向数据推送（剪贴板 IPC / 精灵事件 / 配置建议 / 快捷键触发）
 * 应使用 safeSendToWindow——webContents.send 向隐藏窗口发送不抛异常，
 * 渲染层在窗口隐藏时仍能接收并缓存消息，窗口显示时直接展示。
 * 用 isFullWindowAccessible 守卫此类场景会导致数据永久丢失（BUG-6 同类模式）。
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
 * 适用场景：单向数据推送（剪贴板 IPC / 精灵事件 / 配置建议 / 快捷键触发）。
 * 不检查 isVisible / isMinimized——隐藏窗口的渲染进程仍能接收 IPC 并缓存，
 * 窗口恢复可见时直接展示。这是为了避免"单向推送 + 会话级内存态 = 阻断即永久丢失"
 * 的不可逆损失点（BUG-6 修复后的统一守卫策略）。
 *
 * 不适用场景：需要用户交互的请求-响应（如写入确认对话框），应先用
 * isFullWindowAccessible 判断，窗口不可见时快速失败。
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
