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
import { isValidContent, isValidId, isValidRelationType, isValidSearchQuery } from './inputValidation.js';
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
      // 校验 source 参数：非空时必须通过 isValidId（与 MEMORIES_SHOW/DELETE 一致，500 字符上限）
      if (query?.source !== undefined && !isValidId(query.source)) {
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

  /** 删除记忆（软删除，移入回收站） */
  ipcMain.handle(IPC_CHANNELS.MEMORIES_DELETE, async (_event, id: string) =>
    safeHandle('删除记忆失败', { deleted: false }, () => {
      // FOUNDATION-SEAL Phase 3：校验记忆 ID 类型和长度，防止非字符串或超长值传入内核
      if (!isValidId(id)) {
        return { deleted: false };
      }
      return { deleted: ctx.sprite.deleteMemory(id) };
    }),
  );

  /** 恢复软删除记忆（从回收站恢复） */
  ipcMain.handle(IPC_CHANNELS.MEMORIES_RESTORE, async (_event, id: string) =>
    safeHandle('恢复记忆失败', { restored: false }, () => {
      if (!isValidId(id)) {
        return { restored: false };
      }
      // P3-2：返回 id 供渲染层定位恢复的记忆
      return { restored: ctx.sprite.restoreMemory(id), id };
    }),
  );

  /** 物理删除记忆（回收站彻底删除） */
  ipcMain.handle(IPC_CHANNELS.MEMORIES_PURGE, async (_event, id: string) =>
    safeHandle('彻底删除记忆失败', { purged: false }, () => {
      if (!isValidId(id)) {
        return { purged: false };
      }
      return { purged: ctx.sprite.purgeMemory(id) };
    }),
  );

  /** 列出回收站记忆 */
  ipcMain.handle(IPC_CHANNELS.MEMORIES_LIST_DELETED, async () =>
    safeHandle('列出回收站记忆失败', { memories: [] }, () => {
      return { memories: ctx.sprite.listDeletedMemories() };
    }),
  );

  /** 添加记忆 */
  ipcMain.handle(IPC_CHANNELS.MEMORIES_ADD, async (_event, data: { source: string; name: string; content: string }) =>
    safeHandle('添加记忆失败', { id: '' }, () => {
      // 输入验证：拒绝超大内容，防止内存耗尽
      if (!isValidContent(data.content)) {
        return { id: '' };
      }
      // source/name 校验（与 MEMORIES_SHOW/DELETE 的 isValidId 风格一致）
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

  /** 批量归档当前会话（一键归档） */
  ipcMain.handle(
    IPC_CHANNELS.ARCHIVE_SESSION,
    async (_event, params: { date: string; session: string }) =>
      safeHandle('归档会话失败', { archivedCount: 0 }, async () => {
        // 校验日期和会话名
        if (typeof params.date !== 'string' || typeof params.session !== 'string') {
          return { archivedCount: 0 };
        }
        const result = await ctx.agent.archiveSessionContent(params.date, params.session);
        return { archivedCount: result.archivedCount };
      }),
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
      // 参数校验：sourceId/targetId 必须 isValidId，type 必须 isValidRelationType（ADR-014 白名单）
      if (!isValidId(data?.sourceId) || !isValidId(data?.targetId) || !isValidRelationType(data?.type)) {
        return { success: false };
      }
      ctx.sprite.addRelation(data.sourceId, data.targetId, data.type, data.weight);
      return { success: true };
    }),
  );

  /** 删除记忆关系（关系图交互） */
  ipcMain.handle(IPC_CHANNELS.MEMORIES_REMOVE_RELATION, async (_event, data: { sourceId: string; targetId: string; type: string }) =>
    safeHandle('删除记忆关系失败', { success: false }, () => {
      if (!isValidId(data?.sourceId) || !isValidId(data?.targetId) || !isValidRelationType(data?.type)) {
        return { success: false };
      }
      ctx.sprite.removeRelation(data.sourceId, data.targetId, data.type);
      return { success: true };
    }),
  );

  /** 更新记忆关系（关系图交互） */
  ipcMain.handle(IPC_CHANNELS.MEMORIES_UPDATE_RELATION, async (_event, data: { sourceId: string; targetId: string; type: string; weight: number }) =>
    safeHandle('更新记忆关系失败', { success: false }, () => {
      if (!isValidId(data?.sourceId) || !isValidId(data?.targetId) || !isValidRelationType(data?.type)) {
        return { success: false };
      }
      ctx.sprite.updateRelation(data.sourceId, data.targetId, data.type, data.weight);
      return { success: true };
    }),
  );

  /**
   * 手动归档 profile facts（缺口 J：archiveMode='manual' 模式下供 UI 调用）
   *
   * 从用户输入中提取个人偏好事实并归档。返回归档的条目数（精简后传输，避免大 payload）。
   */
  ipcMain.handle(IPC_CHANNELS.MEMORIES_ARCHIVE_PROFILE, async (_event, data: { input: string }) =>
    safeHandle('归档个人偏好失败', { count: 0 }, async () => {
      // 参数校验：input 必须通过 isValidContent（与 MEMORIES_ADD 一致，拒绝空/超大内容）
      if (!isValidContent(data?.input)) {
        return { count: 0 };
      }
      const entries = await ctx.sprite.archiveProfileFacts(data.input);
      return { count: entries.length };
    }),
  );

  /**
   * 手动归档 insight（缺口 J：archiveMode='manual' 模式下供 UI 调用）
   *
   * 从对话中提取洞察并归档为记忆。内部走 classify 判断，无价值输入返回 count=0。
   */
  ipcMain.handle(IPC_CHANNELS.MEMORIES_ARCHIVE_INSIGHT, async (_event, data: { input: string; assistantContent: string }) =>
    safeHandle('归档洞察失败', { count: 0 }, async () => {
      // 参数校验：input/assistantContent 必须通过 isValidContent
      if (!isValidContent(data?.input) || !isValidContent(data?.assistantContent)) {
        return { count: 0 };
      }
      const memories = await ctx.sprite.archiveInsight(data.input, data.assistantContent);
      return { count: memories.length };
    }),
  );
}
