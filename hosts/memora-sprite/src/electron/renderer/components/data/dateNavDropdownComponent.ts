/**
 * 日期导航下拉组件
 *
 * 职责（封装 dateNavManager 中日期下拉的 DOM 操作与事件绑定）：
 * - 管理日期导航 5 个 DOM 元素引用（按钮/下拉容器/列表/标签/回到今天）
 * - 绑定下拉展开收起、外部点击关闭、Esc 关闭、键盘导航等 DOM 事件
 * - 渲染日期列表项（今天/昨天标签 + 会话数 + 删除按钮）
 * - 更新按钮文字与「回到今天」按钮可见性
 *
 * 与现有 HTML 模板的关系：
 * - 日期导航 DOM 元素已存在于 index.html 模板中（date-nav-btn 等）
 * - 本组件 mount() 时查询并缓存这些已有元素引用，不创建新元素
 * - destroy() 不删除 DOM 元素（模板部分），仅解绑事件 + nullify 引用
 *
 * 对齐 ARCH-COMP-1 阶段 4 方案（「Manager 编排 + Component 封装」）：
 * - Manager 持有 Component 实例，调用 mount/initEvents/destroy
 * - Manager 的 openDropdown/closeDropdown/renderDateList 等方法委托给 Component
 * - 业务逻辑（selectDate 跳转、日期数据管理、Alt 翻日计算）保留在 Manager
 *
 * 事件策略：
 * - 所有 DOM 事件通过 addEventListener 绑定，解绑函数通过 trackEvent 注册
 * - 由基类 destroy() 统一清理，避免遗漏
 * - 业务决策（跳转/删除/回到今天/Alt 翻日）通过 initEvents 回调委托给 Manager
 * - 纯 UI 行为（外部点击关闭、Esc 关闭、方向键焦点移动）内部处理，无需回调
 */

import { Component } from '../base/component.js';
import { clearElement, createEmptyState, formatDateKey } from '../../helpers/domHelpers.js';
import { setIcon } from '../../helpers/icon.js';
// 渲染进程统一日志入口（替代散落的 console.error/warn）
import { reportError } from '../../helpers/errorHelpers.js';
import { MS_PER_DAY } from '../../../../sprite/constants.js';

// ─── 组件选项 ──────────────────────────────────────────────

/** DateNavDropdownComponent 配置（当前无外部配置，保留接口供扩展） */
export interface DateNavDropdownOptions {
  // 当前无跨模块关注点注入，保留接口供后续扩展
}

// ─── 组件 ──────────────────────────────────────────────────

/**
 * 日期导航下拉组件
 *
 * 由 DateNavManager 持有实例，替代原有 11 处 document.getElementById 直接 DOM 操作。
 * 挂载到现有 HTML 模板中的 #date-nav-btn / #date-nav-dropdown 等元素。
 * 提供下拉展开收起、日期列表渲染、按钮文字更新等 DOM 操作方法。
 */
export class DateNavDropdownComponent extends Component<DateNavDropdownOptions> {
  // ─── 缓存的 DOM 元素引用（mount 时查询，destroy 时 nullify） ──
  /** 日期按钮（点击展开/收起下拉） */
  private btnEl: HTMLButtonElement | null = null;
  /** 下拉容器（展开/收起的根元素） */
  private dropdownEl: HTMLElement | null = null;
  /** 日期列表容器（渲染日期项的父元素） */
  private listEl: HTMLElement | null = null;
  /** 按钮文字标签（显示当前日期） */
  private labelEl: HTMLElement | null = null;
  /** 回到今天按钮（当前日期非今天时显示） */
  private backToTodayBtnEl: HTMLElement | null = null;

  /**
   * 构造函数——只合并配置，无副作用
   *
   * @param options 组件配置
   */
  constructor(options: DateNavDropdownOptions = {}) {
    super(options);
  }

  /**
   * 挂载到容器——查询并缓存现有 5 个 DOM 元素引用
   *
   * 日期导航元素已存在于 index.html 模板中，mount 仅做查询缓存，不创建新元素。
   * 元素缺失时缓存为 null（后续 initEvents / DOM 方法会做空值保护，不抛错）。
   *
   * @param _container 容器元素或选择器（兼容 Component 契约，本组件按 ID 查询故忽略）
   * @returns this（链式调用）
   */
  mount(_container: HTMLElement | string): this {
    // 查询并缓存 5 个 DOM 元素（按 ID 查询，元素已存在于模板）
    const btn = document.getElementById('date-nav-btn');
    // 按钮需校验为 HTMLButtonElement，避免类型不匹配
    this.btnEl = btn instanceof HTMLButtonElement ? btn : null;
    this.dropdownEl = document.getElementById('date-nav-dropdown');
    this.listEl = document.getElementById('date-nav-list');
    this.labelEl = document.getElementById('date-nav-label');
    this.backToTodayBtnEl = document.getElementById('btn-back-to-today');

    // 设置 this.el 为下拉容器（满足 Component 基类契约；destroy 时会被置空以避免删除模板元素）
    this.el = this.dropdownEl;

    return this;
  }

  /**
   * 增量更新——当前组件不使用 update 模式
   *
   * 日期列表 / 按钮文字通过 renderDateList / updateButtonLabel 等显式方法更新。
   *
   * @returns this
   */
  update(): this {
    return this;
  }

  /**
   * 绑定 DOM 事件——由 Manager 的 init() 调用
   *
   * 绑定以下事件（纯 UI 行为内部处理，业务决策通过回调委托给 Manager）：
   * - 按钮点击 / Enter / Space 切换 → onToggle
   * - 外部点击关闭、Esc 关闭（内部处理，调用 closeDropdown）
   * - 下拉键盘导航 ArrowDown / ArrowUp 焦点移动（内部处理）
   * - 下拉 Enter 选中日期 → onSelectDate
   * - 下拉 Escape 关闭 + 聚焦按钮（内部处理）
   * - 日期列表项点击 → onSelectDate（事件委托，排除删除按钮）
   * - 删除按钮点击 → onDeleteDate（事件委托）
   * - 回到今天按钮点击 → onBackToToday
   * - 全局 Alt+←/→ 翻日 → onGlobalAltArrow
   *
   * 核心元素（btn / dropdown / listEl）缺失时记录错误并跳过绑定，不抛错。
   * 所有解绑函数通过 trackEvent 注册，由基类 destroy() 统一清理。
   *
   * @param onToggle 按钮点击/Enter/Space 切换回调（Manager 决定展开或收起）
   * @param onSelectDate 日期项点击/Enter 选中回调（Manager 执行 selectDate 跳转）
   * @param onDeleteDate 删除按钮点击回调（Manager 执行 deleteCallback）
   * @param onBackToToday 回到今天按钮点击回调（Manager 执行 backToTodayCallback）
   * @param onGlobalAltArrow 全局 Alt+←/→ 翻日回调（Manager 基于 availableDates/currentDate 计算）
   */
  initEvents(
    onToggle: () => void,
    onSelectDate: (date: string) => void,
    onDeleteDate: (date: string) => void,
    onBackToToday: () => void,
    onGlobalAltArrow: (e: KeyboardEvent) => void,
  ): void {
    // 取出核心元素局部引用（便于在闭包中捕获，destroy 后仍可正确解绑）
    const btn = this.btnEl;
    const dropdown = this.dropdownEl;
    const listEl = this.listEl;

    // 核心元素校验：btn/dropdown/listEl 缺失时记录错误并跳过事件绑定
    if (
      !(btn instanceof HTMLButtonElement) ||
      !(dropdown instanceof HTMLElement) ||
      !(listEl instanceof HTMLElement)
    ) {
      reportError(
        'DateNav DOM 元素缺失',
        new Error('日期导航不可用：btn/dropdown/list 校验失败'),
      );
      return;
    }

    // ── 按钮事件 ──

    // 点击按钮切换下拉（stopPropagation 防止冒泡到 document 立即触发关闭逻辑）
    const onBtnClick = (e: Event) => {
      e.stopPropagation();
      onToggle();
    };
    btn.addEventListener('click', onBtnClick);
    this.trackEvent(() => btn.removeEventListener('click', onBtnClick));

    // 键盘支持：Enter / Space 触发切换（按钮上）
    const onBtnKeydown = (e: Event) => {
      const ke = e as KeyboardEvent;
      if (ke.key === 'Enter' || ke.key === ' ') {
        ke.preventDefault();
        onToggle();
      }
    };
    btn.addEventListener('keydown', onBtnKeydown);
    this.trackEvent(() => btn.removeEventListener('keydown', onBtnKeydown));

    // ── document 级事件 ──

    // 点击外部关闭下拉（target 不在 dropdown 与 btn 内时收起）
    const onDocClick = (e: Event) => {
      const target = e.target as Node;
      if (!dropdown.contains(target) && !btn.contains(target)) {
        this.closeDropdown();
      }
    };
    document.addEventListener('click', onDocClick);
    this.trackEvent(() => document.removeEventListener('click', onDocClick));

    // Esc 关闭下拉
    const onDocKeydownEsc = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key === 'Escape') {
        this.closeDropdown();
      }
    };
    document.addEventListener('keydown', onDocKeydownEsc);
    this.trackEvent(() => document.removeEventListener('keydown', onDocKeydownEsc));

    // 全局快捷键：Alt+←/→ 翻日（仅做按键过滤，日期计算委托给 Manager）
    const onDocKeydownAlt = (e: Event) => {
      if (!(e instanceof KeyboardEvent)) return;
      // 仅响应 Alt + 左/右方向键
      if (!e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
      onGlobalAltArrow(e);
    };
    document.addEventListener('keydown', onDocKeydownAlt);
    this.trackEvent(() => document.removeEventListener('keydown', onDocKeydownAlt));

    // ── 下拉键盘导航 ──

    // 下拉内方向键移动焦点 + Enter 选中 + Escape 关闭并聚焦按钮
    const onDropdownKeydown = (e: Event) => {
      const ke = e as KeyboardEvent;
      const items = dropdown.querySelectorAll<HTMLElement>('.date-nav-item[data-date]');
      if (items.length === 0) return;

      // 当前焦点所在项索引（-1 表示焦点不在任何日期项上）
      const currentIdx = Array.from(items).findIndex(
        (item) => item === document.activeElement,
      );

      if (ke.key === 'ArrowDown') {
        ke.preventDefault();
        // 向下：无焦点时聚焦首项，否则聚焦下一项（不越界）
        const nextIdx = currentIdx < 0 ? 0 : Math.min(currentIdx + 1, items.length - 1);
        items[nextIdx]?.focus();
      } else if (ke.key === 'ArrowUp') {
        ke.preventDefault();
        // 向上：无焦点时聚焦末项，否则聚焦上一项（不越界）
        const prevIdx = currentIdx < 0 ? items.length - 1 : Math.max(currentIdx - 1, 0);
        items[prevIdx]?.focus();
      } else if (ke.key === 'Enter') {
        ke.preventDefault();
        // Enter：仅当焦点在日期项上时触发选中
        if (currentIdx >= 0) {
          const date = items[currentIdx]?.dataset.date;
          if (date) {
            onSelectDate(date);
          }
        }
      } else if (ke.key === 'Escape') {
        // Escape：关闭下拉并恢复按钮焦点
        this.closeDropdown();
        this.focusButton();
      }
    };
    dropdown.addEventListener('keydown', onDropdownKeydown);
    this.trackEvent(() => dropdown.removeEventListener('keydown', onDropdownKeydown));

    // ── 日期列表事件委托 ──

    // 日期项点击 → 跳转（排除删除按钮的点击）
    // 事件委托避免每次 renderDateList 重建 DOM 时重复绑定事件监听器
    const onListClickSelect = (e: Event) => {
      const target = e.target as HTMLElement;
      // 排除删除按钮的点击（删除按钮已单独处理）
      if (target.closest('.date-nav-item-delete')) return;
      // 找到日期项
      const item = target.closest<HTMLElement>('.date-nav-item[data-date]');
      if (item) {
        const date = item.dataset.date;
        if (date) {
          onSelectDate(date);
        }
      }
    };
    listEl.addEventListener('click', onListClickSelect);
    this.trackEvent(() => listEl.removeEventListener('click', onListClickSelect));

    // 删除按钮点击 → 删除委托
    const onListClickDelete = (e: Event) => {
      const target = e.target as HTMLElement;
      const deleteBtn = target.closest<HTMLElement>('.date-nav-item-delete');
      if (deleteBtn) {
        const item = deleteBtn.closest<HTMLElement>('.date-nav-item[data-date]');
        if (item) {
          const date = item.dataset.date;
          if (date) {
            onDeleteDate(date);
          }
        }
      }
    };
    listEl.addEventListener('click', onListClickDelete);
    this.trackEvent(() => listEl.removeEventListener('click', onListClickDelete));

    // ── 回到今天按钮 ──

    // 回到今天按钮（可选元素，模板缺失时跳过绑定）
    const backBtn = this.backToTodayBtnEl;
    if (backBtn) {
      const onBackClick = () => onBackToToday();
      backBtn.addEventListener('click', onBackClick);
      // 闭包捕获 backBtn 局部引用，确保 destroy 后解绑仍能定位元素
      this.trackEvent(() => backBtn.removeEventListener('click', onBackClick));
    }
  }

  // ─── DOM 操作方法 ──────────────────────────────────────

  /**
   * 展开下拉——设置 aria-expanded=true + 移除 hidden 类
   */
  openDropdown(): void {
    if (!this.btnEl || !this.dropdownEl) return;
    this.btnEl.setAttribute('aria-expanded', 'true');
    this.dropdownEl.classList.remove('hidden');
  }

  /**
   * 收起下拉——重置 aria-expanded=false + 添加 hidden 类
   */
  closeDropdown(): void {
    if (!this.btnEl || !this.dropdownEl) return;
    this.btnEl.setAttribute('aria-expanded', 'false');
    this.dropdownEl.classList.add('hidden');
  }

  /**
   * 查询当前展开状态
   *
   * @returns true 表示已展开（aria-expanded="true"）
   */
  isExpanded(): boolean {
    return this.btnEl?.getAttribute('aria-expanded') === 'true';
  }

  /**
   * 聚焦按钮——Esc 关闭下拉后恢复焦点
   */
  focusButton(): void {
    this.btnEl?.focus();
  }

  /**
   * 渲染日期列表
   *
   * 按日期倒序排列（最新在前），每个项显示日期 + 当天会话数。
   * 当前选中日期高亮（active 类 + aria-selected），今天不显示删除按钮。
   *
   * @param dates 有记录的日期集合（date → 会话数）
   * @param currentDate 当前选中日期（用于高亮）
   */
  renderDateList(dates: Map<string, number>, currentDate: string): void {
    if (!this.listEl) return;

    // 清空列表（使用 clearElement 替代 innerHTML='' 以保持一致性）
    clearElement(this.listEl);

    // 无数据时显示空状态
    if (dates.size === 0) {
      this.listEl.appendChild(createEmptyState({ title: '暂无对话记录' }));
      return;
    }

    // 按日期倒序排列（最新在前）
    const sortedDates = Array.from(dates.entries()).sort((a, b) =>
      b[0].localeCompare(a[0]),
    );

    // 今天/昨天标签基准（用于显示「今天 · 日期」「昨天 · 日期」）
    const today = formatDateKey(new Date());
    const yesterday = formatDateKey(new Date(Date.now() - MS_PER_DAY));

    for (const [date, count] of sortedDates) {
      // 日期项容器
      const item = document.createElement('div');
      item.className = 'date-nav-item flex-between';
      item.setAttribute('role', 'option');
      item.setAttribute('data-date', date);
      // tabindex="-1" 支持键盘导航（由父容器事件委托处理）
      item.setAttribute('tabindex', '-1');
      // ARIA 可访问性：标记当前选中项（屏幕阅读器用户需感知）
      item.setAttribute('aria-selected', date === currentDate ? 'true' : 'false');

      if (date === currentDate) {
        item.classList.add('active');
      }

      // 日期显示：今天/昨天 + 日期
      let label = date;
      if (date === today) {
        label = `今天 · ${date}`;
      } else if (date === yesterday) {
        label = `昨天 · ${date}`;
      }

      const labelSpan = document.createElement('span');
      labelSpan.className = 'date-nav-item-label';
      labelSpan.textContent = label;

      const countSpan = document.createElement('span');
      countSpan.className = 'date-nav-item-count';
      countSpan.textContent = `${count} 条`;

      item.appendChild(labelSpan);
      item.appendChild(countSpan);

      // 删除按钮：今天不显示删除（避免删除当天进行中的对话）
      const isToday = date === today;
      if (!isToday) {
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'date-nav-item-delete flex-shrink-0';
        deleteBtn.title = '删除该日期的对话记录';
        deleteBtn.setAttribute('aria-label', `删除 ${date} 的对话记录`);
        // 事件委托已处理删除按钮点击，此处无需绑定
        setIcon(deleteBtn, 'icon-trash');
        item.appendChild(deleteBtn);
      }

      // 事件委托已处理日期项点击，此处无需绑定
      this.listEl.appendChild(item);
    }
  }

  /**
   * 更新按钮显示的日期文字
   *
   * 今天显示「今天」，昨天显示「昨天」，其他日期显示「月/日」。
   *
   * @param date 当前日期（为空显示默认文字「选择日期」）
   */
  updateButtonLabel(date: string): void {
    if (!this.labelEl) return;

    if (!date) {
      this.labelEl.textContent = '选择日期';
      return;
    }

    const today = formatDateKey(new Date());
    const yesterday = formatDateKey(new Date(Date.now() - MS_PER_DAY));

    if (date === today) {
      this.labelEl.textContent = '今天';
    } else if (date === yesterday) {
      this.labelEl.textContent = '昨天';
    } else {
      // 只显示月/日，节省空间
      const parts = date.split('-');
      this.labelEl.textContent = `${parts[1]}/${parts[2]}`;
    }
  }

  /**
   * 更新「回到今天」按钮可见性
   *
   * 仅当当前日期不是今天时显示按钮。
   *
   * @param date 当前日期
   */
  updateBackToTodayVisibility(date: string): void {
    if (!this.backToTodayBtnEl) return;
    const today = formatDateKey(new Date());
    if (date && date !== today) {
      this.backToTodayBtnEl.classList.remove('hidden');
    } else {
      this.backToTodayBtnEl.classList.add('hidden');
    }
  }

  /**
   * 销毁组件——解绑事件 + nullify 引用
   *
   * 日期导航元素是 HTML 模板的一部分，不删除 DOM。
   * 先 nullify this.el 防止基类 destroy() 调用 el.remove() 删除模板元素，
   * 再调用 super.destroy() 由基类统一执行 _cleanups（事件解绑）。
   */
  destroy(): void {
    // nullify 元素引用（模板元素不删除）
    this.btnEl = null;
    this.dropdownEl = null;
    this.listEl = null;
    this.labelEl = null;
    this.backToTodayBtnEl = null;
    // 置空 this.el 防止基类 remove() 删除模板元素
    this.el = null;
    // 调用基类 destroy() 统一执行事件解绑（_cleanups）
    super.destroy();
  }
}
