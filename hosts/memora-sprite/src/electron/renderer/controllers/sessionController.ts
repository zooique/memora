/**
 * 会话控制器 — 时间流式会话历史加载
 *
 * 职责：
 * - 加载当前会话历史消息到 UI（默认当天或最近一天）
 * - 向上分页加载当前会话的更早消息
 * - 跨天加载更早日期的对话（时间流式体验，类似微信/QQ）
 * - 跨日自动切换到今天的 main 会话（保留 LLM 工作记忆一致性）
 * - 删除指定日期的对话记录（按日期前缀删除当天全部子会话）
 * - 重命名会话（文件层面操作，不影响 Agent 内部状态）
 * - 分叉会话（从当前会话分叉出独立分支，保留全部历史消息）
 *
 * 设计原则：
 * - 用户不需要自己管理会话，系统自动按天管理对话（YYYY-MM-DD-main）
 * - 分叉功能是唯一的"新建会话"入口（基于当前上下文分叉，而非空白创建）
 * - 接收 UIManager 实例，不持有模块级状态
 * - currentSessionId 通过闭包封装，外部通过返回值访问
 * - 会话 ID 格式：YYYY-MM-DD-sessionName（与 SessionStore 对齐）
 * - UI 不再提供会话切换按钮，用户通过向上滚动加载历史日期
 * - loadedDates 跟踪已加载的日期，避免重复加载
 */

import type { UIManager } from '../ui.js';
import { reportError } from '../helpers/errorHelpers.js';
import { getLocalDate } from '../../../sprite/constants.js';
// P0-B：结构化错误抛出（替代裸 throw new Error，让 ErrorHandler 正确分类）
import { MemoraError, ErrorCode } from '../../../sprite/errors.js';

/**
 * 将 IPC 消息的角色映射为 UI 消息角色
 *
 * 确保 role 值仅限 'user' | 'assistant' | 'system'，
 * 未知值回退为 'assistant'。消除多处重复的映射逻辑。
 */
function mapRole(rawRole: string): 'user' | 'assistant' | 'system' {
  return (rawRole === 'user' || rawRole === 'assistant' || rawRole === 'system')
    ? rawRole
    : 'assistant';
}

/**
 * 将 IPC 消息数组映射为 UI Message 数组
 *
 * 提取自 loadSessionHistory / loadMoreHistory 中重复的映射逻辑（DRY）。
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
 * @returns 会话控制器接口（加载历史、加载更多、加载更早日期、切换会话、获取当前 ID）
 */
export function createSessionController(uiManager: UIManager) {
  /** 当前会话 ID（用于跨日检测和 LLM 工作记忆同步） */
  let currentSessionId = '';

  // 分页状态
  const PAGE_SIZE = 50;
  /** 当前已加载的消息偏移量（用于当前会话内的分页加载） */
  let currentOffset = 0;
  /** 当前会话消息总数 */
  let currentTotal = 0;
  /** 当前会话的 date + session 参数（用于当前会话内的分页加载） */
  let currentSessionParams: { date: string; session: string } | null = null;

  // 时间流状态
  /** 已加载的日期集合（避免重复加载同一天的消息） */
  const loadedDates = new Set<string>();
  /** 最早已加载的日期（用于查询更早的日期，null 表示尚未初始化） */
  let earliestDate: string | null = null;

  /**
   * 加载当前会话历史消息（初始加载，最近 PAGE_SIZE 条）
   *
   * 使用分页加载 + DocumentFragment 批量插入，
   * 首次加载最近 PAGE_SIZE 条消息，有更多时显示"加载更多"按钮，
   * 当前会话无更多消息时检查是否有更早日期，有则显示"加载更早的对话"按钮。
   */
  async function loadSessionHistory(): Promise<void> {
    try {
      const { messages, loadedSessionId, total, hasMore } = await window.electronAPI.loadSession({
        limit: PAGE_SIZE,
        offset: 0,
      });
      // 追加前先清空，纵深防御竞态条件导致的重复加载
      uiManager.clearMessages();
      // 批量插入消息（DocumentFragment 优化）
      uiManager.appendMessages(mapMessages(messages), false);
      if (loadedSessionId) {
        currentSessionId = loadedSessionId;
        // 解析会话参数用于当前会话内分页加载
        const parts = loadedSessionId.split('-');
        if (parts.length >= 4) {
          currentSessionParams = {
            date: parts.slice(0, 3).join('-'),
            session: parts.slice(3).join('-') || 'main',
          };
          // 记录已加载的日期
          loadedDates.add(currentSessionParams.date);
          earliestDate = currentSessionParams.date;
        }
      }
      // 更新分页状态
      currentOffset = messages.length;
      currentTotal = total;
      // 今日消息数只统计今天 main 会话的消息
      // 加载昨天对话时今日消息数为 0，加载今天 main 时为该会话的消息数
      const today = getLocalDate();
      const isTodayMain = loadedSessionId === `${today}-main`;
      uiManager.setMessageCount(isTodayMain ? messages.filter((m) => m.role !== 'system').length : 0);
      // 根据分页和日期状态显示对应的加载按钮
      await updateLoadMoreButton(hasMore);

      uiManager.hidePanelError('chat');
    } catch (error) {
      reportError('loadSessionHistory', error);
      uiManager.showPanelError('chat', '加载会话历史失败，请检查连接后重试', () => loadSessionHistory());
    }
  }

  /**
   * 加载更多历史消息（当前会话内分页）
   *
   * 从当前已加载位置继续加载更早的消息，插入到消息区顶部。
   * 加载完成后更新分页状态，无更多消息时切换为"加载更早的对话"按钮。
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
      currentTotal = total;

      // 根据分页和日期状态显示对应的加载按钮
      await updateLoadMoreButton(hasMore);
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
   * 加载更早日期的对话
   *
   * 查询比当前最早日期更早的最近一个日期，加载该日期代表会话的全部消息，
   * prepend 到消息区顶部。加载完成后更新 earliestDate，并检查是否还有更早的日期。
   *
   * 设计要点：
   * - 不更新 currentSessionParams（currentSessionParams 始终指向当前 LLM 工作记忆的会话）
   * - 仅更新 loadedDates 和 earliestDate（用于跟踪已加载的日期范围）
   * - 一次加载一天的全部消息（不分页，按天作为加载单位）
   */
  async function loadEarlierDay(): Promise<void> {
    try {
      const { sessions } = await window.electronAPI.listSessions();
      // 提取所有日期并去重排序（升序）
      const allDates = Array.from(new Set(sessions.map((s) => s.date))).sort();
      // 找到比 earliestDate 更早的日期
      // 使用局部变量保存 narrow 后的值，避免 TS 在 filter 回调中无法保证 let 变量不变
      const earliest = earliestDate;
      const earlierDates = earliest
        ? allDates.filter((d) => d < earliest)
        : allDates;

      if (earlierDates.length === 0) {
        // 没有更早的日期，隐藏按钮
        uiManager.hideLoadMore();
        return;
      }

      // 取最近的更早日期（earlierDates 升序，最后一项是最接近 earliestDate 的）
      // noUncheckedIndexedAccess 模式下数组索引返回 T | undefined，需 ?? 兜底
      const targetDate = earlierDates[earlierDates.length - 1] ?? '';
      if (!targetDate) {
        uiManager.hideLoadMore();
        return;
      }

      // 找到该日期的代表会话（SESSION_LIST 已按日期聚合，每日期一条代表）
      const targetSession = sessions.find((s) => s.date === targetDate);
      if (!targetSession) {
        uiManager.hideLoadMore();
        return;
      }

      // 加载该日期的全部消息（一次加载，按天作为单位）
      const { messages } = await window.electronAPI.loadSession({
        date: targetDate,
        session: targetSession.name,
        limit: 10000, // 一次加载全部（实际不会那么多）
        offset: 0,
      });

      // prepend 到 UI 顶部
      uiManager.appendMessages(mapMessages(messages), true);

      // 更新时间流状态（不更新 currentSessionParams）
      loadedDates.add(targetDate);
      earliestDate = targetDate;

      // 检查是否还有更早的日期
      const hasEarlier = allDates.some((d) => d < targetDate);
      if (hasEarlier) {
        uiManager.showLoadEarlierDay(loadEarlierDay);
      } else {
        uiManager.hideLoadMore();
      }
    } catch (error) {
      reportError('loadEarlierDay', error);
      uiManager.showToast('加载更早的对话失败', 'error');
    }
  }

  /**
   * 根据分页和日期状态更新加载按钮
   *
   * 优先级：
   * 1. 当前会话还有更多消息 → 显示"加载更多消息"按钮
   * 2. 当前会话无更多消息，但有更早日期 → 显示"加载更早的对话"按钮
   * 3. 无更多消息且无更早日期 → 隐藏按钮
   *
   * @param hasMoreCurrent 当前会话是否还有更多消息（来自 IPC 返回值）
   */
  async function updateLoadMoreButton(hasMoreCurrent: boolean): Promise<void> {
    // 当前会话还有更多消息
    if (hasMoreCurrent && currentSessionParams) {
      uiManager.showLoadMore(currentTotal - currentOffset, loadMoreHistory);
      return;
    }

    // 当前会话无更多消息，隐藏"加载更多"按钮
    uiManager.hideLoadMore();

    // 检查是否有更早的日期
    // 使用局部变量保存 narrow 后的值，避免 TS 在 some 回调中无法保证 let 变量不变
    const earliest = earliestDate;
    if (earliest) {
      try {
        const { sessions } = await window.electronAPI.listSessions();
        const allDates = Array.from(new Set(sessions.map((s) => s.date))).sort();
        const hasEarlier = allDates.some((d) => d < earliest);
        if (hasEarlier) {
          uiManager.showLoadEarlierDay(loadEarlierDay);
        }
      } catch (error) {
        // 查询失败不影响主流程，仅记录日志
        reportError('updateLoadMoreButton', error);
      }
    }
  }

  /**
   * 跨日自动切换到指定会话
   *
   * 保留 LLM 工作记忆一致性：用户在查看历史日期时发送消息，
   * 自动切换到今天的 main 会话，确保新消息持久化到正确的会话。
   *
   * 检查流式状态，避免流式输出期间切换导致状态混乱。
   * 失败时显示 toast 和错误横幅，提供重试。
   * 会话 ID 格式：YYYY-MM-DD-sessionName，需解析为 date + session 参数。
   *
   * 注意：方案 B 移除了会话切换 UI，此方法仅用于跨日自动切换。
   */
  async function switchSession(sessionId: string): Promise<void> {
    // 流式输出期间禁止切换会话，避免状态混乱
    if (uiManager.isStreaming()) {
      uiManager.showToast('精灵正在回复中，请等待完成或点击停止后再切换会话', 'warning');
      return;
    }

    try {
      // 清空当前消息区
      uiManager.clearMessages();
      // 重置分页和时间流状态
      currentOffset = 0;
      currentTotal = 0;
      currentSessionParams = null;
      loadedDates.clear();
      earliestDate = null;
      // 解析会话 ID 为 date + session 参数
      const parts = sessionId.split('-');
      const date = parts.slice(0, 3).join('-');
      const name = parts.slice(3).join('-') || 'main';

      // 调用 switchSession IPC：更新 Agent 内部状态 + 加载会话消息
      const result = await window.electronAPI.switchSession({ date, session: name });
      if (!result.success) {
        throw new MemoraError(ErrorCode.API_ERROR, result.error ?? '切换会话失败');
      }

      // 渲染目标会话的消息（批量插入）
      uiManager.appendMessages(mapMessages(result.messages), false);
      currentSessionId = sessionId;
      // 记录已加载的日期
      loadedDates.add(date);
      earliestDate = date;
      // 解析会话参数用于当前会话内分页
      currentSessionParams = { date, session: name };
      currentOffset = result.messages.length;
      currentTotal = result.messages.length; // switchSession 返回全部消息，无分页
      // 今日消息数只统计今天 main 会话的消息
      const today = getLocalDate();
      const isTodayMain = date === today && name === 'main';
      uiManager.setMessageCount(isTodayMain ? result.messages.filter((m) => m.role !== 'system').length : 0);
      // 切换成功后隐藏错误横幅
      uiManager.hidePanelError('chat');
    } catch (error) {
      reportError('switchSession', error);
      // 失败时显示 toast 和错误横幅，提供重试
      uiManager.showToast('切换会话失败，请重试', 'error');
      uiManager.showPanelError('chat', `切换会话失败：${error instanceof Error ? error.message : '未知错误'}`, () => switchSession(sessionId));
    }
  }

  /** 获取当前会话 ID（供跨日检测使用） */
  function getCurrentSessionId(): string {
    return currentSessionId;
  }

  /**
   * 加载日期列表（供日期导航下拉使用）
   *
   * 查询所有有对话记录的日期，按日期降序排列（最新的在最前）。
   * 始终包含今天日期（即使 0 条消息），确保用户可以跳转到今天的对话。
   *
   * @returns 日期列表，每项包含日期、消息数、是否今天
   */
  async function loadDateList(): Promise<Array<{ date: string; messageCount: number; isToday: boolean }>> {
    try {
      const { sessions } = await window.electronAPI.listSessions();
      const today = getLocalDate();

      // 按日期聚合消息数
      const dateCountMap = new Map<string, number>();
      for (const s of sessions) {
        const count = s.messageCount ?? 0;
        dateCountMap.set(s.date, (dateCountMap.get(s.date) ?? 0) + count);
      }

      // 始终包含今天（即使无消息）
      if (!dateCountMap.has(today)) {
        dateCountMap.set(today, 0);
      }

      // 转换为数组并按日期降序排列（最新的在最前）
      const result = Array.from(dateCountMap.entries())
        .map(([date, messageCount]) => ({
          date,
          messageCount,
          isToday: date === today,
        }))
        .sort((a, b) => b.date.localeCompare(a.date));

      return result;
    } catch (error) {
      reportError('loadDateList', error);
      return [];
    }
  }

  /**
   * 跳转到指定日期的对话
   *
   * 加载指定日期的代表会话消息，替换当前消息区。
   * 跳转后重置时间流状态，以该日期为起点。
   *
   * @param date 目标日期（YYYY-MM-DD）
   */
  async function jumpToDate(date: string): Promise<void> {
    // 流式输出期间禁止跳转
    if (uiManager.isStreaming()) {
      uiManager.showToast('精灵正在回复中，请等待完成或点击停止后再跳转', 'warning');
      return;
    }

    try {
      // 查询该日期的代表会话
      const { sessions } = await window.electronAPI.listSessions();
      const targetSession = sessions.find((s) => s.date === date);
      const sessionName = targetSession?.name ?? 'main';

      // 清空当前消息区
      uiManager.clearMessages();
      // 重置分页和时间流状态
      currentOffset = 0;
      currentTotal = 0;
      currentSessionParams = null;
      loadedDates.clear();
      earliestDate = null;

      // 加载该日期的全部消息
      const { messages, total, hasMore } = await window.electronAPI.loadSession({
        date,
        session: sessionName,
        limit: PAGE_SIZE,
        offset: 0,
      });

      // 渲染消息
      uiManager.appendMessages(mapMessages(messages), false);

      // 更新状态
      const sessionId = `${date}-${sessionName}`;
      currentSessionId = sessionId;
      currentSessionParams = { date, session: sessionName };
      currentOffset = messages.length;
      currentTotal = total;
      loadedDates.add(date);
      earliestDate = date;

      // 今日消息数只统计今天 main 会话的消息
      const today = getLocalDate();
      const isTodayMain = date === today && sessionName === 'main';
      uiManager.setMessageCount(isTodayMain ? messages.filter((m) => m.role !== 'system').length : 0);

      // 更新加载按钮状态
      await updateLoadMoreButton(hasMore);

      uiManager.hidePanelError('chat');
    } catch (error) {
      reportError('jumpToDate', error);
      uiManager.showToast('跳转到指定日期失败', 'error');
    }
  }

  /**
   * 删除指定日期的对话记录
   *
   * 调用主进程 SESSION_DELETE 删除该日期所有子会话，
   * 删除成功后刷新日期导航列表并重置 UI：
   * - 若删除的是当前查看日期：清空消息区，加载今天 main 会话
   * - 若删除的是其他日期：仅刷新日期列表
   *
   * @param date 目标日期（YYYY-MM-DD）
   * @returns 是否删除成功（供调用方决定是否刷新日期列表）
   */
  async function deleteSession(date: string): Promise<boolean> {
    // 流式输出期间禁止删除
    if (uiManager.isStreaming()) {
      uiManager.showToast('精灵正在回复中，请等待完成或点击停止后再删除', 'warning');
      return false;
    }

    try {
      // 调用主进程删除会话（按日期前缀删除当天全部子会话）
      const result = await window.electronAPI.deleteSession(date);
      if (!result.success) {
        throw new MemoraError(ErrorCode.API_ERROR, result.error ?? '删除会话失败');
      }

      uiManager.showToast('对话记录已删除', 'success');

      // 删除的是当前查看日期：清空消息区并加载今天 main 会话
      if (currentSessionParams && currentSessionParams.date === date) {
        uiManager.clearMessages();
        currentOffset = 0;
        currentTotal = 0;
        currentSessionParams = null;
        loadedDates.clear();
        earliestDate = null;
        currentSessionId = '';
        // 重新加载当前会话历史（会自动加载今天 main 或最近会话）
        await loadSessionHistory();
      }

      uiManager.hidePanelError('chat');
      return true;
    } catch (error) {
      reportError('deleteSession', error);
      uiManager.showToast('删除对话记录失败，请重试', 'error');
      return false;
    }
  }

  /**
   * 重命名会话
   *
   * 调用主进程 SESSION_RENAME 重命名指定会话（文件层面操作，不影响 Agent 内部状态）。
   * 重命名成功后显示 toast 提示，不切换当前视图。
   *
   * @param sessionId 目标会话 ID（YYYY-MM-DD-sessionName）
   * @param newName 新会话名
   * @returns 是否重命名成功
   */
  async function renameSession(sessionId: string, newName: string): Promise<boolean> {
    // 流式输出期间禁止重命名
    if (uiManager.isStreaming()) {
      uiManager.showToast('精灵正在回复中，请等待完成后再重命名', 'warning');
      return false;
    }

    try {
      const result = await window.electronAPI.renameSession(sessionId, newName);
      if (!result.success) {
        throw new MemoraError(ErrorCode.API_ERROR, result.error ?? '重命名会话失败');
      }

      uiManager.showToast(`已重命名为 ${newName}`, 'success');
      uiManager.hidePanelError('chat');
      return true;
    } catch (error) {
      reportError('renameSession', error);
      uiManager.showToast('重命名会话失败，请重试', 'error');
      return false;
    }
  }

  /**
   * 会话分叉（从当前会话分叉出独立分支，保留全部历史消息）
   *
   * 调用主进程 SESSION_FORK 触发内核 Agent.forkSession()。
   * 分叉成功后内核会发射 sessionForked 事件，由 ipcListeners 监听并切换到新会话。
   * 此方法仅负责触发操作和显示反馈，不直接切换 UI（避免与事件处理重复切换）。
   *
   * @param targetSession 可选，指定分叉目标会话名；不传时由内核自动生成
   * @returns 是否分叉成功
   */
  async function forkSession(targetSession?: string): Promise<boolean> {
    // 流式输出期间禁止分叉
    if (uiManager.isStreaming()) {
      uiManager.showToast('精灵正在回复中，请等待完成或点击停止后再分叉', 'warning');
      return false;
    }

    try {
      const result = await window.electronAPI.forkSession(targetSession);
      if (!result.success || !result.newSession) {
        throw new MemoraError(ErrorCode.API_ERROR, result.error ?? '分叉会话失败');
      }

      // 分叉成功提示（实际切换由 sessionForked 事件触发）
      uiManager.showToast(`已分叉出 ${result.messageCount ?? 0} 条消息，正在切换...`, 'success');
      uiManager.hidePanelError('chat');
      return true;
    } catch (error) {
      reportError('forkSession', error);
      uiManager.showToast('分叉会话失败，请重试', 'error');
      return false;
    }
  }

  return {
    loadSessionHistory,
    switchSession,
    deleteSession,
    renameSession,
    forkSession,
    loadMoreHistory,
    loadEarlierDay,
    loadDateList,
    jumpToDate,
    getCurrentSessionId,
  };
}
