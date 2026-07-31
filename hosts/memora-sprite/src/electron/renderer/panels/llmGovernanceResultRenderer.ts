/**
 * LLM 记忆治理结果组件 — 健康度面板内"LLM 治理结果"子区域渲染
 *
 * 职责：
 * - 渲染最近一次 LLM 治理报告（L1 语义去重 / L2 时效性评估 / L3 冲突检测）
 * - L1/L2 降级列表：展示降级记忆 ID（截断）+ 单条"恢复"按钮（调用 boostMemory，score +0.05）
 * - L3 冲突对详情：展示两条记忆 name + contentPreview + 冲突描述 + LLM 建议 + 理由（不自动修复）
 * - 结果只保留最近一次，新报告覆盖旧报告（不持久化历史，ADR-017 枝叶层 2 次触发原则）
 *
 * 组件化改造（HEAL-17 Phase B，对齐 ui-engineering-mindset-rules §四.1 / §四.4）：
 * - 由 LlmGovernanceResultRenderer 升级为 Component 子类，统一生命周期 mount/update/destroy
 * - 采用「采纳静态容器」变体：#health-llm-result 是 index.html 预留的嵌套静态子区
 *   （位于 #memory-health-bar 内，由 HealthDashboardComponent 共享、不移除），mount() 直接采纳为 this.el
 * - 恢复按钮采用**单一事件委托**（委托到容器根，而非逐条 EventTracker 绑定）：
 *   按钮随每次渲染动态重建，委托避免了"每渲染重绑/监听器累积"问题（原 EventTracker.cleanup 的等价目标）
 * - destroy() 先置 this.el = null，使基类 destroy 跳过 el.remove()，不误删共享静态容器
 *
 * 语义对齐：
 * - L1/L2 降级 = score 降低（非软删除），因此"恢复"用 boostMemory（score +0.05），不用 restoreMemory
 * - L3 冲突检测 = 仅检测不修复，因此不提供"恢复/修复"按钮，需用户手动消歧
 */

import { Component } from '../components/Component.js';
import { createEl } from '../helpers/domHelpers.js';
// 截断工具（shared/ 层真理源，ADR-017 枝叶层 2 次提取产物）
import { truncate } from '../../../shared/truncate.js';
import type { DedupReport, DedupVerdictSummary, TimelinessReport, ConflictReport } from 'memora';

// ─── 常量 ────────────────────────────────────────────────

/** 结果容器 DOM 选择器（G3 已在 index.html 预留，且位于 #memory-health-bar 内，共享不移除） */
const RESULT_CONTAINER_SELECTOR = '#health-llm-result';

/** ID 截断长度（降级列表展示用，完整 ID 在 title 属性） */
const ID_DISPLAY_LEN = 12;

/** contentPreview 截断长度（冲突对详情展示用） */
const PREVIEW_LEN = 60;

/** LLM 建议保留的中文标签映射 */
const RECOMMENDATION_LABEL: Record<string, string> = {
  a: '保留 A',
  b: '保留 B',
  both: '都保留',
};

// ─── 选项 ────────────────────────────────────────────────

/** 治理报告判别联合（三种报告类型，对应 L1/L2/L3） */
export type LlmGovernanceReport =
  | { type: 'dedup'; data: DedupReport }
  | { type: 'timeliness'; data: TimelinessReport }
  | { type: 'conflicts'; data: ConflictReport };

/** LlmGovernanceResultComponent 配置（对齐 Component<P> 泛型契约） */
export interface LlmGovernanceOptions {
  /** 最近一次治理报告（由 Controller 治理完成后传入） */
  report?: LlmGovernanceReport;
}

// ─── 组件 ────────────────────────────────────────────────

/**
 * LLM 记忆治理结果组件
 *
 * 负责在健康度面板 #health-llm-result 容器内渲染最近一次治理报告。
 * 由 MemoryOrchestrator 持有（闭包级 const），通过 update({ report }) 注入报告数据。
 */
export class LlmGovernanceResultComponent extends Component<LlmGovernanceOptions> {
  /** 恢复记忆回调（用户点击降级列表"恢复"按钮时触发，Controller 调 boostMemory IPC） */
  private restoreCallback: ((memoryId: string) => Promise<void>) | null = null;

  /** 最近一次治理报告（由 update 写入，_renderReport 读取） */
  private _report: LlmGovernanceReport | null = null;

  // ─── 构造函数（放宽 base 的 protected 构造，允许外部 new，对齐 health/insights 同款） ──

  constructor(options: LlmGovernanceOptions = {}) {
    super(options);
  }

  // ─── 回调注册 ──────────────────────────────────────────

  /**
   * 注册恢复记忆回调
   *
   * 用户点击 L1/L2 降级列表中某条记忆的"恢复"按钮时触发（经容器根事件委托捕获）。
   * Controller 负责调用 boostMemory IPC（score +0.05），与降级语义对称。
   *
   * @param cb 回调函数，接收记忆 ID，返回 Promise（Controller 处理 toast 反馈）
   */
  onRestoreMemory(cb: (memoryId: string) => Promise<void>): void {
    this.restoreCallback = cb;
  }

  // ─── 挂载 ──────────────────────────────────────────────

  /**
   * 挂载到静态容器 #health-llm-result，并绑定唯一的容器根事件委托。
   *
   * 恢复按钮随每次渲染动态重建，故采用委托：在容器根绑定一个 click 委托，
   * 由 _onRestoreClick 根据 [data-action="restore-boost"] 分发，避免逐条绑定与累积。
   *
   * @param container 容器元素或选择器（默认 #health-llm-result）
   * @returns this（链式调用）
   */
  mount(container: HTMLElement | string = RESULT_CONTAINER_SELECTOR): this {
    const target = typeof container === 'string'
      ? document.querySelector<HTMLElement>(container)
      : container;
    if (!target) return this;
    this.el = target;

    // 单一事件委托：恢复按钮动态重建，委托到容器根，避免逐条绑定/监听器累积
    const handler = (e: Event): void => {
      void this._onRestoreClick(e);
    };
    target.addEventListener('click', handler);
    this.trackEvent(() => target.removeEventListener('click', handler));

    return this;
  }

  // ─── 增量更新 ──────────────────────────────────────────

  /**
   * 更新治理报告并渲染。
   *
   * @param newOptions 含最新治理报告（判别联合）
   * @returns this（链式调用）
   */
  update(newOptions: Partial<LlmGovernanceOptions> = {}): this {
    if (newOptions.report) this._report = newOptions.report;
    this._ensureMounted();
    this._renderReport();
    return this;
  }

  /** 懒挂载：首次 update 时若未挂载则采纳静态容器（与 holder 创建时序无关） */
  private _ensureMounted(): void {
    if (!this.el) this.mount(RESULT_CONTAINER_SELECTOR);
  }

  /** 依据当前报告类型分发到对应渲染方法 */
  private _renderReport(): void {
    if (!this.el || !this._report) return;
    switch (this._report.type) {
      case 'dedup':
        this._renderDedupReport(this._report.data);
        break;
      case 'timeliness':
        this._renderTimelinessReport(this._report.data);
        break;
      case 'conflicts':
        this._renderConflictReport(this._report.data);
        break;
    }
  }

  // ─── 渲染方法 ──────────────────────────────────────────

  /** 清空容器（只保留最近一次，新报告覆盖旧报告） */
  private _resetContainer(): void {
    if (this.el) this.el.innerHTML = '';
  }

  /**
   * 渲染 L1 语义去重报告
   */
  private _renderDedupReport(report: DedupReport): void {
    if (report.skippedReason) {
      this._renderSkipped('语义去重跳过', report.skippedReason);
      return;
    }
    const summary = `语义去重：扫描 ${report.scannedCount} 条 / ${report.pairCount} 对，降级 ${report.deduplicatedCount} 条`;
    this._renderDemotedList(summary, report.demotedIds, '去重降级', report.verdicts);
  }

  /**
   * 渲染 L2 时效性评估报告
   */
  private _renderTimelinessReport(report: TimelinessReport): void {
    if (report.skippedReason) {
      this._renderSkipped('时效评估跳过', report.skippedReason);
      return;
    }
    const summary = `时效评估：扫描 ${report.scannedCount} 条，过时 ${report.outdatedCount} 条`;
    this._renderDemotedList(summary, report.demotedIds, '时效降级');
  }

  /**
   * 渲染 L3 冲突检测报告
   */
  private _renderConflictReport(report: ConflictReport): void {
    if (!this.el) return;
    if (report.skippedReason) {
      this._renderSkipped('冲突检测跳过', report.skippedReason);
      return;
    }

    this._resetContainer();
    this.el.appendChild(createEl('div', 'llm-result-summary', `冲突检测：扫描 ${report.scannedCount} 条 / ${report.pairCount} 对，发现 ${report.conflictCount} 处冲突`));

    if (report.conflicts.length === 0) {
      this.el.appendChild(createEl('div', 'llm-result-empty', '未发现语义冲突'));
      return;
    }

    const listEl = createEl('div', 'llm-result-list');
    for (const verdict of report.conflicts) {
      if (!verdict.hasConflict) continue;
      listEl.appendChild(this._createConflictPairEl(verdict));
    }
    this.el.appendChild(listEl);
  }

  // ─── 内部渲染方法 ──────────────────────────────────────

  /**
   * 渲染跳过提示（skippedReason 非空时）
   */
  private _renderSkipped(title: string, reason: string): void {
    if (!this.el) return;
    this._resetContainer();
    this.el.appendChild(createEl('div', 'llm-result-skipped', `${title}：${reason}`));
  }

  /**
   * 渲染降级列表（L1/L2 共用）
   */
  private _renderDemotedList(
    summary: string,
    demotedIds: string[],
    label: string,
    verdicts?: DedupVerdictSummary[],
  ): void {
    if (!this.el) return;
    this._resetContainer();
    this.el.appendChild(createEl('div', 'llm-result-summary', summary));

    if (demotedIds.length === 0) {
      this.el.appendChild(createEl('div', 'llm-result-empty', '无需降级'));
      return;
    }

    // 构建 ID → verdict 索引（O(1) 查找，避免遍历）
    const verdictMap = new Map<string, DedupVerdictSummary>();
    if (verdicts) {
      for (const v of verdicts) verdictMap.set(v.demotedId, v);
    }

    const listEl = createEl('div', 'llm-result-list');
    for (const id of demotedIds) {
      listEl.appendChild(this._createDemotedItemEl(id, label, verdictMap.get(id)));
    }
    this.el.appendChild(listEl);
  }

  /**
   * 创建降级列表项元素（含"恢复"按钮，data-action + data-memory-id 供容器根委托捕获）
   *
   * 注意：恢复按钮不再逐条绑定监听，改由 mount 时绑定的容器根事件委托统一处理。
   *
   * @param memoryId 记忆 ID
   * @param label 降级类型标签
   * @param verdict 降级审计详情（可选，L1 携带时展示 reason + mergedContent 预览）
   */
  private _createDemotedItemEl(
    memoryId: string,
    label: string,
    verdict?: DedupVerdictSummary,
  ): HTMLElement {
    const itemEl = createEl('div', 'llm-result-item');

    // ID 展示（截断，完整 ID 在 title）
    const displayId = truncate(memoryId, ID_DISPLAY_LEN);
    const idEl = createEl('span', 'llm-result-item-id', `${label}：${displayId}`);
    idEl.title = memoryId;
    itemEl.appendChild(idEl);

    // 降级理由（可选，L1 携带时展示，便于用户审计降级是否合理）
    if (verdict?.reason) {
      const reasonEl = createEl('div', 'llm-result-item-reason', `理由：${verdict.reason}`);
      itemEl.appendChild(reasonEl);
    }

    // 合并内容预览（可选，L1 携带 mergedContent 时展示，便于用户验证合并质量）
    if (verdict?.mergedContent) {
      const preview = truncate(verdict.mergedContent, PREVIEW_LEN);
      const mergedEl = createEl('div', 'llm-result-item-merged', `合并后：${preview}`);
      mergedEl.title = verdict.mergedContent;
      itemEl.appendChild(mergedEl);
    }

    // 恢复按钮（收口为通用 .btn-secondary，data-action 作测试钩子，data-memory-id 供委托读取）
    const restoreBtn = createEl('button', 'btn btn-secondary btn-sm flex-shrink-0', '恢复');
    restoreBtn.setAttribute('data-action', 'restore-boost');
    restoreBtn.setAttribute('data-memory-id', memoryId);
    restoreBtn.title = '提升该记忆 score（+0.05），与降级语义对称';
    itemEl.appendChild(restoreBtn);

    return itemEl;
  }

  /**
   * 创建冲突对详情元素
   *
   * 展示：记忆 A name + contentPreview / 记忆 B name + contentPreview / 冲突描述 / LLM 建议 / 理由
   * 不提供"恢复/修复"按钮（L3 仅检测不修复）。
   */
  private _createConflictPairEl(verdict: {
    memoryA: { name: string; content: string; source: string; score: number };
    memoryB: { name: string; content: string; source: string; score: number };
    conflictDescription?: string;
    recommendation?: string;
    reason: string;
  }): HTMLElement {
    const pairEl = createEl('div', 'llm-result-pair');

    pairEl.appendChild(this._createConflictMemoryEl('A', verdict.memoryA));
    pairEl.appendChild(this._createConflictMemoryEl('B', verdict.memoryB));

    if (verdict.conflictDescription) {
      pairEl.appendChild(createEl('div', 'llm-result-pair-desc', `冲突点：${verdict.conflictDescription}`));
    }

    if (verdict.recommendation) {
      const recLabel = RECOMMENDATION_LABEL[verdict.recommendation] ?? verdict.recommendation;
      pairEl.appendChild(createEl('div', 'llm-result-pair-rec', `LLM 建议：${recLabel}`));
    }

    pairEl.appendChild(createEl('div', 'llm-result-pair-reason', `理由：${verdict.reason}`));

    return pairEl;
  }

  /**
   * 创建冲突对中单条记忆的展示元素
   */
  private _createConflictMemoryEl(
    label: string,
    memory: { name: string; content: string; source: string; score: number },
  ): HTMLElement {
    const memEl = createEl('div', 'llm-result-pair-memory');
    memEl.appendChild(createEl('span', 'llm-result-pair-memory-label flex-shrink-0', label));

    const nameEl = createEl('span', 'llm-result-pair-memory-name', memory.name);
    nameEl.title = `${memory.source} · score ${memory.score.toFixed(2)}`;
    memEl.appendChild(nameEl);

    const preview = truncate(memory.content, PREVIEW_LEN);
    const previewEl = createEl('span', 'llm-result-pair-memory-preview', preview);
    previewEl.title = memory.content;
    memEl.appendChild(previewEl);

    return memEl;
  }

  // ─── 事件委托处理 ──────────────────────────────────────

  /**
   * 容器根 click 委托：捕获恢复按钮点击，执行恢复流程。
   *
   * 恢复成功后移除该项；失败则恢复按钮状态（Controller 负责 toast 错误反馈）。
   */
  private async _onRestoreClick(e: Event): Promise<void> {
    const target = e.target as HTMLElement | null;
    const btn = target?.closest('[data-action="restore-boost"]') as HTMLButtonElement | null;
    if (!btn || btn.disabled) return;
    const memoryId = btn.getAttribute('data-memory-id');
    if (!memoryId || !this.restoreCallback) return;

    btn.disabled = true;
    btn.textContent = '恢复中…';
    const itemEl = btn.closest('.llm-result-item');
    try {
      await this.restoreCallback(memoryId);
      itemEl?.remove();
    } catch {
      btn.disabled = false;
      btn.textContent = '恢复';
    }
  }

  // ─── 销毁 ──────────────────────────────────────────────

  /**
   * 销毁组件——先 nullify 恢复回调与共享容器引用，再调用基类清理。
   *
   * 注意：#health-llm-result 是 #memory-health-bar 内的共享静态子区（由 HealthDashboardComponent 共享），
   * 销毁时不可移除它，故先置 this.el = null，使基类 destroy 跳过 el.remove()，仅清理事件委托与引用。
   */
  destroy(): void {
    this.restoreCallback = null;
    this.el = null;
    super.destroy();
  }
}
