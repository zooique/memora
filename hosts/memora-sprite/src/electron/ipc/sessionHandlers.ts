/**
 * 会话管理 IPC 处理器
 *
 * 职责：
 *   1. 加载历史会话消息（支持分页）
 *   2. 切换到已有会话（更新 Agent 内部状态）
 *   3. 列出所有会话（按日期聚合，含预览和消息数量）
 *   4. 删除会话
 *   5. 重命名会话
 *   6. 分叉会话（从当前会话分叉出独立分支，保留全部历史消息）
 */

import { ipcMain } from 'electron';
import { toError, logger } from 'memora';
import { errorHandler, ErrorCode } from '../errorHandler.js';
import { IPC_CHANNELS } from './channels.js';
import { getLocalDate } from '../../sprite/constants.js';
import { isValidSessionName } from './inputValidation.js';
import { requireAgent, requireSessionStore } from './types.js';
import type { IpcContext } from './types.js';

/**
 * 注册会话管理 IPC 处理器
 *
 * @param ctx IPC 上下文
 */
export function registerSessionHandlers(ctx: IpcContext): void {
  /** 加载历史会话消息 */
  ipcMain.handle(IPC_CHANNELS.SESSION_LOAD, async (_event, query: { date?: string; session?: string; limit?: number; offset?: number }) => {
    try {
      // query 对象类型校验，防止 null/undefined 或非对象传入
      if (!query || typeof query !== 'object') {
        return { messages: [], loadedSessionId: '', total: 0, hasMore: false };
      }
      // date/session 可选但必须是字符串；limit/offset 可选但必须是数字
      if (query.date !== undefined && typeof query.date !== 'string') {
        return { messages: [], loadedSessionId: '', total: 0, hasMore: false };
      }
      if (query.session !== undefined && typeof query.session !== 'string') {
        return { messages: [], loadedSessionId: '', total: 0, hasMore: false };
      }
      if (query.limit !== undefined && typeof query.limit !== 'number') {
        return { messages: [], loadedSessionId: '', total: 0, hasMore: false };
      }
      if (query.offset !== undefined && typeof query.offset !== 'number') {
        return { messages: [], loadedSessionId: '', total: 0, hasMore: false };
      }

      let target: string;
      if (query.date && query.session) {
        // 有明确查询参数时直接构造目标
        target = `${query.date}-${query.session}`;
      } else {
        // 无查询参数时：始终加载今天的 main 会话
        // 每天的对话独立，LLM 上下文从新会话开始，
        // 昨天的消息通过"加载更早的对话"按钮访问。
        const today = getLocalDate();
        target = `${today}-main`;
      }

      const match = target.match(/^(\d{4}-\d{2}-\d{2})-(.+)$/);
      if (!match || !match[1] || !match[2]) {
        return { messages: [], loadedSessionId: '', total: 0, hasMore: false };
      }

      // 分页加载：limit 和 offset 来自 query（默认 50 条）
      const pageSize = query.limit ?? 50;
      const offset = query.offset ?? 0;
      // 缓存 SessionStore：本 handler 内多次调用，统一取一次避免重复调用 getter
      const sessionStore = requireSessionStore(ctx);
      const total = sessionStore.countMessages(match[1], match[2]);
      const messages = sessionStore.loadMessagesPaginated(match[1], match[2], pageSize, offset);
      // 保留 timestamp 字段，返回 loadedSessionId 供渲染进程正确高亮当前会话
      return {
        messages: messages.map((msg) => ({ role: msg.role, content: msg.content, timestamp: msg.timestamp })),
        loadedSessionId: target,
        // 分页信息
        total,
        hasMore: offset + messages.length < total,
      };
    } catch (error) {
      errorHandler.handle(error, { code: ErrorCode.UNKNOWN, context: '加载会话历史失败' });
      return { messages: [], loadedSessionId: '', total: 0, hasMore: false };
    }
  });

  /** 切换到已有会话（更新 Agent 内部状态，避免消息持久化到错误会话） */
  ipcMain.handle(IPC_CHANNELS.SESSION_SWITCH, async (_event, query: { date: string; session: string }) => {
    try {
      // query 对象类型校验，防止 null/undefined 或非对象传入
      if (!query || typeof query !== 'object') {
        return { success: false, messages: [], error: '无效的请求参数' };
      }
      // date 字段校验：必填，必须是非空字符串
      if (typeof query.date !== 'string' || query.date.length === 0) {
        return { success: false, messages: [], error: '无效的请求参数' };
      }

      if (!ctx.isAgentReady()) {
        return { success: false, messages: [], error: 'Agent 未初始化' };
      }

      // 输入验证：拒绝含路径分隔符的会话名，防止路径遍历
      if (!isValidSessionName(query.session)) {
        return { success: false, messages: [], error: '无效的会话名' };
      }

      // 切换会话前检查是否有进行中对话，有则拒绝
      // 避免旧对话的后续消息持久化到新会话，导致会话内容串扰
      if (ctx.getAbortController()) {
        return { success: false, messages: [], error: '有进行中的对话，请等待完成或中断后再切换会话' };
      }

      // SessionManager 未初始化时拒绝切换（agent.sessionManager 在 close() 后为 null）
      const agent = requireAgent(ctx);
      if (!agent.sessionManager) {
        return { success: false, messages: [], error: 'SessionManager 未初始化' };
      }

      // 会话切换前归档当前会话内容
      // 模式判断已集中到 ArchiveCoordinator 内部（传 autoTriggered: true）：
      //   - full 模式 → 执行自动归档
      //   - insights-only / manual 模式 → ArchiveCoordinator 跳过，用户需手动调用
      // best-effort：归档失败不阻塞会话切换（LLM 不可用/消息过少等场景静默跳过）
      const currentInfo = agent.sessionManager.getCurrentSessionInfo();
      if (currentInfo && (currentInfo.date !== query.date || currentInfo.session !== query.session)) {
        // 异步归档，不阻塞切换（归档写入 memory storage，与 sessionStore 独立）
        agent.archiveSessionContent(currentInfo.date, currentInfo.session, { autoTriggered: true }).catch((err) => {
          // 归档失败仅记录日志，不影响会话切换
          logger.warn({ err: toError(err).message }, '[sessionHandlers] 会话内容归档失败');
        });
      }

      // 1. 切换 Agent 内部会话标识（更新 currentSession，后续 chat() 写入新会话）
      agent.sessionManager.switchSession(query.session);
      // 2. 恢复目标会话的历史消息到 AgentLoop 工作记忆（供 LLM 上下文使用）
      const restoredCount = await agent.sessionManager.restoreSession(query.date, query.session);
      // 3. restoreSession 仅在有消息时写入工作记忆；无消息时旧上下文残留需手动清理
      if (restoredCount === 0 && agent.agentLoop) {
        agent.agentLoop.restoreHistory([]);
      }
      // 4. 加载会话消息供 UI 渲染（保留 timestamp）
      const messages = requireSessionStore(ctx).loadMessages(query.date, query.session);
      return {
        success: true,
        messages: messages.map((msg) => ({ role: msg.role, content: msg.content, timestamp: msg.timestamp })),
      };
    } catch (error) {
      errorHandler.handle(error, { code: ErrorCode.UNKNOWN, context: '切换会话失败' });
      return { success: false, messages: [], error: toError(error).message };
    }
  });

  // 删除会话（如传入日期前缀则删除当天全部子会话）
  ipcMain.handle(IPC_CHANNELS.SESSION_DELETE, async (_event, sessionId: string) => {
    try {
      if (!ctx.isAgentReady()) {
        return { success: false, error: 'Agent 未初始化' };
      }

      // 输入验证：拒绝含路径分隔符的会话 ID
      if (!isValidSessionName(sessionId)) {
        return { success: false, error: '无效的会话 ID' };
      }

      // 按日期前缀批量删除（聚合逻辑下沉到 sessionStore.deleteSessionsByDatePrefix）
      const datePrefix = sessionId.slice(0, 10);
      const deletedCount = requireSessionStore(ctx).deleteSessionsByDatePrefix(datePrefix);

      if (deletedCount === 0) {
        return { success: false, error: '未找到该日期的会话记录' };
      }

      // Agent 状态同步：如果 Agent 的当前日期正是被删的日期，
      // 重置到当天主会话，避免 Agent 内部指向已删除数据
      const agent = requireAgent(ctx);
      const history = agent.agentHistory;
      if (history) {
        const today = getLocalDate();
        if (history.currentDateValue === datePrefix && history.currentDateValue !== today) {
          await history.loadSessionMessages(today, 'main');
          agent.agentLoop?.restoreHistory([]);
        }
      }

      return { success: true };
    } catch (error) {
      errorHandler.handle(error, { code: ErrorCode.UNKNOWN, context: '删除会话失败' });
      return { success: false, error: toError(error).message };
    }
  });

  // 重命名会话
  ipcMain.handle(IPC_CHANNELS.SESSION_RENAME, async (_event, sessionId: string, newName: string) => {
    try {
      if (!ctx.isAgentReady()) {
        return { success: false, error: 'Agent 未初始化' };
      }

      // 输入验证：拒绝含路径分隔符的会话名和新名称
      if (!isValidSessionName(sessionId) || !isValidSessionName(newName.trim())) {
        return { success: false, error: '无效的会话名' };
      }

      const renamed = requireSessionStore(ctx).renameSession(sessionId, newName.trim());
      if (!renamed) {
        return { success: false, error: '会话不存在或重命名失败' };
      }

      return { success: true };
    } catch (error) {
      errorHandler.handle(error, { code: ErrorCode.UNKNOWN, context: '重命名会话失败' });
      return { success: false, error: toError(error).message };
    }
  });

  // 搜索对话内容（跨所有会话）
  ipcMain.handle(IPC_CHANNELS.SESSION_SEARCH, async (_event, query: { keyword: string; limit?: number }) => {
    try {
      // 参数校验：query 必须是对象，keyword 必须是非空字符串
      if (!query || typeof query !== 'object') {
        return { results: [] };
      }
      if (typeof query.keyword !== 'string' || query.keyword.trim().length === 0) {
        return { results: [] };
      }
      // 关键词长度限制（防止超长字符串拖慢 LIKE 查询）
      const keyword = query.keyword.trim().slice(0, 200);
      const limit = typeof query.limit === 'number' ? Math.min(query.limit, 100) : 50;
      const rows = requireSessionStore(ctx).searchMessages(keyword, limit);
      return {
        results: rows.map((r) => ({
          date: r.date,
          session: r.session,
          role: r.role,
          content: r.content,
          timestamp: r.timestamp,
        })),
      };
    } catch (error) {
      errorHandler.handle(error, { code: ErrorCode.UNKNOWN, context: '搜索对话内容失败' });
      return { results: [] };
    }
  });

  // 会话分叉（从当前会话分叉出独立分支，保留全部历史消息）
  // 内核 Agent.forkSession() 已实现，发射 sessionForked 事件供 UI 响应
  ipcMain.handle(IPC_CHANNELS.SESSION_FORK, async (_event, targetSession?: string) => {
    try {
      if (!ctx.isAgentReady()) {
        return { success: false, error: 'Agent 未初始化' };
      }

      // 对话进行中拒绝分叉（内核 forkSession 也会检查，这里提前返回更友好的错误信息）
      if (ctx.getAbortController()) {
        return { success: false, error: '有进行中的对话，请等待完成或中断后再分叉会话' };
      }

      // 缓存 Agent 实例：本 handler 内多次调用，统一取一次避免重复调用 getter
      const agent = requireAgent(ctx);
      // 可选参数校验：若提供 targetSession，必须为合法会话名
      if (targetSession !== undefined && targetSession !== '') {
        const trimmed = targetSession.trim();
        if (!isValidSessionName(trimmed)) {
          return { success: false, error: '无效的目标会话名' };
        }
        // 调用内核 forkSession（trim 后的名称）
        const result = agent.forkSession(trimmed);
        return { success: true, newSession: result.newSession, messageCount: result.messageCount };
      }

      // 无参数时由内核自动生成分支名
      const result = agent.forkSession();
      return { success: true, newSession: result.newSession, messageCount: result.messageCount };
    } catch (error) {
      errorHandler.handle(error, { code: ErrorCode.UNKNOWN, context: '分叉会话失败' });
      return { success: false, error: toError(error).message };
    }
  });

  // 列出所有会话（按日期聚合，每日期最多一条）
  // 聚合 + 解析 + preview 逻辑下沉到 sessionStore.listSessionsGroupedByDate
  ipcMain.handle(IPC_CHANNELS.SESSION_LIST, async () => {
    try {
      const today = getLocalDate();
      const sessions = requireSessionStore(ctx).listSessionsGroupedByDate(today);
      return { sessions };
    } catch (error) {
      errorHandler.handle(error, { code: ErrorCode.UNKNOWN, context: '列出会话失败' });
      return { sessions: [] };
    }
  });
}
