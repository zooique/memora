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
    safeHandle('列出记忆失败', { memories: [] }, () => {
      // 校验 source 参数类型和长度
      if (query?.source !== undefined && (typeof query.source !== 'string' || query.source.length > 200)) {
        return { memories: [] };
      }
      return { memories: ctx.sprite.listMemories(query?.source) };
    }),
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
      // SEC-P1-001：source/name 校验（与 MEMORIES_SHOW/DELETE 的 isValidId 风格一致）
      // 防止恶意渲染进程传入空字符串/超长字符串/非字符串导致内核异常
      if (!isValidId(data.source) || !isValidId(data.name)) {
        return { id: '' };
      }
      return { id: ctx.sprite.upsertMemory(data.source, data.name, data.content) };
    }),
  );

  /** 获取记忆关系图谱（ADR-014：拓扑可视化） */
  ipcMain.handle(IPC_CHANNELS.MEMORIES_RELATION_GRAPH, async () =>
    safeHandle('获取关系图谱失败', { nodes: [], edges: [] }, () => ctx.sprite.getRelationGraph()),
  );

  /** 获取记忆健康度仪表盘数据（Phase 1：健康度诊断） */
  ipcMain.handle(IPC_CHANNELS.MEMORIES_HEALTH_DASHBOARD, async () =>
    safeHandle('获取健康度仪表盘失败', { scores: { overall: 100, uniqueness: 100, freshness: 100, completeness: 100 }, duplicates: [], staleMemories: [], lowQualityCount: 0, totalMemories: 0, healthLabel: 'excellent', healthDescription: '暂无数据' }, () => ctx.sprite.getHealthDashboard()),
  );

  /** 获取对话回顾数据（Phase 2：对话回顾与摘要） */
  ipcMain.handle(IPC_CHANNELS.MEMORIES_REVIEW_DATA, async () =>
    safeHandle('获取回顾数据失败', { today: { date: '', messageCount: 0, newMemories: 0, newInsights: 0 }, trend: { last7Days: 0, last30Days: 0, daily: [], direction: 'stable', description: '暂无趋势数据' }, insights: { total: 0, recent: [], bySource: {} }, totalMemories: 0, generatedAt: '' }, () => ctx.sprite.getReviewData()),
  );

  /** 批量删除记忆（Phase 3：智能清理） */
  ipcMain.handle(IPC_CHANNELS.MEMORIES_DELETE_BATCH, async (_event, ids: string[]) =>
    safeHandle('批量删除记忆失败', { deleted: 0, total: ids.length }, async () => {
      let deleted = 0;
      for (const id of ids) {
        // 使用 isValidId 校验（安全规则 § 参数校验，与 MEMORIES_SHOW/DELETE 保持一致）
        if (isValidId(id)) {
          const result = ctx.sprite.deleteMemory(id);
          if (result) deleted++;
        }
      }
      return { deleted, total: ids.length };
    }),
  );

  /** 添加记忆关系（手动创建，关系图交互） */
  ipcMain.handle(IPC_CHANNELS.MEMORIES_ADD_RELATION, async (_event, data: { sourceId: string; targetId: string; type: string; weight: number }) =>
    safeHandle('添加记忆关系失败', { success: false }, () => {
      ctx.sprite.addRelation(data.sourceId, data.targetId, data.type, data.weight);
      return { success: true };
    }),
  );

  /** 删除记忆关系（关系图交互） */
  ipcMain.handle(IPC_CHANNELS.MEMORIES_REMOVE_RELATION, async (_event, data: { sourceId: string; targetId: string; type: string }) =>
    safeHandle('删除记忆关系失败', { success: false }, () => {
      ctx.sprite.removeRelation(data.sourceId, data.targetId, data.type);
      return { success: true };
    }),
  );

  /** 更新记忆关系（关系图交互） */
  ipcMain.handle(IPC_CHANNELS.MEMORIES_UPDATE_RELATION, async (_event, data: { sourceId: string; targetId: string; type: string; weight: number }) =>
    safeHandle('更新记忆关系失败', { success: false }, () => {
      ctx.sprite.updateRelation(data.sourceId, data.targetId, data.type, data.weight);
      return { success: true };
    }),
  );
}
