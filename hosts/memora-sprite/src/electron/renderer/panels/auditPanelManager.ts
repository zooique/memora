/**
 * 审计日志面板管理器
 *
 * 职责：
 *   - 组合持有 `FlatListPanel<AuditEntry>`（扁平列表工厂，负责加载/计数/空/错/刷新）
 *   - 保留审计特有的"清空 + 二次确认"流程（不可逆操作，Manager 层职责）
 *
 * 设计原则：
 *   - 列表的通用结构（容器采纳、计数、空/错态、刷新绑定、事件清理）下沉到
 *     `FlatListPanel`（§四.2 声明式工厂）；Manager 只做审计专属编排（清空确认）。
 *   - 事件监听器：刷新由工厂经 Component.destroy 统一清理；清空按钮由本 Manager 的
 *     EventTracker 跟踪，cleanup 时统一清理。
 *   - 渲染使用 textContent（防 XSS），不使用 innerHTML（typeSymbol 为静态 SVG 常量）。
 *   - 审计数据来自内核 AuditManager，通过 IPC 获取。
 */
import { EventTracker } from '../helpers/eventTracker.js';
import { reportError, toError } from '../helpers/errorHelpers.js';
import { formatClock, getOptionalElement, setButtonLoadingEl } from '../helpers/domHelpers.js';
// FlatListPanel：扁平列表声明式工厂（§四.2），覆盖 audit/profile/work 三个结构相似面板
import { FlatListPanel } from '../components/base/flatListPanel.js';
import type { ConfirmDialogOptions } from '../types.js';

/**
 * 确认对话框函数类型（由 UIManager 注入，用于清空审计日志前的二次确认）
 */
type ConfirmDialogFn = (options: ConfirmDialogOptions) => Promise<boolean>;

/** 审计条目类型 */
interface AuditEntry {
  type: string;
  path?: string;
  tool?: string;
  reason?: string;
  timestamp: string;
  sessionId: string;
}

/**
 * 审计日志面板管理器
 *
 * 管理"审计"tab 的加载、渲染和清空操作。
 * UIManager 通过组合持有此实例，并在切换到"审计"tab 时调用 load()。
 */
export class AuditPanelManager {
  /** 事件监听器跟踪器（清空按钮绑定，cleanup 时统一清理） */
  private events = new EventTracker();
  /** 扁平列表工厂（负责列表加载/计数/空/错/刷新，持有 Component 实例） */
  private listPanel: FlatListPanel<AuditEntry>;
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

  constructor() {
    this.listPanel = new FlatListPanel<AuditEntry>({
      listContainerId: 'audit-list',
      countElId: 'audit-count',
      refreshBtnId: 'btn-audit-refresh',
      load: () => window.electronAPI.listAuditLog(AuditPanelManager.LOAD_LIMIT),
      renderRow: (entry) => AuditPanelManager.buildRow(entry),
      emptyText: '暂无审计记录',
      errorText: (err) => `加载失败: ${toError(err).message}`,
    });
  }

  /**
   * 初始化审计面板管理器
   *
   * 采纳静态列表容器、绑定清空按钮事件。在 UIManager 构造时调用。
   *
   * @param confirmDialog 确认对话框函数（可选，注入后清空操作前弹二次确认）
   */
  init(confirmDialog?: ConfirmDialogFn): void {
    if (this.initialized) return;
    this.initialized = true;
    this.confirmDialog = confirmDialog ?? null;

    // 采纳静态列表容器 + 绑定刷新（幂等，由 FlatListPanel 内部守卫）
    this.listPanel.mount();

    // 清空按钮：审计特有（不可逆操作，需二次确认），保留在 Manager 层
    this.clearBtn = getOptionalElement('btn-audit-clear', 'button');
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
        setButtonLoadingEl(this.clearBtn!, true, '清空中…');
        try {
          await this.clearAuditLogCallback!();
          await this.load();
        } catch (error) {
          reportError('clearAuditLog', error);
          // 复用工厂错误态（图标 + 文字 + 重试按钮），重试即重新加载列表
          this.listPanel.renderError('清空审计日志失败');
        } finally {
          setButtonLoadingEl(this.clearBtn!, false);
        }
      });
    }
  }

  /**
   * 设置清空审计日志回调（由 settingsController 注入）
   *
   * @param cb 清空回调（async，成功 resolve 后 Manager 自动刷新列表）
   */
  setClearAuditLogCallback(cb: () => Promise<void>): void {
    this.clearAuditLogCallback = cb;
  }

  /**
   * 加载审计日志数据并渲染（委托到 FlatListPanel）
   */
  async load(): Promise<void> {
    return this.listPanel.load();
  }

  /** 清理所有事件监听器（UIManager.cleanup 时调用） */
  cleanup(): void {
    this.events.cleanup();
    this.listPanel.destroy();
  }

  /**
   * 将审计条目渲染为列表项 DOM（审计专属行结构，作为 renderRow 注入工厂）
   */
  private static buildRow(entry: AuditEntry): HTMLElement {
    const item = document.createElement('div');
    item.className = 'audit-item';

    // 事件类型 → 符号映射
    const typeSymbol = AuditPanelManager.getTypeSymbol(entry.type);
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
    return item;
  }

  /**
   * 将审计事件类型映射为展示符号（SVG sprite 引用，跨平台一致）
   */
  private static getTypeSymbol(type: string): string {
    switch (type) {
      case 'path-allow': return '<svg class="icon"><use href="#icon-check"/></svg>';
      case 'path-deny': return '<svg class="icon"><use href="#icon-close"/></svg>';
      case 'write-confirm': return '<svg class="icon"><use href="#icon-flag"/></svg>';
      case 'write-auto': return '<svg class="icon"><use href="#icon-circle"/></svg>';
      case 'write-decline': return '<svg class="icon"><use href="#icon-undo"/></svg>';
      default: return '?';
    }
  }
}
