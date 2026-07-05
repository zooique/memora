/**
 * 用户画像面板管理器（用户画像闭环）
 *
 * 职责：
 *   - 加载用户画像条目（已确认 + 待确认）并渲染到设置面板的"画像"tab
 *   - 待确认条目：提供"确认/拒绝"按钮，确认后持久化到 SQLite
 *   - 已确认条目：提供"删除"按钮（调用 reject 接口移除）
 *   - 刷新按钮：重新拉取最新画像数据
 *
 * 设计原则：
 *   - 独立子模块，UIManager 通过组合持有（与 SuggestionCardManager / ProactiveBanner 同模式）
 *   - 事件监听器纳入 EventTracker 跟踪集合，cleanup 时统一清理
 *   - 渲染使用 textContent（防 XSS），不使用 innerHTML
 *   - 类别标签颜色区分，提升视觉识别度
 */

import type { UserProfileEntryPayload } from '../../preload.js';
import { EventTracker } from '../helpers/eventTracker.js';
import { reportError, toError } from '../helpers/errorHelpers.js';
import { clearElement, formatTimeAgo, getOptionalElement, setButtonLoadingEl } from '../helpers/domHelpers.js';

/**
 * 用户画像面板管理器
 *
 * 管理"画像"tab 的加载、渲染和确认/拒绝操作。
 * UIManager 通过组合持有此实例，并在切换到"画像"tab 时调用 load()。
 */
export class ProfilePanelManager {
  /** 事件监听器跟踪器（统一管理事件监听器的注册与清理，避免内存泄漏） */
  private events = new EventTracker();
  /** 待确认列表容器 */
  private pendingListEl: HTMLElement | null = null;
  /** 已确认列表容器 */
  private confirmedListEl: HTMLElement | null = null;
  /** 待确认计数元素 */
  private pendingCountEl: HTMLElement | null = null;
  /** 已确认计数元素 */
  private confirmedCountEl: HTMLElement | null = null;
  /** 刷新按钮 */
  private refreshBtn: HTMLButtonElement | null = null;
  /** 是否已初始化（避免重复绑定事件） */
  private initialized = false;

  /**
   * 类别标签中文映射
   *
   * 用于将英文类别 key 转换为用户可读的中文标签。
   */
  private static readonly CATEGORY_LABELS: Record<string, string> = {
    identity: '身份',
    preference: '偏好',
    expertise: '专长',
    habit: '习惯',
    history: '历史',
  };

  /**
   * 初始化画像面板管理器
   *
   * 获取 DOM 元素引用并绑定刷新按钮事件。
   * 在 UIManager 构造时调用。
   */
  init(): void {
    if (this.initialized) return;
    this.initialized = true;

    // 获取 DOM 元素引用（均为可选，缺失时静默降级）
    this.pendingListEl = document.getElementById('profile-pending-list');
    this.confirmedListEl = document.getElementById('profile-confirmed-list');
    this.pendingCountEl = document.getElementById('profile-pending-count');
    this.confirmedCountEl = document.getElementById('profile-confirmed-count');
    this.refreshBtn = getOptionalElement('btn-profile-refresh', 'button');

    // 绑定刷新按钮事件
    if (this.refreshBtn) {
      this.events.addEventListener(this.refreshBtn, 'click', () => {
        void this.load();
      });
    }
  }

  /**
   * 加载用户画像数据并渲染
   *
   * 调用 listUserProfile IPC 获取已确认 + 待确认条目，
   * 按 confirmed 字段分组渲染到对应列表。
   * 失败时显示错误提示（不阻塞面板其他功能）。
   */
  async load(): Promise<void> {
    try {
      const { entries } = await window.electronAPI.listUserProfile();
      this.render(entries);
    } catch (err) {
      reportError('ProfilePanel', `加载用户画像失败: ${toError(err).message}`);
      // 在待确认区显示错误提示
      if (this.pendingListEl) {
        // Q9 使用 clearElement 工具函数替代手写 while+removeChild
        clearElement(this.pendingListEl);
        const errorEl = document.createElement('div');
        errorEl.className = 'profile-empty profile-error';
        errorEl.textContent = '加载失败，请点击刷新重试';
        this.pendingListEl.appendChild(errorEl);
      }
    }
  }

  /**
   * 渲染画像条目到对应列表
   *
   * @param entries 画像条目数组（已确认 + 待确认混合）
   */
  private render(entries: UserProfileEntryPayload[]): void {
    // 按确认状态分组
    const pending = entries.filter((e) => !e.confirmed);
    const confirmed = entries.filter((e) => e.confirmed);

    // 更新计数
    if (this.pendingCountEl) this.pendingCountEl.textContent = String(pending.length);
    if (this.confirmedCountEl) this.confirmedCountEl.textContent = String(confirmed.length);

    // 渲染待确认列表
    this.renderList(this.pendingListEl, pending, true);
    // 渲染已确认列表
    this.renderList(this.confirmedListEl, confirmed, false);
  }

  /**
   * 渲染单个列表（待确认或已确认）
   *
   * @param container 列表容器元素
   * @param entries 条目数组
   * @param isPending 是否为待确认列表（决定按钮文案：确认/拒绝 vs 删除）
   */
  private renderList(
    container: HTMLElement | null,
    entries: UserProfileEntryPayload[],
    isPending: boolean,
  ): void {
    if (!container) return;

    // Q9 使用 clearElement 工具函数替代手写 while+removeChild
    clearElement(container);

    // 空列表提示
    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'profile-empty';
      empty.textContent = isPending ? '暂无待确认条目' : '暂无已确认条目';
      container.appendChild(empty);
      return;
    }

    // 渲染每条画像
    for (const entry of entries) {
      const card = this.createEntryCard(entry, isPending);
      container.appendChild(card);
    }
  }

  /**
   * 创建画像条目卡片 DOM 元素
   *
   * 卡片结构：
   *   <div class="profile-card">
   *     <div class="profile-card-header">
   *       <span class="profile-category profile-category-{type}">{类别}</span>
   *       <span class="profile-source">来源: {source}</span>
   *       <span class="profile-updated">{updatedAt}</span>
   *     </div>
   *     <div class="profile-value">{value}</div>
   *     <div class="profile-actions">
   *       <button class="profile-btn accept">确认</button>
   *       <button class="profile-btn reject">拒绝</button>
   *     </div>
   *   </div>
   */
  private createEntryCard(entry: UserProfileEntryPayload, isPending: boolean): HTMLElement {
    const card = document.createElement('div');
    card.className = 'profile-card';
    card.dataset.entryId = entry.id;

    // 头部：类别标签 + 来源 + 更新时间
    const header = document.createElement('div');
    header.className = 'profile-card-header';

    const categoryLabel = ProfilePanelManager.CATEGORY_LABELS[entry.category] ?? entry.category;
    const categorySpan = document.createElement('span');
    categorySpan.className = `profile-category profile-category-${entry.category}`;
    categorySpan.textContent = categoryLabel;
    header.appendChild(categorySpan);

    const sourceSpan = document.createElement('span');
    sourceSpan.className = 'profile-source';
    sourceSpan.textContent = `来源: ${entry.source}`;
    header.appendChild(sourceSpan);

    const updatedSpan = document.createElement('span');
    updatedSpan.className = 'profile-updated';
    updatedSpan.textContent = formatTimeAgo(entry.updatedAt);
    header.appendChild(updatedSpan);

    card.appendChild(header);

    // 画像值
    const valueDiv = document.createElement('div');
    valueDiv.className = 'profile-value';
    valueDiv.textContent = entry.value;
    card.appendChild(valueDiv);

    // 操作按钮
    const actions = document.createElement('div');
    actions.className = 'profile-actions';

    if (isPending) {
      // 待确认条目：确认 + 拒绝
      const confirmBtn = document.createElement('button');
      confirmBtn.className = 'profile-btn accept';
      confirmBtn.textContent = '确认';
      this.events.addEventListener(confirmBtn, 'click', async () => {
        // 复用 setButtonLoadingEl，与全项目 loading 模式一致
        setButtonLoadingEl(confirmBtn, true, '处理中...');
        const rejectBtn = actions.querySelector<HTMLButtonElement>('.reject');
        if (rejectBtn) rejectBtn.disabled = true;
        try {
          await window.electronAPI.confirmUserProfile(entry.id);
          // 确认成功后移除卡片（已确认列表会在下次 load 时更新）
          card.remove();
        } catch (err) {
          reportError('ProfilePanel', `确认画像失败: ${toError(err).message}`);
          setButtonLoadingEl(confirmBtn, false);
          if (rejectBtn) rejectBtn.disabled = false;
        }
      });
      actions.appendChild(confirmBtn);

      const rejectBtn = document.createElement('button');
      rejectBtn.className = 'profile-btn reject';
      rejectBtn.textContent = '拒绝';
      this.events.addEventListener(rejectBtn, 'click', async () => {
        // 复用 setButtonLoadingEl
        setButtonLoadingEl(rejectBtn, true, '处理中...');
        confirmBtn.disabled = true;
        try {
          await window.electronAPI.rejectUserProfile(entry.id);
          card.remove();
        } catch (err) {
          reportError('ProfilePanel', `拒绝画像失败: ${toError(err).message}`);
          setButtonLoadingEl(rejectBtn, false);
          confirmBtn.disabled = false;
        }
      });
      actions.appendChild(rejectBtn);
    } else {
      // 已确认条目：删除（调用 reject 接口移除）
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'profile-btn reject';
      deleteBtn.textContent = '删除';
      this.events.addEventListener(deleteBtn, 'click', async () => {
        // 复用 setButtonLoadingEl
        setButtonLoadingEl(deleteBtn, true, '删除中...');
        try {
          await window.electronAPI.rejectUserProfile(entry.id);
          card.remove();
        } catch (err) {
          reportError('ProfilePanel', `删除画像失败: ${toError(err).message}`);
          setButtonLoadingEl(deleteBtn, false);
        }
      });
      actions.appendChild(deleteBtn);
    }

    card.appendChild(actions);
    return card;
  }

  /** 清理所有事件监听器（UIManager.cleanup 时调用） */
  cleanup(): void {
    this.events.cleanup();
  }
}
