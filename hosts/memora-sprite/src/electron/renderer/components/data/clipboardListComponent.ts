/**
 * 剪贴板待处理列表组件
 *
 * 职责（封装 clipboardPanelManager 中列表渲染相关的 DOM 操作）：
 * - 管理剪贴板面板 5 个 DOM 元素引用（列表/空状态/角标/批量操作/引导气泡）
 * - 渲染待处理条目列表（预览 + 长度 + 时间 + 较旧标签 + 复制/归档/忽略按钮）
 * - 切换空状态、批量操作按钮、引导气泡的显隐
 * - 更新导航角标（数量 0 隐藏 / 1-99 数字 / >99 显示 99+ / 较旧变警告色）
 * - 绑定引导关闭按钮事件（事件通过 trackEvent 注册，由基类 destroy 统一清理）
 *
 * 与现有 HTML 模板的关系：
 * - 面板 DOM 元素已存在于 index.html 模板中（clipboard-pending-list 等）
 * - 本组件 mount() 时查询并缓存这些已有元素引用，不创建新容器
 * - destroy() 不删除 DOM 元素（模板部分），仅 nullify 引用 + 解绑事件
 *
 * 对齐 ARCH-COMP-1 阶段 4 方案（Manager 编排 + Component 封装）：
 * - Manager 持有 Component 实例，调用 renderList/toggleX/updateBadge/bindOnboardingClose
 * - 列表项创建（createItemElement）完整移入 Component，事件通过 trackEvent 注册
 * - 业务逻辑（IPC 调用、数据加载、归档/忽略处理）保留在 Manager
 * - 单条操作回调（onCopy/onArchive/onIgnore）由 Manager 注入，Component 不直接调用 Manager 方法
 */

import { Component } from '../base/component.js';
import { clearElement, createEl, formatTimeAgo } from '../../helpers/domHelpers.js';
import type { ClipboardPendingItem } from '../../panels/clipboardManager.js';
import { BADGE_MAX_DISPLAY } from '../../panels/clipboardManager.js';

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
 *
 * 导出说明：Manager 的 dismissOnboarding 写入此键，Component 的 toggleOnboardingTip 读取此键，
 * 二者共享同一真理源，故在此定义并导出。
 */
export const ONBOARDING_DISMISSED_KEY = 'memora:clipboard-onboarding-dismissed';

// ─── 类型定义 ──────────────────────────────────────────────

/**
 * 列表项操作回调集合
 *
 * 由 Manager 注入，Component 在创建列表项按钮时绑定到点击事件。
 * Component 不直接调用 Manager 方法，通过回调解耦（保持 Component 的纯渲染职责）。
 */
export interface ItemActionCallbacks {
  /** 复制按钮回调（将条目完整内容写回 OS 剪贴板） */
  onCopy: (content: string) => void;
  /** 归档按钮回调（乐观移除 + 触发 clipboardAnalyze） */
  onArchive: (id: string) => void;
  /** 忽略按钮回调（从列表移除条目，不归档） */
  onIgnore: (id: string) => void;
}

// ─── 组件选项 ──────────────────────────────────────────────

/** ClipboardListComponent 配置（当前无跨模块关注点注入，保留接口供后续扩展） */
export interface ClipboardListOptions {
  // 预留扩展
}

// ─── 组件 ──────────────────────────────────────────────────

/**
 * 剪贴板待处理列表组件
 *
 * 由 ClipboardPanelManager 持有实例，替代原有 5 处 document.getElementById 直接 DOM 操作。
 * 挂载到现有 HTML 模板中的 #clipboard-pending-list 等元素。
 *
 * 注：本组件管理 5 个分布于面板各处的模板元素（非单一根容器），
 * 因此 this.el 保持 null（无单一根锚点），destroy 不移除任何模板 DOM。
 */
export class ClipboardListComponent extends Component<ClipboardListOptions> {
  // ─── 缓存的 DOM 元素引用（mount 时查询，destroy 时 nullify） ──
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

  /**
   * 构造函数——只合并配置，无副作用
   *
   * @param options 组件配置
   */
  constructor(options: ClipboardListOptions = {}) {
    super(options);
  }

  /**
   * 挂载到容器——查询并缓存现有 DOM 元素引用
   *
   * 面板 DOM 元素已存在于 index.html 模板中，mount 仅做查询缓存，不创建新元素。
   * actionsEl 优先通过 id 查找，缺失时通过 class 兜底查找（原 resolveActionsContainer 逻辑）。
   *
   * @param _container 容器元素或选择器（兼容 Component 契约，当前未使用——元素通过全局 id 查询）
   * @returns this（链式调用）
   */
  mount(_container: HTMLElement | string): this {
    // 列表容器
    this.listEl = document.getElementById('clipboard-pending-list');
    // 空状态容器
    this.emptyStateEl = document.getElementById('clipboard-empty-state');
    // 导航角标
    this.navBadgeEl = document.getElementById('clipboard-nav-badge');
    // 批量操作按钮容器（id 优先，缺失时 class 兜底，原 resolveActionsContainer 逻辑迁入此处）
    this.actionsEl = document.getElementById('clipboard-actions') ?? document.querySelector('.clipboard-actions');
    // 首次引导气泡
    this.onboardingTipEl = document.getElementById('clipboard-onboarding-tip');

    // 本组件管理多个 peer 模板元素，无单一根容器，this.el 保持 null（基类 remove 为 no-op）
    return this;
  }

  /**
   * 增量更新——当前列表组件不使用 update 模式
   *
   * 列表渲染通过 renderList 显式调用完成（清空 + 重建），无需 update 增量更新。
   *
   * @returns this
   */
  update(): this {
    return this;
  }

  // ─── 列表渲染 ──────────────────────────────────────────

  /**
   * 渲染待处理列表
   *
   * 清空列表容器后，按倒序（最新在最前）渲染每条条目。
   * ClipboardManager 已经维护倒序，此处直接遍历。
   *
   * @param items 待处理条目数组
   * @param callbacks 单条操作回调（复制/归档/忽略），由 Manager 注入
   */
  renderList(items: readonly ClipboardPendingItem[], callbacks: ItemActionCallbacks): void {
    if (!this.listEl) return;
    clearElement(this.listEl);

    for (const item of items) {
      const itemEl = this.createItemElement(item, callbacks);
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
   *       <button class="clipboard-item-btn clipboard-item-btn-copy">复制</button>
   *       <button class="clipboard-item-btn clipboard-item-btn-archive">归档</button>
   *       <button class="clipboard-item-btn clipboard-item-btn-ignore">忽略</button>
   *     </div>
   *   </div>
   * </div>
   * ```
   *
   * 事件绑定通过 trackEvent 注册，由基类 destroy() 统一清理。
   *
   * @param item 待处理条目数据
   * @param callbacks 单条操作回调
   * @returns 条目 DOM 元素
   */
  private createItemElement(item: ClipboardPendingItem, callbacks: ItemActionCallbacks): HTMLElement {
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

    // 复制按钮（将完整内容写回 OS 剪贴板）
    const copyBtn = createEl('button', 'clipboard-item-btn clipboard-item-btn-copy');
    copyBtn.type = 'button';
    copyBtn.title = '复制到剪贴板';
    copyBtn.setAttribute('aria-label', '复制到剪贴板');
    copyBtn.innerHTML = '<svg class="icon"><use href="#icon-copy"/></svg>';
    const handleCopy = (): void => callbacks.onCopy(item.content);
    copyBtn.addEventListener('click', handleCopy);
    this.trackEvent(() => copyBtn.removeEventListener('click', handleCopy));
    actionsEl.appendChild(copyBtn);

    // 归档按钮（乐观移除 + 触发 clipboardAnalyze）
    const archiveBtn = createEl('button', 'clipboard-item-btn clipboard-item-btn-archive');
    archiveBtn.type = 'button';
    archiveBtn.title = '归档为记忆';
    archiveBtn.setAttribute('aria-label', '归档为记忆');
    archiveBtn.innerHTML = '<svg class="icon"><use href="#icon-check"/></svg>';
    const handleArchive = (): void => callbacks.onArchive(item.id);
    archiveBtn.addEventListener('click', handleArchive);
    this.trackEvent(() => archiveBtn.removeEventListener('click', handleArchive));
    actionsEl.appendChild(archiveBtn);

    // 忽略按钮（从列表移除，不归档）
    const ignoreBtn = createEl('button', 'clipboard-item-btn clipboard-item-btn-ignore');
    ignoreBtn.type = 'button';
    ignoreBtn.title = '忽略此条';
    ignoreBtn.setAttribute('aria-label', '忽略此条');
    ignoreBtn.innerHTML = '<svg class="icon"><use href="#icon-close"/></svg>';
    const handleIgnore = (): void => callbacks.onIgnore(item.id);
    ignoreBtn.addEventListener('click', handleIgnore);
    this.trackEvent(() => ignoreBtn.removeEventListener('click', handleIgnore));
    actionsEl.appendChild(ignoreBtn);

    metaEl.appendChild(actionsEl);
    itemEl.appendChild(metaEl);

    return itemEl;
  }

  // ─── 显隐切换 ──────────────────────────────────────────

  /**
   * 切换空状态显隐
   *
   * 列表为空时显示空状态引导，有内容时隐藏。
   *
   * @param isEmpty 列表是否为空
   */
  toggleEmptyState(isEmpty: boolean): void {
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
  toggleActionsVisibility(isEmpty: boolean): void {
    if (!this.actionsEl) return;
    if (isEmpty) {
      this.actionsEl.classList.add('clipboard-actions-hidden');
    } else {
      this.actionsEl.classList.remove('clipboard-actions-hidden');
    }
  }

  /**
   * 切换首次引导气泡显隐
   *
   * 显示条件：有待处理内容 + 未关闭过（localStorage 无记录）
   * 隐藏条件：无待处理内容 或 已关闭过
   *
   * @param hasItems 是否有待处理内容
   */
  toggleOnboardingTip(hasItems: boolean): void {
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

  // ─── 角标更新 ──────────────────────────────────────────

  /**
   * 更新导航角标显示
   *
   * 规则：
   * - count=0：隐藏角标
   * - 1≤count≤99：显示数字
   * - count>99：显示 "99+"
   * - hasStale=true：追加 nav-badge-stale 类（背景变警告色）
   *
   * @param count 待处理数量
   * @param hasStale 是否存在较旧条目
   */
  updateBadge(count: number, hasStale: boolean): void {
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

  // ─── 引导关闭按钮绑定 ──────────────────────────────────

  /**
   * 绑定首次引导关闭按钮事件
   *
   * 点击关闭后由 Manager 的 onClose 回调处理（记录 localStorage + 隐藏气泡）。
   * 事件通过 trackEvent 注册，由基类 destroy() 统一清理。
   *
   * @param onClose 关闭按钮点击回调（Manager 注入 dismissOnboarding）
   */
  bindOnboardingClose(onClose: () => void): void {
    const closeBtn = document.getElementById('clipboard-onboarding-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', onClose);
      this.trackEvent(() => closeBtn.removeEventListener('click', onClose));
    }
  }

  // ─── 销毁 ──────────────────────────────────────────────

  /**
   * 销毁组件——nullify 引用 + 统一清理事件
   *
   * 面板元素是 HTML 模板的一部分，不删除 DOM（this.el 保持 null，基类 remove 为 no-op）。
   * 仅 nullify 内部引用，事件由基类 destroy() 通过 _cleanups 统一解绑。
   */
  destroy(): void {
    this.listEl = null;
    this.emptyStateEl = null;
    this.navBadgeEl = null;
    this.actionsEl = null;
    this.onboardingTipEl = null;
    super.destroy();
  }
}
