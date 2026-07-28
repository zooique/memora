/**
 * 全局快捷键 Dispatcher —— 管理键盘快捷键 + 快捷触发入口
 *
 * HEAL-12 从 PanelRouter 拆分（模式 B 职责拆分）。原 PanelRouter 6 职责过载，
 * 快捷键与面板切换/窗口控制/AUX 侧栏正交，独立为 Dispatcher。
 *
 * 职责：
 * - document keydown 全局监听
 * - Esc：关闭下拉/弹窗打开时跳过/非对话面板切回对话
 * - Ctrl/Cmd + 1-5：切换主面板（chat/memories/sprite-settings/clipboard/settings）
 * - Ctrl/Cmd + . ：停止生成（仅流式输出期间）
 * - Ctrl/Cmd + / ：快捷键帮助弹窗
 * - handleQuickRecordTrigger / handleRecallMemoryTrigger：Ctrl+Shift+M / Ctrl+Shift+R 入口
 *
 * 跨 Controller 依赖：
 * - 通过 host.switchPanel 委托到 PanelRouter（不直接持有 PanelRouter 引用，避免循环依赖）
 * - 由 UIManager 作为 composition root 中转（progressive-refactor-rules.md §5.3 跨 Service 依赖处理）
 *
 * 设计原则：
 * - 通过 GlobalShortcutHost 接口与 UIManager 解耦
 * - 持有独立 EventTracker，cleanup 时统一清理
 * - 与 PanelRouter / WindowControlsController / AuxSidebarManager 同层并列
 */

import { EventTracker } from '../helpers/eventTracker.js';
import type { UIState } from '../types.js';

// ─── GlobalShortcutDispatcher 宿主接口 ────────────────

/** GlobalShortcutDispatcher 所需的宿主能力（UIManager 实现此接口） */
export interface GlobalShortcutHost {
  /** 获取当前 UI 状态（用于 Escape 判断当前面板） */
  getState(): UIState;
  /** 是否正在流式输出（Ctrl+. 触发条件） */
  isStreaming(): boolean;
  /** 发送停止消息信号（Ctrl+. 触发） */
  emitStopMessage(): void;
  /** 显示弹窗（Ctrl+/ 切换 shortcuts-modal） */
  showModal(modalId: string): void;
  /** 隐藏弹窗 */
  hideModal(modalId: string): void;
  /** 切换面板（Ctrl+1-5 / Esc 切回 chat 时调用，UIManager 委托到 PanelRouter.switchPanel） */
  switchPanel(panel: string): Promise<void>;
}

// ─── GlobalShortcutDispatcher 类 ──────────────────────

export class GlobalShortcutDispatcher {
  /** 事件监听器跟踪器（独立于 UIManager 的 EventTracker） */
  private events = new EventTracker();

  constructor(private host: GlobalShortcutHost) {}

  // ─── 初始化 ────────────────────────────────────────

  /**
   * 初始化全局键盘快捷键监听
   *
   * 绑定 document keydown，分发到对应处理器。
   * 在 UIManager 构造函数末尾调用（与 PanelRouter.init 同阶段）。
   */
  init(): void {
    this.events.addEventListener(document, 'keydown', this.handleGlobalKeydown.bind(this));
  }

  // ─── 清理 ──────────────────────────────────────────

  /** 清理所有事件监听器 */
  cleanup(): void {
    this.events.cleanup();
  }

  // ─── 快捷触发入口（外部调用） ──────────────────────

  /**
   * 处理 quick-record 快捷键触发
   *
   * 用户按下 Ctrl+Shift+M 时调用，切换到对话面板并聚焦输入框。
   * 通过 host.switchPanel 委托到 PanelRouter.switchPanel。
   */
  async handleQuickRecordTrigger(): Promise<void> {
    await this.host.switchPanel('chat');
  }

  /**
   * 处理 recall-memory 快捷键触发
   *
   * 用户按下 Ctrl+Shift+R 时调用，切换到记忆面板并聚焦搜索框。
   * 通过 host.switchPanel 委托到 PanelRouter.switchPanel。
   */
  async handleRecallMemoryTrigger(): Promise<void> {
    await this.host.switchPanel('memories');
    // 选中已有文本，方便用户直接输入新搜索词替换（静态元素，instanceof 校验）
    const searchInput = document.getElementById('memory-search');
    if (searchInput instanceof HTMLInputElement) {
      searchInput.select();
    }
  }

  // ─── 全局键盘快捷键 ────────────────────────────────

  /**
   * 全局键盘快捷键处理
   *
   * - Esc：关闭展开的下拉菜单（弹窗由 ModalManager 统一处理）
   * - Ctrl/Cmd + 1/2/3/4/5：切换面板（对话/记忆/设定/剪贴板/设置）
   * - Ctrl/Cmd + .：停止生成（仅流式输出期间）
   * - Ctrl/Cmd + /：显示快捷键帮助弹窗
   */
  private handleGlobalKeydown(e: Event): void {
    if (!(e instanceof KeyboardEvent)) return;
    const isMod = e.ctrlKey || e.metaKey;

    // Esc：关闭下拉菜单 / 面板切换回对话
    if (e.key === 'Escape') {
      this.handleEscapeKey(e);
      return;
    }

    // Ctrl/Cmd + 1-5：切换主面板（chat/memories/sprite-settings/clipboard/settings）
    if (isMod && ['1', '2', '3', '4', '5'].includes(e.key)) {
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
      void this.host.switchPanel('chat');
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
   * 面板快捷键映射：Ctrl/Cmd + 1-5 → chat/memories/sprite-settings/clipboard/settings
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

  /** 处理 Ctrl/Cmd + 1-5：切换到对应面板 */
  private handlePanelShortcut(e: KeyboardEvent): void {
    const panel = GlobalShortcutDispatcher.PANEL_SHORTCUT_MAP[e.key];
    if (panel) {
      void this.host.switchPanel(panel);
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
}
