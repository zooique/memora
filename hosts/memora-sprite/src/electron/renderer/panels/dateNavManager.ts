/**
 * 日期导航管理器 — 有记录日期下拉列表
 *
 * 从原生 <input type="date"> 重构为自定义下拉列表。
 * 只显示有对话记录的日期，无记录日期不显示，避免用户困惑。
 * 日期按倒序排列（最新在前），每个日期显示会话数。
 *
 * 职责：
 * - 绑定 #date-nav-btn 点击事件，展开/收起下拉列表
 * - 接收 availableDates，渲染日期列表项
 * - 点击日期项触发跳转回调
 * - 点击外部区域关闭下拉
 * - 显示当前查看的日期（按钮文字）
 *
 * 设计原则：
 * - 自包含 EventTracker，init() 绑定事件，cleanup() 统一清理
 * - 与 UIManager 解耦，通过回调接口通信
 * - 日期数据来自 updateAvailableDates()，由外部（sessionController）提供
 */
import { EventTracker } from '../helpers/eventTracker.js';
import { formatDateKey } from '../helpers/domHelpers.js';
import { MS_PER_DAY } from '../../../sprite/constants.js';

/**
 * 日期导航管理器类
 *
 * 生命周期：init() 绑定事件 → cleanup() 清理事件 + 回调
 */
export class DateNavManager {
  /** 事件监听器跟踪器 */
  private events = new EventTracker();
  /** 日期跳转回调（由 renderer.ts 注册，调用 sessionController.jumpToDate） */
  private jumpCallback: ((date: string) => void) | null = null;
  /** 有对话记录的日期集合（用于渲染下拉列表） */
  private availableDates = new Map<string, number>();
  /** 当前选中的日期 */
  private currentDate = '';
  /** 日期删除回调（由 renderer.ts 注册，调用 sessionController.deleteSession） */
  private deleteCallback: ((date: string) => void) | null = null;
  /** 回到今天回调（由 renderer.ts 注册，调用 sessionController 切换到今天的会话） */
  private backToTodayCallback: (() => void) | null = null;

  /**
   * 初始化事件监听器
   *
   * 绑定日期按钮点击展开/收起，点击外部关闭。
   * 在 UIManager 构造完成后调用。
   */
  init(): void {
    const btn = document.getElementById('date-nav-btn') as HTMLButtonElement | null;
    const dropdown = document.getElementById('date-nav-dropdown');
    const listEl = document.getElementById('date-nav-list');
    if (!btn || !dropdown || !listEl) return;

    // 点击按钮切换下拉
    this.events.addEventListener(btn, 'click', (e) => {
      e.stopPropagation();
      const expanded = btn.getAttribute('aria-expanded') === 'true';
      if (expanded) {
        this.closeDropdown();
      } else {
        this.openDropdown();
      }
    });

    // 点击外部关闭
    this.events.addEventListener(document, 'click', (e) => {
      const target = e.target as Node;
      if (!dropdown.contains(target) && !btn.contains(target)) {
        this.closeDropdown();
      }
    });

    // Esc 关闭
    this.events.addEventListener(document, 'keydown', (e) => {
      if (e instanceof KeyboardEvent && e.key === 'Escape') {
        this.closeDropdown();
      }
    });

    // 键盘支持：Enter/Space 展开下拉（按钮上）
    this.events.addEventListener(btn, 'keydown', (e) => {
      const ke = e as KeyboardEvent;
      if (ke.key === 'Enter' || ke.key === ' ') {
        ke.preventDefault();
        const expanded = btn.getAttribute('aria-expanded') === 'true';
        if (expanded) {
          this.closeDropdown();
        } else {
          this.openDropdown();
        }
      }
    });

    // 键盘导航：在下拉菜单内用方向键移动焦点，Enter 选择
    this.events.addEventListener(dropdown, 'keydown', (e) => {
      const ke = e as KeyboardEvent;
      const items = dropdown.querySelectorAll<HTMLElement>('.date-nav-item[data-date]');
      if (items.length === 0) return;

      const currentIdx = Array.from(items).findIndex(
        (item) => item === document.activeElement,
      );

      if (ke.key === 'ArrowDown') {
        ke.preventDefault();
        const nextIdx = currentIdx < 0 ? 0 : Math.min(currentIdx + 1, items.length - 1);
        items[nextIdx]?.focus();
      } else if (ke.key === 'ArrowUp') {
        ke.preventDefault();
        const prevIdx = currentIdx < 0 ? items.length - 1 : Math.max(currentIdx - 1, 0);
        items[prevIdx]?.focus();
      } else if (ke.key === 'Enter') {
        ke.preventDefault();
        if (currentIdx >= 0) {
          const date = items[currentIdx]?.dataset.date;
          if (date) {
            this.selectDate(date);
          }
        }
      } else if (ke.key === 'Escape') {
        this.closeDropdown();
        btn.focus();
      }
    });

    // 事件委托：日期列表项点击（跳转）
    // 避免每次 renderDateList 重建 DOM 时重复绑定事件监听器
    this.events.addEventListener(listEl, 'click', (e) => {
      const target = e.target as HTMLElement;
      // 排除删除按钮的点击（删除按钮已单独处理）
      if (target.closest('.date-nav-item-delete')) return;
      // 找到日期项
      const item = target.closest<HTMLElement>('.date-nav-item[data-date]');
      if (item) {
        const date = item.dataset.date;
        if (date) {
          this.selectDate(date);
        }
      }
    });

    // 事件委托：删除按钮点击
    this.events.addEventListener(listEl, 'click', (e) => {
      const target = e.target as HTMLElement;
      const deleteBtn = target.closest<HTMLElement>('.date-nav-item-delete');
      if (deleteBtn) {
        const item = deleteBtn.closest<HTMLElement>('.date-nav-item[data-date]');
        if (item) {
          const date = item.dataset.date;
          if (date && this.deleteCallback) {
            this.deleteCallback(date);
          }
        }
      }
    });

    // 回到今天按钮
    const backToTodayBtn = document.getElementById('btn-back-to-today');
    if (backToTodayBtn) {
      this.events.addEventListener(backToTodayBtn, 'click', () => {
        this.backToTodayCallback?.();
      });
    }
  }

  /**
   * 展开下拉列表
   */
  private openDropdown(): void {
    const btn = document.getElementById('date-nav-btn');
    const dropdown = document.getElementById('date-nav-dropdown');
    if (!btn || !dropdown) return;

    btn.setAttribute('aria-expanded', 'true');
    dropdown.classList.remove('hidden');
    this.renderDateList();
  }

  /**
   * 收起下拉列表
   */
  private closeDropdown(): void {
    const btn = document.getElementById('date-nav-btn');
    const dropdown = document.getElementById('date-nav-dropdown');
    if (!btn || !dropdown) return;

    btn.setAttribute('aria-expanded', 'false');
    dropdown.classList.add('hidden');
  }

  /**
   * 渲染日期列表
   *
   * 按日期倒序排列，每个项显示日期 + 当天会话数。
   * 当前选中日期高亮。
   */
  private renderDateList(): void {
    const listEl = document.getElementById('date-nav-list');
    if (!listEl) return;

    listEl.innerHTML = '';

    // 无数据时显示空状态
    if (this.availableDates.size === 0) {
      const empty = document.createElement('div');
      empty.className = 'date-nav-empty';
      empty.textContent = '暂无对话记录';
      listEl.appendChild(empty);
      return;
    }

    // 按日期倒序排列（最新在前）
    const sortedDates = Array.from(this.availableDates.entries()).sort((a, b) =>
      b[0].localeCompare(a[0]),
    );

    const today = formatDateKey(new Date());
    const yesterday = formatDateKey(
      new Date(Date.now() - MS_PER_DAY),
    );

    for (const [date, count] of sortedDates) {
      const item = document.createElement('div');
      item.className = 'date-nav-item';
      item.setAttribute('role', 'option');
      item.setAttribute('data-date', date);
      // 添加 tabindex="-1" 支持键盘导航（由父容器事件委托处理）
      item.setAttribute('tabindex', '-1');
      // 补全 ARIA 可访问性：标记当前选中项（屏幕阅读器用户需感知）
      item.setAttribute('aria-selected', date === this.currentDate ? 'true' : 'false');

      if (date === this.currentDate) {
        item.classList.add('active');
      }

      // 日期显示：今天/昨天 + 日期
      let label = date;
      if (date === today) {
        label = `今天 · ${date}`;
      } else if (date === yesterday) {
        label = `昨天 · ${date}`;
      }

      const labelEl = document.createElement('span');
      labelEl.className = 'date-nav-item-label';
      labelEl.textContent = label;

      const countEl = document.createElement('span');
      countEl.className = 'date-nav-item-count';
      countEl.textContent = `${count} 条`;

      item.appendChild(labelEl);
      item.appendChild(countEl);

      // 删除按钮：今天不显示删除（避免删除当天进行中的对话）
      const isToday = date === today;
      if (!isToday) {
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'date-nav-item-delete';
        deleteBtn.title = '删除该日期的对话记录';
        deleteBtn.setAttribute('aria-label', `删除 ${date} 的对话记录`);
        // 事件委托已处理删除按钮点击，此处无需绑定
        deleteBtn.innerHTML = '<svg class="icon"><use href="#icon-trash"/></svg>';
        item.appendChild(deleteBtn);
      }

      // 事件委托已处理日期项点击，此处无需绑定
      listEl.appendChild(item);
    }
  }

  /**
   * 选择日期并跳转
   *
   * @param date 日期字符串（YYYY-MM-DD）
   */
  private selectDate(date: string): void {
    this.currentDate = date;
    this.updateButtonLabel();
    this.closeDropdown();

    if (this.jumpCallback) {
      this.jumpCallback(date);
    }
  }

  /**
   * 更新按钮显示的日期文字
   */
  private updateButtonLabel(): void {
    const labelEl = document.getElementById('date-nav-label');
    if (!labelEl) return;

    if (!this.currentDate) {
      labelEl.textContent = '选择日期';
      return;
    }

    const today = formatDateKey(new Date());
    const yesterday = formatDateKey(
      new Date(Date.now() - MS_PER_DAY),
    );

    if (this.currentDate === today) {
      labelEl.textContent = '今天';
    } else if (this.currentDate === yesterday) {
      labelEl.textContent = '昨天';
    } else {
      // 只显示月/日，节省空间
      const parts = this.currentDate.split('-');
      labelEl.textContent = `${parts[1]}/${parts[2]}`;
    }
  }

  /**
   * 更新有对话记录的日期集合
   *
   * 数据更新后立即重新渲染下拉列表，确保删除/新增会话后列表实时刷新。
   *
   * @param dates 日期列表（YYYY-MM-DD 格式）
   * @param counts 每个日期的会话数（可选，默认 1）
   */
  updateAvailableDates(dates: string[], counts?: Map<string, number>): void {
    this.availableDates.clear();
    dates.forEach((d) => {
      this.availableDates.set(d, counts?.get(d) ?? 1);
    });
    // 如果当前选中日期不在列表中，回退到最近的有记录日期
    if (this.currentDate && !this.availableDates.has(this.currentDate)) {
      const sorted = dates.sort((a, b) => b.localeCompare(a));
      this.currentDate = sorted[0] ?? '';
    }
    this.updateButtonLabel();
    // 立即重新渲染下拉列表，避免数据已更新但DOM仍显示旧内容
    this.renderDateList();
  }

  /**
   * 设置当前显示的日期
   *
   * 同时控制"回到今天"按钮的显示：仅当当前日期不是今天时显示。
   *
   * @param date 日期字符串（YYYY-MM-DD 格式），为空则清空
   */
  setCurrentDate(date: string): void {
    this.currentDate = date;
    this.updateButtonLabel();
    this.updateBackToTodayVisibility();
  }

  /**
   * 注册日期跳转回调
   *
   * @param cb 跳转回调（接收日期字符串 YYYY-MM-DD）
   */
  onDateNavJump(cb: (date: string) => void): void {
    this.jumpCallback = cb;
  }

  /**
   * 注册日期删除回调（删除指定日期的对话记录）
   *
   * @param cb 删除回调（接收日期字符串 YYYY-MM-DD）
   */
  onDateNavDelete(cb: (date: string) => void): void {
    this.deleteCallback = cb;
  }

  /**
   * 注册回到今天回调
   *
   * @param cb 回调（无参数，由 renderer.ts 注册调用 sessionController 切换到今天）
   */
  onBackToToday(cb: () => void): void {
    this.backToTodayCallback = cb;
  }

  /**
   * 更新"回到今天"按钮的可见性
   *
   * 仅当当前查看的日期不是今天时显示按钮。
   */
  private updateBackToTodayVisibility(): void {
    const btn = document.getElementById('btn-back-to-today');
    if (!btn) return;
    const today = formatDateKey(new Date());
    if (this.currentDate && this.currentDate !== today) {
      btn.classList.remove('hidden');
    } else {
      btn.classList.add('hidden');
    }
  }

  /** 清理事件监听器 */
  cleanup(): void {
    this.events.cleanup();
    this.jumpCallback = null;
    this.deleteCallback = null;
    this.backToTodayCallback = null;
    this.availableDates.clear();
    this.currentDate = '';
  }
}
