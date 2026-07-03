/**
 * 会话管理 IPC 处理器
 *
 * 职责：
 *   1. 加载历史会话消息（支持分页）
 *   2. 切换到已有会话（更新 Agent 内部状态）
 *   3. 列出所有会话（按日期聚合，含预览和消息数量）
 *   4. 删除会话
 *   5. 重命名会话
 */

import { ipcMain } from 'electron';
import { toError } from 'memora';
import { errorHandler, ErrorCode } from '../errorHandler.js';
import { IPC_CHANNELS } from './channels.js';
import { getLocalDate } from '../../sprite/constants.js';
import { isValidSessionName } from './inputValidation.js';
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
      // FOUNDATION-SEAL Phase 3 轮3：query 对象类型校验，防止 null/undefined 或非对象传入
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
        // UX-PP-08 有明确查询参数时直接构造目标
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

      // UX-FD-07 分页加载：limit 和 offset 来自 query（默认 50 条）
      const pageSize = query.limit ?? 50;
      const offset = query.offset ?? 0;
      const total = ctx.sessionStore.countMessages(match[1], match[2]);
      const messages = ctx.sessionStore.loadMessagesPaginated(match[1], match[2], pageSize, offset);
      // UX-P2-06 保留 timestamp 字段，UX-P2-07 返回 loadedSessionId 供渲染进程正确高亮当前会话
      return {
        messages: messages.map((msg) => ({ role: msg.role, content: msg.content, timestamp: msg.timestamp })),
        loadedSessionId: target,
        // UX-FD-07 分页信息
        total,
        hasMore: offset + messages.length < total,
      };
    } catch (error) {
      errorHandler.handle(error, { code: ErrorCode.UNKNOWN, context: '加载会话历史失败' });
      return { messages: [], loadedSessionId: '', total: 0, hasMore: false };
    }
  });

  /** UX-P1-04 切换到已有会话（更新 Agent 内部状态，避免消息持久化到错误会话） */
  ipcMain.handle(IPC_CHANNELS.SESSION_SWITCH, async (_event, query: { date: string; session: string }) => {
    try {
      // FOUNDATION-SEAL Phase 3 轮3：query 对象类型校验，防止 null/undefined 或非对象传入
      if (!query || typeof query !== 'object') {
        return { success: false, messages: [], error: '无效的请求参数' };
      }
      // date 字段校验：必填，必须是非空字符串
      if (typeof query.date !== 'string' || query.date.length === 0) {
        return { success: false, messages: [], error: '无效的请求参数' };
      }

      if (!ctx.agent) {
        return { success: false, messages: [], error: 'Agent 未初始化' };
      }

      // P1-SEC-01 输入验证：拒绝含路径分隔符的会话名，防止路径遍历
      if (!isValidSessionName(query.session)) {
        return { success: false, messages: [], error: '无效的会话名' };
      }

      // 切换会话前检查是否有进行中对话，有则拒绝
      // 避免旧对话的后续消息持久化到新会话，导致会话内容串扰
      if (ctx.getAbortController()) {
        return { success: false, messages: [], error: '有进行中的对话，请等待完成或中断后再切换会话' };
      }

      // 添加 sessionManager null 检查
      if (!ctx.agent.sessionManager) {
        return { success: false, messages: [], error: 'SessionManager 未初始化' };
      }

      // GAP-2：会话切换前归档当前会话内容（仅 full 模式自动触发）
      // insights-only / manual 模式下用户需通过 UI 手动调用 archiveSessionContent
      // best-effort：归档失败不阻塞会话切换（LLM 不可用/消息过少等场景静默跳过）
      if (ctx.agent.getArchiveMode() === 'full') {
        const currentInfo = ctx.agent.sessionManager.getCurrentSessionInfo();
        if (currentInfo && (currentInfo.date !== query.date || currentInfo.session !== query.session)) {
          // 异步归档，不阻塞切换（归档写入 memory storage，与 sessionStore 独立）
          ctx.agent.archiveSessionContent(currentInfo.date, currentInfo.session).catch((err) => {
            // 归档失败仅记录日志，不影响会话切换
            console.warn('[sessionHandlers] 会话内容归档失败:', err);
          });
        }
      }

      // 1. 切换 Agent 内部会话标识（更新 currentSession，后续 chat() 写入新会话）
      ctx.agent.sessionManager.switchSession(query.session);
      // 2. 恢复目标会话的历史消息到 AgentLoop 工作记忆（供 LLM 上下文使用）
      const restoredCount = await ctx.agent.sessionManager.restoreSession(query.date, query.session);
      // 3. restoreSession 仅在有消息时写入工作记忆；无消息时旧上下文残留需手动清理
      if (restoredCount === 0 && ctx.agent.agentLoop) {
        ctx.agent.agentLoop.restoreHistory([]);
      }
      // 4. 加载会话消息供 UI 渲染（保留 timestamp）
      const messages = ctx.sessionStore.loadMessages(query.date, query.session);
      return {
        success: true,
        messages: messages.map((msg) => ({ role: msg.role, content: msg.content, timestamp: msg.timestamp })),
      };
    } catch (error) {
      errorHandler.handle(error, { code: ErrorCode.UNKNOWN, context: '切换会话失败' });
      return { success: false, messages: [], error: toError(error).message };
    }
  });

  // FD-09 删除会话（如传入日期前缀则删除当天全部子会话）
  ipcMain.handle(IPC_CHANNELS.SESSION_DELETE, async (_event, sessionId: string) => {
    try {
      if (!ctx.agent) {
        return { success: false, error: 'Agent 未初始化' };
      }

      // P1-SEC-01 输入验证：拒绝含路径分隔符的会话 ID
      if (!isValidSessionName(sessionId)) {
        return { success: false, error: '无效的会话 ID' };
      }

      // 按天聚合后删除某天时，删除当天所有子会话（含 main 和遗留的 session-xxx）
      const datePrefix = sessionId.slice(0, 10); // YYYY-MM-DD
      const allSessions = ctx.sessionStore.listSessions();
      let deletedCount = 0;
      for (const s of allSessions) {
        if (s.slice(0, 10) === datePrefix) {
          if (ctx.sessionStore.deleteSession(s)) {
            deletedCount++;
          }
        }
      }

      if (deletedCount === 0) {
        return { success: false, error: '未找到该日期的会话记录' };
      }

      // UT-FQ-02 删除后 Agent 状态同步：如果 Agent 的当前日期正是被删的日期，
      // 重置到当天主会话，避免 Agent 内部 currentDate / loop.messages[] 指向已删除数据
      const history = ctx.agent?.agentHistory;
      if (history) {
        const today = getLocalDate();
        if (history.currentDateValue === datePrefix && history.currentDateValue !== today) {
          await history.loadSessionMessages(today, 'main');
          ctx.agent.agentLoop?.restoreHistory([]);
        }
      }

      return { success: true };
    } catch (error) {
      errorHandler.handle(error, { code: ErrorCode.UNKNOWN, context: '删除会话失败' });
      return { success: false, error: toError(error).message };
    }
  });

  // FD-09 重命名会话
  ipcMain.handle(IPC_CHANNELS.SESSION_RENAME, async (_event, sessionId: string, newName: string) => {
    try {
      if (!ctx.agent) {
        return { success: false, error: 'Agent 未初始化' };
      }

      // P1-SEC-01 输入验证：拒绝含路径分隔符的会话名和新名称
      if (!isValidSessionName(sessionId) || !isValidSessionName(newName.trim())) {
        return { success: false, error: '无效的会话名' };
      }

      const renamed = ctx.sessionStore.renameSession(sessionId, newName.trim());
      if (!renamed) {
        return { success: false, error: '会话不存在或重命名失败' };
      }

      return { success: true };
    } catch (error) {
      errorHandler.handle(error, { code: ErrorCode.UNKNOWN, context: '重命名会话失败' });
      return { success: false, error: toError(error).message };
    }
  });

  // FD-A1 列出所有会话（按日期聚合，每日期最多一条）
  ipcMain.handle(IPC_CHANNELS.SESSION_LIST, async () => {
    try {
      const sessions = ctx.sessionStore.listSessions(); // 返回 ['YYYY-MM-DD-name', ...]

      // 按日期聚合：同一天取最近创建的会话（列表中最后的那个）作为代表
      const dateMap = new Map<string, string>(); // date → sessionId
      for (const s of sessions) {
        const date = s.slice(0, 10); // YYYY-MM-DD
        // 后出现的覆盖先出现的（listSessions 按 ID ASC，所以最后的是最新的）
        dateMap.set(date, s);
      }

      // BUG-FIX 始终包含当天 main 会话（即使 0 条消息）
      // 跨日启动时当天无消息，原逻辑不返回当天会话，导致 sessions.length <= 1 时按钮被禁用，
      // 用户无法切换查看昨天的对话。补当天占位后，至少有"昨天+今天"两个选项，按钮可用。
      const today = getLocalDate();
      if (!dateMap.has(today)) {
        dateMap.set(today, `${today}-main`);
      }

      // 解析每个日期的一条代表会话
      const parsed = Array.from(dateMap.entries())
        .sort((a, b) => a[0].localeCompare(b[0])) // 日期升序
        .map(([_date, s]) => {
          const parts = s.split('-');
          if (parts.length >= 3) {
            const date = parts[0] + '-' + parts[1] + '-' + parts[2];
            const name = parts.slice(3).join('-') || 'main';
            const preview = ctx.sessionStore.getFirstUserMessage(s);
            const messageCount = ctx.sessionStore.countMessages(date, name);
            return { id: s, date, name, preview, messageCount };
          }
          return { id: s, date: s, name: s, preview: '', messageCount: 0 };
        });

      return { sessions: parsed };
    } catch (error) {
      errorHandler.handle(error, { code: ErrorCode.UNKNOWN, context: '列出会话失败' });
      return { sessions: [] };
    }
  });
}
