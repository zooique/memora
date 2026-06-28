/**
 * 审计日志面板管理器（M2：审计日志 UI）
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
import { clearElement, formatClock, getOptionalElement } from '../helpers/domHelpers.js';

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

  /** 审计加载条目数上限（与原 ipcListeners 实现一致） */
  private static readonly LOAD_LIMIT = 50;

  /**
   * 初始化审计面板管理器
   *
   * 获取 DOM 元素引用并绑定刷新/清空按钮事件。
   * 在 UIManager 构造时调用。
   */
  init(): void {
    if (this.initialized) return;
    this.initialized = true;

    // 获取 DOM 元素引用（均为可选，缺失时静默降级）
    this.listEl = document.getElementById('audit-list');
    this.countEl = document.getElementById('audit-count');
    this.refreshBtn = getOptionalElement('btn-audit-refresh', 'button');
    this.clearBtn = getOptionalElement('btn-audit-clear', 'button');

    // 绑定刷新按钮事件
    if (this.refreshBtn) {
      this.events.addEventListener(this.refreshBtn, 'click', () => {
        void this.load();
      });
    }

    // 绑定清空按钮事件
    if (this.clearBtn) {
      this.events.addEventListener(this.clearBtn, 'click', async () => {
        try {
          await window.electronAPI.clearAuditLog();
          await this.load();
        } catch (error) {
          reportError('clearAuditLog', error);
          // 清空失败时通过 DOM 显示错误（不依赖 UIManager 引用）
          if (this.listEl) {
            clearElement(this.listEl);
            const errorDiv = document.createElement('div');
            errorDiv.className = 'profile-empty';
            errorDiv.textContent = '清空审计日志失败';
            this.listEl.appendChild(errorDiv);
          }
        }
      });
    }
  }

  /**
   * 加载审计日志数据并渲染
   *
   * 调用 listAuditLog IPC 获取最近的审计条目，
   * 按事件类型渲染为列表项。失败时显示错误提示。
   */
  async load(): Promise<void> {
    if (!this.listEl || !this.countEl) return;

    try {
      const entries = await window.electronAPI.listAuditLog(AuditPanelManager.LOAD_LIMIT);
      this.render(entries);
    } catch (err) {
      reportError('AuditPanel', `加载审计日志失败: ${toError(err).message}`);
      this.renderError(`加载失败: ${toError(err).message}`);
    }
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
      item.className = 'profile-item';

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
      nameEl.className = 'profile-item-name';
      nameEl.textContent = `${typeSymbol} ${entry.type} · ${timeStr}`;

      const contentEl = document.createElement('div');
      contentEl.className = 'profile-item-content';
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
   * @param message 错误消息
   */
  private renderError(message: string): void {
    if (!this.listEl) return;
    clearElement(this.listEl);
    const errorDiv = document.createElement('div');
    errorDiv.className = 'profile-empty';
    errorDiv.textContent = message;
    this.listEl.appendChild(errorDiv);
  }

  /**
   * 将审计事件类型映射为展示符号
   *
   * @param type 事件类型
   * @returns 对应的符号字符
   */
  private getTypeSymbol(type: string): string {
    switch (type) {
      case 'path-allow': return '✓';
      case 'path-deny': return '✗';
      case 'write-confirm': return '⚑';
      case 'write-auto': return '◯';
      case 'write-decline': return '↩';
      default: return '?';
    }
  }

  /** 清理所有事件监听器（UIManager.cleanup 时调用） */
  cleanup(): void {
    this.events.cleanup();
  }
}
