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

import { showPanelLoading, hidePanelLoading } from '../helpers/domHelpers.js';
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
    if (metricsEl) showPanelLoading(metricsEl, '加载健康度数据…');
  }

  /**
   * 渲染记忆健康度仪表盘数据
   *
   * 接收 Controller 拉取的健康度数据，渲染：
   * - 健康度评分（总分）+ 评分基数（N 条记忆）+ 健康等级徽章
   * - 三维度进度条（uniqueness/freshness/completeness）
   * - 详情计数（重复 + 平均相似度 / 过期 + 原因分类 + 最长闲置天数 / 低质量）
   * - 健康描述文字
   * - 清理按钮可见性（仅在有可清理项时显示）
   *
   * @param data 健康度数据
   */
  render(data: HealthDashboardPayload): void {
    // 清除 showLoading() 添加的 .panel-loading 覆盖层（修复 loading 永驻 bug）
    // 必须在 setTextContent 前执行，否则覆盖层持续遮挡渲染结果
    const healthBar = document.getElementById('memory-health-bar');
    const metricsEl = healthBar?.querySelector('.health-metrics');
    if (metricsEl) hidePanelLoading(metricsEl);

    // ─── 健康度评分（记忆面板 health-bar）+ 评分基数 ──────────────
    const scoreEl = document.getElementById('health-score');
    if (scoreEl) {
      // 评分：纯分数（样本量由 #health-score-sample 承载，CSS-R11 分离层级）
      scoreEl.textContent = String(data.scores.overall);
    }
    const scoreSampleEl = document.getElementById('health-score-sample');
    if (scoreSampleEl) {
      // 样本量：基于 N 条记忆，muted 次级信息，不与分数争夺视觉权重
      scoreSampleEl.textContent = `（${data.totalMemories} 条）`;
    }

    // ─── 健康等级徽章 ──────────────────────────────────
    const badgeEl = document.getElementById('health-badge');
    if (badgeEl) {
      // 清除旧等级类名
      badgeEl.className = 'panel-badge';
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
        fillEl.className = `metric-track__fill ${dim.cssClass}`;
      }
      if (valEl) valEl.textContent = String(dim.value);
    }

    // ─── 详情计数（重复/过期/低质量）+ 数据点补全 ──────────────────
    const duplicateCount = data.duplicates.reduce((sum, g) => sum + g.memories.length, 0);
    const dupEl = document.getElementById('health-duplicates');
    if (dupEl) {
      // 重复组追加平均相似度（payload 的 similarity 为 0-1，越小越相似，转为百分比展示）
      // 空值保护：similarity 为可选字段，未提供时不追加
      const similarities = data.duplicates
        .map((g) => g.similarity)
        .filter((s): s is number => typeof s === 'number' && !Number.isNaN(s));
      const avgSimilarity =
        similarities.length > 0
          ? Math.round((similarities.reduce((sum, s) => sum + s, 0) / similarities.length) * 100)
          : null;
      const dupText = avgSimilarity !== null
        ? `重复: ${duplicateCount}（相似度 ${avgSimilarity}%）`
        : `重复: ${duplicateCount}`;
      dupEl.textContent = dupText;
      // title 悬停展示完整详情（避免单行溢出）
      dupEl.title = duplicateCount > 0 ? `${duplicateCount} 条重复记忆，平均相似度 ${avgSimilarity ?? '未知'}%` : '';
      dupEl.className = 'panel-chip';
      if (duplicateCount > 0) dupEl.classList.add('warning');
    }

    const staleEl = document.getElementById('health-stale');
    if (staleEl) {
      // 过期记忆追加原因分类（old_age / low_score / both）+ 最长闲置天数
      // 原因分类让用户区分"长期未访问"与"低分"两类过期，针对性清理
      const reasonCounts = { old_age: 0, low_score: 0, both: 0 } as Record<string, number>;
      let maxDays = 0;
      for (const item of data.staleMemories) {
        reasonCounts[item.reason] = (reasonCounts[item.reason] ?? 0) + 1;
        if (item.daysSinceAccess > maxDays) maxDays = item.daysSinceAccess;
      }
      const staleCount = data.staleMemories.length;
      const parts: string[] = [`过期: ${staleCount}`];
      if (staleCount > 0) {
        // 原因分类（仅展示非零项）
        const reasonParts: string[] = [];
        if ((reasonCounts.old_age ?? 0) > 0) reasonParts.push(`老化 ${reasonCounts.old_age}`);
        if ((reasonCounts.low_score ?? 0) > 0) reasonParts.push(`低分 ${reasonCounts.low_score}`);
        if ((reasonCounts.both ?? 0) > 0) reasonParts.push(`双重 ${reasonCounts.both}`);
        if (reasonParts.length > 0) parts.push(`（${reasonParts.join(' / ')}）`);
        // 最长闲置天数
        if (maxDays > 0) parts.push(`· 最长 ${maxDays} 天`);
      }
      staleEl.textContent = parts.join('');
      // title 悬停展示完整详情
      staleEl.title = staleCount > 0
        ? `${staleCount} 条过期记忆：老化 ${reasonCounts.old_age ?? 0} / 低分 ${reasonCounts.low_score ?? 0} / 双重 ${reasonCounts.both ?? 0}，最长闲置 ${maxDays} 天`
        : '';
      staleEl.className = 'panel-chip';
      if (staleCount > 0) staleEl.classList.add('warning');
    }

    const lowEl = document.getElementById('health-low-quality');
    if (lowEl) {
      lowEl.textContent = `低质量: ${data.lowQualityCount}`;
      lowEl.className = 'panel-chip';
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
