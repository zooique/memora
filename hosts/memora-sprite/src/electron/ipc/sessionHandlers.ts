/**
 * 会话管理 IPC 处理器
 *
 * 职责：
 *   1. 加载历史会话消息（支持分页）
 *   2. 切换到已有会话（更新 Agent 内部状态）
 *   3. 新建会话（基于时间戳生成会话名）
 *   4. 列出所有会话（含预览和消息数量）
 *   5. 删除会话
 *   6. 重命名会话
 */

import { ipcMain } from 'electron';
import { toError } from 'memora';
import { errorHandler, ErrorCode } from '../errorHandler.js';
import { IPC_CHANNELS } from '../ipcChannels.js';
import { getLocalDate } from '../../sprite/constants.js';
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
      // UX-PP-08 有明确查询参数时直接构造目标，跳过 listSessions 冗余调用
      let target: string | undefined;
      if (query.date && query.session) {
        target = `${query.date}-${query.session}`;
      } else {
        // 无查询参数时：列出所有会话，智能选择最近会话
        const sessions = ctx.sessionStore.listSessions();
        if (sessions.length === 0) {
          return { messages: [], loadedSessionId: '', total: 0, hasMore: false };
        }
        const today = getLocalDate(); // UX-PP-07 本地日期，非 UTC
        target = sessions.find(s => s === `${today}-main`) ?? sessions[sessions.length - 1];
      }

      if (!target) {
        return { messages: [], loadedSessionId: '', total: 0, hasMore: false };
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
      if (!ctx.agent) {
        return { success: false, messages: [], error: 'Agent 未初始化' };
      }

      // P2 修复：切换会话前检查是否有进行中对话，有则拒绝
      // 避免旧对话的后续消息持久化到新会话，导致会话内容串扰
      if (ctx.getAbortController()) {
        return { success: false, messages: [], error: '有进行中的对话，请等待完成或中断后再切换会话' };
      }

      // 1. 切换 Agent 内部会话标识（更新 currentSession，后续 chat() 写入新会话）
      ctx.agent.switchSession(query.session);
      // 2. 恢复目标会话的历史消息到 AgentLoop 工作记忆（供 LLM 上下文使用）
      await ctx.agent.restoreSession(query.date, query.session);
      // 3. 加载会话消息供 UI 渲染（保留 timestamp）
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

  // FD-09 删除会话
  ipcMain.handle(IPC_CHANNELS.SESSION_DELETE, async (_event, sessionId: string) => {
    try {
      if (!ctx.agent) {
        return { success: false, error: 'Agent 未初始化' };
      }

      const deleted = ctx.sessionStore.deleteSession(sessionId);
      if (!deleted) {
        return { success: false, error: '会话不存在或删除失败' };
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

      if (!newName || !newName.trim()) {
        return { success: false, error: '会话名不能为空' };
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

  /**
   * 新建会话
   *
   * 生成基于时间戳的会话名（session-HHmmss），调用 agent.switchSession 切换。
   * 旧会话数据保留在 SessionStore 中，不删除。
   */
  ipcMain.handle(IPC_CHANNELS.SESSION_NEW, async () => {
    try {
      const now = new Date();
      // 会话名格式：session-HHmmss（如 session-143052）
      const sessionName = `session-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
      ctx.agent.switchSession(sessionName);
      return { success: true, sessionName };
    } catch (error) {
      errorHandler.handle(error, { code: ErrorCode.UNKNOWN, context: '新建会话失败' });
      return { success: false, error: toError(error).message };
    }
  });

  // FD-A1 列出所有会话
  ipcMain.handle(IPC_CHANNELS.SESSION_LIST, async () => {
    try {
      const sessions = ctx.sessionStore.listSessions();
      // 解析会话名，提取日期和名称用于 UI 展示
      const parsed = sessions.map((s) => {
        const parts = s.split('-');
        // 格式：YYYY-MM-DD-name（如 2026-06-20-main, 2026-06-20-session-143052）
        if (parts.length >= 3) {
          const date = parts[0] + '-' + parts[1] + '-' + parts[2];
          const name = parts.slice(3).join('-') || 'main';
          // UX-PP-05 获取首条用户消息作为预览
          const preview = ctx.sessionStore.getFirstUserMessage(s);
          // P3-FLOW-04 获取消息数量用于会话列表项展示
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
