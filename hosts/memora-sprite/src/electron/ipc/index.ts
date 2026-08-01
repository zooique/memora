/**
 * IPC 处理器聚合注册入口
 *
 * 职责：聚合调用各领域 register 函数。
 *
 * 仅首次调用注册，reinitAgent 路径不再重注册：
 * - IpcContext 通过 getter 实时访问 appState.agent/sprite/sessionStore，
 *   reinit 后 IPC handler 自动看到新实例，无需 removeHandler + 重注册。
 * - 调用方（main.ts setupAgentReady）用 appState.ipcRegistered 标志保证幂等。
 *
 * minimalHandlers 通道接管：
 * - 启动期 minimalHandlers 注册了 onboarding 阶段必需的临时通道（如 CONFIG_GET、PROJECTS_LIST）
 * - 完整 IPC 接管时这些通道会被各领域 handler 重新注册，需先 removeHandler 避免冲突
 * - 持久通道（AGENT_STATUS、LLM_PROVIDER、AUDIT_LOG_*）完整 IPC 不重复注册，保留 minimalHandlers 的实现
 */

import { ipcMain } from 'electron';
import type { IpcContext } from './types.js';
import { registerChatHandlers } from './chatHandlers.js';
import { registerSessionHandlers } from './sessionHandlers.js';
import { registerMemoryHandlers } from './memoryHandlers.js';
import { registerConfigHandlers } from './configHandlers.js';
import { registerSystemHandlers } from './systemHandlers.js';
import { registerSuggestionHandlers } from './suggestionHandlers.js';
import { registerWorkProjectionHandlers } from './workProjectionHandlers.js';
import { IPC_CHANNELS } from './channels.js';

/**
 * minimalHandlers 注册的、会被完整 IPC 接管的通道列表
 *
 * 这些通道在 onboarding 阶段由 minimalHandlers 注册（Agent 未就绪时），
 * 完整 IPC 接管时由各领域 handler 重新注册（Agent 就绪后），需先 removeHandler。
 */
const MINIMAL_HANDLERS_TO_TAKE_OVER = [
  IPC_CHANNELS.CONFIG_GET,
  IPC_CHANNELS.PROJECTS_LIST,
] as const;

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
  // 清理 minimalHandlers 在 onboarding 阶段注册的临时通道，避免完整 IPC 重新注册时冲突
  // 持久通道（AGENT_STATUS 等）不在此列表，保留 minimalHandlers 的实现
  for (const channel of MINIMAL_HANDLERS_TO_TAKE_OVER) {
    ipcMain.removeHandler(channel);
  }

  // 聚合注册各领域 handler
  registerChatHandlers(ctx);
  registerSessionHandlers(ctx);
  registerMemoryHandlers(ctx);
  registerConfigHandlers(ctx);
  registerSystemHandlers(ctx);
  registerSuggestionHandlers(ctx);
  registerWorkProjectionHandlers(ctx);
}
