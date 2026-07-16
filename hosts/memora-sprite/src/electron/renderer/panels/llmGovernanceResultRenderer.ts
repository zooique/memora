/**
 * LLM 记忆治理结果渲染器 — 健康度面板内"LLM 治理结果"子区域渲染
 *
 * 职责：
 * - 渲染最近一次 LLM 治理报告（L1 语义去重 / L2 时效性评估 / L3 冲突检测）
 * - L1/L2 降级列表：展示降级记忆 ID（截断）+ 单条"恢复"按钮（调用 boostMemory，score +0.05）
 * - L3 冲突对详情：展示两条记忆 name + contentPreview + 冲突描述 + LLM 建议 + 理由（不自动修复）
 * - 结果只保留最近一次，新报告覆盖旧报告（不持久化历史，ADR-017 枝叶层 2 次触发原则）
 *
 * 设计原则（遵循 ADR-SP-015 组合模式）：
 * - 模式 C（自包含 EventTracker）：恢复按钮事件通过 EventTracker 统一管理
 * - 模式 D 衍生：onRestoreMemory() 回调注册接口与外部协作（Controller 调 boostMemory IPC）
 * - 由 MemoryController 持有实例，治理回调内调用 render 方法
 *
 * 语义对齐：
 * - L1/L2 降级 = score 降低（非软删除），因此"恢复"用 boostMemory（score +0.05），不用 restoreMemory
 * - L3 冲突检测 = 仅检测不修复，因此不提供"恢复/修复"按钮，需用户手动消歧
 */

import { EventTracker } from '../helpers/eventTracker.js';
import { createEl } from '../helpers/domHelpers.js';
import type { DedupReport, DedupVerdictSummary, TimelinessReport, ConflictReport } from 'memora';

// ─── 常量 ────────────────────────────────────────────────

/** 结果容器 DOM ID（G3 已在 index.html 预留） */
const RESULT_CONTAINER_ID = 'health-llm-result';

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

// ─── 渲染器 ────────────────────────────────────────────────

/**
 * LLM 记忆治理结果渲染器
 *
 * 负责在健康度面板 #health-llm-result 容器内渲染最近一次治理报告。
 * 由 MemoryController 持有，通过 render 方法注入报告数据。
 */
export class LlmGovernanceResultRenderer {
  /** 事件监听器跟踪器（统一管理恢复按钮事件，避免内存泄漏） */
  private events = new EventTracker();

  /** 恢复记忆回调（用户点击降级列表"恢复"按钮时触发，Controller 调 boostMemory IPC） */
  private restoreCallback: ((memoryId: string) => Promise<void>) | null = null;

  // ─── 回调注册 ──────────────────────────────────────────

  /**
   * 注册恢复记忆回调
   *
   * 用户点击 L1/L2 降级列表中某条记忆的"恢复"按钮时触发。
   * Controller 负责调用 boostMemory IPC（score +0.05），与降级语义对称。
   *
   * @param cb 回调函数，接收记忆 ID，返回 Promise（Controller 处理 toast 反馈）
   */
  onRestoreMemory(cb: (memoryId: string) => Promise<void>): void {
    this.restoreCallback = cb;
  }

  // ─── 资源清理 ──────────────────────────────────────────

  /**
   * 清理事件监听器（页面卸载时调用，避免回调在 DOM 销毁后触发）
   */
  cleanup(): void {
    this.events.cleanup();
    this.restoreCallback = null;
  }

  // ─── 渲染方法 ──────────────────────────────────────────

  /**
   * 渲染 L1 语义去重报告
   *
   * 展示：扫描数 / 降级数 / 降级 ID 列表（每项含"恢复"按钮 + 降级理由 + 合并内容预览）
   * 跳过原因非空时渲染跳过提示，不渲染降级列表。
   * verdicts 携带 LLM 判断理由和合并内容，供用户审计降级是否合理（与 L3 冲突检测展示深度对齐）。
   *
   * @param report L1 去重报告（含 verdicts 审计详情）
   */
  renderDedupReport(report: DedupReport): void {
    if (report.skippedReason) {
      this.renderSkipped('语义去重跳过', report.skippedReason);
      return;
    }
    const summary = `语义去重：扫描 ${report.scannedCount} 条 / ${report.pairCount} 对，降级 ${report.deduplicatedCount} 条`;
    this.renderDemotedList(summary, report.demotedIds, '去重降级', report.verdicts);
  }

  /**
   * 渲染 L2 时效性评估报告
   *
   * 展示：扫描数 / 过时数 / 降级 ID 列表（每项含"恢复"按钮）
   * 跳过原因非空时渲染跳过提示，不渲染降级列表。
   *
   * @param report L2 时效性评估报告
   */
  renderTimelinessReport(report: TimelinessReport): void {
    if (report.skippedReason) {
      this.renderSkipped('时效评估跳过', report.skippedReason);
      return;
    }
    const summary = `时效评估：扫描 ${report.scannedCount} 条，过时 ${report.outdatedCount} 条`;
    this.renderDemotedList(summary, report.demotedIds, '时效降级');
  }

  /**
   * 渲染 L3 冲突检测报告
   *
   * 展示：扫描数 / 冲突数 / 冲突对详情（两条记忆 name + contentPreview + 冲突描述 + LLM 建议 + 理由）
   * 冲突检测仅检测不修复，因此不提供"恢复/修复"按钮，需用户手动消歧。
   * 跳过原因非空时渲染跳过提示，不渲染冲突列表。
   *
   * @param report L3 冲突检测报告
   */
  renderConflictReport(report: ConflictReport): void {
    const container = document.getElementById(RESULT_CONTAINER_ID);
    if (!container) return;

    if (report.skippedReason) {
      this.renderSkipped('冲突检测跳过', report.skippedReason);
      return;
    }

    // 清空旧结果（只保留最近一次）
    this.events.cleanup();
    container.innerHTML = '';

    // 摘要
    const summary = `冲突检测：扫描 ${report.scannedCount} 条 / ${report.pairCount} 对，发现 ${report.conflictCount} 处冲突`;
    container.appendChild(createEl('div', 'llm-result-summary', summary));

    if (report.conflicts.length === 0) {
      container.appendChild(createEl('div', 'llm-result-empty', '未发现语义冲突'));
      return;
    }

    // 冲突对列表
    const listEl = createEl('div', 'llm-result-list');
    for (const verdict of report.conflicts) {
      if (!verdict.hasConflict) continue;
      listEl.appendChild(this.createConflictPairEl(verdict));
    }
    container.appendChild(listEl);
  }

  // ─── 内部渲染方法 ──────────────────────────────────────

  /**
   * 渲染跳过提示（skippedReason 非空时）
   */
  private renderSkipped(title: string, reason: string): void {
    const container = document.getElementById(RESULT_CONTAINER_ID);
    if (!container) return;
    this.events.cleanup();
    container.innerHTML = '';
    container.appendChild(createEl('div', 'llm-result-skipped', `${title}：${reason}`));
  }

  /**
   * 渲染降级列表（L1/L2 共用）
   *
   * @param summary 摘要文本
   * @param demotedIds 降级记忆 ID 列表
   * @param label 降级类型标签（"去重降级" / "时效降级"）
   * @param verdicts 降级审计详情（可选，L1 语义去重携带 reason + mergedContent，L2 时效评估不携带）
   */
  private renderDemotedList(
    summary: string,
    demotedIds: string[],
    label: string,
    verdicts?: DedupVerdictSummary[],
  ): void {
    const container = document.getElementById(RESULT_CONTAINER_ID);
    if (!container) return;

    // 清空旧结果（只保留最近一次）
    this.events.cleanup();
    container.innerHTML = '';

    // 摘要
    container.appendChild(createEl('div', 'llm-result-summary', summary));

    if (demotedIds.length === 0) {
      container.appendChild(createEl('div', 'llm-result-empty', '无需降级'));
      return;
    }

    // 构建 ID → verdict 索引（O(1) 查找，避免遍历）
    const verdictMap = new Map<string, DedupVerdictSummary>();
    if (verdicts) {
      for (const v of verdicts) verdictMap.set(v.demotedId, v);
    }

    // 降级列表
    const listEl = createEl('div', 'llm-result-list');
    for (const id of demotedIds) {
      listEl.appendChild(this.createDemotedItemEl(id, label, verdictMap.get(id)));
    }
    container.appendChild(listEl);
  }

  /**
   * 创建降级列表项元素（含"恢复"按钮 + 可选的降级理由和合并内容预览）
   *
   * @param memoryId 记忆 ID
   * @param label 降级类型标签
   * @param verdict 降级审计详情（可选，L1 携带时展示 reason + mergedContent 预览）
   */
  private createDemotedItemEl(
    memoryId: string,
    label: string,
    verdict?: DedupVerdictSummary,
  ): HTMLElement {
    const itemEl = createEl('div', 'llm-result-item');

    // ID 展示（截断，完整 ID 在 title）
    const displayId = memoryId.length > ID_DISPLAY_LEN
      ? `${memoryId.slice(0, ID_DISPLAY_LEN)}…`
      : memoryId;
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
      const preview = verdict.mergedContent.length > PREVIEW_LEN
        ? `${verdict.mergedContent.slice(0, PREVIEW_LEN)}…`
        : verdict.mergedContent;
      const mergedEl = createEl('div', 'llm-result-item-merged', `合并后：${preview}`);
      mergedEl.title = verdict.mergedContent;
      itemEl.appendChild(mergedEl);
    }

    // 恢复按钮（调用 boostMemory，score +0.05）
    const restoreBtn = createEl('button', 'llm-result-restore-btn', '恢复');
    restoreBtn.title = '提升该记忆 score（+0.05），与降级语义对称';
    this.events.addEventListener(restoreBtn, 'click', async () => {
      restoreBtn.disabled = true;
      restoreBtn.textContent = '恢复中…';
      try {
        await this.restoreCallback?.(memoryId);
        // 恢复成功后移除该项
        itemEl.remove();
      } catch {
        // 恢复失败时恢复按钮状态（Controller 负责 toast 错误反馈）
        restoreBtn.disabled = false;
        restoreBtn.textContent = '恢复';
      }
    });
    itemEl.appendChild(restoreBtn);

    return itemEl;
  }

  /**
   * 创建冲突对详情元素
   *
   * 展示：记忆 A name + contentPreview / 记忆 B name + contentPreview / 冲突描述 / LLM 建议 / 理由
   * 不提供"恢复/修复"按钮（L3 仅检测不修复）。
   *
   * @param verdict 冲突判断结果
   */
  private createConflictPairEl(verdict: {
    memoryA: { name: string; content: string; source: string; score: number };
    memoryB: { name: string; content: string; source: string; score: number };
    conflictDescription?: string;
    recommendation?: string;
    reason: string;
  }): HTMLElement {
    const pairEl = createEl('div', 'llm-result-pair');

    // 记忆 A
    pairEl.appendChild(this.createConflictMemoryEl('A', verdict.memoryA));
    // 记忆 B
    pairEl.appendChild(this.createConflictMemoryEl('B', verdict.memoryB));

    // 冲突描述（可选）
    if (verdict.conflictDescription) {
      pairEl.appendChild(createEl('div', 'llm-result-pair-desc', `冲突点：${verdict.conflictDescription}`));
    }

    // LLM 建议（可选）
    if (verdict.recommendation) {
      const recLabel = RECOMMENDATION_LABEL[verdict.recommendation] ?? verdict.recommendation;
      pairEl.appendChild(createEl('div', 'llm-result-pair-rec', `LLM 建议：${recLabel}`));
    }

    // LLM 理由
    pairEl.appendChild(createEl('div', 'llm-result-pair-reason', `理由：${verdict.reason}`));

    return pairEl;
  }

  /**
   * 创建冲突对中单条记忆的展示元素
   *
   * @param label 标签（"A" / "B"）
   * @param memory 记忆对象（仅需 name/content/source/score 字段）
   */
  private createConflictMemoryEl(
    label: string,
    memory: { name: string; content: string; source: string; score: number },
  ): HTMLElement {
    const memEl = createEl('div', 'llm-result-pair-memory');
    memEl.appendChild(createEl('span', 'llm-result-pair-memory-label', label));

    const nameEl = createEl('span', 'llm-result-pair-memory-name', memory.name);
    nameEl.title = `${memory.source} · score ${memory.score.toFixed(2)}`;
    memEl.appendChild(nameEl);

    // contentPreview 截断
    const preview = memory.content.length > PREVIEW_LEN
      ? `${memory.content.slice(0, PREVIEW_LEN)}…`
      : memory.content;
    const previewEl = createEl('span', 'llm-result-pair-memory-preview', preview);
    previewEl.title = memory.content;
    memEl.appendChild(previewEl);

    return memEl;
  }
}
