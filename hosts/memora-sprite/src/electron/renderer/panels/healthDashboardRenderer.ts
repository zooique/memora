/**
 * 健康度仪表盘渲染器 — 仪表盘内"记忆健康度"子区域渲染
 *
 * 职责：
 * - 显示健康度面板加载态（IPC 调用前）
 * - 渲染健康度仪表盘数据（迷你徽章/评分/等级徽章/三维度进度条/详情计数/清理按钮可见性）
 * - 显示加载失败状态（带重试按钮，触发回调重新拉取数据）
 *
 * 设计原则（遵循 ADR-SP-015 组合模式）：
 * - 模式 C（自包含 EventTracker）：重试按钮的事件通过 EventTracker 统一管理
 * - 模式 D 衍生：onReloadHealth() 回调注册接口与外部协作
 * - 由 DashboardPanelManager 持有实例，外观方法委托调用
 */

import { showPanelLoading } from '../helpers/domHelpers.js';
// renderErrorState 统一面板错误态渲染（图标 + 文字 + 重试按钮），4 处面板共用
import { renderErrorState } from '../helpers/errorState.js';
import { EventTracker } from '../helpers/eventTracker.js';
import type { HealthDashboardPayload } from '../../preload.js';

// ─── 常量 ────────────────────────────────────────────────

/** 健康等级中文标签映射表（本渲染器的唯一真理源，已从 dashboardPanelManager 迁入） */
const HEALTH_LABEL_MAP: Record<string, string> = {
  excellent: '优秀',
  good: '良好',
  fair: '一般',
  poor: '较差',
};

/** 三维度配置：id（DOM 前缀）/ value（数值）/ cssClass（进度条样式类） */
interface DimensionConfig {
  /** DOM 元素 ID 前缀（如 'uniqueness' 对应 #health-uniqueness 和 #health-uniqueness-val） */
  id: string;
  /** 数值（0-100） */
  value: number;
  /** 进度条样式类（与维度同名，用于不同颜色的进度条） */
  cssClass: string;
}

// ─── 健康度仪表盘渲染器 ────────────────────────────────────

/**
 * 健康度仪表盘渲染器
 *
 * 负责仪表盘内"记忆健康度"子区域的全部渲染逻辑。
 * 由 DashboardPanelManager 持有，通过外观方法委托调用。
 */
export class HealthDashboardRenderer {
  /** 事件监听器跟踪器（统一管理重试按钮事件，避免内存泄漏） */
  private events = new EventTracker();

  /** 重试加载健康度数据回调（用户点击重试按钮时触发） */
  private reloadCallback: (() => void) | null = null;

  // ─── 回调注册 ──────────────────────────────────────────

  /**
   * 注册重试加载健康度数据回调
   *
   * 用户点击重试按钮时触发，由 Controller 重新拉取数据。
   */
  onReloadHealth(cb: () => void): void {
    this.reloadCallback = cb;
  }

  // ─── 资源清理 ──────────────────────────────────────────

  /**
   * 清理事件监听器（页面卸载时调用，避免回调在 DOM 销毁后触发）
   */
  cleanup(): void {
    this.events.cleanup();
    this.reloadCallback = null;
  }

  // ─── 渲染方法 ──────────────────────────────────────────

  /**
   * 显示健康度面板加载态（IPC 调用前调用）
   *
   * 在 health-metrics 区域插入加载态占位，不影响 header 区域。
   */
  showLoading(): void {
    const healthBar = document.getElementById('memory-health-bar');
    // 在 health-metrics 区域插入加载态（不影响 header 区域）
    const metricsEl = healthBar?.querySelector('.health-metrics');
    if (metricsEl) showPanelLoading(metricsEl, '加载健康度数据...');
  }

  /**
   * 渲染记忆健康度仪表盘数据（Phase 1：健康度诊断）
   *
   * 接收 Controller 拉取的健康度数据，渲染：
   * - 健康度评分（总分）+ 健康等级徽章
   * - 三维度进度条（uniqueness/freshness/completeness）
   * - 详情计数（重复/过期/低质量）
   * - 健康描述文字
   * - 清理按钮可见性（仅在有可清理项时显示）
   *
   * @param data 健康度数据
   */
  render(data: HealthDashboardPayload): void {
    // ─── 健康度评分（记忆面板 health-bar） ──────────────
    const scoreEl = document.getElementById('health-score');
    if (scoreEl) scoreEl.textContent = String(data.scores.overall);

    // ─── 健康等级徽章 ──────────────────────────────────
    const badgeEl = document.getElementById('health-badge');
    if (badgeEl) {
      // 清除旧等级类名
      badgeEl.className = 'health-badge';
      badgeEl.classList.add(data.healthLabel);
      badgeEl.textContent = HEALTH_LABEL_MAP[data.healthLabel] || data.healthLabel;
    }

    // ─── 三维度进度条 ──────────────────────────────────
    const dimensions: DimensionConfig[] = [
      { id: 'uniqueness', value: data.scores.uniqueness, cssClass: 'uniqueness' },
      { id: 'freshness', value: data.scores.freshness, cssClass: 'freshness' },
      { id: 'completeness', value: data.scores.completeness, cssClass: 'completeness' },
    ];
    for (const dim of dimensions) {
      const fillEl = document.getElementById(`health-${dim.id}`);
      const valEl = document.getElementById(`health-${dim.id}-val`);
      if (fillEl) {
        fillEl.style.width = `${dim.value}%`;
        fillEl.className = `health-metric-fill ${dim.cssClass}`;
      }
      if (valEl) valEl.textContent = String(dim.value);
    }

    // ─── 详情计数（重复/过期/低质量） ──────────────────
    const duplicateCount = data.duplicates.reduce((sum, g) => sum + g.memories.length, 0);
    const dupEl = document.getElementById('health-duplicates');
    if (dupEl) {
      dupEl.textContent = `重复: ${duplicateCount}`;
      dupEl.className = 'health-detail-item';
      if (duplicateCount > 0) dupEl.classList.add('warning');
    }

    const staleEl = document.getElementById('health-stale');
    if (staleEl) {
      staleEl.textContent = `过期: ${data.staleMemories.length}`;
      staleEl.className = 'health-detail-item';
      if (data.staleMemories.length > 0) staleEl.classList.add('warning');
    }

    const lowEl = document.getElementById('health-low-quality');
    if (lowEl) {
      lowEl.textContent = `低质量: ${data.lowQualityCount}`;
      lowEl.className = 'health-detail-item';
      if (data.lowQualityCount > 0) lowEl.classList.add('warning');
    }

    // ─── 健康描述 ──────────────────────────────────────
    const descEl = document.getElementById('health-description');
    if (descEl) descEl.textContent = data.healthDescription;

    // ─── 清理按钮：仅在有可清理项时显示 ──────────────
    const staleCount = data.staleMemories.length;
    const hasCleanupTarget = duplicateCount > 0 || staleCount > 0;
    const dupBtn = document.getElementById('health-cleanup-duplicates');
    const staleBtn = document.getElementById('health-cleanup-stale');
    const allBtn = document.getElementById('health-cleanup-all');
    const actionsEl = document.getElementById('health-actions');

    if (dupBtn) dupBtn.style.display = duplicateCount > 0 ? '' : 'none';
    if (staleBtn) staleBtn.style.display = staleCount > 0 ? '' : 'none';
    if (allBtn) allBtn.style.display = hasCleanupTarget ? '' : 'none';
    if (actionsEl) actionsEl.style.display = hasCleanupTarget ? '' : 'none';
  }

  /**
   * 显示健康度面板加载失败状态（带重试按钮）
   *
   * 复用 renderErrorState 统一错误态结构（图标 + 文字 + 重试按钮），
   * 与 profilePanel/auditPanel/workProjectionPanel 对齐。
   * 用户点击重试按钮时触发 onReloadHealth 回调，由 Controller 重新拉取数据。
   */
  showError(): void {
    const healthBar = document.getElementById('memory-health-bar');
    const metricsEl = healthBar?.querySelector('.health-metrics');
    if (metricsEl instanceof HTMLElement) {
      renderErrorState(
        metricsEl,
        '加载失败',
        () => this.reloadCallback?.(),
        this.events,
      );
    }
  }
}
