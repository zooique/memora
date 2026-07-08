/**
 * 记忆 CRUD HTTP 路由
 *
 * 与 electron/ipc/memoryHandlers.ts 镜像，复用 sprite 核心层。
 *
 * 路由表：
 *   GET    /api/memories              → 列出记忆（可选 source 过滤）
 *   GET    /api/memories/search?q=xxx → 搜索记忆（关键词 + 向量召回）
 *   GET    /api/memories/:id          → 查看记忆详情
 *   DELETE /api/memories/:id          → 删除记忆
 *   POST   /api/memories              → 添加记忆
 *   GET    /api/memories/graph        → 获取记忆关系图谱
 *   GET    /api/memories/relation-path    → 获取记忆关系路径（Phase 5.1）
 *   GET    /api/memories/relation-neighbors → 获取记忆关系邻居（Phase 5.2）
 *   GET    /api/memories/health       → 获取记忆健康度仪表盘
 *   GET    /api/memories/review       → 获取对话回顾数据
 *   POST   /api/memories/batch-delete → 批量删除记忆
 *   POST   /api/memories/relation     → 添加记忆关系
 *   DELETE /api/memories/relation     → 删除记忆关系
 *   PUT    /api/memories/relation     → 更新记忆关系
 *   GET    /api/memories/trash        → 列出回收站记忆
 *   POST   /api/memories/trash/restore → 恢复回收站记忆
 *   POST   /api/memories/trash/purge  → 清空回收站过期记忆（批量清理）
 *   DELETE /api/memories/trash/:id    → 单个记忆彻底删除（不可恢复）
 *   POST   /api/memories/archive      → 手动归档会话
 *   GET    /api/memories/profile      → 用户画像
 *   POST   /api/memories/fork         → 会话分叉
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HostContext } from '../../shared/hostContext.js';
import { toError } from 'memora';
import { parseJsonBody, sendJson, sendError, safeRoute, ensureAgentReady } from './types.js';

/**
 * 处理记忆相关 HTTP 路由
 *
 * @param req HTTP 请求对象
 * @param res HTTP 响应对象
 * @param ctx HostContext 实例
 */
export async function handleMemoryRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HostContext,
): Promise<void> {
  // Agent 未就绪时拒绝请求
  if (!ensureAgentReady(res, ctx)) return;

  const method = req.method ?? 'GET';
  const url = req.url ?? '';
  const path = url.split('?')[0] ?? url;
  // 去除 /api/memories 前缀，得到剩余路径
  const subPath = path.replace('/api/memories', '') || '/';
  // 解析 query string
  const queryStr = url.split('?')[1] ?? '';
  const queryParams = new URLSearchParams(queryStr);

  await safeRoute(res, '记忆操作', async () => {
    // GET /api/memories — 列出记忆
    if (method === 'GET' && (subPath === '/' || subPath === '')) {
      const source = queryParams.get('source') ?? undefined;
      const memories = ctx.sprite.listMemories(source);
      sendJson(res, 200, { memories });
      return;
    }

    // GET /api/memories/search — 搜索记忆
    if (method === 'GET' && subPath === '/search') {
      const q = queryParams.get('q') ?? '';
      if (!q || q.length > 1000) {
        sendJson(res, 200, { hits: [] });
        return;
      }
      const hits = await ctx.sprite.searchMemories(q);
      sendJson(res, 200, { hits });
      return;
    }

    // GET /api/memories/graph — 获取记忆关系图谱
    if (method === 'GET' && subPath === '/graph') {
      const graph = ctx.sprite.getRelationGraph();
      sendJson(res, 200, graph);
      return;
    }

    // GET /api/memories/relation-path — 获取记忆关系路径（Phase 5.1：路径追溯）
    // query: memoryId（必填）、maxDepth（默认 5）、direction（默认 incoming）
    if (method === 'GET' && subPath === '/relation-path') {
      const memoryId = queryParams.get('memoryId') ?? '';
      // 参数校验：memoryId 非空且长度 ≤ 500（与 IPC handler isValidId 一致）
      if (!memoryId || memoryId.length > 500) {
        sendJson(res, 200, []);
        return;
      }
      const maxDepth = Math.min(parseInt(queryParams.get('maxDepth') ?? '5', 10) || 5, 10);
      // direction 运行时校验：非法值降级为 'incoming'（避免 as 断言绕过类型检查）
      const rawDirection = queryParams.get('direction') ?? 'incoming';
      const direction: 'incoming' | 'outgoing' | 'both' =
        rawDirection === 'outgoing' || rawDirection === 'both' ? rawDirection : 'incoming';
      const path = ctx.sprite.getRelationPath(memoryId, maxDepth, direction);
      sendJson(res, 200, path);
      return;
    }

    // GET /api/memories/relation-neighbors — 获取记忆关系邻居（Phase 5.2：邻居查询）
    // query: memoryId（必填）、limit（默认 10）
    if (method === 'GET' && subPath === '/relation-neighbors') {
      const memoryId = queryParams.get('memoryId') ?? '';
      if (!memoryId || memoryId.length > 500) {
        sendJson(res, 200, []);
        return;
      }
      const limit = Math.min(parseInt(queryParams.get('limit') ?? '10', 10) || 10, 50);
      const neighbors = ctx.sprite.getRelationNeighbors(memoryId, limit);
      sendJson(res, 200, neighbors);
      return;
    }

    // GET /api/memories/health — 获取记忆健康度仪表盘
    if (method === 'GET' && subPath === '/health') {
      const dashboard = ctx.sprite.getHealthDashboard();
      sendJson(res, 200, dashboard);
      return;
    }

    // GET /api/memories/review — 获取对话回顾数据
    if (method === 'GET' && subPath === '/review') {
      const reviewData = ctx.sprite.getReviewData();
      sendJson(res, 200, reviewData);
      return;
    }

    // POST /api/memories/batch-delete — 批量删除记忆
    if (method === 'POST' && subPath === '/batch-delete') {
      const body = await parseJsonBody<{ ids: string[] }>(req);
      if (!body?.ids || !Array.isArray(body.ids)) {
        sendError(res, 400, '请求体必须包含 ids 数组');
        return;
      }
      // 循环调用 deleteMemory（与 IPC handler 实现一致，Sprite 无 deleteMemoriesBatch 方法）
      let deleted = 0;
      for (const id of body.ids) {
        if (id && id.length <= 500) {
          if (ctx.sprite.deleteMemory(id)) deleted++;
        }
      }
      sendJson(res, 200, { deleted, total: body.ids.length });
      return;
    }

    // POST /api/memories/relation — 添加记忆关系
    if (method === 'POST' && subPath === '/relation') {
      const body = await parseJsonBody<{ sourceId: string; targetId: string; type: string; weight: number }>(req);
      if (!body?.sourceId || !body?.targetId) {
        sendError(res, 400, 'sourceId 和 targetId 必填');
        return;
      }
      ctx.sprite.addRelation(body.sourceId, body.targetId, body.type, body.weight);
      sendJson(res, 200, { success: true });
      return;
    }

    // DELETE /api/memories/relation — 删除记忆关系
    if (method === 'DELETE' && subPath === '/relation') {
      const body = await parseJsonBody<{ sourceId: string; targetId: string; type: string }>(req);
      if (!body?.sourceId || !body?.targetId) {
        sendError(res, 400, 'sourceId 和 targetId 必填');
        return;
      }
      ctx.sprite.removeRelation(body.sourceId, body.targetId, body.type);
      sendJson(res, 200, { success: true });
      return;
    }

    // PUT /api/memories/relation — 更新记忆关系
    if (method === 'PUT' && subPath === '/relation') {
      const body = await parseJsonBody<{ sourceId: string; targetId: string; type: string; weight: number }>(req);
      if (!body?.sourceId || !body?.targetId) {
        sendError(res, 400, 'sourceId 和 targetId 必填');
        return;
      }
      ctx.sprite.updateRelation(body.sourceId, body.targetId, body.type, body.weight);
      sendJson(res, 200, { success: true });
      return;
    }

    // POST /api/memories — 添加记忆
    if (method === 'POST' && (subPath === '/' || subPath === '')) {
      const body = await parseJsonBody<{ source: string; name: string; content: string }>(req);
      if (!body?.source || !body?.name || !body?.content) {
        sendError(res, 400, 'source、name、content 必填');
        return;
      }
      const id = ctx.sprite.upsertMemory(body.source, body.name, body.content);
      sendJson(res, 200, { id });
      return;
    }

    // GET /api/memories/:id — 查看记忆详情
    // 注意：必须排除 /trash、/graph、/search、/health、/review 等已知子路由
    // 否则通用 :id 会先匹配到这些路径（如 /trash 被当成 id="trash"）
    if (method === 'GET' && subPath.startsWith('/') && subPath.length > 1
        && subPath !== '/trash' && subPath !== '/graph' && subPath !== '/search'
        && subPath !== '/health' && subPath !== '/review'
        && !subPath.startsWith('/relation')) {
      const id = subPath.slice(1); // 去除前导 /
      if (!id || id.length > 500) {
        sendJson(res, 200, { memory: null });
        return;
      }
      const memory = ctx.sprite.showMemory(id);
      sendJson(res, 200, { memory });
      return;
    }

    // DELETE /api/memories/:id — 删除记忆（软删除，进入回收站）
    // 注意：必须排除 /trash/ 前缀，否则会拦截回收站彻底删除路由
    if (method === 'DELETE' && subPath.startsWith('/') && subPath.length > 1 && !subPath.startsWith('/trash/')) {
      const id = subPath.slice(1); // 去除前导 /
      if (!id || id.length > 500) {
        sendJson(res, 200, { deleted: false });
        return;
      }
      const deleted = ctx.sprite.deleteMemory(id);
      sendJson(res, 200, { deleted });
      return;
    }

    // ─── 回收站路由 ────────────────────────────────

    // GET /api/memories/trash — 列出回收站记忆
    // 返回格式与 Electron IPC MEMORIES_LIST_DELETED 一致：{ memories: [] }
    if (method === 'GET' && subPath === '/trash') {
      const limit = parseInt(queryParams.get('limit') ?? '50', 10);
      const memories = ctx.sprite.listDeletedMemories(Math.min(limit, 200));
      sendJson(res, 200, { memories });
      return;
    }

    // POST /api/memories/trash/restore — 恢复回收站记忆
    if (method === 'POST' && subPath === '/trash/restore') {
      const body = await parseJsonBody<{ id: string }>(req);
      if (!body?.id || body.id.length > 500) {
        sendError(res, 400, 'id 必填且长度不超过 500');
        return;
      }
      const restored = ctx.sprite.restoreMemory(body.id);
      sendJson(res, 200, { restored, id: body.id });
      return;
    }

    // POST /api/memories/trash/purge — 清空回收站过期记忆（批量清理）
    if (method === 'POST' && subPath === '/trash/purge') {
      const body = await parseJsonBody<{ retentionDays?: number }>(req);
      const retentionDays = body?.retentionDays ?? 30;
      const before = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
      // P1-2 拆分：purgeExpired 已迁移至 agent.memoryMutator
      const purgedCount = ctx.agent.memoryMutator?.purgeExpired(before) ?? 0;
      sendJson(res, 200, { purgedCount });
      return;
    }

    // DELETE /api/memories/trash/:id — 单个记忆彻底删除（不可恢复）
    // 与 Electron IPC MEMORIES_PURGE 镜像，渲染层调用 purgeMemory(id)
    if (method === 'DELETE' && subPath.startsWith('/trash/')) {
      const id = decodeURIComponent(subPath.slice('/trash/'.length));
      if (!id || id.length > 500) {
        sendError(res, 400, 'id 必填且长度不超过 500');
        return;
      }
      const purged = ctx.sprite.purgeMemory(id);
      sendJson(res, 200, { purged });
      return;
    }

    // ─── 手动归档会话 ──────────────────────────────

    // POST /api/memories/archive — 手动归档当前会话
    if (method === 'POST' && subPath === '/archive') {
      const body = await parseJsonBody<{ date: string; session: string }>(req);
      if (!body?.date || !body?.session) {
        sendError(res, 400, 'date 和 session 必填');
        return;
      }
      const result = await ctx.agent.archiveSessionContent(body.date, body.session);
      sendJson(res, 200, result);
      return;
    }

    // ─── 用户画像 + 会话分叉 ────────────────────────

    // GET /api/memories/profile — 获取用户画像
    if (method === 'GET' && subPath === '/profile') {
      const up = ctx.agent.userProfile;
      if (!up) {
        sendJson(res, 200, { profile: { confirmed: [], pending: [] } });
        return;
      }
      sendJson(res, 200, {
        profile: {
          confirmed: up.getConfirmed(),
          pending: up.getPending(),
        },
      });
      return;
    }

    // POST /api/memories/fork — 会话分叉
    // 返回格式与 Electron IPC SESSION_FORK 一致：{ success, newSession, messageCount }
    // 渲染层 sessionController.forkSession 依赖此格式判断成功/失败
    if (method === 'POST' && subPath === '/fork') {
      // session 可选：不传时由内核自动生成分支名
      const body = await parseJsonBody<{ session?: string }>(req);
      try {
        let result: { newSession: string; messageCount: number };
        if (body?.session && body.session.trim()) {
          result = ctx.agent.forkSession(body.session.trim());
        } else {
          result = ctx.agent.forkSession();
        }
        sendJson(res, 200, { success: true, newSession: result.newSession, messageCount: result.messageCount });
      } catch (error) {
        sendJson(res, 200, { success: false, error: toError(error).message });
      }
      return;
    }

    // 未匹配的路由
    sendError(res, 404, `未找到记忆路由: ${method} ${subPath}`);
  });
}
