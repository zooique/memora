/**
 * 信息侧栏 Manager —— 管理 AUX 侧栏展开/收起 + tab 切换
 *
 * HEAL-12 从 PanelRouter 拆分（模式 B 职责拆分）。原 PanelRouter 6 职责过载，
 * AUX 侧栏状态与面板切换/快捷键/窗口控制正交，独立为 Manager。
 *
 * 职责：
 * - 持有 auxSidebarOpen + activeAuxTab 状态
 * - 绑定 btn-toggle-aux + .aux-tab 点击事件
 * - applyAuxSidebarState / applyAuxTabState 同步 DOM
 * - open / isVisible 对外 API（命令面板/主动触发/精灵状态条点击）
 *
 * 命名调整（HEAL-12 拆分时对齐"独立 Controller"语义）：
 * - openAuxSidebar(tab?) → open(tab?)
 * - isAuxTabVisible(tab) → isVisible(tab)
 * UIManager 通过 sugar API 保留原方法名供外部调用方使用。
 *
 * 设计原则：
 * - 通过 AuxSidebarHost 接口与 UIManager 解耦
 * - 持有独立 EventTracker，cleanup 时统一清理
 * - 与 PanelRouter / WindowControlsController / GlobalShortcutDispatcher 同层并列
 */

import { EventTracker } from '../helpers/eventTracker.js';
import { getOptionalElement } from '../helpers/domHelpers.js';

// ─── AuxSidebarManager 宿主接口 ───────────────────────

/** AuxSidebarManager 所需的宿主能力（UIManager 实现此接口） */
export interface AuxSidebarHost {
  /** 获取面板切换回调（tab 切换时触发数据刷新：perception→loadPerception，dashboard→loadDashboard） */
  getPanelSwitchCallback(): ((panel: string) => void) | null;
}

// ─── AuxSidebarManager 类 ─────────────────────────────

export class AuxSidebarManager {
  /** 事件监听器跟踪器（独立于 UIManager 的 EventTracker） */
  private events = new EventTracker();

  /** 信息侧栏是否展开（默认 true，用户确认默认打开） */
  private auxSidebarOpen = true;
  /**
   * 当前激活的侧栏 tab
   * P1-1: 新增 'tasks' 任务表面板 tab
   */
  private activeAuxTab: 'perception' | 'dashboard' | 'tasks' = 'perception';

  constructor(private host: AuxSidebarHost) {}

  // ─── 初始化 ────────────────────────────────────────

  /**
   * 初始化信息侧栏事件监听器 + DOM 状态同步
   *
   * 绑定：btn-toggle-aux click + .aux-tab click。
   * 同步初始 DOM 状态（与 auxSidebarOpen/activeAuxTab 默认值一致）。
   * 在 UIManager 构造函数末尾调用（与 PanelRouter.init 同阶段）。
   */
  init(): void {
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

  // ─── 对外 API ──────────────────────────────────────

  /**
   * 打开信息侧栏（可选指定 tab），用于自动打开路径
   *
   * 调用方：精灵状态条点击 / 命令面板 Ctrl+K / 主动触发（洞察/里程碑/模式/建议）
   * 由 UIManager.openAuxSidebar sugar API 委托到此。
   */
  open(tab?: 'perception' | 'dashboard' | 'tasks'): void {
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

  /**
   * 判断指定侧栏 tab 是否当前可见（侧栏展开 + 该 tab 激活）
   *
   * 调用方：onPersonaChanged 事件（感知面板可见时同步刷新）
   * 由 UIManager.isAuxTabVisible sugar API 委托到此。
   */
  isVisible(tab: 'perception' | 'dashboard' | 'tasks'): boolean {
    return this.auxSidebarOpen && this.activeAuxTab === tab;
  }

  // ─── 内部处理 ──────────────────────────────────────

  /** toggle 按钮点击：展开/收起信息侧栏 */
  private handleToggleAuxClick(): void {
    this.toggleAuxSidebar();
  }

  /** aux tab 点击：切换侧栏视图（感知 / 仪表盘） */
  private handleAuxTabClick(e: Event): void {
    const target = e.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    const tab = target.dataset.auxTab;
    if (tab === 'perception' || tab === 'dashboard' || tab === 'tasks') {
      this.switchAuxTab(tab);
    }
  }

  /** 切换信息侧栏展开/收起（仅 #btn-toggle-aux 内部调用，无外部消费者） */
  private toggleAuxSidebar(): void {
    this.auxSidebarOpen = !this.auxSidebarOpen;
    this.applyAuxSidebarState();
  }

  /** 切换侧栏 tab（perception / dashboard / tasks，仅 .aux-tab 内部调用，无外部消费者） */
  private switchAuxTab(tab: 'perception' | 'dashboard' | 'tasks'): void {
    if (this.activeAuxTab === tab && this.auxSidebarOpen) return; // 已激活且可见则跳过
    this.activeAuxTab = tab;
    this.applyAuxTabState();
    // 触发数据刷新（复用主面板切换回调：dashboard → loadDashboard，perception → loadPerception）
    // 仪表盘 Canvas 在面板可见后需重绘（隐藏时 getBoundingClientRect().width=0 会跳过绘制）
    this.host.getPanelSwitchCallback()?.(tab);
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
    // 面板（通过 id 匹配 tab：panel-perception / panel-dashboard / panel-tasks）
    const perceptionPanel = document.getElementById('panel-perception');
    const dashboardPanel = document.getElementById('panel-dashboard');
    const tasksPanel = document.getElementById('panel-tasks');
    perceptionPanel?.classList.toggle('aux-active', this.activeAuxTab === 'perception');
    dashboardPanel?.classList.toggle('aux-active', this.activeAuxTab === 'dashboard');
    tasksPanel?.classList.toggle('aux-active', this.activeAuxTab === 'tasks');
  }
}
