/**
 * 会话管理 HTTP 路由
 *
 * 与 electron/ipc/sessionHandlers.ts 镜像，复用 sprite 核心层。
 *
 * 路由表：
 *   GET    /api/sessions           → 列出所有会话
 *   GET    /api/sessions/messages  → 加载会话消息（支持分页）
 *   POST   /api/sessions/switch    → 切换到已有会话
 *   DELETE /api/sessions/:id       → 删除会话
 *   PUT    /api/sessions/:id/rename → 重命名会话
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { logger } from 'memora';
import type { HostContext } from '../../shared/hostContext.js';
import { isValidSessionName } from '../../shared/inputValidation.js';
import { parseJsonBody, sendJson, sendError, safeRoute, ensureAgentReady } from './types.js';
import { getLocalDate } from '../../sprite/constants.js';

/**
 * 处理会话管理 HTTP 路由
 *
 * @param req HTTP 请求对象
 * @param res HTTP 响应对象
 * @param ctx HostContext 实例
 */
export async function handleSessionRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HostContext,
): Promise<void> {
  // Agent 未就绪时拒绝请求
  if (!ensureAgentReady(res, ctx)) return;

  const method = req.method ?? 'GET';
  const url = req.url ?? '';
  const path = url.split('?')[0] ?? url;
  const queryStr = url.split('?')[1] ?? '';
  const queryParams = new URLSearchParams(queryStr);

  await safeRoute(res, '会话操作', async () => {
    // GET /api/sessions — 列出所有会话
    if (method === 'GET' && (path === '/api/sessions' || path === '/api/sessions/')) {
      const sessions = ctx.sessionStore.listSessions();
      // 聚合每个会话的预览和消息数
      const result = sessions.map((sessionId) => {
        // sessionId 格式：YYYY-MM-DD-sessionName
        const match = sessionId.match(/^(\d{4}-\d{2}-\d{2})-(.+)$/);
        if (!match || !match[1] || !match[2]) return null;
        const date = match[1];
        const session = match[2];
        const messageCount = ctx.sessionStore.countMessages(date, session);
        // 获取最后一条消息作为预览
        const messages = ctx.sessionStore.loadMessagesPaginated(date, session, 1, messageCount > 0 ? messageCount - 1 : 0);
        const lastMessage = messages[0];
        return {
          id: sessionId,
          date,
          name: session,
          preview: lastMessage?.content?.slice(0, 50) ?? '',
          messageCount,
        };
      }).filter((s): s is NonNullable<typeof s> => s !== null);
      sendJson(res, 200, { sessions: result });
      return;
    }

    // GET /api/sessions/messages — 加载会话消息（支持分页）
    if (method === 'GET' && path === '/api/sessions/messages') {
      const date = queryParams.get('date') ?? undefined;
      const session = queryParams.get('session') ?? undefined;
      // SEC-WEB-03：分页参数严格校验，拒绝 NaN/负数/超大值，非法值回退默认值
      // - limit ∈ [1, 500]，默认 50（防止一次拉取过多消息耗尽内存）
      // - offset >= 0，默认 0（防止负数绕过分页起始位）
      // 用 parseInt 截断浮点/非数字前缀，Number.isFinite 拦截 NaN/Infinity
      const DEFAULT_LIMIT = 50;
      const DEFAULT_OFFSET = 0;
      const MAX_LIMIT = 500;
      const rawLimit = queryParams.get('limit');
      const rawOffset = queryParams.get('offset');
      const parsedLimit = rawLimit !== null ? parseInt(rawLimit, 10) : DEFAULT_LIMIT;
      const parsedOffset = rawOffset !== null ? parseInt(rawOffset, 10) : DEFAULT_OFFSET;
      const limit = Number.isFinite(parsedLimit) && parsedLimit >= 1 && parsedLimit <= MAX_LIMIT
        ? parsedLimit
        : DEFAULT_LIMIT;
      const offset = Number.isFinite(parsedOffset) && parsedOffset >= 0
        ? parsedOffset
        : DEFAULT_OFFSET;

      let target: string;
      if (date && session) {
        target = `${date}-${session}`;
      } else {
        // 无查询参数时：始终加载今天的 main 会话
        // 每天的对话独立，昨天的消息通过"加载更早的对话"按钮访问。
        const today = getLocalDate();
        target = `${today}-main`;
      }

      const match = target.match(/^(\d{4}-\d{2}-\d{2})-(.+)$/);
      if (!match || !match[1] || !match[2]) {
        sendJson(res, 200, { messages: [], loadedSessionId: '', total: 0, hasMore: false });
        return;
      }

      const targetDate = match[1];
      const targetSession = match[2];
      const total = ctx.sessionStore.countMessages(targetDate, targetSession);
      const messages = ctx.sessionStore.loadMessagesPaginated(targetDate, targetSession, limit, offset);
      sendJson(res, 200, {
        messages: messages.map((msg) => ({
          role: msg.role,
          content: msg.content,
          timestamp: msg.timestamp,
        })),
        loadedSessionId: target,
        total,
        hasMore: offset + messages.length < total,
      });
      return;
    }

    // POST /api/sessions/switch — 切换到已有会话
    if (method === 'POST' && path === '/api/sessions/switch') {
      const body = await parseJsonBody<{ date: string; session: string }>(req);
      if (!body?.date || !body?.session) {
        sendError(res, 400, 'date 和 session 必填');
        return;
      }
      if (!isValidSessionName(body.session)) {
        sendJson(res, 200, { success: false, messages: [], error: '无效的会话名' });
        return;
      }
      // 切换会话前检查是否有进行中对话
      if (ctx.getAbortController()) {
        sendJson(res, 200, { success: false, messages: [], error: '有进行中的对话，请等待完成或中断后再切换会话' });
        return;
      }

      // 更新 Agent 内部会话状态（与 IPC 一致：先 switchSession 再 restoreSession）
      if (ctx.agent.sessionManager) {
        // 1. 切换 Agent 内部会话标识（后续 chat() 写入新会话）
        ctx.agent.sessionManager.switchSession(body.session);
        // 2. 恢复目标会话历史消息到 AgentLoop 工作记忆（供 LLM 上下文使用）
        const restoredCount = await ctx.agent.sessionManager.restoreSession(body.date, body.session);
        // 3. restoreSession 仅在有消息时写入工作记忆；无消息时旧上下文残留需手动清理
        //    （与 chatStreamRoutes 跨日重置逻辑一致）
        if (restoredCount === 0 && ctx.agent.agentLoop) {
          ctx.agent.agentLoop.restoreHistory([]);
        }
      }

      // 加载切换后会话的消息（用 loadMessages 保持与 IPC 一致：全量加载供 UI 渲染）
      const messages = ctx.sessionStore.loadMessages(body.date, body.session);
      sendJson(res, 200, {
        success: true,
        messages: messages.map((msg) => ({
          role: msg.role,
          content: msg.content,
          timestamp: msg.timestamp,
        })),
      });
      return;
    }

    // DELETE /api/sessions/:id — 删除会话（如传入日期前缀则删除当天全部子会话）
    if (method === 'DELETE' && path.startsWith('/api/sessions/')) {
      const sessionId = decodeURIComponent(path.replace('/api/sessions/', ''));
      if (!sessionId) {
        sendError(res, 400, '会话 ID 必填');
        return;
      }
      // 安全校验：拒绝非法会话 ID（与 IPC isValidSessionName 对齐）
      if (!isValidSessionName(sessionId)) {
        sendJson(res, 200, { success: false, error: '无效的会话 ID' });
        return;
      }
      // 按日期前缀删除当天所有子会话（与 IPC sessionHandlers 行为一致）
      const datePrefix = sessionId.slice(0, 10); // YYYY-MM-DD
      const allSessions = ctx.sessionStore.listSessions();
      let deletedCount = 0;
      for (const s of allSessions) {
        if (s.slice(0, 10) === datePrefix) {
          // SessionStore.deleteSession 接受 sessionId 字符串（内部 parseSessionId）
          if (ctx.sessionStore.deleteSession(s)) deletedCount++;
        }
      }
      if (deletedCount === 0) {
        sendJson(res, 200, { success: false, error: '未找到该日期的会话记录' });
        return;
      }
      sendJson(res, 200, { success: true });
      return;
    }

    // PUT /api/sessions/:id/rename — 重命名会话
    // SEC-WEB-06：用 endsWith 精确匹配路径后缀，避免 includes 误匹配
    // （如 /api/sessions/rename-xxx 或 /rename/extra 都不会被命中，仅 /api/sessions/:id/rename 命中）
    if (method === 'PUT' && path.endsWith('/rename')) {
      const sessionId = decodeURIComponent(path.replace('/api/sessions/', '').replace('/rename', ''));
      const body = await parseJsonBody<{ newName: string }>(req);
      if (!body?.newName || !isValidSessionName(body.newName.trim())) {
        sendJson(res, 200, { success: false, error: '无效的会话名' });
        return;
      }
      if (!isValidSessionName(sessionId)) {
        sendJson(res, 200, { success: false, error: '无效的会话 ID' });
        return;
      }
      // SessionStore.renameSession 接受 (sessionId, newName)（内部 parseSessionId）
      const result = ctx.sessionStore.renameSession(sessionId, body.newName.trim());
      if (!result) {
        sendJson(res, 200, { success: false, error: '会话不存在或重命名失败' });
        return;
      }
      sendJson(res, 200, { success: true });
      return;
    }

    // SEC-WEB-05：不回显 path 防止用户输入注入到响应体或泄露路由细节，实际路径仅记录到服务端日志
    logger.info({ method, path }, '[Web Session] 未匹配的会话路由');
    sendError(res, 404, '404 Not Found');
  });
}
