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
import { IPC_CHANNELS } from './channels.js';
import { safeHandle } from './types.js';
import { isValidContent, isValidId, isValidSearchQuery } from './inputValidation.js';
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
    safeHandle('搜索记忆失败', { hits: [] }, async () => {
      // FOUNDATION-SEAL Phase 3：校验搜索关键词类型和长度，防止超长查询导致性能问题
      if (!isValidSearchQuery(query)) {
        return { hits: [] };
      }
      return { hits: await ctx.sprite.searchMemories(query) };
    }),
  );

  /** 查看单条记忆详情 */
  ipcMain.handle(IPC_CHANNELS.MEMORIES_SHOW, async (_event, id: string) =>
    safeHandle('查看记忆详情失败', { memory: null }, () => {
      // FOUNDATION-SEAL Phase 3：校验记忆 ID 类型和长度，防止非字符串或超长值传入内核
      if (!isValidId(id)) {
        return { memory: null };
      }
      return { memory: ctx.sprite.showMemory(id) };
    }),
  );

  /** 删除记忆 */
  ipcMain.handle(IPC_CHANNELS.MEMORIES_DELETE, async (_event, id: string) =>
    safeHandle('删除记忆失败', { deleted: false }, () => {
      // FOUNDATION-SEAL Phase 3：校验记忆 ID 类型和长度，防止非字符串或超长值传入内核
      if (!isValidId(id)) {
        return { deleted: false };
      }
      return { deleted: ctx.sprite.deleteMemory(id) };
    }),
  );

  /** 添加记忆 */
  ipcMain.handle(IPC_CHANNELS.MEMORIES_ADD, async (_event, data: { source: string; name: string; content: string }) =>
    safeHandle('添加记忆失败', { id: '' }, () => {
      // P1-SEC-01 输入验证：拒绝超大内容，防止内存耗尽
      if (!isValidContent(data.content)) {
        return { id: '' };
      }
      return { id: ctx.sprite.upsertMemory(data.source, data.name, data.content) };
    }),
  );

  /** 获取记忆关系图谱（ADR-014：拓扑可视化） */
  ipcMain.handle(IPC_CHANNELS.MEMORIES_RELATION_GRAPH, async () =>
    safeHandle('获取关系图谱失败', { nodes: [], edges: [] }, () => ctx.sprite.getRelationGraph()),
  );
}
