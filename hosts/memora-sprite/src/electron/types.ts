/**
 * Electron 主进程类型 barrel
 *
 * 集中导出 electron 主进程分散在各模块的类型定义，提供统一入口。
 * 消费方可从此 barrel 统一 import 类型，避免从分散文件 import。
 *
 * 设计约束：
 * - 仅导出类型（export type），不导出运行时函数（如 safeHandle），
 *   避免引入运行时耦合。
 * - 运行时函数仍从原模块 import。
 * - sprite 层是 electron 层的依赖方（electron 依赖 sprite，不反向），
 *   因此 sprite 层类型不在此 barrel 中（见 sprite/controllers/index.ts）。
 *
 * 迁移策略：
 * - 现有代码逐步迁移，不强求一次性全量切换（避免运行时 import 与类型 import 同源时被拆散）。
 * - 新代码优先从此 barrel 导入类型，建立统一入口习惯。
 * - 当某文件已从原模块导入运行时符号时，类型可跟随原 import，不必强制迁移到 barrel。
 */

// 窗口状态管理
export type { WindowState, WindowStateData, WindowStateOptions } from './windows/windowState.js';

// 浮动窗口
export type { FloatWindowCallbacks } from './windows/floatWindow.js';

// 托盘图标
export type { TrayState, TrayCallbacks } from './trayIcon.js';

// 精灵事件桥接
export type { SpriteEventBridgeDeps } from './spriteEventBridge.js';

// 全局快捷键
export type { ShortcutAction, ShortcutManagerOptions } from './shortcuts.js';

// 错误处理
export type { AppError } from './errorHandler.js';

// IPC 通道载荷
// SerializedAppError / WorkProjectionPayload 真理源在 ipc/types.ts
export type { SerializedAppError } from './ipc/types.js';

// IPC 上下文（依赖容器）
export type { IpcContext } from './ipc/types.js';
