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
  // 强制释放对话锁（reinitAgent 时需清理，避免重复注册抛错）
  IPC_CHANNELS.CHAT_FORCE_RELEASE_LOCK,
  IPC_CHANNELS.SESSION_LOAD,
  IPC_CHANNELS.SESSION_LIST,
  // 会话搜索（reinitAgent 时需清理，避免重复注册抛错）
  IPC_CHANNELS.SESSION_SEARCH,
  // 遗漏这三个通道会导致 reinitAgent 时 ipcMain.handle 重复注册抛错
  IPC_CHANNELS.SESSION_SWITCH,
  IPC_CHANNELS.SESSION_DELETE,
  IPC_CHANNELS.SESSION_RENAME,
  // 会话分叉（reinitAgent 时需清理，避免重复注册抛错）
  IPC_CHANNELS.SESSION_FORK,
  IPC_CHANNELS.MEMORIES_LIST,
  IPC_CHANNELS.MEMORIES_SEARCH,
  IPC_CHANNELS.MEMORIES_SHOW,
  IPC_CHANNELS.MEMORIES_DELETE,
  // 回收站通道（reinitAgent 时需清理，避免重复注册抛错）
  IPC_CHANNELS.MEMORIES_RESTORE,
  IPC_CHANNELS.MEMORIES_PURGE,
  // 批量回收站操作（reinitAgent 时需清理，避免重复注册抛错）
  IPC_CHANNELS.MEMORIES_RESTORE_ALL,
  IPC_CHANNELS.MEMORIES_PURGE_ALL,
  IPC_CHANNELS.MEMORIES_LIST_DELETED,
  IPC_CHANNELS.MEMORIES_ADD,
  IPC_CHANNELS.MEMORIES_RELATION_GRAPH,
  IPC_CHANNELS.MEMORIES_HEALTH_DASHBOARD,
  IPC_CHANNELS.MEMORIES_REVIEW_DATA,
  IPC_CHANNELS.MEMORIES_DELETE_BATCH,
  // 关系编辑（Phase 4：关系图可交互化）
  IPC_CHANNELS.MEMORIES_ADD_RELATION,
  IPC_CHANNELS.MEMORIES_REMOVE_RELATION,
  IPC_CHANNELS.MEMORIES_UPDATE_RELATION,
  // Phase 5.1/5.2：路径追溯 + 邻居查询（reinitAgent 时需清理，避免重复注册抛错）
  IPC_CHANNELS.MEMORIES_RELATION_PATH,
  IPC_CHANNELS.MEMORIES_RELATION_NEIGHBORS,
  // manual 模式手动归档（reinitAgent 时需清理，避免重复注册抛错）
  IPC_CHANNELS.MEMORIES_ARCHIVE_PROFILE,
  IPC_CHANNELS.MEMORIES_ARCHIVE_INSIGHT,
  // L2 采纳反哺内核（reinitAgent 时需清理，避免重复注册抛错）
  IPC_CHANNELS.MEMORIES_BOOST,
  // 会话归档（reinitAgent 时需清理，避免重复注册抛错）
  IPC_CHANNELS.ARCHIVE_SESSION,
  IPC_CHANNELS.CONFIG_GET,
  IPC_CHANNELS.CONFIG_UPDATE,
  // 批量配置通道也需在 reinitAgent 时清理，避免重复注册抛错
  IPC_CHANNELS.CONFIG_UPDATE_BATCH,
  IPC_CHANNELS.PERSONA_LIST,
  IPC_CHANNELS.PERSONA_SWITCH,
  IPC_CHANNELS.PERSONA_MODE,
  IPC_CHANNELS.PERSONA_MODE_GET,
  IPC_CHANNELS.PROJECTS_LIST,
  IPC_CHANNELS.DASHBOARD_GET,
  IPC_CHANNELS.PERCEPTION_GET,
  IPC_CHANNELS.STARTUP_SUMMARY_GET,
  // 配置建议（接受/拒绝）
  IPC_CHANNELS.SUGGESTION_ACCEPT,
  IPC_CHANNELS.SUGGESTION_REJECT,
  // 用户画像管理
  IPC_CHANNELS.USER_PROFILE_LIST,
  IPC_CHANNELS.USER_PROFILE_CONFIRM,
  IPC_CHANNELS.USER_PROFILE_REJECT,
  // 作品投影查看
  IPC_CHANNELS.WORK_PROJECTION_LIST,
  IPC_CHANNELS.WORK_PROJECTION_SHOW,
  // 使用统计导出（AUDIT-5-3，reinitAgent 时需清理）
  IPC_CHANNELS.USAGE_STATS_EXPORT,
  // 使用统计清除（AUDIT-5-4，reinitAgent 时需清理）
  IPC_CHANNELS.USAGE_STATS_CLEAR,
] as const;

/**
 * 所有通过 ipcMain.on 监听的通道
 */
const ON_CHANNELS = [
  IPC_CHANNELS.USER_INPUT,
  IPC_CHANNELS.PROACTIVE_PROMPT_SHOWN,
  IPC_CHANNELS.PROACTIVE_ACCEPT,
  IPC_CHANNELS.PROACTIVE_REJECT,
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
