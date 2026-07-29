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
import { safeHandle, throwingHandle, requireSprite, requireAgent } from './types.js';
import { isValidContent, isValidId, isValidRelationParams, isValidSearchQuery } from './inputValidation.js';
import { ErrorCode, SpriteError } from '../errorHandler.js';
import type { IpcContext } from './types.js';

/**
 * 注册记忆 CRUD IPC 处理器
 *
 * @param ctx IPC 上下文
 */
export function registerMemoryHandlers(ctx: IpcContext): void {
  /** 列出记忆（可按 source 过滤） */
  ipcMain.handle(IPC_CHANNELS.MEMORIES_LIST, async (_event, query: { source?: string }) =>
    throwingHandle('列出记忆失败', () => {
      // 校验 source 参数：非空时必须通过 isValidId（与 MEMORIES_SHOW/DELETE 一致，500 字符上限）
      if (query?.source !== undefined && !isValidId(query.source)) {
        throw new SpriteError(ErrorCode.VALIDATION_ERROR, '非法 source 参数');
      }
      return { memories: requireSprite(ctx).listMemories(query?.source) };
    }),
  );

  /**
   * 列出全部 distinct 记忆 source
   *
   * 用于渲染层"来源筛选" dropdown 动态生成：替换 index.html 中硬编码的 7 项 option。
   * 仅返回 source 字符串数组，不携带记忆内容（轻量 IPC，避免大记忆库全量传输）。
   */
  ipcMain.handle(IPC_CHANNELS.MEMORIES_SOURCES, async () =>
    throwingHandle('列出记忆来源失败', () => {
      return { sources: requireSprite(ctx).listMemorySources() };
    }),
  );

  /** 搜索记忆（混合搜索：关键词 + 向量召回） */
  ipcMain.handle(IPC_CHANNELS.MEMORIES_SEARCH, async (_event, query: string) =>
    throwingHandle('搜索记忆失败', async () => {
      // 校验搜索关键词类型和长度，防止超长查询导致性能问题
      if (!isValidSearchQuery(query)) {
        throw new SpriteError(ErrorCode.VALIDATION_ERROR, '非法搜索关键词');
      }
      return { hits: await requireSprite(ctx).searchMemories(query) };
    }),
  );

  /** 查看单条记忆详情 */
  ipcMain.handle(IPC_CHANNELS.MEMORIES_SHOW, async (_event, id: string) =>
    throwingHandle('查看记忆详情失败', () => {
      // 校验记忆 ID 类型和长度，防止非字符串或超长值传入内核
      if (!isValidId(id)) {
        throw new SpriteError(ErrorCode.VALIDATION_ERROR, '非法记忆 ID');
      }
      return { memory: requireSprite(ctx).showMemory(id) };
    }),
  );

  /** 删除记忆（软删除，移入回收站） */
  ipcMain.handle(IPC_CHANNELS.MEMORIES_DELETE, async (_event, id: string) =>
    safeHandle('删除记忆失败', { deleted: false }, () => {
      // 校验记忆 ID 类型和长度，防止非字符串或超长值传入内核
      if (!isValidId(id)) {
        return { deleted: false };
      }
      return { deleted: requireSprite(ctx).deleteMemory(id) };
    }),
  );

  /** 恢复软删除记忆（从回收站恢复） */
  ipcMain.handle(IPC_CHANNELS.MEMORIES_RESTORE, async (_event, id: string) =>
    safeHandle('恢复记忆失败', { restored: false }, () => {
      if (!isValidId(id)) {
        return { restored: false };
      }
      // 返回 id 供渲染层定位恢复的记忆
      return { restored: requireSprite(ctx).restoreMemory(id), id };
    }),
  );

  /** 物理删除记忆（回收站彻底删除） */
  ipcMain.handle(IPC_CHANNELS.MEMORIES_PURGE, async (_event, id: string) =>
    safeHandle('彻底删除记忆失败', { purged: false }, async () => {
      if (!isValidId(id)) {
        return { purged: false };
      }
      // purgeMemory 为 async：vectorStore.delete 立即 save 持久化删除结果
      return { purged: await requireSprite(ctx).purgeMemory(id) };
    }),
  );

  /** 批量恢复回收站所有记忆 */
  ipcMain.handle(IPC_CHANNELS.MEMORIES_RESTORE_ALL, async () =>
    safeHandle('批量恢复记忆失败', { restored: 0, failed: 0 }, () => {
      return requireSprite(ctx).restoreAllMemories();
    }),
  );

  /** 批量清空回收站所有记忆 */
  ipcMain.handle(IPC_CHANNELS.MEMORIES_PURGE_ALL, async () =>
    safeHandle('批量清空回收站失败', { purged: 0, failed: 0 }, async () => {
      // purgeAllMemories 为 async：批量删除需等待所有 vectorStore.delete 完成
      return requireSprite(ctx).purgeAllMemories();
    }),
  );

  /** 列出回收站记忆 */
  ipcMain.handle(IPC_CHANNELS.MEMORIES_LIST_DELETED, async () =>
    throwingHandle('列出回收站记忆失败', () => {
      return { memories: requireSprite(ctx).listDeletedMemories() };
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
      return { id: requireSprite(ctx).upsertMemory(data.source, data.name, data.content) };
    }),
  );

  /** 提升记忆 score（L2 采纳反哺内核） */
  ipcMain.handle(IPC_CHANNELS.MEMORIES_BOOST, async (_event, id: string) =>
    safeHandle('提升记忆 score 失败', { success: false }, () => {
      // 校验记忆 ID 类型（与 MEMORIES_SHOW/DELETE 一致）
      if (!isValidId(id)) {
        return { success: false };
      }
      return { success: requireSprite(ctx).boostMemory(id) };
    }),
  );

  // ─── LLM 记忆治理（L1~L3，G1：异步调用，safeHandle 降级） ──
  // 这三个 handler 均为异步（调用 LLM，可能 5-15 秒），safeHandle 确保失败时返回
  // 空报告而非抛错（与内核 manager 内部 LLM 失败降级语义一致）。

  /** L1 语义去重（扫描名称相似对 → LLM 判断 → 降级低分记忆） */
  ipcMain.handle(IPC_CHANNELS.MEMORIES_DEDUP, async () =>
    safeHandle('语义去重失败', { scannedCount: 0, pairCount: 0, deduplicatedCount: 0, demotedIds: [], skippedReason: 'IPC 失败' }, () =>
      requireSprite(ctx).deduplicateMemories(),
    ),
  );

  /** L2 时效性评估（扫描低分记忆 → LLM 判断 → 降级过时记忆） */
  ipcMain.handle(IPC_CHANNELS.MEMORIES_EVALUATE_TIMELINESS, async () =>
    safeHandle('时效性评估失败', { scannedCount: 0, outdatedCount: 0, demotedIds: [], skippedReason: 'IPC 失败' }, () =>
      requireSprite(ctx).evaluateTimeliness(),
    ),
  );

  /** L3 冲突检测（同 source 配对 → LLM 判断 → 仅检测不修复） */
  ipcMain.handle(IPC_CHANNELS.MEMORIES_DETECT_CONFLICTS, async () =>
    safeHandle('冲突检测失败', { scannedCount: 0, pairCount: 0, conflictCount: 0, conflicts: [], skippedReason: 'IPC 失败' }, () =>
      requireSprite(ctx).detectConflicts(),
    ),
  );

  /** 获取记忆关系图谱（ADR-014：拓扑可视化） */
  ipcMain.handle(IPC_CHANNELS.MEMORIES_RELATION_GRAPH, async () =>
    throwingHandle('获取关系图谱失败', () => requireSprite(ctx).getRelationGraph()),
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
        const result = await requireAgent(ctx).archiveSessionContent(params.date, params.session);
        return { archivedCount: result.memories.length };
      }),
  );

  /** 获取记忆健康度仪表盘数据（Phase 1：健康度诊断） */
  ipcMain.handle(IPC_CHANNELS.MEMORIES_HEALTH_DASHBOARD, async () =>
    throwingHandle('获取健康度仪表盘失败', () => requireSprite(ctx).getHealthDashboard()),
  );

  /** 获取对话回顾数据（Phase 2：对话回顾与摘要） */
  ipcMain.handle(IPC_CHANNELS.MEMORIES_REVIEW_DATA, async () =>
    throwingHandle('获取回顾数据失败', () => requireSprite(ctx).getReviewData()),
  );

  /** 批量删除记忆（智能清理） */
  ipcMain.handle(IPC_CHANNELS.MEMORIES_DELETE_BATCH, async (_event, ids: string[]) =>
    safeHandle('批量删除记忆失败', { deleted: 0, total: ids.length }, async () =>
      requireSprite(ctx).deleteMemoriesBatch(ids),
    ),
  );

  /**
   * 记忆关系变更（IPC-COUNT-02 候选 1：合并 ADD/REMOVE/UPDATE 三通道为统一 mutation 入口）
   *
   * payload.action 区分三类操作，三者参数结构完全同构（sourceId/targetId/type/weight?）：
   *   - 'add'    → sprite.addRelation(sourceId, targetId, type, weight)（weight 必填）
   *   - 'remove' → sprite.removeRelation(sourceId, targetId, type)（weight 忽略）
   *   - 'update' → sprite.updateRelation(sourceId, targetId, type, weight)（weight 必填）
   *
   * 校验链：isValidRelationParams（sourceId/targetId/type 三元组）+ add/update 时 weight 必填且为 number。
   * 返回值统一 { success: boolean }，与原三通道完全等价。
   *
   * 渲染层调用 sugar API（addRelation/removeRelation/updateRelation），preload 内部委托本通道。
   */
  ipcMain.handle(
    IPC_CHANNELS.MEMORIES_RELATION_MUTATE,
    async (_event, data: { action: 'add' | 'remove' | 'update'; sourceId: string; targetId: string; type: string; weight?: number }) =>
      safeHandle('记忆关系变更失败', { success: false }, () => {
        // action 白名单校验（防止恶意渲染进程传入任意字符串触发意外分支）
        if (data?.action !== 'add' && data?.action !== 'remove' && data?.action !== 'update') {
          return { success: false };
        }
        // sourceId/targetId/type 三元组统一校验（ADR-014 关系类型白名单）
        if (!isValidRelationParams(data)) {
          return { success: false };
        }
        // add/update 必须提供 weight（number 类型校验，防止 undefined/字符串传入内核）
        if (data.action === 'add' || data.action === 'update') {
          if (typeof data.weight !== 'number' || !Number.isFinite(data.weight)) {
            return { success: false };
          }
        }
        const sprite = requireSprite(ctx);
        if (data.action === 'add') {
          sprite.addRelation(data.sourceId, data.targetId, data.type, data.weight!);
        } else if (data.action === 'remove') {
          sprite.removeRelation(data.sourceId, data.targetId, data.type);
        } else {
          sprite.updateRelation(data.sourceId, data.targetId, data.type, data.weight!);
        }
        return { success: true };
      }),
  );

  /** 获取记忆关系路径（Phase 5.1：路径追溯，用于展示记忆演化脉络） */
  ipcMain.handle(IPC_CHANNELS.MEMORIES_RELATION_PATH, async (_event, data: { memoryId: string; maxDepth?: number; direction?: 'incoming' | 'outgoing' | 'both' }) =>
    throwingHandle('获取关系路径失败', () => {
      // 参数校验：memoryId 必须 isValidId
      if (!isValidId(data?.memoryId)) {
        throw new SpriteError(ErrorCode.VALIDATION_ERROR, '非法记忆 ID');
      }
      return requireSprite(ctx).getRelationPath(data.memoryId, data.maxDepth ?? 5, data.direction ?? 'incoming');
    }),
  );

  /** 获取记忆关系邻居（Phase 5.2：邻居查询，用于展示直接关联记忆） */
  ipcMain.handle(IPC_CHANNELS.MEMORIES_RELATION_NEIGHBORS, async (_event, data: { memoryId: string; limit?: number }) =>
    throwingHandle('获取关系邻居失败', () => {
      if (!isValidId(data?.memoryId)) {
        throw new SpriteError(ErrorCode.VALIDATION_ERROR, '非法记忆 ID');
      }
      return requireSprite(ctx).getRelationNeighbors(data.memoryId, data.limit ?? 10);
    }),
  );

  /**
   * 手动归档 profile facts（archiveMode='manual' 模式下供 UI 调用）
   *
   * 从用户输入中提取个人偏好事实并归档。返回归档的条目数（精简后传输，避免大 payload）。
   */
  ipcMain.handle(IPC_CHANNELS.MEMORIES_ARCHIVE_PROFILE, async (_event, data: { input: string }) =>
    safeHandle('归档个人偏好失败', { count: 0 }, async () => {
      // 参数校验：input 必须通过 isValidContent（与 MEMORIES_ADD 一致，拒绝空/超大内容）
      if (!isValidContent(data?.input)) {
        return { count: 0 };
      }
      const entries = await requireSprite(ctx).archiveProfileFacts(data.input);
      return { count: entries.length };
    }),
  );

  /**
   * 手动归档 insight（archiveMode='manual' 模式下供 UI 调用）
   *
   * 从对话中提取洞察并归档为记忆。内部走 classify 判断，无价值输入返回 count=0。
   */
  ipcMain.handle(IPC_CHANNELS.MEMORIES_ARCHIVE_INSIGHT, async (_event, data: { input: string; assistantContent: string }) =>
    safeHandle('归档洞察失败', { count: 0 }, async () => {
      // 参数校验：input/assistantContent 必须通过 isValidContent
      if (!isValidContent(data?.input) || !isValidContent(data?.assistantContent)) {
        return { count: 0 };
      }
      const memories = await requireSprite(ctx).archiveInsight(data.input, data.assistantContent);
      return { count: memories.length };
    }),
  );
}
