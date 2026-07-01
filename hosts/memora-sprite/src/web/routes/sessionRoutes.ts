/**
 * 会话管理 HTTP 路由（DWM-01：双模式 Web 调试）
 *
 * 与 electron/ipc/sessionHandlers.ts 镜像，复用 sprite 核心层。
 *
 * 路由表：
 *   GET    /api/sessions           → 列出所有会话
 *   GET    /api/sessages/messages  → 加载会话消息（支持分页）
 *   POST   /api/sessions/switch    → 切换到已有会话
 *   DELETE /api/sessions/:id       → 删除会话
 *   PUT    /api/sessions/:id/rename → 重命名会话
 *
 * 注意：Web 模式不支持新建会话（SESSION_NEW），
 * 新对话自动写入当天 main 会话，与 Electron 模式一致。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HostContext } from '../../shared/hostContext.js';
import { parseJsonBody, sendJson, sendError, safeRoute, ensureAgentReady } from './types.js';
import { getLocalDate } from '../../sprite/constants.js';

/**
 * 校验会话名合法性（与 IPC 层 isValidSessionName 对齐）
 *
 * 拒绝含路径分隔符的会话名，防止路径遍历攻击。
 *
 * @param session 会话名
 * @returns true 表示合法
 */
function isValidSessionName(session: string): boolean {
  if (typeof session !== 'string' || session.length === 0 || session.length > 100) {
    return false;
  }
  // 拒绝路径分隔符和危险字符
  if (/[\/\\:\*\?"<>\|]/.test(session)) {
    return false;
  }
  return true;
}

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
      const limit = queryParams.get('limit') ? Number(queryParams.get('limit')) : 50;
      const offset = queryParams.get('offset') ? Number(queryParams.get('offset')) : 0;

      let target: string;
      if (date && session) {
        target = `${date}-${session}`;
      } else {
        // 无查询参数时：优先加载最近有消息的会话
        const today = getLocalDate();
        const allSessions = ctx.sessionStore.listSessions();
        const todayMain = `${today}-main`;
        if (allSessions.includes(todayMain) && ctx.sessionStore.countMessages(today, 'main') > 0) {
          target = todayMain;
        } else if (allSessions.length > 0) {
          target = allSessions[allSessions.length - 1] ?? todayMain;
        } else {
          target = todayMain;
        }
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
        await ctx.agent.sessionManager.restoreSession(body.date, body.session);
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
    if (method === 'PUT' && path.includes('/rename')) {
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

    // 未匹配的路由
    sendError(res, 404, `未找到会话路由: ${method} ${path}`);
  });
}
