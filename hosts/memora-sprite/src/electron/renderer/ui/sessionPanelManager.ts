/**
 * 会话面板管理器 — 会话历史列表 UI 逻辑独立子模块
 *
 * 职责：
 * - 管理会话列表的渲染、过滤、下拉切换
 * - 管理会话切换/删除/重命名回调
 * - 管理会话搜索框事件绑定
 *
 * 设计原则：
 * - 遵循 SettingsPanelManager 的组合模式，UIManager 持有实例并委托
 * - 自管理 DOM 查询（通过 ID 查询，无需构造注入）
 * - 提取自 ui.ts（P2-008：ui.ts 体积过大拆分），减少约 300 行。
 */

import { formatTimeAgo } from '../domHelpers.js';

// ─── 会话面板管理器类 ─────────────────────────────────────

export class SessionPanelManager {
  /** 会话切换回调（由 renderer.ts 注入） */
  private sessionSwitchCallback: ((sessionId: string) => void) | null = null;

  /** FD-09 会话删除回调（由 renderer.ts 注入） */
  private sessionDeleteCallback: ((sessionId: string) => void) | null = null;

  /** FD-09 会话重命名回调（由 renderer.ts 注入） */
  private sessionRenameCallback: ((sessionId: string) => void) | null = null;

  /** FD-08 当前会话 ID（renderSessionListItems 渲染高亮使用） */
  private sessionsCurrentId: string = '';

  /** FD-08 搜索框事件是否已绑定（仅首次绑定） */
  private sessionSearchBound: boolean = false;

  constructor() {
    // SessionPanelManager 不持有 DOM 引用，所有 DOM 操作通过 ID 动态查询
  }

  // ─── 回调注册 ───────────────────────────────────────────

  /** FD-A1 设置会话切换回调 */
  setSessionSwitchCallback(cb: (sessionId: string) => void): void {
    this.sessionSwitchCallback = cb;
  }

  /** FD-09 设置会话删除回调 */
  setSessionDeleteCallback(cb: (sessionId: string) => void): void {
    this.sessionDeleteCallback = cb;
  }

  /** FD-09 设置会话重命名回调 */
  setSessionRenameCallback(cb: (sessionId: string) => void): void {
    this.sessionRenameCallback = cb;
  }

  // ─── 公共 API ───────────────────────────────────────────

  /**
   * FD-A1 更新会话列表 UI
   *
   * 从主进程获取会话列表后，填充下拉菜单。
   * 会话数 ≤ 1 时禁用选择器（无需切换），但仍渲染当前会话信息。
   */
  updateSessionList(
    sessions: Array<{ id: string; date: string; name: string; preview?: string; messageCount?: number }>,
    currentSessionId: string,
  ): void {
    const selector = document.getElementById('session-selector');
    const list = document.getElementById('session-list');
    const currentName = document.getElementById('session-current-name');
    const searchInput = document.getElementById('session-search') as HTMLInputElement | null;
    if (!selector || !list || !currentName) return;

    // P1 修复：移除初始 hidden 类，使会话选择器可见
    // HTML 中 session-selector 初始带 hidden 类，此处首次加载时移除
    selector.classList.remove('hidden');

    // FD-08 存储当前会话 ID，供 renderSessionListItems 高亮使用
    this.sessionsCurrentId = currentSessionId;

    // UX-PP-06 仅一个会话时保留选择器但禁用下拉（避免 UI 消失导致用户困惑）
    if (sessions.length <= 1) {
      selector.classList.add('disabled');
      const sessionCurrent = document.getElementById('session-current');
      if (sessionCurrent) {
        sessionCurrent.setAttribute('aria-disabled', 'true');
      }
      // 仍然渲染当前会话信息（显示名称 + 日期）
      this.renderSessionListItems(sessions);
      return;
    }

    selector.classList.remove('disabled');
    const sessionCurrent = document.getElementById('session-current');
    if (sessionCurrent) {
      sessionCurrent.removeAttribute('aria-disabled');
    }

    // 找到当前会话
    const current = sessions.find((s) => s.id === currentSessionId);
    currentName.textContent = current?.name ?? currentSessionId;

    // 清空搜索框并渲染全部会话
    if (searchInput) {
      searchInput.value = '';
      // FD-08 绑定搜索过滤事件（仅首次）
      if (!this.sessionSearchBound) {
        this.sessionSearchBound = true;
        searchInput.addEventListener('input', () => {
          this.filterSessionList(searchInput.value);
        });
      }
    }

    this.renderSessionListItems(sessions);
  }

  /** FD-A1 切换会话下拉菜单的显示/隐藏（UX-PP-06 禁用状态下不响应） */
  toggleSessionDropdown(): void {
    const selector = document.getElementById('session-selector');
    if (selector?.classList.contains('disabled')) return;
    const dropdown = document.getElementById('session-dropdown');
    if (dropdown) {
      dropdown.classList.toggle('hidden');
    }
  }

  /** FD-A1 关闭会话下拉菜单 */
  closeSessionDropdown(): void {
    const dropdown = document.getElementById('session-dropdown');
    if (dropdown) {
      dropdown.classList.add('hidden');
    }
  }

  // ─── 私有方法 ───────────────────────────────────────────

  /**
   * FD-08 渲染会话列表项
   *
   * 按时间倒序渲染所有会话到 #session-list。
   */
  private renderSessionListItems(
    sessions: Array<{ id: string; date: string; name: string; preview?: string; messageCount?: number }>,
  ): void {
    const list = document.getElementById('session-list');
    if (!list) return;

    // 清空列表
    while (list.firstChild) {
      list.removeChild(list.firstChild);
    }

    const currentId = this.sessionsCurrentId ?? '';

    // 按时间倒序（最近在前）
    const sorted = [...sessions].reverse();
    for (const session of sorted) {
      const li = document.createElement('li');
      li.className = 'session-list-item';
      if (session.id === currentId) {
        li.classList.add('active');
      }
      li.dataset.sessionId = session.id;

      const nameSpan = document.createElement('span');
      nameSpan.className = 'session-list-item-name';
      nameSpan.textContent = session.name;
      li.appendChild(nameSpan);

      const dateSpan = document.createElement('span');
      dateSpan.className = 'session-list-item-date';
      // UX-PP-05 使用相对时间格式化（今天/昨天/3天前/MM-DD）
      dateSpan.textContent = formatTimeAgo(session.date);
      li.appendChild(dateSpan);

      // UX-PP-05 首条消息预览（仅在有内容时显示）
      if (session.preview) {
        const previewSpan = document.createElement('span');
        previewSpan.className = 'session-list-item-preview';
        previewSpan.textContent = session.preview;
        li.appendChild(previewSpan);
      }

      // P3-FLOW-04 消息数量徽章（仅当有消息时显示，避免空会话显示 0）
      if (typeof session.messageCount === 'number' && session.messageCount > 0) {
        const countSpan = document.createElement('span');
        countSpan.className = 'session-list-item-count';
        countSpan.textContent = String(session.messageCount);
        countSpan.title = `${session.messageCount} 条消息`;
        li.appendChild(countSpan);
      }

      // FD-09 删除按钮
      // P3-FLOW-05 当前会话也显示删除按钮（原仅非当前会话显示，导致用户无法删除当前会话）
      // 删除当前会话时由 sessionController 处理切换逻辑
      const delBtn = document.createElement('button');
      delBtn.className = 'session-list-item-del';
      delBtn.title = '删除会话';
      delBtn.textContent = '🗑';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.sessionDeleteCallback?.(session.id);
      });
      li.appendChild(delBtn);

      // FD-09 重命名按钮
      const renameBtn = document.createElement('button');
      renameBtn.className = 'session-list-item-rename';
      renameBtn.title = '重命名会话';
      renameBtn.textContent = '✏';
      renameBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.sessionRenameCallback?.(session.id);
      });
      li.appendChild(renameBtn);

      li.addEventListener('click', () => {
        this.toggleSessionDropdown();
        this.sessionSwitchCallback?.(session.id);
      });

      list.appendChild(li);
    }
  }

  /**
   * FD-08 过滤会话列表
   *
   * 根据搜索关键词过滤显示/隐藏会话列表项。
   * 匹配规则：会话名、日期或预览内容包含关键词（忽略大小写）。
   * P3-FLOW-03 扩展搜索范围：增加 preview 匹配，支持按消息内容关键词查找会话
   */
  private filterSessionList(query: string): void {
    const items = document.querySelectorAll('#session-list .session-list-item');
    const q = query.toLowerCase().trim();

    items.forEach((item) => {
      const el = item as HTMLElement;
      const name = (el.querySelector('.session-list-item-name') as HTMLElement | null)?.textContent ?? '';
      const date = (el.querySelector('.session-list-item-date') as HTMLElement | null)?.textContent ?? '';
      // P3-FLOW-03 增加预览内容匹配
      const preview = (el.querySelector('.session-list-item-preview') as HTMLElement | null)?.textContent ?? '';

      if (q === '' || name.toLowerCase().includes(q) || date.includes(q) || preview.toLowerCase().includes(q)) {
        el.style.display = '';
      } else {
        el.style.display = 'none';
      }
    });
  }
}