/**
 * 日期导航管理器 — 有记录日期下拉列表
 *
 * 从原生 <input type="date"> 重构为自定义下拉列表。
 * 只显示有对话记录的日期，无记录日期不显示，避免用户困惑。
 * 日期按倒序排列（最新在前），每个日期显示会话数。
 *
 * 职责：
 * - 编排日期导航下拉的展开/收起流程
 * - 管理日期数据（availableDates / currentDate）
 * - 通过 DateNavDropdownComponent 封装 DOM 操作与事件绑定
 * - 点击日期项触发跳转回调
 *
 * 设计原则（对齐 ARCH-COMP-1 阶段 4「Manager 编排 + Component 封装」）：
 * - Manager 持有 Component 实例，init() 创建并委托事件绑定，cleanup() 销毁
 * - DOM 操作（getElementById / createElement / classList）全部下沉到 Component
 * - 业务逻辑（selectDate 跳转、日期数据管理、Alt 翻日计算）保留在 Manager
 * - 与 UIManager 解耦，通过回调接口通信
 * - 日期数据来自 updateAvailableDates()，由外部（sessionController）提供
 *
 * 生命周期：
 * - init() 创建并挂载 Component，委托绑定事件（支持 cleanup() 后重新 init 重建）
 * - cleanup() 销毁 Component（解绑事件）+ 清空回调与日期数据
 */
import { DateNavDropdownComponent } from '../components/data/dateNavDropdownComponent.js';

/**
 * 日期导航管理器类
 *
 * 生命周期：init() 创建 Component + 绑定事件 → cleanup() 销毁 Component + 清空回调
 */
export class DateNavManager {
  /** 日期导航下拉组件（封装 DOM 操作与事件绑定；init 创建，cleanup 销毁） */
  private dateNavComponent: DateNavDropdownComponent | null = null;
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
   * 创建并挂载 DateNavDropdownComponent，委托其绑定所有 DOM 事件。
   * 业务决策通过回调注入 Component（toggle / selectDate / delete / backToToday / Alt 翻日）。
   * 在 UIManager 构造完成后调用；支持 cleanup() 后重新调用以重建事件绑定。
   */
  init(): void {
    // 创建并挂载组件（查询并缓存 5 个 DOM 元素引用，不创建新元素）
    const component = new DateNavDropdownComponent().mount('');
    this.dateNavComponent = component;
    // 委托组件绑定 DOM 事件，注入业务回调
    component.initEvents(
      /* onToggle */ () => {
        // 根据当前展开状态决定展开或收起
        if (this.dateNavComponent?.isExpanded()) {
          this.closeDropdown();
        } else {
          this.openDropdown();
        }
      },
      /* onSelectDate */ (date: string) => {
        // 日期项点击/Enter：执行跳转业务逻辑
        this.selectDate(date);
      },
      /* onDeleteDate */ (date: string) => {
        // 删除按钮点击：触发删除回调
        this.deleteCallback?.(date);
      },
      /* onBackToToday */ () => {
        // 回到今天按钮点击：触发回到今天回调
        this.backToTodayCallback?.();
      },
      /* onGlobalAltArrow */ (e: KeyboardEvent) => {
        // 全局 Alt+←/→ 翻日：基于已加载日期集合计算目标日期
        this.handleAltArrow(e);
      },
    );
  }

  /**
   * 处理 Alt+←/→ 翻日快捷键
   *
   * 基于已加载的 availableDates 排序后查找前/后一天，无记录的日期自动跳过。
   * Component 仅做按键过滤（确认是 Alt+方向键），具体日期计算在此完成。
   *
   * @param e 键盘事件（已确认为 Alt+ArrowLeft/ArrowRight）
   */
  private handleAltArrow(e: KeyboardEvent): void {
    // 无日期数据或未选中日期时跳过
    if (this.availableDates.size === 0 || !this.currentDate) return;

    // 升序排列（旧→新），与 ArrowLeft=往前(更早)、ArrowRight=往后(更晚) 语义一致
    const sortedDates = Array.from(this.availableDates.keys()).sort((a, b) =>
      a.localeCompare(b),
    );
    const currentIdx = sortedDates.indexOf(this.currentDate);
    if (currentIdx === -1) return;

    // 计算目标索引，越界时跳过（已在最早/最新日期）
    const targetIdx = e.key === 'ArrowLeft' ? currentIdx - 1 : currentIdx + 1;
    if (targetIdx < 0 || targetIdx >= sortedDates.length) return;

    e.preventDefault();
    // 边界检查已确保 targetIdx ∈ [0, length)，sortedDates[targetIdx] 必有值
    const targetDate = sortedDates[targetIdx]!;
    this.selectDate(targetDate);
  }

  /**
   * 展开下拉列表
   *
   * 委托 Component 设置 aria-expanded + 移除 hidden，随后重新渲染日期列表。
   */
  private openDropdown(): void {
    this.dateNavComponent?.openDropdown();
    this.renderDateList();
  }

  /**
   * 收起下拉列表
   *
   * 委托 Component 重置 aria-expanded + 添加 hidden。
   */
  private closeDropdown(): void {
    this.dateNavComponent?.closeDropdown();
  }

  /**
   * 渲染日期列表
   *
   * 委托 Component 按日期倒序排列渲染，每个项显示日期 + 当天会话数。
   * 当前选中日期高亮。
   */
  private renderDateList(): void {
    this.dateNavComponent?.renderDateList(this.availableDates, this.currentDate);
  }

  /**
   * 选择日期并跳转
   *
   * 业务逻辑：更新 currentDate + 更新按钮文字 + 关闭下拉 + 触发跳转回调。
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
   *
   * 委托 Component 更新按钮标签（今天/昨天/月日）。
   */
  private updateButtonLabel(): void {
    this.dateNavComponent?.updateButtonLabel(this.currentDate);
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
   * 委托 Component：仅当当前查看的日期不是今天时显示按钮。
   */
  private updateBackToTodayVisibility(): void {
    this.dateNavComponent?.updateBackToTodayVisibility(this.currentDate);
  }

  /**
   * 清理事件监听器 + 销毁组件 + 清空回调
   *
   * 销毁 Component 会解绑所有 DOM 事件并 nullify 元素引用。
   * 清空回调与日期数据，防止 cleanup 后误触发。
   * 支持随后重新调用 init() 重建（创建新的 Component 实例）。
   */
  cleanup(): void {
    // 销毁组件（解绑所有 DOM 事件 + nullify 元素引用）
    this.dateNavComponent?.destroy();
    this.dateNavComponent = null;
    this.jumpCallback = null;
    this.deleteCallback = null;
    this.backToTodayCallback = null;
    this.availableDates.clear();
    this.currentDate = '';
  }
}
