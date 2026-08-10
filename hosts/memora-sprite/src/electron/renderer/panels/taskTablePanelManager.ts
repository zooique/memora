/**
 * 任务表面板管理器（申请暂停模型 Phase 1）
 *
 * 渲染 checkpoint plan（任务表）+ 进度行 + 上一回合记录，
 * 并托管 PendingDraftArea 组件与暂停/取消/继续按钮双态。
 *
 * 职责：
 * - 渲染任务表（plan steps + 当前进度 + 上一回合）
 * - 持有 PendingDraftArea 实例，管理草稿区
 * - 管理暂停/继续按钮双态（suspended→显示「继续」）
 * - 通过 IPC 与内核交互（SESSION_PAUSE / SESSION_RESUME / SESSION_CANCEL_PAUSE）
 *
 * 设计原则：
 * - 与 DashboardPanelManager 同层，UIManager 持有实例并委托
 * - DOM 操作委托给 Component 实例（PendingDraftArea）
 * - 任务表渲染直接操作 DOM（纯展示，无需 Component 抽象）
 * - 按钮态通过 refreshButtonState 增量更新，不重建 DOM
 */

import { clearElement } from '../helpers/domHelpers.js';
import { PendingDraftArea } from '../components/data/pendingDraftArea.js';
import type { DraftItem, DraftActionCallbacks } from '../components/data/pendingDraftArea.js';
import type { ToastType } from '../types.js';

// ─── 常量 ───────────────────────────────────────────────

/** 任务表渲染容器 id */
const TASKS_TABLE_CONTAINER_ID = 'tasks-table-container';
/** 草稿区容器 id */
const TASKS_DRAFT_CONTAINER_ID = 'tasks-draft-container';

// ─── 任务表数据结构 ─────────────────────────────────────

/**
 * 任务步骤数据
 *
 * 对齐内核 PlanStep 接口的子集，渲染层只消费展示所需字段。
 */
export interface TaskStep {
  /** 步骤序号 */
  order: number;
  /** 步骤描述 */
  description: string;
  /** 步骤状态：pending / in_progress / done / blocked */
  status: 'pending' | 'in_progress' | 'done' | 'blocked';
}

/**
 * 工作上下文数据
 *
 * 由 SESSION_GET_WORK_CONTEXT IPC 返回（P1-6 新增），
 * 渲染层用于展示任务表 + 进度 + 草稿。
 */
export interface WorkContext {
  /** 任务步骤列表 */
  plan: TaskStep[];
  /** 当前在执行的步骤序号（-1 表示无活跃步骤） */
  activeStepOrder: number;
  /** 暂停阶段（undefined=未暂停 / suspended=已挂起） */
  pausePhase?: 'suspended';
  /**
   * 暂停申请是否在途（申请已发、loop 尚未挂起）
   *
   * 三态按钮区分依据（用户设计定案 2026-08-10）：
   * - 无暂停态且无在途申请 → 显示「暂停」（发起软暂停）
   * - 无暂停态但在途申请 → 显示「取消暂停」（撤销申请，loop 继续运行）
   * - suspended → 显示「继续」（已暂停，恢复执行；不再显示取消暂停）
   * 「取消暂停」只在申请未触发时有意义——已暂停直接继续即可。
   */
  pausePending?: boolean;
  /** 暂停原因 */
  pauseReason?: string;
  /** P3-2: 暂停来源（仅 suspended 态有效，用于门控"存进度到记忆"按钮显隐） */
  pauseSource?: 'user' | 'agent' | 'system';
}

// ─── 宿主接口 ───────────────────────────────────────────

/** TaskTablePanelManager 需要的宿主能力（由 UIManager 注入） */
export interface TaskTablePanelHost {
  /** 显示 toast 通知 */
  showToast(message: string, type?: ToastType, duration?: number): void;
  /** 获取当前 agent 状态字符串（running / paused / error） */
  getAgentStatus(): string;
  /** P1-6: 获取工作上下文（通过 IPC） */
  getWorkContext(): Promise<WorkContext>;
  /** P1-6: 暂停会话（软暂停：内核在 loop 边界挂起，保留消息可续跑；通过 IPC） */
  pauseSession(): Promise<void>;
  /** 取消暂停（通过 IPC） */
  cancelPause(): Promise<void>;
  /** 恢复会话（通过 IPC） */
  resumeSession(): Promise<void>;
  /** P1-5: 删除指定草稿（委托 UIManager 从 pendingDrafts 中移除） */
  removeDraft(id: string): void;
  /** P3-1: 归档当前会话并包含工作上下文（plan 快照，暂停态下"存进度到记忆"） */
  archiveSessionWithContext(): Promise<{ archivedCount: number }>;
}

// ─── 面板管理器 ─────────────────────────────────────────

/**
 * 任务表面板管理器
 *
 * 由 UIManager 持有实例，在 aux 侧栏切换到 tasks tab 时渲染。
 * 生命周期：init → loadData → cleanup
 */
export class TaskTablePanelManager {
  /** 草稿区组件实例 */
  private draftArea: PendingDraftArea | null = null;
  /** 宿主回调 */
  private host!: TaskTablePanelHost;
  /** 是否已初始化 */
  private initialized = false;

  // ─── 缓存 DOM 元素引用 ──────────────────────────────
  /** 任务表容器 */
  private tableContainerEl: HTMLElement | null = null;
  /** 草稿区容器 */
  private draftContainerEl: HTMLElement | null = null;

  /**
   * 初始化——查询 DOM 引用，创建草稿区组件
   *
   * @param host 宿主回调
   */
  init(host: TaskTablePanelHost): void {
    if (this.initialized) return;
    this.host = host;
    this.tableContainerEl = document.getElementById(TASKS_TABLE_CONTAINER_ID);
    this.draftContainerEl = document.getElementById(TASKS_DRAFT_CONTAINER_ID);

    // 创建草稿区组件（挂载到 draft 容器）
    if (this.draftContainerEl) {
      this.draftArea = new PendingDraftArea();
      this.draftArea.mount(this.draftContainerEl);
    }

    this.initialized = true;
  }

  /**
   * 加载工作上下文数据并渲染
   *
   * 由 UIManager 在 tasks tab 激活时调用。
   * 通过 SESSION_GET_WORK_CONTEXT IPC 获取最新数据。
   */
  async loadData(): Promise<void> {
    try {
      const ctx = await this.host.getWorkContext();
      this.renderTaskTable(ctx);
      this.renderPauseButtons(ctx);
    } catch {
      this.host.showToast('加载任务表失败', 'error');
    }
  }

  /**
   * 渲染任务表
   *
   * 显示 plan 步骤列表 + 当前进度条 + 上一回合摘要。
   * 清空容器后重建，结构：
   * ```html
   * <div class="task-table">
   *   <div class="task-table-progress">进度: 2/5</div>
   *   <div class="task-table-steps">
   *     <div class="task-step [task-step-active]">{order}. {description} [{status}]</div>
   *   </div>
   * </div>
   * ```
   *
   * @param ctx 工作上下文
   */
  private renderTaskTable(ctx: WorkContext): void {
    if (!this.tableContainerEl) return;
    clearElement(this.tableContainerEl);

    if (!ctx.plan || ctx.plan.length === 0) {
      // 空任务表：区分"任务生成中"与"暂无任务"（用户实测纠偏 2026-08-10）：
      // - 会话运行中（running）且 plan 为空 → LLM 正在生成任务表，提示"正在生成"
      // - 会话空闲（idle）/ 其他 → 无任务可展示，提示"暂无任务"
      const isGenerating = this.host.getAgentStatus() === 'running';
      const emptyEl = document.createElement('div');
      emptyEl.className = 'task-table-empty';
      emptyEl.textContent = isGenerating ? '正在生成任务表…' : '暂无任务';
      this.tableContainerEl.appendChild(emptyEl);
      return;
    }

    // 任务表根容器
    const tableEl = document.createElement('div');
    tableEl.className = 'task-table';

    // 进度行
    const doneCount = ctx.plan.filter((s) => s.status === 'done').length;
    const progressEl = document.createElement('div');
    progressEl.className = 'task-table-progress';
    progressEl.textContent = `进度: ${doneCount}/${ctx.plan.length}`;
    tableEl.appendChild(progressEl);

    // 进度条指示器
    const barEl = document.createElement('div');
    barEl.className = 'task-table-bar';
    const fillEl = document.createElement('div');
    fillEl.className = 'task-table-bar-fill';
    fillEl.style.width = `${ctx.plan.length > 0 ? (doneCount / ctx.plan.length) * 100 : 0}%`;
    barEl.appendChild(fillEl);
    tableEl.appendChild(barEl);

    // 步骤列表
    const stepsEl = document.createElement('div');
    stepsEl.className = 'task-table-steps';

    for (const step of ctx.plan) {
      const stepEl = document.createElement('div');
      stepEl.className = `task-step task-step-${step.status}`;
      stepEl.dataset.order = String(step.order);

      // 步骤序号+描述
      const descEl = document.createElement('span');
      descEl.className = 'task-step-desc';
      descEl.textContent = `${step.order + 1}. ${step.description}`;
      stepEl.appendChild(descEl);

      // 状态标签
      const statusEl = document.createElement('span');
      statusEl.className = 'task-step-status';
      statusEl.textContent = this.statusLabel(step.status);
      stepEl.appendChild(statusEl);

      stepsEl.appendChild(stepEl);
    }

    tableEl.appendChild(stepsEl);
    this.tableContainerEl.appendChild(tableEl);
  }

  /**
   * 状态标签文本映射
   */
  private statusLabel(status: TaskStep['status']): string {
    switch (status) {
      case 'pending': return '待办';
      case 'in_progress': return '进行中';
      case 'done': return '已完成';
      case 'blocked': return '阻塞';
      default: return '未知';
    }
  }

  /**
   * 更新草稿区（由 UIManager 在草稿变化时调用）
   *
   * @param drafts 草稿条目列表
   */
  updateDraftArea(drafts: DraftItem[]): void {
    if (!this.draftArea) return;

    // 草稿区操作回调
    const callbacks: DraftActionCallbacks = {
      onDelete: (id: string) => this.handleDraftDelete(id),
      onSubmit: (id: string) => this.handleDraftSubmit(id),
    };

    this.draftArea.update({ drafts, callbacks });
  }

  /**
   * 处理草稿删除
   *
   * 委托 host.removeDraft 从 UIManager.pendingDrafts 中移除，
   * UIManager 会同步更新草稿区 UI。
   */
  private handleDraftDelete(id: string): void {
    this.host.removeDraft(id);
  }

  /**
   * 处理草稿提交
   */
  private async handleDraftSubmit(_id: string): Promise<void> {
    try {
      // 提交草稿：RUNNING 态自动消费 / PAUSED 态合并提交（P1-5 实现后接入）
      // 当前为占位
      this.host.showToast('草稿提交', 'info');
    } catch {
      this.host.showToast('提交草稿失败', 'error');
    }
  }

  /**
   * 渲染暂停/取消暂停/继续三态按钮 + 存进度到记忆
   *
   * - 三态互斥（用户设计定案 2026-08-10）：无申请→「暂停」/ 在途→「取消暂停」/ 已挂起→「继续」
   * - P3-2: pausePhase suspended + pauseSource='user': 显示「存进度到记忆」按钮
   * - 无任何按钮需展示时隐藏按钮区
   *
   * @param ctx 工作上下文
   */
  private renderPauseButtons(ctx: WorkContext): void {
    if (!this.tableContainerEl) return;

    // 移除旧按钮区
    const oldBtns = this.tableContainerEl.querySelector('.task-table-actions');
    oldBtns?.remove();

    const showArchiveBtn = ctx.pausePhase === 'suspended' && ctx.pauseSource === 'user';
    // 按钮区常显：暂停控制组（暂停/取消暂停/继续三态）是会话级操作，与 plan 是否为空
    // 无关（用户设计定案 2026-08-10：暂停/继续/取消暂停统一在任务清单列表，面板即控制家）。
    const actionsEl = document.createElement('div');
    actionsEl.className = 'task-table-actions';

    // ── 暂停控制组（用户设计定案：暂停/继续/取消暂停统一在任务清单列表）──
    // 三态互斥（2026-08-10 实测纠偏）：
    // - 无暂停态且无在途申请：显示「暂停」（发起软暂停）——但会话空闲（idle，无任务）
    //   时暂停无意义，不显示（用户实测纠偏：任务执行完毕重启后不应出现暂停按钮）
    // - 无暂停态但在途申请：显示「取消暂停」（撤销申请 → SESSION_CANCEL_PAUSE）
    //   ——「暂停按钮按下去就直接显示取消暂停」，不等状态机翻转；
    //     已暂停态不再显示取消暂停（取消暂停只在申请未触发时有意义）
    // - suspended（已挂起）：显示「继续」（恢复执行），与取消暂停互斥
    const hasActiveSession = this.host.getAgentStatus() === 'running' || this.host.getAgentStatus() === 'paused';
    if (!ctx.pausePhase && !ctx.pausePending) {
      if (hasActiveSession) {
        const pauseBtn = document.createElement('button');
        pauseBtn.className = 'task-table-btn task-table-btn-pause';
        pauseBtn.textContent = '暂停';
        pauseBtn.addEventListener('click', () => this.handlePause());
        actionsEl.appendChild(pauseBtn);
      }
    } else if (!ctx.pausePhase && ctx.pausePending) {
      // 取消在途的暂停申请：loop 继续运行（SESSION_CANCEL_PAUSE → agent.cancelPauseRequest）
      const cancelPendingBtn = document.createElement('button');
      cancelPendingBtn.className = 'task-table-btn task-table-btn-cancel-pause';
      cancelPendingBtn.textContent = '取消暂停';
      cancelPendingBtn.addEventListener('click', () => this.handleCancelPendingPause());
      actionsEl.appendChild(cancelPendingBtn);
    } else if (ctx.pausePhase === 'suspended') {
      const resumeBtn = document.createElement('button');
      resumeBtn.className = 'task-table-btn task-table-btn-resume';
      resumeBtn.textContent = '继续';
      resumeBtn.addEventListener('click', () => this.handleResume());
      actionsEl.appendChild(resumeBtn);
    }

    // ── P3-2: 暂停来源为 user 时显示「存进度到记忆」按钮 ──
    if (showArchiveBtn) {
      const archiveBtn = document.createElement('button');
      archiveBtn.className = 'task-table-btn task-table-btn-archive';
      archiveBtn.textContent = '存进度到记忆';
      archiveBtn.addEventListener('click', () => this.handleArchiveWithContext());
      actionsEl.appendChild(archiveBtn);
    }

    // 暂停原因
    if (ctx.pauseReason) {
      const reasonEl = document.createElement('div');
      reasonEl.className = 'task-table-pause-reason';
      reasonEl.textContent = `暂停原因: ${ctx.pauseReason}`;
      actionsEl.appendChild(reasonEl);
    }

    this.tableContainerEl.appendChild(actionsEl);
  }

  /**
   * 根据会话状态同步更新暂停按钮（不依赖异步 IPC loadData）
   *
   * 由 onSessionStatusChanged 同步调用，确保按钮状态与会话状态即时同步。
   * 解决"暂停已触发但按钮仍显示取消暂停"的异步竞态问题。
   * 计划详情等异步数据仍由 loadData 刷新。
   *
   * @param status 会话状态：'running' | 'paused' | 'error' | 'idle'
   * @param reason 暂停原因（可选）
   * @param source 暂停来源（可选，仅 paused 态有效）
   */
  updatePauseByStatus(status: string, reason?: string, source?: string): void {
    if (!this.tableContainerEl) return;

    // 移除旧按钮区
    const oldBtns = this.tableContainerEl.querySelector('.task-table-actions');
    oldBtns?.remove();

    const actionsEl = document.createElement('div');
    actionsEl.className = 'task-table-actions';

    if (status === 'paused') {
      // 已暂停：显示"继续"（用户设计定案 2026-08-10：暂停已触发，取消暂停无意义）
      const resumeBtn = document.createElement('button');
      resumeBtn.className = 'task-table-btn task-table-btn-resume';
      resumeBtn.textContent = '继续';
      resumeBtn.addEventListener('click', () => this.handleResume());
      actionsEl.appendChild(resumeBtn);

      // 暂停来源为 user 时显示"存进度到记忆"
      if (source === 'user') {
        const archiveBtn = document.createElement('button');
        archiveBtn.className = 'task-table-btn task-table-btn-archive';
        archiveBtn.textContent = '存进度到记忆';
        archiveBtn.addEventListener('click', () => this.handleArchiveWithContext());
        actionsEl.appendChild(archiveBtn);
      }

      // 暂停原因
      if (reason) {
        const reasonEl = document.createElement('div');
        reasonEl.className = 'task-table-pause-reason';
        reasonEl.textContent = `暂停原因: ${reason}`;
        actionsEl.appendChild(reasonEl);
      }
    }
    // 其他状态（running/error/idle）不在此处理，由 loadData 异步刷新完整 WorkContext 后渲染
    // 注意：running 态需要 pausePending 字段判断显示"暂停"还是"取消暂停"，
    // 无法仅从 status 字符串推导，需等待 IPC 返回的 WorkContext

    this.tableContainerEl.appendChild(actionsEl);
  }

  /**
   * 处理暂停（发起软暂停）
   *
   * 委托 host.pauseSession()（SESSION_PAUSE IPC → agent.requestPause，
   * 内核在 loop 边界挂起，保留消息可续跑）。
   */
  private async handlePause(): Promise<void> {
    try {
      await this.host.pauseSession();
      this.loadData();
    } catch {
      this.host.showToast('暂停失败', 'error');
    }
  }

  /**
   * 处理取消在途的暂停申请（撤销申请，loop 继续运行）
   *
   * 委托 host.cancelPause()（SESSION_CANCEL_PAUSE → agent.cancelPauseRequest）。
   * 与已暂停态的「放弃」（SESSION_ABANDON）区分：本方法只撤销未触发的申请；
   * 已暂停态只有「继续」（resumeSession），不再提供放弃入口。
   */
  private async handleCancelPendingPause(): Promise<void> {
    try {
      await this.host.cancelPause();
      this.loadData();
    } catch {
      this.host.showToast('取消暂停失败', 'error');
    }
  }

  /**
   * 处理继续执行
   *
   * 委托 host.resumeSession()（SESSION_RESUME IPC）。
   */
  private async handleResume(): Promise<void> {
    try {
      await this.host.resumeSession();
      // 刷新面板
      this.loadData();
    } catch {
      this.host.showToast('继续执行失败', 'error');
    }
  }

  /**
   * P3-2: 处理"存进度到记忆"
   *
   * 委托 host.archiveSessionWithContext() 归档当前会话并包含工作上下文，
   * 让记忆包含 plan 快照信息。
   */
  private async handleArchiveWithContext(): Promise<void> {
    try {
      const result = await this.host.archiveSessionWithContext();
      this.host.showToast(`已存档 ${result.archivedCount} 条记忆`, 'success');
    } catch {
      this.host.showToast('存进度到记忆失败', 'error');
    }
  }

  /**
   * 清理——销毁草稿区组件，释放引用
   */
  cleanup(): void {
    if (this.draftArea) {
      this.draftArea.destroy();
      this.draftArea = null;
    }
    this.tableContainerEl = null;
    this.draftContainerEl = null;
    this.initialized = false;
  }
}