/**
 * 剪贴板面板管理器 — UI 渲染层
 *
 * 职责：
 * - 渲染待处理条目列表（预览 + 长度 + 时间 + 较旧标签 + 操作按钮）
 * - 角标更新（数量 0 隐藏 / 1-99 数字 / >99 显示 99+ / 较旧变警告色）
 * - 空状态切换（列表为空时显示引导，有内容时隐藏）
 * - 批量操作按钮显隐（列表为空时隐藏）
 * - 首次引导气泡（一次性，点击关闭后 localStorage 记录不再出现）
 * - 单条归档（乐观移除 + 触发 clipboardAnalyze）
 * - 批量归档（二次确认 + 清空列表 + 触发 clipboardAnalyze）
 * - 单条忽略（removePendingItem）
 * - 批量忽略（二次确认 + clearPendingItems）
 *
 * 设计原则：
 * - 单向依赖：clipboardPanelManager 依赖 ClipboardManager（数据层），反向不可见
 * - onChange 回调：通过 ClipboardManager.setOnChange 注入 refresh，数据变更自动刷新
 * - Manager 编排 + Component 封装：面板 DOM 操作委托 ClipboardListComponent，Manager 负责编排与业务逻辑
 * - 事件统一管理：通过 EventTracker 跟踪所有事件监听器，cleanup 时统一清理
 */

import { getOptionalElement } from '../helpers/domHelpers.js';
// 渲染进程统一日志入口（替代散落的 console.error/warn）
import { reportError } from '../helpers/errorHelpers.js';
import type { EventTracker } from '../helpers/eventTracker.js';
import type { ConfirmDialogOptions, ToastType } from '../types.js';
// 剪贴板数据/状态层（ClipboardPanelManager 依赖其 API，单向依赖）
import type { ClipboardManager } from './clipboardManager.js';
// 列表渲染组件（ARCH-COMP-1 阶段 4：封装面板 DOM 操作，Manager 编排 + Component 封装）
import { ClipboardListComponent, ONBOARDING_DISMISSED_KEY } from '../components/data/clipboardListComponent.js';

// ─── Host 接口（跨模块关注点注入） ────────────────────────

/** 剪贴板面板管理器需要的宿主能力（由 UIManager 注入） */
export interface ClipboardPanelHost {
  /** 显示确认对话框（批量归档/忽略前的二次确认） */
  showConfirmDialog(options: ConfirmDialogOptions): Promise<boolean>;
  /** 显示 toast 通知（操作反馈） */
  showToast(message: string, type?: ToastType, duration?: number): void;
}

// ─── ClipboardPanelManager 类 ─────────────────────────

/**
 * 剪贴板面板管理器类（UI 渲染层）
 *
 * 生命周期：
 * - 构造函数：注入 ClipboardManager + Host + EventTracker
 * - init()：创建 ClipboardListComponent + 绑定批量操作/引导关闭 + 注入 onChange 回调
 * - refresh()：由 ClipboardManager.onChange 触发，委托 Component 重新渲染列表 + 角标
 * - cleanup()：销毁 Component + 清理事件监听器
 */
export class ClipboardPanelManager {
  // ─── Component 实例（ARCH-COMP-1 阶段 4：封装面板 DOM 操作，替代直接查询） ─
  /** 列表渲染组件（列表/空状态/角标/批量操作/引导气泡 DOM 操作） */
  private clipboardComponent!: ClipboardListComponent;

  // ─── 依赖注入 ────────────────────────────────────────
  /**
   * 构造函数注入 ClipboardManager（数据层）
   *
   * 设计理由：ClipboardPanelManager 依赖 ClipboardManager 的 API（getPendingItems 等），
   * 但 ClipboardManager 不依赖 ClipboardPanelManager（通过 onChange 回调解耦）。
   */
  constructor(
    private clipboardManager: ClipboardManager,
    private host: ClipboardPanelHost,
    private events: EventTracker,
  ) {}

  // ─── 初始化 ────────────────────────────────────────

  /**
   * 初始化剪贴板面板管理器
   *
   * 步骤：
   * 1. 创建 ClipboardListComponent 并挂载（封装 DOM 查询，缺失时降级）
   * 2. 绑定引导关闭按钮（委托 Component）+ 批量操作按钮（保留在 Manager）
   * 3. 注入 onChange 回调到 ClipboardManager（数据变更自动刷新）
   * 4. 首次渲染（同步当前状态）
   * 5. 显示首次引导气泡（如果未关闭过且有待处理内容）
   */
  init(): void {
    // 创建 Component 实例并挂载到现有 HTML 模板元素（封装 5 处 DOM 查询 + 兜底逻辑）
    this.clipboardComponent = new ClipboardListComponent().mount('');
    // 绑定首次引导关闭按钮（委托 Component 查询元素 + 注册事件，回调 Manager.dismissOnboarding）
    this.clipboardComponent.bindOnboardingClose(() => this.dismissOnboarding());

    // 绑定批量操作按钮（可选，缺失时降级）—— 保留在 Manager（业务逻辑，非面板渲染）
    this.bindBatchActions();

    // 注入 onChange 回调：ClipboardManager 状态变更时自动触发 refresh
    this.clipboardManager.setOnChange(() => this.refresh());

    // 首次渲染（同步当前状态，可能为空列表）
    this.refresh();
  }

  // ─── 资源清理 ──────────────────────────────────────────

  /**
   * 清理资源
   *
   * - 销毁 ClipboardListComponent（nullify 引用 + 解绑列表项/引导关闭事件）
   * - 清理批量操作按钮事件监听器（通过 EventTracker 统一管理）
   * - 不清理 ClipboardManager 的 onChange（由 ClipboardManager.cleanup 自行处理）
   */
  cleanup(): void {
    this.clipboardComponent.destroy();
    this.events.cleanup();
  }

  // ─── 渲染 ────────────────────────────────────────────

  /**
   * 刷新面板（由 ClipboardManager.onChange 触发，或外部主动调用）
   *
   * 步骤：
   * 1. 读取最新待处理列表
   * 2. 渲染列表条目（或清空）
   * 3. 切换空状态显隐
   * 4. 切换批量操作按钮显隐
   * 5. 更新导航角标（数量 + 较旧态）
   * 6. 刷新较旧标记（将 >24h 的条目标记为 isStale）
   * 7. 首次引导气泡显隐（有待处理内容且未关闭过时显示）
   */
  refresh(): void {
    // 刷新较旧标记（检测 >24h 的条目）
    this.clipboardManager.refreshStaleFlags();

    const items = this.clipboardManager.getPendingItems();
    const count = items.length;

    // 渲染列表 + 注入单条操作回调（Component 不直接调用 Manager，通过回调解耦）
    this.clipboardComponent.renderList(items, {
      onCopy: (content) => this.handleCopyItem(content),
      onArchive: (id) => this.handleArchiveItem(id),
      onIgnore: (id) => this.handleIgnoreItem(id),
    });

    // 切换空状态显隐
    this.clipboardComponent.toggleEmptyState(count === 0);

    // 切换批量操作按钮显隐
    this.clipboardComponent.toggleActionsVisibility(count === 0);

    // 更新导航角标（未查看计数，非总条目数）
    this.clipboardComponent.updateBadge(this.clipboardManager.getUnviewedCount(), this.clipboardManager.hasStaleItem());

    // 首次引导气泡显隐
    this.clipboardComponent.toggleOnboardingTip(count > 0);
  }

  // ─── 单条操作 ────────────────────────────────────────

  /**
   * 处理单条归档按钮点击
   *
   * 策略：乐观移除 + 触发 clipboardAnalyze
   * - 立即从列表移除条目（视觉反馈即时）
   * - 调用 clipboardAnalyze 触发主进程读取剪贴板 + 敏感检测 + 护栏检查
   * - 主进程通过 emit('analysis-ready') 反馈，由 ipcListeners 调用 showClipboardConfirmDialog
   * - 如果用户在对话框取消，条目已移除（用户可重新复制触发）
   * - 如果分析失败（敏感/护栏），toast 会提示用户
   *
   * 设计理由：剪贴板只存储最新内容，归档"某条历史条目"的语义实际上等于"归档当前剪贴板内容"。
   *           乐观移除让用户感知"点击归档后条目消失"，符合直觉。
   *
   * @param id 待归档条目 ID
   */
  private async handleArchiveItem(id: string): Promise<void> {
    // 乐观移除条目（视觉反馈即时）
    this.clipboardManager.removePendingItem(id);
    await this.triggerArchiveAnalyze();
  }

  /**
   * 触发主进程剪贴板分析（读取 + 敏感检测 + 护栏检查），统一处理失败反馈
   *
   * 提取自 handleArchiveItem / handleArchiveAll 的重复 try/catch + reportError + showToast 模式
   * （ADR-017 枝叶层 2 次提取原则）。
   *
   * 通过后由 ipcListeners 调用 showClipboardConfirmDialog 显示确认对话框。
   */
  private async triggerArchiveAnalyze(): Promise<void> {
    try {
      await window.electronAPI.clipboardAnalyze();
    } catch (error) {
      reportError('ClipboardPanelManager.triggerArchiveAnalyze', error);
      this.host.showToast('归档失败，请稍后重试', 'error');
    }
  }

  /**
   * 处理单条忽略按钮点击
   *
   * 从列表移除条目，不触发归档流程。
   *
   * @param id 待忽略条目 ID
   */
  /**
   * 处理复制按钮点击——将条目内容写回 OS 剪贴板
   *
   * 使用 navigator.clipboard.writeText() 写入完整内容（非 preview 截断）。
   * ClipboardHandler 检测到变化后通过 CLIPBOARD_CHANGED IPC 通知渲染层，
   * addPendingItem 的去重逻辑会将同名条目移到列表顶部，不创建重复，不增加未查看计数。
   */
  private async handleCopyItem(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 剪贴板写入失败（如权限被拒绝），静默降级不弹 toast
    }
  }

  private handleIgnoreItem(id: string): void {
    this.clipboardManager.removePendingItem(id);
  }

  // ─── 批量操作 ────────────────────────────────────────

  /**
   * 绑定批量操作按钮事件
   *
   * - 全部归档按钮：弹出二次确认 → 清空列表 + 触发 clipboardAnalyze
   * - 全部忽略按钮：弹出二次确认 → 清空列表
   */
  private bindBatchActions(): void {
    const archiveAllBtn = getOptionalElement('btn-clipboard-archive-all', 'button');
    if (archiveAllBtn) {
      this.events.addEventListener(archiveAllBtn, 'click', () => this.handleArchiveAll());
    }

    const ignoreAllBtn = getOptionalElement('btn-clipboard-ignore-all', 'button');
    if (ignoreAllBtn) {
      this.events.addEventListener(ignoreAllBtn, 'click', () => this.handleIgnoreAll());
    }
  }

  /**
   * 处理"全部归档"按钮点击
   *
   * 策略：二次确认 → 清空列表 + 触发 clipboardAnalyze
   *
   * 对话框文案明确告知用户"仅当前剪贴板内容会被归档为记忆，历史条目将被清空"，
   * 避免用户误解为"列表中所有条目都会被写入记忆"。
   */
  private async handleArchiveAll(): Promise<void> {
    const confirmed = await this.host.showConfirmDialog({
      title: '全部归档',
      message: '将归档当前剪贴板内容为记忆，并清空待处理列表。注意：仅当前剪贴板内容会被归档，历史条目将被清空。',
      confirmText: '归档并清空',
      cancelText: '取消',
    });
    if (!confirmed) return;

    // 清空待处理列表（视觉反馈即时）
    this.clipboardManager.clearPendingItems();
    await this.triggerArchiveAnalyze();
  }

  /**
   * 处理"全部忽略"按钮点击
   *
   * 策略：二次确认 → 清空列表
   */
  private async handleIgnoreAll(): Promise<void> {
    const confirmed = await this.host.showConfirmDialog({
      title: '全部忽略',
      message: '确定要忽略所有待处理内容吗？此操作不可撤销。',
      confirmText: '全部忽略',
      cancelText: '取消',
      danger: true,
    });
    if (!confirmed) return;

    this.clipboardManager.clearPendingItems();
    this.host.showToast('已清空待处理列表', 'success');
  }

  // ─── 首次引导气泡 ────────────────────────────────────

  /**
   * 关闭首次引导气泡（记录到 localStorage）
   *
   * 由 ClipboardListComponent.bindOnboardingClose 注入为回调，点击关闭按钮时触发。
   * localStorage 写入保留在 Manager，与 Component 的读取共享 ONBOARDING_DISMISSED_KEY。
   */
  private dismissOnboarding(): void {
    try {
      localStorage.setItem(ONBOARDING_DISMISSED_KEY, '1');
    } catch {
      // localStorage 不可用时降级：仅隐藏当前会话的气泡
    }
    this.clipboardComponent.toggleOnboardingTip(false);
  }
}
