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
import { escapeHtml } from './domHelpers.js';

/**
 * 将 IPC 消息的角色映射为 UI 消息角色
 *
 * 确保 role 值仅限 'user' | 'assistant' | 'system'，
 * 未知值回退为 'assistant'。消除 3 处重复的映射逻辑。
 */
function mapRole(rawRole: string): 'user' | 'assistant' | 'system' {
  return (rawRole === 'user' || rawRole === 'assistant' || rawRole === 'system')
    ? rawRole
    : 'assistant';
}

/**
 * 将 IPC 消息数组映射为 UI Message 数组
 *
 * 提取自 loadSessionHistory / loadMoreHistory / switchSession 中 3 处相同的映射逻辑（DRY）。
 */
function mapMessages(messages: Array<{ role: string; content: string; timestamp?: string }>): Array<{ role: 'user' | 'assistant' | 'system'; content: string; timestamp?: string }> {
  return messages.map((msg) => ({
    role: mapRole(msg.role),
    content: msg.content,
    timestamp: msg.timestamp,
  }));
}

/**
 * 创建会话控制器
 *
 * @param uiManager UI 管理器实例
 * @returns 会话控制器接口（加载历史、加载列表、切换会话、加载更多、获取当前 ID）
 */
export function createSessionController(uiManager: UIManager) {
  /** FD-A1 当前会话 ID（用于会话列表 UI 高亮当前项） */
  let currentSessionId = '';

  // UX-FD-07 分页状态
  const PAGE_SIZE = 50;
  /** 当前已加载的消息偏移量（用于加载更多） */
  let currentOffset = 0;
  /** 当前会话消息总数 */
  let currentTotal = 0;
  /** 当前会话的 date + session 参数（用于加载更多） */
  let currentSessionParams: { date: string; session: string } | null = null;

  /**
   * 加载当前会话历史消息（初始加载，最近 50 条）
   *
   * UX-FD-07 使用分页加载 + DocumentFragment 批量插入，
   * 首次加载最近 PAGE_SIZE 条消息，有更多时显示"加载更多"按钮。
   */
  async function loadSessionHistory(): Promise<void> {
    try {
      const { messages, loadedSessionId, total, hasMore } = await window.electronAPI.loadSession({
        limit: PAGE_SIZE,
        offset: 0,
      });
      // UX-FD-07 批量插入消息（DocumentFragment 优化）
      uiManager.appendMessages(mapMessages(messages), false);
      if (loadedSessionId) {
        currentSessionId = loadedSessionId;
        // 解析会话参数用于加载更多
        const parts = loadedSessionId.split('-');
        if (parts.length >= 4) {
          currentSessionParams = {
            date: parts.slice(0, 3).join('-'),
            session: parts.slice(3).join('-') || 'main',
          };
        }
      }
      // UX-FD-07 更新分页状态
      currentOffset = messages.length;
      currentTotal = total ?? messages.length;
      if (hasMore && currentSessionParams) {
        uiManager.showLoadMore(currentTotal - currentOffset, loadMoreHistory);
      }

      uiManager.hidePanelError('chat');
    } catch (error) {
      reportError('loadSessionHistory', error);
      uiManager.showPanelError('chat', '加载会话历史失败，请检查连接后重试', () => loadSessionHistory());
    }
  }

  /**
   * UX-FD-07 加载更多历史消息
   *
   * 从当前已加载位置继续加载更早的消息，插入到消息区顶部。
   * 加载完成后更新分页状态，无更多消息时隐藏按钮。
   */
  async function loadMoreHistory(): Promise<void> {
    if (!currentSessionParams) return;

    try {
      const { messages, hasMore, total } = await window.electronAPI.loadSession({
        date: currentSessionParams.date,
        session: currentSessionParams.session,
        limit: PAGE_SIZE,
        offset: currentOffset,
      });

      // 插入到消息区顶部（prepend=true）
      uiManager.appendMessages(mapMessages(messages), true);

      // 更新分页状态
      currentOffset += messages.length;
      currentTotal = total ?? currentTotal;

      if (hasMore) {
        uiManager.showLoadMore(currentTotal - currentOffset, loadMoreHistory);
      } else {
        uiManager.hideLoadMore();
      }
    } catch (error) {
      reportError('loadMoreHistory', error);
      uiManager.showToast('加载更多消息失败', 'error');
      // 恢复按钮状态
      if (currentTotal > currentOffset) {
        uiManager.showLoadMore(currentTotal - currentOffset, loadMoreHistory);
      }
    }
  }

  /**
   * FD-A1 加载会话列表到 UI
   *
   * 使用 currentSessionId 高亮当前会话（由 loadSessionHistory 或 switchSession 设置）。
   */
  async function loadSessionList(): Promise<void> {
    try {
      const { sessions } = await window.electronAPI.listSessions();
      uiManager.updateSessionList(sessions, currentSessionId);
    } catch (error) {
      reportError('loadSessionList', error);
    }
  }

  /**
   * FD-A1 切换会话
   *
   * UX-P1-04 修复：调用 switchSession IPC 更新 Agent 内部状态（currentSession + restoreSession），
   * 避免消息持久化到错误会话。
   * UX-P2-04 检查流式状态，避免流式输出期间切换导致状态混乱。
   * UX-P2-08 失败时显示 toast 和错误横幅，提供重试。
   * 会话 ID 格式：YYYY-MM-DD-sessionName，需解析为 date + session 参数。
   */
  async function switchSession(sessionId: string): Promise<void> {
    // UX-P2-04 流式输出期间禁止切换会话，避免状态混乱
    if (uiManager.isStreaming()) {
      uiManager.showToast('精灵正在回复中，请等待完成或点击停止后再切换会话', 'warning');
      return;
    }

    try {
      // 清空当前消息区
      uiManager.clearMessages();
      // UX-FD-07 重置分页状态
      currentOffset = 0;
      currentTotal = 0;
      currentSessionParams = null;
      // 解析会话 ID 为 date + session 参数
      const parts = sessionId.split('-');
      const date = parts.slice(0, 3).join('-');
      const name = parts.slice(3).join('-') || 'main';

      // UX-P1-04 调用 switchSession IPC：更新 Agent 内部状态 + 加载会话消息
      const result = await window.electronAPI.switchSession({ date, session: name });
      if (!result.success) {
        throw new Error(result.error ?? '切换会话失败');
      }

      // 渲染目标会话的消息（UX-FD-07 批量插入）
      uiManager.appendMessages(mapMessages(result.messages), false);
      currentSessionId = sessionId;
      // 刷新会话列表以更新高亮
      const { sessions } = await window.electronAPI.listSessions();
      uiManager.updateSessionList(sessions, currentSessionId);
      // 切换成功后隐藏错误横幅
      uiManager.hidePanelError('chat');
    } catch (error) {
      reportError('switchSession', error);
      // UX-P2-08 失败时显示 toast 和错误横幅，提供重试
      uiManager.showToast('切换会话失败，请重试', 'error');
      uiManager.showPanelError('chat', `切换会话失败：${error instanceof Error ? error.message : '未知错误'}`, () => switchSession(sessionId));
    }
  }

  /** 获取当前会话 ID（供外部查询高亮状态） */
  function getCurrentSessionId(): string {
    return currentSessionId;
  }

  /**
   * FD-09 删除会话
   *
   * 弹出确认对话框后删除会话。删除不可恢复。
   * 删除成功后刷新会话列表 UI。
   * P3-FLOW-05 支持删除当前会话：删除后自动切换到剩余会话中的第一个
   * QC-R2-02 统一使用 showConfirmDialog 替代原生 confirm（与项目其他弹窗风格一致）
   */
  async function deleteSession(sessionId: string): Promise<void> {
    // 安全检查：防止未知 sessionId
    if (!sessionId) return;

    // QC-R2-02 使用自定义确认弹窗（与项目其他弹窗风格一致，支持 Escape/Enter 键盘操作）
    const confirmed = await uiManager.showConfirmDialog({
      title: '删除会话',
      message: `确定删除会话「${escapeHtml(sessionId)}」吗？此操作不可恢复。`,
      confirmText: '删除',
      cancelText: '取消',
      danger: true,
    });
    if (!confirmed) return;

    const result = await window.electronAPI.deleteSession(sessionId);
    if (result.success) {
      uiManager.showToast('会话已删除', 'info');

      // P3-FLOW-05 删除当前会话时，自动切换到剩余会话中的第一个
      // 避免用户删除当前会话后界面停留在已删除会话的消息上
      if (sessionId === currentSessionId) {
        const { sessions: remaining } = await window.electronAPI.listSessions();
        if (remaining.length > 0) {
          // 切换到剩余会话中最近的一个（列表已按时间倒序，第一项为最近）
          await switchSession(remaining[0]!.id);
        } else {
          // 没有剩余会话：清空消息区，等待用户开始新对话
          uiManager.clearMessages();
          currentSessionId = '';
        }
      } else {
        // 删除非当前会话：仅刷新会话列表
        await loadSessionList();
      }
    } else {
      uiManager.showToast(result.error ?? '删除失败', 'error');
    }
  }

  /**
   * FD-09 重命名会话
   *
   * 弹出输入框让用户输入新名称。
   * 重命名成功后刷新会话列表 UI。
   */
  async function renameSession(sessionId: string): Promise<void> {
    if (!sessionId) return;

    // 提取当前会话名作为默认值（去除日期前缀）
    const parts = sessionId.split('-');
    const currentName = parts.length >= 4 ? parts.slice(3).join('-') : sessionId;

    // 使用自定义输入弹窗替代原生 prompt，提供一致的视觉体验
    const newName = await uiManager.showInputDialog({
      title: '重命名会话',
      message: '请输入新的会话名称：',
      defaultValue: currentName,
      placeholder: '输入会话名',
      maxLength: 100,
      required: true,
    });

    // 用户取消或输入为空
    if (!newName) return;

    const result = await window.electronAPI.renameSession(sessionId, newName);
    if (result.success) {
      uiManager.showToast('会话已重命名', 'info');
      await loadSessionList();
    } else {
      uiManager.showToast(result.error ?? '重命名失败', 'error');
    }
  }

  return {
    loadSessionHistory,
    loadSessionList,
    switchSession,
    deleteSession,
    renameSession,
    loadMoreHistory,
    getCurrentSessionId,
  };
}
