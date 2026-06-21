/**
 * 会话控制器 — 会话历史加载与切换
 *
 * 职责：
 * - 加载当前会话历史消息到 UI
 * - 加载会话列表用于历史切换
 * - 切换到指定会话并加载其消息
 *
 * 设计原则：
 * - 接收 UIManager 实例，不持有模块级状态
 * - currentSessionId 通过闭包封装，外部通过返回值访问
 * - 会话 ID 格式：YYYY-MM-DD-sessionName（与 SessionStore 对齐）
 */

import type { UIManager } from './ui.js';
import { reportError } from './errorHelpers.js';

/**
 * 创建会话控制器
 *
 * @param uiManager UI 管理器实例
 * @returns 会话控制器接口（加载历史、加载列表、切换会话、获取当前 ID）
 */
export function createSessionController(uiManager: UIManager) {
  /** FD-A1 当前会话 ID（用于会话列表 UI 高亮当前项） */
  let currentSessionId = '';

  /**
   * 加载当前会话历史消息
   *
   * 从主进程加载会话历史，逐条追加到对话区。
   * 未知角色回退为 assistant（避免 system 被错误映射）。
   */
  async function loadSessionHistory(): Promise<void> {
    try {
      const { messages } = await window.electronAPI.loadSession({});
      for (const msg of messages) {
        // 保留合法角色，未知角色回退为 assistant（避免 system 被错误映射为 assistant）
        const role = (msg.role === 'user' || msg.role === 'assistant' || msg.role === 'system')
          ? msg.role
          : 'assistant';
        uiManager.appendMessage({
          role,
          content: msg.content,
        });
      }
    } catch (error) {
      // 会话历史加载失败：显示错误横幅，提供重试
      reportError('loadSessionHistory', error);
      uiManager.showPanelError('chat', '加载会话历史失败，请检查连接后重试', () => loadSessionHistory());
    }
  }

  /**
   * FD-A1 加载会话列表到 UI
   *
   * 推断当前会话 ID：取最近一条（listSessions 按顺序返回）。
   */
  async function loadSessionList(): Promise<void> {
    try {
      const { sessions } = await window.electronAPI.listSessions();
      // 推断当前会话 ID：取最近一条（listSessions 按顺序返回）
      if (sessions.length > 0) {
        currentSessionId = sessions[sessions.length - 1]!.id;
      }
      uiManager.updateSessionList(sessions, currentSessionId);
    } catch (error) {
      reportError('loadSessionList', error);
    }
  }

  /**
   * FD-A1 切换会话
   *
   * 清空当前消息区，加载目标会话的消息，刷新会话列表高亮。
   * 会话 ID 格式：YYYY-MM-DD-sessionName，需解析为 date + session 参数。
   */
  async function switchSession(sessionId: string): Promise<void> {
    try {
      // 清空当前消息区
      uiManager.clearMessages();
      // 加载目标会话的消息
      const parts = sessionId.split('-');
      const date = parts.slice(0, 3).join('-');
      const name = parts.slice(3).join('-') || 'main';
      const { messages } = await window.electronAPI.loadSession({ date, session: name });
      for (const msg of messages) {
        const role = (msg.role === 'user' || msg.role === 'assistant' || msg.role === 'system')
          ? msg.role
          : 'assistant';
        uiManager.appendMessage({ role, content: msg.content });
      }
      currentSessionId = sessionId;
      // 刷新会话列表以更新高亮
      const { sessions } = await window.electronAPI.listSessions();
      uiManager.updateSessionList(sessions, currentSessionId);
    } catch (error) {
      reportError('switchSession', error);
    }
  }

  /** 获取当前会话 ID（供外部查询高亮状态） */
  function getCurrentSessionId(): string {
    return currentSessionId;
  }

  return {
    loadSessionHistory,
    loadSessionList,
    switchSession,
    getCurrentSessionId,
  };
}
