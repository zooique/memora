/**
 * 面板路由器（瘦身后）—— 仅负责主面板切换 + 导航按钮点击
 *
 * HEAL-12 拆分后保留的核心职责：
 * - switchPanel：主面板切换（chat/memories/settings/clipboard/sprite-settings）含未保存修改检查
 * - handleNavClick：侧边栏导航按钮点击分发
 *
 * 已拆出的职责（HEAL-12 模式 B 职责拆分）：
 * - 窗口控制（最小化/最大化/关闭） → WindowControlsController
 * - AUX 侧栏（展开/收起/tab 切换） → AuxSidebarManager
 * - 全局快捷键（Ctrl+1-5/Esc/Ctrl+./Ctrl+/）+ 快捷触发 → GlobalShortcutDispatcher
 *
 * 设计原则：
 * - 通过 PanelRouterHost 接口与 UIManager 解耦
 * - 持有独立 EventTracker，cleanup 时统一清理
 * - Host 接口最小化（仅含面板切换所需 9 个方法）
 */

import { EventTracker } from '../helpers/eventTracker.js';
import { reportError } from '../helpers/errorHelpers.js';
import type { UIState, ConfirmDialogOptions } from '../types.js';

// ─── PanelRouter 宿主接口 ─────────────────────────────

/** PanelRouter 所需的宿主能力（UIManager 实现此接口） */
export interface PanelRouterHost {
  // 状态访问
  /** 获取当前 UI 状态（只读副本） */
  getState(): UIState;
  /** 设置当前面板名 */
  setCurrentPanel(panel: string): void;

  // UI 元素访问
  /** 获取对话输入框元素（切到 chat 时聚焦） */
  getInputEl(): HTMLTextAreaElement;

  // 操作委托
  /** 检查设置面板是否有未保存修改 */
  isSettingsDirty(): boolean;
  /** 重置设置面板 dirty 标志 */
  resetSettingsFormDirty(): void;
  /** 显示确认对话框（离开设置面板时） */
  showConfirmDialog(options: ConfirmDialogOptions): Promise<boolean>;
  /** 关闭记忆面板的分析面板（离开 memories 时） */
  dismissMemoryAnalysisPanels(): void;
  /** 进入记忆面板时确保当前激活区块视图可见 */
  activateMemoryPanelView(): void;

  // 回调访问
  /** 获取面板切换回调（通知外部控制器刷新数据） */
  getPanelSwitchCallback(): ((panel: string) => void) | null;
}

// ─── PanelRouter 类 ──────────────────────────────────

export class PanelRouter {
  /** 事件监听器跟踪器（独立于 UIManager 的 EventTracker） */
  private events = new EventTracker();

  constructor(private host: PanelRouterHost) {}

  // ─── 初始化 ────────────────────────────────────────

  /**
   * 初始化面板路由相关的事件监听器
   *
   * HEAL-12 拆分后仅绑定侧边栏 .nav-btn 导航按钮 click。
   * 窗口控制/AUX 侧栏/全局快捷键已分别迁移到 WindowControlsController / AuxSidebarManager / GlobalShortcutDispatcher。
   */
  init(): void {
    // 导航事件（侧边栏 .nav-btn 按钮）
    document.querySelectorAll<HTMLElement>('.nav-btn').forEach((btn) => {
      this.events.addEventListener(btn, 'click', this.handleNavClick.bind(this));
    });
  }

  // ─── 清理 ──────────────────────────────────────────

  /** 清理所有事件监听器 */
  cleanup(): void {
    this.events.cleanup();
  }

  // ─── 面板切换 ──────────────────────────────────────

  /**
   * 切换面板
   *
   * 切换前检查当前面板是否有未保存修改，
   * 有则弹出确认对话框，用户取消则中止切换。
   *
   * chat/memories/settings 三个面板均通过 .panel.active 控制显隐，
   * 替换核心区域内容。切换到 chat 自动聚焦输入框，切换到 memories 聚焦搜索框。
   */
  async switchPanel(panel: string): Promise<void> {
    try {
      const state = this.host.getState();

      // 当前在设置面板且有未保存修改时，确认后再切换
      if (state.currentPanel === 'settings' && this.host.isSettingsDirty()) {
        const confirmed = await this.host.showConfirmDialog({
          title: '离开设置',
          message: '有未保存的修改，离开后将丢失。确定要离开吗？',
          confirmText: '离开',
          danger: true,
        });
        if (!confirmed) return;
        // 用户选择离开，重置 dirty 状态避免后续切换重复提示
        this.host.resetSettingsFormDirty();
      }

      // 移除所有面板活动状态（侧栏面板使用 .aux-active 而非 .active，故全局移除 .active 无副作用）
      document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
      // 仅清除带 data-panel 的导航按钮 active 态（排除 #btn-toggle-aux，其 active 表示侧栏打开）
      document.querySelectorAll('.nav-btn[data-panel]').forEach((b) => {
        b.classList.remove('active');
        // 清除其他导航的 aria-current，避免屏幕阅读器误读多个"当前页"
        b.removeAttribute('aria-current');
      });

      // 激活目标面板
      const panelEl = document.getElementById(`panel-${panel}`);
      const navBtn = document.querySelector(`.nav-btn[data-panel="${panel}"]`);

      panelEl?.classList.add('active');
      panelEl?.setAttribute('aria-hidden', 'false');
      navBtn?.classList.add('active');
      // 标记当前所在面板，辅助屏幕阅读器识别"当前页"位置
      navBtn?.setAttribute('aria-current', 'page');

      // 将之前激活的面板设为 aria-hidden=true
      if (state.currentPanel && state.currentPanel !== panel) {
        const prevPanel = document.getElementById(`panel-${state.currentPanel}`);
        prevPanel?.setAttribute('aria-hidden', 'true');
        // 离开记忆面板时，关闭所有分析面板
        if (state.currentPanel === 'memories') {
          this.host.dismissMemoryAnalysisPanels();
        }
      }

      this.host.setCurrentPanel(panel);

      // 切换面板后重置滚动位置到顶部
      requestAnimationFrame(() => {
        document.documentElement.scrollTop = 0;
        document.body.scrollTop = 0;
        const mainContent = document.getElementById('main-content');
        if (mainContent) mainContent.scrollTop = 0;
        panelEl?.scrollTo?.(0, 0);
      });

      // 切换到对话面板时自动聚焦输入框
      if (panel === 'chat') {
        this.host.getInputEl().focus();
      }
      // 切换到记忆面板时聚焦搜索框（静态元素，instanceof 校验）
      if (panel === 'memories') {
        const searchInput = document.getElementById('memory-search');
        if (searchInput instanceof HTMLInputElement) {
          searchInput.focus();
        }
        // 确保当前激活区块视图可见（默认 list 容器可能处于 hidden，兜底同步显隐）
        this.host.activateMemoryPanelView();
      }
      // P1-4 用户体验打磨：其他面板切换后将焦点移到面板容器，
      // 让键盘用户能直接 Tab 导航面板内容，而非从顶部导航按钮开始。
      // tabindex="-1" 让容器可编程聚焦但不进入 Tab 顺序（避免破坏正常 Tab 流）。
      // preventScroll:true 避免焦点切换引发意外滚动（与上面 requestAnimationFrame 重置滚动协作）。
      if (panel !== 'chat' && panel !== 'memories' && panelEl) {
        panelEl.tabIndex = -1;
        panelEl.focus({ preventScroll: true });
      }

      // 面板切换回调：通知外部控制器刷新数据
      this.host.getPanelSwitchCallback()?.(panel);
    } catch (error) {
      // 面板切换失败不应崩溃 UI，仅记录日志供排查（DOM 异常 / showConfirmDialog 抛错等）
      reportError('PanelRouter.switchPanel', error);
    }
  }

  // ─── 导航事件处理 ──────────────────────────────────

  /**
   * 侧边栏导航按钮点击处理器
   *
   * 点击侧边栏图标切换到对应面板（chat / memory / settings）。
   */
  handleNavClick(e: Event): void {
    const target = e.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    const panel = target.dataset.panel;
    if (panel) {
      void this.switchPanel(panel);
    }
  }

  /**
   * 给指定面板的导航按钮添加 pulse 高亮动画（MIND2-D5：消除跨面板 DOM 耦合）
   *
   * 原由 chatPanelManager 直接 `document.querySelector('.nav-btn[data-panel="dashboard"]')`
   * 操作 PanelRouter 管辖的 DOM。现统一收口到 PanelRouter，外部通过此方法触发，
   * 避免跨面板 DOM 耦合（违反 §2.1「逻辑被 UI 绑架」）。
   *
   * @param panel 目标面板名（如 'dashboard'）
   */
  pulseNavButton(panel: string): void {
    const navBtn = document.querySelector(`.nav-btn[data-panel="${panel}"]`);
    if (navBtn instanceof HTMLElement) {
      navBtn.classList.add('pulse-highlight');
      // 500ms 后移除高亮类（与 CSS 动画时长一致）
      window.setTimeout(() => navBtn.classList.remove('pulse-highlight'), 500);
    }
  }
}
