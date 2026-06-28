/**
 * IPC 处理器聚合注册入口
 *
 * 职责：
 *   1. 通道清理（reinitAgent 重复调用时先移除旧 handler，避免重复注册抛错）
 *   2. 聚合调用各领域 register 函数
 *
 * 支持重复调用：reinitAgent 路径会在 Agent 重新初始化后再次调用本函数。
 */

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from './channels.js';
import type { IpcContext } from './types.js';
import { registerChatHandlers } from './chatHandlers.js';
import { registerSessionHandlers } from './sessionHandlers.js';
import { registerMemoryHandlers } from './memoryHandlers.js';
import { registerConfigHandlers } from './configHandlers.js';
import { registerSystemHandlers } from './systemHandlers.js';
import { registerSuggestionHandlers } from './suggestionHandlers.js';
import { registerWorkProjectionHandlers } from './workProjectionHandlers.js';

/**
 * 所有通过 ipcMain.handle 注册的通道
 *
 * reinitAgent 路径可能重复调用注册函数，先清理这些通道避免重复注册抛错。
 */
const HANDLE_CHANNELS = [
  IPC_CHANNELS.CHAT_ABORT,
  IPC_CHANNELS.SESSION_LOAD,
  // SESSION_NEW 已移除（会话按天自动存储）
  IPC_CHANNELS.SESSION_LIST,
  // P1 修复：遗漏这三个通道会导致 reinitAgent 时 ipcMain.handle 重复注册抛错
  IPC_CHANNELS.SESSION_SWITCH,
  IPC_CHANNELS.SESSION_DELETE,
  IPC_CHANNELS.SESSION_RENAME,
  IPC_CHANNELS.MEMORIES_LIST,
  IPC_CHANNELS.MEMORIES_SEARCH,
  IPC_CHANNELS.MEMORIES_SHOW,
  IPC_CHANNELS.MEMORIES_DELETE,
  IPC_CHANNELS.MEMORIES_ADD,
  IPC_CHANNELS.MEMORIES_RELATION_GRAPH,
  IPC_CHANNELS.MEMORIES_HEALTH_DASHBOARD,
  IPC_CHANNELS.MEMORIES_REVIEW_DATA,
  IPC_CHANNELS.MEMORIES_DELETE_BATCH,
  IPC_CHANNELS.CONFIG_GET,
  IPC_CHANNELS.CONFIG_UPDATE,
  // QC-CONFIG-01：批量配置通道也需在 reinitAgent 时清理，避免重复注册抛错
  IPC_CHANNELS.CONFIG_UPDATE_BATCH,
  IPC_CHANNELS.PERSONA_LIST,
  IPC_CHANNELS.PERSONA_SWITCH,
  IPC_CHANNELS.PERSONA_MODE,
  IPC_CHANNELS.PERSONA_MODE_GET,
  IPC_CHANNELS.PROJECTS_LIST,
  IPC_CHANNELS.DASHBOARD_GET,
  // H1：配置建议（接受/拒绝）
  IPC_CHANNELS.SUGGESTION_ACCEPT,
  IPC_CHANNELS.SUGGESTION_REJECT,
  // H2：用户画像管理
  IPC_CHANNELS.USER_PROFILE_LIST,
  IPC_CHANNELS.USER_PROFILE_CONFIRM,
  IPC_CHANNELS.USER_PROFILE_REJECT,
  // H3：作品投影查看
  IPC_CHANNELS.WORK_PROJECTION_LIST,
  IPC_CHANNELS.WORK_PROJECTION_SHOW,
] as const;

/**
 * 所有通过 ipcMain.on 监听的通道
 */
const ON_CHANNELS = [
  IPC_CHANNELS.USER_INPUT,
  IPC_CHANNELS.PROACTIVE_PROMPT_SHOWN,
  IPC_CHANNELS.THEME_CHANGED,
] as const;

/**
 * 注册所有 IPC 处理器
 *
 * 支持重复调用：reinitAgent 路径会在 Agent 重新初始化后再次调用本函数。
 * 先清理本函数注册的通道，避免重复注册 handle 或重复监听 on 事件。
 *
 * @param ctx IPC 上下文（Agent + Sprite + SessionStore + WindowManager 等）
 */
export function registerIpcHandlers(ctx: IpcContext): void {
  // 通道清理：removeHandler 对未注册通道是 no-op，安全用于幂等注册
  for (const channel of HANDLE_CHANNELS) {
    ipcMain.removeHandler(channel);
  }
  // on 通道仅由本函数注册，移除全部监听器是安全的
  for (const channel of ON_CHANNELS) {
    ipcMain.removeAllListeners(channel);
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
