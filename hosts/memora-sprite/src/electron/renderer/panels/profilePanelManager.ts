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
import { clearElement, createEl, formatTimeAgo, getOptionalElement, setButtonLoadingEl } from '../helpers/domHelpers.js';
// getSourceLabel 将 source 字符串映射为中文标签（UX-2：画像条目来源中文化）
import { getSourceLabel } from '../helpers/sourceLabel.js';
// bindRefreshButton 统一"刷新按钮 → loading → 异步操作"绑定模式
import { bindRefreshButton } from '../helpers/buttonHelpers.js';
// renderErrorState 统一面板错误态渲染（图标 + 文字 + 重试按钮），3 处面板共用
import { renderErrorState } from '../helpers/errorState.js';
import type { ConfirmDialogOptions } from '../types.js';

/**
 * 确认对话框函数类型（由 UIManager 注入，用于删除已确认画像前的二次确认）
 */
type ConfirmDialogFn = (options: ConfirmDialogOptions) => Promise<boolean>;

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
  /** 确认对话框函数（由 UIManager 注入，用于删除已确认画像的二次确认） */
  private confirmDialog: ConfirmDialogFn | null = null;
  /** 确认画像回调（由 settingsController 注入） */
  private onConfirmProfile: ((id: string) => Promise<void>) | null = null;
  /** 拒绝/删除画像回调（由 settingsController 注入） */
  private onRejectProfile: ((id: string) => Promise<void>) | null = null;

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
   *
   * @param confirmDialog 确认对话框函数（可选，注入后删除已确认画像前弹二次确认）
   */
  init(confirmDialog?: ConfirmDialogFn): void {
    if (this.initialized) return;
    this.initialized = true;
    this.confirmDialog = confirmDialog ?? null;

    // 获取 DOM 元素引用（均为可选，缺失时静默降级）
    this.pendingListEl = document.getElementById('profile-pending-list');
    this.confirmedListEl = document.getElementById('profile-confirmed-list');
    this.pendingCountEl = document.getElementById('profile-pending-count');
    this.confirmedCountEl = document.getElementById('profile-confirmed-count');
    this.refreshBtn = getOptionalElement('btn-profile-refresh', 'button');

    // 绑定刷新按钮事件（带 loading 反馈，与 audit/workProjection 面板统一交互模式）
    bindRefreshButton(this.refreshBtn, this.events, () => this.load());
  }

  /**
   * 加载用户画像数据并渲染
   *
   * 调用 listUserProfile IPC 获取已确认 + 待确认条目，
   * 按 confirmed 字段分组渲染到对应列表。
   * 失败时显示错误提示（不阻塞面板其他功能）。
   */
  async load(): Promise<void> {
    // try 仅包裹 IPC 调用（IO），render（DOM 渲染）移出 try，
    // 避免 render 抛出的 DOM 错误被误当成 IO 错误处理
    let entries: UserProfileEntryPayload[];
    try {
      const result = await window.electronAPI.listUserProfile();
      entries = result.entries;
    } catch (err) {
      reportError('ProfilePanel', `加载用户画像失败: ${toError(err).message}`);
      // 统一用 .error-state 结构（图标 + 文字 + 重试按钮），renderErrorState 公共函数
      if (this.pendingListEl) {
        renderErrorState(this.pendingListEl, '加载用户画像失败', () => this.load(), this.events);
      }
      return; // IO 失败后不执行 render
    }
    this.render(entries);
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

    // 使用 clearElement 工具函数清空容器
    clearElement(container);

    // 空列表提示
    if (entries.length === 0) {
      container.appendChild(createEl('div', 'profile-empty', isPending ? '暂无待确认条目' : '暂无已确认条目'));
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
    categorySpan.className = `profile-category profile-category-${entry.category} flex-shrink-0`;
    categorySpan.textContent = categoryLabel;
    header.appendChild(categorySpan);

    const sourceSpan = document.createElement('span');
    sourceSpan.className = 'profile-source';
    sourceSpan.textContent = `来源: ${getSourceLabel(entry.source)}`;
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
      confirmBtn.className = 'btn-primary profile-btn accept';
      confirmBtn.textContent = '确认';
      this.events.addEventListener(confirmBtn, 'click', async () => {
        // 复用 setButtonLoadingEl，与全项目 loading 模式一致
        setButtonLoadingEl(confirmBtn, true, '处理中…');
        const rejectBtn = actions.querySelector<HTMLButtonElement>('.reject');
        if (rejectBtn) rejectBtn.disabled = true;
        try {
          await this.onConfirmProfile!(entry.id);
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
      rejectBtn.className = 'btn-secondary profile-btn reject';
      rejectBtn.textContent = '拒绝';
      this.events.addEventListener(rejectBtn, 'click', async () => {
        // 复用 setButtonLoadingEl
        setButtonLoadingEl(rejectBtn, true, '处理中…');
        confirmBtn.disabled = true;
        try {
          await this.onRejectProfile!(entry.id);
          card.remove();
        } catch (err) {
          reportError('ProfilePanel', `拒绝画像失败: ${toError(err).message}`);
          setButtonLoadingEl(rejectBtn, false);
          confirmBtn.disabled = false;
        }
      });
      actions.appendChild(rejectBtn);
    } else {
      // 已确认条目：删除（调用 reject 接口移除，二次确认避免误删已持久化画像）
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'btn-secondary profile-btn reject';
      deleteBtn.textContent = '删除';
      this.events.addEventListener(deleteBtn, 'click', async () => {
        // 二次确认：已确认画像已持久化到 SQLite，删除属不可逆操作
        if (this.confirmDialog) {
          const confirmed = await this.confirmDialog({
            title: '删除用户画像',
            message: '将删除这条用户画像，精灵后续对话将不再参考。确认删除？',
            confirmText: '删除',
            cancelText: '取消',
            danger: true,
          });
          if (!confirmed) return;
        }
        // 复用 setButtonLoadingEl
        setButtonLoadingEl(deleteBtn, true, '删除中…');
        try {
          await this.onRejectProfile!(entry.id);
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

  /**
   * 设置确认画像回调（由 settingsController 注入）
   *
   * @param cb 确认回调（接收画像 id，async 成功后 PanelManager 自动移除卡片）
   */
  setConfirmProfileCallback(cb: (id: string) => Promise<void>): void {
    this.onConfirmProfile = cb;
  }

  /**
   * 设置拒绝/删除画像回调（由 settingsController 注入）
   *
   * @param cb 拒绝回调（接收画像 id，async 成功后 PanelManager 自动移除卡片）
   */
  setRejectProfileCallback(cb: (id: string) => Promise<void>): void {
    this.onRejectProfile = cb;
  }

  /** 清理所有事件监听器（UIManager.cleanup 时调用） */
  cleanup(): void {
    this.events.cleanup();
  }
}
