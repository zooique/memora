/**
 * 审计日志面板管理器
 *
 * 职责：
 *   - 加载审计日志列表并渲染到设置面板的"审计"tab
 *   - 按事件类型显示不同符号（✓ 允许 / ✗ 拒绝 / ⚑ 确认写入等）
 *   - 刷新按钮：重新拉取最新审计数据
 *   - 清空按钮：清空全部审计记录后刷新
 *
 * 设计原则：
 *   - 独立子模块，UIManager 通过组合持有（与 ProfilePanelManager / WorkProjectionPanelManager 同模式）
 *   - 事件监听器纳入 EventTracker 跟踪集合，cleanup 时统一清理
 *   - 渲染使用 textContent（防 XSS），不使用 innerHTML
 *   - 审计数据来自内核 AuditManager，通过 IPC 获取
 *
 * 迁移自 ipcListeners.ts 的 loadAndRenderAuditLog 函数，
 * 消除架构不对称（profile/work 有独立 PanelManager，audit 却散落在 ipcListeners 中）。
 */

import { EventTracker } from '../helpers/eventTracker.js';
import { reportError, toError } from '../helpers/errorHelpers.js';
import { clearElement, formatClock, getOptionalElement, setButtonLoadingEl } from '../helpers/domHelpers.js';
// bindRefreshButton 统一"刷新按钮 → loading → 异步操作"绑定模式
import { bindRefreshButton } from '../helpers/buttonHelpers.js';
// renderErrorState 统一面板错误态渲染（图标 + 文字 + 重试按钮），3 处面板共用
import { renderErrorState } from '../helpers/errorState.js';
import type { ConfirmDialogOptions } from '../types.js';

/**
 * 确认对话框函数类型（由 UIManager 注入，用于清空审计日志前的二次确认）
 */
type ConfirmDialogFn = (options: ConfirmDialogOptions) => Promise<boolean>;

/**
 * 审计日志面板管理器
 *
 * 管理"审计"tab 的加载、渲染和清空操作。
 * UIManager 通过组合持有此实例，并在切换到"审计"tab 时调用 load()。
 */
export class AuditPanelManager {
  /** 事件监听器跟踪器（统一管理事件监听器的注册与清理，避免内存泄漏） */
  private events = new EventTracker();
  /** 审计列表容器 */
  private listEl: HTMLElement | null = null;
  /** 审计计数元素 */
  private countEl: HTMLElement | null = null;
  /** 刷新按钮 */
  private refreshBtn: HTMLButtonElement | null = null;
  /** 清空按钮 */
  private clearBtn: HTMLButtonElement | null = null;
  /** 是否已初始化（避免重复绑定事件） */
  private initialized = false;
  /** 确认对话框函数（由 UIManager 注入，用于清空操作的二次确认） */
  private confirmDialog: ConfirmDialogFn | null = null;
  /** 清空审计日志回调（由 settingsController 注入） */
  private clearAuditLogCallback: (() => Promise<void>) | null = null;

  /** 审计加载条目数上限 */
  private static readonly LOAD_LIMIT = 50;

  /**
   * 初始化审计面板管理器
   *
   * 获取 DOM 元素引用并绑定刷新/清空按钮事件。
   * 在 UIManager 构造时调用。
   *
   * @param confirmDialog 确认对话框函数（可选，注入后清空操作前弹二次确认）
   */
  init(confirmDialog?: ConfirmDialogFn): void {
    if (this.initialized) return;
    this.initialized = true;
    this.confirmDialog = confirmDialog ?? null;

    // 获取 DOM 元素引用（均为可选，缺失时静默降级）
    this.listEl = document.getElementById('audit-list');
    this.countEl = document.getElementById('audit-count');
    this.refreshBtn = getOptionalElement('btn-audit-refresh', 'button');
    this.clearBtn = getOptionalElement('btn-audit-clear', 'button');

    // 绑定刷新按钮事件（带 loading 反馈，避免 IPC 调用期间用户重复点击）
    bindRefreshButton(this.refreshBtn, this.events, () => this.load());

    // 绑定清空按钮事件（带 loading 反馈 + 二次确认，避免误触批量清空审计记录）
    if (this.clearBtn) {
      this.events.addEventListener(this.clearBtn, 'click', async () => {
        // 二次确认：清空审计日志属不可逆操作，需用户明确确认
        if (this.confirmDialog) {
          const confirmed = await this.confirmDialog({
            title: '清空审计日志',
            message: '将清空全部审计记录，此操作不可撤销。确认清空？',
            confirmText: '清空',
            cancelText: '取消',
            danger: true,
          });
          if (!confirmed) return;
        }
        setButtonLoadingEl(this.clearBtn!, true, '清空中...');
        try {
          await this.clearAuditLogCallback!();
          await this.load();
        } catch (error) {
          reportError('clearAuditLog', error);
          // 复用 renderError 统一错误态结构（图标 + 文字 + 重试按钮）
          this.renderError('清空审计日志失败');
        } finally {
          setButtonLoadingEl(this.clearBtn!, false);
        }
      });
    }
  }

  /**
   * 设置清空审计日志回调（由 settingsController 注入）
   *
   * @param cb 清空回调（async，成功 resolve 后 PanelManager 自动刷新列表）
   */
  setClearAuditLogCallback(cb: () => Promise<void>): void {
    this.clearAuditLogCallback = cb;
  }

  /**
   * 加载审计日志数据并渲染
   *
   * 调用 listAuditLog IPC 获取最近的审计条目，
   * 按事件类型渲染为列表项。失败时显示错误提示。
   */
  async load(): Promise<void> {
    if (!this.listEl || !this.countEl) return;

    // try 仅包裹 IPC 调用（IO），render（DOM 渲染）移出 try，
    // 避免 render 抛出的 DOM 错误被误当成 IO 错误处理
    let entries: Awaited<ReturnType<typeof window.electronAPI.listAuditLog>>;
    try {
      entries = await window.electronAPI.listAuditLog(AuditPanelManager.LOAD_LIMIT);
    } catch (err) {
      reportError('AuditPanel', `加载审计日志失败: ${toError(err).message}`);
      this.renderError(`加载失败: ${toError(err).message}`);
      return; // IO 失败后不执行 render
    }
    this.render(entries);
  }

  /**
   * 渲染审计日志列表
   *
   * @param entries 审计条目数组
   */
  private render(entries: Array<{
    type: string;
    path?: string;
    tool?: string;
    reason?: string;
    timestamp: string;
    sessionId: string;
  }>): void {
    if (!this.listEl || !this.countEl) return;

    this.countEl.textContent = String(entries.length);

    if (entries.length === 0) {
      clearElement(this.listEl);
      const emptyDiv = document.createElement('div');
      emptyDiv.className = 'profile-empty';
      emptyDiv.textContent = '暂无审计记录';
      this.listEl.appendChild(emptyDiv);
      return;
    }

    // 使用 DocumentFragment 批量插入，避免循环中逐个 appendChild 触发重排
    const frag = document.createDocumentFragment();
    for (const entry of entries) {
      const item = document.createElement('div');
      item.className = 'audit-item';

      // 事件类型 → 符号映射
      const typeSymbol = this.getTypeSymbol(entry.type);
      const timeStr = formatClock(entry.timestamp);

      // 元信息行：路径 / 工具 / 原因
      const meta = [
        entry.path ? `路径: ${entry.path}` : '',
        entry.tool ? `工具: ${entry.tool}` : '',
        entry.reason ? `原因: ${entry.reason}` : '',
      ].filter(Boolean).join(' · ');

      const nameEl = document.createElement('div');
      nameEl.className = 'audit-item-name';
      // SVG 图标（静态常量，无 XSS 风险）+ 动态文本（通过 createTextNode 转义，防止 entry.type/timeStr 注入）
      nameEl.innerHTML = typeSymbol;
      nameEl.appendChild(document.createTextNode(` ${entry.type} · ${timeStr}`));

      const contentEl = document.createElement('div');
      contentEl.className = 'audit-item-content';
      contentEl.textContent = meta || '—';

      item.appendChild(nameEl);
      item.appendChild(contentEl);
      frag.appendChild(item);
    }

    clearElement(this.listEl);
    this.listEl.appendChild(frag);
  }

  /**
   * 渲染错误状态
   *
   * 统一用 .error-state 结构（图标 + 文字 + 重试按钮），renderErrorState 公共函数。
   * 重试按钮触发重新加载（load 失败和 clearAuditLog 失败后的恢复操作均为重新加载列表）。
   *
   * @param message 错误消息
   */
  private renderError(message: string): void {
    if (!this.listEl) return;
    renderErrorState(this.listEl, message, () => this.load(), this.events);
  }

  /**
   * 将审计事件类型映射为展示符号（SVG sprite 引用，跨平台一致）
   *
   * @param type 事件类型
   * @returns 对应的 SVG 图标字符串（含 <svg><use> 结构）
   */
  private getTypeSymbol(type: string): string {
    switch (type) {
      case 'path-allow': return '<svg class="icon"><use href="#icon-check"/></svg>';
      case 'path-deny': return '<svg class="icon"><use href="#icon-close"/></svg>';
      case 'write-confirm': return '<svg class="icon"><use href="#icon-flag"/></svg>';
      case 'write-auto': return '<svg class="icon"><use href="#icon-circle"/></svg>';
      case 'write-decline': return '<svg class="icon"><use href="#icon-undo"/></svg>';
      default: return '?';
    }
  }

  /** 清理所有事件监听器（UIManager.cleanup 时调用） */
  cleanup(): void {
    this.events.cleanup();
  }
}
