/**
 * 待定草稿区组件（申请暂停模型 Phase 1）
 *
 * 在任务表面板侧栏中展示用户输入的待定草稿列表。
 * 用户切换到任务面板或输入「入待定区」的内容会暂存在此，
 * 待 LLM 工作通道空闲时自动消费（RUNNING 态）或由用户手动提交（PAUSED 态）。
 *
 * 生命周期（对齐 Component 基类四件套契约）：
 *   - new PendingDraftArea(options)  创建实例，不操作 DOM
 *   - mount(container)                挂载到 DOM 容器
 *   - update(data)                    增量更新草稿列表
 *   - destroy()                       销毁组件，清理事件+DOM
 *
 * 设计原则：
 * - 单根 el 容器，挂载到 #tasks-draft-container
 * - 列表渲染使用 clearElement + 重建（结构简单，无需增量 diff）
 * - 事件通过 trackEvent 注册，由 destroy 统一清理
 * - 纯展示组件，编辑/删除操作用户行为由 onAction 回调通知 Manager
 */

import { Component } from '../base/component.js';
import { createEl, clearElement } from '../../helpers/domHelpers.js';

// ─── 常量 ───────────────────────────────────────────────

/** 草稿列表最大条目数（超过此上限时不允许新增） */
export const DRAFT_MAX_ITEMS = 20;

// ─── 类型 ───────────────────────────────────────────────

/**
 * 草稿条目数据
 */
export interface DraftItem {
  /** 草稿唯一标识 */
  id: string;
  /** 草稿文本内容 */
  text: string;
  /** 草稿创建时间戳（ISO 格式） */
  createdAt: string;
}

/**
 * 草稿区操作回调
 *
 * 由 Manager 注入，Component 在创建条目按钮时绑定。
 * 保持 Component 的纯渲染职责，不直接调用 Manager 方法。
 */
export interface DraftActionCallbacks {
  /** 删除单条草稿 */
  onDelete: (id: string) => void;
  /** 提交草稿（PAUSED 态合并提交 / RUNNING 态自动消费） */
  onSubmit: (id: string) => void;
}

/**
 * 草稿区状态文案
 *
 * 根据当前工作通道状态显示不同的提示文案：
 * - RUNNING：待定内容将在 LLM 空闲时自动消费
 * - PAUSED：继续时合并提交
 * - 空列表：暂无待定内容
 */
export interface DraftStatusText {
  /** 顶部状态文案 */
  heading: string;
  /** 空列表提示文案 */
  empty: string;
}

// ─── 组件选项 ───────────────────────────────────────────

/** PendingDraftArea 组件配置 */
export interface PendingDraftAreaOptions {
  /** 初始草稿列表（默认空） */
  drafts?: DraftItem[];
  /** 草稿操作回调 */
  callbacks?: DraftActionCallbacks;
  /** 状态文案 */
  statusText?: DraftStatusText;
}

// ─── 默认值 ─────────────────────────────────────────────

const DEFAULT_STATUS_TEXT: DraftStatusText = {
  heading: '待定草稿',
  empty: '暂无待定内容',
};

// ─── 组件 ───────────────────────────────────────────────

/**
 * 待定草稿区组件
 *
 * 渲染草稿列表 + 数量徽标 + 逐条删除/提交按钮 + 状态文案。
 * 由 TaskTablePanelManager 持有实例，挂载到 #tasks-draft-container。
 */
export class PendingDraftArea extends Component<PendingDraftAreaOptions> {
  /** 当前草稿列表数据 */
  private drafts: DraftItem[] = [];
  /** 操作回调 */
  private callbacks: DraftActionCallbacks = { onDelete: () => {}, onSubmit: () => {} };
  /** 状态文案 */
  private statusText: DraftStatusText = { ...DEFAULT_STATUS_TEXT };

  // ─── 缓存的子元素引用（mount 时查询，update 时更新） ──
  /** 数量徽标 */
  private badgeEl: HTMLElement | null = null;
  /** 列表容器 */
  private listEl: HTMLElement | null = null;
  /** 空状态提示 */
  private emptyEl: HTMLElement | null = null;
  /** 状态文案标题 */
  private headingEl: HTMLElement | null = null;

  /**
   * 构造函数——只合并配置，不操作 DOM
   */
  constructor(options: PendingDraftAreaOptions = {}) {
    super(options);
    this.drafts = options.drafts ?? [];
    this.callbacks = options.callbacks ?? { onDelete: () => {}, onSubmit: () => {} };
    this.statusText = options.statusText ?? { ...DEFAULT_STATUS_TEXT };
  }

  /**
   * 挂载到 DOM 容器
   *
   * 创建根元素结构，查询子元素引用，绑定事件。
   *
   * @param container 容器元素或选择器
   * @returns this（链式调用）
   */
  mount(container: HTMLElement | string): this {
    if (this.el) return this; // 防重复挂载

    // 创建根容器
    this.el = createEl('div', 'pending-draft-area');

    // 状态区：标题 + 数量徽标
    const headerEl = createEl('div', 'pending-draft-header');
    this.headingEl = createEl('span', 'pending-draft-heading', this.statusText.heading);
    headerEl.appendChild(this.headingEl);
    this.badgeEl = createEl('span', 'pending-draft-badge', '0');
    this.badgeEl.classList.add('nav-badge-hidden');
    headerEl.appendChild(this.badgeEl);
    this.el.appendChild(headerEl);

    // 列表容器
    this.listEl = createEl('div', 'pending-draft-list');
    this.el.appendChild(this.listEl);

    // 空状态（默认显示）
    this.emptyEl = createEl('div', 'pending-draft-empty', this.statusText.empty);
    this.el.appendChild(this.emptyEl);

    // 挂载到容器
    const root = typeof container === 'string' ? document.querySelector(container) : container;
    if (root) {
      root.appendChild(this.el);
    }

    return this;
  }

  /**
   * 增量更新草稿列表
   *
   * 重建列表 DOM（结构简单，全量渲染成本低）。
   * 保持徽标、空状态、列表三者的同步。
   *
   * @param newOptions 新的配置项
   * @returns this
   */
  update(newOptions: Partial<PendingDraftAreaOptions>): this {
    if (newOptions.drafts !== undefined) {
      this.drafts = newOptions.drafts;
    }
    if (newOptions.callbacks !== undefined) {
      this.callbacks = newOptions.callbacks;
    }
    if (newOptions.statusText !== undefined) {
      this.statusText = { ...DEFAULT_STATUS_TEXT, ...newOptions.statusText };
    }

    this.renderList();
    return this;
  }

  /**
   * 渲染草稿列表
   *
   * 同步更新：徽标计数、列表条目、空状态显隐。
   */
  private renderList(): void {
    if (!this.listEl || !this.emptyEl || !this.badgeEl) return;

    // 清空列表
    clearElement(this.listEl);

    // 更新徽标
    const count = this.drafts.length;
    if (count === 0) {
      this.badgeEl.classList.add('nav-badge-hidden');
      this.badgeEl.textContent = '0';
    } else {
      this.badgeEl.classList.remove('nav-badge-hidden');
      this.badgeEl.textContent = count > 99 ? '99+' : String(count);
    }

    // 切换空状态
    if (count === 0) {
      this.emptyEl!.classList.remove('hidden');
      return;
    }
    this.emptyEl!.classList.add('hidden');

    // 渲染草稿条目
    for (const draft of this.drafts) {
      const itemEl = this.createDraftItem(draft);
      this.listEl.appendChild(itemEl);
    }
  }

  /**
   * 创建单条草稿条目 DOM
   *
   * 结构：
   * ```html
   * <div class="pending-draft-item" data-draft-id="{id}">
   *   <span class="pending-draft-text">{text}</span>
   *   <div class="pending-draft-actions">
   *     <button class="pending-draft-btn pending-draft-btn-submit" title="提交">提交</button>
   *     <button class="pending-draft-btn pending-draft-btn-delete" title="删除">删除</button>
   *   </div>
   * </div>
   * ```
   *
   * @param draft 草稿条目数据
   * @returns 条目 DOM 元素
   */
  private createDraftItem(draft: DraftItem): HTMLElement {
    const itemEl = createEl('div', 'pending-draft-item');
    itemEl.dataset.draftId = draft.id;

    // 草稿文本（截断长文本）
    const textEl = createEl('span', 'pending-draft-text', draft.text);
    itemEl.appendChild(textEl);

    // 操作按钮
    const actionsEl = createEl('div', 'pending-draft-actions');

    // 提交按钮
    const submitBtn = createEl('button', 'pending-draft-btn pending-draft-btn-submit', '提交');
    submitBtn.type = 'button';
    submitBtn.title = '提交此条草稿';
    const handleSubmit = (): void => this.callbacks.onSubmit(draft.id);
    submitBtn.addEventListener('click', handleSubmit);
    this.trackEvent(() => submitBtn.removeEventListener('click', handleSubmit));
    actionsEl.appendChild(submitBtn);

    // 删除按钮
    const deleteBtn = createEl('button', 'pending-draft-btn pending-draft-btn-delete', '删除');
    deleteBtn.type = 'button';
    deleteBtn.title = '删除此条草稿';
    const handleDelete = (): void => this.callbacks.onDelete(draft.id);
    deleteBtn.addEventListener('click', handleDelete);
    this.trackEvent(() => deleteBtn.removeEventListener('click', handleDelete));
    actionsEl.appendChild(deleteBtn);

    itemEl.appendChild(actionsEl);
    return itemEl;
  }

  /**
   * 销毁组件
   *
   * 清理事件 + 移除 DOM + nullify 引用。
   */
  destroy(): void {
    this.badgeEl = null;
    this.listEl = null;
    this.emptyEl = null;
    this.headingEl = null;
    // 重置数据引用
    this.drafts = [];
    super.destroy();
  }
}