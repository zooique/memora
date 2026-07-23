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
import { reportError } from '../helpers/errorHelpers.js';
import { setIcon } from '../helpers/icon.js';
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

  // 命令面板
  /** 打开命令面板 */
  openCommandPalette(): void;
}

// ─── PanelRouter 类 ──────────────────────────────────

export class PanelRouter {
  /** 事件监听器跟踪器（独立于 UIManager 的 EventTracker） */
  private events = new EventTracker();

  /** 信息侧栏是否展开（默认 true，用户确认默认打开） */
  private auxSidebarOpen = true;
  /** 当前激活的侧栏 tab（'perception' | 'dashboard'，默认 perception） */
  private activeAuxTab: 'perception' | 'dashboard' = 'perception';

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
      this.updateMaximizeButton(msg.maximized);
    });

    // 全局键盘快捷键
    this.events.addEventListener(document, 'keydown', this.handleGlobalKeydown.bind(this));

    // 信息侧栏 toggle 按钮（独立绑定，#btn-toggle-aux 无 data-panel 故不触发 switchPanel）
    const btnToggleAux = getOptionalElement('btn-toggle-aux', 'button');
    if (btnToggleAux) {
      this.events.addEventListener(btnToggleAux, 'click', this.handleToggleAuxClick.bind(this));
    }
    // 信息侧栏 tab 切换（感知 / 仪表盘）
    document.querySelectorAll<HTMLElement>('.aux-tab').forEach((tab) => {
      this.events.addEventListener(tab, 'click', this.handleAuxTabClick.bind(this));
    });

    // 同步信息侧栏初始 DOM 状态（与 auxSidebarOpen/activeAuxTab 默认值一致）
    this.applyAuxSidebarState();
    this.applyAuxTabState();
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

    // Esc：关闭下拉菜单 / 面板切换回对话
    if (e.key === 'Escape') {
      this.handleEscapeKey(e);
      return;
    }

    // Ctrl/Cmd + 1-4：切换主面板（chat/memories/clipboard/settings）
    if (isMod && ['1', '2', '3', '4'].includes(e.key)) {
      this.handlePanelShortcut(e);
      return;
    }

    // Ctrl/Cmd + . / /：停止生成 / 快捷键帮助
    if (isMod && (e.key === '.' || e.key === '/')) {
      this.handleActionShortcut(e);
      return;
    }
  }

  /**
   * 处理 Escape 键：关闭下拉菜单 / 弹窗打开时跳过 / 非对话面板切回对话
   *
   * 优先级：弹窗 > 命令面板/搜索弹窗 > 面板切换 > 下拉菜单
   */
  private handleEscapeKey(e: KeyboardEvent): void {
    // 弹窗或浮层打开时，Escape 交给对应管理器处理，不触发面板切换
    const openModals = document.querySelectorAll('.modal:not(.hidden)');
    if (openModals.length > 0) {
      return;
    }
    // 命令面板 / 搜索弹窗打开时，不触发面板切换（由各自管理器处理 Escape）
    const commandPalette = document.querySelector('.command-palette:not(.hidden)');
    const searchModal = document.querySelector('.search-messages-modal:not(.hidden)');
    if (commandPalette || searchModal) {
      return;
    }
    // 设置/记忆/剪贴板面板激活时，Escape 切回对话面板（感知/仪表盘现为侧栏 tab，不参与主面板 Escape）
    const state = this.host.getState();
    if (state.currentPanel === 'settings' || state.currentPanel === 'memories' || state.currentPanel === 'clipboard') {
      void this.switchPanel('chat');
      e.preventDefault();
      return;
    }
    // 无弹窗且在对话面板：关闭已展开的下拉菜单
    const openDropdowns = document.querySelectorAll('.dropdown:not(.hidden)');
    if (openDropdowns.length > 0) {
      openDropdowns.forEach((dropdown) => dropdown.classList.add('hidden'));
      e.preventDefault();
    }
  }

  /**
   * 面板快捷键映射：Ctrl/Cmd + 1-6 → chat/memories/sprite-settings/clipboard/settings
   *
   * 顶部高频区 4 项：对话(1) / 记忆(2) / 设定(3) / 剪贴板(4)；
   * 底部控制区：设置(5)。侧栏面板感知/仪表盘由 toggle + tab 控制。
   */
  private static readonly PANEL_SHORTCUT_MAP: Record<string, string> = {
    '1': 'chat',
    '2': 'memories',
    '3': 'sprite-settings',
    '4': 'clipboard',
    '5': 'settings',
  };

  /**
   * 处理 Ctrl/Cmd + 1-6：切换到对应面板
   */
  private handlePanelShortcut(e: KeyboardEvent): void {
    const panel = PanelRouter.PANEL_SHORTCUT_MAP[e.key];
    if (panel) {
      void this.switchPanel(panel);
      e.preventDefault();
    }
  }

  /**
   * 处理 Ctrl/Cmd + . 和 Ctrl/Cmd + /
   *
   * - `.`：停止生成（仅流式输出期间）
   * - `/`：切换快捷键帮助弹窗
   */
  private handleActionShortcut(e: KeyboardEvent): void {
    if (e.key === '.') {
      if (this.host.isStreaming()) {
        this.host.emitStopMessage();
        e.preventDefault();
      }
      return;
    }

    // e.key === '/'
    const modal = document.getElementById('shortcuts-modal');
    if (modal) {
      if (modal.classList.contains('hidden')) {
        this.host.showModal('shortcuts-modal');
      } else {
        this.host.hideModal('shortcuts-modal');
      }
      e.preventDefault();
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

  /**
   * 关闭完整窗口（隐藏到托盘态）
   *
   * 行为分支：取决于 showFloatBubble 偏好（由 windowStateManager 控制）：
   *   - showFloatBubble=true → 浮动气泡显示
   *   - showFloatBubble=false → 仅托盘态（用户从托盘菜单恢复）
   *
   * 关闭前检查设置面板是否有未保存修改，与 switchPanel 行为一致：
   * 有未保存修改时弹确认对话框，用户取消则中止关闭。
   */
  private async handleClose(): Promise<void> {
    try {
      const state = this.host.getState();

      // 当前在设置面板且有未保存修改时，确认后再关闭
      if (state.currentPanel === 'settings' && this.host.isSettingsDirty()) {
        const confirmed = await this.host.showConfirmDialog({
          title: '关闭窗口',
          message: '有未保存的修改，关闭后将丢失。确定要关闭吗？',
          confirmText: '关闭',
          danger: true,
        });
        if (!confirmed) return;
        // 用户选择关闭，重置 dirty 状态避免下次打开设置面板时误判
        this.host.resetSettingsFormDirty();
      }

      window.electronAPI.windowClose();
    } catch (error) {
      // 关闭失败不应阻塞 UI，仅记录日志供排查
      reportError('PanelRouter.handleClose', error);
    }
  }

  // ─── 最大化按钮图标 ────────────────────────────────

  /**
   * 更新最大化按钮图标
   *
   * 根据窗口当前是否最大化切换 SVG 图标：
   * - 最大化时显示还原图标（icon-restore）
   * - 普通状态时显示最大化图标（icon-maximize）
   *
   * 仅当 btnMaximize 元素存在时执行（部分布局可能不提供标题栏）
   */
  updateMaximizeButton(isMaximized: boolean): void {
    const btnMaximize = this.host.getBtnMaximize();
    if (!btnMaximize) return;
    const iconId = isMaximized ? 'icon-restore' : 'icon-maximize';
    setIcon(btnMaximize, iconId);
    btnMaximize.title = isMaximized ? '还原' : '最大化';
  }

  // ─── 信息侧栏（2.1 双栏布局） ──────────────────────

  /** toggle 按钮点击：展开/收起信息侧栏 */
  private handleToggleAuxClick(): void {
    this.toggleAuxSidebar();
  }

  /** aux tab 点击：切换侧栏视图（感知 / 仪表盘） */
  private handleAuxTabClick(e: Event): void {
    const target = e.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    const tab = target.dataset.auxTab;
    if (tab === 'perception' || tab === 'dashboard') {
      this.switchAuxTab(tab);
    }
  }

  /** 切换信息侧栏展开/收起（仅 #btn-toggle-aux 内部调用，无外部消费者） */
  private toggleAuxSidebar(): void {
    this.auxSidebarOpen = !this.auxSidebarOpen;
    this.applyAuxSidebarState();
  }

  /** 切换侧栏 tab（perception / dashboard，仅 .aux-tab 内部调用，无外部消费者） */
  private switchAuxTab(tab: 'perception' | 'dashboard'): void {
    if (this.activeAuxTab === tab && this.auxSidebarOpen) return; // 已激活且可见则跳过
    this.activeAuxTab = tab;
    this.applyAuxTabState();
    // 触发数据刷新（复用主面板切换回调：dashboard → loadDashboard，perception → loadPerception）
    // 仪表盘 Canvas 在面板可见后需重绘（隐藏时 getBoundingClientRect().width=0 会跳过绘制）
    this.host.getPanelSwitchCallback()?.(tab);
  }

  /** 判断指定侧栏 tab 是否当前可见（侧栏展开 + 该 tab 激活） */
  isAuxTabVisible(tab: 'perception' | 'dashboard'): boolean {
    return this.auxSidebarOpen && this.activeAuxTab === tab;
  }

  /** 打开信息侧栏（可选指定 tab），用于自动打开路径（精灵状态条 / 健康度诊断等） */
  openAuxSidebar(tab?: 'perception' | 'dashboard'): void {
    const tabChanged = tab && tab !== this.activeAuxTab;
    if (tab) {
      this.activeAuxTab = tab;
    }
    this.auxSidebarOpen = true;
    this.applyAuxSidebarState();
    this.applyAuxTabState();
    // 指定 tab 且发生变化时触发数据刷新（仪表盘 Canvas 重绘等）
    if (tab && tabChanged) {
      this.host.getPanelSwitchCallback()?.(tab);
    }
  }

  /** 将侧栏展开状态同步到 DOM（#main-content.aux-open + #btn-toggle-aux.active + aria-pressed） */
  private applyAuxSidebarState(): void {
    const mainContent = document.getElementById('main-content');
    const btnToggleAux = getOptionalElement('btn-toggle-aux', 'button');
    if (this.auxSidebarOpen) {
      mainContent?.classList.add('aux-open');
      btnToggleAux?.classList.add('active');
      btnToggleAux?.setAttribute('aria-pressed', 'true');
    } else {
      mainContent?.classList.remove('aux-open');
      btnToggleAux?.classList.remove('active');
      btnToggleAux?.setAttribute('aria-pressed', 'false');
    }
  }

  /** 将当前 tab 状态同步到 DOM（.aux-tab.aux-active + 对应 .panel.aux-active） */
  private applyAuxTabState(): void {
    // tab 按钮
    document.querySelectorAll('.aux-tab').forEach((tab) => {
      const tabName = tab.getAttribute('data-aux-tab');
      if (tabName === this.activeAuxTab) {
        tab.classList.add('aux-active');
        tab.setAttribute('aria-selected', 'true');
      } else {
        tab.classList.remove('aux-active');
        tab.setAttribute('aria-selected', 'false');
      }
    });
    // 面板（通过 id 匹配 tab：panel-perception / panel-dashboard）
    const perceptionPanel = document.getElementById('panel-perception');
    const dashboardPanel = document.getElementById('panel-dashboard');
    perceptionPanel?.classList.toggle('aux-active', this.activeAuxTab === 'perception');
    dashboardPanel?.classList.toggle('aux-active', this.activeAuxTab === 'dashboard');
  }
}