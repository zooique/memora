/**
 * IPC 处理器聚合注册入口
 *
 * 职责：聚合调用各领域 register 函数。
 *
 * 仅首次调用注册，reinitAgent 路径不再重注册：
 * - IpcContext 通过 getter 实时访问 appState.agent/sprite/sessionStore，
 *   reinit 后 IPC handler 自动看到新实例，无需 removeHandler + 重注册。
 * - 调用方（main.ts setupAgentReady）用 appState.ipcRegistered 标志保证幂等。
 * - 若强行重复调用本函数，ipcMain.handle 会抛"Attempted to register a second handle"——
 *   这是 Electron 的契约，由调用方保证不重复调用。
 */

import type { IpcContext } from './types.js';
import { registerChatHandlers } from './chatHandlers.js';
import { registerSessionHandlers } from './sessionHandlers.js';
import { registerMemoryHandlers } from './memoryHandlers.js';
import { registerConfigHandlers } from './configHandlers.js';
import { registerSystemHandlers } from './systemHandlers.js';
import { registerSuggestionHandlers } from './suggestionHandlers.js';
import { registerWorkProjectionHandlers } from './workProjectionHandlers.js';

/**
 * 注册所有 IPC 处理器（仅首次调用）
 *
 * 不支持重复调用：
 * - IpcContext 持有 appState 引用，getter 实时返回最新实例，无需重注册
 * - 调用方负责保证仅首次调用（appState.ipcRegistered 标志）
 *
 * @param ctx IPC 上下文（Agent + Sprite + SessionStore + WindowManager 等）
 */
export function registerIpcHandlers(ctx: IpcContext): void {
  // 聚合注册各领域 handler
  registerChatHandlers(ctx);
  registerSessionHandlers(ctx);
  registerMemoryHandlers(ctx);
  registerConfigHandlers(ctx);
  registerSystemHandlers(ctx);
  registerSuggestionHandlers(ctx);
  registerWorkProjectionHandlers(ctx);
}
