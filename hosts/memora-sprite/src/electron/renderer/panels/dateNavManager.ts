/**
 * 日期导航面板管理器
 *
 * C-5-3：从 UIManager 拆分（约 99 行），统一管理"日期导航"功能的 UI 联动。
 *
 * 职责：
 * - 绑定日期导航按钮（#date-nav-btn）、列表（#date-nav-list）、文档点击事件
 * - 下拉打开时触发列表加载回调，让控制器拉取最新日期列表
 * - 列表项点击时触发跳转回调，让控制器切换到对应日期的对话
 * - 列表项删除按钮点击时触发删除回调（FD-09 删除对话记录）
 * - 渲染日期列表（今天/昨天/前天/完整日期，含消息数 + 删除按钮）
 *
 * 设计原则：
 * - 自包含事件监听器管理（EventTracker），与 UIManager 解耦
 * - 通过 init() 在 UIManager 构造完成后绑定事件，cleanup() 统一清理
 * - 公共 API：onDateNavJump / onDateNavDelete / onDateNavOpen / toggle / close / renderDateNavList
 */

import { EventTracker } from '../helpers/eventTracker.js';
// 精灵公共常量（时间常量，跨进程共享 DRY）
import { MS_PER_DAY } from '../../../sprite/constants.js';

/** 日期列表项类型（日期、消息数、是否今天） */
interface DateNavItem {
  date: string;
  messageCount: number;
  isToday: boolean;
}

/**
 * 日期导航面板管理器类
 *
 * 职责：日期下拉的显示/隐藏、列表渲染、跳转/删除回调分发
 * 依赖：EventTracker（事件监听器管理）
 * 生命周期：init() 绑定事件 → cleanup() 清理事件 + 回调
 */
export class DateNavManager {
  /** 事件监听器跟踪器（统一管理事件监听器的注册与清理，避免内存泄漏） */
  private events = new EventTracker();
  /** 日期导航跳转回调（由 renderer.ts 注册，调用 sessionController.jumpToDate） */
  private dateNavJumpCallback: ((date: string) => void) | null = null;
  /** 日期导航删除回调（由 renderer.ts 注册，调用 sessionController.deleteSession） */
  private dateNavDeleteCallback: ((date: string) => void) | null = null;
  /** 日期导航列表加载回调（下拉打开时触发，由 renderer.ts 注册） */
  private dateNavLoadCallback: (() => void) | null = null;

  /**
   * 初始化事件监听器
   *
   * 在 UIManager 构造完成后调用。绑定 3 个事件监听器：
   * - #date-nav-btn click：切换下拉显示/隐藏
   * - #date-nav-list click：列表项点击触发跳转 / 删除按钮点击触发删除
   * document click：点击外部关闭下拉
   */
  init(): void {
    // UX-FD-07 日期导航按钮：点击切换下拉显示/隐藏
    const dateNavBtn = document.getElementById('date-nav-btn');
    if (dateNavBtn) {
      this.events.addEventListener(dateNavBtn, 'click', (e) => {
        e.stopPropagation();
        this.toggleDateNavDropdown();
      });
    }
    // 日期导航列表点击事件委托：区分跳转和删除两种 action
    const dateNavList = document.getElementById('date-nav-list');
    if (dateNavList) {
      this.events.addEventListener(dateNavList, 'click', (e) => {
        const target = e.target as HTMLElement;
        // FD-09 删除按钮点击：优先处理（避免触发父级跳转）
        const deleteBtn = target.closest<HTMLElement>('[data-action="delete-date"]');
        if (deleteBtn) {
          e.stopPropagation();
          const date = deleteBtn.dataset.date ?? '';
          if (date && this.dateNavDeleteCallback) {
            this.dateNavDeleteCallback(date);
          }
          return;
        }
        // 跳转到指定日期
        const item = target.closest<HTMLElement>('[data-action="jump-to-date"]');
        if (item && this.dateNavJumpCallback) {
          const date = item.dataset.date ?? '';
          if (date) {
            this.closeDateNavDropdown();
            this.dateNavJumpCallback(date);
          }
        }
      });
    }
    // 点击其他区域关闭日期导航下拉
    this.events.addEventListener(document, 'click', (e) => {
      const navigator = document.getElementById('date-navigator');
      if (navigator && !navigator.contains(e.target as Node)) {
        this.closeDateNavDropdown();
      }
    });
  }

  /**
   * 注册日期导航跳转回调
   *
   * @param cb 跳转回调（接收日期字符串 YYYY-MM-DD）
   */
  onDateNavJump(cb: (date: string) => void): void {
    this.dateNavJumpCallback = cb;
  }

  /**
   * 注册日期导航删除回调（FD-09 删除对话记录）
   *
   * @param cb 删除回调（接收日期字符串 YYYY-MM-DD）
   */
  onDateNavDelete(cb: (date: string) => void): void {
    this.dateNavDeleteCallback = cb;
  }

  /**
   * 注册日期导航列表加载回调（下拉打开时触发）
   *
   * @param cb 加载回调（无参数，由控制器自行拉取日期列表）
   */
  onDateNavOpen(cb: () => void): void {
    this.dateNavLoadCallback = cb;
  }

  /** 切换日期导航下拉的显示/隐藏 */
  toggleDateNavDropdown(): void {
    const dropdown = document.getElementById('date-nav-dropdown');
    if (dropdown) {
      const wasHidden = dropdown.classList.contains('hidden');
      dropdown.classList.toggle('hidden');
      // 下拉打开时触发列表加载（确保数据最新）
      if (wasHidden && this.dateNavLoadCallback) {
        this.dateNavLoadCallback();
      }
    }
  }

  /** 关闭日期导航下拉 */
  closeDateNavDropdown(): void {
    const dropdown = document.getElementById('date-nav-dropdown');
    if (dropdown) {
      dropdown.classList.add('hidden');
    }
  }

  /**
   * 渲染日期列表到日期导航下拉
   *
   * 每个日期项包含：日期标签 + 消息数 + 删除按钮（今天不显示删除按钮）。
   *
   * @param dates 日期列表（每项包含日期、消息数、是否今天）
   * @param currentDate 当前查看的日期（用于高亮 active 项）
   */
  renderDateNavList(dates: DateNavItem[], currentDate: string): void {
    const list = document.getElementById('date-nav-list');
    if (!list) return;

    // 清空旧列表
    while (list.firstChild) {
      list.removeChild(list.firstChild);
    }

    if (dates.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'date-nav-empty';
      empty.textContent = '暂无历史对话';
      list.appendChild(empty);
      return;
    }

    for (const item of dates) {
      const li = document.createElement('li');
      li.className = 'date-nav-item';
      if (item.date === currentDate) {
        li.classList.add('active');
      }
      // data-action="jump-to-date" data-date="YYYY-MM-DD"
      li.dataset.action = 'jump-to-date';
      li.dataset.date = item.date;

      const dateEl = document.createElement('span');
      dateEl.className = 'date-nav-item-date';
      // 今天显示"今天"，昨天显示"昨天"，其他显示完整日期
      if (item.isToday) {
        dateEl.textContent = '今天';
      } else {
        // 简单的相对日期显示
        const today = new Date();
        const target = new Date(item.date);
        const diffDays = Math.floor((today.getTime() - target.getTime()) / MS_PER_DAY);
        if (diffDays === 1) {
          dateEl.textContent = '昨天';
        } else if (diffDays === 2) {
          dateEl.textContent = '前天';
        } else {
          dateEl.textContent = item.date;
        }
      }

      const countEl = document.createElement('span');
      countEl.className = 'date-nav-item-count';
      countEl.textContent = `${item.messageCount} 条`;

      // FD-09 删除按钮：今天不显示删除（避免删除当天进行中的对话）
      if (!item.isToday) {
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'date-nav-item-delete';
        deleteBtn.title = '删除该日期的对话记录';
        deleteBtn.setAttribute('aria-label', `删除 ${item.date} 的对话记录`);
        // data-action="delete-date" data-date="YYYY-MM-DD"（与列表项共享 date）
        deleteBtn.dataset.action = 'delete-date';
        deleteBtn.dataset.date = item.date;
        deleteBtn.innerHTML = '<svg class="icon"><use href="#icon-trash"/></svg>';
        li.appendChild(dateEl);
        li.appendChild(countEl);
        li.appendChild(deleteBtn);
      } else {
        li.appendChild(dateEl);
        li.appendChild(countEl);
      }
      list.appendChild(li);
    }
  }

  /** 清理事件监听器 */
  cleanup(): void {
    this.events.cleanup();
    this.dateNavJumpCallback = null;
    this.dateNavDeleteCallback = null;
    this.dateNavLoadCallback = null;
  }
}
