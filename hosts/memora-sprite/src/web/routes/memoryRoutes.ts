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
 *   GET    /api/memories/health       → 获取记忆健康度仪表盘
 *   GET    /api/memories/review       → 获取对话回顾数据
 *   POST   /api/memories/batch-delete → 批量删除记忆
 *   POST   /api/memories/relation     → 添加记忆关系
 *   DELETE /api/memories/relation     → 删除记忆关系
 *   PUT    /api/memories/relation     → 更新记忆关系
 *   GET    /api/memories/trash        → 列出回收站记忆
 *   POST   /api/memories/trash/restore → 恢复回收站记忆
 *   POST   /api/memories/trash/purge  → 清空回收站过期记忆
 *   POST   /api/memories/archive      → 手动归档会话
 *   GET    /api/memories/profile      → 用户画像
 *   POST   /api/memories/fork         → 会话分叉
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HostContext } from '../../shared/hostContext.js';
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
    if (method === 'GET' && subPath.startsWith('/') && subPath.length > 1) {
      const id = subPath.slice(1); // 去除前导 /
      if (!id || id.length > 500) {
        sendJson(res, 200, { memory: null });
        return;
      }
      const memory = ctx.sprite.showMemory(id);
      sendJson(res, 200, { memory });
      return;
    }

    // DELETE /api/memories/:id — 删除记忆
    if (method === 'DELETE' && subPath.startsWith('/') && subPath.length > 1) {
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
    if (method === 'GET' && subPath === '/trash') {
      const limit = parseInt(queryParams.get('limit') ?? '50', 10);
      const items = ctx.sprite.listDeletedMemories(Math.min(limit, 200));
      sendJson(res, 200, { items });
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

    // POST /api/memories/trash/purge — 清空回收站过期记忆
    if (method === 'POST' && subPath === '/trash/purge') {
      const body = await parseJsonBody<{ retentionDays?: number }>(req);
      const retentionDays = body?.retentionDays ?? 30;
      const before = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
      const purgedCount = ctx.agent.memory?.purgeExpired(before) ?? 0;
      sendJson(res, 200, { purgedCount });
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
    if (method === 'POST' && subPath === '/fork') {
      const body = await parseJsonBody<{ session: string }>(req);
      if (!body?.session) {
        sendError(res, 400, 'session 必填');
        return;
      }
      const newSession = ctx.agent.forkSession(body.session);
      sendJson(res, 200, { session: newSession });
      return;
    }

    // 未匹配的路由
    sendError(res, 404, `未找到记忆路由: ${method} ${subPath}`);
  });
}
