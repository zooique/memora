/**
 * 剪贴板面板管理器 — UI 渲染层
 *
 * 职责：
 * - 渲染待处理条目列表（预览 + 长度 + 时间 + 较旧标签 + 操作按钮）
 * - 角标更新（数量 0 隐藏 / 1-99 数字 / >99 显示 99+ / 较旧变警告色）
 * - 空状态切换（列表为空时显示引导，有内容时隐藏）
 * - 批量操作按钮显隐（列表为空时隐藏）
 * - 首次引导气泡（一次性，点击关闭后 localStorage 记录不再出现）
 * - 单条归档（乐观移除 + 触发 clipboardAnalyze）
 * - 批量归档（二次确认 + 清空列表 + 触发 clipboardAnalyze）
 * - 单条忽略（removePendingItem）
 * - 批量忽略（二次确认 + clearPendingItems）
 *
 * 设计原则：
 * - 单向依赖：clipboardPanelManager 依赖 ClipboardManager（数据层），反向不可见
 * - onChange 回调：通过 ClipboardManager.setOnChange 注入 refresh，数据变更自动刷新
 * - DOM 操作集中：本类负责所有剪贴板面板 DOM 操作，ClipboardManager 不操作 DOM
 * - 事件统一管理：通过 EventTracker 跟踪所有事件监听器，cleanup 时统一清理
 */

import { getOptionalElement, clearElement, createEl, formatTimeAgo } from '../helpers/domHelpers.js';
// 渲染进程统一日志入口（替代散落的 console.error/warn）
import { reportError } from '../helpers/errorHelpers.js';
import type { EventTracker } from '../helpers/eventTracker.js';
import type { ConfirmDialogOptions, ToastType } from '../types.js';
// 剪贴板数据/状态层（ClipboardPanelManager 依赖其 API，单向依赖）
import type { ClipboardManager } from './clipboardManager.js';
import { BADGE_MAX_DISPLAY } from './clipboardManager.js';
import type { ClipboardPendingItem } from './clipboardManager.js';

// ─── 常量 ───────────────────────────────────────────────

/**
 * 首次引导气泡 localStorage 键名（一次性引导，关闭后不再出现）
 *
 * 权衡说明（STEP6-2 评估结论：保留 localStorage）：
 * - 这是 UI 一次性提示状态（非用户数据），最坏情况是 localStorage 不可用时气泡再次显示，零数据风险
 * - 已有 try-catch 降级路径，localStorage 抛错时仅影响气泡显隐，不阻塞功能
 * - 迁移到主进程 spriteConfig 需改 spriteConfig.ts / preload.ts / configHandlers.ts / ADR-SP-002，
 *   且 toggleOnboardingTip 是同步方法被 refresh() 同步调用，改 IPC 异步会破坏 refresh 同步链路
 * - 与 OnboardingManager.shouldShowOnboarding（基于 Provider 真理源）不同，这是纯 UI 提示，
 *   不需要绝对可靠的真理源
 * - 符合 ADR-017 枝叶层原则：避免为单次 UI 提示引入跨进程配置开销
 */
const ONBOARDING_DISMISSED_KEY = 'memora:clipboard-onboarding-dismissed';

// ─── Host 接口（跨模块关注点注入） ────────────────────────

/** 剪贴板面板管理器需要的宿主能力（由 UIManager 注入） */
export interface ClipboardPanelHost {
  /** 显示确认对话框（批量归档/忽略前的二次确认） */
  showConfirmDialog(options: ConfirmDialogOptions): Promise<boolean>;
  /** 显示 toast 通知（操作反馈） */
  showToast(message: string, type?: ToastType, duration?: number): void;
}

// ─── ClipboardPanelManager 类 ─────────────────────────

/**
 * 剪贴板面板管理器类（UI 渲染层）
 *
 * 生命周期：
 * - 构造函数：注入 ClipboardManager + Host + EventTracker
 * - init()：绑定 DOM 元素 + 注册事件监听器 + 注入 onChange 回调
 * - refresh()：由 ClipboardManager.onChange 触发，重新渲染列表 + 角标
 * - cleanup()：清理事件监听器 + 移除 onChange 引用
 */
export class ClipboardPanelManager {
  // ─── DOM 元素引用（init 时查找，可能为 null） ──────────
  /** 待处理列表容器（动态渲染条目） */
  private listEl: HTMLElement | null = null;
  /** 空状态容器（列表为空时显示） */
  private emptyStateEl: HTMLElement | null = null;
  /** 导航角标元素（显示待处理数量） */
  private navBadgeEl: HTMLElement | null = null;
  /** 批量操作按钮容器（列表为空时隐藏） */
  private actionsEl: HTMLElement | null = null;
  /** 首次引导气泡容器（一次性，关闭后不再显示） */
  private onboardingTipEl: HTMLElement | null = null;

  // ─── 依赖注入 ────────────────────────────────────────
  /**
   * 构造函数注入 ClipboardManager（数据层）
   *
   * 设计理由：ClipboardPanelManager 依赖 ClipboardManager 的 API（getPendingItems 等），
   * 但 ClipboardManager 不依赖 ClipboardPanelManager（通过 onChange 回调解耦）。
   */
  constructor(
    private clipboardManager: ClipboardManager,
    private host: ClipboardPanelHost,
    private events: EventTracker,
  ) {}

  // ─── 初始化 ────────────────────────────────────────

  /**
   * 初始化剪贴板面板管理器
   *
   * 步骤：
   * 1. 查找 DOM 元素引用（缺失时降级，不阻塞其他功能）
   * 2. 绑定批量操作按钮 + 引导关闭按钮事件
   * 3. 注入 onChange 回调到 ClipboardManager（数据变更自动刷新）
   * 4. 首次渲染（同步当前状态）
   * 5. 显示首次引导气泡（如果未关闭过且有待处理内容）
   */
  init(): void {
    // 查找 DOM 元素（可选，缺失时降级）
    this.listEl = document.getElementById('clipboard-pending-list');
    this.emptyStateEl = document.getElementById('clipboard-empty-state');
    this.navBadgeEl = document.getElementById('clipboard-nav-badge');
    this.actionsEl = document.getElementById('clipboard-actions') ?? this.resolveActionsContainer();
    this.onboardingTipEl = document.getElementById('clipboard-onboarding-tip');

    // 绑定批量操作按钮（可选，缺失时降级）
    this.bindBatchActions();
    // 绑定首次引导关闭按钮
    this.bindOnboardingClose();

    // 注入 onChange 回调：ClipboardManager 状态变更时自动触发 refresh
    this.clipboardManager.setOnChange(() => this.refresh());

    // 首次渲染（同步当前状态，可能为空列表）
    this.refresh();
  }

  // ─── 资源清理 ──────────────────────────────────────────

  /**
   * 清理资源
   *
   * - 清理事件监听器（通过 EventTracker 统一管理）
   * - 不清理 ClipboardManager 的 onChange（由 ClipboardManager.cleanup 自行处理）
   */
  cleanup(): void {
    this.events.cleanup();
  }

  // ─── 渲染 ────────────────────────────────────────────

  /**
   * 刷新面板（由 ClipboardManager.onChange 触发，或外部主动调用）
   *
   * 步骤：
   * 1. 读取最新待处理列表
   * 2. 渲染列表条目（或清空）
   * 3. 切换空状态显隐
   * 4. 切换批量操作按钮显隐
   * 5. 更新导航角标（数量 + 较旧态）
   * 6. 刷新较旧标记（将 >24h 的条目标记为 isStale）
   * 7. 首次引导气泡显隐（有待处理内容且未关闭过时显示）
   */
  refresh(): void {
    // 刷新较旧标记（检测 >24h 的条目）
    this.clipboardManager.refreshStaleFlags();

    const items = this.clipboardManager.getPendingItems();
    const count = items.length;

    // 渲染列表
    this.renderList(items);

    // 切换空状态显隐
    this.toggleEmptyState(count === 0);

    // 切换批量操作按钮显隐
    this.toggleActionsVisibility(count === 0);

    // 更新导航角标（未查看计数，非总条目数）
    this.updateBadge(this.clipboardManager.getUnviewedCount(), this.clipboardManager.hasStaleItem());

    // 首次引导气泡显隐
    this.toggleOnboardingTip(count > 0);
  }

  /**
   * 渲染待处理列表
   *
   * 清空列表容器后，按倒序（最新在最前）渲染每条条目。
   * ClipboardManager 已经维护倒序，此处直接遍历。
   *
   * @param items 待处理条目数组
   */
  private renderList(items: readonly ClipboardPendingItem[]): void {
    if (!this.listEl) return;
    clearElement(this.listEl);

    for (const item of items) {
      const itemEl = this.createItemElement(item);
      this.listEl.appendChild(itemEl);
    }
  }

  /**
   * 创建单条待处理条目 DOM 元素
   *
   * 结构：
   * ```html
   * <div class="clipboard-pending-item [clipboard-item-stale]" role="listitem">
   *   <div class="clipboard-item-preview">{preview}</div>
   *   <div class="clipboard-item-meta">
   *     <span class="clipboard-item-length">{length}字</span>
   *     <span class="clipboard-item-time">{timeAgo}</span>
   *     [<span class="clipboard-item-stale-tag">较旧</span>]
   *     <div class="clipboard-item-actions">
   *       <button class="clipboard-item-btn clipboard-item-btn-archive">归档</button>
   *       <button class="clipboard-item-btn clipboard-item-btn-ignore">忽略</button>
   *     </div>
   *   </div>
   * </div>
   * ```
   *
   * @param item 待处理条目数据
   * @returns 条目 DOM 元素
   */
  private createItemElement(item: ClipboardPendingItem): HTMLElement {
    // 条目根容器（较旧态追加 clipboard-item-stale 类）
    const itemEl = createEl('div', 'clipboard-pending-item');
    itemEl.setAttribute('role', 'listitem');
    itemEl.dataset.id = item.id;
    if (item.isStale) {
      itemEl.classList.add('clipboard-item-stale');
    }

    // 预览文本（前 100 字符，单行截断）
    const previewEl = createEl('div', 'clipboard-item-preview', item.preview);
    itemEl.appendChild(previewEl);

    // 元信息行：长度 + 时间 + [较旧标签] + 操作按钮
    const metaEl = createEl('div', 'clipboard-item-meta');

    // 长度标签
    const lengthEl = createEl('span', 'clipboard-item-length', `${item.length}字`);
    metaEl.appendChild(lengthEl);

    // 时间标签（相对时间，如"刚刚"/"3分钟前"，复用 domHelpers.formatTimeAgo 统一入口）
    // data-timestamp 保留原始时间戳，供 timeRefresher 在窗口恢复焦点时统一刷新
    const detectedIso = new Date(item.detectedAt).toISOString();
    const timeEl = createEl('span', 'clipboard-item-time', formatTimeAgo(detectedIso));
    timeEl.dataset.timestamp = detectedIso;
    metaEl.appendChild(timeEl);

    // 较旧标签（>24h 时显示）
    if (item.isStale) {
      const staleTag = createEl('span', 'clipboard-item-stale-tag', '较旧');
      metaEl.appendChild(staleTag);
    }

    // 操作按钮容器（复制 + 归档 + 忽略）
    const actionsEl = createEl('div', 'clipboard-item-actions');

    // 复制按钮（将 preview 写回 OS 剪贴板）
    const copyBtn = createEl('button', 'clipboard-item-btn clipboard-item-btn-copy');
    copyBtn.type = 'button';
    copyBtn.title = '复制到剪贴板';
    copyBtn.setAttribute('aria-label', '复制到剪贴板');
    copyBtn.innerHTML = '<svg class="icon"><use href="#icon-copy"/></svg>';
    this.events.addEventListener(copyBtn, 'click', () => this.handleCopyItem(item.content));
    actionsEl.appendChild(copyBtn);

    // 归档按钮（乐观移除 + 触发 clipboardAnalyze）
    const archiveBtn = createEl('button', 'clipboard-item-btn clipboard-item-btn-archive');
    archiveBtn.type = 'button';
    archiveBtn.title = '归档为记忆';
    archiveBtn.setAttribute('aria-label', '归档为记忆');
    archiveBtn.innerHTML = '<svg class="icon"><use href="#icon-check"/></svg>';
    this.events.addEventListener(archiveBtn, 'click', () => this.handleArchiveItem(item.id));
    actionsEl.appendChild(archiveBtn);

    // 忽略按钮（从列表移除，不归档）
    const ignoreBtn = createEl('button', 'clipboard-item-btn clipboard-item-btn-ignore');
    ignoreBtn.type = 'button';
    ignoreBtn.title = '忽略此条';
    ignoreBtn.setAttribute('aria-label', '忽略此条');
    ignoreBtn.innerHTML = '<svg class="icon"><use href="#icon-close"/></svg>';
    this.events.addEventListener(ignoreBtn, 'click', () => this.handleIgnoreItem(item.id));
    actionsEl.appendChild(ignoreBtn);

    metaEl.appendChild(actionsEl);
    itemEl.appendChild(metaEl);

    return itemEl;
  }

  // ─── 单条操作 ────────────────────────────────────────

  /**
   * 处理单条归档按钮点击
   *
   * 策略：乐观移除 + 触发 clipboardAnalyze
   * - 立即从列表移除条目（视觉反馈即时）
   * - 调用 clipboardAnalyze 触发主进程读取剪贴板 + 敏感检测 + 护栏检查
   * - 主进程通过 emit('analysis-ready') 反馈，由 ipcListeners 调用 showClipboardConfirmDialog
   * - 如果用户在对话框取消，条目已移除（用户可重新复制触发）
   * - 如果分析失败（敏感/护栏），toast 会提示用户
   *
   * 设计理由：剪贴板只存储最新内容，归档"某条历史条目"的语义实际上等于"归档当前剪贴板内容"。
   *           乐观移除让用户感知"点击归档后条目消失"，符合直觉。
   *
   * @param id 待归档条目 ID
   */
  private async handleArchiveItem(id: string): Promise<void> {
    // 乐观移除条目（视觉反馈即时）
    this.clipboardManager.removePendingItem(id);
    await this.triggerArchiveAnalyze();
  }

  /**
   * 触发主进程剪贴板分析（读取 + 敏感检测 + 护栏检查），统一处理失败反馈
   *
   * 提取自 handleArchiveItem / handleArchiveAll 的重复 try/catch + reportError + showToast 模式
   * （ADR-017 枝叶层 2 次提取原则）。
   *
   * 通过后由 ipcListeners 调用 showClipboardConfirmDialog 显示确认对话框。
   */
  private async triggerArchiveAnalyze(): Promise<void> {
    try {
      await window.electronAPI.clipboardAnalyze();
    } catch (error) {
      reportError('ClipboardPanelManager.triggerArchiveAnalyze', error);
      this.host.showToast('归档失败，请稍后重试', 'error');
    }
  }

  /**
   * 处理单条忽略按钮点击
   *
   * 从列表移除条目，不触发归档流程。
   *
   * @param id 待忽略条目 ID
   */
  /**
   * 处理复制按钮点击——将条目内容写回 OS 剪贴板
   *
   * 使用 navigator.clipboard.writeText() 写入完整内容（非 preview 截断）。
   * ClipboardHandler 检测到变化后通过 CLIPBOARD_CHANGED IPC 通知渲染层，
   * addPendingItem 的去重逻辑会将同名条目移到列表顶部，不创建重复，不增加未查看计数。
   */
  private async handleCopyItem(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 剪贴板写入失败（如权限被拒绝），静默降级不弹 toast
    }
  }

  private handleIgnoreItem(id: string): void {
    this.clipboardManager.removePendingItem(id);
  }

  // ─── 批量操作 ────────────────────────────────────────

  /**
   * 绑定批量操作按钮事件
   *
   * - 全部归档按钮：弹出二次确认 → 清空列表 + 触发 clipboardAnalyze
   * - 全部忽略按钮：弹出二次确认 → 清空列表
   */
  private bindBatchActions(): void {
    const archiveAllBtn = getOptionalElement('btn-clipboard-archive-all', 'button');
    if (archiveAllBtn) {
      this.events.addEventListener(archiveAllBtn, 'click', () => this.handleArchiveAll());
    }

    const ignoreAllBtn = getOptionalElement('btn-clipboard-ignore-all', 'button');
    if (ignoreAllBtn) {
      this.events.addEventListener(ignoreAllBtn, 'click', () => this.handleIgnoreAll());
    }
  }

  /**
   * 处理"全部归档"按钮点击
   *
   * 策略：二次确认 → 清空列表 + 触发 clipboardAnalyze
   *
   * 对话框文案明确告知用户"仅当前剪贴板内容会被归档为记忆，历史条目将被清空"，
   * 避免用户误解为"列表中所有条目都会被写入记忆"。
   */
  private async handleArchiveAll(): Promise<void> {
    const confirmed = await this.host.showConfirmDialog({
      title: '全部归档',
      message: '将归档当前剪贴板内容为记忆，并清空待处理列表。注意：仅当前剪贴板内容会被归档，历史条目将被清空。',
      confirmText: '归档并清空',
      cancelText: '取消',
    });
    if (!confirmed) return;

    // 清空待处理列表（视觉反馈即时）
    this.clipboardManager.clearPendingItems();
    await this.triggerArchiveAnalyze();
  }

  /**
   * 处理"全部忽略"按钮点击
   *
   * 策略：二次确认 → 清空列表
   */
  private async handleIgnoreAll(): Promise<void> {
    const confirmed = await this.host.showConfirmDialog({
      title: '全部忽略',
      message: '确定要忽略所有待处理内容吗？此操作不可撤销。',
      confirmText: '全部忽略',
      cancelText: '取消',
      danger: true,
    });
    if (!confirmed) return;

    this.clipboardManager.clearPendingItems();
    this.host.showToast('已清空待处理列表', 'success');
  }

  // ─── 首次引导气泡 ────────────────────────────────────

  /**
   * 绑定首次引导关闭按钮事件
   *
   * 点击关闭后 localStorage 记录 dismissed=true，不再显示。
   */
  private bindOnboardingClose(): void {
    const closeBtn = document.getElementById('clipboard-onboarding-close');
    if (closeBtn) {
      this.events.addEventListener(closeBtn, 'click', () => this.dismissOnboarding());
    }
  }

  /**
   * 关闭首次引导气泡（记录到 localStorage）
   */
  private dismissOnboarding(): void {
    try {
      localStorage.setItem(ONBOARDING_DISMISSED_KEY, '1');
    } catch {
      // localStorage 不可用时降级：仅隐藏当前会话的气泡
    }
    this.toggleOnboardingTip(false);
  }

  /**
   * 切换首次引导气泡显隐
   *
   * 显示条件：有待处理内容 + 未关闭过（localStorage 无记录）
   * 隐藏条件：无待处理内容 或 已关闭过
   *
   * @param hasItems 是否有待处理内容
   */
  private toggleOnboardingTip(hasItems: boolean): void {
    if (!this.onboardingTipEl) return;

    if (!hasItems) {
      this.onboardingTipEl.classList.add('hidden');
      return;
    }

    // 检查 localStorage 是否已关闭过
    let dismissed = false;
    try {
      dismissed = localStorage.getItem(ONBOARDING_DISMISSED_KEY) === '1';
    } catch {
      // localStorage 不可用时降级：视为未关闭过
    }

    if (dismissed) {
      this.onboardingTipEl.classList.add('hidden');
    } else {
      this.onboardingTipEl.classList.remove('hidden');
    }
  }

  // ─── 角标更新 ────────────────────────────────────────

  /**
   * 更新导航角标显示
   *
   * 规则：
   * - count=0：隐藏角标
   * - 1≤count≤99：显示数字
   * - count>99：显示 "99+"
   * - hasStale=true：追加 clipboard-nav-badge-stale 类（背景变警告色）
   *
   * @param count 待处理数量
   * @param hasStale 是否存在较旧条目
   */
  private updateBadge(count: number, hasStale: boolean): void {
    if (!this.navBadgeEl) return;

    if (count === 0) {
      // 无待处理：隐藏角标
      this.navBadgeEl.classList.add('nav-badge-hidden');
      this.navBadgeEl.classList.remove('nav-badge-stale');
      this.navBadgeEl.textContent = '';
      return;
    }

    // 显示角标
    this.navBadgeEl.classList.remove('nav-badge-hidden');
    if (hasStale) {
      this.navBadgeEl.classList.add('nav-badge-stale');
    } else {
      this.navBadgeEl.classList.remove('nav-badge-stale');
    }

    // 数量显示
    if (count > BADGE_MAX_DISPLAY) {
      this.navBadgeEl.textContent = '99+';
    } else {
      this.navBadgeEl.textContent = String(count);
    }
  }

  // ─── 显隐切换 ────────────────────────────────────────

  /**
   * 切换空状态显隐
   *
   * 列表为空时显示空状态引导，有内容时隐藏。
   *
   * @param isEmpty 列表是否为空
   */
  private toggleEmptyState(isEmpty: boolean): void {
    if (!this.emptyStateEl) return;
    if (isEmpty) {
      this.emptyStateEl.classList.remove('hidden');
    } else {
      this.emptyStateEl.classList.add('hidden');
    }
  }

  /**
   * 切换批量操作按钮容器显隐
   *
   * 列表为空时隐藏批量操作按钮（避免无目标操作）。
   *
   * @param isEmpty 列表是否为空
   */
  private toggleActionsVisibility(isEmpty: boolean): void {
    if (!this.actionsEl) return;
    if (isEmpty) {
      this.actionsEl.classList.add('clipboard-actions-hidden');
    } else {
      this.actionsEl.classList.remove('clipboard-actions-hidden');
    }
  }

  // ─── 工具方法 ────────────────────────────────────────

  /**
   * 解析批量操作按钮容器（兜底查找）
   *
   * init 时优先通过 id 查找，缺失时通过 class 查找。
   *
   * @returns 批量操作容器元素或 null
   */
  private resolveActionsContainer(): HTMLElement | null {
    return document.querySelector('.clipboard-actions');
  }
}
