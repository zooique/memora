/**
 * 面板路由器 — 管理面板切换、导航、键盘快捷键和窗口控制
 *
 * 职责：
 * - 面板切换（switchPanel）含未保存修改检查
 * - 导航按钮点击处理（handleNavClick）
 * - 全局键盘快捷键（handleGlobalKeydown）
 * - 快捷触发（handleQuickRecordTrigger / handleRecallMemoryTrigger）
 * - 窗口控制按钮（最小化/最大化/关闭）
 * - 事件绑定初始化（init）
 *
 * 设计原则：
 * - 通过 PanelRouterHost 接口与 UIManager 解耦
 * - 持有独立 EventTracker，cleanup 时统一清理
 * - 与 UIManager 的其他子管理器（ChatPanelManager 等）同模式
 */

import { EventTracker } from '../helpers/eventTracker.js';
import { getOptionalElement } from '../helpers/domHelpers.js';
import type { UIState, ConfirmDialogOptions } from '../types.js';

// ─── PanelRouter 宿主接口 ─────────────────────────────

/** PanelRouter 所需的宿主能力（UIManager 实现此接口） */
export interface PanelRouterHost {
  // 状态访问
  /** 获取当前 UI 状态（只读副本） */
  getState(): UIState;
  /** 设置当前面板名 */
  setCurrentPanel(panel: string): void;
  /** 是否正在流式输出 */
  isStreaming(): boolean;

  // UI 元素访问
  /** 获取对话输入框元素 */
  getInputEl(): HTMLTextAreaElement;
  /** 获取停止生成按钮元素 */
  getBtnStop(): HTMLButtonElement;
  /** 获取最大化按钮元素（可能为 null） */
  getBtnMaximize(): HTMLButtonElement | null;

  // 操作委托
  /** 发送停止消息信号 */
  emitStopMessage(): void;
  /** 检查设置面板是否有未保存修改 */
  isSettingsDirty(): boolean;
  /** 重置设置面板 dirty 标志 */
  resetSettingsFormDirty(): void;
  /** 显示确认对话框 */
  showConfirmDialog(options: ConfirmDialogOptions): Promise<boolean>;
  /** 关闭记忆面板的分析面板 */
  dismissMemoryAnalysisPanels(): void;
  /** 显示弹窗 */
  showModal(modalId: string): void;
  /** 隐藏弹窗 */
  hideModal(modalId: string): void;

  // 回调访问
  /** 获取面板切换回调 */
  getPanelSwitchCallback(): ((panel: string) => void) | null;

  // 窗口控制
  /** 更新最大化按钮图标 */
  updateMaximizeButton(maximized: boolean): void;

  // 命令面板
  /** 打开命令面板 */
  openCommandPalette(): void;
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
   * 绑定：导航按钮点击、窗口控制按钮、全局键盘快捷键。
   * 非路由事件（btnStop、btnAddMemoryQuick、btnForkSession、btnCmdk）由 UIManager 自行绑定。
   * 在 UIManager 构造函数末尾调用。
   */
  init(): void {
    // 导航事件（侧边栏 .nav-btn 按钮）
    document.querySelectorAll<HTMLElement>('.nav-btn').forEach((btn) => {
      this.events.addEventListener(btn, 'click', this.handleNavClick.bind(this));
    });

    // 标题栏按钮（可选，部分布局可能不提供）
    const btnMinimize = getOptionalElement('btn-minimize', 'button');
    const btnClose = getOptionalElement('btn-close', 'button');
    if (btnMinimize) {
      this.events.addEventListener(btnMinimize, 'click', this.handleMinimize.bind(this));
    }
    const btnMaximize = this.host.getBtnMaximize();
    if (btnMaximize) {
      this.events.addEventListener(btnMaximize, 'click', this.handleMaximize.bind(this));
    }
    if (btnClose) {
      this.events.addEventListener(btnClose, 'click', this.handleClose.bind(this));
    }

    // 窗口状态变更监听（最大化按钮图标切换）
    window.electronAPI.onWindowStateChanged((msg: { maximized: boolean }) => {
      this.host.updateMaximizeButton(msg.maximized);
    });

    // 全局键盘快捷键
    this.events.addEventListener(document, 'keydown', this.handleGlobalKeydown.bind(this));
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

    // 移除所有面板活动状态
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach((b) => {
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
    }

    // 面板切换回调：通知外部控制器刷新数据
    this.host.getPanelSwitchCallback()?.(panel);
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

  // ─── 全局键盘快捷键 ────────────────────────────────

  /**
   * 全局键盘快捷键处理
   *
   * - Esc：关闭展开的下拉菜单（弹窗由 ModalManager 统一处理）
   * - Ctrl/Cmd + 1/2/3：切换面板（对话/记忆/设置）
   * - Ctrl/Cmd + .：停止生成（仅流式输出期间）
   * - Ctrl/Cmd + /：显示快捷键帮助弹窗
   */
  handleGlobalKeydown(e: Event): void {
    if (!(e instanceof KeyboardEvent)) return;
    const isMod = e.ctrlKey || e.metaKey;

    // Esc：关闭下拉菜单；设置/记忆/仪表盘/感知面板激活时切回对话
    if (e.key === 'Escape') {
      // 设置或记忆或仪表盘或感知面板激活时，Escape 切回对话面板
      const state = this.host.getState();
      if (state.currentPanel === 'settings' || state.currentPanel === 'memories' || state.currentPanel === 'dashboard' || state.currentPanel === 'perception') {
        void this.switchPanel('chat');
        e.preventDefault();
        return;
      }
      const openDropdowns = document.querySelectorAll('.dropdown:not(.hidden)');
      if (openDropdowns.length > 0) {
        openDropdowns.forEach((dropdown) => dropdown.classList.add('hidden'));
        e.preventDefault();
      }
      return;
    }

    // Ctrl/Cmd + 数字：切换面板
    if (isMod && ['1', '2', '3', '4', '5'].includes(e.key)) {
      const panelMap: Record<string, string> = {
        '1': 'chat',
        '2': 'memories',
        '3': 'settings',
        '4': 'dashboard',
        '5': 'perception',
      };
      const panel = panelMap[e.key];
      if (panel) {
        void this.switchPanel(panel);
        e.preventDefault();
      }
      return;
    }

    // Ctrl/Cmd + .：停止生成
    if (isMod && e.key === '.') {
      if (this.host.isStreaming()) {
        this.host.emitStopMessage();
        e.preventDefault();
      }
      return;
    }

    // Ctrl/Cmd + /：显示快捷键帮助弹窗
    if (isMod && e.key === '/') {
      const modal = document.getElementById('shortcuts-modal');
      if (modal) {
        if (modal.classList.contains('hidden')) {
          this.host.showModal('shortcuts-modal');
        } else {
          this.host.hideModal('shortcuts-modal');
        }
        e.preventDefault();
      }
      return;
    }
  }

  // ─── 快捷触发处理 ──────────────────────────────────

  /**
   * 处理 quick-record 快捷键触发
   *
   * 用户按下 Ctrl+Shift+M 时调用，切换到对话面板并聚焦输入框。
   */
  async handleQuickRecordTrigger(): Promise<void> {
    await this.switchPanel('chat');
  }

  /**
   * 处理 recall-memory 快捷键触发
   *
   * 用户按下 Ctrl+Shift+R 时调用，切换到记忆面板并聚焦搜索框。
   */
  async handleRecallMemoryTrigger(): Promise<void> {
    await this.switchPanel('memories');
    // 选中已有文本，方便用户直接输入新搜索词替换（静态元素，instanceof 校验）
    const searchInput = document.getElementById('memory-search');
    if (searchInput instanceof HTMLInputElement) {
      searchInput.select();
    }
  }

  // ─── 窗口控制 ──────────────────────────────────────

  /** 最小化窗口 */
  private handleMinimize(): void {
    window.electronAPI.windowMinimize();
  }

  /** 最大化/还原窗口 */
  private handleMaximize(): void {
    window.electronAPI.windowMaximize();
  }

  /** 关闭窗口（隐藏到浮动窗口） */
  private handleClose(): void {
    window.electronAPI.windowClose();
  }
}