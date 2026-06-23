/**
 * 记忆 CRUD IPC 处理器
 *
 * 职责：
 *   1. 列出记忆（可按 source 过滤）
 *   2. 搜索记忆（混合搜索：关键词 + 向量召回）
 *   3. 查看单条记忆详情
 *   4. 删除记忆
 *   5. 添加/更新记忆
 *
 * 所有 handler 均委托给 Sprite 的 MemoryController，通过 safeHandle 统一错误兜底。
 */

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../ipcChannels.js';
import { safeHandle } from './types.js';
import type { IpcContext } from './types.js';

/**
 * 注册记忆 CRUD IPC 处理器
 *
 * @param ctx IPC 上下文
 */
export function registerMemoryHandlers(ctx: IpcContext): void {
  /** 列出记忆（可按 source 过滤） */
  ipcMain.handle(IPC_CHANNELS.MEMORIES_LIST, async (_event, query: { source?: string }) =>
    safeHandle('列出记忆失败', { memories: [] }, () => ({ memories: ctx.sprite.listMemories(query?.source) })),
  );

  /** 搜索记忆（混合搜索：关键词 + 向量召回） */
  ipcMain.handle(IPC_CHANNELS.MEMORIES_SEARCH, async (_event, query: string) =>
    safeHandle('搜索记忆失败', { hits: [] }, async () => ({ hits: await ctx.sprite.searchMemories(query) })),
  );

  /** 查看单条记忆详情 */
  ipcMain.handle(IPC_CHANNELS.MEMORIES_SHOW, async (_event, id: string) =>
    safeHandle('查看记忆详情失败', { memory: null }, () => ({ memory: ctx.sprite.showMemory(id) })),
  );

  /** 删除记忆 */
  ipcMain.handle(IPC_CHANNELS.MEMORIES_DELETE, async (_event, id: string) =>
    safeHandle('删除记忆失败', { deleted: false }, () => ({ deleted: ctx.sprite.deleteMemory(id) })),
  );

  /** 添加记忆 */
  ipcMain.handle(IPC_CHANNELS.MEMORIES_ADD, async (_event, data: { source: string; name: string; content: string }) =>
    safeHandle('添加记忆失败', { id: '' }, () => ({ id: ctx.sprite.upsertMemory(data.source, data.name, data.content) })),
  );
}
